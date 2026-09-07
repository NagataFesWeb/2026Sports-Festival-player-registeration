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
import {
  MOCK_ROSTER_SOURCE_CHOICES,
  MOCK_ROSTER_SOURCE_LABELS,
  detectRosterSourceConflict,
  firstRosterToRead,
  parseMockRosterSource,
  rosterFallbackAllowed,
  rosterSourceConflictMessage,
  type MockRosterSource,
} from '../core/mock-roster-source';
import { getSystemMode } from './mode-probe';
import { cachedSheetRows, invalidateSheetCache } from './sheet-cache';

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

/** このモジュール内で使う。読み取りメモへは触れない。 */
function sheetNamed(name: string): Sheet {
  const sheet = spreadsheet().getSheetByName(name);
  if (!sheet) {
    throw new Error(`「${name}」シートがありません。最初に初期設定を実行してください。`);
  }
  return sheet;
}

/**
 * ほかのモジュールへSheetを渡す入口。渡した先で何を書くか分からないので、
 * そのシートの読み取りメモを先に捨てる。モジュール内では`sheetNamed`を使う。
 */
export function requireSheet(name: string): Sheet {
  invalidateSheetCache(name);
  return sheetNamed(name);
}

function ensureSheet(name: string, headers?: Header): Sheet {
  const book = spreadsheet();
  const sheet = book.getSheetByName(name) ?? book.insertSheet(name);
  if (headers && headers.length > 0) {
    sheet.getRange(1, 1, 1, headers.length).setValues([[...headers]]);
    sheet.setFrozenRows(1);
  }
  invalidateSheetCache(name);
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
  invalidateSheetCache(SHEETS.productionStudents);
  return sheet;
}

export function openProductionStudentSheet(): void {
  const sheet = ensureProductionStudentSheet();
  spreadsheet().setActiveSheet(sheet);
  sheet.activate();
}

/** `疑似データ設定`シートの1行分。`band`は背景色と入力規則をまとめて当てるための区分。 */
interface MockDataSettingRow {
  key: string;
  value: SheetValue;
  note: string;
  band: 'grade' | 'class' | 'formType' | 'count' | 'roster' | 'stamp';
}

