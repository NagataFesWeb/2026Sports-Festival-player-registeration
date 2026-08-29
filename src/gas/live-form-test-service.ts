import { LIVE_FORM_TEST_HEADERS, SHEETS } from '../shared/constants';
import type { EventSetting, FormRegistryRow, RuleSetting, Student } from '../shared/types';
import { appliesToGrade } from '../core/settings';
import { convertFormAnswer } from '../core/form-response';
import { duplicateCandidates } from '../core/duplicate-selection';
import { validateSubmission } from '../core/validation';
import {
  buildLiveFormTestCases,
  compareLiveFormTestOutcome,
  describeDifference,
  isSameAnswerSet,
  issueCodesOf,
  pickRegistryRowForAnswer,
  summarizeItems,
  type LiveFormTestOutcome,
} from '../core/live-form-test';
import { assertAuthorized } from './auth-service';
import {
  findSubmission,
  readApprovalHistory,
  readIssues,
  readItems,
  readRawFormResponses,
  readRegistrations,
  readStudents,
  readSubmissions,
  removeRawFormResponses,
  removeSubmissionWithItems,
  replaceIssuesForSubmissions,
} from './repository';
import { readEventSettings, readFormDesign, readFormRegistry, readRuleSettings } from './settings-repository';
import { retryFailedFormResponses } from './form-response-service';
import { revalidateAffectedSubmissions } from './service';

/**
 * 実機テスト。本物のGoogleフォームへ回答を投入し、取込と検査の結果が
 * 同じ入力に対する検査結果と一致するかを照合する。
 * 実在の氏名・学籍番号は戻り値へ入れず、シートの中だけで扱う。
 */

/** 生徒マスターに実在しない入力者番号として使う。学年1〜3の範囲外なので実在しない。 */
const TEST_SUBMITTER_STUDENT_ID = '9999';
const TEST_SUBMITTER_NAME = '実機テスト（削除予定）';
const TEST_CORRECTION_REASON = '実機テストのための送信です。確認後に削除します。';
const IMPORT_WAIT_MILLISECONDS = 8000;
const TERMINAL_STATUSES = ['APPROVED', 'APPLIED'] as const;

const COLUMNS = {
  caseId: 1,
  formType: 2,
  description: 3,
  state: 4,
  prefilledUrl: 5,
  responseId: 6,
  submissionId: 7,
  importPath: 8,
  verdict: 9,
  difference: 10,
  executedAt: 11,
  answerJson: 12,
} as const;

const STATES = {
  prepared: '未送信',
  submitted: '送信済み',
  submitFailed: '送信エラー',
  notImported: '未取込',
  checked: '照合済み',
} as const;

export interface LiveFormTestPrepareResult {
  targetGrade: number;
  targetClass: number;
  classStudentCount: number;
  caseCount: number;
  normalCaseCount: number;
  correctionCaseCount: number;
  existingSubmissionCount: number;
  existingRegistrationCount: number;
  normalFormLimitsOneResponse: boolean;
  message: string;
}

export interface LiveFormTestSubmitResult {
  submittedCount: number;
  failedCount: number;
  triggerImportedCount: number;
  retryImportedCount: number;
  notImportedCount: number;
  message: string;
}

export interface LiveFormTestCaseVerdict {
  caseId: string;
  formType: 'normal' | 'correction';
  verdict: 'OK' | 'NG' | '未取込';
  difference: string;
  importPath: string;
}

export interface LiveFormTestCollectResult {
  checkedCount: number;
  okCount: number;
  ngCount: number;
  notImportedCount: number;
  cases: LiveFormTestCaseVerdict[];
  message: string;
}

export interface LiveFormTestCleanupResult {
  removedSubmissionCount: number;
  removedRawResponseCount: number;
  keptApprovalHistoryCount: number;
  revalidatedSubmissionCount: number;
  message: string;
}

interface LiveFormTestRow {
  row: number;
  caseId: string;
  formType: 'normal' | 'correction';
  description: string;
  state: string;
  responseId: string;
  submissionId: string;
  answers: Record<string, string>;
}

