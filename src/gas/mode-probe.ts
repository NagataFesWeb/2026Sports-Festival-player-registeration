import { SCRIPT_PROPERTIES, SHEETS, SYSTEM_CONFIG_KEYS } from '../shared/constants';
import { resolveSystemMode, type SystemMode } from '../core/system-mode';
import { cachedSheetRows, cachedSheetValue, invalidateSheetCache } from './sheet-cache';

/** Script Propertiesの読み取りメモに使う名前。実在のシート名と衝突しない。 */
const SCRIPT_PROPERTY_CACHE_NAME = '@script-properties';

/**
 * 運用モードの読み取りだけを切り出したモジュール。
 * `repository.ts`と`auth-service.ts`の両方が必要とするため、ここへ置いて相互参照を避ける。
 * 書き込み（`writeSystemMode`）は`auth-service.ts`に残す。
 */
export function systemConfigRows(): string[][] {
  return cachedSheetRows(SHEETS.systemConfig, 'display:2', () => {
    const spreadsheet = SpreadsheetApp.getActiveSpreadsheet();
    const local = spreadsheet?.getSheetByName(SHEETS.systemConfig);
    if (!local || local.getLastRow() < 2) return [];
    return local.getRange(2, 1, local.getLastRow() - 1, 2).getDisplayValues();
  }).map((row) => [row[0] ?? '', row[1] ?? '']);
}

/** 運用モードを書き換えた直後に呼ぶ。シートとScript Propertiesの両方のメモを捨てる。 */
export function invalidateSystemModeCache(): void {
  invalidateSheetCache(SHEETS.systemConfig, SCRIPT_PROPERTY_CACHE_NAME);
}

export function systemConfigValue(key: string): string {
  return systemConfigRows().find((row) => row[0] === key)?.[1] ?? '';
}

export function getSystemMode(): SystemMode {
  return resolveSystemMode(
    systemConfigValue(SYSTEM_CONFIG_KEYS.mode),
    cachedSheetValue(SCRIPT_PROPERTY_CACHE_NAME, SCRIPT_PROPERTIES.systemMode, () =>
      PropertiesService.getScriptProperties().getProperty(SCRIPT_PROPERTIES.systemMode) ?? undefined),
  );
}

export function isProductionMode(): boolean {
  return getSystemMode() === 'PRODUCTION';
}

export function isPracticeWorkbook(): boolean {
  return systemConfigValue(SYSTEM_CONFIG_KEYS.mode) === 'PRACTICE';
}
