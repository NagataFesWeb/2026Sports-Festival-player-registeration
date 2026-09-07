import {
  buildAthleteIndex, buildClassDistributionPages, buildConcurrentRosterTables, rosterGenderLabel,
  type RosterGender,
  buildRegistrationSnapshot, buildRosterDistributionPreflight,
  assertRosterJobCanStart, normalizeRosterInputName, planRosterJobStep, ROSTER_REPORT_NAMES,
  selectRosterVersionName,
  buildEventRosterPages, eventRosterPageTitle, type EventRosterPage,
  diffRosterRegistrations, gradeRosterSheetName, planEventRosterSheetNames,
  replaceRosterMetadataVersion, selectAffectedRosterPages, shouldRebuildWholeReport,
  type RosterBaselineRow, type RosterDiff,
} from '../core/roster';
import { validateSubmission } from '../core/validation';
import { REGISTRATION_HEADERS, SCRIPT_PROPERTIES, SHEETS } from '../shared/constants';
import type { EventSetting, Registration, Student } from '../shared/types';
import {
  appendRosterHistory,
  assertMockRosterSourceConsistent,
  ensureApplicationSheets,
  readItems,
  readRosterHistory,
  readStudents,
  readSubmissions,
  replaceRegistrations,
  replaceSubmissions,
  requireSheet,
  rosterHistoryHasVersion,
} from './repository';
import { readEventSettings, readFormDesign, readRuleSettings } from './settings-repository';
import { assertAuthorized } from './auth-service';

const ROSTER_FOLDER_NAME = '選手名簿';
const ROSTER_JOB_PROPERTY = SCRIPT_PROPERTIES.playerRosterJob;
const ROSTER_STATUS_SHEET = '名簿作成状況';
const ROSTER_TRIGGER_HANDLER = 'continuePlayerRosterCreation';
/**
 * 名簿ファイルの構成とページの分け方の版。
 * 途中で中断した名簿作成が、古い体裁のまま再開されるのを防ぐために比べる。
 * 5: 種目別・当日変更用を表示順の100区切りでページ分けするようにした。
 */
const ROSTER_REPORT_PLAN_VERSION = 5;
const REPORTS = ROSTER_REPORT_NAMES;
const PRINT_COLORS = {
  title: '#17324d', titleText: '#ffffff', accent: '#f2c94c', header: '#dbe7f0',
  groupA: '#ffffff', groupB: '#eef4f8', border: '#64748b', muted: '#475569',
  correction: '#fff2cc',
} as const;
type ReportName = typeof REPORTS[number];
type RosterLayout = '種目別' | 'クラス別' | '招集順' | '当日変更用';

export interface CreatedRosterFile {
  name: ReportName;
  url: string;
}

export interface CreateRosterResult {
  inputName: string;
  versionName: string;
  registrationCount: number;
  sourceSubmissionCount: number;
  folderUrl: string;
  files: CreatedRosterFile[];
  processing: boolean;
  message: string;
  /** 差分作成のときだけ入る、複製元の版名。 */
  baseVersionName?: string;
  /** 差分作成のときだけ入る、前回の版から変わった選手枠の数。 */
  changedCount?: number;
}

/** 「変更点だけを反映して選手名簿を作成」を押す前に見せる下調べの結果。 */
export interface RosterDiffPreview {
  canRun: boolean;
  baseVersionName: string;
  nextVersionName: string;
  addedCount: number;
  removedCount: number;
  changedCount: number;
  totalCount: number;
  /** 書き直しが必要な競技名。個人名は含めない。 */
  affectedEventNames: string[];
  message: string;
}

interface RosterJobState {
  reportPlanVersion?: number;
  /**
   * `FULL`は全ファイルを新規に作る。`DIFF`は前回の版のファイルを複製し、
   * 変わったシートだけを書き直す。古い作りかけの状態には無いため、省略時は`FULL`とみなす。
   */
  mode?: 'FULL' | 'DIFF';
  /** `DIFF`のときの複製元。 */
  baseFolderId?: string;
  baseVersionName?: string;
  jobId: string;
  inputName: string;
  versionName: string;
  folderId: string;
  folderUrl: string;
  registrationCount: number;
  sourceSubmissionCount: number;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  nextReportIndex: number;
  stagingSheetName: string;
  sourceSheetName: string;
  files: CreatedRosterFile[];
  status: 'RUNNING' | 'ERROR';
  message: string;
}

export interface RosterJobStatus {
  active: boolean;
  status: 'RUNNING' | 'ERROR' | 'COMPLETE' | 'CANCELLED' | 'NONE';
  versionName: string;
  progress: string;
  folderUrl: string;
  message: string;
  updatedAt: string;
}

function parentFolder(): GoogleAppsScript.Drive.Folder {
  const file = DriveApp.getFileById(SpreadsheetApp.getActiveSpreadsheet().getId());
  const parents = file.getParents();
  return parents.hasNext() ? parents.next() : DriveApp.getRootFolder();
}

function childFolder(parent: GoogleAppsScript.Drive.Folder, name: string): GoogleAppsScript.Drive.Folder {
  const folders = parent.getFoldersByName(name);
  return folders.hasNext() ? folders.next() : parent.createFolder(name);
}

function childFolderNames(parent: GoogleAppsScript.Drive.Folder): string[] {
  const result: string[] = [];
  const folders = parent.getFolders();
  while (folders.hasNext()) result.push(folders.next().getName());
  return result;
}

function numberIn(value: string): number {
  const match = value.match(/\d+/);
  return match ? Number(match[0]) : Number.MAX_SAFE_INTEGER;
}

function compareText(left: string, right: string): number {
  return left.localeCompare(right, 'ja');
}

function sortedRegistrations(
  registrations: Registration[], report: RosterLayout, events: EventSetting[],
): Registration[] {
  const eventById = new Map(events.map((event) => [event.eventId, event]));
  const displayOrder = (row: Registration): number => eventById.get(row.eventId)?.displayOrder ?? Number.MAX_SAFE_INTEGER;
  const assemblyOrder = (row: Registration): number => eventById.get(row.eventId)?.assemblyOrder ?? Number.MAX_SAFE_INTEGER;
  const classOrder = (row: Registration): number => row.grade * 100 + row.classNumber;
  const eventOrder = (left: Registration, right: Registration): number =>
    displayOrder(left) - displayOrder(right) || compareText(left.eventName, right.eventName);
  const slotOrder = (left: Registration, right: Registration): number =>
    numberIn(left.slotName || left.slotId) - numberIn(right.slotName || right.slotId)
      || compareText(left.slotName, right.slotName);

  return [...registrations].sort((left, right) => {
    if (report === 'クラス別' || report === '当日変更用') {
      return classOrder(left) - classOrder(right) || eventOrder(left, right) || slotOrder(left, right);
    }
    if (report === '招集順') {
      return assemblyOrder(left) - assemblyOrder(right) || eventOrder(left, right)
        || classOrder(left) - classOrder(right) || slotOrder(left, right);
    }
    return eventOrder(left, right) || classOrder(left) - classOrder(right) || slotOrder(left, right);
  });
}

function decorateTitle(
  sheet: GoogleAppsScript.Spreadsheet.Sheet,
  title: string,
  instruction: string,
  metadata: string,
  columnCount: number,
): void {
  sheet.setHiddenGridlines(true);
  sheet.getRange(1, 1, 1, columnCount).mergeAcross().setValue(title)
    .setFontSize(18).setFontWeight('bold').setFontColor(PRINT_COLORS.titleText)
    .setBackground(PRINT_COLORS.title).setHorizontalAlignment('left');
  sheet.getRange(2, 1, 1, columnCount).mergeAcross().setValue(instruction)
    .setFontSize(12).setFontWeight('bold').setBackground(PRINT_COLORS.accent)
    .setWrap(true).setHorizontalAlignment('left');
  sheet.getRange(3, 1, 1, columnCount).mergeAcross().setValue(metadata)
    .setFontSize(10).setFontColor(PRINT_COLORS.muted).setHorizontalAlignment('left');
  sheet.setRowHeight(1, 40);
  sheet.setRowHeight(2, 42);
  sheet.setRowHeight(3, 24);
}

function decorateTable(
  sheet: GoogleAppsScript.Spreadsheet.Sheet,
  rowCount: number,
  visibleColumnCount: number,
  groupKeys: string[],
): void {
  const headerRow = 5;
  const dataRow = 6;
  sheet.getRange(headerRow, 1, 1, visibleColumnCount)
    .setFontSize(11).setFontWeight('bold').setBackground(PRINT_COLORS.header)
    .setHorizontalAlignment('center').setVerticalAlignment('middle')
    .setBorder(true, true, true, true, true, true, PRINT_COLORS.border, SpreadsheetApp.BorderStyle.SOLID);
  sheet.setRowHeight(headerRow, 32);
  if (rowCount === 0) return;

  let previous = '';
  let alternate = false;
  const backgrounds = groupKeys.map((key) => {
    if (previous !== '' && previous !== key) alternate = !alternate;
    previous = key;
    return Array.from({ length: visibleColumnCount }, () => alternate ? PRINT_COLORS.groupB : PRINT_COLORS.groupA);
  });
  const range = sheet.getRange(dataRow, 1, rowCount, visibleColumnCount);
  range.setBackgrounds(backgrounds).setFontSize(11).setVerticalAlignment('middle')
    .setBorder(true, true, true, true, true, true, '#cbd5e1', SpreadsheetApp.BorderStyle.SOLID);
}

