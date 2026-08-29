import { buildCorrectionSections, correctionSectionKey } from './settings';
import type {
  EventSetting,
  FormRegistryRow,
  Student,
  SubmissionItem,
  ValidationIssue,
} from '../shared/types';

/**
 * 実機テスト（本物のGoogleフォームへ回答を投入し、取込と検査の結果を照合する確認）で
 * 使う純関数。シートやFormAppへは触れず、渡された値だけで組み立てる。
 */

export type LiveFormTestCaseKind =
  | 'NORMAL_VALID'
  | 'CORRECTION_VALID'
  | 'CORRECTION_STUDENT_NOT_FOUND'
  | 'CORRECTION_CLASS_MISMATCH';

export interface LiveFormTestCase {
  caseId: string;
  kind: LiveFormTestCaseKind;
  formType: 'normal' | 'correction';
  /** 画面とシートへ出す説明。実在の氏名・学籍番号を含めない。 */
  description: string;
  answersByFieldKey: Record<string, string>;
}

export interface LiveFormTestBuildInput {
  targetGrade: number;
  targetClass: number;
  /** 対象クラスの生徒。出席番号順で渡す。 */
  classStudents: Student[];
  /** 別クラスの実在学籍番号。見つからない場合は空文字。 */
  otherClassStudentId: string;
  /** 生徒マスターに存在しない4ケタの学籍番号。 */
  unknownStudentId: string;
  submitterStudentId: string;
  submitterName: string;
  correctionReason: string;
  /** 有効かつ対象学年に一致する競技。表示順で渡す。 */
  events: EventSetting[];
  normalRegistry: FormRegistryRow[];
  correctionRegistry: FormRegistryRow[];
}

export interface LiveFormTestSlotField {
  eventId: string;
  studentIdFieldKey: string;
  stateFieldKey: string;
  displayOrder: number;
}

export interface LiveFormTestOutcome {
  issueCodes: string[];
  targetGrade: number;
  targetClass: number;
  itemInputs: string[];
}

export interface LiveFormTestDifference {
  ok: boolean;
  missingIssueCodes: string[];
  unexpectedIssueCodes: string[];
  /** 期待と実際で内容が違った申請項目の件数。学籍番号そのものは含めない。 */
  itemMismatchCount: number;
  targetMismatch: boolean;
}

const STATE_REGISTER = '選手を登録する';

/** 対応表から、競技ごとの選手枠（学籍番号欄と登録状態欄）を表示順で取り出す。 */
export function readSlotFields(registry: FormRegistryRow[]): LiveFormTestSlotField[] {
  const enabled = registry.filter((row) => row.enabled);
  const stateKeys = new Set(enabled.map((row) => row.fieldKey));
  const seen = new Set<string>();
  return enabled
    .filter((row) => row.eventId !== '' && row.fieldKey.endsWith('_student_id'))
    .filter((row) => {
      if (seen.has(row.fieldKey)) return false;
      seen.add(row.fieldKey);
      return true;
    })
    .sort((left, right) => left.displayOrder - right.displayOrder)
    .map((row) => {
      const stateFieldKey = row.fieldKey.replace(/_student_id$/, '_state');
      return {
        eventId: row.eventId,
        studentIdFieldKey: row.fieldKey,
        stateFieldKey: stateKeys.has(stateFieldKey) ? stateFieldKey : '',
        displayOrder: row.displayOrder,
      };
    });
}

/**
 * 同じ`field_key`の設問は、全学年の競技だと学年ページごとに作られる。回答が進む
 * ページにある設問を選び、見つからない場合だけ最初の設問を使う。ページを取り違えると
 * 回答が別の学年ページへ入り、実際に表示されるページの必須項目が空欄のままになる。
 */
export function pickRegistryRowForAnswer(
  registry: FormRegistryRow[],
  fieldKey: string,
  answeredPageItemIds: ReadonlySet<string>,
): FormRegistryRow | undefined {
  const candidates = registry.filter((row) => row.enabled && row.fieldKey === fieldKey);
  return candidates.find((row) => answeredPageItemIds.has(row.itemId)) ?? candidates[0];
}

/**
 * 修正フォームの「修正する競技」で選ぶ選択肢の文言。フォーム作成時と同じ組み立てにする。
 * 表示順100ごとのセクション単位なので、同じセクションの競技はまとめて1つの選択肢になる。
 */