function sheet(): GoogleAppsScript.Spreadsheet.Sheet {
  const book = SpreadsheetApp.getActiveSpreadsheet();
  const existing = book.getSheetByName(SHEETS.liveFormTest);
  const target = existing ?? book.insertSheet(SHEETS.liveFormTest);
  target.getRange(1, 1, 1, LIVE_FORM_TEST_HEADERS.length).setValues([[...LIVE_FORM_TEST_HEADERS]]);
  target.setFrozenRows(1);
  target.hideColumns(COLUMNS.answerJson);
  return target;
}

function readRows(): LiveFormTestRow[] {
  const target = sheet();
  if (target.getLastRow() < 2) return [];
  return target.getRange(2, 1, target.getLastRow() - 1, LIVE_FORM_TEST_HEADERS.length)
    .getDisplayValues()
    .map((values, index) => ({
      row: index + 2,
      caseId: values[COLUMNS.caseId - 1] ?? '',
      formType: (values[COLUMNS.formType - 1] === 'correction' ? 'correction' : 'normal') as 'normal' | 'correction',
      description: values[COLUMNS.description - 1] ?? '',
      state: values[COLUMNS.state - 1] ?? '',
      responseId: values[COLUMNS.responseId - 1] ?? '',
      submissionId: values[COLUMNS.submissionId - 1] ?? '',
      answers: parseAnswers(values[COLUMNS.answerJson - 1] ?? ''),
    }))
    .filter((row) => row.caseId !== '');
}

function parseAnswers(json: string): Record<string, string> {
  if (json === '') return {};
  try {
    const parsed: unknown = JSON.parse(json);
    if (!parsed || typeof parsed !== 'object') return {};
    const result: Record<string, string> = {};
    Object.entries(parsed as Record<string, unknown>).forEach(([key, value]) => {
      result[key] = String(value ?? '');
    });
    return result;
  } catch {
    return {};
  }
}

function formIdFor(formType: 'normal' | 'correction'): string {
  const design = readFormDesign();
  const formId = formType === 'normal' ? design.normalFormId : design.correctionFormId;
  if (formId === '') {
    throw new Error('公開中のフォームIDが設定されていません。先にフォームを作成・公開してください。');
  }
  return formId;
}

function createItemResponse(
  item: GoogleAppsScript.Forms.Item,
  value: string,
): GoogleAppsScript.Forms.ItemResponse {
  switch (item.getType()) {
    case FormApp.ItemType.TEXT:
      return item.asTextItem().createResponse(value);
    case FormApp.ItemType.PARAGRAPH_TEXT:
      return item.asParagraphTextItem().createResponse(value);
    case FormApp.ItemType.LIST:
      return item.asListItem().createResponse(value);
    case FormApp.ItemType.MULTIPLE_CHOICE:
      return item.asMultipleChoiceItem().createResponse(value);
    default:
      throw new Error(`実機テストが対応していない設問形式です：${item.getTitle()}`);
  }
}

/**
 * 分岐の選択肢から進むページを特定し、そのページにある設問のIDを集める。
 * 通常フォームは学年ページごとに同じ`field_key`の設問を作るため、回答を入れる設問を
 * ページで選ばないと、実際に表示されるページの必須項目が空欄のまま残る。
 */
function answeredPageItemIds(
  form: GoogleAppsScript.Forms.Form,
  registry: FormRegistryRow[],
  answers: Record<string, string>,
): Set<string> {
  const empty = new Set<string>();
  const branchFieldKey = registry[0]?.formType === 'correction' ? 'correction_event_id' : 'target_grade';
  const answer = (answers[branchFieldKey] ?? '').trim();
  const branchRow = registry.find((row) => row.enabled && row.fieldKey === branchFieldKey);
  if (answer === '' || !branchRow) return empty;
  const branchItem = form.getItemById(Number(branchRow.itemId));
  if (!branchItem || branchItem.getType() !== FormApp.ItemType.MULTIPLE_CHOICE) return empty;
  const page = branchItem.asMultipleChoiceItem().getChoices()
    .find((choice) => choice.getValue() === answer)?.getGotoPage();
  if (!page) return empty;
  const items = form.getItems();
  const start = items.findIndex((item) => item.getId() === page.getId());
  if (start < 0) return empty;
  const ids = new Set<string>();
  for (let index = start + 1; index < items.length; index += 1) {
    const item = items[index]!;
    if (item.getType() === FormApp.ItemType.PAGE_BREAK) break;
    ids.add(String(item.getId()));
  }
  return ids;
}

