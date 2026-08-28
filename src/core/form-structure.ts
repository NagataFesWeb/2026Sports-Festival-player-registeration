import type { FormRegistryRow } from '../shared/types';

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

const normalizedType = (value: string): string => value.trim().toLowerCase();

export function inspectFormStructure(
  registryRows: FormRegistryRow[],
  actualItems: ActualFormItem[],
): FormStructureDifference[] {
  const differences: FormStructureDifference[] = [];
  const enabled = registryRows.filter((row) => row.enabled);
  const seenFields = new Set<string>();
  const seenItems = new Set<string>();
  enabled.forEach((row) => {
    if (seenFields.has(row.fieldKey)) {
      differences.push({
        code: 'DUPLICATE_FIELD_KEY',
        message: `field_key「${row.fieldKey}」が重複しています。`,
      });
    }
    if (seenItems.has(row.itemId)) {
      differences.push({
        code: 'DUPLICATE_ITEM_ID',
        message: `設問ID「${row.itemId}」が重複しています。`,
      });
    }
    seenFields.add(row.fieldKey);
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
