import { appliesToGrade, buildCorrectionSlotDefinitions } from '../core/settings';
import {
  isStudentIdField,
  STUDENT_ID_RESPONSE_ERROR,
  STUDENT_ID_RESPONSE_PATTERN,
} from '../core/form-fields';
import type { EventSetting, FormDesignSetting, FormRegistryRow } from '../shared/types';
import { appendFormRegistry } from './settings-repository';

export interface DraftFormsResult {
  normalFormId: string;
  correctionFormId: string;
  normalEditUrl: string;
  correctionEditUrl: string;
  formsFolderId: string;
  formsFolderUrl: string;
  registry: FormRegistryRow[];
}

interface PublishAwareFormApp extends GoogleAppsScript.Forms.FormApp {
  create(title: string): GoogleAppsScript.Forms.Form;
  create(title: string, isPublished: boolean): GoogleAppsScript.Forms.Form;
}

interface RegistryItem {
  getId(): number;
}

const FORM_ID_CACHE = new WeakMap<object, string>();

function cachedFormId(form: GoogleAppsScript.Forms.Form): string {
  const cached = FORM_ID_CACHE.get(form);
  if (cached) return cached;
  const formId = form.getId();
  FORM_ID_CACHE.set(form, formId);
  return formId;
}

export interface InitializedDraftForms {
  normalFormId: string;
  correctionFormId: string;
  normalEditUrl: string;
  correctionEditUrl: string;
  formsFolderId: string;
  formsFolderUrl: string;
}

export function initializeDraftForms(design: FormDesignSetting): InitializedDraftForms {
  const forms = FormApp as PublishAwareFormApp;
  const normal = forms.create(design.normalTitle, false);
  const correction = forms.create(design.correctionTitle, false);
  const formsFolder = moveFormsBesideSpreadsheet(normal, correction);
  configureForm(normal, design, false);
  configureForm(correction, design, true);
  return {
    normalFormId: cachedFormId(normal), correctionFormId: cachedFormId(correction),
    normalEditUrl: normal.getEditUrl(), correctionEditUrl: correction.getEditUrl(),
    formsFolderId: formsFolder.getId(), formsFolderUrl: formsFolder.getUrl(),
  };
}

export function addNormalFormBase(form: GoogleAppsScript.Forms.Form): number {
  const registry: FormRegistryRow[] = [];
  form.addSectionHeaderItem().setTitle('回答責任者');
  addText(form, registry, 'normal', 'submitter_student_id', '', '入力者の学籍番号', 1, true);
  addText(form, registry, 'normal', 'submitter_name_input', '', '入力者の氏名', 2, true);
  const classItem = form.addListItem().setTitle('登録対象の組').setChoiceValues(
    ['1組', '2組', '3組', '4組', '5組', '6組', '7組', '8組'],
  ).setRequired(true);
  addRegistry(registry, 'normal', form, classItem, '登録対象の組', 'target_class', '', 'list', 3);
  const proxyItem = form.addMultipleChoiceItem().setTitle('代理入力ですか')
    .setChoiceValues(['自分のクラスを入力', '別のクラスを代理で入力']).setRequired(true);
  addRegistry(registry, 'normal', form, proxyItem, '代理入力ですか', 'is_proxy', '', 'multiple_choice', 4);
  const gradeQuestion = form.addMultipleChoiceItem().setTitle('登録対象の学年').setRequired(true);
  addRegistry(registry, 'normal', form, gradeQuestion, '登録対象の学年', 'target_grade', '', 'multiple_choice', 5);
  appendFormRegistryChunk(registry);
  return gradeQuestion.getId();
}

export function addNormalGradePage(form: GoogleAppsScript.Forms.Form, grade: number): number {
  const page = form.addPageBreakItem().setTitle(`${grade}年の競技`);
  page.setGoToPage(FormApp.PageNavigationType.SUBMIT);
  return page.getId();
}

export function addNormalEventChunk(form: GoogleAppsScript.Forms.Form, event: EventSetting): void {
  const registry: FormRegistryRow[] = [];
  addEventItems(form, registry, event);
  appendFormRegistryChunk(registry);
}

export function finalizeNormalFormBranches(
  form: GoogleAppsScript.Forms.Form,
  questionId: number,
  pageIds: number[],
): void {
  const question = form.getItemById(questionId).asMultipleChoiceItem();
  const pages = pageIds.map((id) => form.getItemById(id).asPageBreakItem());
  question.setChoices(pages.map((page, index) => question.createChoice(`${index + 1}年`, page)));
}

