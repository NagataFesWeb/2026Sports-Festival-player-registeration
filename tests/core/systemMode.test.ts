import { describe, expect, it } from 'vitest';
import {
  buildProductionMigrationText,
  isProductionMigrationConfirmed,
  isRosterStagingSheetName,
  PRODUCTION_MIGRATION_CONFIRMATION_WORD,
  resolveSystemMode,
  upsertSystemConfigRows,
  type ProductionMigrationPreview,
} from '../../src/core/system-mode';

describe('運用モードの判定', () => {
  it('シートの値をScript Propertyより優先する', () => {
    expect(resolveSystemMode('PRODUCTION', undefined)).toBe('PRODUCTION');
    expect(resolveSystemMode('PRACTICE', 'PRODUCTION')).toBe('DEVELOPMENT');
  });

  it('開発用へ戻した後は、Script Propertyが本番のままでも開発用と判定する', () => {
    expect(resolveSystemMode('DEVELOPMENT', 'PRODUCTION')).toBe('DEVELOPMENT');
  });

  it('シートに値がないときはScript Propertyで判定する', () => {
    expect(resolveSystemMode(undefined, 'PRODUCTION')).toBe('PRODUCTION');
    expect(resolveSystemMode('', 'PRODUCTION')).toBe('PRODUCTION');
    expect(resolveSystemMode('', undefined)).toBe('DEVELOPMENT');
    expect(resolveSystemMode('', '')).toBe('DEVELOPMENT');
  });

  it('前後の空白や小文字を許容する', () => {
    expect(resolveSystemMode(' production ', undefined)).toBe('PRODUCTION');
    expect(resolveSystemMode(undefined, ' production ')).toBe('PRODUCTION');
  });

  it('未知の値は開発用として扱う', () => {
    expect(resolveSystemMode('本番', undefined)).toBe('DEVELOPMENT');
  });
});

describe('システム設定シートの書き換え', () => {
  it('運用モードの行だけを書き換え、練習用保存フォルダIDを残す', () => {
    const rows = [['運用モード', 'PRODUCTION'], ['練習用保存フォルダID', 'folder-1']];
    expect(upsertSystemConfigRows(rows, '運用モード', 'DEVELOPMENT')).toEqual([
      ['運用モード', 'DEVELOPMENT'],
      ['練習用保存フォルダID', 'folder-1'],
    ]);
  });

  it('項目がなければ末尾へ追加する', () => {
    expect(upsertSystemConfigRows([['練習用保存フォルダID', 'folder-1']], '運用モード', 'PRODUCTION'))
      .toEqual([['練習用保存フォルダID', 'folder-1'], ['運用モード', 'PRODUCTION']]);
    expect(upsertSystemConfigRows([], '運用モード', 'PRODUCTION')).toEqual([['運用モード', 'PRODUCTION']]);
  });

  it('元の配列を書き換えない', () => {
    const rows = [['運用モード', 'PRODUCTION']];
    upsertSystemConfigRows(rows, '運用モード', 'DEVELOPMENT');
    expect(rows).toEqual([['運用モード', 'PRODUCTION']]);
  });
});

describe('名簿作成の一時シート', () => {
  it('一時シートだけを識別する', () => {
    expect(isRosterStagingSheetName('_名簿登録作成中_abc123')).toBe(true);
    expect(isRosterStagingSheetName('_名簿申請作成中_abc123')).toBe(true);
    expect(isRosterStagingSheetName('選手名簿作成履歴')).toBe(false);
    expect(isRosterStagingSheetName('名簿作成状況')).toBe(false);
    expect(isRosterStagingSheetName('登録データ')).toBe(false);
  });
});

describe('本番切替の確認入力', () => {
  it('確認語と一致したときだけ許可する', () => {
    expect(isProductionMigrationConfirmed(PRODUCTION_MIGRATION_CONFIRMATION_WORD)).toBe(true);
    expect(isProductionMigrationConfirmed(' 本番開始 ')).toBe(true);
    expect(isProductionMigrationConfirmed('本番　開始')).toBe(true);
    expect(isProductionMigrationConfirmed('')).toBe(false);
    expect(isProductionMigrationConfirmed('はい')).toBe(false);
    expect(isProductionMigrationConfirmed('本番開始します')).toBe(false);
  });
});

describe('本番切替前の確認文', () => {
  const preview: ProductionMigrationPreview = {
    clearedSheets: ['承認待ち', '登録データ'],
    keptSheets: ['競技設定', 'ルール設定'],
    counts: {
      submissions: 12, items: 60, issues: 5, approvals: 8, changes: 2,
      rawResponses: 12, registrations: 40, mockStudents: 120, rosterHistory: 1,
      formResponses: 3,
    },
    rosterFolderUrls: ['https://drive.example/folder-1'],
    productionStudentCount: 960,
  };

  it('削除件数、残すもの、確認語を本文へ含める', () => {
    const text = buildProductionMigrationText(preview);
    expect(text).toContain('承認待ちの申請：12件');
    expect(text).toContain('登録データ：40件');
    expect(text).toContain('Googleフォームに届いている回答：3件');
    expect(text).toContain('生徒マスター（960人）');
    expect(text).toContain('競技設定、ルール設定');
    expect(text).toContain('https://drive.example/folder-1');
    expect(text).toContain(PRODUCTION_MIGRATION_CONFIRMATION_WORD);
  });

  it('帳票フォルダがなければ、手動で片付ける案内を出さない', () => {
    const text = buildProductionMigrationText({ ...preview, rosterFolderUrls: [] });
    expect(text).not.toContain('手動で片付けるもの');
  });
});