const MOCK_DATA_BAND_BACKGROUNDS: Record<MockDataSettingRow['band'], string> = {
  grade: '#dcfce7', class: '#e0f2fe', formType: '#ede9fe',
  count: '#fef3c7', roster: '#fce7f3', stamp: '#eceff1',
};

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
  // 旧版のブックには名簿行が無い。そのときだけ、それまでの挙動（生徒マスターに入力があれば
  // そちらを優先）と同じ結果になる初期値を書き込む。以後はこの行の値が正になる。
  const rosterSource: MockRosterSource = oldValues.has(MOCK_DATA_SETTING_KEYS.rosterSource)
    ? parseMockRosterSource(text(oldValues.get(MOCK_DATA_SETTING_KEYS.rosterSource)))
    : (isProductionStudentMasterActive() ? 'PRODUCTION_STUDENTS' : 'MOCK_STUDENTS');
  const rosterStamp = text(oldValues.get(MOCK_DATA_SETTING_KEYS.rosterSourceStamp));

  const settingRows: MockDataSettingRow[] = [
    ...[1, 2, 3].map((grade): MockDataSettingRow => ({
      key: `${MOCK_DATA_SETTING_KEYS.targetGradePrefix}${grade}年`,
      value: targetGrades.includes(grade), band: 'grade',
      note: `チェックすると${grade}年を作成対象にします。`,
    })),
    ...[1, 2, 3, 4, 5, 6, 7, 8].map((classNumber): MockDataSettingRow => ({
      key: `${MOCK_DATA_SETTING_KEYS.targetClassPrefix}${classNumber}組`,
      value: targetClasses.includes(classNumber), band: 'class',
      note: `チェックすると、選んだ学年の${classNumber}組を作成対象にします。`,
    })),
    {
      key: MOCK_DATA_SETTING_KEYS.normalFormEnabled, value: normalFormEnabled, band: 'formType',
      note: 'チェックすると、選んだ各クラスにつき通常フォームの疑似回答を1件だけ作ります。',
    },
    {
      key: MOCK_DATA_SETTING_KEYS.correctionFormEnabled, value: correctionFormEnabled, band: 'formType',
      note: 'チェックすると、通常回答の後に、競技全体を直す修正フォームの疑似回答を追加します。',
    },
    {
      key: MOCK_DATA_SETTING_KEYS.errorSubmissionCount, value: errorCount, band: 'count',
      note: 'この件数の申請に、存在しない番号または別クラスの番号を入れます。',
    },
    {
      key: MOCK_DATA_SETTING_KEYS.warningSubmissionCount, value: warningCount, band: 'count',
      note: 'この件数の申請に、代理入力・受付停止のいずれかを入れます。',
    },
    {
      key: MOCK_DATA_SETTING_KEYS.rosterSource, value: MOCK_ROSTER_SOURCE_LABELS[rosterSource], band: 'roster',
      note: '疑似申請の選手をどちらの名簿から選ぶかを決めます。'
        + `「${MOCK_ROSTER_SOURCE_LABELS.MOCK_STUDENTS}」は実在しない生徒だけを使います。`
        + `「${MOCK_ROSTER_SOURCE_LABELS.PRODUCTION_STUDENTS}」は実在の生徒を使うので、実際のクラス人数のまま試せます。`,
    },
    {
      key: MOCK_DATA_SETTING_KEYS.rosterSourceStamp, value: rosterStamp, band: 'stamp',
      note: '疑似データを作ったときの名簿を自動で記録します。この行は編集しないでください。',
    },
  ];

  const rowNumberOf = (key: string): number =>
    settingRows.findIndex((row) => row.key === key) + 2;
  const bandRange = (band: MockDataSettingRow['band']): { start: number; count: number } => {
    const first = settingRows.findIndex((row) => row.band === band);
    return { start: first + 2, count: settingRows.filter((row) => row.band === band).length };
  };

  const oldDataRows = Math.max(0, sheet.getLastRow() - 1);
  // ここから先はシートを書き換える。途中で失敗しても古い内容のメモを使わないよう、先に捨てる。
  invalidateSheetCache(SHEETS.mockDataSettings);
  // 入力規則だけが値のない行にも残るため、B列の全データ行を先に解除する。
  // flushしないと、同一実行内のsetValuesが旧規則で判定される場合がある。
  const validationRows = Math.max(1, sheet.getMaxRows() - 1);
  sheet.getRange(2, 2, validationRows, 1).clearDataValidations();
  SpreadsheetApp.flush();
  if (oldDataRows > 0) {
    sheet.getRange(2, 1, oldDataRows, MOCK_DATA_SETTING_HEADERS.length).clearContent();
  }
  sheet.getRange(2, 1, settingRows.length, MOCK_DATA_SETTING_HEADERS.length)
    .setValues(settingRows.map((row) => [row.key, row.value, row.note]));

  const checkboxBands = (['grade', 'class', 'formType'] as const).map(bandRange);
  const checkboxStart = Math.min(...checkboxBands.map((band) => band.start));
  const checkboxCount = checkboxBands.reduce((total, band) => total + band.count, 0);
  sheet.getRange(checkboxStart, 2, checkboxCount, 1).setDataValidation(
    SpreadsheetApp.newDataValidation().requireCheckbox().setAllowInvalid(false).build(),
  );
  const countBand = bandRange('count');
  sheet.getRange(countBand.start, 2, countBand.count, 1).setDataValidation(
    SpreadsheetApp.newDataValidation().requireNumberBetween(0, 5000).setAllowInvalid(false).build(),
  ).setNumberFormat('0');
  sheet.getRange(rowNumberOf(MOCK_DATA_SETTING_KEYS.rosterSource), 2, 1, 1).setDataValidation(
    SpreadsheetApp.newDataValidation()
      .requireValueInList([...MOCK_ROSTER_SOURCE_CHOICES], true).setAllowInvalid(false).build(),
  );

  sheet.setColumnWidth(1, 210);
  sheet.setColumnWidth(2, 160);
  sheet.setColumnWidth(3, 560);
  sheet.getRange(1, 1, 1, MOCK_DATA_SETTING_HEADERS.length).setFontWeight('bold').setBackground('#dbeafe');
  (Object.keys(MOCK_DATA_BAND_BACKGROUNDS) as MockDataSettingRow['band'][]).forEach((band) => {
    const range = bandRange(band);
    if (range.count === 0) return;
    sheet.getRange(range.start, 1, range.count, MOCK_DATA_SETTING_HEADERS.length)
      .setBackground(MOCK_DATA_BAND_BACKGROUNDS[band]);
  });
  sheet.getRange(checkboxStart, 2, checkboxCount, 1).setHorizontalAlignment('center');
  sheet.getRange(countBand.start, 2, 1, 1)
    .setNote('実際に作成する申請数を超えた場合は、自動的に申請数以下へ調整します。');
  sheet.getRange(rowNumberOf(MOCK_DATA_SETTING_KEYS.rosterSourceStamp), 2, 1, 1)
    .setNote('自動で記録します。編集しないでください。');
  invalidateSheetCache(SHEETS.mockDataSettings);
}

