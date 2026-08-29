import {
  buildCorrectionSlotDefinitions,
  CORRECTION_BRANCH_HELP,
  CORRECTION_PAGE_HELP,
  correctionSectionPageTitle,
  type CorrectionSection,
} from '../core/settings';
import {
  STUDENT_ID_RESPONSE_ERROR,
  STUDENT_ID_RESPONSE_PATTERN,
} from '../core/form-fields';
import type { EventSetting, FormRegistryRow } from '../shared/types';
import { appendFormRegistry } from './settings-repository';

type FormType = FormRegistryRow['formType'];
type JsonObject = Record<string, unknown>;

interface ApiItemDefinition {
  item: JsonObject;
  registry?: Omit<FormRegistryRow, 'formId' | 'itemId' | 'enabled'>;
}

const FORMS_API_BASE = 'https://forms.googleapis.com/v1/forms/';

/**
 * Google Forms API に渡せるのはフォームの設問定義だけに限定する。
 * 生徒マスター、フォーム回答、氏名・学籍番号の入力値を受け取る引数は設けない。
 */
function batchCreateItems(
  formId: string,
  startIndex: number,
  definitions: ApiItemDefinition[],
): number {
  if (definitions.length === 0) return startIndex;
  requestFormsApi(formId, {
    requests: definitions.map((definition, offset) => ({
      createItem: { item: definition.item, location: { index: startIndex + offset } },
    })),
    includeFormInResponse: false,
  });
  const registry = definitions.flatMap((definition) => definition.registry ? [{
    ...definition.registry,
    formId,
    itemId: String(definition.item.itemId),
    enabled: true,
  }] : []);
  if (registry.length > 0) appendFormRegistry(registry);
  return startIndex + definitions.length;
}

function requestFormsApi(formId: string, payload: JsonObject): void {
  const response = UrlFetchApp.fetch(`${FORMS_API_BASE}${encodeURIComponent(formId)}:batchUpdate`, {
    method: 'post',
    contentType: 'application/json',
    headers: { Authorization: `Bearer ${ScriptApp.getOAuthToken()}` },
    payload: JSON.stringify(payload),
    muteHttpExceptions: true,
  });
  const status = response.getResponseCode();
  if (status >= 200 && status < 300) return;
  if (status === 401 || status === 403) {
    throw new Error(
      '高速フォーム作成に必要な Google Forms API を利用できません。Apps Script の標準 Google Cloud プロジェクトで Forms API を有効にしてから、「中断した場所から再開」を押してください。',
    );
  }
  throw new Error(`Google Forms API で設問を作成できませんでした（HTTP ${status}）。時間をおいて再開してください。`);
}

function stableItemId(seed: string, key: string): string {
  const bytes = Utilities.computeDigest(
    Utilities.DigestAlgorithm.SHA_256,
    `${seed}:${key}`,
    Utilities.Charset.UTF_8,
  );
  // FormApp#getItemById とも互換になる正の32bit整数を使う。
  const value = ((((bytes[0]! & 0x7f) << 24) | ((bytes[1]! & 0xff) << 16)
    | ((bytes[2]! & 0xff) << 8) | (bytes[3]! & 0xff)) >>> 0) || 1;
  return String(value);
}

function textDisplay(itemId: string, title: string, description = ''): JsonObject {
  return { itemId, title, description, textItem: {} };
}

function pageBreak(itemId: string, title: string, description = ''): JsonObject {
  return { itemId, title, description, pageBreakItem: {} };
}

function textQuestion(itemId: string, title: string, required: boolean, paragraph = false): JsonObject {
  return { itemId, title, questionItem: { question: { required, textQuestion: { paragraph } } } };
}

function choiceQuestion(
  itemId: string,
  title: string,
  values: string[],
  type: 'RADIO' | 'DROP_DOWN',
  description = '',
  pageIds?: string[],
): JsonObject {
  return {
    itemId, title, description,
    questionItem: { question: { required: true, choiceQuestion: {
      type,
      options: values.map((value, index) => ({
        value,
        ...(pageIds?.[index] ? { goToSectionId: pageIds[index] } : {}),
      })),
      shuffle: false,
    } } },
  };
}

function definition(
  item: JsonObject,
  formType: FormType,
  fieldKey?: string,
  eventId = '',
  itemType = '',
  displayOrder = 0,
): ApiItemDefinition {
  return {
    item,
    ...(fieldKey ? { registry: {
      formType, fieldKey, eventId, title: String(item.title), itemType, displayOrder,
    } } : {}),
  };
}