function writeAthleteIndex(
  sheet: GoogleAppsScript.Spreadsheet.Sheet,
  versionName: string,
  registrations: Registration[],
  createdAt: string,
): void {
  sheet.setName('自分の競技を探す');
  const headers = ['学年', '組', '学籍番号', '選手氏名', '性別', '出場競技・走順'];
  const indexRows = buildAthleteIndex(registrations);
  const rows = indexRows.map((row) => [
    `${row.grade}年`, `${row.classNumber}組`, row.studentId, row.studentName,
    rosterGenderLabel(row.gender), row.eventSummary,
  ]);
  const metadata = `版：${versionName} / 作成：${Utilities.formatDate(new Date(createdAt), 'Asia/Tokyo', 'yyyy/MM/dd HH:mm')} / 選手：${rows.length}人`;
  decorateTitle(
    sheet,
    '自分の出場競技を確認する',
    '自分の学年・組を探し、選手氏名の右にある「出場競技・走順」を確認してください。',
    metadata,
    headers.length,
  );
  sheet.getRange(5, 1, 1, headers.length).setValues([headers]);
  if (rows.length > 0) sheet.getRange(6, 1, rows.length, headers.length).setValues(rows);
  decorateTable(
    sheet, rows.length, headers.length,
    indexRows.map((row) => `${row.grade}:${row.classNumber}`),
  );
  sheet.setFrozenRows(5);
  sheet.setColumnWidth(1, 65);
  sheet.setColumnWidth(2, 65);
  sheet.setColumnWidth(3, 100);
  sheet.setColumnWidth(4, 180);
  sheet.setColumnWidth(5, 70);
  sheet.setColumnWidth(6, 360);
  if (rows.length > 0) {
    sheet.getRange(6, 3, rows.length, 1).setNumberFormat('@').setHorizontalAlignment('center');
    sheet.getRange(6, 4, rows.length, 1).setFontWeight('bold');
    sheet.getRange(6, 5, rows.length, 1).setHorizontalAlignment('center');
    sheet.getRange(6, 6, rows.length, 1).setWrap(true);
    // autoResizeRowsは大規模名簿で非常に遅いため、索引全体を一括設定する。
    sheet.setRowHeights(6, rows.length, 58);
  }
  sheet.getRange(5, 1, Math.max(1, rows.length + 1), headers.length).createFilter();
}

function reportInstruction(report: RosterLayout): string {
  if (report === 'クラス別') return 'クラスごとに、全競技・全走順と登録選手を確認できます。空欄は未登録です。';
  if (report === '招集順') return '招集する順番で競技を並べたチェック表です。各クラスの選手を横方向に確認できます。';
  if (report === '当日変更用') return '種目ごとに現在の選手を確認し、変更内容を同じ表へ記入できます。';
  return '競技ごとに全走順を表示します。横方向に各クラスの選手を確認でき、空欄は未登録です。';
}

function classesForGrade(students: Student[], registrations: Registration[], grade: number): number[] {
  const values = new Set([
    ...students.filter((student) => student.grade === grade).map((student) => student.classNumber),
    ...registrations.filter((registration) => registration.grade === grade)
      .map((registration) => registration.classNumber),
  ]);
  return values.size > 0 ? [...values].sort((left, right) => left - right) : [1, 2, 3, 4, 5, 6, 7, 8];
}

function normalizeStagingGender(value: unknown): RosterGender {
  const normalized = String(value ?? '').trim().toUpperCase();
  return normalized === 'M' || normalized === 'F' ? normalized : 'U';
}

function athleteCell(
  athletes: Array<{ studentId: string; studentName: string; gender?: RosterGender }>,
  report: RosterLayout,
): string {
  if (report === '当日変更用' && athletes.length === 0) {
    return '変更後：____________\n理由：____________';
  }
  return athletes.map((athlete) => {
    // 学籍番号と氏名の並びは修正枠の黄色付けが目印にしているため崩さず、性別だけを添える。
    const base = `${athlete.studentName}\n（${athlete.studentId}・${rosterGenderLabel(athlete.gender)}）`;
    return report === '当日変更用'
      ? `${base}\n変更後：____________\n理由：____________`
      : base;
  }).join('\n────────\n');
}

function tableHeader(
  sheet: GoogleAppsScript.Spreadsheet.Sheet, row: number, headers: string[],
): void {
  sheet.getRange(row, 1, 1, headers.length).setValues([headers])
    .setFontWeight('bold').setBackground(PRINT_COLORS.header)
    .setHorizontalAlignment('center').setVerticalAlignment('middle')
    .setBorder(true, true, true, true, true, true, PRINT_COLORS.border, SpreadsheetApp.BorderStyle.SOLID);
  sheet.setRowHeight(row, 30);
}

function tableBody(
  sheet: GoogleAppsScript.Spreadsheet.Sheet, row: number, values: Array<Array<string | number>>,
): void {
  if (values.length === 0) return;
  sheet.getRange(row, 1, values.length, values[0]!.length).setValues(values)
    .setWrap(true).setVerticalAlignment('middle')
    .setBorder(true, true, true, true, true, true, '#cbd5e1', SpreadsheetApp.BorderStyle.SOLID);
}

function sectionTitle(
  sheet: GoogleAppsScript.Spreadsheet.Sheet, row: number, columnCount: number,
  title: string, alternate: boolean,
): void {
  sheet.getRange(row, 1, 1, columnCount).mergeAcross().setValue(title)
    .setFontSize(13).setFontWeight('bold').setFontColor(PRINT_COLORS.titleText)
    .setBackground(alternate ? '#315b78' : PRINT_COLORS.title).setHorizontalAlignment('left');
  sheet.setRowHeight(row, 30);
}

function writeGradeRosterSheet(
  sheet: GoogleAppsScript.Spreadsheet.Sheet,
  report: RosterLayout,
  grade: number,
  versionName: string,
  registrations: Registration[],
  events: EventSetting[],
  students: Student[],
  createdAt: string,
  sheetName = `${grade}年`,
): void {
  sheet.setName(sheetName);
  const classNumbers = classesForGrade(students, registrations, grade);
  const columnCount = report === 'クラス別' ? 5 : report === '当日変更用' ? 7
    : report === '招集順' ? classNumbers.length + 4 : classNumbers.length + 1;
  const gradeRegistrations = registrations.filter((registration) => registration.grade === grade);
  const tables = buildConcurrentRosterTables(registrations, grade, events);
  decorateTitle(
    sheet,
    `${report}選手名簿 ${grade}年`,
    reportInstruction(report),
    `版：${versionName} / 作成：${Utilities.formatDate(new Date(createdAt), 'Asia/Tokyo', 'yyyy/MM/dd HH:mm')} / 登録：${gradeRegistrations.length}件`,
    columnCount,
  );
  sheet.setFrozenRows(3);

  let row = 5;
  if (report === 'クラス別' || report === '当日変更用') {
    const headers = report === 'クラス別'
      ? ['競技名', '走順・役割', '学籍番号', '選手氏名', '性別']
      : ['競技名', '走順・役割', '現在の選手', '変更後の学籍番号', '変更後の氏名', '変更理由', '確認者'];
    const widths = report === 'クラス別' ? [190, 120, 110, 190, 70] : [175, 115, 210, 125, 170, 180, 110];
    widths.forEach((width, index) => sheet.setColumnWidth(index + 1, width));
    classNumbers.forEach((classNumber, classIndex) => {
      sectionTitle(sheet, row, columnCount, `${grade}年${classNumber}組`, classIndex % 2 === 1);
      row += 1;
      tableHeader(sheet, row, headers);
      row += 1;
      const values: Array<Array<string | number>> = [];
      tables.forEach((table) => table.rows.forEach((slot) => {
        const athletes = slot.athletesByClass[classNumber] ?? [];
        if (report === 'クラス別') {
          if (athletes.length === 0) values.push([table.eventName, slot.slotName, '', '', '']);
          else athletes.forEach((athlete) => values.push([
            table.eventName, slot.slotName, athlete.studentId, athlete.studentName,
            rosterGenderLabel(athlete.gender),
          ]));
        } else {
          values.push([
            table.eventName, slot.slotName, athleteCell(athletes, '種目別'), '', '', '', '',
          ]);
        }
      }));
      tableBody(sheet, row, values);
      if (values.length > 0) {
        sheet.getRange(row, 1, values.length, 2).setBackground(classIndex % 2 ? '#f5f9fc' : PRINT_COLORS.groupA);
        sheet.getRange(row, 3, values.length, report === 'クラス別' ? 2 : 1).setFontWeight('bold');
        sheet.setRowHeights(row, values.length, report === '当日変更用' ? 72 : 44);
      }
      row += values.length + 1;
    });
    return;
  }

  if (report === '招集順') {
    const headers = ['招集順', '競技名', '走順・役割', ...classNumbers.map((value) => `${value}組`), '確認'];
    sheet.setColumnWidth(1, 80);
    sheet.setColumnWidth(2, 190);
    const classStart = 4;
    sheet.setColumnWidth(3, 120);
    classNumbers.forEach((_, index) => sheet.setColumnWidth(classStart + index, 165));
    sheet.setColumnWidth(headers.length, 80);
    tableHeader(sheet, row, headers);
    row += 1;
    const flat = tables.flatMap((table, eventIndex) => table.rows.map((slot) => ({ table, slot, eventIndex })));
    const values = flat.map(({ table, slot, eventIndex }) => [
      events.find((event) => event.eventId === table.eventId)?.assemblyOrder ?? eventIndex + 1,
      table.eventName, slot.slotName,
      ...classNumbers.map((classNumber) => athleteCell(slot.athletesByClass[classNumber] ?? [], report)), '□',
    ]);
    tableBody(sheet, row, values);
    if (values.length > 0) {
      sheet.getRange(row, 1, values.length, 3).setFontWeight('bold');
      sheet.getRange(row, classStart, values.length, classNumbers.length)
        .setFontWeight('bold').setHorizontalAlignment('center');
      sheet.setRowHeights(row, values.length, 64);
    }
    return;
  }

  sheet.setColumnWidth(1, 125);
  classNumbers.forEach((_, index) => sheet.setColumnWidth(index + 2, 175));
  tables.forEach((table, tableIndex) => {
    sectionTitle(sheet, row, columnCount, table.eventName, tableIndex % 2 === 1);
    row += 1;

    const headers = ['走順・役割', ...classNumbers.map((classNumber) => `${classNumber}組`)];
    tableHeader(sheet, row, headers);
    row += 1;

    const values = table.rows.map((slot) => [
      slot.slotName,
      ...classNumbers.map((classNumber) => athleteCell(slot.athletesByClass[classNumber] ?? [], report)),
    ]);
    if (values.length > 0) {
      const range = sheet.getRange(row, 1, values.length, columnCount);
      range.setValues(values).setWrap(true).setVerticalAlignment('middle')
        .setBorder(true, true, true, true, true, true, '#cbd5e1', SpreadsheetApp.BorderStyle.SOLID);
      sheet.getRange(row, 1, values.length, 1).setFontWeight('bold')
        .setBackground(tableIndex % 2 === 0 ? PRINT_COLORS.groupB : '#e5eef4')
        .setHorizontalAlignment('center');
      sheet.getRange(row, 2, values.length, classNumbers.length)
        .setFontWeight('bold').setHorizontalAlignment('center');
      const greatest = Math.max(1, ...table.rows.flatMap((slot) =>
        classNumbers.map((classNumber) => slot.athletesByClass[classNumber]?.length ?? 0)));
      sheet.setRowHeights(row, values.length, Math.max(56, greatest * 58));
      row += values.length;
    }
    row += 1;
  });
}