/** `疑似データ設定`シートの1行だけを読む。`ensureMockDataSettings`は呼ばない。 */
function mockDataSettingValue(key: string): string {
  return cachedSheetRows(SHEETS.mockDataSettings, 'display:2', () => {
    const sheet = spreadsheet().getSheetByName(SHEETS.mockDataSettings);
    if (!sheet || sheet.getLastRow() < 2) return [];
    return sheet.getRange(2, 1, sheet.getLastRow() - 1, 2).getDisplayValues();
  }).find((row) => (row[0] ?? '') === key)?.[1] ?? '';
}

function writeMockDataSettingValue(key: string, value: string): void {
  const sheet = spreadsheet().getSheetByName(SHEETS.mockDataSettings);
  if (!sheet || sheet.getLastRow() < 2) return;
  const keys = sheet.getRange(2, 1, sheet.getLastRow() - 1, 1).getDisplayValues();
  const offset = keys.findIndex((row) => (row[0] ?? '') === key);
  if (offset < 0) return;
  sheet.getRange(offset + 2, 2, 1, 1).setValue(value);
  invalidateSheetCache(SHEETS.mockDataSettings);
}

/** 利用者が選んだ名簿。シートも行も無いときは疑似生徒マスター。 */
export function readMockRosterSourceSetting(): MockRosterSource {
  return parseMockRosterSource(mockDataSettingValue(MOCK_DATA_SETTING_KEYS.rosterSource));
}

/** 疑似申請を作ったときの名簿。未記録なら空文字。 */
export function readMockRosterSourceStamp(): MockRosterSource | '' {
  const raw = mockDataSettingValue(MOCK_DATA_SETTING_KEYS.rosterSourceStamp).trim();
  return raw === '' ? '' : parseMockRosterSource(raw);
}

export function writeMockRosterSourceStamp(source: MockRosterSource | ''): void {
  writeMockDataSettingValue(
    MOCK_DATA_SETTING_KEYS.rosterSourceStamp,
    source === '' ? '' : MOCK_ROSTER_SOURCE_LABELS[source],
  );
}

/**
 * 疑似申請が残ったまま名簿の選択が変わっていないかを確かめる。
 *
 * 疑似生徒マスターと生徒マスターは学籍番号の書式が同じなので、選択を変えると既存の疑似申請が
 * 別の生徒へ解決され直す。承認して`登録データ`や帳票へ流れると取り返しがつかないため、
 * 再検査・承認・名簿作成の入口で必ず止める。
 */
