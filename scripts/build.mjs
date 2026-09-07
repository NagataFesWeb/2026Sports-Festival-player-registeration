import { build } from 'esbuild';
import { copyFile, mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { extractEntrypoints } from './extract-entrypoints.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dist = resolve(root, 'dist');

await mkdir(dist, { recursive: true });
await build({
  absWorkingDir: root,
  entryPoints: [resolve(root, 'src/main.ts')],
  bundle: true,
  format: 'iife',
  globalName: 'SportsFestivalApp',
  target: 'es2020',
  outfile: resolve(dist, 'Code.js')
});

const mainSource = await readFile(resolve(root, 'src/main.ts'), 'utf8');
const globals = extractEntrypoints(mainSource);
if (globals.length === 0) throw new Error('Apps Scriptへ公開する関数がsrc/main.tsに見つかりません。');
// 入口関数ごとの実行時間をApps Scriptの実行ログへ残す。関数名とミリ秒だけを出し、
// 引数や戻り値（氏名・学籍番号を含みうる）は出力しない。
await writeFile(
  resolve(dist, 'Entrypoints.js'),
  [
    'function __logElapsed(name, startedAt) {',
    "  console.log('[実行時間] ' + name + ' ' + (Date.now() - startedAt) + 'ms');",
    '}',
    ...globals.map((name) =>
      `function ${name}(...args) { const startedAt = Date.now(); try { return SportsFestivalApp.${name}(...args); } finally { __logElapsed('${name}', startedAt); } }`),
  ].join('\n') + '\n'
);
// src/直下のHTMLはすべてコピーする。新しい画面を足したときのコピー漏れを避けるため、
// ファイル名を1件ずつ書かない。
for (const file of (await readdir(resolve(root, 'src'))).filter((name) => name.endsWith('.html'))) {
  await copyFile(resolve(root, 'src', file), resolve(dist, file));
}
await copyFile(resolve(root, 'src/appsscript.json'), resolve(dist, 'appsscript.json'));