function gradesForEvent(event: EventSetting): (1 | 2 | 3)[] {
  return ([1, 2, 3] as const).filter((grade) =>
    event.targetGrade === '全学年' || event.targetGrade === `${grade}年`);
}

/**
 * 1ページ分の種目別名簿を書く。
 *
 * 表示順の100区切りが同じ競技は同じページへまとめる（`buildEventRosterPages`）。
 * 学年ごとに競技を分けている場合に、1枚へまとめて印刷できるようにするため。
 */
function writeEventRosterSheet(
  sheet: GoogleAppsScript.Spreadsheet.Sheet,
  page: EventRosterPage,
  versionName: string,
  registrations: Registration[],
  students: Student[],
  createdAt: string,
  report: '種目別' | '当日変更用',
): void {
  const pageGrades = [...new Set(page.events.flatMap(gradesForEvent))].sort((left, right) => left - right);
  const classNumbers = [...new Set(pageGrades.flatMap((grade) =>
    classesForGrade(students, registrations, grade)))].sort((left, right) => left - right);
  const columnCount = Math.max(2, classNumbers.length + 1);
  const eventIds = new Set(page.events.map((event) => event.eventId));
  const pageRegistrations = registrations.filter((registration) => eventIds.has(registration.eventId));
  const multipleEvents = page.events.length > 1;
  const pageTitle = eventRosterPageTitle(page);
  decorateTitle(
    sheet,
    `${pageTitle} ${report}選手名簿`,
    report === '当日変更用'
      ? '種目別名簿と同じ配置です。縦が走順・役割、横がクラスです。変更する選手の欄へ記入してください。'
      : multipleEvents
        ? `表示順が同じ100番台の${page.events.length}競技を1ページにまとめています。縦が走順・役割、横がクラスです。`
        : '同じ種目の1年、2年、3年の表を上から順に並べています。縦が走順・役割、横がクラスです。',
    `版：${versionName} / 作成：${Utilities.formatDate(new Date(createdAt), 'Asia/Tokyo', 'yyyy/MM/dd HH:mm')} / 登録：${pageRegistrations.length}件`,
    columnCount,
  );
  sheet.setFrozenRows(3);
  sheet.setColumnWidth(1, 125);
  classNumbers.forEach((_, index) => sheet.setColumnWidth(index + 2, 175));

  let row = 5;
  let sectionIndex = 0;
  page.events.forEach((event) => {
    const grades = gradesForEvent(event);
    grades.forEach((grade) => {
      const table = buildConcurrentRosterTables(registrations, grade, [event])[0];
      // 1競技だけのページは今までどおり学年だけを見出しにする。
      // 複数競技をまとめたページでは、どの競技の表かが分かるよう競技名を必ず入れる。
      const label = !multipleEvents
        ? `${grade}年`
        : grades.length > 1 ? `${event.eventName}（${grade}年）` : event.eventName;
      sectionTitle(sheet, row, columnCount, label, sectionIndex % 2 === 1);
      row += 1;
      const headers = ['走順・役割', ...classNumbers.map((classNumber) => `${classNumber}組`)];
      tableHeader(sheet, row, headers);
      row += 1;
      const values = (table?.rows ?? []).map((slot) => [
        slot.slotName,
        ...classNumbers.map((classNumber) => athleteCell(slot.athletesByClass[classNumber] ?? [], report)),
      ]);
      tableBody(sheet, row, values);
      if (values.length > 0) {
        sheet.getRange(row, 1, values.length, 1).setFontWeight('bold')
          .setBackground(sectionIndex % 2 ? '#e5eef4' : PRINT_COLORS.groupB)
          .setHorizontalAlignment('center');
        sheet.getRange(row, 2, values.length, classNumbers.length)
          .setFontWeight('bold').setHorizontalAlignment('center');
        const greatest = Math.max(1, ...(table?.rows ?? []).flatMap((slot) =>
          classNumbers.map((classNumber) => slot.athletesByClass[classNumber]?.length ?? 0)));
        const heightPerAthlete = report === '当日変更用' ? 92 : 58;
        sheet.setRowHeights(row, values.length, Math.max(report === '当日変更用' ? 92 : 56, greatest * heightPerAthlete));
      }
      row += values.length + 1;
      sectionIndex += 1;
    });
  });
}

function writeEventRosterSheets(
  book: GoogleAppsScript.Spreadsheet.Spreadsheet,
  events: EventSetting[],
  versionName: string,
  registrations: Registration[],
  students: Student[],
  createdAt: string,
  report: '種目別' | '当日変更用',
): void {
  const pages = buildEventRosterPages(events);
  const sheetNames = planEventRosterSheetNames(pages);
  pages.forEach((page, index) => {
    const sheet = book.insertSheet(sheetNames[index]!);
    writeEventRosterSheet(sheet, page, versionName, registrations, students, createdAt, report);
  });
}

/** 帳票へ実際に印字した内容を残す隠しシート。差分作成のときの比較元になる。 */
const ROSTER_SYSTEM_SHEET = '_管理用データ';
const ROSTER_INDEX_SHEET = '自分の競技を探す';
const ROSTER_SYSTEM_HEADERS = [
  'registration_id', 'event_id', 'event_name', 'slot_id', 'slot_name',
  'grade', 'class_number', 'student_id', 'student_name', 'gender', 'source_version',
  'correction_source',
] as const;

function writeSystemDataSheet(
  book: GoogleAppsScript.Spreadsheet.Spreadsheet,
  registrations: Registration[],
  correctionSubmissionIds: Set<string>,
): void {
  const existing = book.getSheetByName(ROSTER_SYSTEM_SHEET);
  if (existing) book.deleteSheet(existing);
  const sheet = book.insertSheet(ROSTER_SYSTEM_SHEET);
  const headers = [...ROSTER_SYSTEM_HEADERS];
  const rows = registrations.map((row) => [
    row.registrationId, row.eventId, row.eventName, row.slotId, row.slotName,
    row.grade, row.classNumber, row.studentId, row.studentNameSnapshot,
    rosterGenderLabel(row.genderSnapshot), row.version,
    correctionSubmissionIds.has(row.sourceSubmissionId),
  ]);
  sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
  if (rows.length > 0) sheet.getRange(2, 1, rows.length, headers.length).setValues(rows);
  sheet.hideSheet();
}

/**
 * 修正フォーム由来の選手枠へ色と補足を付ける。
 *
 * 差分作成では書き直したシートだけを渡す。触っていないシートには前の版で付けた色が
 * そのまま残っており、中身が変わっていない以上その色は今も正しいため、付け直さない。
 * 全シートを走査すると`createTextFinder`が枠の数だけ走り、複製で稼いだ時間を使い切る。
 */
