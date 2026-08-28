import { describe, expect, it } from 'vitest';
import { inspectFormStructure } from '../../src/core/form-structure';
import type { FormRegistryRow } from '../../src/shared/types';

const row = (overrides: Partial<FormRegistryRow> = {}): FormRegistryRow => ({
  formType: 'normal', formId: 'FORM-1', itemId: '10', fieldKey: 'student_id',
  eventId: '', title: '学籍番号', itemType: 'text', displayOrder: 1, enabled: true,
  ...overrides,
});

describe('フォーム構造差分検査', () => {
  it('設問ID・表示名・形式が一致すれば差分なし', () => {
    expect(inspectFormStructure(
      [row()],
      [{ itemId: '10', title: '学籍番号', itemType: 'TEXT' }],
    )).toEqual([]);
  });

  it('削除・改名・形式変更・未登録設問を検出する', () => {
    const result = inspectFormStructure(
      [row(), row({ itemId: '20', fieldKey: 'name', title: '氏名' })],
      [
        { itemId: '10', title: '生徒番号', itemType: 'LIST' },
        { itemId: '30', title: '自由追加', itemType: 'TEXT' },
      ],
    );
    expect(new Set(result.map((item) => item.code)))
      .toEqual(new Set(['TITLE_MISMATCH', 'TYPE_MISMATCH', 'MISSING_ITEM', 'UNREGISTERED_ITEM']));
  });
});
