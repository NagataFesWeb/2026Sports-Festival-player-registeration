import {
  FORM_DESIGN_HEADERS,
  SHEETS,
  SYSTEM_CONFIG_HEADERS,
  SYSTEM_CONFIG_KEYS,
} from '../shared/constants';
import { assertAuthorized, isProductionMode } from './auth-service';

export interface PracticeCopyResult {
  spreadsheetId: string;
  spreadsheetUrl: string;
  name: string;
  message: string;
}

const CLEARED_SHEETS = [
  SHEETS.dashboard,
  SHEETS.submissions,
  SHEETS.items,
  SHEETS.issues,
  SHEETS.productionStudents,
  SHEETS.students,
  SHEETS.registrations,
  SHEETS.rosterHistory,
  SHEETS.mockDataSettings,
  SHEETS.approvals,
  SHEETS.changeHistory,
  SHEETS.settingsIssues,
  SHEETS.formRegistry,
  SHEETS.rawFormResponses,
  SHEETS.liveFormTest,
] as const;

const FORM_REFERENCE_KEYS = new Set([
  'フォーム状態',
  '通常フォームID',
  '修正フォームID',
  '通常フォーム編集URL',
  '修正フォーム編集URL',
  'フォーム保存フォルダID',
  'フォーム保存フォルダURL',
]);

function clearDataRows(sheet: GoogleAppsScript.Spreadsheet.Sheet): void {
  if (sheet.getLastRow() < 2) return;
  sheet.getRange(2, 1, sheet.getLastRow() - 1, Math.max(1, sheet.getLastColumn())).clearContent();
}

function detachProductionFormReferences(book: GoogleAppsScript.Spreadsheet.Spreadsheet): void {
  const sheet = book.getSheetByName(SHEETS.formDesign);
  if (!sheet) return;
  if (sheet.getLastRow() < 2) {
    sheet.getRange(1, 1, 1, FORM_DESIGN_HEADERS.length).setValues([[...FORM_DESIGN_HEADERS]]);
    return;
  }
  const values = sheet.getRange(2, 1, sheet.getLastRow() - 1, 2).getValues();
  values.forEach((row) => {
    const key = String(row[0] ?? '');
    if (!FORM_REFERENCE_KEYS.has(key)) return;
    row[1] = key === 'フォーム状態' ? '未作成' : '';
  });
  sheet.getRange(2, 1, values.length, 2).setValues(values);
}

function setPracticeMarker(
  book: GoogleAppsScript.Spreadsheet.Spreadsheet,
  rootFolderId: string,
): void {
  const sheet = book.getSheetByName(SHEETS.systemConfig) ?? book.insertSheet(SHEETS.systemConfig);
  sheet.clearContents();
  sheet.getRange(1, 1, 1, SYSTEM_CONFIG_HEADERS.length).setValues([[...SYSTEM_CONFIG_HEADERS]]);
  sheet.getRange(2, 1, 2, 2).setValues([
    [SYSTEM_CONFIG_KEYS.mode, 'PRACTICE'],
    [SYSTEM_CONFIG_KEYS.practiceRootFolderId, rootFolderId],
  ]);
  sheet.hideSheet();
}

function relaxCopiedProtections(book: GoogleAppsScript.Spreadsheet.Spreadsheet): void {
  book.getSheets().forEach((sheet) => {
    sheet.getProtections(SpreadsheetApp.ProtectionType.SHEET)
      .forEach((protection) => protection.setWarningOnly(true));
    sheet.getProtections(SpreadsheetApp.ProtectionType.RANGE)
      .forEach((protection) => protection.setWarningOnly(true));
  });
}

export function createPracticeWorkbookCopy(): PracticeCopyResult {
  assertAuthorized();
  if (!isProductionMode()) {
    throw new Error('練習用コピーは本番ファイルから作成してください。現在のファイルは本番モードではありません。');
  }
  const sourceBook = SpreadsheetApp.getActiveSpreadsheet();
  const sourceFile = DriveApp.getFileById(sourceBook.getId());
  const timestamp = Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyyMMdd_HHmmss');
  const name = `${sourceBook.getName()}_練習用_${timestamp}`;
  const parents = sourceFile.getParents();
  const rootFolder = parents.hasNext()
    ? parents.next().createFolder(`${name}_専用`)
    : DriveApp.createFolder(`${name}_専用`);
  const stagingFile = sourceFile.makeCopy(`${name}_作成中`, rootFolder);
  let copiedFile: GoogleAppsScript.Drive.File | undefined;
  try {
    const stagingBook = SpreadsheetApp.openById(stagingFile.getId());
    CLEARED_SHEETS.forEach((sheetName) => {
      const sheet = stagingBook.getSheetByName(sheetName);
      if (sheet) clearDataRows(sheet);
    });
    detachProductionFormReferences(stagingBook);
    setPracticeMarker(stagingBook, rootFolder.getId());
    relaxCopiedProtections(stagingBook);
    SpreadsheetApp.flush();
    // Sanitized stateからもう一度コピーし、実データを含む最初の版を練習ファイルへ残さない。
    copiedFile = stagingFile.makeCopy(name, rootFolder);
    stagingFile.setTrashed(true);
    const copyBook = SpreadsheetApp.openById(copiedFile.getId());
    return {
      spreadsheetId: copyBook.getId(),
      spreadsheetUrl: copyBook.getUrl(),
      name,
      message: '練習用コピーを作成しました。本番フォームID・実回答・登録データ・履歴・生徒マスターはコピーから切り離されています。',
    };
  } catch (error) {
    if (copiedFile) {
      try { copiedFile.setTrashed(true); } catch { /* 元のエラーを優先する。 */ }
    }
    try { stagingFile.setTrashed(true); } catch { /* 元のエラーを優先する。 */ }
    try { rootFolder.setTrashed(true); } catch { /* 元のエラーを優先する。 */ }
    throw error;
  }
}