export function correctionSectionChoiceFor(
  events: EventSetting[],
  event: EventSetting,
): string {
  const key = correctionSectionKey(event);
  return buildCorrectionSections(events).find((section) => section.key === key)?.choice ?? '';
}

function genderFor(category: EventSetting['category']): 'M' | 'F' | undefined {
  if (category === '男子') return 'M';
  if (category === '女子') return 'F';
  return undefined;
}

/**
 * 競技の区分に合う生徒を、同じ申請の中でなるべく重複しないように選ぶ。
 * 足りないときは先頭へ戻って再利用する（重複の判定自体は検査側の責務）。
 */
function createStudentPicker(classStudents: Student[]): (category: EventSetting['category']) => string {
  const used = new Set<string>();
  return (category) => {
    const wanted = genderFor(category);
    const pools = wanted
      ? [classStudents.filter((student) => student.gender === wanted), classStudents]
      : [classStudents];
    for (const pool of pools) {
      const fresh = pool.find((student) => !used.has(student.studentId));
      if (fresh) {
        used.add(fresh.studentId);
        return fresh.studentId;
      }
    }
    const fallback = pools[0]?.[0] ?? classStudents[0];
    return fallback?.studentId ?? '';
  };
}

function submitterAnswers(input: LiveFormTestBuildInput): Record<string, string> {
  return {
    submitter_student_id: input.submitterStudentId,
    submitter_name_input: input.submitterName,
  };
}

function fillSlots(
  answers: Record<string, string>,
  slots: LiveFormTestSlotField[],
  eventsById: Map<string, EventSetting>,
  pick: (category: EventSetting['category']) => string,
): void {
  slots.forEach((slot) => {
    const event = eventsById.get(slot.eventId);
    if (!event) return;
    if (slot.stateFieldKey) answers[slot.stateFieldKey] = STATE_REGISTER;
    answers[slot.studentIdFieldKey] = pick(event.category);
  });
}

export function buildLiveFormTestCases(input: LiveFormTestBuildInput): LiveFormTestCase[] {
  const eventsById = new Map(input.events.map((event) => [event.eventId, event]));
  const cases: LiveFormTestCase[] = [];
  const normalSlots = readSlotFields(input.normalRegistry)
    .filter((slot) => eventsById.has(slot.eventId));
  if (normalSlots.length > 0) {
    const answers: Record<string, string> = {
      ...submitterAnswers(input),
      target_grade: `${input.targetGrade}年`,
      target_class: `${input.targetClass}組`,
      is_proxy: '自分のクラスを入力',
    };
    fillSlots(answers, normalSlots, eventsById, createStudentPicker(input.classStudents));
    cases.push({
      caseId: 'LT-01',
      kind: 'NORMAL_VALID',
      formType: 'normal',
      description: '通常フォーム：対象クラスの全枠を在籍する生徒で登録する',
      answersByFieldKey: answers,
    });
  }

  const correctionSlots = readSlotFields(input.correctionRegistry);
  const correctionEvent = input.events.find((event) =>
    correctionSlots.some((slot) => slot.eventId === event.eventId));
  if (correctionEvent) {
    // 修正フォームはセクション単位で1ページなので、同じセクションの全競技の枠を埋める。
    const sectionEventIds = new Set(input.events
      .filter((event) => correctionSectionKey(event) === correctionSectionKey(correctionEvent))
      .map((event) => event.eventId));
    const eventSlots = correctionSlots.filter((slot) => sectionEventIds.has(slot.eventId));
    const base = (): Record<string, string> => {
      const answers: Record<string, string> = {
        ...submitterAnswers(input),
        target_class: `${input.targetGrade}年${input.targetClass}組`,
        correction_reason: input.correctionReason,
        correction_event_id: correctionSectionChoiceFor(input.events, correctionEvent),
      };
      fillSlots(answers, eventSlots, eventsById, createStudentPicker(input.classStudents));
      return answers;
    };
    const firstSlotKey = eventSlots[0]?.studentIdFieldKey ?? '';

    cases.push({
      caseId: 'LT-02',
      kind: 'CORRECTION_VALID',
      formType: 'correction',
      description: `修正フォーム：${correctionEvent.eventName}を含むまとまりの全枠を在籍する生徒で修正する`,
      answersByFieldKey: base(),
    });

    if (firstSlotKey && input.unknownStudentId) {
      const answers = base();
      answers[firstSlotKey] = input.unknownStudentId;
      cases.push({
        caseId: 'LT-03',
        kind: 'CORRECTION_STUDENT_NOT_FOUND',
        formType: 'correction',
        description: `修正フォーム：${correctionEvent.eventName}を含むまとまりの1枠へ在籍しない学籍番号を入力する`,
        answersByFieldKey: answers,
      });
    }

    if (firstSlotKey && input.otherClassStudentId) {
      const answers = base();
      answers[firstSlotKey] = input.otherClassStudentId;
      cases.push({
        caseId: 'LT-04',
        kind: 'CORRECTION_CLASS_MISMATCH',
        formType: 'correction',
        description: `修正フォーム：${correctionEvent.eventName}を含むまとまりの1枠へ別クラスの学籍番号を入力する`,
        answersByFieldKey: answers,
      });
    }
  }
  return cases;
}

