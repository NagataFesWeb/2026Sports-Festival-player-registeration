import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  EVENT_SETTING_HEADERS,
  FORM_DESIGN_HEADERS,
  RULE_SETTING_HEADERS,
  SCRIPT_PROPERTIES,
  SHEETS,
  SYSTEM_CONFIG_HEADERS,
  SYSTEM_CONFIG_KEYS,
} from '../../src/shared/constants';
import { invalidateSheetCache } from '../../src/gas/sheet-cache';
import {
  getSettingsSheet,
  readEventSettings,
  readFormDesign,
  readRuleSettings,
  writeFormDesign,
} from '../../src/gas/settings-repository';
import { getSystemMode, invalidateSystemModeCache } from '../../src/gas/mode-probe';
import { writeSystemMode } from '../../src/gas/auth-service';
import { FakeSpreadsheet, fakeSpreadsheetApp, type FakeSheet } from './fakeSpreadsheet';

/**
 * 設定シートの読み取りメモと、ルール設定の対象競技列そろえが実行内で1回だけ走ることを確かめる。
 * 値はすべて架空。
 */
let book: FakeSpreadsheet;
let eventSheet: FakeSheet;
let ruleSheet: FakeSheet;
let designSheet: FakeSheet;
let scriptProperties: Map<string, string>;
let propertyReads: number;

beforeEach(() => {
  invalidateSheetCache();
  book = new FakeSpreadsheet();
  eventSheet = book.addSheet(SHEETS.eventSettings, [
    [...EVENT_SETTING_HEADERS],
    [2026, 'E001', true, '全学年', '100m走', '男子', 2, true, false, 10, 10, ''],
    [2026, 'E002', true, '全学年', '100m走', '女子', 2, true, false, 20, 20, ''],
  ]);
  ruleSheet = book.addSheet(SHEETS.ruleSettings, [
    [...RULE_SETTING_HEADERS],
    ['R001', true, '重複禁止', '全競技', '', '', '', 'エラー', '重複', '', 'MAX_PER_EVENT <= 1'],
  ]);
  designSheet = book.addSheet(SHEETS.formDesign, [
    [...FORM_DESIGN_HEADERS],
    ['年度', 2026],
    ['通常フォームタイトル', '選手登録'],
    ['フォーム状態', '未作成'],
  ]);
  book.addSheet(SHEETS.systemConfig, [
    [...SYSTEM_CONFIG_HEADERS],
    [SYSTEM_CONFIG_KEYS.mode, 'DEVELOPMENT'],
  ]);
  scriptProperties = new Map();
  propertyReads = 0;
  vi.stubGlobal('SpreadsheetApp', fakeSpreadsheetApp(book));
  vi.stubGlobal('PropertiesService', {
    getScriptProperties: (): Record<string, unknown> => ({
      getProperty: (key: string): string | null => { propertyReads += 1; return scriptProperties.get(key) ?? null; },
      setProperty: (key: string, value: string): void => { scriptProperties.set(key, value); },
      deleteProperty: (key: string): void => { scriptProperties.delete(key); },
    }),
  });
});

describe('設定シートの実行内メモ', () => {
  it('競技設定を2回読んでも、シートは1回しか読まない', () => {
    expect(readEventSettings()).toHaveLength(2);
    readEventSettings();
    expect(eventSheet.reads.values).toBe(1);
  });

  it('ルール設定の対象競技列そろえは、同じ実行内では1回だけ書き込む', () => {
    const first = readRuleSettings();
    const writesAfterFirst = ruleSheet.writes;
    expect(writesAfterFirst).toBeGreaterThan(0);
    expect(first).toHaveLength(1);
    expect(first[0]?.targetEventIds).toBe('E001,E002');
    readRuleSettings();
    readRuleSettings();
    expect(ruleSheet.writes).toBe(writesAfterFirst);
    // 対象競技列が追加されたヘッダーになっている
    expect(ruleSheet.cell(1, RULE_SETTING_HEADERS.length + 1)).toContain('E001');
  });

  it('フォーム設計を書き換えると、ルール設定の列そろえをもう一度行う', () => {
    readRuleSettings();
    const writesAfterFirst = ruleSheet.writes;
    writeFormDesign({ ...readFormDesign(), year: 2027 });
    expect(readFormDesign().year).toBe(2027);
    readRuleSettings();
    expect(ruleSheet.writes).toBeGreaterThan(writesAfterFirst);
  });

  it('writeFormDesign の後は新しい値を読み、その後はまたメモから返す', () => {
    expect(readFormDesign().normalTitle).toBe('選手登録');
    writeFormDesign({ ...readFormDesign(), normalTitle: '新しいタイトル' });
    expect(readFormDesign().normalTitle).toBe('新しいタイトル');
    const readsAfterWrite = designSheet.reads.values;
    readFormDesign();
    readFormDesign();
    expect(designSheet.reads.values).toBe(readsAfterWrite);
  });

  it('getSettingsSheet でシートを外へ渡すと、そのシートを読み直す', () => {
    readEventSettings();
    getSettingsSheet(SHEETS.eventSettings).getRange(2, 5).setValue('200m走');
    expect(readEventSettings()[0]?.eventName).toBe('200m走');
  });
});

describe('運用モードの実行内メモ', () => {
  it('同じ実行内で何度読んでも、シートとScript Propertiesは1回しか読まない', () => {
    expect(getSystemMode()).toBe('DEVELOPMENT');
    getSystemMode();
    getSystemMode();
    expect(book.getSheetByName(SHEETS.systemConfig)!.reads.display).toBe(1);
    expect(propertyReads).toBe(1);
  });

  it('writeSystemMode の後は新しいモードを返す', () => {
    expect(getSystemMode()).toBe('DEVELOPMENT');
    writeSystemMode('PRODUCTION');
    expect(getSystemMode()).toBe('PRODUCTION');
    writeSystemMode('DEVELOPMENT');
    expect(getSystemMode()).toBe('DEVELOPMENT');
  });

  it('invalidateSystemModeCache で読み直す', () => {
    getSystemMode();
    // 正本はシート。直接書き換えた場合、メモを捨てるまでは古い値が返る。
    book.getSheetByName(SHEETS.systemConfig)!.getRange(2, 2).setValue('PRODUCTION');
    expect(getSystemMode()).toBe('DEVELOPMENT');
    invalidateSystemModeCache();
    expect(getSystemMode()).toBe('PRODUCTION');
  });

  it('シートにモードが無いときは Script Properties を見る', () => {
    book.getSheetByName(SHEETS.systemConfig)!.getRange(2, 1, 1, 2).clearContent();
    scriptProperties.set(SCRIPT_PROPERTIES.systemMode, 'PRODUCTION');
    expect(getSystemMode()).toBe('PRODUCTION');
  });
});
