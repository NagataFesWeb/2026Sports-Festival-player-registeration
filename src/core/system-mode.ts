export type SystemMode = 'DEVELOPMENT' | 'PRODUCTION';

/**
 * `システム設定`シートの値を優先し、判定できないときだけScript Propertyで判定する。
 * シートが`DEVELOPMENT`または`PRACTICE`のときは、Script Propertyが古い`PRODUCTION`のままでも開発用モードとする。
 */
export function resolveSystemMode(
  sheetValue: string | undefined,
  propertyValue: string | undefined,
): SystemMode {
  const sheetMode = (sheetValue ?? '').trim().toUpperCase();
  if (sheetMode === 'PRODUCTION') return 'PRODUCTION';
  if (sheetMode === 'DEVELOPMENT' || sheetMode === 'PRACTICE') return 'DEVELOPMENT';
  return (propertyValue ?? '').trim().toUpperCase() === 'PRODUCTION' ? 'PRODUCTION' : 'DEVELOPMENT';
}

/** 同じ項目名の行だけを書き換え、`練習用保存フォルダID`など他の行を消さない。 */
export function upsertSystemConfigRows(
  rows: readonly (readonly string[])[],
  key: string,
  value: string,
): string[][] {
  const updated = rows.map((row) => [row[0] ?? '', row[1] ?? '']);
  const target = updated.find((row) => row[0] === key);
  if (target) {
    target[1] = value;
    return updated;
  }
  return [...updated, [key, value]];
}

/** 名簿作成の途中経過を保存する一時シート。切替時に消し残すと疑似データが残る。 */
export function isRosterStagingSheetName(name: string): boolean {
  return /^_名簿(登録|申請)作成中_/.test(name);
}

export const PRODUCTION_MIGRATION_CONFIRMATION_WORD = '本番開始';

/** 全角空白・前後の空白を無視して、確認語を入力したかどうかを判定する。 */
export function isProductionMigrationConfirmed(input: string): boolean {
  return input.replace(/[\s\u3000]/g, '') === PRODUCTION_MIGRATION_CONFIRMATION_WORD;
}

export interface ProductionMigrationCounts {
  submissions: number;
  items: number;
  issues: number;
  approvals: number;
  changes: number;
  rawResponses: number;
  registrations: number;
  mockStudents: number;
  rosterHistory: number;
  formResponses: number;
}

export interface ProductionMigrationPreview {
  clearedSheets: readonly string[];
  keptSheets: readonly string[];
  counts: ProductionMigrationCounts;
  rosterFolderUrls: readonly string[];
  productionStudentCount: number;
}

function countLine(label: string, count: number): string {
  return `・${label}：${count}件`;
}

/** 切替前の確認画面に出す本文。何を消して何を残すかを、件数付きで先に見せる。 */
export function buildProductionMigrationText(preview: ProductionMigrationPreview): string {
  const { counts } = preview;
  const deletedLines = [
    countLine('承認待ちの申請', counts.submissions),
    countLine('申請項目', counts.items),
    countLine('検査結果', counts.issues),
    countLine('承認履歴', counts.approvals),
    countLine('変更履歴', counts.changes),
    countLine('フォーム回答原本', counts.rawResponses),
    countLine('登録データ', counts.registrations),
    countLine('疑似生徒マスター', counts.mockStudents),
    countLine('選手名簿作成履歴', counts.rosterHistory),
    countLine('Googleフォームに届いている回答', counts.formResponses),
  ].join('\n');
  const folderLines = preview.rosterFolderUrls.length > 0
    ? '\n\n【手動で片付けるもの】\n開発中に作った選手名簿のフォルダは自動では削除しません。'
      + '切替後に次のURLを開いて、不要なら削除してください。\n'
      + preview.rosterFolderUrls.join('\n')
    : '';
  return '本番モードへ切り替えます。切替前に、開発用に作ったデータをすべて削除します。\n\n'
    + `【削除するもの】（元に戻せません）\n${deletedLines}\n`
    + `削除するシート：${preview.clearedSheets.join('、')}\n\n`
    + `【残すもの】\n生徒マスター（${preview.productionStudentCount}人）、`
    + `${preview.keptSheets.join('、')}、作成済みのGoogleフォーム本体\n`
    + folderLines
    + `\n\n続ける場合は、下の入力欄に「${PRODUCTION_MIGRATION_CONFIRMATION_WORD}」と入力してOKを押してください。`;
}