function highlightCorrectionRegistrations(
  sheets: GoogleAppsScript.Spreadsheet.Sheet[],
  registrations: Registration[],
  correctionSubmissionIds: Set<string>,
): void {
  const corrected = registrations.filter((row) => correctionSubmissionIds.has(row.sourceSubmissionId));
  if (corrected.length === 0) return;
  sheets.filter((sheet) => sheet.getName() !== ROSTER_SYSTEM_SHEET).forEach((sheet) => {
    corrected.forEach((registration) => {
      const matches = sheet.createTextFinder(registration.studentId).matchCase(true).findAll();
      matches.forEach((range) => {
        const display = range.getDisplayValue();
        if (display !== registration.studentId
          && (!display.includes(registration.studentId)
            || !display.includes(registration.studentNameSnapshot))) return;
        range.setBackground(PRINT_COLORS.correction)
          .setNote('修正フォームから承認・反映された選手枠です。');
        if (display === registration.studentId && range.getColumn() < sheet.getLastColumn()) {
          const nameCell = sheet.getRange(range.getRow(), range.getColumn() + 1);
          if (nameCell.getDisplayValue() === registration.studentNameSnapshot) {
            nameCell.setBackground(PRINT_COLORS.correction)
              .setNote('修正フォームから承認・反映された選手枠です。');
          }
        }
      });
    });
  });
}

function addSlideText(
  slide: GoogleAppsScript.Slides.Slide,
  text: string,
  left: number,
  top: number,
  width: number,
  height: number,
  fontSize: number,
  bold = false,
  background = '',
): void {
  const shape = slide.insertTextBox(text, left, top, width, height);
  shape.getText().getTextStyle().setFontSize(fontSize).setForegroundColor('#172033').setBold(bold);
  shape.getText().getParagraphStyle().setParagraphAlignment(SlidesApp.ParagraphAlignment.START);
  if (background) shape.getFill().setSolidFill(background);
  shape.getBorder().setTransparent();
}

function writeClassDistributionPdf(
  versionFolder: GoogleAppsScript.Drive.Folder,
  versionName: string,
  registrations: Registration[],
  students: Student[],
  createdAt: string,
  correctionSubmissionIds: Set<string>,
): CreatedRosterFile {
  const fileName = `${versionName}_クラス配布用選手名簿`;
  const presentation = SlidesApp.create(`${fileName}_PDF生成用`);
  // PDFへの変換や保存が途中で失敗しても、氏名と学籍番号が入ったPDF生成用スライドを
  // Driveへ残さない。作成直後から必ず後片付けの対象にする。
  const temporary = DriveApp.getFileById(presentation.getId());
  try {
    renderClassDistributionSlides(
      presentation, versionName, registrations, students, createdAt, correctionSubmissionIds,
    );
    presentation.saveAndClose();
    const pdf = versionFolder.createFile(
      temporary.getAs('application/pdf').setName(`${fileName}.pdf`),
    );
    return { name: 'クラス配布用PDF', url: pdf.getUrl() };
  } finally {
    temporary.setTrashed(true);
  }
}

function renderClassDistributionSlides(
  presentation: GoogleAppsScript.Slides.Presentation,
  versionName: string,
  registrations: Registration[],
  students: Student[],
  createdAt: string,
  correctionSubmissionIds: Set<string>,
): void {
  const pages = buildClassDistributionPages(registrations, students);
  const firstSlide = presentation.getSlides()[0]!;
  pages.forEach((page, pageIndex) => {
    const slide = pageIndex === 0
      ? firstSlide
      : presentation.appendSlide(SlidesApp.PredefinedLayout.BLANK);
    slide.getPageElements().forEach((element) => element.remove());
    addSlideText(slide, `${page.grade}年${page.classNumber}組 選手名簿`, 24, 15, 670, 35, 20, true);
    addSlideText(
      slide,
      `版：${versionName} / 作成：${Utilities.formatDate(new Date(createdAt), 'Asia/Tokyo', 'yyyy/MM/dd HH:mm')}`
        + ' / ※黄色は修正フォームから反映',
      25, 51, 670, 20, 8, false,
    );
    const rows = page.registrations;
    if (rows.length === 0) {
      addSlideText(slide, '登録された選手はいません。', 28, 88, 650, 40, 14);
      return;
    }
    const columnCount = rows.length > 36 ? 3 : 2;
    const rowsPerColumn = Math.ceil(rows.length / columnCount);
    const gap = 10;
    const availableWidth = 672;
    const columnWidth = (availableWidth - gap * (columnCount - 1)) / columnCount;
    const rowHeight = Math.min(22, 315 / Math.max(1, rowsPerColumn));
    const fontSize = rowHeight >= 18 ? 9 : rowHeight >= 14 ? 8 : 7;
    rows.forEach((registration, index) => {
      const column = Math.floor(index / rowsPerColumn);
      const row = index % rowsPerColumn;
      const corrected = correctionSubmissionIds.has(registration.sourceSubmissionId);
      addSlideText(
        slide,
        `${registration.eventName}｜${registration.slotName || '選手'}｜`
          + `${registration.studentNameSnapshot}（${registration.studentId}・`
          + `${rosterGenderLabel(registration.genderSnapshot)}）`,
        24 + column * (columnWidth + gap),
        78 + row * rowHeight,
        columnWidth,
        Math.max(10, rowHeight - 1),
        fontSize,
        corrected,
        corrected ? PRINT_COLORS.correction : (row % 2 === 0 ? '#eef4f8' : '#ffffff'),
      );
    });
  });
  if (pages.length === 0) {
    firstSlide.getPageElements().forEach((element) => element.remove());
    addSlideText(firstSlide, '配布対象のクラスがありません。', 30, 30, 650, 50, 18, true);
  }
}

function writeReport(
  report: ReportName,
  versionFolder: GoogleAppsScript.Drive.Folder,
  versionName: string,
  registrations: Registration[],
  events: EventSetting[],
  students: Student[],
  createdAt: string,
  correctionSubmissionIds: Set<string>,
): CreatedRosterFile {
  if (report === 'クラス配布用PDF') {
    return writeClassDistributionPdf(
      versionFolder, versionName, registrations, students, createdAt, correctionSubmissionIds,
    );
  }
  const fileName = `${versionName}_${report}選手名簿`;
  const book = SpreadsheetApp.create(fileName);
  DriveApp.getFileById(book.getId()).moveTo(versionFolder);
  const indexSheet = book.getSheets()[0]!;
  writeAthleteIndex(indexSheet, versionName, registrations, createdAt);
  const displayEvents = [...events].sort((left, right) =>
    left.displayOrder - right.displayOrder || left.assemblyOrder - right.assemblyOrder);
  const displaySorted = sortedRegistrations(registrations, report === 'クラス別・招集順' ? 'クラス別' : report, events);
  if (report === '種目別' || report === '当日変更用') {
    writeEventRosterSheets(book, displayEvents, versionName, displaySorted, students, createdAt, report);
  } else {
    [1, 2, 3].forEach((grade) => writeGradeRosterSheet(
      book.insertSheet(), 'クラス別', grade, versionName, displaySorted, displayEvents, students, createdAt,
      `クラス別 ${grade}年`,
    ));
    const assemblyEvents = [...events].sort((left, right) =>
      left.assemblyOrder - right.assemblyOrder || left.displayOrder - right.displayOrder);
    const assemblySorted = sortedRegistrations(registrations, '招集順', events);
    [1, 2, 3].forEach((grade) => writeGradeRosterSheet(
      book.insertSheet(), '招集順', grade, versionName, assemblySorted, assemblyEvents, students, createdAt,
      `招集順 ${grade}年`,
    ));
  }
  highlightCorrectionRegistrations(book.getSheets(), displaySorted, correctionSubmissionIds);
  writeSystemDataSheet(book, displaySorted, correctionSubmissionIds);
  book.setActiveSheet(indexSheet);
  return { name: report, url: book.getUrl() };
}

// ------------------------------------------------------- 差分で名簿を作り直す

/** 差分作成をあきらめて全面作成へ切り替える理由。利用者へは出さず、状況シートの補足に使う。 */
type RosterPatchFallback =
  | 'BASE_FILE_MISSING' | 'BASE_DATA_MISSING' | 'SHEET_LAYOUT_CHANGED' | 'TOO_MANY_CHANGES';

interface RosterPatchResult {
  file?: CreatedRosterFile;
  fallback?: RosterPatchFallback;
  rewrittenSheetCount?: number;
}

/**
 * 帳票の`_管理用データ`から、その版に印字されている選手枠を読む。
 * 列は名前で引く。将来列が増えても差分作成が壊れないようにするため。
 */
function readRosterSystemData(
  book: GoogleAppsScript.Spreadsheet.Spreadsheet,
): RosterBaselineRow[] | undefined {
  const sheet = book.getSheetByName(ROSTER_SYSTEM_SHEET);
  if (!sheet || sheet.getLastRow() < 1 || sheet.getLastColumn() < 1) return undefined;
  const width = sheet.getLastColumn();
  const headers = sheet.getRange(1, 1, 1, width).getDisplayValues()[0] ?? [];
  const columnOf = (name: string): number => headers.indexOf(name);
  const required = [
    'registration_id', 'event_id', 'grade', 'class_number', 'student_id', 'student_name', 'gender',
  ];
  if (required.some((name) => columnOf(name) < 0)) return undefined;
  if (sheet.getLastRow() < 2) return [];
  return sheet.getRange(2, 1, sheet.getLastRow() - 1, width).getDisplayValues()
    .filter((row) => String(row[columnOf('registration_id')] ?? '') !== '')
    .map((row) => ({
      registrationId: String(row[columnOf('registration_id')] ?? ''),
      eventId: String(row[columnOf('event_id')] ?? ''),
      grade: Number(row[columnOf('grade')] ?? 0),
      classNumber: Number(row[columnOf('class_number')] ?? 0),
      studentId: String(row[columnOf('student_id')] ?? ''),
      studentName: String(row[columnOf('student_name')] ?? ''),
      genderLabel: String(row[columnOf('gender')] ?? ''),
    }));
}

