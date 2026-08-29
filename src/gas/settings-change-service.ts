import {
  PUBLIC_SETTINGS_SNAPSHOT_HEADERS,
  SCRIPT_PROPERTIES,
  SETTINGS_CHANGE_HISTORY_HEADERS,
  SHEETS,
} from '../shared/constants';
import { assertAuthorized } from './auth-service';
import { readFormDesign, syncRuleEventCheckboxes, writeFormDesign } from './settings-repository';

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

/** 運用モードの切替など、設定シート以外の重要操作も同じ履歴へ残す。 */
export function appendSettingsChangeHistory(
  action: string,
  reason: string,
  changedSheets: string,
): void {
  appendHistory(action, reason, changedSheets);
}

function snapshotRows(): Array<[string, number, string]> {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEETS.publicSettingsSnapshot);
  if (!sheet || sheet.getLastRow() < 2) return [];
  return sheet.getRange(2, 1, sheet.getLastRow() - 1, 3).getDisplayValues()
    .map((row) => [row[0] ?? '', Number(row[1]), row[2] ?? '']);
}

/** Saves the current contents of the guarded sheets without changing the lock. */
function writeSettingsSnapshot(): void {
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
}

export function capturePublishedSettingsSnapshot(): void {
  writeSettingsSnapshot();
  properties().setProperty(SCRIPT_PROPERTIES.publicSettingsLocked, 'TRUE');
}

const PUBLISHED_STATUSES = ['公開中', '公開前確認'];

/**
 * Reports whether the settings sheets are currently protected. The lock flag
 * only means something while a form is published; if the flag survived after
 * the forms went back to 未作成 or 受付停止, the settings would stay frozen with
 * no way to release them, so a stale flag is cleared here.
 */
export function isSettingsProtected(): boolean {
  if (properties().getProperty(SCRIPT_PROPERTIES.publicSettingsLocked) !== 'TRUE') return false;
  if (PUBLISHED_STATUSES.includes(readFormDesign().formStatus)) return true;
  properties().setProperty(SCRIPT_PROPERTIES.publicSettingsLocked, 'FALSE');
  return false;
}

/**
 * Restores the guarded settings sheets from the snapshot taken when the forms
 * were published. Pass a sheet name to restore only that sheet, so an edit to
 * one guarded sheet never discards work in progress on another.
 */
