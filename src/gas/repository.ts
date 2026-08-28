import {
  APPROVAL_HEADERS,
  CHANGE_HEADERS,
  ISSUE_HEADERS,
  ITEM_HEADERS,
  MOCK_DATA_SETTING_HEADERS,
  MOCK_DATA_SETTING_KEYS,
  REGISTRATION_HEADERS,
  ROSTER_HISTORY_HEADERS,
  SHEETS,
  PRODUCTION_STUDENT_HEADERS,
  STUDENT_HEADERS,
  SUBMISSION_HEADERS
  ,RAW_FORM_RESPONSE_HEADERS
  ,SYSTEM_CONFIG_HEADERS
} from '../shared/constants';
import type {
  Registration,
  MockDataGenerationConfig,
  Student,
  Submission,
  SubmissionItem,
  SubmissionStatus,
  ValidationIssue
} from '../shared/types';
import {
  isDevelopmentMockResponseId,
  isDevelopmentMockSubmissionId,
} from '../core/mock-data-lifecycle';
import {
  buildProductionStudents,
  type ProductionStudentInputRow,
} from '../core/student-master';
import { normalizeStudentId } from '../core/normalization';

type SheetValue = string | number | boolean | Date;
type Header = readonly string[];
type Spreadsheet = ReturnType<typeof SpreadsheetApp.getActiveSpreadsheet>;
type Sheet = ReturnType<Spreadsheet['getActiveSheet']>;

const dataRowCount = (sheet: Sheet): number =>
  Math.max(0, sheet.getLastRow() - 1);

function spreadsheet(): Spreadsheet {
  const active = SpreadsheetApp.getActiveSpreadsheet();
  if (!active) {
    throw new Error('管理用スプレッドシートを開いてから、もう一度操作してください。');
  }
  return active;
}

export function requireSheet(name: string): Sheet {
  const sheet = spreadsheet().getSheetByName(name);
  if (!sheet) {
    throw new Error(`「${name}」シートがありません。最初に初期設定を実行してください。`);
  }
  return sheet;
}

function ensureSheet(name: string, headers?: Header): Sheet {
  const book = spreadsheet();
  const sheet = book.getSheetByName(name) ?? book.insertSheet(name);
  if (headers && headers.length > 0) {
    sheet.getRange(1, 1, 1, headers.length).setValues([[...headers]]);
    sheet.setFrozenRows(1);
  }
  return sheet;
}

export function ensureApplicationSheets(): void {
  const dashboard = ensureSheet(SHEETS.dashboard);
  ensureSheet(SHEETS.submissions, SUBMISSION_HEADERS);
  ensureSheet(SHEETS.items, ITEM_HEADERS);
  ensureSheet(SHEETS.issues, ISSUE_HEADERS);
  ensureProductionStudentSheet();
  ensureSheet(SHEETS.students, STUDENT_HEADERS);
  ensureSheet(SHEETS.registrations, REGISTRATION_HEADERS);
  ensureSheet(SHEETS.rosterHistory, ROSTER_HISTORY_HEADERS);
  ensureSheet(SHEETS.mockDataSettings, MOCK_DATA_SETTING_HEADERS);
  ensureSheet(SHEETS.approvals, APPROVAL_HEADERS);
  ensureSheet(SHEETS.changeHistory, CHANGE_HEADERS);
  ensureSheet(SHEETS.rawFormResponses, RAW_FORM_RESPONSE_HEADERS);
  ensureSheet(SHEETS.systemConfig, SYSTEM_CONFIG_HEADERS);
  spreadsheet().setActiveSheet(dashboard);
}