/**
 * シートを同じ位置へ作り直す。複製元の行の高さ・結合・メモ・背景色が残ったまま
 * 上書きすると体裁が混ざるため、消してから入れ直す。並び順は印刷順なので位置を保つ。
 */
function replaceSheetInPlace(
  book: GoogleAppsScript.Spreadsheet.Spreadsheet, name: string,
): GoogleAppsScript.Spreadsheet.Sheet {
  const existing = book.getSheetByName(name);
  const position = existing ? existing.getIndex() - 1 : book.getNumSheets();
  if (existing) book.deleteSheet(existing);
  const sheet = book.insertSheet(position);
  sheet.setName(name);
  return sheet;
}

function rosterCreatedLabel(createdAt: string): string {
  return Utilities.formatDate(new Date(createdAt), 'Asia/Tokyo', 'yyyy/MM/dd HH:mm');
}

/** 書き直さないシートの見出しにある版名と作成日時だけを新しい版へそろえる。 */
function restampRosterSheet(sheet: GoogleAppsScript.Spreadsheet.Sheet, versionName: string, createdAt: string): void {
  const cell = sheet.getRange(3, 1);
  const updated = replaceRosterMetadataVersion(cell.getDisplayValue(), versionName, rosterCreatedLabel(createdAt));
  if (updated) cell.setValue(updated);
}

function findFileInFolder(
  folder: GoogleAppsScript.Drive.Folder, name: string,
): GoogleAppsScript.Drive.File | undefined {
  const files = folder.getFilesByName(name);
  return files.hasNext() ? files.next() : undefined;
}

/**
 * 前回の版の帳票を複製し、変わったシートだけを書き直す。
 *
 * 比較元は複製したファイル自身の`_管理用データ`にする。`登録データ`は承認取消のあとに
 * 作り直されるため、すでに配った帳票の中身とは一致しないことがある。
 *
 * 差分で作れないと分かった時点で複製を捨て、`fallback`を返す。呼び出し側は全面作成へ切り替える。
 */
function patchReportFromBase(
  report: '種目別' | 'クラス別・招集順' | '当日変更用',
  baseFolder: GoogleAppsScript.Drive.Folder,
  baseVersionName: string,
  versionFolder: GoogleAppsScript.Drive.Folder,
  versionName: string,
  registrations: Registration[],
  events: EventSetting[],
  students: Student[],
  createdAt: string,
  correctionSubmissionIds: Set<string>,
): RosterPatchResult {
  const baseFile = findFileInFolder(baseFolder, `${baseVersionName}_${report}選手名簿`);
  if (!baseFile) return { fallback: 'BASE_FILE_MISSING' };

  const copy = baseFile.makeCopy(`${versionName}_${report}選手名簿`, versionFolder);
  const discard = (fallback: RosterPatchFallback): RosterPatchResult => {
    try { copy.setTrashed(true); } catch { /* 全面作成でやり直すため、後始末の失敗は無視する */ }
    return { fallback };
  };

  const book = SpreadsheetApp.openById(copy.getId());
  const baseline = readRosterSystemData(book);
  if (!baseline) return discard('BASE_DATA_MISSING');
  if (!book.getSheetByName(ROSTER_INDEX_SHEET)) return discard('SHEET_LAYOUT_CHANGED');

  const diff = diffRosterRegistrations(baseline, registrations);
  const displayEvents = [...events].sort((left, right) =>
    left.displayOrder - right.displayOrder || left.assemblyOrder - right.assemblyOrder);
  const displaySorted = sortedRegistrations(
    registrations, report === 'クラス別・招集順' ? 'クラス別' : report, events,
  );

  const rewritten: GoogleAppsScript.Spreadsheet.Sheet[] = [];
  if (report === '種目別' || report === '当日変更用') {
    const pages = buildEventRosterPages(displayEvents);
    const sheetNames = planEventRosterSheetNames(pages);
    // 競技を足した・消した・並べ替えた場合は、前回のシートと今回のページが対応しない。
    const existing = book.getSheets().map((sheet) => sheet.getName())
      .filter((name) => name !== ROSTER_SYSTEM_SHEET && name !== ROSTER_INDEX_SHEET);
    const sameLayout = existing.length === sheetNames.length
      && sheetNames.every((name, index) => existing[index] === name);
    if (!sameLayout) return discard('SHEET_LAYOUT_CHANGED');

    const affected = selectAffectedRosterPages(pages, diff.affectedEventIds);
    if (shouldRebuildWholeReport(affected.length, pages.length)) return discard('TOO_MANY_CHANGES');
    affected.forEach((index) => {
      const sheet = replaceSheetInPlace(book, sheetNames[index]!);
      writeEventRosterSheet(
        sheet, pages[index]!, versionName, displaySorted, students, createdAt, report,
      );
      rewritten.push(sheet);
    });
  } else {
    const layouts = ['クラス別', '招集順'] as const;
    const gradeNames = layouts.flatMap((layout) =>
      [1, 2, 3].map((grade) => gradeRosterSheetName(layout, grade)));
    if (gradeNames.some((name) => !book.getSheetByName(name))) return discard('SHEET_LAYOUT_CHANGED');

    const affectedGrades = diff.affectedGrades.filter((grade) => [1, 2, 3].includes(grade));
    if (shouldRebuildWholeReport(affectedGrades.length * layouts.length, gradeNames.length)) {
      return discard('TOO_MANY_CHANGES');
    }
    const assemblyEvents = [...events].sort((left, right) =>
      left.assemblyOrder - right.assemblyOrder || left.displayOrder - right.displayOrder);
    const assemblySorted = sortedRegistrations(registrations, '招集順', events);
    affectedGrades.forEach((grade) => {
      const classSheet = replaceSheetInPlace(book, gradeRosterSheetName('クラス別', grade));
      writeGradeRosterSheet(
        classSheet, 'クラス別', grade, versionName, displaySorted, displayEvents, students, createdAt,
        gradeRosterSheetName('クラス別', grade),
      );
      const assemblySheet = replaceSheetInPlace(book, gradeRosterSheetName('招集順', grade));
      writeGradeRosterSheet(
        assemblySheet, '招集順', grade, versionName, assemblySorted, assemblyEvents, students, createdAt,
        gradeRosterSheetName('招集順', grade),
      );
      rewritten.push(classSheet, assemblySheet);
    });
  }

  // 索引は全学年ぶんを1枚にまとめるため、どこか1件でも変われば作り直す。
  const indexSheet = replaceSheetInPlace(book, ROSTER_INDEX_SHEET);
  writeAthleteIndex(indexSheet, versionName, displaySorted, createdAt);

  const rewrittenNames = new Set([...rewritten.map((sheet) => sheet.getName()), ROSTER_INDEX_SHEET]);
  book.getSheets()
    .filter((sheet) => !rewrittenNames.has(sheet.getName()) && sheet.getName() !== ROSTER_SYSTEM_SHEET)
    .forEach((sheet) => restampRosterSheet(sheet, versionName, createdAt));

  highlightCorrectionRegistrations(rewritten, displaySorted, correctionSubmissionIds);
  writeSystemDataSheet(book, displaySorted, correctionSubmissionIds);
  book.setActiveSheet(indexSheet);
  return {
    file: { name: report, url: book.getUrl() },
    rewrittenSheetCount: rewritten.length + 1,
  };
}

function documentProperties(): GoogleAppsScript.Properties.Properties {
  return PropertiesService.getDocumentProperties();
}

/**
 * 名簿作成が途中かどうかだけを見る。保存先を知っているのはこのファイルだけなので、
 * メニューの有効・無効を決める側は自前で Properties を読まずにこれを呼ぶ。
 * メニュー構築中に呼ばれるため、`loadRosterJob()`と違って何も書き戻さない。
 */
export function isPlayerRosterJobActive(): boolean {
  return documentProperties().getProperty(ROSTER_JOB_PROPERTY) !== null;
}

function loadRosterJob(): RosterJobState | undefined {
  const raw = documentProperties().getProperty(ROSTER_JOB_PROPERTY);
  if (!raw) return undefined;
  const state = JSON.parse(raw) as RosterJobState;
  // 名簿の構成やページの分け方を変えたら必ず上げる。上げ忘れると、途中まで作った名簿が
  // 古い体裁、残りが新しい体裁になり、1つの版の中で見た目が食い違う。
  if (state.reportPlanVersion !== ROSTER_REPORT_PLAN_VERSION) {
    state.status = 'ERROR';
    state.message = '種目別名簿と当日変更用名簿のページの分け方が変わりました（表示順の100区切りでまとめるようになりました）。'
      + '途中まで作った名簿と体裁が食い違うため、「途中の名簿作成を取り消す」を実行してから、新しく作成してください。'
      + '正式データはまだ変更されていません。';
    state.updatedAt = new Date().toISOString();
    documentProperties().setProperty(ROSTER_JOB_PROPERTY, JSON.stringify(state));
  }
  return state;
}

function saveRosterJob(state: RosterJobState): void {
  documentProperties().setProperty(ROSTER_JOB_PROPERTY, JSON.stringify(state));
}