function buildFormResponse(
  form: GoogleAppsScript.Forms.Form,
  registry: FormRegistryRow[],
  answers: Record<string, string>,
): GoogleAppsScript.Forms.FormResponse {
  const pageItemIds = answeredPageItemIds(form, registry, answers);
  let response = form.createResponse();
  Object.keys(answers).forEach((fieldKey) => {
    const value = answers[fieldKey] ?? '';
    if (value === '') return;
    const registryRow = pickRegistryRowForAnswer(registry, fieldKey, pageItemIds);
    if (!registryRow) {
      throw new Error(`フォーム項目対応表に「${fieldKey}」がありません。フォームを作り直してから実行してください。`);
    }
    const item = form.getItemById(Number(registryRow.itemId));
    if (!item) {
      throw new Error(`フォームに「${registryRow.title}」の設問が見つかりません。フォームを作り直してから実行してください。`);
    }
    response = response.withItemResponse(createItemResponse(item, value));
  });
  return response;
}

function pickUnknownStudentId(
  students: Student[],
  targetGrade: number,
  targetClass: number,
): string {
  const known = new Set(students.map((student) => student.studentId));
  for (let attendance = 99; attendance >= 40; attendance -= 1) {
    const candidate = `${targetGrade}${targetClass}${String(attendance).padStart(2, '0')}`;
    if (!known.has(candidate)) return candidate;
  }
  return '';
}

function pickOtherClassStudentId(
  students: Student[],
  targetGrade: number,
  targetClass: number,
): string {
  const sameGrade = students.find((student) =>
    student.grade === targetGrade && student.classNumber !== targetClass);
  if (sameGrade) return sameGrade.studentId;
  return students.find((student) => student.classNumber !== targetClass)?.studentId ?? '';
}

function assertNoPendingTestData(): void {
  const rows = readRows();
  const pending = rows.filter((row) => row.submissionId !== '' || row.responseId !== '');
  if (pending.length > 0) {
    throw new Error('前回の実機テストの申請が残っています。先に「実機テストの結果を片付ける」を実行してください。');
  }
}