function ensureProductionStudentSheet(): Sheet {
  const sheet = ensureSheet(SHEETS.productionStudents, PRODUCTION_STUDENT_HEADERS);
  sheet.setColumnWidth(1, 130);
  sheet.setColumnWidth(2, 240);
  sheet.setColumnWidths(3, 3, 120);
  sheet.getRange('A:B').setBackground('#fff7d6');
  sheet.getRange('F:F').setBackground('#fff7d6');
  sheet.getRange('C:E').setBackground('#f1f5f9');
  sheet.getRange(1, 1, 1, PRODUCTION_STUDENT_HEADERS.length)
    .setFontWeight('bold').setBackground('#dbeafe');
  sheet.getRange('A:A').setNumberFormat('@');
  sheet.getRange('A1').setNote('4ケタの学籍番号を入力してください。例：1324');
  sheet.getRange('B1').setNote('生徒の氏名を入力してください。実在データをソースコードやテストへコピーしないでください。');
  sheet.getRange('F1').setNote('性別をmまたはfで入力してください。大文字・小文字はどちらでも構いません。');
  sheet.getRange('C1:E1').setNote('学籍番号から自動で表示されます。この列は入力しません。');
  const validationRows = Math.max(1, sheet.getMaxRows() - 1);
  sheet.getRange(2, 1, validationRows, 1).setDataValidation(
    SpreadsheetApp.newDataValidation()
      .requireFormulaSatisfied('=OR(A2="",REGEXMATCH(TO_TEXT(A2),"^[0-9]{4}$"))')
      .setAllowInvalid(false)
      .setHelpText('4ケタの学籍番号を数値で入力してください')
      .build(),
  );
  sheet.getRange(2, 6, validationRows, 1).setDataValidation(
    SpreadsheetApp.newDataValidation()
      .requireFormulaSatisfied('=OR(F2="",LOWER(F2)="m",LOWER(F2)="f")')
      .setAllowInvalid(false)
      .setHelpText('性別はmまたはfで入力してください')
      .build(),
  );
  const lastRow = Math.max(2, sheet.getLastRow());
  const derivedValues = sheet.getRange(2, 3, lastRow - 1, 3).getDisplayValues();
  const derivedIsEmpty = derivedValues.every((row) => row.every((value) => value === ''));
  if (derivedIsEmpty) {
    sheet.getRange('C2').setFormula('=ARRAYFORMULA(IF(A2:A="","",IFERROR(VALUE(LEFT(A2:A&"",1)),"")))');
    sheet.getRange('D2').setFormula('=ARRAYFORMULA(IF(A2:A="","",IFERROR(VALUE(MID(A2:A&"",2,1)),"")))');
    sheet.getRange('E2').setFormula('=ARRAYFORMULA(IF(A2:A="","",IFERROR(VALUE(RIGHT(A2:A&"",2)),"")))');
  }
  return sheet;
}

export function openProductionStudentSheet(): void {
  const sheet = ensureProductionStudentSheet();
  spreadsheet().setActiveSheet(sheet);
  sheet.activate();
}

export function ensureMockDataSettings(students: Student[]): void {
  const sheet = ensureSheet(SHEETS.mockDataSettings, MOCK_DATA_SETTING_HEADERS);
  const oldRows = sheet.getLastRow() < 2
    ? [] : sheet.getRange(2, 1, sheet.getLastRow() - 1, MOCK_DATA_SETTING_HEADERS.length).getValues();
  const oldValues = new Map(oldRows.map((row) => [text(row[0]), row[1] as SheetValue]));
  const checked = (key: string): boolean => {
    const value = oldValues.get(key);
    return value === undefined ? true : value === true || text(value).toUpperCase() === 'TRUE';
  };
  const targetGrades = [1, 2, 3].filter((grade) => checked(`${MOCK_DATA_SETTING_KEYS.targetGradePrefix}${grade}年`));
  const targetClasses = [1, 2, 3, 4, 5, 6, 7, 8]
    .filter((classNumber) => checked(`${MOCK_DATA_SETTING_KEYS.targetClassPrefix}${classNumber}組`));
  const normalFormEnabled = checked(MOCK_DATA_SETTING_KEYS.normalFormEnabled);
  const correctionFormEnabled = checked(MOCK_DATA_SETTING_KEYS.correctionFormEnabled);
  const selectedStudents = students.filter((student) =>
    targetGrades.includes(student.grade) && targetClasses.includes(student.classNumber));
  const selectedClassCount = new Set(selectedStudents.map((student) =>
    `${student.grade}:${student.classNumber}`)).size;
  const submissionCount = correctionFormEnabled ? selectedStudents.length : selectedClassCount;
  const oldError = Math.max(0, Math.trunc(numberValue(oldValues.get(MOCK_DATA_SETTING_KEYS.errorSubmissionCount))));
  const oldWarning = Math.max(0, Math.trunc(numberValue(oldValues.get(MOCK_DATA_SETTING_KEYS.warningSubmissionCount))));
  const defaultError = oldValues.has(MOCK_DATA_SETTING_KEYS.errorSubmissionCount) ? oldError : 20;
  const defaultWarning = oldValues.has(MOCK_DATA_SETTING_KEYS.warningSubmissionCount) ? oldWarning : 20;
  const errorCount = Math.min(defaultError, submissionCount);
  const warningCount = Math.min(defaultWarning, Math.max(0, submissionCount - errorCount));
  const rows: SheetValue[][] = [
    ...[1, 2, 3].map((grade) => [
      `${MOCK_DATA_SETTING_KEYS.targetGradePrefix}${grade}年`, targetGrades.includes(grade),
      `チェックすると${grade}年を作成対象にします。`,
    ]),
    ...[1, 2, 3, 4, 5, 6, 7, 8].map((classNumber) => [
      `${MOCK_DATA_SETTING_KEYS.targetClassPrefix}${classNumber}組`, targetClasses.includes(classNumber),
      `チェックすると、選んだ学年の${classNumber}組を作成対象にします。`,
    ]),
    [MOCK_DATA_SETTING_KEYS.normalFormEnabled, normalFormEnabled,
      'チェックすると、選んだ各クラスにつき通常フォームの疑似回答を1件だけ作ります。'],
    [MOCK_DATA_SETTING_KEYS.correctionFormEnabled, correctionFormEnabled,
      'チェックすると、通常回答の後に、競技全体を直す修正フォームの疑似回答を追加します。'],
    [MOCK_DATA_SETTING_KEYS.errorSubmissionCount, errorCount,
      'この件数の申請に、存在しない番号または別クラスの番号を入れます。'],
    [MOCK_DATA_SETTING_KEYS.warningSubmissionCount, warningCount,
      'この件数の申請に、氏名差異・代理入力・受付停止のいずれかを入れます。'],
  ];
  const oldDataRows = Math.max(0, sheet.getLastRow() - 1);
  // 入力規則だけが値のない行にも残るため、B列の全データ行を先に解除する。
  // flushしないと、同一実行内のsetValuesが旧規則で判定される場合がある。
  const validationRows = Math.max(1, sheet.getMaxRows() - 1);
  sheet.getRange(2, 2, validationRows, 1).clearDataValidations();
  SpreadsheetApp.flush();
  if (oldDataRows > 0) {
    const oldRange = sheet.getRange(2, 1, oldDataRows, MOCK_DATA_SETTING_HEADERS.length);
    oldRange.clearContent();
  }
  sheet.getRange(2, 1, rows.length, MOCK_DATA_SETTING_HEADERS.length).setValues(rows);
  sheet.getRange(2, 2, 13, 1).setDataValidation(
    SpreadsheetApp.newDataValidation().requireCheckbox().setAllowInvalid(false).build(),
  );
  sheet.getRange(15, 2, 2, 1).setDataValidation(
    SpreadsheetApp.newDataValidation().requireNumberBetween(0, 5000).setAllowInvalid(false).build(),
  ).setNumberFormat('0');
  sheet.setColumnWidth(1, 210);
  sheet.setColumnWidth(2, 120);
  sheet.setColumnWidth(3, 560);
  sheet.getRange(1, 1, 1, MOCK_DATA_SETTING_HEADERS.length).setFontWeight('bold').setBackground('#dbeafe');
  sheet.getRange('A2:C4').setBackground('#dcfce7');
  sheet.getRange('A5:C12').setBackground('#e0f2fe');
  sheet.getRange('A13:C14').setBackground('#ede9fe');
  sheet.getRange('A15:C16').setBackground('#fef3c7');
  sheet.getRange('B2:B14').setHorizontalAlignment('center');
  sheet.getRange('B15').setNote('実際に作成する申請数を超えた場合は、自動的に申請数以下へ調整します。');
}