function clearRosterTriggers(): void {
  ScriptApp.getProjectTriggers()
    .filter((trigger) => trigger.getHandlerFunction() === ROSTER_TRIGGER_HANDLER)
    .forEach((trigger) => ScriptApp.deleteTrigger(trigger));
}

function scheduleRosterContinuation(): void {
  clearRosterTriggers();
  ScriptApp.newTrigger(ROSTER_TRIGGER_HANDLER).timeBased().after(5_000).create();
}

function writeRosterStatus(status: RosterJobStatus): void {
  const book = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = book.getSheetByName(ROSTER_STATUS_SHEET) ?? book.insertSheet(ROSTER_STATUS_SHEET);
  // 以前のレイアウトでデータ範囲の外まで結合されていても、
  // 結合範囲の一部だけを選択しないようシート全体を解除対象にする。
  sheet.getRange(1, 1, sheet.getMaxRows(), sheet.getMaxColumns()).breakApart();
  sheet.clear();
  const rows = [
    ['名簿作成状況', ''],
    ['状態', status.status === 'RUNNING' ? '作成中' : status.status === 'ERROR' ? '中断'
      : status.status === 'COMPLETE' ? '完了' : status.status === 'CANCELLED' ? '取り消し' : '未実行'],
    ['版名', status.versionName],
    ['進み具合', status.progress],
    ['保存先', status.folderUrl],
    ['メッセージ', status.message],
    ['更新日時', status.updatedAt],
  ];
  sheet.getRange(1, 1, rows.length, 2).setValues(rows);
  sheet.getRange(1, 1, 1, 2).mergeAcross().setFontSize(16).setFontWeight('bold')
    .setBackground('#17324d').setFontColor('#ffffff');
  sheet.getRange(2, 1, rows.length - 1, 1).setFontWeight('bold').setBackground('#dbe7f0');
  sheet.getRange(2, 2, rows.length - 1, 1).setWrap(true);
  sheet.setColumnWidth(1, 120);
  sheet.setColumnWidth(2, 520);
}

function statusFromJob(state: RosterJobState): RosterJobStatus {
  return {
    active: true,
    status: state.status,
    versionName: state.versionName,
    progress: `${state.nextReportIndex}/${REPORTS.length}ファイル`,
    folderUrl: state.folderUrl,
    message: state.message,
    updatedAt: state.updatedAt,
  };
}

function stagingSheetName(prefix: string, jobId: string): string {
  return `_${prefix}_${jobId.replace(/-/g, '').slice(0, 12)}`;
}

function writeStagingRegistrations(name: string, registrations: Registration[]): void {
  const book = SpreadsheetApp.getActiveSpreadsheet();
  const existing = book.getSheetByName(name);
  if (existing) book.deleteSheet(existing);
  const sheet = book.insertSheet(name);
  sheet.getRange(1, 1, 1, REGISTRATION_HEADERS.length).setValues([[...REGISTRATION_HEADERS]]);
  if (registrations.length > 0) sheet.getRange(2, 1, registrations.length, REGISTRATION_HEADERS.length)
    .setValues(registrations.map((row) => [
      row.registrationId, row.sourceSubmissionId, row.eventId, row.eventName, row.slotId,
      row.slotName, row.studentId, row.studentNameSnapshot, row.grade, row.classNumber,
      row.version, row.updatedAt, row.updatedBy, row.genderSnapshot ?? 'U',
    ]));
  sheet.hideSheet();
}

function readStagingRegistrations(name: string): Registration[] {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(name);
  if (!sheet) throw new Error('作成途中の登録データが見つかりません。名簿作成を取り消して、最初から作り直してください。');
  if (sheet.getLastRow() < 2) return [];
  return sheet.getRange(2, 1, sheet.getLastRow() - 1, REGISTRATION_HEADERS.length).getValues().map((row) => ({
    registrationId: String(row[0] ?? ''), sourceSubmissionId: String(row[1] ?? ''),
    eventId: String(row[2] ?? ''), eventName: String(row[3] ?? ''), slotId: String(row[4] ?? ''),
    slotName: String(row[5] ?? ''), studentId: String(row[6] ?? ''), studentNameSnapshot: String(row[7] ?? ''),
    grade: Number(row[8]), classNumber: Number(row[9]), version: String(row[10] ?? ''),
    updatedAt: row[11] instanceof Date ? row[11].toISOString() : String(row[11] ?? ''),
    updatedBy: String(row[12] ?? ''),
    genderSnapshot: normalizeStagingGender(row[13]),
  }));
}

function writeSourceSubmissionIds(name: string, ids: string[]): void {
  const book = SpreadsheetApp.getActiveSpreadsheet();
  const existing = book.getSheetByName(name);
  if (existing) book.deleteSheet(existing);
  const sheet = book.insertSheet(name);
  sheet.getRange(1, 1).setValue('submission_id');
  if (ids.length > 0) sheet.getRange(2, 1, ids.length, 1).setValues(ids.map((id) => [id]));
  sheet.hideSheet();
}

function readSourceSubmissionIds(name: string): Set<string> {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(name);
  if (!sheet) throw new Error('名簿作成元の申請一覧が見つかりません。名簿作成を取り消して、最初から作り直してください。');
  if (sheet.getLastRow() < 2) return new Set();
  return new Set(sheet.getRange(2, 1, sheet.getLastRow() - 1, 1).getDisplayValues().flat().filter(Boolean));
}

function deleteSheetIfPresent(name: string): void {
  const book = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = book.getSheetByName(name);
  if (sheet) book.deleteSheet(sheet);
}

function removeIncompleteReport(folder: GoogleAppsScript.Drive.Folder, versionName: string, report: ReportName): void {
  const name = report === 'クラス配布用PDF'
    ? `${versionName}_クラス配布用選手名簿.pdf`
    : `${versionName}_${report}選手名簿`;
  const files = folder.getFilesByName(name);
  while (files.hasNext()) files.next().setTrashed(true);
}

function uniqueBackupName(): string {
  const book = SpreadsheetApp.getActiveSpreadsheet();
  const prefix = `登録データ_バックアップ_${Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyyMMdd_HHmmss')}`;
  let name = prefix;
  let suffix = 1;
  while (book.getSheetByName(name)) {
    name = `${prefix}_${suffix}`;
    suffix += 1;
  }
  return name;
}

function assertAcceptedSubmissionsAreValid(): void {
  const submissions = readSubmissions();
  // 帳票へ実在生徒が流れる最後の砦。疑似申請を作った名簿と今の選択が違えば作成しない。
  assertMockRosterSourceConsistent(submissions);
  const items = readItems();
  const students = readStudents();
  const rules = readRuleSettings();
  const invalid = submissions
    .filter((submission) => submission.status === 'APPROVED' || submission.status === 'APPLIED')
    .filter((submission) => validateSubmission(
      submission,
      items.filter((item) => item.submissionId === submission.submissionId),
      { students, sameClassInitialSubmissionCount: 1, rules },
    ).errorCount > 0);
  if (invalid.length > 0) {
    throw new Error(`承認済み申請のうち${invalid.length}件にエラーが見つかりました。「すべて再検査する」で内容を確認し、修正してから作成してください。`);
  }
}

export function createPlayerRosters(inputName: string): CreateRosterResult {
  const normalizedInputName = normalizeRosterInputName(inputName);
  if (!normalizedInputName) throw new Error('選手名簿の名前を入力してください。例：「第1回確認版」');
  const lock = LockService.getDocumentLock();
  if (!lock.tryLock(30_000)) {
    throw new Error('ほかの担当者が処理中です。少し待ってから、もう一度実行してください。');
  }

  let versionFolder: GoogleAppsScript.Drive.Folder | undefined;
  let stagingName = '';
  let sourceName = '';
  let jobSaved = false;
  try {
    ensureApplicationSheets();
    const activeJob = loadRosterJob();
    assertRosterJobCanStart(activeJob?.versionName);
    const actor = assertAuthorized();
    assertAcceptedSubmissionsAreValid();
    const submissions = readSubmissions();
    const acceptedSubmissions = submissions
      .filter((submission) => submission.status === 'APPROVED' || submission.status === 'APPLIED');
    if (acceptedSubmissions.length === 0) {
      throw new Error('承認済みの申請がありません。申請を承認してから選手名簿を作成してください。');
    }

    const rosterRoot = childFolder(parentFolder(), ROSTER_FOLDER_NAME);
    const versionName = selectRosterVersionName(normalizedInputName, childFolderNames(rosterRoot));
    versionFolder = rosterRoot.createFolder(versionName);
    const createdAt = new Date().toISOString();
    const jobId = Utilities.getUuid();
    const students = readStudents();
    const registrations = buildRegistrationSnapshot({
      submissions, items: readItems(), students,
      versionName, updatedAt: createdAt, updatedBy: actor,
    });
    const folderUrl = versionFolder.getUrl();
    stagingName = stagingSheetName('名簿登録作成中', jobId);
    sourceName = stagingSheetName('名簿申請作成中', jobId);
    writeStagingRegistrations(stagingName, registrations);
    writeSourceSubmissionIds(sourceName, acceptedSubmissions.map((submission) => submission.submissionId));
    const preflight = buildRosterDistributionPreflight(submissions);
    const state: RosterJobState = {
      reportPlanVersion: ROSTER_REPORT_PLAN_VERSION,
      jobId, inputName: normalizedInputName, versionName, folderId: versionFolder.getId(), folderUrl,
      registrationCount: registrations.length, sourceSubmissionCount: acceptedSubmissions.length,
      createdBy: actor, createdAt, updatedAt: createdAt, nextReportIndex: 0,
      stagingSheetName: stagingName, sourceSheetName: sourceName, files: [], status: 'RUNNING',
      message: `3種類のスプレッドシートとクラス配布用PDFを1ファイルずつ自動作成します。${preflight.message}`,
    };
    saveRosterJob(state);
    jobSaved = true;
    writeRosterStatus(statusFromJob(state));
    scheduleRosterContinuation();

    return {
      inputName: normalizedInputName, versionName, registrationCount: registrations.length,
      sourceSubmissionCount: acceptedSubmissions.length, folderUrl, files: [], processing: true,
      message: state.message,
    };
  } catch (error) {
    if (jobSaved) {
      documentProperties().deleteProperty(ROSTER_JOB_PROPERTY);
      try { clearRosterTriggers(); } catch { /* 元のエラーを優先する */ }
    }
    if (stagingName) try { deleteSheetIfPresent(stagingName); } catch { /* 元のエラーを優先する */ }
    if (sourceName) try { deleteSheetIfPresent(sourceName); } catch { /* 元のエラーを優先する */ }
    if (versionFolder) {
      try { versionFolder.setTrashed(true); } catch { /* 元のエラーを優先する */ }
    }
    throw error;
  } finally {
    lock.releaseLock();
  }
}

