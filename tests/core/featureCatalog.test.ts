import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
// ビルドが`dist/Entrypoints.js`を作るときと同じ抽出器を使う。
// ここで正規表現を書き写すと、出荷物ではなく写しを検査することになる。
import { extractEntrypoints } from '../../scripts/extract-entrypoints.mjs';
import {
  FEATURE_CATALOG,
  FEATURE_CATEGORY_DESCRIPTIONS,
  FEATURE_CATEGORY_TITLES,
  NON_FEATURE_ENTRYPOINTS,
  isNonFeatureEntrypoint,
  type FeatureCategory,
} from '../../src/core/feature-catalog';
import { CONDITION_BLOCKED_MESSAGES } from '../../src/core/feature-availability';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const readSource = (relativePath: string): string =>
  readFileSync(resolve(projectRoot, relativePath), 'utf8');

const exportedEntrypoints = extractEntrypoints(readSource('src/main.ts')) as string[];
const catalogEntrypoints = FEATURE_CATALOG.map((entry) => entry.entrypoint);

const SCREEN_FILES = ['src/Sidebar.html', 'src/SettingsSidebar.html', 'src/FeatureGuide.html'];

describe('機能カタログと src/main.ts の対応', () => {
  it('利用者が触るすべてのexportが、カタログか除外表のどちらかに載っている', () => {
    const covered = new Set(catalogEntrypoints);
    const missing = exportedEntrypoints
      .filter((name) => !covered.has(name) && !isNonFeatureEntrypoint(name));
    expect(
      missing,
      `src/main.ts に追加された関数が機能カタログに載っていません。\n`
      + `src/core/feature-catalog.ts の FEATURE_CATALOG へ1件足すか、`
      + `利用者が直接使わないものであれば NON_FEATURE_ENTRYPOINTS へ理由付きで書いてください。\n`
      + `対象: ${missing.join(', ')}`,
    ).toEqual([]);
  });

  it('カタログが指すentrypointがすべて実在する', () => {
    const exported = new Set(exportedEntrypoints);
    const dangling = catalogEntrypoints.filter((name) => !exported.has(name));
    expect(
      dangling,
      `機能カタログが、src/main.ts に無い関数を指しています。`
      + `関数名を変えたか消したのに、カタログを直し忘れていませんか。\n対象: ${dangling.join(', ')}`,
    ).toEqual([]);
  });

  it('除外表に書いた関数がすべて実在する（除外表自体が古くならないようにする）', () => {
    const exported = new Set(exportedEntrypoints);
    const stale = Object.keys(NON_FEATURE_ENTRYPOINTS).filter((name) => !exported.has(name));
    expect(
      stale,
      `NON_FEATURE_ENTRYPOINTS に、src/main.ts へ無い関数が残っています。\n対象: ${stale.join(', ')}`,
    ).toEqual([]);
  });

  it('除外表とカタログが重なっていない', () => {
    const overlap = catalogEntrypoints.filter((name) =>
      Object.prototype.hasOwnProperty.call(NON_FEATURE_ENTRYPOINTS, name));
    expect(overlap).toEqual([]);
  });

  it('除外の理由が空でない', () => {
    Object.entries(NON_FEATURE_ENTRYPOINTS).forEach(([name, reason]) => {
      expect(reason.trim().length, `${name} の除外理由が空です。`).toBeGreaterThan(0);
    });
  });
});

