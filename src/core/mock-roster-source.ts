import type { SystemMode } from './system-mode';

/**
 * 疑似申請がどちらの名簿の生徒を使うか。
 *
 * 疑似生徒マスターと生徒マスターは学籍番号の書式が完全に一致する（どちらも学年1桁＋組1桁＋
 * 出席番号2桁）。両方を結合すると疑似申請が実在生徒へ静かに解決されるため、
 * **常にどちらか一方だけ**を使う。混ぜてはいけない。
 */
export type MockRosterSource = 'MOCK_STUDENTS' | 'PRODUCTION_STUDENTS';

export const MOCK_ROSTER_SOURCE_LABELS: Record<MockRosterSource, string> = {
  MOCK_STUDENTS: '疑似生徒マスター',
  PRODUCTION_STUDENTS: '生徒マスター',
};

export const MOCK_ROSTER_SOURCE_CHOICES: readonly string[] = [
  MOCK_ROSTER_SOURCE_LABELS.MOCK_STUDENTS,
  MOCK_ROSTER_SOURCE_LABELS.PRODUCTION_STUDENTS,
];

/** `疑似データ設定`シートの表示値から選択値を読む。空欄・不明値・シート無しは疑似生徒マスター。 */
export function parseMockRosterSource(cellValue: string | undefined): MockRosterSource {
  return String(cellValue ?? '').trim() === MOCK_ROSTER_SOURCE_LABELS.PRODUCTION_STUDENTS
    ? 'PRODUCTION_STUDENTS'
    : 'MOCK_STUDENTS';
}

/**
 * 最初に読む名簿を返す。ここが空だったときだけ、もう一方を読む。
 *
 * 名簿の件数を先に両方数える形にすると、決めるために2枚読んでから勝った方をもう一度読むことになり、
 * 1回で済んでいた読み取りが3回になる。名簿作成は既に実行時間の上限に触れるため、
 * 「まず1枚読む → 空なら次」の順で最悪2回に抑える。
 */
export function firstRosterToRead(input: {
  mode: SystemMode;
  configured: MockRosterSource;
}): MockRosterSource {
  // 本番モードでは疑似データ機能そのものが使えないので、選択を一切見ない。
  if (input.mode === 'PRODUCTION') return 'PRODUCTION_STUDENTS';
  return input.configured;
}

/** 本番モードでは疑似生徒マスターへ落ちてはいけない。開発モードのときだけ代替を許す。 */
export function rosterFallbackAllowed(mode: SystemMode): boolean {
  return mode !== 'PRODUCTION';
}

/** 実際に読んだ件数から決める。呼び出し側の分岐と同じ規則を、テストできる形で表したもの。 */
export function resolveRosterSourceFromCounts(input: {
  mode: SystemMode;
  configured: MockRosterSource;
  mockStudentCount: number;
  productionStudentCount: number;
}): MockRosterSource {
  if (input.mode === 'PRODUCTION') return 'PRODUCTION_STUDENTS';
  if (input.configured === 'MOCK_STUDENTS' && input.mockStudentCount > 0) return 'MOCK_STUDENTS';
  if (input.configured === 'PRODUCTION_STUDENTS' && input.productionStudentCount > 0) {
    return 'PRODUCTION_STUDENTS';
  }
  // 選んだ名簿が空のときは、もう一方に入力があればそちらを使う（旧版ブックとの互換）。
  if (input.productionStudentCount > 0) return 'PRODUCTION_STUDENTS';
  return 'MOCK_STUDENTS';
}

/** 疑似申請を作ったときの名簿と、いま選ばれている名簿の食い違い。 */
export type RosterSourceConflictCode = 'MOCK_ROSTER_SOURCE_CHANGED' | '';

/**
 * 疑似申請が残っている状態で名簿の選択を変えると、既存の疑似申請が別名簿の生徒へ
 * 解決され直す。承認され`登録データ`や帳票へ流れると取り返しがつかないため、
 * 消費する側（再検査・承認・名簿作成）で必ず検出する。
 */
export function detectRosterSourceConflict(input: {
  resolved: MockRosterSource;
  stamped: MockRosterSource | '';
  mockSubmissionExists: boolean;
}): RosterSourceConflictCode {
  if (!input.mockSubmissionExists) return '';
  if (input.stamped === '') return '';
  return input.stamped === input.resolved ? '' : 'MOCK_ROSTER_SOURCE_CHANGED';
}

export function rosterSourceConflictMessage(stamped: MockRosterSource): string {
  return `今ある疑似申請は「${MOCK_ROSTER_SOURCE_LABELS[stamped]}」の生徒で作られています。`
    + 'いまは別の名簿が選ばれているため、処理を中止しました。\n\n'
    + `「疑似データ設定」シートの「疑似申請に使う名簿」を「${MOCK_ROSTER_SOURCE_LABELS[stamped]}」へ戻すか、`
    + '「開発用の疑似データをすべて削除」を実行してから、もう一度お試しください。';
}

export function emptyRosterMessage(source: MockRosterSource): string {
  return source === 'PRODUCTION_STUDENTS'
    ? '「生徒マスター」に生徒が1人も入力されていません。'
      + 'A列に4ケタの学籍番号、B列に氏名、F列に性別を入力してから、もう一度お試しください。\n\n'
      + '実在の生徒を使わずに試す場合は、「疑似データ設定」シートの「疑似申請に使う名簿」を'
      + '「疑似生徒マスター」へ戻してください。'
    : '「疑似生徒マスター」が空です。先に「開発用の疑似データを作る」を実行してください。';
}