export function readMockDataSettings(students: Student[]): MockDataGenerationConfig {
  ensureMockDataSettings(students);
  const rows = readRows(SHEETS.mockDataSettings, MOCK_DATA_SETTING_HEADERS);
  const values = new Map(rows.map((row) => [text(row[0]), row[1]]));
  const targetGrades = [1, 2, 3].filter((grade) =>
    booleanValue(values.get(`${MOCK_DATA_SETTING_KEYS.targetGradePrefix}${grade}年`)));
  const targetClasses = [1, 2, 3, 4, 5, 6, 7, 8].filter((classNumber) =>
    booleanValue(values.get(`${MOCK_DATA_SETTING_KEYS.targetClassPrefix}${classNumber}組`)));
  const targetFormTypes: Array<'normal' | 'correction'> = [];
  if (booleanValue(values.get(MOCK_DATA_SETTING_KEYS.normalFormEnabled))) targetFormTypes.push('normal');
  if (booleanValue(values.get(MOCK_DATA_SETTING_KEYS.correctionFormEnabled))) targetFormTypes.push('correction');
  if (targetGrades.length === 0) throw new Error('「対象学年」を1つ以上チェックしてください。例：1年だけ作る場合は「対象学年：1年」をチェックします。');
  if (targetClasses.length === 0) throw new Error('「対象クラス」を1つ以上チェックしてください。例：1〜3組だけ作る場合は1組、2組、3組をチェックします。');
  if (targetFormTypes.length === 0) throw new Error('「通常フォーム」または「修正フォーム」を1つ以上チェックしてください。両方を作る場合は両方にチェックします。');
  const selectedStudents = students.filter((student) =>
    targetGrades.includes(student.grade) && targetClasses.includes(student.classNumber));
  const selectedClassCount = new Set(selectedStudents.map((student) =>
    `${student.grade}:${student.classNumber}`)).size;
  const submissionCount = targetFormTypes.includes('correction')
    ? selectedStudents.length
    : selectedClassCount;
  const config: MockDataGenerationConfig = {
    submissionCount,
    targetGrades,
    targetClasses,
    targetFormTypes,
    errorSubmissionCount: Math.trunc(numberValue(values.get(MOCK_DATA_SETTING_KEYS.errorSubmissionCount))),
    warningSubmissionCount: Math.trunc(numberValue(values.get(MOCK_DATA_SETTING_KEYS.warningSubmissionCount))),
  };
  if (config.submissionCount < 1) throw new Error('選択した学年・組に疑似生徒がいません。対象範囲を確認してください。');
  if (config.errorSubmissionCount < 0 || config.warningSubmissionCount < 0) {
    throw new Error('エラー数と警告数は0以上で入力してください。');
  }
  if (config.errorSubmissionCount + config.warningSubmissionCount > config.submissionCount) {
    throw new Error(`エラー数と警告数の合計を、選択範囲の${config.submissionCount}人以下にしてください。黄色の2行の数字を小さくします。`);
  }
  return config;
}

