import { SCRIPT_PROPERTIES, SHEETS, SYSTEM_CONFIG_KEYS } from '../shared/constants';
import { resolveSystemMode, type SystemMode } from '../core/system-mode';

/**
 * 運用モードの読み取りだけを切り出したモジュール。
 * `repository.ts`と`auth-service.ts`の両方が必要とするため、ここへ置いて相互参照を避ける。
 * 書き込み（`writeSystemMode`）は`auth-service.ts`に残す。
 */
export function systemConfigRows(): string[][] {
  const spreadsheet = SpreadsheetApp.getActiveSpreadsheet();
  const local = spreadsheet?.getSheetByName(SHEETS.systemConfig);
  if (!local || local.getLastRow() < 2) return [];
  return local.getRange(2, 1, local.getLastRow() - 1, 2).getDisplayValues()
    .map((row) => [row[0] ?? '', row[1] ?? '']);
}

export function systemConfigValue(key: string): string {
  return systemConfigRows().find((row) => row[0] === key)?.[1] ?? '';
}

export function getSystemMode(): SystemMode {
  return resolveSystemMode(
    systemConfigValue(SYSTEM_CONFIG_KEYS.mode),
    PropertiesService.getScriptProperties().getProperty(SCRIPT_PROPERTIES.systemMode) ?? undefined,
  );
}

export function isProductionMode(): boolean {
  return getSystemMode() === 'PRODUCTION';
}

export function isPracticeWorkbook(): boolean {
  return systemConfigValue(SYSTEM_CONFIG_KEYS.mode) === 'PRACTICE';
}
