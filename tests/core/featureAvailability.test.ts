import { describe, expect, it } from 'vitest';
import {
  CONDITION_BLOCKED_MESSAGES,
  evaluateCatalog,
  evaluateFeature,
  findAvailability,
  isFeatureVisible,
  type FeatureConditionSnapshot,
} from '../../src/core/feature-availability';
import {
  FEATURE_CATALOG,
  findFeature,
  type FeatureConditionKey,
  type FeatureEntry,
  type FeatureVisibility,
} from '../../src/core/feature-catalog';

const entry = (
  visibility: FeatureVisibility,
  requires: readonly FeatureConditionKey[] = [],
): FeatureEntry => ({
  id: 'test.entry',
  title: 'テスト用の操作',
  category: 'REVIEW',
  entrypoint: 'showDashboard',
  placement: [{ kind: 'MENU', path: [] }],
  visibility,
  requires,
  whatItDoes: 'テスト用。',
  whatChanges: ['なし'],
  whatDoesNotChange: ['なし'],
  whenToUse: 'テストのとき。',
  confirmBeforeRun: false,
  destructive: false,
});

const snapshot = (
  overrides: Partial<FeatureConditionSnapshot> = {},
): FeatureConditionSnapshot => ({
  mode: 'DEVELOPMENT',
  practiceWorkbook: false,
  conditions: {},
  ...overrides,
});

describe('isFeatureVisible', () => {
  it('ALWAYSはどのモードでも出す', () => {
    expect(isFeatureVisible(entry('ALWAYS'), { mode: 'DEVELOPMENT', practiceWorkbook: false })).toBe(true);
    expect(isFeatureVisible(entry('ALWAYS'), { mode: 'PRODUCTION', practiceWorkbook: false })).toBe(true);
    expect(isFeatureVisible(entry('ALWAYS'), { mode: 'DEVELOPMENT', practiceWorkbook: true })).toBe(true);
  });

  it('DEVELOPMENT_ONLYは本番モードで消える', () => {
    expect(isFeatureVisible(entry('DEVELOPMENT_ONLY'), { mode: 'DEVELOPMENT', practiceWorkbook: false })).toBe(true);
    expect(isFeatureVisible(entry('DEVELOPMENT_ONLY'), { mode: 'PRODUCTION', practiceWorkbook: false })).toBe(false);
  });

  it('PRODUCTION_ONLYは開発用モードで消える', () => {
    expect(isFeatureVisible(entry('PRODUCTION_ONLY'), { mode: 'PRODUCTION', practiceWorkbook: false })).toBe(true);
    expect(isFeatureVisible(entry('PRODUCTION_ONLY'), { mode: 'DEVELOPMENT', practiceWorkbook: false })).toBe(false);
  });

  it('NON_PRACTICE_ONLYは練習用コピーで消える', () => {
    expect(isFeatureVisible(entry('NON_PRACTICE_ONLY'), { mode: 'DEVELOPMENT', practiceWorkbook: false })).toBe(true);
    expect(isFeatureVisible(entry('NON_PRACTICE_ONLY'), { mode: 'DEVELOPMENT', practiceWorkbook: true })).toBe(false);
  });
});