export function replaceRegistrations(registrations: Registration[]): void {
  replaceRows(SHEETS.registrations, REGISTRATION_HEADERS, registrations.map((registration) => [
    registration.registrationId, registration.sourceSubmissionId, registration.eventId,
    registration.eventName, registration.slotId, registration.slotName, registration.studentId,
    registration.studentNameSnapshot, registration.grade, registration.classNumber,
    registration.version, registration.updatedAt, registration.updatedBy,
  ]));
}

export function readRegistrations(): Registration[] {
  return readRows(SHEETS.registrations, REGISTRATION_HEADERS).map((row) => ({
    registrationId: text(row[0]), sourceSubmissionId: text(row[1]), eventId: text(row[2]),
    eventName: text(row[3]), slotId: text(row[4]), slotName: text(row[5]),
    studentId: text(row[6]), studentNameSnapshot: text(row[7]), grade: numberValue(row[8]),
    classNumber: numberValue(row[9]), version: text(row[10]),
    updatedAt: row[11] instanceof Date ? row[11].toISOString() : text(row[11]),
    updatedBy: text(row[12]),
  }));
}

export interface RosterHistoryRecord {
  rosterVersionId: string;
  inputName: string;
  versionName: string;
  folderId: string;
  folderUrl: string;
  registrationCount: number;
  sourceSubmissionCount: number;
  createdBy: string;
  createdAt: string;
}

export function appendRosterHistory(record: RosterHistoryRecord): number {
  const sheet = requireSheet(SHEETS.rosterHistory);
  const row = sheet.getLastRow() + 1;
  sheet.getRange(row, 1, 1, ROSTER_HISTORY_HEADERS.length).setValues([[
    record.rosterVersionId, record.inputName, record.versionName, record.folderId,
    record.folderUrl, record.registrationCount, record.sourceSubmissionCount,
    record.createdBy, record.createdAt,
  ]]);
  return row;
}

export function rosterHistoryHasVersion(versionName: string): boolean {
  const sheet = requireSheet(SHEETS.rosterHistory);
  if (sheet.getLastRow() < 2) return false;
  return sheet.getRange(2, 3, sheet.getLastRow() - 1, 1).getDisplayValues()
    .some((row) => row[0] === versionName);
}

export function removeFailedRosterHistoryRow(row: number): void {
  const sheet = requireSheet(SHEETS.rosterHistory);
  if (row >= 2 && row <= sheet.getLastRow()) sheet.deleteRow(row);
}

export function appendSubmissionWithItems(submission: Submission, items: SubmissionItem[]): void {
  const submissionSheet = requireSheet(SHEETS.submissions);
  submissionSheet.getRange(submissionSheet.getLastRow() + 1, 1, 1, SUBMISSION_HEADERS.length)
    .setValues([submissionToRow(submission)]);
  if (items.length === 0) return;
  const itemSheet = requireSheet(SHEETS.items);
  itemSheet.getRange(itemSheet.getLastRow() + 1, 1, items.length, ITEM_HEADERS.length).setValues(items.map((item) => [
    item.submissionItemId, item.submissionId, submission.submitterStudentId, submission.submitterNameInput,
    item.eventId, item.eventName, item.slotId, item.slotName, item.studentIdInput,
    item.studentNameInput, item.normalizedStudentId, item.normalizedName, item.registrationState, item.required,
  ]));
}

export function removeSubmissionWithItems(submissionId: string): void {
  removeRowsByValue(requireSheet(SHEETS.items), 2, submissionId);
  removeRowsByValue(requireSheet(SHEETS.submissions), 1, submissionId);
}

function removeRowsByValue(sheet: Sheet, column: number, value: string): void {
  if (sheet.getLastRow() < 2) return;
  const values = sheet.getRange(2, column, sheet.getLastRow() - 1, 1).getDisplayValues();
  for (let index = values.length - 1; index >= 0; index -= 1) {
    if (values[index]?.[0] === value) sheet.deleteRow(index + 2);
  }
}

