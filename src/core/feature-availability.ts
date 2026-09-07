import type { SystemMode } from './system-mode';
import {
  FEATURE_CATALOG,
  type FeatureConditionKey,
  type FeatureEntry,
} from './feature-catalog';

/**
 * 機能が「今出すか」「今押せるか」を決める純関数。
 *
 * 出し分けの方針:
 * - モードで決まるもの（開発専用・本番専用・練習用コピー）は完全に非表示にする
 * - 状態で決まるもの（設定が未完了、受付停止中など）は表示したまま押せなくし、理由を1行添える
 *
 * 表示したまま無効化するのは、「使える機能があること自体に気づけない」状態を避けるため。
 */

/** メニューを組むときに使う軽い文脈。シート1枚の読み取りだけで作れる。 */
export interface FeatureVisibilityContext {
  readonly mode: SystemMode;
  readonly practiceWorkbook: boolean;
}

/** サイドバーと機能紹介ダイアログで使う、全条件を評価済みの文脈。 */
export interface FeatureConditionSnapshot extends FeatureVisibilityContext {
  readonly conditions: Readonly<Partial<Record<FeatureConditionKey, boolean>>>;
}

export interface FeatureAvailability {
  readonly id: string;
  readonly visible: boolean;
  readonly enabled: boolean;
  readonly unmetConditions: readonly FeatureConditionKey[];
  /** 押せない理由。押せるときは空文字。 */
  readonly blockedReason: string;
}

/** 内部コードと表示文言を分けるための対応表。 */
export const CONDITION_BLOCKED_MESSAGES: Readonly<Record<FeatureConditionKey, string>> = {
  SETTINGS_SHEETS_READY: '先に「設定シートを作成・不足分を補う」を実行してください。',
  SETTINGS_NO_ERROR: '先に「設定を点検」を実行し、エラーを0件にしてください。',
  FORMS_EXIST: '先に「フォーム下書きを作成」でフォームを作ってください。',
  DRAFT_FORMS_PREPARED: '公開前の下書きフォームがありません。先に「フォーム下書きを作成」を実行してください。',
  FORMS_PUBLISHED: 'フォームがまだ公開されていません。先に「確認済みフォームを公開」を実行してください。',
  FORM_BUILD_IDLE: 'フォームを作成中です。終わるまで待つか、「途中のフォーム作成を取り消す」を実行してください。',
  FORM_BUILD_ACTIVE: '途中まで進んだフォーム作成がありません。',
  SETTINGS_CHANGE_IDLE: '設定変更中です。先に下書きを作って公開するか、変更を取り消してください。',
  RULE_CHANGE_ACTIVE: 'ルール変更を始めていません。先に「ルール設定だけを変更する」を実行してください。',
  RULE_CHANGE_IDLE: 'ルール変更中です。先に「ルール変更を確定して全申請を再検査」または「ルール変更を取り消す」を実行してください。',
  ROSTER_JOB_IDLE: '選手名簿を作成中です。終わるまで待つか、「途中の名簿作成を取り消す」を実行してください。',
  ROSTER_JOB_ACTIVE: '途中まで進んだ名簿作成がありません。',
  ROSTER_VERSION_EXISTS: 'まだ選手名簿を1度も作成していません。先に「承認済みから選手名簿を作成」を実行してください。',
  SUBMISSIONS_EXIST: 'まだ申請が1件も届いていません。',
  APPROVED_SUBMISSIONS_EXIST: '承認済みの申請がありません。先に申請を承認してください。',
  MOCK_SUBMISSIONS_EXIST: '疑似申請がありません。先に「開発用の疑似データを作る」を実行してください。',
  MOCK_ROSTER_READY: '「疑似申請に使う名簿」で選んだ名簿に生徒がいません。「疑似データの対象範囲を設定」で確認してください。',
  PRODUCTION_MASTER_FILLED: '本番用の「生徒マスター」が空です。先に学籍番号と氏名を入力してください。',
  AUTHORIZED_EDITORS_SET: '先に「担当者アカウントを設定」で操作できるアカウントを登録してください。',
};

export function isFeatureVisible(entry: FeatureEntry, context: FeatureVisibilityContext): boolean {
  switch (entry.visibility) {
    case 'ALWAYS':
      return true;
    case 'DEVELOPMENT_ONLY':
      return context.mode === 'DEVELOPMENT';
    case 'PRODUCTION_ONLY':
      return context.mode === 'PRODUCTION';
    case 'NON_PRACTICE_ONLY':
      return !context.practiceWorkbook;
    default:
      return true;
  }
}

export function evaluateFeature(
  entry: FeatureEntry,
  snapshot: FeatureConditionSnapshot,
): FeatureAvailability {
  const visible = isFeatureVisible(entry, snapshot);
  // 判定できなかった条件は「満たしている」とみなす。調べていないことを理由に操作を止めない。
  const unmet = entry.requires.filter((key) => snapshot.conditions[key] === false);
  return {
    id: entry.id,
    visible,
    enabled: visible && unmet.length === 0,
    unmetConditions: unmet,
    // 理由は先頭の1件だけを出す。まず何をすればよいかを1行で伝えるため。
    blockedReason: unmet.length === 0 ? '' : CONDITION_BLOCKED_MESSAGES[unmet[0]!],
  };
}

export function evaluateCatalog(
  snapshot: FeatureConditionSnapshot,
): readonly FeatureAvailability[] {
  return FEATURE_CATALOG.map((entry) => evaluateFeature(entry, snapshot));
}

export function findAvailability(
  availability: readonly FeatureAvailability[],
  id: string,
): FeatureAvailability | undefined {
  return availability.find((candidate) => candidate.id === id);
}
