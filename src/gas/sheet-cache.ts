/**
 * 1回の実行の中だけで有効な、シート読み取りのメモ。
 *
 * Apps Scriptはメニュー・サイドバー・トリガーの呼び出しごとにスクリプトを最初から実行するので、
 * モジュール変数に置いたメモは実行をまたいで残らない。同じ実行の中で同じシートを何度も読む
 * 往復（承認1件で申請シートを6回読む等）を省くのが目的で、実行をまたぐキャッシュではない。
 *
 * 守るべき規約:
 * - シートへ書き込む関数は、書いた直後に必ず`invalidateSheetCache(シート名)`を呼ぶ。
 * - 書き込む相手が分からない場面（ロック取得直後、シートの追加・削除、外部モジュールへの
 *   Sheetハンドル渡し）では引数なしの`invalidateSheetCache()`で全部捨てる。
 * - 読み取り結果の2次元配列は毎回コピーして返す。呼び出し側が行を書き換えてもメモは汚れない。
 *
 * このモジュールはGASのグローバルへ触れない。純粋な関数としてローカルテストで検証する。
 */
type CacheValue = unknown;

// シート名に含まれない文字で区切る。シート名は空白を含みうる。
const SEPARATOR = '\u0000';
const store = new Map<string, CacheValue>();

function cacheKey(sheetName: string, label: string): string {
  return `${sheetName}${SEPARATOR}${label}`;
}

/** 単一の値（文字列・真偽値など、書き換えられない値）を実行内でメモする。 */
export function cachedSheetValue<T extends string | number | boolean | undefined>(
  sheetName: string,
  label: string,
  load: () => T,
): T {
  const key = cacheKey(sheetName, label);
  if (store.has(key)) return store.get(key) as T;
  const value = load();
  store.set(key, value);
  return value;
}

/**
 * 2次元配列（`getValues()`や`getDisplayValues()`の結果）を実行内でメモする。
 * 返す配列は毎回、行ごとにコピーしたものにする。
 */
export function cachedSheetRows<T>(sheetName: string, label: string, load: () => T[][]): T[][] {
  const key = cacheKey(sheetName, label);
  const cached = store.get(key) as T[][] | undefined;
  const rows = cached ?? load();
  if (!cached) store.set(key, rows);
  return rows.map((row) => row.slice());
}

/**
 * メモを捨てる。シート名を渡すとそのシートの分だけ、渡さなければ全部捨てる。
 * 書き込みの直後、ロック取得の直後、シート構成を変えた直後に呼ぶ。
 */
export function invalidateSheetCache(...sheetNames: string[]): void {
  if (sheetNames.length === 0) {
    store.clear();
    return;
  }
  const targets = new Set(sheetNames);
  for (const key of [...store.keys()]) {
    const sheetName = key.slice(0, key.indexOf(SEPARATOR));
    if (targets.has(sheetName)) store.delete(key);
  }
}

/** テスト用。メモされている項目数を返す。 */
export function sheetCacheSize(): number {
  return store.size;
}