export function addCorrectionFormBase(form: GoogleAppsScript.Forms.Form): number {
  const registry: FormRegistryRow[] = [];
  form.addSectionHeaderItem().setTitle('申請者情報');
  addText(form, registry, 'correction', 'submitter_student_id', '', '入力者の学籍番号', 1, true);
  addText(form, registry, 'correction', 'submitter_name_input', '', '入力者の氏名', 2, true);
  const targetClass = form.addListItem().setTitle('修正対象クラス').setChoiceValues(
    Array.from({ length: 24 }, (_, index) => `${Math.floor(index / 8) + 1}年${index % 8 + 1}組`),
  ).setRequired(true);
  addRegistry(registry, 'correction', form, targetClass, '修正対象クラス', 'target_class', '', 'list', 3);
  addParagraph(form, registry, 'correction', 'correction_reason', '',
    '修正する理由と変更内容', 3, true,
    '例：第2走者を変更しました。競技全体の現在の登録内容を、次のページですべて入力してください。');
  const eventQuestion = form.addMultipleChoiceItem().setTitle('修正する競技').setRequired(true)
    .setHelpText('1回の送信で修正できる競技は1つです。選んだ競技の全選手を入力してください。');
  addRegistry(registry, 'correction', form, eventQuestion, '修正する競技', 'correction_event_id', '', 'multiple_choice', 10);
  appendFormRegistryChunk(registry);
  return eventQuestion.getId();
}

export function addCorrectionEventChunk(form: GoogleAppsScript.Forms.Form, event: EventSetting): number {
  const registry: FormRegistryRow[] = [];
  const page = form.addPageBreakItem().setTitle(`${event.eventName}（${event.category}）をすべて入力`)
    .setHelpText('変更した人だけでなく、この競技に登録する全員を入力してください。');
  addCorrectionEventItems(form, registry, event);
  page.setGoToPage(FormApp.PageNavigationType.SUBMIT);
  appendFormRegistryChunk(registry);
  return page.getId();
}

export function finalizeCorrectionFormBranches(
  form: GoogleAppsScript.Forms.Form,
  questionId: number,
  events: EventSetting[],
  pageIds: number[],
): void {
  const question = form.getItemById(questionId).asMultipleChoiceItem();
  const pages = pageIds.map((id) => form.getItemById(id).asPageBreakItem());
  question.setChoices(events.map((event, index) => question.createChoice(
    `${event.eventName}（${event.category} / ${event.eventId}）`, pages[index]!,
  )));
}

function appendFormRegistryChunk(registry: FormRegistryRow[]): void {
  if (registry.length === 0) return;
  appendFormRegistry(registry);
}

export function buildDraftFormsFromSettings(
  events: EventSetting[],
  design: FormDesignSetting,
): DraftFormsResult {
  const enabledEvents = events.filter((event) => event.enabled && event.year === design.year)
    .sort((a, b) => a.displayOrder - b.displayOrder);
  const forms = FormApp as PublishAwareFormApp;
  const normal = forms.create(design.normalTitle, false);
  const correction = forms.create(design.correctionTitle, false);
  const formsFolder = moveFormsBesideSpreadsheet(normal, correction);
  const registry: FormRegistryRow[] = [];
  configureForm(normal, design, false);
  configureForm(correction, design, true);
  buildNormalForm(normal, enabledEvents, registry);
  buildCorrectionForm(correction, enabledEvents, registry);
  return {
    normalFormId: cachedFormId(normal), correctionFormId: cachedFormId(correction),
    normalEditUrl: normal.getEditUrl(), correctionEditUrl: correction.getEditUrl(), registry,
    formsFolderId: formsFolder.getId(), formsFolderUrl: formsFolder.getUrl(),
  };
}

function configureForm(
  form: GoogleAppsScript.Forms.Form,
  design: FormDesignSetting,
  correction: boolean,
): void {
  const purpose = correction ? '提出済み内容の修正を申請するフォームです。' : 'クラスの選手を登録するフォームです。';
  form
    .setDescription(`${purpose}\n締切：${design.deadline}\n送信しただけでは正式名簿へ反映されません。招集パートの承認後に反映されます。`)
    .setCollectEmail(design.loginRequired)
    .setLimitOneResponsePerUser(!correction && design.normalResubmission === '禁止')
    .setShowLinkToRespondAgain(false)
    .setConfirmationMessage('回答を受け付けました。この時点では正式名簿へ反映されていません。')
    .setProgressBar(true);
}