export function prepareLiveFormTest(
  targetGrade: number,
  targetClass: number,
  allowExistingClassData = false,
): LiveFormTestPrepareResult {
  assertAuthorized();
  if (!Number.isInteger(targetGrade) || targetGrade < 1 || targetGrade > 3) {
    throw new Error('対象の学年は1から3の数字で指定してください。');
  }
  if (!Number.isInteger(targetClass) || targetClass < 1 || targetClass > 8) {
    throw new Error('対象の組は1から8の数字で指定してください。');
  }
  const design = readFormDesign();
  if (design.formStatus !== '公開中' && design.formStatus !== '受付停止') {
    throw new Error(`フォームが公開されていません（現在：${design.formStatus}）。公開してから実機テストを実行してください。`);
  }
  assertNoPendingTestData();

  const students = readStudents();
  if (students.length === 0) {
    throw new Error('生徒マスターが空です。先に生徒マスターを入力してください。');
  }
  const classStudents = students
    .filter((student) => student.grade === targetGrade && student.classNumber === targetClass)
    .sort((left, right) => left.attendanceNumber - right.attendanceNumber);
  if (classStudents.length === 0) {
    throw new Error(`生徒マスターに${targetGrade}年${targetClass}組の生徒がいません。対象の学年・組を確認してください。`);
  }

  const submissions = readSubmissions();
  const existingSubmissionCount = submissions.filter((submission) =>
    submission.targetGrade === targetGrade && submission.targetClass === targetClass).length;
  const existingRegistrationCount = readRegistrations().filter((registration) =>
    registration.grade === targetGrade && registration.classNumber === targetClass).length;
  if (!allowExistingClassData && (existingSubmissionCount > 0 || existingRegistrationCount > 0)) {
    throw new Error(
      `${targetGrade}年${targetClass}組には、すでに申請${existingSubmissionCount}件・登録データ${existingRegistrationCount}件があります。`
      + 'テストの申請が本物の申請と混ざるため、まだ申請のないクラスを選ぶか、混ざることを承知のうえで実行してください。',
    );
  }

  const normalRegistry = readFormRegistry(design.normalFormId);
  const correctionRegistry = readFormRegistry(design.correctionFormId);
  if (normalRegistry.length === 0 || correctionRegistry.length === 0) {
    throw new Error('フォーム項目対応表が見つかりません。設定画面からフォームを作り直してください。');
  }
  const events = readEventSettings()
    .filter((event) => event.enabled && appliesToGrade(event, targetGrade))
    .sort((left, right) => left.displayOrder - right.displayOrder);
  if (events.length === 0) {
    throw new Error(`${targetGrade}年が対象の有効な競技がありません。競技設定を確認してください。`);
  }

  const cases = buildLiveFormTestCases({
    targetGrade,
    targetClass,
    classStudents,
    otherClassStudentId: pickOtherClassStudentId(students, targetGrade, targetClass),
    unknownStudentId: pickUnknownStudentId(students, targetGrade, targetClass),
    submitterStudentId: TEST_SUBMITTER_STUDENT_ID,
    submitterName: TEST_SUBMITTER_NAME,
    correctionReason: TEST_CORRECTION_REASON,
    events,
    normalRegistry,
    correctionRegistry,
  });
  if (cases.length === 0) {
    throw new Error('テストケースを作れませんでした。フォーム項目対応表と競技設定を確認してください。');
  }

  const target = sheet();
  if (target.getLastRow() >= 2) {
    target.getRange(2, 1, target.getLastRow() - 1, LIVE_FORM_TEST_HEADERS.length).clearContent();
  }
  const executedAt = new Date().toISOString();
  const values = cases.map((testCase) => {
    const registry = testCase.formType === 'normal' ? normalRegistry : correctionRegistry;
    const form = FormApp.openById(formIdFor(testCase.formType));
    const prefilledUrl = buildFormResponse(form, registry, testCase.answersByFieldKey).toPrefilledUrl();
    return [
      testCase.caseId,
      testCase.formType,
      testCase.description,
      STATES.prepared,
      prefilledUrl,
      '', '', '', '', '',
      executedAt,
      JSON.stringify(testCase.answersByFieldKey),
    ];
  });
  target.getRange(2, 1, values.length, LIVE_FORM_TEST_HEADERS.length).setValues(values);
  SpreadsheetApp.getActiveSpreadsheet().setActiveSheet(target);

  const normalCaseCount = cases.filter((testCase) => testCase.formType === 'normal').length;
  const limitsOneResponse = design.normalResubmission === '禁止';
  return {
    targetGrade,
    targetClass,
    classStudentCount: classStudents.length,
    caseCount: cases.length,
    normalCaseCount,
    correctionCaseCount: cases.length - normalCaseCount,
    existingSubmissionCount,
    existingRegistrationCount,
    normalFormLimitsOneResponse: limitsOneResponse,
    message: `${targetGrade}年${targetClass}組を対象に、テストを${cases.length}件用意しました。`
      + `「${SHEETS.liveFormTest}」シートの事前入力URLを開いて送信するか、自動送信を実行してください。`
      + (limitsOneResponse
        ? '通常フォームは1アカウント1回だけ送信できる設定です。手動送信では通常フォームのテストは1件だけになります。'
        : ''),
  };
}