export function assertMockRosterSourceConsistent(submissions: Submission[]): void {
  const stamped = readMockRosterSourceStamp();
  if (stamped === '') return;
  const conflict = detectRosterSourceConflict({
    resolved: activeRosterSource(),
    stamped,
    mockSubmissionExists: submissions.some((submission) =>
      isDevelopmentMockSubmissionId(submission.submissionId)),
  });
  if (conflict === 'MOCK_ROSTER_SOURCE_CHANGED') {
    throw new Error(rosterSourceConflictMessage(stamped));
  }
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

/** 旧版の`登録データ`には性別列が無いため、読めない値はUNKNOWN扱いの`U`にそろえる。 */
function normalizeSnapshotGender(value: SheetValue | undefined): NonNullable<Student['gender']> {
  const normalized = text(value).toUpperCase();
  return normalized === 'M' || normalized === 'F' ? normalized : 'U';
}

export function replaceRegistrations(registrations: Registration[]): void {
  replaceRows(SHEETS.registrations, REGISTRATION_HEADERS, registrations.map((registration) => [
    registration.registrationId, registration.sourceSubmissionId, registration.eventId,
    registration.eventName, registration.slotId, registration.slotName, registration.studentId,
    registration.studentNameSnapshot, registration.grade, registration.classNumber,
    registration.version, registration.updatedAt, registration.updatedBy,
    registration.genderSnapshot ?? 'U',
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
    genderSnapshot: normalizeSnapshotGender(row[13]),
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
  const sheet = sheetNamed(SHEETS.rosterHistory);
  const row = sheet.getLastRow() + 1;
  sheet.getRange(row, 1, 1, ROSTER_HISTORY_HEADERS.length).setValues([[
    record.rosterVersionId, record.inputName, record.versionName, record.folderId,
    record.folderUrl, record.registrationCount, record.sourceSubmissionCount,
    record.createdBy, record.createdAt,
  ]]);
  invalidateSheetCache(SHEETS.rosterHistory);
  return row;
}

export function rosterHistoryHasVersion(versionName: string): boolean {
  const sheet = sheetNamed(SHEETS.rosterHistory);
  if (sheet.getLastRow() < 2) return false;
  return sheet.getRange(2, 3, sheet.getLastRow() - 1, 1).getDisplayValues()
    .some((row) => row[0] === versionName);
}

export function removeFailedRosterHistoryRow(row: number): void {
  const sheet = sheetNamed(SHEETS.rosterHistory);
  if (row >= 2 && row <= sheet.getLastRow()) sheet.deleteRow(row);
  invalidateSheetCache(SHEETS.rosterHistory);
}

export function appendSubmissionWithItems(submission: Submission, items: SubmissionItem[]): void {
  const submissionSheet = sheetNamed(SHEETS.submissions);
  submissionSheet.getRange(submissionSheet.getLastRow() + 1, 1, 1, SUBMISSION_HEADERS.length)
    .setValues([submissionToRow(submission)]);
  invalidateSheetCache(SHEETS.submissions);
  if (items.length === 0) return;
  const itemSheet = sheetNamed(SHEETS.items);
  itemSheet.getRange(itemSheet.getLastRow() + 1, 1, items.length, ITEM_HEADERS.length).setValues(items.map((item) => [
    item.submissionItemId, item.submissionId, submission.submitterStudentId, submission.submitterNameInput,
    item.eventId, item.eventName, item.slotId, item.slotName, item.studentIdInput,
    item.studentNameInput, item.normalizedStudentId, item.normalizedName, item.registrationState, item.required,
  ]));
  invalidateSheetCache(SHEETS.items);
}

export function removeSubmissionWithItems(submissionId: string): void {
  removeRowsByValue(SHEETS.items, 2, submissionId);
  removeRowsByValue(SHEETS.submissions, 1, submissionId);
}

function removeRowsByValue(sheetName: string, column: number, value: string): void {
  removeRowsWhere(sheetName, column, (candidate) => candidate === value);
}

function removeRowsWhere(sheetName: string, column: number, predicate: (value: string) => boolean): void {
  const sheet = sheetNamed(sheetName);
  if (sheet.getLastRow() < 2) return;
  const values = sheet.getRange(2, column, sheet.getLastRow() - 1, 1).getDisplayValues();
  try {
    for (let index = values.length - 1; index >= 0; index -= 1) {
      if (predicate(values[index]?.[0] ?? '')) sheet.deleteRow(index + 2);
    }
  } finally {
    // 途中で失敗しても、消した行が残ったメモを使わないようにする。
    invalidateSheetCache(sheetName);
  }
}

export function deleteDevelopmentMockRows(): void {
  replaceStudents([]);
  deleteDevelopmentMockSubmissionRows();
}

/** 実フォーム確認用。照合に必要な疑似生徒マスターを残し、自動生成した回答・申請だけを消す。 */
export function deleteDevelopmentMockSubmissionRows(): void {
  removeRowsWhere(SHEETS.rawFormResponses, 2, isDevelopmentMockResponseId);
  removeRowsWhere(SHEETS.items, 2, isDevelopmentMockSubmissionId);
  removeRowsWhere(SHEETS.issues, 2, isDevelopmentMockSubmissionId);
  removeRowsWhere(SHEETS.approvals, 2, isDevelopmentMockSubmissionId);
  removeRowsWhere(SHEETS.changeHistory, 2, isDevelopmentMockSubmissionId);
  removeRowsWhere(SHEETS.submissions, 1, isDevelopmentMockSubmissionId);
  // 疑似申請が無くなったので、どの名簿で作ったかの記録も消す。残すと次回の食い違い検出が誤作動する。
  writeMockRosterSourceStamp('');
}

/** ヘッダー行を残して、指定シートのデータ行だけを消す。存在しないシートは無視する。 */
export function clearSheetDataRows(sheetName: string): number {
  const sheet = spreadsheet().getSheetByName(sheetName);
  if (!sheet) return 0;
  const rows = dataRowCount(sheet);
  if (rows === 0) return 0;
  sheet.getRange(2, 1, rows, Math.max(1, sheet.getLastColumn())).clearContent();
  invalidateSheetCache(sheetName);
  return rows;
}

export function countSheetDataRows(sheetName: string): number {
  const sheet = spreadsheet().getSheetByName(sheetName);
  return sheet ? dataRowCount(sheet) : 0;
}

/** 名簿作成の一時シートなど、名前で判定できる残骸シートを削除する。 */
export function deleteSheetsWhere(predicate: (name: string) => boolean): number {
  const book = spreadsheet();
  const targets = book.getSheets().filter((sheet) => predicate(sheet.getName()));
  targets.forEach((sheet) => book.deleteSheet(sheet));
  invalidateSheetCache();
  return targets.length;
}

export function readRosterHistory(): RosterHistoryRecord[] {
  return readRows(SHEETS.rosterHistory, ROSTER_HISTORY_HEADERS).map((row) => ({
    rosterVersionId: text(row[0]), inputName: text(row[1]), versionName: text(row[2]),
    folderId: text(row[3]), folderUrl: text(row[4]),
    registrationCount: numberValue(row[5]), sourceSubmissionCount: numberValue(row[6]),
    createdBy: text(row[7]),
    createdAt: row[8] instanceof Date ? row[8].toISOString() : text(row[8]),
  }));
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

/** 回答原本の全行を表示文字列で読む。同じ実行内では1回だけ読む。 */
function rawFormResponseDisplayRows(): string[][] {
  ensureRawFormResponseSheet();
  return cachedSheetRows(SHEETS.rawFormResponses, `display:${RAW_FORM_RESPONSE_HEADERS.length}`, () => {
    const sheet = sheetNamed(SHEETS.rawFormResponses);
    if (sheet.getLastRow() < 2) return [];
    return sheet.getRange(2, 1, sheet.getLastRow() - 1, RAW_FORM_RESPONSE_HEADERS.length).getDisplayValues();
  });
}

export function findRawFormResponse(formId: string, responseId: string): { row: number; record: RawFormResponseRecord } | undefined {
  const values = rawFormResponseDisplayRows();
  const index = values.findIndex((row) => row[0] === formId && row[1] === responseId);
  if (index < 0) return undefined;
  const row = values[index]!;
  return { row: index + 2, record: rawResponseFromRow(row) };
}

export function findRawFormResponseBySubmissionId(submissionId: string): RawFormResponseRecord | undefined {
  const row = rawFormResponseDisplayRows().find((value) => value[6] === submissionId);
  return row ? rawResponseFromRow(row) : undefined;
}

export function appendRawFormResponse(record: RawFormResponseRecord): number {
  ensureRawFormResponseSheet();
  const sheet = sheetNamed(SHEETS.rawFormResponses);
  const row = sheet.getLastRow() + 1;
  sheet.getRange(row, 1, 1, RAW_FORM_RESPONSE_HEADERS.length).setValues([rawResponseToRow(record)]);
  invalidateSheetCache(SHEETS.rawFormResponses);
  return row;
}

export function updateRawFormResponse(row: number, record: RawFormResponseRecord): void {
  sheetNamed(SHEETS.rawFormResponses).getRange(row, 1, 1, RAW_FORM_RESPONSE_HEADERS.length)
    .setValues([rawResponseToRow(record)]);
  invalidateSheetCache(SHEETS.rawFormResponses);
}

/** 実機テストの後片付け用。指定した回答IDの原本行だけを削除する。 */
export function removeRawFormResponses(responseIds: string[]): number {
  const targets = new Set(responseIds.filter((value) => value !== ''));
  if (targets.size === 0) return 0;
  const sheet = sheetNamed(SHEETS.rawFormResponses);
  if (sheet.getLastRow() < 2) return 0;
  const values = sheet.getRange(2, 2, sheet.getLastRow() - 1, 1).getDisplayValues();
  let removed = 0;
  try {
    for (let index = values.length - 1; index >= 0; index -= 1) {
      if (targets.has(values[index]?.[0] ?? '')) {
        sheet.deleteRow(index + 2);
        removed += 1;
      }
    }
  } finally {
    invalidateSheetCache(SHEETS.rawFormResponses);
  }
  return removed;
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
  const sheet = sheetNamed(sheetName);
  // 途中で失敗しても古い内容のメモを使わないよう、書く前にも捨てる。
  invalidateSheetCache(sheetName);
  const previousRows = dataRowCount(sheet);
  if (previousRows > 0) {
    sheet.getRange(2, 1, previousRows, Math.max(headers.length, sheet.getLastColumn())).clearContent();
  }
  sheet.getRange(1, 1, 1, headers.length).setValues([[...headers]]);
  if (rows.length > 0) {
    sheet.getRange(2, 1, rows.length, headers.length).setValues(rows);
  }
  invalidateSheetCache(sheetName);
}

/** データ行を`getValues()`で読む。同じ実行内の2回目以降はメモから返す（毎回コピー）。 */
function readRows(sheetName: string, headers: Header): SheetValue[][] {
  return cachedSheetRows<SheetValue>(sheetName, `values:${headers.length}`, () => {
    const sheet = sheetNamed(sheetName);
    const count = dataRowCount(sheet);
    if (count === 0) return [];
    return sheet.getRange(2, 1, count, headers.length).getValues() as SheetValue[][];
  });
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

/** 本番用の`生徒マスター`だけを読む。名簿の選択を一切見ない。 */
export function readProductionStudents(): Student[] {
  return buildProductionStudents(readProductionStudentInputRows());
}

/**
 * 検査・確認画面・名簿作成が使う唯一の名簿。
 *
 * `疑似データ設定`の`疑似申請に使う名簿`で選んだ側を返す。2つの名簿は学籍番号の書式が
 * 同じなので、混ぜずに必ずどちらか一方だけを返す。
 * 先に1枚読み、空だったときだけもう一方を読む（読み取り回数を最悪2回に抑えるため）。
 */
export function readStudents(): Student[] {
  const mode = getSystemMode();
  const first = firstRosterToRead({ mode, configured: readMockRosterSourceSetting() });
  const readOne = (source: MockRosterSource): Student[] =>
    source === 'PRODUCTION_STUDENTS' ? readProductionStudents() : readMockStudents();
  const primary = readOne(first);
  if (primary.length > 0 || !rosterFallbackAllowed(mode)) return primary;
  return readOne(first === 'MOCK_STUDENTS' ? 'PRODUCTION_STUDENTS' : 'MOCK_STUDENTS');
}

/** いま実際に使われている名簿。表示文言と食い違い検出のために使う。 */
export function activeRosterSource(): MockRosterSource {
  const mode = getSystemMode();
  const first = firstRosterToRead({ mode, configured: readMockRosterSourceSetting() });
  if (!rosterFallbackAllowed(mode)) return first;
  const primaryCount = first === 'PRODUCTION_STUDENTS'
    ? readProductionStudentInputRows().length
    : readMockStudents().length;
  if (primaryCount > 0) return first;
  return first === 'MOCK_STUDENTS' ? 'PRODUCTION_STUDENTS' : 'MOCK_STUDENTS';
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
  return cachedSheetRows(SHEETS.productionStudents, 'display:6', () => {
    const sheet = spreadsheet().getSheetByName(SHEETS.productionStudents);
    if (!sheet || sheet.getLastRow() < 2) return [];
    return sheet.getRange(2, 1, sheet.getLastRow() - 1, 6).getDisplayValues();
  })
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
  const sheet = sheetNamed(SHEETS.submissions);
  const rows = readRows(SHEETS.submissions, SUBMISSION_HEADERS);
  const index = rows.findIndex((row) => text(row[0]) === submission.submissionId);
  if (index < 0) {
    throw new Error('指定された申請が見つかりません。一覧を開き直してください。');
  }
  sheet.getRange(index + 2, 1, 1, SUBMISSION_HEADERS.length).setValues([submissionToRow(submission)]);
  invalidateSheetCache(SHEETS.submissions);
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
  // 先頭行にヘッダー（表示文字列）、以降にデータ行を入れて1つのメモにする。
  const table = cachedSheetRows<SheetValue>(SHEETS.items, 'header+values', () => {
    const sheet = sheetNamed(SHEETS.items);
    const count = dataRowCount(sheet);
    if (count === 0) return [];
    const columnCount = sheet.getLastColumn();
    const headerRow = sheet.getRange(1, 1, 1, columnCount).getDisplayValues()[0] ?? [];
    const dataRows = sheet.getRange(2, 1, count, columnCount).getValues() as SheetValue[][];
    return [headerRow, ...dataRows];
  });
  if (table.length === 0) return [];
  const headers = (table[0] ?? []).map((header) => text(header));
  const columnByName = new Map(headers.map((header, index) => [header, index]));
  const rows = table.slice(1);
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
  const sheet = sheetNamed(SHEETS.items);
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
    invalidateSheetCache(SHEETS.items);
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
  const sheet = sheetNamed(SHEETS.items);
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
  invalidateSheetCache(SHEETS.items);
  sheet.getRange(row.getRow(), stateColumn).setValue(registrationState);
  invalidateSheetCache(SHEETS.items);
  const updated = findItem(itemId);
  if (!updated) throw new Error('修正後の申請項目を読み取れませんでした。再検査してください。');
  return updated;
}

export function replaceIssues(issues: ValidationIssue[]): void {
  replaceRows(SHEETS.issues, ISSUE_HEADERS, issues.map((issue) => [
    issue.issueId, issue.submissionId, issue.submissionItemId, issue.severity, issue.issueCode,
    issue.displayTitle, issue.locationText, issue.currentValue, issue.fixInstruction, issue.status,
    issue.relatedItemIds
  ]));
}

export function replaceIssuesForSubmissions(
  submissionIds: string[],
  issues: ValidationIssue[],
): void {
  const targets = new Set(submissionIds);
  const sheet = sheetNamed(SHEETS.issues);
  if (sheet.getLastRow() >= 2) {
    const values = sheet.getRange(2, 2, sheet.getLastRow() - 1, 1).getDisplayValues();
    try {
      for (let index = values.length - 1; index >= 0; index -= 1) {
        if (targets.has(values[index]?.[0] ?? '')) sheet.deleteRow(index + 2);
      }
    } finally {
      invalidateSheetCache(SHEETS.issues);
    }
  }
  if (issues.length === 0) return;
  sheet.getRange(sheet.getLastRow() + 1, 1, issues.length, ISSUE_HEADERS.length)
    .setValues(issues.map((issue) => [
      issue.issueId, issue.submissionId, issue.submissionItemId, issue.severity, issue.issueCode,
      issue.displayTitle, issue.locationText, issue.currentValue, issue.fixInstruction, issue.status,
      issue.relatedItemIds,
    ]));
  invalidateSheetCache(SHEETS.issues);
}

export function readIssues(): ValidationIssue[] {
  return readRows(SHEETS.issues, ISSUE_HEADERS).map((row) => ({
    issueId: text(row[0]), submissionId: text(row[1]), submissionItemId: text(row[2]),
    severity: text(row[3]) as ValidationIssue['severity'], issueCode: text(row[4]),
    displayTitle: text(row[5]), locationText: text(row[6]), currentValue: text(row[7]),
    fixInstruction: text(row[8]), status: text(row[9]) as ValidationIssue['status'],
    relatedItemIds: text(row[10])
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
  const sheet = sheetNamed(SHEETS.approvals);
  const row = sheet.getLastRow() + 1;
  sheet.getRange(row, 1, 1, APPROVAL_HEADERS.length).setValues([[
    record.approvalId, record.submissionId, record.action, record.actorEmail, record.reason, record.actedAt
  ]]);
  invalidateSheetCache(SHEETS.approvals);
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
  const sheet = sheetNamed(SHEETS.approvals);
  if (row >= 2 && row <= sheet.getLastRow()) sheet.deleteRow(row);
  invalidateSheetCache(SHEETS.approvals);
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

/** 変更履歴の書き込み後に失敗したときへ戻すため、追記した行を消す。 */
export function removeFailedChangeHistoryRow(row: number): void {
  const sheet = sheetNamed(SHEETS.changeHistory);
  if (row >= 2 && row <= sheet.getLastRow()) sheet.deleteRow(row);
  invalidateSheetCache(SHEETS.changeHistory);
}

export function appendChangeHistory(record: ChangeHistoryRecord): number {
  const sheet = sheetNamed(SHEETS.changeHistory);
  const row = sheet.getLastRow() + 1;
  sheet.getRange(row, 1, 1, CHANGE_HEADERS.length).setValues([[
    record.changeId, record.submissionId, record.submissionItemId,
    record.beforeStudentId, record.afterStudentId, record.beforeStudentName,
    record.afterStudentName, record.beforeRegistrationState,
    record.afterRegistrationState, record.reason, record.actorEmail, record.changedAt
  ]]);
  invalidateSheetCache(SHEETS.changeHistory);
  return row;
}
