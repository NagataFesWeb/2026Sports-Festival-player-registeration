import { build } from 'esbuild';
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

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
const globals = [...mainSource.matchAll(/export function\s+([A-Za-z_$][\w$]*)\s*\(/g)]
  .map((match) => match[1]);
if (globals.length === 0) throw new Error('Apps Scriptへ公開する関数がsrc/main.tsに見つかりません。');
await writeFile(
  resolve(dist, 'Entrypoints.js'),
  globals.map((name) => `function ${name}(...args) { return SportsFestivalApp.${name}(...args); }`).join('\n') + '\n'
);
await copyFile(resolve(root, 'src/Sidebar.html'), resolve(dist, 'Sidebar.html'));
await copyFile(resolve(root, 'src/SettingsSidebar.html'), resolve(dist, 'SettingsSidebar.html'));
await copyFile(resolve(root, 'src/UiTokens.html'), resolve(dist, 'UiTokens.html'));
await copyFile(resolve(root, 'src/appsscript.json'), resolve(dist, 'appsscript.json'));