/**
 * 差分作成の1ファイルぶん。複製元が使えないと分かったら`undefined`を返し、
 * 呼び出し側はそのファイルだけ全面作成へ切り替える。差分で作れないことは失敗ではない。
 */
function patchReportFromBaseFolder(
  report: '種目別' | 'クラス別・招集順' | '当日変更用',
  state: RosterJobState,
  versionFolder: GoogleAppsScript.Drive.Folder,
  registrations: Registration[],
  events: EventSetting[],
  students: Student[],
  correctionSubmissionIds: Set<string>,
): RosterPatchResult {
  if (!state.baseFolderId || !state.baseVersionName) return { fallback: 'BASE_FILE_MISSING' };
  let baseFolder: GoogleAppsScript.Drive.Folder;
  try {
    baseFolder = DriveApp.getFolderById(state.baseFolderId);
  } catch {
    return { fallback: 'BASE_FILE_MISSING' };
  }
  return patchReportFromBase(
    report, baseFolder, state.baseVersionName, versionFolder, state.versionName,
    registrations, events, students, state.createdAt, correctionSubmissionIds,
  );
}

/** 状況シートへ出す1行。差分で作れたか、作り直したかを担当者が確認できるようにする。 */
function describeRosterPatch(result: RosterPatchResult | undefined): string {
  if (!result) return '';
  if (result.file) return `（${result.rewrittenSheetCount ?? 0}シートだけ書き直しました）`;
  const reason = {
    BASE_FILE_MISSING: '前回の版のファイルが見つからなかった',
    BASE_DATA_MISSING: '前回の版に比較用の情報がなかった',
    SHEET_LAYOUT_CHANGED: '競技設定が変わってページが対応しなかった',
    TOO_MANY_CHANGES: '書き直すページが多かった',
  }[result.fallback ?? 'BASE_FILE_MISSING'];
  return `（${reason}ため、このファイルは作り直しました）`;
}

interface RosterDiffPlan {
  baseInputName: string;
  baseVersionName: string;
  baseFolder: GoogleAppsScript.Drive.Folder;
  registrations: Registration[];
  acceptedSubmissionIds: string[];
  diff: RosterDiff;
  affectedEventNames: string[];
}

/**
 * 差分作成の下ごしらえ。前回作り終えた版を`選手名簿作成履歴`の最後の行から選び、
 * その版の帳票に印字されている内容と、いま承認済みの内容を突き合わせる。
 */
function buildRosterDiffPlan(actor: string, createdAt: string, versionName: string): RosterDiffPlan {
  const history = readRosterHistory();
  const base = history[history.length - 1];
  if (!base) {
    throw new Error('まだ選手名簿を1度も作成していません。最初は「承認済みから選手名簿を作成」で作成してください。');
  }
  let baseFolder: GoogleAppsScript.Drive.Folder;
  try {
    baseFolder = DriveApp.getFolderById(base.folderId);
    if (baseFolder.isTrashed()) throw new Error('TRASHED');
  } catch {
    throw new Error(`前回の版「${base.versionName}」のフォルダが見つかりません。ゴミ箱へ移動された可能性があります。「承認済みから選手名簿を作成」で作り直してください。`);
  }
  const baseBook = findFileInFolder(baseFolder, `${base.versionName}_種目別選手名簿`);
  if (!baseBook) {
    throw new Error(`前回の版「${base.versionName}」の種目別選手名簿が見つかりません。「承認済みから選手名簿を作成」で作り直してください。`);
  }
  const baseline = readRosterSystemData(SpreadsheetApp.openById(baseBook.getId()));
  if (!baseline) {
    throw new Error(`前回の版「${base.versionName}」には差分の比較に使う情報がありません。「承認済みから選手名簿を作成」で作り直してください。`);
  }

  const submissions = readSubmissions();
  const acceptedSubmissions = submissions
    .filter((submission) => submission.status === 'APPROVED' || submission.status === 'APPLIED');
  if (acceptedSubmissions.length === 0) {
    throw new Error('承認済みの申請がありません。申請を承認してから選手名簿を作成してください。');
  }
  const registrations = buildRegistrationSnapshot({
    submissions, items: readItems(), students: readStudents(),
    versionName, updatedAt: createdAt, updatedBy: actor,
  });
  const diff = diffRosterRegistrations(baseline, registrations);
  const formYear = readFormDesign().year;
  const eventNameById = new Map(readEventSettings()
    .filter((event) => event.year === formYear)
    .map((event) => [event.eventId, event.eventName]));
  return {
    baseInputName: base.inputName,
    baseVersionName: base.versionName,
    baseFolder,
    registrations,
    acceptedSubmissionIds: acceptedSubmissions.map((submission) => submission.submissionId),
    diff,
    affectedEventNames: diff.affectedEventIds.map((eventId) => eventNameById.get(eventId) ?? eventId),
  };
}

/** 差分作成を実行する前の下調べ。作成は行わない。 */
export function describePlayerRosterDiff(): RosterDiffPreview {
  assertAuthorized();
  ensureApplicationSheets();
  const plan = buildRosterDiffPlan('', new Date().toISOString(), '');
  const nextVersionName = selectRosterVersionName(
    plan.baseInputName, childFolderNames(childFolder(parentFolder(), ROSTER_FOLDER_NAME)),
  );
  const { diff } = plan;
  return {
    canRun: diff.hasChanges,
    baseVersionName: plan.baseVersionName,
    nextVersionName,
    addedCount: diff.addedCount,
    removedCount: diff.removedCount,
    changedCount: diff.changedCount,
    totalCount: diff.totalCount,
    affectedEventNames: plan.affectedEventNames,
    message: diff.hasChanges
      ? `前回の版「${plan.baseVersionName}」から、選手枠${diff.totalCount}件が変わっています（追加${diff.addedCount}件・変更${diff.changedCount}件・取り消し${diff.removedCount}件）。`
      : `前回の版「${plan.baseVersionName}」から変わった選手枠はありません。新しい版を作る必要はありません。`,
  };
}

/**
 * 前回の版を複製し、変わったところだけ書き直した新しい版を作る。
 *
 * 版の名前は前回と同じ名前を引き継ぎ、`_v1.1`、`_v1.2`と自動で番号が進む。
 * 正式データへの反映（`登録データ`の入れ替え、承認済み申請の反映済み化）は
 * 「承認済みから選手名簿を作成」とまったく同じ手順で最後にまとめて行う。
 */
