import {
  SCRIPT_PROPERTIES,
  SHEETS,
  SYSTEM_CONFIG_HEADERS,
  SYSTEM_CONFIG_KEYS,
} from '../shared/constants';
import {
  upsertSystemConfigRows,
  type SystemMode,
} from '../core/system-mode';
import {
  getSystemMode,
  invalidateSystemModeCache,
  isPracticeWorkbook,
  isProductionMode,
  systemConfigRows,
  systemConfigValue,
} from './mode-probe';

export type { SystemMode };
export { getSystemMode, isPracticeWorkbook, isProductionMode };

export function listConfiguredEditorEmails(): string[] {
  return (PropertiesService.getScriptProperties()
    .getProperty(SCRIPT_PROPERTIES.authorizedEditorEmails) ?? '')
    .split(/[\s,;]+/)
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean);
}

export function currentEditorEmail(): string {
  return (Session.getActiveUser().getEmail() || Session.getEffectiveUser().getEmail())
    .trim().toLowerCase();
}

/** 運用モードの正本は`システム設定`シート。Script Propertyは互換のため同じ値へそろえる。 */
export function writeSystemMode(mode: SystemMode): void {
  const spreadsheet = SpreadsheetApp.getActiveSpreadsheet();
  const local = spreadsheet.getSheetByName(SHEETS.systemConfig)
    ?? spreadsheet.insertSheet(SHEETS.systemConfig);
  const rows = upsertSystemConfigRows(systemConfigRows(), SYSTEM_CONFIG_KEYS.mode, mode);
  try {
    local.getRange(1, 1, 1, SYSTEM_CONFIG_HEADERS.length).setValues([[...SYSTEM_CONFIG_HEADERS]]);
    local.getRange(2, 1, rows.length, 2).setValues(rows);
    local.hideSheet();
    const properties = PropertiesService.getScriptProperties();
    if (mode === 'PRODUCTION') {
      properties.setProperty(SCRIPT_PROPERTIES.systemMode, 'PRODUCTION');
      return;
    }
    properties.deleteProperty(SCRIPT_PROPERTIES.systemMode);
  } finally {
    // 途中で失敗しても、古いモードのメモを使わない。
    invalidateSystemModeCache();
  }
}

export function getPracticeRootFolderId(): string {
  if (!isPracticeWorkbook()) return '';
  return systemConfigValue(SYSTEM_CONFIG_KEYS.practiceRootFolderId);
}

export function getAuthorizedEditorEmails(): string[] {
  assertAuthorized();
  return listConfiguredEditorEmails();
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
  const email = currentEditorEmail();
  const properties = PropertiesService.getScriptProperties();
  const allowedDomain = properties.getProperty('ALLOWED_DOMAIN')?.trim().toLowerCase();
  const authorizedEditors = listConfiguredEditorEmails();
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

/** 内部コード`MOCK_DATA_BLOCKED_IN_PRODUCTION`に対応する表示文言。 */
const MOCK_DATA_BLOCKED_IN_PRODUCTION_MESSAGE =
  '本番モードでは疑似データ機能を使用できません。'
  + '練習する場合は、メニューの「練習用コピーを作成」で作ったコピーを開いてください。';

/**
 * 疑似データ機能の入口ガード。
 * 判定は運用モードだけで行う。生徒マスターに入力があっても、開発モードなら疑似データを作れる。
 * どちらの名簿を使うかは`疑似データ設定`シートの`疑似申請に使う名簿`で選ぶ。
 */
export function assertDevelopmentMode(): void {
  if (isProductionMode()) {
    throw new Error(MOCK_DATA_BLOCKED_IN_PRODUCTION_MESSAGE);
  }
}