function removeRowsWhere(sheet: Sheet, column: number, predicate: (value: string) => boolean): void {
  if (sheet.getLastRow() < 2) return;
  const values = sheet.getRange(2, column, sheet.getLastRow() - 1, 1).getDisplayValues();
  for (let index = values.length - 1; index >= 0; index -= 1) {
    if (predicate(values[index]?.[0] ?? '')) sheet.deleteRow(index + 2);
  }
}

export function deleteDevelopmentMockRows(): void {
  replaceStudents([]);
  deleteDevelopmentMockSubmissionRows();
}

/** 実フォーム確認用。照合に必要な疑似生徒マスターを残し、自動生成した回答・申請だけを消す。 */
export function deleteDevelopmentMockSubmissionRows(): void {
  removeRowsWhere(requireSheet(SHEETS.rawFormResponses), 2, isDevelopmentMockResponseId);
  removeRowsWhere(requireSheet(SHEETS.items), 2, isDevelopmentMockSubmissionId);
  removeRowsWhere(requireSheet(SHEETS.issues), 2, isDevelopmentMockSubmissionId);
  removeRowsWhere(requireSheet(SHEETS.approvals), 2, isDevelopmentMockSubmissionId);
  removeRowsWhere(requireSheet(SHEETS.changeHistory), 2, isDevelopmentMockSubmissionId);
  removeRowsWhere(requireSheet(SHEETS.submissions), 1, isDevelopmentMockSubmissionId);
}

export interface RawFormResponseRecord {
  formId: string;
  responseId: string;
  formType: string;
  submittedAt: string;
  answerJson: string;
  processingStatus: 'RECEIVED' | 'PROCESSED' | 'ERROR';
  submissionId: string;
  processedAt: string;
  errorCode: string;
}

export function ensureRawFormResponseSheet(): void {
  ensureSheet(SHEETS.rawFormResponses, RAW_FORM_RESPONSE_HEADERS);
}

export function findRawFormResponse(formId: string, responseId: string): { row: number; record: RawFormResponseRecord } | undefined {
  ensureRawFormResponseSheet();
  const sheet = requireSheet(SHEETS.rawFormResponses);
  if (sheet.getLastRow() < 2) return undefined;
  const values = sheet.getRange(2, 1, sheet.getLastRow() - 1, RAW_FORM_RESPONSE_HEADERS.length).getDisplayValues();
  const index = values.findIndex((row) => row[0] === formId && row[1] === responseId);
  if (index < 0) return undefined;
  const row = values[index]!;
  return { row: index + 2, record: rawResponseFromRow(row) };
}

export function findRawFormResponseBySubmissionId(submissionId: string): RawFormResponseRecord | undefined {
  ensureRawFormResponseSheet();
  const sheet = requireSheet(SHEETS.rawFormResponses);
  if (sheet.getLastRow() < 2) return undefined;
  const values = sheet.getRange(2, 1, sheet.getLastRow() - 1, RAW_FORM_RESPONSE_HEADERS.length).getDisplayValues();
  const row = values.find((value) => value[6] === submissionId);
  return row ? rawResponseFromRow(row) : undefined;
}

export function appendRawFormResponse(record: RawFormResponseRecord): number {
  ensureRawFormResponseSheet();
  const sheet = requireSheet(SHEETS.rawFormResponses);
  const row = sheet.getLastRow() + 1;
  sheet.getRange(row, 1, 1, RAW_FORM_RESPONSE_HEADERS.length).setValues([rawResponseToRow(record)]);
  return row;
}

export function updateRawFormResponse(row: number, record: RawFormResponseRecord): void {
  requireSheet(SHEETS.rawFormResponses).getRange(row, 1, 1, RAW_FORM_RESPONSE_HEADERS.length)
    .setValues([rawResponseToRow(record)]);
}

export function replaceRawFormResponses(records: RawFormResponseRecord[]): void {
  replaceRows(SHEETS.rawFormResponses, RAW_FORM_RESPONSE_HEADERS, records.map(rawResponseToRow));
}

export function readRawFormResponses(): RawFormResponseRecord[] {
  return readRows(SHEETS.rawFormResponses, RAW_FORM_RESPONSE_HEADERS)
    .map((row) => rawResponseFromRow(row.map((value) => text(value))));
}

function rawResponseToRow(record: RawFormResponseRecord): SheetValue[] {
  return [record.formId, record.responseId, record.formType, record.submittedAt, record.answerJson,
    record.processingStatus, record.submissionId, record.processedAt, record.errorCode];
}

function rawResponseFromRow(row: string[]): RawFormResponseRecord {
  return {
    formId: row[0] ?? '', responseId: row[1] ?? '', formType: row[2] ?? '', submittedAt: row[3] ?? '',
    answerJson: row[4] ?? '', processingStatus: (row[5] ?? 'RECEIVED') as RawFormResponseRecord['processingStatus'],
    submissionId: row[6] ?? '', processedAt: row[7] ?? '', errorCode: row[8] ?? '',
  };
}

