import { appliesToGrade } from './settings';
import type { EventSetting, FormRegistryRow } from '../shared/types';

export interface ActualFormItem {
  itemId: string;
  title: string;
  itemType: string;
}

export interface FormStructureDifference {
  code: 'DUPLICATE_FIELD_KEY' | 'DUPLICATE_ITEM_ID' | 'MISSING_ITEM'
    | 'TITLE_MISMATCH' | 'TYPE_MISMATCH' | 'UNREGISTERED_ITEM';
  message: string;
}

/** 通常フォームが持つ学年ページ。全学年の競技は各学年ページへ1組ずつ出す。 */
const NORMAL_FORM_GRADES = [1, 2, 3] as const;

const normalizedType = (value: string): string => value.trim().toLowerCase();

/**
 * 1つのfield_keyが同じフォームへ何回登録されるはずかを返す。
 * 通常フォームの競技設問は学年ページごとに作るため、全学年の競技では学年数だけ増える。
 * 競技設定に見つからないevent_idは、誤って公開を止めないよう最大値（学年数）まで許す。
 */
function expectedRowCount(row: FormRegistryRow, eventsById: Map<string, EventSetting>): number {
  if (row.formType !== 'normal' || row.eventId === '') return 1;
  const event = eventsById.get(row.eventId);
  if (!event) return NORMAL_FORM_GRADES.length;
  return NORMAL_FORM_GRADES.filter((grade) => appliesToGrade(event, grade)).length || 1;
}

export function inspectFormStructure(
  registryRows: FormRegistryRow[],
  actualItems: ActualFormItem[],
  events: EventSetting[] = [],
): FormStructureDifference[] {
  const differences: FormStructureDifference[] = [];
  const enabled = registryRows.filter((row) => row.enabled);
  const eventsById = new Map(events.map((event) => [event.eventId, event]));
  const rowsByFieldKey = new Map<string, FormRegistryRow[]>();
  enabled.forEach((row) => {
    const grouped = rowsByFieldKey.get(row.fieldKey) ?? [];
    grouped.push(row);
    rowsByFieldKey.set(row.fieldKey, grouped);
  });
  rowsByFieldKey.forEach((grouped, fieldKey) => {
    const expected = expectedRowCount(grouped[0]!, eventsById);
    if (grouped.length <= expected) return;
    differences.push({
      code: 'DUPLICATE_FIELD_KEY',
      message: `field_key「${fieldKey}」が${grouped.length}件あります（想定は${expected}件）。`,
    });
  });
  const seenItems = new Set<string>();
  enabled.forEach((row) => {
    if (seenItems.has(row.itemId)) {
      differences.push({
        code: 'DUPLICATE_ITEM_ID',
        message: `設問ID「${row.itemId}」が重複しています。`,
      });
    }
    seenItems.add(row.itemId);
  });

  const actualById = new Map(actualItems.map((item) => [item.itemId, item]));
  enabled.forEach((row) => {
    const actual = actualById.get(row.itemId);
    if (!actual) {
      differences.push({
        code: 'MISSING_ITEM',
        message: `「${row.title}」（${row.fieldKey}）がフォームにありません。`,
      });
      return;
    }
    if (actual.title !== row.title) {
      differences.push({
        code: 'TITLE_MISMATCH',
        message: `「${row.fieldKey}」の設問名が「${actual.title}」へ変更されています。`,
      });
    }
    if (normalizedType(actual.itemType) !== normalizedType(row.itemType)) {
      differences.push({
        code: 'TYPE_MISMATCH',
        message: `「${row.title}」の設問形式が変更されています。`,
      });
    }
  });
  const registeredIds = new Set(enabled.map((row) => row.itemId));
  actualItems.filter((item) => !registeredIds.has(item.itemId)).forEach((item) => {
    differences.push({
      code: 'UNREGISTERED_ITEM',
      message: `対応表にない回答項目「${item.title}」があります。`,
    });
  });
  return differences;
}
