/**
 * `src/main.ts`のトップレベル`export function`名を取り出す。
 *
 * ビルド（`dist/Entrypoints.js`の生成）と、機能カタログの取りこぼし検査の両方がここを使う。
 * 2箇所に同じ正規表現を書くと必ずずれるので、必ずこの関数を通すこと。
 */
export const ENTRYPOINT_PATTERN = /export function\s+([A-Za-z_$][\w$]*)\s*\(/g;

export function extractEntrypoints(mainSource) {
  return [...mainSource.matchAll(ENTRYPOINT_PATTERN)].map((match) => match[1]);
}
