import {
  PUBLIC_SETTINGS_SNAPSHOT_HEADERS,
  SCRIPT_PROPERTIES,
  SETTINGS_CHANGE_HISTORY_HEADERS,
  SHEETS,
} from '../shared/constants';
import { assertAuthorized } from './auth-service';
import { readFormDesign, writeFormDesign } from './settings-repository';

const GUARDED_SHEETS = [SHEETS.eventSettings, SHEETS.ruleSettings, SHEETS.formDesign] as const;

function properties(): GoogleAppsScript.Properties.Properties {
  return PropertiesService.getDocumentProperties();
}

function ensureSheet(name: string, headers: readonly string[]): GoogleAppsScript.Spreadsheet.Sheet {
  const book = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = book.getSheetByName(name) ?? book.insertSheet(name);
  sheet.getRange(1, 1, 1, headers.length).setValues([[...headers]]).setFontWeight('bold');
  return sheet;
}

function appendHistory(action: string, reason: string, changedSheets: string): void {
  const sheet = ensureSheet(SHEETS.settingsChangeHistory, SETTINGS_CHANGE_HISTORY_HEADERS);
  sheet.appendRow([new Date().toISOString(), Session.getActiveUser().getEmail(), action, reason, changedSheets]);
}

function snapshotRows(): Array<[string, number, string]> {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEETS.publicSettingsSnapshot);
  if (!sheet || sheet.getLastRow() < 2) return [];
  return sheet.getRange(2, 1, sheet.getLastRow() - 1, 3).getDisplayValues()
    .map((row) => [row[0] ?? '', Number(row[1]), row[2] ?? '']);
}

export function capturePublishedSettingsSnapshot(): void {
  const book = SpreadsheetApp.getActiveSpreadsheet();
  const snapshot = ensureSheet(SHEETS.publicSettingsSnapshot, PUBLIC_SETTINGS_SNAPSHOT_HEADERS);
  if (snapshot.getLastRow() > 1) snapshot.getRange(2, 1, snapshot.getLastRow() - 1, 3).clearContent();
  const values: Array<[string, number, string]> = [];
  GUARDED_SHEETS.forEach((name) => {
    const source = book.getSheetByName(name);
    if (!source) return;
    source.getDataRange().getValues().forEach((row, index) => {
      values.push([name, index + 1, JSON.stringify(row)]);
    });
  });
  if (values.length > 0) snapshot.getRange(2, 1, values.length, 3).setValues(values);
  snapshot.hideSheet();
  properties().setProperty(SCRIPT_PROPERTIES.publicSettingsLocked, 'TRUE');
}

export function restorePublishedSettingsSnapshot(): void {
  const rows = snapshotRows();
  if (rows.length === 0) throw new Error('公開時の設定控えがありません。設定変更を中止できません。');
  const book = SpreadsheetApp.getActiveSpreadsheet();
  GUARDED_SHEETS.forEach((name) => {
    const sourceRows = rows.filter((row) => row[0] === name).sort((a, b) => a[1] - b[1]);
    const sheet = book.getSheetByName(name);
    if (!sheet || sourceRows.length === 0) return;
    sheet.getDataRange().clearContent();
    const values = sourceRows.map((row) => JSON.parse(row[2]) as unknown[]);
    const width = Math.max(...values.map((row) => row.length));
    sheet.getRange(1, 1, values.length, width)
      .setValues(values.map((row) => [...row, ...Array(width - row.length).fill('')]));
  });
}

export function beginPublishedSettingsChange(reason: string): void {
  assertAuthorized();
  const normalizedReason = reason.trim();
  if (!normalizedReason) throw new Error('設定を変更する理由を入力してください。');
  const design = readFormDesign();
  if (design.formStatus !== '公開中') throw new Error('公開中のフォームがないため、この操作は必要ありません。');
  capturePublishedSettingsSnapshot();
  [design.normalFormId, design.correctionFormId].filter(Boolean).forEach((id) =>
    FormApp.openById(id).setAcceptingResponses(false));
  properties().setProperties({
    [SCRIPT_PROPERTIES.publicSettingsLocked]: 'FALSE',
    [SCRIPT_PROPERTIES.settingsChangeActive]: 'TRUE',
    [SCRIPT_PROPERTIES.settingsChangeReason]: normalizedReason,
  });
  writeFormDesign({ ...design, formStatus: '受付停止' });
  appendHistory('設定変更開始・受付停止', normalizedReason, '');
}

export function auditPendingSettingsChange(): void {
  if (!isSettingsChangeActive()) return;
  const reason = properties().getProperty(SCRIPT_PROPERTIES.settingsChangeReason) ?? '';
  const book = SpreadsheetApp.getActiveSpreadsheet();
  const before = snapshotRows();
  const changed = GUARDED_SHEETS.filter((name) => {
    const oldJson = before.filter((row) => row[0] === name).map((row) => row[2]).join('\n');
    const sheet = book.getSheetByName(name);
    const newJson = sheet ? sheet.getDataRange().getValues().map((row) => JSON.stringify(row)).join('\n') : '';
    return oldJson !== newJson;
  });
  appendHistory('設定変更をフォーム下書きへ反映', reason, changed.join(', '));
}

export function completePublishedSettingsChange(): void {
  capturePublishedSettingsSnapshot();
  properties().deleteProperty(SCRIPT_PROPERTIES.settingsChangeActive);
  properties().deleteProperty(SCRIPT_PROPERTIES.settingsChangeReason);
}

export function cancelPublishedSettingsChange(): void {
  if (!isSettingsChangeActive()) return;
  const reason = properties().getProperty(SCRIPT_PROPERTIES.settingsChangeReason) ?? '';
  restorePublishedSettingsSnapshot();
  const design = readFormDesign();
  [design.normalFormId, design.correctionFormId].filter(Boolean).forEach((id) => {
    const form = FormApp.openById(id);
    (form as typeof form & { setPublished(enabled: boolean): GoogleAppsScript.Forms.Form }).setPublished(true);
    form.setAcceptingResponses(true);
  });
  properties().setProperty(SCRIPT_PROPERTIES.publicSettingsLocked, 'TRUE');
  properties().deleteProperty(SCRIPT_PROPERTIES.settingsChangeActive);
  properties().deleteProperty(SCRIPT_PROPERTIES.settingsChangeReason);
  appendHistory('設定変更取消・受付再開', reason, '');
}

export function isSettingsChangeActive(): boolean {
  return properties().getProperty(SCRIPT_PROPERTIES.settingsChangeActive) === 'TRUE';
}

export function guardPublishedSettingsEdit(
  event: GoogleAppsScript.Events.SheetsOnEdit,
): void {
  if (properties().getProperty(SCRIPT_PROPERTIES.publicSettingsLocked) !== 'TRUE') return;
  const name = event.range.getSheet().getName();
  if (!(GUARDED_SHEETS as readonly string[]).includes(name)) return;
  restorePublishedSettingsSnapshot();
  appendHistory('公開中の直接編集を自動取消', '専用操作を使わない編集', `${name}!${event.range.getA1Notation()}`);
  SpreadsheetApp.getActiveSpreadsheet().toast(
    '公開中の設定編集を取り消しました。「受付を停止して設定変更を開始」を使用してください。',
    '設定を保護しました',
    8,
  );
}