describe('evaluateFeature', () => {
  it('前提をすべて満たしていれば押せる', () => {
    const result = evaluateFeature(entry('ALWAYS', ['SUBMISSIONS_EXIST']),
      snapshot({ conditions: { SUBMISSIONS_EXIST: true } }));
    expect(result.enabled).toBe(true);
    expect(result.blockedReason).toBe('');
    expect(result.unmetConditions).toEqual([]);
  });

  it('満たしていない前提があれば押せず、先頭1件の理由だけを出す', () => {
    const result = evaluateFeature(
      entry('ALWAYS', ['SETTINGS_SHEETS_READY', 'SETTINGS_NO_ERROR']),
      snapshot({ conditions: { SETTINGS_SHEETS_READY: false, SETTINGS_NO_ERROR: false } }),
    );
    expect(result.visible).toBe(true);
    expect(result.enabled).toBe(false);
    expect(result.unmetConditions).toEqual(['SETTINGS_SHEETS_READY', 'SETTINGS_NO_ERROR']);
    expect(result.blockedReason).toBe(CONDITION_BLOCKED_MESSAGES.SETTINGS_SHEETS_READY);
  });

  it('判定できなかった前提は満たしているものとして扱う', () => {
    // 調べていないことを理由に操作を止めない。条件を追加した直後に、
    // まだ評価していない機能が一斉に押せなくなるのを避けるため。
    const result = evaluateFeature(entry('ALWAYS', ['ROSTER_JOB_IDLE']), snapshot());
    expect(result.enabled).toBe(true);
    expect(result.blockedReason).toBe('');
  });

  it('表示しない機能は押せる扱いにしない', () => {
    const result = evaluateFeature(entry('DEVELOPMENT_ONLY'), snapshot({ mode: 'PRODUCTION' }));
    expect(result.visible).toBe(false);
    expect(result.enabled).toBe(false);
  });
});

describe('evaluateCatalog（実際のカタログでの出し分け）', () => {
  it('本番モードでは疑似データの操作がすべて消える', () => {
    const result = evaluateCatalog(snapshot({ mode: 'PRODUCTION' }));
    FEATURE_CATALOG.filter((candidate) => candidate.category === 'MOCK_DATA').forEach((candidate) => {
      expect(
        findAvailability(result, candidate.id)?.visible,
        `${candidate.id} が本番モードで表示されています。`,
      ).toBe(false);
    });
  });

  it('開発用モードでは疑似データの操作が出る', () => {
    const result = evaluateCatalog(snapshot({ mode: 'DEVELOPMENT' }));
    expect(findAvailability(result, 'mock.initialize')?.visible).toBe(true);
    expect(findAvailability(result, 'mock.delete')?.visible).toBe(true);
  });

  it('練習用コピーでは本番モードへの切替と共有点検が消える', () => {
    const result = evaluateCatalog(snapshot({ practiceWorkbook: true }));
    expect(findAvailability(result, 'mode.enableProduction')?.visible).toBe(false);
    expect(findAvailability(result, 'mode.showProductionMaster')?.visible).toBe(false);
    expect(findAvailability(result, 'mode.auditSharing')?.visible).toBe(false);
  });

  it('設定シートが無い状態では、フォーム作成が押せず理由が出る', () => {
    const result = evaluateCatalog(snapshot({
      conditions: { SETTINGS_SHEETS_READY: false, SETTINGS_NO_ERROR: false },
    }));
    const build = findAvailability(result, 'setup.buildDraft');
    expect(build?.visible).toBe(true);
    expect(build?.enabled).toBe(false);
    expect(build?.blockedReason).toBe(CONDITION_BLOCKED_MESSAGES.SETTINGS_SHEETS_READY);
  });

  it('疑似申請が無い状態では、疑似データの削除と修正申請の追加が押せない', () => {
    const result = evaluateCatalog(snapshot({ conditions: { MOCK_SUBMISSIONS_EXIST: false } }));
    expect(findAvailability(result, 'mock.delete')?.enabled).toBe(false);
    expect(findAvailability(result, 'mock.addCorrections')?.enabled).toBe(false);
    // 疑似データの作成は疑似申請が無くても実行できる（それが最初の1回だから）。
    expect(findFeature('mock.initialize').requires).not.toContain('MOCK_SUBMISSIONS_EXIST');
  });

  it('前提を持たない機能は、何も調べなくても押せる', () => {
    const result = evaluateCatalog(snapshot());
    FEATURE_CATALOG.filter((candidate) => candidate.requires.length === 0).forEach((candidate) => {
      const state = findAvailability(result, candidate.id);
      if (!state?.visible) return;
      expect(state.enabled, `${candidate.id} が理由なく押せなくなっています。`).toBe(true);
    });
  });
});