function markRow(
  target: GoogleAppsScript.Spreadsheet.Sheet,
  row: number,
  column: number,
  value: string,
): void {
  target.getRange(row, column).setValue(value);
}

export function submitLiveFormTestAutomatically(): LiveFormTestSubmitResult {
  assertAuthorized();
  const target = sheet();
  const rows = readRows().filter((row) => row.state === STATES.prepared);
  if (rows.length === 0) {
    throw new Error('送信できるテストがありません。先に「実機テストを準備する」を実行してください。');
  }
  const design = readFormDesign();
  const registryByType = {
    normal: readFormRegistry(design.normalFormId),
    correction: readFormRegistry(design.correctionFormId),
  };
  let submittedCount = 0;
  let failedCount = 0;
  const submittedRows: LiveFormTestRow[] = [];
  rows.forEach((row) => {
    try {
      const form = FormApp.openById(formIdFor(row.formType));
      const response = buildFormResponse(form, registryByType[row.formType], row.answers).submit();
      markRow(target, row.row, COLUMNS.responseId, response.getId() ?? '');
      markRow(target, row.row, COLUMNS.state, STATES.submitted);
      submittedCount += 1;
      submittedRows.push({ ...row, responseId: response.getId() ?? '' });
    } catch (error) {
      failedCount += 1;
      markRow(target, row.row, COLUMNS.state, STATES.submitFailed);
      markRow(target, row.row, COLUMNS.difference, error instanceof Error ? error.message : '送信に失敗しました。');
    }
  });

  if (submittedCount > 0) Utilities.sleep(IMPORT_WAIT_MILLISECONDS);
  let triggerImportedCount = 0;
  const pendingAfterTrigger: LiveFormTestRow[] = [];
  submittedRows.forEach((row) => {
    if (isImported(row.formType, row.responseId)) {
      markRow(target, row.row, COLUMNS.importPath, 'トリガー');
      triggerImportedCount += 1;
    } else {
      pendingAfterTrigger.push(row);
    }
  });

  let retryImportedCount = 0;
  if (pendingAfterTrigger.length > 0) {
    retryFailedFormResponses(Math.max(pendingAfterTrigger.length, 25));
    pendingAfterTrigger.forEach((row) => {
      if (isImported(row.formType, row.responseId)) {
        markRow(target, row.row, COLUMNS.importPath, '再処理');
        retryImportedCount += 1;
      } else {
        markRow(target, row.row, COLUMNS.importPath, '未取込');
        markRow(target, row.row, COLUMNS.state, STATES.notImported);
      }
    });
  }

  const notImportedCount = submittedCount - triggerImportedCount - retryImportedCount;
  return {
    submittedCount,
    failedCount,
    triggerImportedCount,
    retryImportedCount,
    notImportedCount,
    message: `${submittedCount}件を送信しました。`
      + `送信トリガーで取り込めたのは${triggerImportedCount}件、`
      + `「回答取込を点検・再処理」で取り込めたのは${retryImportedCount}件、`
      + `取り込めなかったのは${notImportedCount}件です。`
      + (failedCount > 0 ? `送信できなかったテストが${failedCount}件あります。` : ''),
  };
}

function isImported(formType: 'normal' | 'correction', responseId: string): boolean {
  if (responseId === '') return false;
  const formId = formIdFor(formType);
  return readRawFormResponses().some((record) =>
    record.formId === formId
    && record.responseId === responseId
    && record.processingStatus === 'PROCESSED'
    && record.submissionId !== '');
}

interface ExpectedOutcomeInput {
  formType: 'normal' | 'correction';
  answers: Record<string, string>;
  formId: string;
  submittedAt: string;
  respondentEmail: string;
  receptionOpen: boolean;
  registry: FormRegistryRow[];
  events: EventSetting[];
  students: Student[];
  rules: RuleSetting[];
  sameClassInitialSubmissionCount: number;
}

