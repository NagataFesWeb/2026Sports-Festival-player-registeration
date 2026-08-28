import {
  SCRIPT_PROPERTIES,
  SHEETS,
  SYSTEM_CONFIG_HEADERS,
  SYSTEM_CONFIG_KEYS,
} from '../shared/constants';
import { isProductionStudentMasterActive, readStudents } from './repository';
import { auditManagementSharing } from './security-audit-service';

export type SystemMode = 'DEVELOPMENT' | 'PRODUCTION';

function configuredEditors(): string[] {
  return (PropertiesService.getScriptProperties()
    .getProperty(SCRIPT_PROPERTIES.authorizedEditorEmails) ?? '')
    .split(/[\s,;]+/)
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean);
}

function currentEmail(): string {
  return (Session.getActiveUser().getEmail() || Session.getEffectiveUser().getEmail())
    .trim().toLowerCase();
}

export function getSystemMode(): SystemMode {
  const spreadsheet = SpreadsheetApp.getActiveSpreadsheet();
  const local = spreadsheet?.getSheetByName(SHEETS.systemConfig);
  if (local && local.getLastRow() >= 2) {
    const values = local.getRange(2, 1, local.getLastRow() - 1, 2).getDisplayValues();
    const mode = values.find((row) => row[0] === SYSTEM_CONFIG_KEYS.mode)?.[1];
    if (mode === 'PRACTICE') return 'DEVELOPMENT';
    if (mode === 'PRODUCTION') return 'PRODUCTION';
  }
  const configured = PropertiesService.getScriptProperties()
    .getProperty(SCRIPT_PROPERTIES.systemMode);
  if (configured === 'PRODUCTION') return 'PRODUCTION';
  return 'DEVELOPMENT';
}

export function isPracticeWorkbook(): boolean {
  const spreadsheet = SpreadsheetApp.getActiveSpreadsheet();
  const local = spreadsheet?.getSheetByName(SHEETS.systemConfig);
  if (!local || local.getLastRow() < 2) return false;
  return local.getRange(2, 1, local.getLastRow() - 1, 2).getDisplayValues()
    .some((row) => row[0] === SYSTEM_CONFIG_KEYS.mode && row[1] === 'PRACTICE');
}

export function getPracticeRootFolderId(): string {
  if (!isPracticeWorkbook()) return '';
  const spreadsheet = SpreadsheetApp.getActiveSpreadsheet();
  const local = spreadsheet.getSheetByName(SHEETS.systemConfig);
  if (!local || local.getLastRow() < 2) return '';
  return local.getRange(2, 1, local.getLastRow() - 1, 2).getDisplayValues()
    .find((row) => row[0] === SYSTEM_CONFIG_KEYS.practiceRootFolderId)?.[1] ?? '';
}

export function isProductionMode(): boolean {
  return getSystemMode() === 'PRODUCTION';
}

export function getAuthorizedEditorEmails(): string[] {
  assertAuthorized();
  return configuredEditors();
}

export function updateAuthorizedEditorEmails(raw: string): string[] {
  const actor = assertAuthorized();
  const emails = [...new Set(raw.split(/[\s,;]+/)
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean))];
  if (emails.length === 0) {
    throw new Error('担当者のGoogleアカウントを1件以上入力してください。');
  }
  const invalid = emails.filter((email) => !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email));
  if (invalid.length > 0) {
    throw new Error(`Googleアカウントのメールアドレスを確認してください：${invalid.join('、')}`);
  }
  if (isProductionMode() && actor !== '現在の編集者' && !emails.includes(actor)) {
    throw new Error('操作中の自分のGoogleアカウントは担当者一覧から外せません。引継ぎ先を追加した後も自分を残してください。');
  }
  PropertiesService.getScriptProperties()
    .setProperty(SCRIPT_PROPERTIES.authorizedEditorEmails, emails.join(','));
  return emails;
}

export function assertAuthorized(): string {
  const email = currentEmail();
  const properties = PropertiesService.getScriptProperties();
  const allowedDomain = properties.getProperty('ALLOWED_DOMAIN')?.trim().toLowerCase();
  const authorizedEditors = configuredEditors();
  if (!email && (allowedDomain || authorizedEditors.length > 0 || isProductionMode())) {
    throw new Error('操作するGoogleアカウントを確認できません。許可されたアカウントでログインし直してください。');
  }
  if (!email) return '現在の編集者';
  if (authorizedEditors.length > 0 && !authorizedEditors.includes(email)) {
    throw new Error('このGoogleアカウントは担当者一覧に登録されていません。管理者へ確認してください。');
  }
  if (allowedDomain) {
    const normalizedDomain = allowedDomain.replace(/^@/, '');
    const actualDomain = email.split('@')[1] ?? '';
    if (actualDomain !== normalizedDomain) {
      throw new Error('このGoogleアカウントには操作権限がありません。許可されたアカウントに切り替えてください。');
    }
  }
  if (isProductionMode() && authorizedEditors.length === 0) {
    throw new Error('本番モードの担当者が設定されていません。管理者がAUTHORIZED_EDITOR_EMAILSを設定してください。');
  }
  return email;
}

export function assertDevelopmentMode(): void {
  if (isProductionMode() || isProductionStudentMasterActive()) {
    throw new Error('本番運用中は疑似データ機能を使用できません。実在データを守るため処理を中止しました。');
  }
}

export function activateProductionMode(): { mode: 'PRODUCTION'; actorEmail: string; message: string } {
  if (isPracticeWorkbook()) {
    throw new Error('練習用コピーを本番モードへ切り替えることはできません。本番ファイルを開いて操作してください。');
  }
  if (!isProductionStudentMasterActive()) {
    throw new Error('本番用の「生徒マスター」が空です。学籍番号と氏名を入力し、内容を確認してから切り替えてください。');
  }
  // 入力不足・学籍番号不正・重複を本番切替前に必ず検出する。
  readStudents();
  const sharing = auditManagementSharing();
  if (sharing.broadSharingCount > 0) throw new Error(sharing.message);
  const properties = PropertiesService.getScriptProperties();
  let editors = configuredEditors();
  const email = currentEmail();
  if (editors.length === 0) {
    if (!email) throw new Error('担当者のGoogleアカウントを確認できないため、本番モードへ切り替えられません。');
    properties.setProperty(SCRIPT_PROPERTIES.authorizedEditorEmails, email);
    editors = [email];
  }
  if (!email || !editors.includes(email)) {
    throw new Error('現在のGoogleアカウントが担当者一覧にありません。本番切替は登録済み担当者が実行してください。');
  }
  properties.setProperty(SCRIPT_PROPERTIES.systemMode, 'PRODUCTION');
  const spreadsheet = SpreadsheetApp.getActiveSpreadsheet();
  const local = spreadsheet.getSheetByName(SHEETS.systemConfig)
    ?? spreadsheet.insertSheet(SHEETS.systemConfig);
  local.getRange(1, 1, 1, SYSTEM_CONFIG_HEADERS.length).setValues([[...SYSTEM_CONFIG_HEADERS]]);
  local.getRange(2, 1, 1, 2).setValues([[SYSTEM_CONFIG_KEYS.mode, 'PRODUCTION']]);
  local.hideSheet();
  return {
    mode: 'PRODUCTION',
    actorEmail: email,
    message: '本番モードへ切り替えました。疑似データの作成・追加・削除は無効になりました。',
  };
}