export function addNormalFormBaseViaApi(
  formId: string,
  seed: string,
  startIndex: number,
): { nextIndex: number; questionId: string } {
  const id = (key: string): string => stableItemId(seed, `normal:${key}`);
  const questionId = id('target_grade');
  const items: ApiItemDefinition[] = [
    definition(textDisplay(id('header'), '回答責任者'), 'normal'),
    definition(textQuestion(id('submitter_student_id'), '入力者の学籍番号', true), 'normal', 'submitter_student_id', '', 'text', 1),
    definition(textQuestion(id('submitter_name_input'), '入力者の氏名', true), 'normal', 'submitter_name_input', '', 'text', 2),
    definition(choiceQuestion(id('target_class'), '登録対象の組',
      ['1組', '2組', '3組', '4組', '5組', '6組', '7組', '8組'], 'DROP_DOWN'),
    'normal', 'target_class', '', 'list', 3),
    definition(choiceQuestion(id('is_proxy'), '代理入力ですか',
      ['自分のクラスを入力', '別のクラスを代理で入力'], 'RADIO'),
    'normal', 'is_proxy', '', 'multiple_choice', 4),
    definition(choiceQuestion(questionId, '登録対象の学年', ['1年', '2年', '3年'], 'RADIO'),
    'normal', 'target_grade', '', 'multiple_choice', 5),
  ];
  return { nextIndex: batchCreateItems(formId, startIndex, items), questionId };
}

export function addNormalGradePageViaApi(
  formId: string,
  seed: string,
  startIndex: number,
  grade: number,
): { nextIndex: number; pageId: string } {
  const pageId = stableItemId(seed, `normal:grade:${grade}:page`);
  return {
    nextIndex: batchCreateItems(formId, startIndex, [
      definition(pageBreak(pageId, `${grade}年の競技`), 'normal'),
    ]),
    pageId,
  };
}

export function addNormalEventChunkViaApi(
  formId: string,
  seed: string,
  startIndex: number,
  grade: number,
  event: EventSetting,
): number {
  const id = (key: string): string => stableItemId(seed, `normal:${grade}:${event.eventId}:${key}`);
  const items: ApiItemDefinition[] = [
    definition(textDisplay(id('header'), `${event.eventName}（${event.category}）`,
      `必要人数：${event.requiredCount}人。学籍番号（半角数字4桁）だけを入力します。氏名は名簿から自動で照合します。`), 'normal'),
  ];
  for (let index = 1; index <= event.requiredCount; index += 1) {
    const slot = String(index).padStart(2, '0');
    const label = event.hasOrder ? `第${index}走者` : `${index}人目`;
    if (event.vacancyAllowed) {
      const fieldKey = `${event.eventId}_slot${slot}_state`;
      items.push(definition(choiceQuestion(id(fieldKey), `${event.eventName} ${label} 登録状態`,
        ['選手を登録する', '現在調整中', '出場しない'], 'RADIO'),
      'normal', fieldKey, event.eventId, 'multiple_choice', event.displayOrder * 100 + index * 10));
    }
    const studentIdKey = `${event.eventId}_slot${slot}_student_id`;
    items.push(definition(textQuestion(id(studentIdKey), `${event.eventName} ${label} 学籍番号`, !event.vacancyAllowed),
      'normal', studentIdKey, event.eventId, 'text', event.displayOrder * 100 + index * 10 + 1));
  }
  return batchCreateItems(formId, startIndex, items);
}

export function addCorrectionFormBaseViaApi(
  formId: string,
  seed: string,
  startIndex: number,
): { nextIndex: number; questionId: string } {
  const id = (key: string): string => stableItemId(seed, `correction:${key}`);
  const questionId = id('correction_event_id');
  const items: ApiItemDefinition[] = [
    definition(textDisplay(id('header'), '申請者情報'), 'correction'),
    definition(textQuestion(id('submitter_student_id'), '入力者の学籍番号', true), 'correction', 'submitter_student_id', '', 'text', 1),
    definition(textQuestion(id('submitter_name_input'), '入力者の氏名', true), 'correction', 'submitter_name_input', '', 'text', 2),
    definition(choiceQuestion(id('target_class'), '修正対象クラス',
      Array.from({ length: 24 }, (_, index) => `${Math.floor(index / 8) + 1}年${index % 8 + 1}組`), 'DROP_DOWN'),
    'correction', 'target_class', '', 'list', 3),
    definition(textQuestion(id('correction_reason'), '修正する理由と変更内容', true, true),
      'correction', 'correction_reason', '', 'paragraph_text', 3),
    definition(choiceQuestion(questionId, '修正する競技', ['準備中'], 'RADIO',
      CORRECTION_BRANCH_HELP),
    'correction', 'correction_event_id', '', 'multiple_choice', 10),
  ];
  return { nextIndex: batchCreateItems(formId, startIndex, items), questionId };
}