/** 投入した回答を、取込と同じ変換・検査へ通したときの結果。 */
function expectedOutcome(input: ExpectedOutcomeInput): LiveFormTestOutcome {
  const converted = convertFormAnswer({
    formId: input.formId,
    responseId: 'live-form-test-expected',
    formType: input.formType,
    submittedAt: input.submittedAt,
    respondentEmail: input.respondentEmail,
    receptionOpen: input.receptionOpen,
    answersByFieldKey: input.answers,
    registry: input.registry,
    events: input.events,
  });
  const validation = validateSubmission(converted.submission, converted.items, {
    students: input.students,
    sameClassInitialSubmissionCount: input.sameClassInitialSubmissionCount,
    rules: input.rules,
  });
  return {
    issueCodes: issueCodesOf(validation.issues),
    targetGrade: converted.submission.targetGrade,
    targetClass: converted.submission.targetClass,
    itemInputs: summarizeItems(validation.normalizedItems),
  };
}

export function collectLiveFormTestResults(): LiveFormTestCollectResult {
  assertAuthorized();
  const target = sheet();
  const rows = readRows();
  if (rows.length === 0) {
    throw new Error('照合できるテストがありません。先に「実機テストを準備する」を実行してください。');
  }
  const design = readFormDesign();
  const rawRecords = readRawFormResponses();
  const submissions = readSubmissions();
  const allItems = readItems();
  const allIssues = readIssues();
  const students = readStudents();
  const registryByType = {
    normal: readFormRegistry(design.normalFormId),
    correction: readFormRegistry(design.correctionFormId),
  };
  const events = readEventSettings();
  const rules = readRuleSettings();
  const claimedResponseIds = new Set(rows.map((row) => row.responseId).filter((value) => value !== ''));

  const verdicts: LiveFormTestCaseVerdict[] = [];
  rows.forEach((row) => {
    const formId = formIdFor(row.formType);
    let responseId = row.responseId;
    if (responseId === '') {
      const matched = rawRecords.find((record) =>
        record.formId === formId
        && !claimedResponseIds.has(record.responseId)
        && isSameAnswerSet(row.answers, parseAnswers(record.answerJson)));
      if (matched) {
        responseId = matched.responseId;
        claimedResponseIds.add(responseId);
        markRow(target, row.row, COLUMNS.responseId, responseId);
        markRow(target, row.row, COLUMNS.state, STATES.submitted);
        markRow(target, row.row, COLUMNS.importPath, '手動送信');
      }
    }
    const raw = rawRecords.find((record) =>
      record.formId === formId && record.responseId === responseId && responseId !== '');
    const submission = raw?.submissionId ? findSubmission(raw.submissionId) : undefined;
    if (!raw || !submission) {
      markRow(target, row.row, COLUMNS.verdict, '未取込');
      markRow(target, row.row, COLUMNS.difference, 'フォーム回答原本または承認待ちに、この回答が見つかりません。');
      verdicts.push({
        caseId: row.caseId,
        formType: row.formType,
        verdict: '未取込',
        difference: '回答が取り込まれていません。',
        importPath: '',
      });
      return;
    }
    markRow(target, row.row, COLUMNS.submissionId, submission.submissionId);
    const items = allItems.filter((item) => item.submissionId === submission.submissionId);
    const issues = allIssues.filter((issue) => issue.submissionId === submission.submissionId);
    const actual: LiveFormTestOutcome = {
      issueCodes: issueCodesOf(issues),
      targetGrade: submission.targetGrade,
      targetClass: submission.targetClass,
      itemInputs: summarizeItems(items),
    };
    const expected = expectedOutcome({
      formType: row.formType,
      answers: row.answers,
      formId,
      submittedAt: raw.submittedAt,
      respondentEmail: submission.submitterEmail,
      receptionOpen: design.formStatus !== '受付停止',
      registry: registryByType[row.formType],
      events,
      students,
      rules,
      sameClassInitialSubmissionCount: duplicateCandidates(submissions, submission).length,
    });
    const difference = compareLiveFormTestOutcome(expected, actual);
    const differenceText = describeDifference(difference);
    markRow(target, row.row, COLUMNS.state, STATES.checked);
    markRow(target, row.row, COLUMNS.verdict, difference.ok ? 'OK' : 'NG');
    markRow(target, row.row, COLUMNS.difference, differenceText);
    verdicts.push({
      caseId: row.caseId,
      formType: row.formType,
      verdict: difference.ok ? 'OK' : 'NG',
      difference: differenceText,
      importPath: target.getRange(row.row, COLUMNS.importPath).getDisplayValue(),
    });
  });

  const okCount = verdicts.filter((verdict) => verdict.verdict === 'OK').length;
  const ngCount = verdicts.filter((verdict) => verdict.verdict === 'NG').length;
  const notImportedCount = verdicts.filter((verdict) => verdict.verdict === '未取込').length;
  return {
    checkedCount: verdicts.length,
    okCount,
    ngCount,
    notImportedCount,
    cases: verdicts,
    message: `${verdicts.length}件を照合し、一致${okCount}件、不一致${ngCount}件、未取込${notImportedCount}件でした。`,
  };
}