function buildNormalForm(
  form: GoogleAppsScript.Forms.Form,
  events: EventSetting[],
  registry: FormRegistryRow[],
): void {
  form.addSectionHeaderItem().setTitle('回答責任者');
  addText(form, registry, 'normal', 'submitter_student_id', '', '入力者の学籍番号', 1, true);
  addText(form, registry, 'normal', 'submitter_name_input', '', '入力者の氏名', 2, true);
  const classItem = form.addListItem().setTitle('登録対象の組').setChoiceValues(['1組', '2組', '3組', '4組', '5組', '6組', '7組', '8組']).setRequired(true);
  addRegistry(registry, 'normal', form, classItem, '登録対象の組', 'target_class', '', 'list', 3);
  const proxyItem = form.addMultipleChoiceItem().setTitle('代理入力ですか').setChoiceValues(['自分のクラスを入力', '別のクラスを代理で入力']).setRequired(true);
  addRegistry(registry, 'normal', form, proxyItem, '代理入力ですか', 'is_proxy', '', 'multiple_choice', 4);
  const gradeQuestion = form.addMultipleChoiceItem().setTitle('登録対象の学年').setRequired(true);
  addRegistry(registry, 'normal', form, gradeQuestion, '登録対象の学年', 'target_grade', '', 'multiple_choice', 5);
  const gradePages: GoogleAppsScript.Forms.PageBreakItem[] = [];
  for (let grade = 1; grade <= 3; grade += 1) {
    const page = form.addPageBreakItem().setTitle(`${grade}年の競技`);
    gradePages.push(page);
    const gradeEvents = events.filter((event) => appliesToGrade(event, grade));
    gradeEvents.forEach((event) => addEventItems(form, registry, event));
    page.setGoToPage(FormApp.PageNavigationType.SUBMIT);
  }
  gradeQuestion.setChoices(gradePages.map((page, index) => gradeQuestion.createChoice(`${index + 1}年`, page)));
}

function addEventItems(
  form: GoogleAppsScript.Forms.Form,
  registry: FormRegistryRow[],
  event: EventSetting,
): void {
  form.addSectionHeaderItem().setTitle(`${event.eventName}（${event.category}）`)
    .setHelpText(`必要人数：${event.requiredCount}人`);
  for (let index = 1; index <= event.requiredCount; index += 1) {
    const slot = String(index).padStart(2, '0');
    const slotLabel = event.hasOrder ? `第${index}走者` : `${index}人目`;
    if (event.vacancyAllowed) {
      const state = form.addMultipleChoiceItem().setTitle(`${event.eventName} ${slotLabel} 登録状態`)
        .setChoiceValues(['選手を登録する', '現在調整中', '出場しない']).setRequired(true);
      addRegistry(registry, 'normal', form, state, `${event.eventName} ${slotLabel} 登録状態`,
        `${event.eventId}_slot${slot}_state`, event.eventId, 'multiple_choice', event.displayOrder * 100 + index * 10);
    }
    addText(form, registry, 'normal', `${event.eventId}_slot${slot}_student_id`, event.eventId,
      `${event.eventName} ${slotLabel} 学籍番号`, event.displayOrder * 100 + index * 10 + 1, !event.vacancyAllowed);
    addText(form, registry, 'normal', `${event.eventId}_slot${slot}_name`, event.eventId,
      `${event.eventName} ${slotLabel} 氏名`, event.displayOrder * 100 + index * 10 + 2, !event.vacancyAllowed);
  }
}

function buildCorrectionForm(
  form: GoogleAppsScript.Forms.Form,
  events: EventSetting[],
  registry: FormRegistryRow[],
): void {
  form.addSectionHeaderItem().setTitle('申請者情報');
  addText(form, registry, 'correction', 'submitter_student_id', '', '入力者の学籍番号', 1, true);
  addText(form, registry, 'correction', 'submitter_name_input', '', '入力者の氏名', 2, true);
  const targetClass = form.addListItem().setTitle('修正対象クラス').setChoiceValues(
    Array.from({ length: 24 }, (_, index) => `${Math.floor(index / 8) + 1}年${index % 8 + 1}組`),
  ).setRequired(true);
  addRegistry(registry, 'correction', form, targetClass, '修正対象クラス', 'target_class', '', 'list', 3);
  addParagraph(form, registry, 'correction', 'correction_reason', '',
    '修正する理由と変更内容', 3, true,
    '例：第2走者を変更しました。競技全体の現在の登録内容を、次のページですべて入力してください。');
  const eventQuestion = form.addMultipleChoiceItem().setTitle('修正する競技').setRequired(true)
    .setHelpText('1回の送信で修正できる競技は1つです。選んだ競技の全選手を入力してください。');
  addRegistry(registry, 'correction', form, eventQuestion, '修正する競技', 'correction_event_id', '', 'multiple_choice', 10);
  const eventPages = events.map((event) => {
    const page = form.addPageBreakItem().setTitle(`${event.eventName}（${event.category}）をすべて入力`)
      .setHelpText('変更した人だけでなく、この競技に登録する全員を入力してください。');
    addCorrectionEventItems(form, registry, event);
    page.setGoToPage(FormApp.PageNavigationType.SUBMIT);
    return { event, page };
  });
  eventQuestion.setChoices(eventPages.map(({ event, page }) =>
    eventQuestion.createChoice(`${event.eventName}（${event.category} / ${event.eventId}）`, page),
  ));
}

