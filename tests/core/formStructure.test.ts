import { describe, expect, it } from 'vitest';
import { inspectFormStructure, type ActualFormItem } from '../../src/core/form-structure';
import type { EventSetting, FormRegistryRow } from '../../src/shared/types';

const row = (overrides: Partial<FormRegistryRow> = {}): FormRegistryRow => ({
  formType: 'normal', formId: 'FORM-1', itemId: '10', fieldKey: 'student_id',
  eventId: '', title: '学籍番号', itemType: 'text', displayOrder: 1, enabled: true,
  ...overrides,
});

const event = (overrides: Partial<EventSetting> = {}): EventSetting => ({
  year: 2026, eventId: 'E001', enabled: true, targetGrade: '全学年', eventName: '100m走',
  category: '男子', requiredCount: 2, hasOrder: true, vacancyAllowed: false,
  assemblyOrder: 10, displayOrder: 10, note: '',
  ...overrides,
});

const slotRow = (itemId: string, eventId = 'E001'): FormRegistryRow => row({
  itemId, eventId, fieldKey: `${eventId}_slot01_student_id`,
  title: '100m走 第1走者 学籍番号', itemType: 'text', displayOrder: 1011,
});

const slotItem = (itemId: string): ActualFormItem => ({
  itemId, title: '100m走 第1走者 学籍番号', itemType: 'TEXT',
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

  it('全学年の競技が学年ページごとに1組ずつある状態は差分としない', () => {
    expect(inspectFormStructure(
      [slotRow('11'), slotRow('12'), slotRow('13')],
      [slotItem('11'), slotItem('12'), slotItem('13')],
      [event()],
    )).toEqual([]);
  });

  it('学年ページ数を超えて同じfield_keyがある場合は重複として検出する', () => {
    const result = inspectFormStructure(
      [slotRow('11'), slotRow('12'), slotRow('13'), slotRow('14')],
      [slotItem('11'), slotItem('12'), slotItem('13'), slotItem('14')],
      [event()],
    );
    expect(result.map((item) => item.code)).toEqual(['DUPLICATE_FIELD_KEY']);
  });

  it('単一学年の競技は同じfield_keyが2件あれば重複として検出する', () => {
    const result = inspectFormStructure(
      [slotRow('11'), slotRow('12')],
      [slotItem('11'), slotItem('12')],
      [event({ targetGrade: '1年' })],
    );
    expect(result.map((item) => item.code)).toEqual(['DUPLICATE_FIELD_KEY']);
  });

  it('競技に属さない設問は同じfield_keyが2件あれば重複として検出する', () => {
    const result = inspectFormStructure(
      [row({ itemId: '10' }), row({ itemId: '20' })],
      [
        { itemId: '10', title: '学籍番号', itemType: 'TEXT' },
        { itemId: '20', title: '学籍番号', itemType: 'TEXT' },
      ],
    );
    expect(result.map((item) => item.code)).toEqual(['DUPLICATE_FIELD_KEY']);
  });

  it('同じ設問IDが2回登録されている場合は設問IDの重複として検出する', () => {
    const result = inspectFormStructure(
      [slotRow('11'), slotRow('11')],
      [slotItem('11')],
      [event()],
    );
    expect(result.map((item) => item.code)).toEqual(['DUPLICATE_ITEM_ID']);
  });
});