function replaceRows(sheetName: string, headers: Header, rows: SheetValue[][]): void {
  const sheet = requireSheet(sheetName);
  const previousRows = dataRowCount(sheet);
  if (previousRows > 0) {
    sheet.getRange(2, 1, previousRows, Math.max(headers.length, sheet.getLastColumn())).clearContent();
  }
  sheet.getRange(1, 1, 1, headers.length).setValues([[...headers]]);
  if (rows.length > 0) {
    sheet.getRange(2, 1, rows.length, headers.length).setValues(rows);
  }
}

function readRows(sheetName: string, headers: Header): SheetValue[][] {
  const sheet = requireSheet(sheetName);
  const count = dataRowCount(sheet);
  if (count === 0) return [];
  return sheet.getRange(2, 1, count, headers.length).getValues() as SheetValue[][];
}

const text = (value: SheetValue | undefined): string => value == null ? '' : String(value);
const numberValue = (value: SheetValue | undefined): number => Number(value ?? 0);
const booleanValue = (value: SheetValue | undefined): boolean =>
  value === true || String(value).toLowerCase() === 'true';

export function replaceStudents(students: Student[]): void {
  replaceRows(SHEETS.students, STUDENT_HEADERS, students.map((student) => [
    student.studentId, student.grade, student.classNumber, student.attendanceNumber, student.name,
    student.gender ?? 'U',
  ]));
}

export function readStudents(): Student[] {
  const productionRows = readProductionStudentInputRows();
  if (productionRows.length > 0) return buildProductionStudents(productionRows);
  return readRows(SHEETS.students, STUDENT_HEADERS).map((row) => ({
    studentId: text(row[0]),
    grade: numberValue(row[1]),
    classNumber: numberValue(row[2]),
    attendanceNumber: numberValue(row[3]),
    name: text(row[4]),
    gender: (['M', 'F'].includes(text(row[5]).toUpperCase()) ? text(row[5]).toUpperCase() : 'U') as NonNullable<Student['gender']>,
  }));
}

export function readMockStudents(): Student[] {
  return readRows(SHEETS.students, STUDENT_HEADERS).map((row) => ({
    studentId: text(row[0]),
    grade: numberValue(row[1]),
    classNumber: numberValue(row[2]),
    attendanceNumber: numberValue(row[3]),
    name: text(row[4]),
    gender: (['M', 'F'].includes(text(row[5]).toUpperCase()) ? text(row[5]).toUpperCase() : 'U') as NonNullable<Student['gender']>,
  })).filter((student) => student.studentId !== '');
}

export function nextDevelopmentMockResponseSequence(): number {
  const rows = readRows(SHEETS.rawFormResponses, RAW_FORM_RESPONSE_HEADERS);
  const maximum = rows.reduce((current, row) => {
    const match = /^mock-response-([0-9]+)$/.exec(text(row[1]));
    return match ? Math.max(current, Number(match[1])) : current;
  }, 0);
  return maximum + 1;
}

function readProductionStudentInputRows(): ProductionStudentInputRow[] {
  const sheet = spreadsheet().getSheetByName(SHEETS.productionStudents);
  if (!sheet || sheet.getLastRow() < 2) return [];
  return sheet.getRange(2, 1, sheet.getLastRow() - 1, 6).getDisplayValues()
    .map((row, index) => ({
      rowNumber: index + 2,
      studentId: row[0] ?? '',
      name: (row[1] ?? '').trim(),
      gender: row[5] ?? '',
    }))
    .filter((row) => row.studentId !== '' || row.name !== '');
}

export function isProductionStudentMasterActive(): boolean {
  return readProductionStudentInputRows().length > 0;
}

export function replaceSubmissions(submissions: Submission[]): void {
  replaceRows(SHEETS.submissions, SUBMISSION_HEADERS, submissions.map(submissionToRow));
}

export function readSubmissions(): Submission[] {
  return readRows(SHEETS.submissions, SUBMISSION_HEADERS).map(rowToSubmission);
}

export function findSubmission(submissionId: string): Submission | undefined {
  return readSubmissions().find((submission) => submission.submissionId === submissionId);
}

export function updateSubmission(submission: Submission): void {
  const sheet = requireSheet(SHEETS.submissions);
  const rows = readRows(SHEETS.submissions, SUBMISSION_HEADERS);
  const index = rows.findIndex((row) => text(row[0]) === submission.submissionId);
  if (index < 0) {
    throw new Error('指定された申請が見つかりません。一覧を開き直してください。');
  }
  sheet.getRange(index + 2, 1, 1, SUBMISSION_HEADERS.length).setValues([submissionToRow(submission)]);
}

function submissionToRow(value: Submission): SheetValue[] {
  return [
    value.submissionId, value.submissionType, value.submittedAt, value.submitterStudentId,
    value.submitterNameInput, value.submitterEmail, value.targetGrade, value.targetClass,
    value.isProxy, value.receptionOpen, value.status, value.warningCount, value.errorCount
  ];
}