/** 空欄を無視して、投入した回答とフォーム回答原本の内容が同じ申請かを判定する。 */
export function isSameAnswerSet(
  expected: Record<string, string>,
  actual: Record<string, string>,
): boolean {
  const meaningful = (values: Record<string, string>): Map<string, string> => {
    const result = new Map<string, string>();
    Object.keys(values).forEach((key) => {
      const value = (values[key] ?? '').trim();
      if (value !== '') result.set(key, value);
    });
    return result;
  };
  const left = meaningful(expected);
  const right = meaningful(actual);
  if (left.size !== right.size) return false;
  for (const [key, value] of left) {
    if (right.get(key) !== value) return false;
  }
  return true;
}

/** 申請項目を、学籍番号を含めずに比較できる文字列へ畳む。 */
export function summarizeItems(items: SubmissionItem[]): string[] {
  return items
    .map((item) => [
      item.eventId,
      item.slotId,
      item.registrationState,
      item.normalizedStudentId === '' ? 'EMPTY' : 'FILLED',
      item.required ? 'REQUIRED' : 'OPTIONAL',
    ].join('/'))
    .sort();
}

export function issueCodesOf(issues: ValidationIssue[]): string[] {
  return issues.map((issue) => issue.issueCode).sort();
}

export function compareLiveFormTestOutcome(
  expected: LiveFormTestOutcome,
  actual: LiveFormTestOutcome,
): LiveFormTestDifference {
  const missing = countDifference(expected.issueCodes, actual.issueCodes);
  const unexpected = countDifference(actual.issueCodes, expected.issueCodes);
  const itemMismatchCount = countDifference(expected.itemInputs, actual.itemInputs).length
    + countDifference(actual.itemInputs, expected.itemInputs).length;
  const targetMismatch = expected.targetGrade !== actual.targetGrade
    || expected.targetClass !== actual.targetClass;
  return {
    ok: missing.length === 0 && unexpected.length === 0
      && itemMismatchCount === 0 && !targetMismatch,
    missingIssueCodes: missing,
    unexpectedIssueCodes: unexpected,
    itemMismatchCount,
    targetMismatch,
  };
}

/** left にあって right に足りない要素を、重複も数えて返す。 */
function countDifference(left: string[], right: string[]): string[] {
  const remaining = [...right];
  const result: string[] = [];
  left.forEach((value) => {
    const index = remaining.indexOf(value);
    if (index >= 0) remaining.splice(index, 1);
    else result.push(value);
  });
  return result;
}

export function describeDifference(difference: LiveFormTestDifference): string {
  if (difference.ok) return '';
  const parts: string[] = [];
  if (difference.missingIssueCodes.length > 0) {
    parts.push(`検出されなかった判定：${difference.missingIssueCodes.join('、')}`);
  }
  if (difference.unexpectedIssueCodes.length > 0) {
    parts.push(`想定外の判定：${difference.unexpectedIssueCodes.join('、')}`);
  }
  if (difference.itemMismatchCount > 0) {
    parts.push(`申請項目の食い違い：${difference.itemMismatchCount}件`);
  }
  if (difference.targetMismatch) parts.push('対象学年・組が投入内容と一致しません');
  return parts.join(' / ');
}
