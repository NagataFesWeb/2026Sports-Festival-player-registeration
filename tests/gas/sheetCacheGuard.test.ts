import { readFileSync, readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * 実行内メモ（sheet-cache）の規約をソースの形で守らせる検査。
 *
 * 1. リポジトリ2本の中で、シートへ書く関数は必ず同じ関数の中でメモを捨てる。
 * 2. ドキュメントロックを取った直後は必ずメモを全部捨てる。
 * 3. リポジトリ以外のモジュールがメモ対象のシートへ直接書くなら、sheet-cacheを使って捨てるか、
 *    理由付きで除外一覧へ載せる。
 */
const gasDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '../../src/gas');
const REPOSITORY_FILES = ['repository.ts', 'settings-repository.ts'];
const CACHE_FILE = 'sheet-cache.ts';

/** メモ化されている`SHEETS`のキー。新しく読み取りをメモ化したらここへ足す。 */
const MEMOIZED_SHEET_KEYS = [
  'submissions', 'items', 'issues', 'productionStudents', 'students', 'registrations',
  'rosterHistory', 'mockDataSettings', 'approvals', 'changeHistory', 'rawFormResponses',
  'systemConfig', 'eventSettings', 'ruleSettings', 'formDesign', 'formRegistry', 'settingsIssues',
];

/** メモ対象シートへ書くが、sheet-cacheを直接は使わないモジュールと、その理由。 */
const DIRECT_WRITER_EXCEPTIONS: Record<string, string> = {
  'auth-service.ts': '運用モードの書き込み後はmode-probeのinvalidateSystemModeCacheで捨てている。',
  'practice-copy-service.ts': '書き込む相手は練習用コピー（別のスプレッドシート）で、開いているブックのメモには関係しない。',
};

const WRITE_CALL = /\.(setValues|setValue|clearContent|clearContents|clear|deleteRow|deleteRows|appendRow|insertSheet|deleteSheet|insertColumnBefore|insertRowBefore)\(/;
const INVALIDATE_CALL = /invalidate(SheetCache|SettingsSheet|SystemModeCache)\(/;

function gasSources(): Array<{ name: string; text: string }> {
  return readdirSync(gasDirectory)
    .filter((name) => name.endsWith('.ts'))
    .map((name) => ({ name, text: readFileSync(resolve(gasDirectory, name), 'utf8') }));
}

/** トップレベルの`function`ごとに本文を切り出す。 */
function topLevelFunctions(text: string): Array<{ name: string; body: string }> {
  const lines = text.split('\n');
  const starts = lines
    .map((line, index) => ({ line, index }))
    .filter(({ line }) => /^(export )?function\s+[A-Za-z_$][\w$]*\s*\(/.test(line));
  return starts.map(({ line, index }, position) => {
    const end = position + 1 < starts.length ? starts[position + 1]!.index : lines.length;
    const name = /function\s+([A-Za-z_$][\w$]*)/.exec(line)?.[1] ?? '';
    return { name, body: lines.slice(index, end).join('\n') };
  });
}

describe('sheet-cache の規約', () => {
  it('リポジトリの中でシートへ書く関数は、同じ関数の中でメモを捨てる', () => {
    const offenders: string[] = [];
    gasSources()
      .filter(({ name }) => REPOSITORY_FILES.includes(name))
      .forEach(({ name, text }) => {
        topLevelFunctions(text).forEach((fn) => {
          if (WRITE_CALL.test(fn.body) && !INVALIDATE_CALL.test(fn.body)) offenders.push(`${name}:${fn.name}`);
        });
      });
    expect(offenders, '書き込みの直後に invalidateSheetCache(シート名) を呼んでください').toEqual([]);
  });

  it('ドキュメントロックを取った直後にメモを全部捨てる', () => {
    const offenders: string[] = [];
    gasSources().forEach(({ name, text }) => {
      const lines = text.split('\n');
      lines.forEach((line, index) => {
        if (!line.includes('.tryLock(')) return;
        const following = lines.slice(index + 1, index + 8).join('\n');
        if (!following.includes('invalidateSheetCache();')) offenders.push(`${name}:${index + 1}`);
      });
    });
    expect(offenders, 'tryLock の直後に invalidateSheetCache() を呼んでください').toEqual([]);
  });

  it('リポジトリ以外がメモ対象のシートへ直接書くなら、sheet-cache を使うか理由付きで除外する', () => {
    const offenders: string[] = [];
    gasSources()
      .filter(({ name }) => !REPOSITORY_FILES.includes(name) && name !== CACHE_FILE)
      .forEach(({ name, text }) => {
        const writes = WRITE_CALL.test(text);
        const touchesMemoized = MEMOIZED_SHEET_KEYS.some((key) => new RegExp(`SHEETS\\.${key}\\b`).test(text));
        const usesCache = text.includes("from './sheet-cache'");
        if (writes && touchesMemoized && !usesCache && !DIRECT_WRITER_EXCEPTIONS[name]) offenders.push(name);
      });
    expect(offenders, 'メモ対象シートへ書いた後は invalidateSheetCache を呼ぶか、DIRECT_WRITER_EXCEPTIONS へ理由を書いてください').toEqual([]);
  });

  it('除外一覧に載っているモジュールは実在し、いまも直接書いている', () => {
    const names = new Set(gasSources().map(({ name }) => name));
    Object.keys(DIRECT_WRITER_EXCEPTIONS).forEach((name) => {
      expect(names.has(name), `${name} が存在しません。除外一覧から外してください。`).toBe(true);
    });
  });
});