function rowToSubmission(row: SheetValue[]): Submission {
  return {
    submissionId: text(row[0]),
    submissionType: text(row[1]) as Submission['submissionType'],
    submittedAt: row[2] instanceof Date ? row[2].toISOString() : text(row[2]),
    submitterStudentId: text(row[3]),
    submitterNameInput: text(row[4]),
    submitterEmail: text(row[5]),
    targetGrade: numberValue(row[6]),
    targetClass: numberValue(row[7]),
    isProxy: booleanValue(row[8]),
    receptionOpen: booleanValue(row[9]),
    status: text(row[10]) as SubmissionStatus,
    warningCount: numberValue(row[11]),
    errorCount: numberValue(row[12])
  };
}

export function replaceItems(items: SubmissionItem[]): void {
  const submissionsById = new Map(
    readSubmissions().map((submission) => [submission.submissionId, submission])
  );
  replaceRows(SHEETS.items, ITEM_HEADERS, items.map((item) => [
    item.submissionItemId,
    item.submissionId,
    submissionsById.get(item.submissionId)?.submitterStudentId ?? '',
    submissionsById.get(item.submissionId)?.submitterNameInput ?? '',
    item.eventId,
    item.eventName,
    item.slotId,
    item.slotName,
    item.studentIdInput,
    item.studentNameInput,
    item.normalizedStudentId,
    item.normalizedName,
    item.registrationState,
    item.required
  ]));
}

export function readItems(): SubmissionItem[] {
  const sheet = requireSheet(SHEETS.items);
  const count = dataRowCount(sheet);
  if (count === 0) return [];
  const columnCount = sheet.getLastColumn();
  const headers = sheet.getRange(1, 1, 1, columnCount).getDisplayValues()[0] ?? [];
  const columnByName = new Map(headers.map((header, index) => [header, index]));
  const rows = sheet.getRange(2, 1, count, columnCount).getValues() as SheetValue[][];
  const value = (row: SheetValue[], header: string): SheetValue | undefined => {
    const index = columnByName.get(header);
    return index == null ? undefined : row[index];
  };
  return rows.map((row) => ({
    submissionItemId: text(value(row, 'submission_item_id')),
    submissionId: text(value(row, 'submission_id')),
    eventId: text(value(row, 'event_id')),
    eventName: text(value(row, 'event_name')),
    slotId: text(value(row, 'slot_id')),
    slotName: text(value(row, 'slot_name')),
    studentIdInput: text(value(row, 'student_id_input')),
    studentNameInput: text(value(row, 'student_name_input')),
    normalizedStudentId: text(value(row, 'normalized_student_id')),
    normalizedName: text(value(row, 'normalized_name')),
    registrationState: text(value(row, 'registration_state')) as SubmissionItem['registrationState'],
    required: booleanValue(value(row, 'required'))
  }));
}

export function updateValidatedItems(items: SubmissionItem[]): void {
  if (items.length === 0) return;
  const sheet = requireSheet(SHEETS.items);
  if (sheet.getLastRow() < 2) return;
  const rowByItemId = new Map(
    sheet.getRange(2, 1, sheet.getLastRow() - 1, 1).getDisplayValues()
      .map((row, index) => [row[0] ?? '', index + 2] as const),
  );
  const normalizedStudentIdColumn = ITEM_HEADERS.indexOf('normalized_student_id') + 1;
  const located = items.flatMap((item) => {
    const row = rowByItemId.get(item.submissionItemId);
    return row ? [{ row, item }] : [];
  }).sort((left, right) => left.row - right.row);
  let start = 0;
  while (start < located.length) {
    let end = start + 1;
    while (end < located.length && located[end]!.row === located[end - 1]!.row + 1) end += 1;
    const group = located.slice(start, end);
    sheet.getRange(group[0]!.row, normalizedStudentIdColumn, group.length, 2)
      .setValues(group.map(({ item }) => [item.normalizedStudentId, item.normalizedName]));
    start = end;
  }
}

export function findItem(itemId: string): SubmissionItem | undefined {
  return readItems().find((item) => item.submissionItemId === itemId);
}