export function createPlayerRostersFromLatestVersion(): CreateRosterResult {
  const lock = LockService.getDocumentLock();
  if (!lock.tryLock(30_000)) {
    throw new Error('ほかの担当者が処理中です。少し待ってから、もう一度実行してください。');
  }

  let versionFolder: GoogleAppsScript.Drive.Folder | undefined;
  let stagingName = '';
  let sourceName = '';
  let jobSaved = false;
  try {
    ensureApplicationSheets();
    const activeJob = loadRosterJob();
    assertRosterJobCanStart(activeJob?.versionName);
    const actor = assertAuthorized();
    assertAcceptedSubmissionsAreValid();

    const rosterRoot = childFolder(parentFolder(), ROSTER_FOLDER_NAME);
    const createdAt = new Date().toISOString();
    const history = readRosterHistory();
    const baseInputName = history[history.length - 1]?.inputName ?? '';
    if (!baseInputName) {
      throw new Error('まだ選手名簿を1度も作成していません。最初は「承認済みから選手名簿を作成」で作成してください。');
    }
    const versionName = selectRosterVersionName(baseInputName, childFolderNames(rosterRoot));
    const plan = buildRosterDiffPlan(actor, createdAt, versionName);
    if (!plan.diff.hasChanges) {
      throw new Error(`前回の版「${plan.baseVersionName}」から変わった選手枠はありません。新しい版を作る必要はありません。`);
    }

    versionFolder = rosterRoot.createFolder(versionName);
    const jobId = Utilities.getUuid();
    const folderUrl = versionFolder.getUrl();
    stagingName = stagingSheetName('名簿登録作成中', jobId);
    sourceName = stagingSheetName('名簿申請作成中', jobId);
    writeStagingRegistrations(stagingName, plan.registrations);
    writeSourceSubmissionIds(sourceName, plan.acceptedSubmissionIds);
    const preflight = buildRosterDistributionPreflight(readSubmissions());
    const state: RosterJobState = {
      reportPlanVersion: ROSTER_REPORT_PLAN_VERSION,
      mode: 'DIFF',
      baseFolderId: plan.baseFolder.getId(),
      baseVersionName: plan.baseVersionName,
      jobId, inputName: plan.baseInputName, versionName,
      folderId: versionFolder.getId(), folderUrl,
      registrationCount: plan.registrations.length,
      sourceSubmissionCount: plan.acceptedSubmissionIds.length,
      createdBy: actor, createdAt, updatedAt: createdAt, nextReportIndex: 0,
      stagingSheetName: stagingName, sourceSheetName: sourceName, files: [], status: 'RUNNING',
      message: `「${plan.baseVersionName}」を複製し、変わった${plan.diff.totalCount}件ぶんのページだけを書き直します。クラス配布用PDFは差分にできないため作り直します。${preflight.message}`,
    };
    saveRosterJob(state);
    jobSaved = true;
    writeRosterStatus(statusFromJob(state));
    scheduleRosterContinuation();

    return {
      inputName: plan.baseInputName, versionName,
      registrationCount: plan.registrations.length,
      sourceSubmissionCount: plan.acceptedSubmissionIds.length,
      folderUrl, files: [], processing: true, message: state.message,
      baseVersionName: plan.baseVersionName, changedCount: plan.diff.totalCount,
    };
  } catch (error) {
    if (jobSaved) {
      documentProperties().deleteProperty(ROSTER_JOB_PROPERTY);
      try { clearRosterTriggers(); } catch { /* 元のエラーを優先する */ }
    }
    if (stagingName) try { deleteSheetIfPresent(stagingName); } catch { /* 元のエラーを優先する */ }
    if (sourceName) try { deleteSheetIfPresent(sourceName); } catch { /* 元のエラーを優先する */ }
    if (versionFolder) {
      try { versionFolder.setTrashed(true); } catch { /* 元のエラーを優先する */ }
    }
    throw error;
  } finally {
    lock.releaseLock();
  }
}

export function continuePlayerRosterCreation(): void {
  const lock = LockService.getDocumentLock();
  if (!lock.tryLock(30_000)) return;
  try {
    const state = loadRosterJob();
    if (!state) {
      clearRosterTriggers();
      return;
    }
    state.status = 'RUNNING';
    state.updatedAt = new Date().toISOString();
    const step = planRosterJobStep(state.nextReportIndex, REPORTS.length);
    if (step.kind === 'REPORT') {
      const report = REPORTS[step.reportIndex]!;
      state.message = `${report}選手名簿を作成しています。完了するまでほかの名簿作成を始めないでください。`;
      saveRosterJob(state);
      writeRosterStatus(statusFromJob(state));
      const folder = DriveApp.getFolderById(state.folderId);
      removeIncompleteReport(folder, state.versionName, report);
      const registrations = readStagingRegistrations(state.stagingSheetName);
      const students = readStudents();
      const formYear = readFormDesign().year;
      const events = readEventSettings().filter((event) => event.enabled && event.year === formYear);
      const correctionSubmissionIds = new Set(
        readSubmissions()
          .filter((submission) => submission.submissionType === 'CORRECTION')
          .map((submission) => submission.submissionId),
      );
      const patched = state.mode === 'DIFF' && report !== 'クラス配布用PDF'
        ? patchReportFromBaseFolder(
          report, state, folder, registrations, events, students, correctionSubmissionIds,
        )
        : undefined;
      const file = patched?.file ?? writeReport(
        report, folder, state.versionName, registrations, events, students, state.createdAt,
        correctionSubmissionIds,
      );
      state.files = [...state.files.filter((item) => item.name !== report), file];
      state.nextReportIndex += 1;
      state.updatedAt = new Date().toISOString();
      state.message = `${report}選手名簿が完了しました${describeRosterPatch(patched)}。次のファイルを自動で作成します。`;
      saveRosterJob(state);
      writeRosterStatus(statusFromJob(state));
      scheduleRosterContinuation();
      return;
    }

    const registrations = readStagingRegistrations(state.stagingSheetName);
    const sourceIds = readSourceSubmissionIds(state.sourceSheetName);
    if (!rosterHistoryHasVersion(state.versionName)) {
      const book = SpreadsheetApp.getActiveSpreadsheet();
      const backup = requireSheet(SHEETS.registrations).copyTo(book).setName(uniqueBackupName());
      backup.hideSheet();
      replaceRegistrations(registrations);
      appendRosterHistory({
        rosterVersionId: state.jobId, inputName: state.inputName, versionName: state.versionName,
        folderId: state.folderId, folderUrl: state.folderUrl, registrationCount: state.registrationCount,
        sourceSubmissionCount: state.sourceSubmissionCount, createdBy: state.createdBy, createdAt: state.createdAt,
      });
    }
    replaceSubmissions(readSubmissions().map((submission) =>
      submission.status === 'APPROVED' && sourceIds.has(submission.submissionId)
        ? { ...submission, status: 'APPLIED' as const } : submission));
    documentProperties().deleteProperty(SCRIPT_PROPERTIES.rosterRebuildRequired);
    deleteSheetIfPresent(state.stagingSheetName);
    deleteSheetIfPresent(state.sourceSheetName);
    documentProperties().deleteProperty(ROSTER_JOB_PROPERTY);
    clearRosterTriggers();
    writeRosterStatus({
      active: false, status: 'COMPLETE', versionName: state.versionName,
      progress: `${REPORTS.length}/${REPORTS.length}ファイル`, folderUrl: state.folderUrl,
      message: '3種類の名簿とクラス配布用PDFの作成、正式データへの反映が完了しました。配布前にPDFの内容を確認してください。',
      updatedAt: new Date().toISOString(),
    });
    SpreadsheetApp.getActiveSpreadsheet().toast(
      `「${state.versionName}」の名簿3種類とクラス配布用PDFが完成しました。`, '名簿作成が完了しました', 10,
    );
  } catch (error) {
    const state = loadRosterJob();
    if (state) {
      state.status = 'ERROR';
      state.updatedAt = new Date().toISOString();
      state.message = `途中で停止しました：${error instanceof Error ? error.message : String(error)}。「中断した名簿作成を再開」を実行してください。`;
      saveRosterJob(state);
      writeRosterStatus(statusFromJob(state));
    }
    clearRosterTriggers();
    throw error;
  } finally {
    lock.releaseLock();
  }
}

export function resumePlayerRosterCreation(): RosterJobStatus {
  assertAuthorized();
  const lock = LockService.getDocumentLock();
  if (!lock.tryLock(30_000)) throw new Error('名簿作成処理が動いています。少し待ってから状況を確認してください。');
  try {
    const state = loadRosterJob();
    if (!state) throw new Error('再開できる名簿作成はありません。新しい名簿を作成してください。');
    state.status = 'RUNNING';
    state.updatedAt = new Date().toISOString();
    state.message = `${Math.min(state.nextReportIndex + 1, REPORTS.length)}番目の処理から再開します。`;
    saveRosterJob(state);
    writeRosterStatus(statusFromJob(state));
    scheduleRosterContinuation();
    return statusFromJob(state);
  } finally {
    lock.releaseLock();
  }
}

export function cancelPlayerRosterCreation(): RosterJobStatus {
  assertAuthorized();
  const lock = LockService.getDocumentLock();
  if (!lock.tryLock(30_000)) throw new Error('名簿作成処理が動いています。少し待ってから取り消してください。');
  try {
    const state = loadRosterJob();
    if (!state) throw new Error('取り消す名簿作成はありません。');
    clearRosterTriggers();
    deleteSheetIfPresent(state.stagingSheetName);
    deleteSheetIfPresent(state.sourceSheetName);
    try { DriveApp.getFolderById(state.folderId).setTrashed(true); } catch { /* 状況シートは更新する */ }
    documentProperties().deleteProperty(ROSTER_JOB_PROPERTY);
    const status: RosterJobStatus = {
      active: false, status: 'CANCELLED', versionName: state.versionName,
      progress: `${state.nextReportIndex}/${REPORTS.length}ファイル`, folderUrl: '',
      message: '途中の名簿作成を取り消し、作成途中のフォルダをゴミ箱へ移動しました。正式データは変更していません。',
      updatedAt: new Date().toISOString(),
    };
    writeRosterStatus(status);
    return status;
  } finally {
    lock.releaseLock();
  }
}

export function getPlayerRosterJobStatus(): RosterJobStatus {
  assertAuthorized();
  const state = loadRosterJob();
  if (state) return statusFromJob(state);
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(ROSTER_STATUS_SHEET);
  if (!sheet || sheet.getLastRow() < 7) {
    return { active: false, status: 'NONE', versionName: '', progress: '0/4ファイル', folderUrl: '', message: '名簿作成は実行されていません。', updatedAt: '' };
  }
  const values = sheet.getRange(2, 2, 6, 1).getDisplayValues().flat();
  const statusText = values[0];
  return {
    active: false,
    status: statusText === '完了' ? 'COMPLETE' : statusText === '取り消し' ? 'CANCELLED' : 'NONE',
    versionName: values[1] ?? '', progress: values[2] ?? '', folderUrl: values[3] ?? '',
    message: values[4] ?? '', updatedAt: values[5] ?? '',
  };
}