function addCorrectionEventItems(
  form: GoogleAppsScript.Forms.Form,
  registry: FormRegistryRow[],
  event: EventSetting,
): void {
  for (const slot of buildCorrectionSlotDefinitions(event)) {
    if (event.vacancyAllowed) {
      const state = form.addMultipleChoiceItem().setTitle(`${slot.label} 登録状態`)
        .setChoiceValues(['選手を登録する', '現在調整中', '出場しない']).setRequired(true);
      addRegistry(registry, 'correction', form, state, `${slot.label} 登録状態`,
        slot.stateFieldKey, event.eventId, 'multiple_choice', event.displayOrder * 100 + slot.index * 10);
    }
    addText(form, registry, 'correction', slot.studentIdFieldKey, event.eventId,
      `${event.eventName} ${slot.label} 学籍番号`, event.displayOrder * 100 + slot.index * 10 + 1, !event.vacancyAllowed);
    addText(form, registry, 'correction', slot.nameFieldKey, event.eventId,
      `${event.eventName} ${slot.label} 氏名`, event.displayOrder * 100 + slot.index * 10 + 2, !event.vacancyAllowed);
  }
}

function moveFormsBesideSpreadsheet(
  normal: GoogleAppsScript.Forms.Form,
  correction: GoogleAppsScript.Forms.Form,
): GoogleAppsScript.Drive.Folder {
  const spreadsheetFile = DriveApp.getFileById(SpreadsheetApp.getActiveSpreadsheet().getId());
  const parents = spreadsheetFile.getParents();
  const parent = parents.hasNext() ? parents.next() : DriveApp.getRootFolder();
  const existing = parent.getFoldersByName('forms');
  const folder = existing.hasNext() ? existing.next() : parent.createFolder('forms');
  DriveApp.getFileById(cachedFormId(normal)).moveTo(folder);
  DriveApp.getFileById(cachedFormId(correction)).moveTo(folder);
  return folder;
}

function addText(
  form: GoogleAppsScript.Forms.Form,
  registry: FormRegistryRow[],
  formType: FormRegistryRow['formType'],
  fieldKey: string,
  eventId: string,
  title: string,
  displayOrder: number,
  required: boolean,
): GoogleAppsScript.Forms.TextItem {
  const item = form.addTextItem().setTitle(title).setRequired(required);
  if (isStudentIdField(fieldKey)) {
    item.setValidation(
      FormApp.createTextValidation()
        .requireTextMatchesPattern(STUDENT_ID_RESPONSE_PATTERN)
        .setHelpText(STUDENT_ID_RESPONSE_ERROR)
        .build(),
    );
  }
  addRegistry(registry, formType, form, item, title, fieldKey, eventId, 'text', displayOrder);
  return item;
}

function addParagraph(
  form: GoogleAppsScript.Forms.Form,
  registry: FormRegistryRow[],
  formType: FormRegistryRow['formType'],
  fieldKey: string,
  eventId: string,
  title: string,
  displayOrder: number,
  required: boolean,
  helpText: string,
): GoogleAppsScript.Forms.ParagraphTextItem {
  const item = form.addParagraphTextItem().setTitle(title).setHelpText(helpText).setRequired(required);
  addRegistry(registry, formType, form, item, title, fieldKey, eventId, 'paragraph_text', displayOrder);
  return item;
}

function addRegistry(
  registry: FormRegistryRow[],
  formType: FormRegistryRow['formType'],
  form: GoogleAppsScript.Forms.Form,
  item: RegistryItem,
  title: string,
  fieldKey: string,
  eventId: string,
  itemType: string,
  displayOrder: number,
): void {
  registry.push({
    formType, formId: cachedFormId(form), itemId: String(item.getId()), fieldKey, eventId,
    title, itemType, displayOrder, enabled: true,
  });
}
