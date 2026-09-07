import { beforeEach, describe, expect, it } from 'vitest';
import {
  cachedSheetRows,
  cachedSheetValue,
  invalidateSheetCache,
  sheetCacheSize,
} from '../../src/gas/sheet-cache';

describe('sheet-cache', () => {
  beforeEach(() => invalidateSheetCache());

  it('同じシート・同じラベルの2回目以降は読み取り関数を呼ばない', () => {
    let loads = 0;
    const load = (): string[][] => { loads += 1; return [['a', 'b'], ['c', 'd']]; };
    expect(cachedSheetRows('申請', 'values', load)).toEqual([['a', 'b'], ['c', 'd']]);
    expect(cachedSheetRows('申請', 'values', load)).toEqual([['a', 'b'], ['c', 'd']]);
    expect(loads).toBe(1);
  });

  it('ラベルが違えば別々に読む', () => {
    let loads = 0;
    const load = (): string[][] => { loads += 1; return [['x']]; };
    cachedSheetRows('申請', 'values', load);
    cachedSheetRows('申請', 'display', load);
    expect(loads).toBe(2);
  });

  it('返した行を書き換えてもメモは汚れない', () => {
    const first = cachedSheetRows('申請', 'values', () => [['a', 'b']]);
    first[0]![0] = 'changed';
    first.push(['extra']);
    expect(cachedSheetRows('申請', 'values', () => [['never']])).toEqual([['a', 'b']]);
  });

  it('シート名を指定して捨てると、そのシートだけ読み直す', () => {
    let submissionLoads = 0;
    let itemLoads = 0;
    const loadSubmissions = (): string[][] => { submissionLoads += 1; return [['s']]; };
    const loadItems = (): string[][] => { itemLoads += 1; return [['i']]; };
    cachedSheetRows('申請', 'values', loadSubmissions);
    cachedSheetRows('選手枠', 'values', loadItems);
    invalidateSheetCache('申請');
    cachedSheetRows('申請', 'values', loadSubmissions);
    cachedSheetRows('選手枠', 'values', loadItems);
    expect(submissionLoads).toBe(2);
    expect(itemLoads).toBe(1);
  });

  it('引数なしで捨てると全部読み直す', () => {
    let loads = 0;
    const load = (): string[][] => { loads += 1; return [['x']]; };
    cachedSheetRows('申請', 'values', load);
    cachedSheetRows('選手枠', 'values', load);
    expect(sheetCacheSize()).toBe(2);
    invalidateSheetCache();
    expect(sheetCacheSize()).toBe(0);
    cachedSheetRows('申請', 'values', load);
    expect(loads).toBe(3);
  });

  it('空白を含むシート名でも、ほかのシートのメモを巻き込まない', () => {
    let loads = 0;
    const load = (): string[][] => { loads += 1; return [['x']]; };
    cachedSheetRows('名簿 作成', 'values', load);
    cachedSheetRows('名簿', 'values', load);
    invalidateSheetCache('名簿');
    cachedSheetRows('名簿 作成', 'values', load);
    expect(loads).toBe(2);
  });

  it('単一の値もメモし、undefinedも「読んだ」として扱う', () => {
    let loads = 0;
    const load = (): string | undefined => { loads += 1; return undefined; };
    expect(cachedSheetValue('システム設定', 'mode', load)).toBeUndefined();
    expect(cachedSheetValue('システム設定', 'mode', load)).toBeUndefined();
    expect(loads).toBe(1);
    invalidateSheetCache('システム設定');
    expect(cachedSheetValue('システム設定', 'mode', () => 'PRODUCTION')).toBe('PRODUCTION');
  });
});