export function updateItemInput(
  itemId: string,
  studentIdInput: string,
  registrationState: SubmissionItem['registrationState']
): SubmissionItem {
  const sheet = requireSheet(SHEETS.items);
  if (sheet.getLastRow() < 2) {
    throw new Error('修正する申請項目が見つかりません。詳細を開き直してください。');
  }
  const row = sheet.getRange(2, 1, sheet.getLastRow() - 1, 1)
    .createTextFinder(itemId)
    .matchEntireCell(true)
    .findNext();
  if (!row) throw new Error('修正する申請項目が見つかりません。詳細を開き直してください。');
  const studentIdColumn = ITEM_HEADERS.indexOf('student_id_input') + 1;
  const stateColumn = ITEM_HEADERS.indexOf('registration_state') + 1;
  const normalizedStudentId = normalizeStudentId(studentIdInput);
  const studentName = readStudents()
    .find((student) => student.studentId === normalizedStudentId)?.name ?? '';
  sheet.getRange(row.getRow(), studentIdColumn, 1, 2)
    .setValues([[studentIdInput, studentName]]);
  sheet.getRange(row.getRow(), stateColumn).setValue(registrationState);
  const updated = findItem(itemId);
  if (!updated) throw new Error('修正後の申請項目を読み取れませんでした。再検査してください。');
  return updated;
}

export function replaceIssues(issues: ValidationIssue[]): void {
  replaceRows(SHEETS.issues, ISSUE_HEADERS, issues.map((issue) => [
    issue.issueId, issue.submissionId, issue.submissionItemId, issue.severity, issue.issueCode,
    issue.displayTitle, issue.locationText, issue.currentValue, issue.fixInstruction, issue.status
  ]));
}

export function replaceIssuesForSubmissions(
  submissionIds: string[],
  issues: ValidationIssue[],
): void {
  const targets = new Set(submissionIds);
  const sheet = requireSheet(SHEETS.issues);
  if (sheet.getLastRow() >= 2) {
    const values = sheet.getRange(2, 2, sheet.getLastRow() - 1, 1).getDisplayValues();
    for (let index = values.length - 1; index >= 0; index -= 1) {
      if (targets.has(values[index]?.[0] ?? '')) sheet.deleteRow(index + 2);
    }
  }
  if (issues.length === 0) return;
  sheet.getRange(sheet.getLastRow() + 1, 1, issues.length, ISSUE_HEADERS.length)
    .setValues(issues.map((issue) => [
      issue.issueId, issue.submissionId, issue.submissionItemId, issue.severity, issue.issueCode,
      issue.displayTitle, issue.locationText, issue.currentValue, issue.fixInstruction, issue.status,
    ]));
}

export function readIssues(): ValidationIssue[] {
  return readRows(SHEETS.issues, ISSUE_HEADERS).map((row) => ({
    issueId: text(row[0]), submissionId: text(row[1]), submissionItemId: text(row[2]),
    severity: text(row[3]) as ValidationIssue['severity'], issueCode: text(row[4]),
    displayTitle: text(row[5]), locationText: text(row[6]), currentValue: text(row[7]),
    fixInstruction: text(row[8]), status: text(row[9]) as ValidationIssue['status']
  }));
}

export interface ApprovalRecord {
  approvalId: string;
  submissionId: string;
  action: string;
  actorEmail: string;
  reason: string;
  actedAt: string;
}

export function appendApproval(record: ApprovalRecord): number {
  const sheet = requireSheet(SHEETS.approvals);
  const row = sheet.getLastRow() + 1;
  sheet.getRange(row, 1, 1, APPROVAL_HEADERS.length).setValues([[
    record.approvalId, record.submissionId, record.action, record.actorEmail, record.reason, record.actedAt
  ]]);
  return row;
}

export function readApprovalHistory(submissionId: string): ApprovalRecord[] {
  return readRows(SHEETS.approvals, APPROVAL_HEADERS)
    .filter((row) => text(row[1]) === submissionId)
    .map((row) => ({
      approvalId: text(row[0]), submissionId: text(row[1]), action: text(row[2]),
      actorEmail: text(row[3]), reason: text(row[4]),
      actedAt: row[5] instanceof Date ? row[5].toISOString() : text(row[5]),
    }));
}

export function resetApprovalHistory(): void {
  replaceRows(SHEETS.approvals, APPROVAL_HEADERS, []);
}

export function removeFailedApprovalRow(row: number): void {
  const sheet = requireSheet(SHEETS.approvals);
  if (row >= 2 && row <= sheet.getLastRow()) sheet.deleteRow(row);
}

export interface ChangeHistoryRecord {
  changeId: string;
  submissionId: string;
  submissionItemId: string;
  beforeStudentId: string;
  afterStudentId: string;
  beforeStudentName: string;
  afterStudentName: string;
  beforeRegistrationState: string;
  afterRegistrationState: string;
  reason: string;
  actorEmail: string;
  changedAt: string;
}

export function appendChangeHistory(record: ChangeHistoryRecord): number {
  const sheet = requireSheet(SHEETS.changeHistory);
  const row = sheet.getLastRow() + 1;
  sheet.getRange(row, 1, 1, CHANGE_HEADERS.length).setValues([[
    record.changeId, record.submissionId, record.submissionItemId,
    record.beforeStudentId, record.afterStudentId, record.beforeStudentName,
    record.afterStudentName, record.beforeRegistrationState,
    record.afterRegistrationState, record.reason, record.actorEmail, record.changedAt
  ]]);
  return row;
}