describe('機能カタログの中身', () => {
  it('idが重複していない', () => {
    const ids = FEATURE_CATALOG.map((entry) => entry.id);
    expect(ids.length).toBe(new Set(ids).size);
  });

  it('entrypointが重複していない', () => {
    expect(catalogEntrypoints.length).toBe(new Set(catalogEntrypoints).size);
  });

  it('すべての機能に、何をする・いつ使うかが書いてある', () => {
    FEATURE_CATALOG.forEach((entry) => {
      expect(entry.title.trim().length, `${entry.id} の表示名が空です。`).toBeGreaterThan(0);
      expect(entry.whatItDoes.trim().length, `${entry.id} の「何をする」が空です。`).toBeGreaterThan(0);
      expect(entry.whenToUse.trim().length, `${entry.id} の「いつ使うか」が空です。`).toBeGreaterThan(0);
    });
  });

  it('すべての機能に、何が変わる・何は変わらないが書いてある', () => {
    FEATURE_CATALOG.forEach((entry) => {
      expect(entry.whatChanges.length, `${entry.id} の「何が変わる」が空です。`).toBeGreaterThan(0);
      expect(
        entry.whatDoesNotChange.length,
        `${entry.id} の「何は変わらない」が空です。利用者がいちばん不安に思うところなので必ず書いてください。`,
      ).toBeGreaterThan(0);
      entry.whatChanges.forEach((line) => expect(line.trim().length).toBeGreaterThan(0));
      entry.whatDoesNotChange.forEach((line) => expect(line.trim().length).toBeGreaterThan(0));
    });
  });

  it('すべての機能に置き場所が1つ以上ある', () => {
    FEATURE_CATALOG.forEach((entry) => {
      expect(entry.placement.length, `${entry.id} の置き場所がありません。`).toBeGreaterThan(0);
    });
  });

  it('メニューの階層名が、実際に使われているサブメニュー名だけである', () => {
    const knownMenuPaths = new Set([
      '', '状態別に開く', 'フォーム・競技設定', '実機テスト（本物のフォームで確認）',
    ]);
    FEATURE_CATALOG.forEach((entry) => {
      entry.placement.forEach((placement) => {
        if (placement.kind !== 'MENU') return;
        expect(placement.path.length, `${entry.id} のメニュー階層が深すぎます。`).toBeLessThanOrEqual(1);
        expect(
          knownMenuPaths.has(placement.path[0] ?? ''),
          `${entry.id} のメニュー階層「${placement.path.join(' / ')}」は onOpen に存在しません。`,
        ).toBe(true);
      });
    });
  });

  it('使われている前提条件に、すべて表示文言がある', () => {
    FEATURE_CATALOG.forEach((entry) => {
      entry.requires.forEach((key) => {
        expect(
          CONDITION_BLOCKED_MESSAGES[key]?.trim().length ?? 0,
          `${entry.id} が使う前提条件 ${key} の表示文言がありません。`,
        ).toBeGreaterThan(0);
      });
    });
  });

  it('使われている分類に、すべて見出しと説明がある', () => {
    const used = new Set<FeatureCategory>(FEATURE_CATALOG.map((entry) => entry.category));
    used.forEach((category) => {
      expect(FEATURE_CATEGORY_TITLES[category]?.trim().length ?? 0).toBeGreaterThan(0);
      expect(FEATURE_CATEGORY_DESCRIPTIONS[category]?.trim().length ?? 0).toBeGreaterThan(0);
    });
  });

  it('元に戻せない操作には、必ず実行前の確認を出す', () => {
    FEATURE_CATALOG.filter((entry) => entry.destructive).forEach((entry) => {
      expect(
        entry.confirmBeforeRun,
        `${entry.id} は元に戻せない操作なので confirmBeforeRun を true にしてください。`,
      ).toBe(true);
    });
  });
});

describe('画面が呼ぶサーバー関数', () => {
  // run('名前', ...) と google.script.run....名前(...) の両方を拾う。
  // withSuccessHandler などの組み立て用メソッドは呼び出し先ではないので除く。
  const callPattern = /(?:run\(\s*'([A-Za-z_$][\w$]*)'|google\.script\.run[\s\S]{0,200}?\.\s*([A-Za-z_$][\w$]*)\s*\()/g;
  const RUNNER_BUILDER_METHODS = new Set([
    'withSuccessHandler', 'withFailureHandler', 'withUserObject',
  ]);

  SCREEN_FILES.forEach((file) => {
    it(`${file} が呼ぶ関数が、すべて src/main.ts に存在する`, () => {
      const source = readSource(file);
      const called = [...source.matchAll(callPattern)]
        .map((match) => match[1] ?? match[2])
        .filter((name): name is string => Boolean(name))
        .filter((name) => !RUNNER_BUILDER_METHODS.has(name));
      const exported = new Set(exportedEntrypoints);
      const unknown = [...new Set(called)].filter((name) => !exported.has(name));
      expect(
        unknown,
        `${file} が、src/main.ts に無い関数を呼んでいます。`
        + `関数名の書き間違いか、使われなくなった処理が残っています。\n対象: ${unknown.join(', ')}`,
      ).toEqual([]);
    });
  });
});