export function restorePublishedSettingsSnapshot(targetSheetName?: string): void {
  const rows = snapshotRows();
  if (rows.length === 0) throw new Error('公開時の設定控えがありません。設定変更を中止できません。');
  const book = SpreadsheetApp.getActiveSpreadsheet();
  const targets = targetSheetName
    ? GUARDED_SHEETS.filter((name) => name === targetSheetName)
    : GUARDED_SHEETS;
  targets.forEach((name) => {
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
  if (isRuleOnlyChangeActive()) {
    throw new Error('ルール設定の変更中です。先に「ルール変更を確定して全申請を再検査」または「ルール変更を取り消す」を実行してください。');
  }
  const design = readFormDesign();
  if (design.formStatus !== '公開中') {
    throw new Error(
      `公開中のフォームがないため、受付を停止する必要はありません。現在のフォーム状態は「${design.formStatus}」です。`
      + '設定シートはそのまま編集できます。編集後は「設定を点検」→「フォーム下書きを作成」の順に進めてください。'
      + 'ルールだけを直す場合は「ルール設定だけを変更する」を使うと、確定時に受信済みの申請をまとめて再検査できます。',
    );
  }
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

/** Returns the guarded sheets whose contents differ from the published snapshot. */
function changedGuardedSheets(): string[] {
  const book = SpreadsheetApp.getActiveSpreadsheet();
  const before = snapshotRows();
  return GUARDED_SHEETS.filter((name) => {
    const oldJson = before.filter((row) => row[0] === name).map((row) => row[2]).join('\n');
    const sheet = book.getSheetByName(name);
    const newJson = sheet ? sheet.getDataRange().getValues().map((row) => JSON.stringify(row)).join('\n') : '';
    return oldJson !== newJson;
  });
}

export function auditPendingSettingsChange(): void {
  if (!isSettingsChangeActive()) return;
  const reason = properties().getProperty(SCRIPT_PROPERTIES.settingsChangeReason) ?? '';
  appendHistory('設定変更をフォーム下書きへ反映', reason, changedGuardedSheets().join(', '));
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

export function isRuleOnlyChangeActive(): boolean {
  return properties().getProperty(SCRIPT_PROPERTIES.ruleChangeActive) === 'TRUE';
}

/**
 * Unlocks `ルール設定` alone while the forms stay published and keep accepting
 * responses. Rules are only used when a submission is checked, never when a
 * form is built, so they can change without rebuilding or replacing the forms.
 */
export function beginRuleOnlyChange(reason: string): void {
  assertAuthorized();
  const normalizedReason = reason.trim();
  if (!normalizedReason) throw new Error('ルールを変更する理由を入力してください。');
  if (isRuleOnlyChangeActive()) throw new Error('すでにルール設定の変更中です。編集後に「ルール変更を確定して全申請を再検査」を実行してください。');
  if (isSettingsChangeActive()) {
    throw new Error('競技設定・フォーム設計の変更中です。フォームの公開または破棄を終えてから実行してください。');
  }
  // 対象競技のチェックボックス列は「ルール設定を開く」で作り直される。控えを取る前に
  // ここで同期しておかないと、担当者が何も直していなくても差分として記録される。
  syncRuleEventCheckboxes();
  // 公開中かどうかに関わらず控えを取り、取り消し操作で戻せるようにする。保護されて
  // いない状態を、この操作で保護中へ変えてしまわないよう、ロックには触れない。
  writeSettingsSnapshot();
  properties().setProperties({
    [SCRIPT_PROPERTIES.ruleChangeActive]: 'TRUE',
    [SCRIPT_PROPERTIES.ruleChangeReason]: normalizedReason,
  });
  appendHistory('ルール設定の変更開始・受付継続', normalizedReason, SHEETS.ruleSettings);
}

/** Re-locks the settings sheets with the edited rules as the new baseline. */
export function completeRuleOnlyChange(): { ruleSettingsChanged: boolean } {
  if (!isRuleOnlyChangeActive()) {
    throw new Error('ルール設定の変更は始まっていません。先に「ルール設定だけを変更する」を実行してください。');
  }
  const reason = properties().getProperty(SCRIPT_PROPERTIES.ruleChangeReason) ?? '';
  const changed = changedGuardedSheets();
  if (isSettingsProtected()) capturePublishedSettingsSnapshot();
  else writeSettingsSnapshot();
  properties().deleteProperty(SCRIPT_PROPERTIES.ruleChangeActive);
  properties().deleteProperty(SCRIPT_PROPERTIES.ruleChangeReason);
  appendHistory('ルール設定の変更を確定', reason, changed.join(', '));
  return { ruleSettingsChanged: changed.includes(SHEETS.ruleSettings) };
}

/** Puts `ルール設定` back to the contents held when the change started. */
export function cancelRuleOnlyChange(): void {
  assertAuthorized();
  if (!isRuleOnlyChangeActive()) {
    throw new Error('取り消せるルール設定の変更はありません。');
  }
  const reason = properties().getProperty(SCRIPT_PROPERTIES.ruleChangeReason) ?? '';
  restorePublishedSettingsSnapshot(SHEETS.ruleSettings);
  properties().deleteProperty(SCRIPT_PROPERTIES.ruleChangeActive);
  properties().deleteProperty(SCRIPT_PROPERTIES.ruleChangeReason);
  appendHistory('ルール設定の変更を取消', reason, SHEETS.ruleSettings);
}

export function guardPublishedSettingsEdit(
  event: GoogleAppsScript.Events.SheetsOnEdit,
): void {
  if (properties().getProperty(SCRIPT_PROPERTIES.publicSettingsLocked) !== 'TRUE') return;
  const name = event.range.getSheet().getName();
  if (!(GUARDED_SHEETS as readonly string[]).includes(name)) return;
  if (!isSettingsProtected()) return;
  if (name === SHEETS.ruleSettings && isRuleOnlyChangeActive()) return;
  restorePublishedSettingsSnapshot(name);
  appendHistory('公開中の直接編集を自動取消', '専用操作を使わない編集', `${name}!${event.range.getA1Notation()}`);
  SpreadsheetApp.getActiveSpreadsheet().toast(
    '公開中の設定編集を取り消しました。「受付を停止して設定変更を開始」を使用してください。',
    '設定を保護しました',
    8,
  );
}