/**
 * 競技1件ずつ作る。セクションの先頭競技のときだけページ区切りを先頭へ付け、そのIDを返す。
 * 2件目以降は同じページへ続けて追加するため`pageId`は`undefined`になる。
 */
export function addCorrectionEventChunkViaApi(
  formId: string,
  seed: string,
  startIndex: number,
  event: EventSetting,
  newSection: CorrectionSection | undefined,
): { nextIndex: number; pageId: string | undefined } {
  const id = (key: string): string => stableItemId(seed, `correction:${event.eventId}:${key}`);
  const pageId = newSection ? id('page') : undefined;
  const items: ApiItemDefinition[] = [];
  if (pageId && newSection) {
    items.push(definition(pageBreak(pageId, correctionSectionPageTitle(newSection),
      CORRECTION_PAGE_HELP), 'correction'));
  }
  // 1ページへ複数の競技が並ぶため、競技名の見出しを必ず付ける。
  items.push(definition(textDisplay(id('header'), `${event.eventName}（${event.category}）`,
    `必要人数：${event.requiredCount}人。この競技に登録する全員を入力してください。`), 'correction'));
  for (const slot of buildCorrectionSlotDefinitions(event)) {
    if (event.vacancyAllowed) {
      items.push(definition(choiceQuestion(id(slot.stateFieldKey),
        `${event.eventName} ${slot.label} 登録状態`,
        ['選手を登録する', '現在調整中', '出場しない'], 'RADIO'),
      'correction', slot.stateFieldKey, event.eventId, 'multiple_choice', event.displayOrder * 100 + slot.index * 10));
    }
    items.push(definition(textQuestion(id(slot.studentIdFieldKey),
      `${event.eventName} ${slot.label} 学籍番号`, !event.vacancyAllowed),
    'correction', slot.studentIdFieldKey, event.eventId, 'text', event.displayOrder * 100 + slot.index * 10 + 1));
  }
  return { nextIndex: batchCreateItems(formId, startIndex, items), pageId };
}

function updateBranchQuestion(
  formId: string,
  itemId: string,
  index: number,
  title: string,
  labels: string[],
  pageIds: string[],
): void {
  requestFormsApi(formId, { requests: [{ updateItem: {
    item: choiceQuestion(itemId, title, labels, 'RADIO', '', pageIds),
    location: { index },
    updateMask: 'questionItem.question.choiceQuestion.options',
  } }] });
}

export function finalizeNormalFormViaApi(
  formId: string,
  questionId: string,
  pageIds: string[],
): void {
  updateBranchQuestion(formId, questionId, 5, '登録対象の学年', ['1年', '2年', '3年'], pageIds);
  applyFormAppOnlyFeatures(formId);
}

export function finalizeCorrectionFormViaApi(
  formId: string,
  questionId: string,
  sections: CorrectionSection[],
  pageIds: string[],
): void {
  updateBranchQuestion(formId, questionId, 5, '修正する競技',
    sections.map((section) => section.choice), pageIds);
  applyFormAppOnlyFeatures(formId);
}

/** REST API が扱えない回答検証と、各セクション末尾の送信動作だけを FormApp で補う。 */
function applyFormAppOnlyFeatures(formId: string): void {
  const form = FormApp.openById(formId);
  form.getItems(FormApp.ItemType.PAGE_BREAK).forEach((item) =>
    item.asPageBreakItem().setGoToPage(FormApp.PageNavigationType.SUBMIT));
  form.getItems(FormApp.ItemType.TEXT).forEach((item) => {
    const text = item.asTextItem();
    if (!text.getTitle().endsWith('学籍番号')) return;
    text.setValidation(FormApp.createTextValidation()
      .requireTextMatchesPattern(STUDENT_ID_RESPONSE_PATTERN)
      .setHelpText(STUDENT_ID_RESPONSE_ERROR)
      .build());
  });
}