export function cleanupLiveFormTest(): LiveFormTestCleanupResult {
  assertAuthorized();
  const target = sheet();
  const rows = readRows();
  const submissionIds = [...new Set(rows.map((row) => row.submissionId).filter((value) => value !== ''))];
  const responseIds = [...new Set(rows.map((row) => row.responseId).filter((value) => value !== ''))];
  const submissions = readSubmissions();
  const testSubmissions = submissions.filter((submission) => submissionIds.includes(submission.submissionId));
  const approved = testSubmissions.filter((submission) =>
    (TERMINAL_STATUSES as readonly string[]).includes(submission.status));
  if (approved.length > 0) {
    throw new Error(
      `承認済みのテスト申請が${approved.length}件あります。登録データへ反映されているため自動では削除しません。`
      + '「選手を変更する」から取り消してから、もう一度片付けを実行してください。',
    );
  }
  const keptApprovalHistoryCount = submissionIds
    .reduce((total, submissionId) => total + readApprovalHistory(submissionId).length, 0);
  const affectedClasses = testSubmissions.map((submission) => `${submission.targetGrade}-${submission.targetClass}`);
  const remainingIds = submissions
    .filter((submission) => !submissionIds.includes(submission.submissionId))
    .filter((submission) => affectedClasses.includes(`${submission.targetGrade}-${submission.targetClass}`))
    .map((submission) => submission.submissionId);

  if (submissionIds.length > 0) {
    replaceIssuesForSubmissions(submissionIds, []);
    submissionIds.forEach((submissionId) => removeSubmissionWithItems(submissionId));
  }
  const removedRawResponseCount = removeRawFormResponses(responseIds);
  revalidateAffectedSubmissions(remainingIds);
  if (target.getLastRow() >= 2) {
    target.getRange(2, 1, target.getLastRow() - 1, LIVE_FORM_TEST_HEADERS.length).clearContent();
  }
  return {
    removedSubmissionCount: submissionIds.length,
    removedRawResponseCount,
    keptApprovalHistoryCount,
    revalidatedSubmissionCount: remainingIds.length,
    message: `テスト申請${submissionIds.length}件とフォーム回答原本${removedRawResponseCount}件を削除しました。`
      + `同じクラスの残りの申請${remainingIds.length}件を再検査しました。`
      + (keptApprovalHistoryCount > 0
        ? `承認履歴${keptApprovalHistoryCount}件は監査のため残しています。`
        : ''),
  };
}

/** 回答本文を残したまま、テストの一覧だけを消す。フォーム側の回答は消えない。 */
export function describeLiveFormTestState(): {
  caseCount: number;
  submittedCount: number;
  pendingCleanupCount: number;
} {
  const rows = readRows();
  return {
    caseCount: rows.length,
    submittedCount: rows.filter((row) => row.responseId !== '').length,
    pendingCleanupCount: rows.filter((row) => row.submissionId !== '').length,
  };
}
