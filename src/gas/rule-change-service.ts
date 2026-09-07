import { SHEETS } from '../shared/constants';
import type { Submission } from '../shared/types';
import { assertAuthorized } from './auth-service';
import { readSubmissions } from './repository';
import { revalidateAllSubmissionsWithinLock } from './service';
import { validateAndRenderSettings } from './settings-service';
import {
  beginRuleOnlyChange,
  cancelRuleOnlyChange,
  completeRuleOnlyChange,
  isRuleOnlyChangeActive,
} from './settings-change-service';
import { invalidateSheetCache } from './sheet-cache';

const DECIDED: Submission['status'][] = ['APPROVED', 'APPLIED'];

export interface RuleChangeStartResult {
  message: string;
}

export interface RuleChangeApplyResult {
  ruleSettingsChanged: boolean;
  recheckedSubmissions: number;
  errorSubmissions: number;
  warningSubmissions: number;
  decidedWithErrors: number;
  message: string;
}

/** 受付を止めずに`ルール設定`だけを編集できる状態にする。 */
export function startRuleOnlyChange(reason: string): RuleChangeStartResult {
  beginRuleOnlyChange(reason);
  return {
    message: '「ルール設定を開く」から論理式を直してください。公開中のフォームは受付を続け、フォームは作り直しません。'
      + '\n\n直し終えたら「ルール変更を確定して全申請を再検査」を実行すると、受信済みの申請を新しいルールで検査し直します。',
  };
}

/**
 * 編集したルールを確定し、受信済みの全申請を新しいルールで検査し直す。
 * 承認済み・反映済みの申請は状態を変えず、警告・エラー件数だけを更新する。
 */
export function applyRuleOnlyChange(): RuleChangeApplyResult {
  // ルールの確定と全再検査を1つのロックの中で行う。受付を止めないまま実行するため、
  // 途中で届いたフォーム回答が古い内容で上書きされないようにする。
  const lock = LockService.getDocumentLock();
  if (!lock.tryLock(30_000)) throw new Error('ほかの担当者が処理中です。少し待ってから、もう一度実行してください。');
  // ロックを取った直後は、ほかの担当者やトリガーが書いた内容を必ず読み直す。
  invalidateSheetCache();
  try {
    return applyRuleOnlyChangeWithinLock();
  } finally {
    lock.releaseLock();
  }
}

function applyRuleOnlyChangeWithinLock(): RuleChangeApplyResult {
  assertAuthorized();
  if (!isRuleOnlyChangeActive()) {
    throw new Error('ルール設定の変更は始まっていません。先に「ルール設定だけを変更する」を実行してください。');
  }
  const settings = validateAndRenderSettings();
  if (settings.ruleErrorCount > 0) {
    throw new Error(
      `${SHEETS.ruleSettings}にエラーが${settings.ruleErrorCount}件あります。`
      + `「${SHEETS.settingsIssues}」シートの直し方に従って直してから、もう一度実行してください。`,
    );
  }
  const { ruleSettingsChanged } = completeRuleOnlyChange();
  revalidateAllSubmissionsWithinLock();
  const submissions = readSubmissions();
  const errorSubmissions = submissions.filter((submission) => submission.errorCount > 0).length;
  const warningSubmissions = submissions.filter((submission) =>
    submission.errorCount === 0 && submission.warningCount > 0).length;
  const decidedWithErrors = submissions.filter((submission) =>
    DECIDED.includes(submission.status) && submission.errorCount > 0).length;
  const headline = ruleSettingsChanged
    ? `新しいルールで申請${submissions.length}件を検査し直しました。`
    : `ルールの変更はありませんでした。申請${submissions.length}件を検査し直しました。`;
  const counts = `エラーがある申請${errorSubmissions}件、警告だけの申請${warningSubmissions}件です。`;
  const decidedNote = decidedWithErrors > 0
    ? `\n\n承認済み・名簿反映済みの申請のうち${decidedWithErrors}件が新しいルールでエラーになりました。`
      + '状態は変えていません。「状態別に開く」→「承認済みの申請」から内容を確認し、'
      + '必要なら「承認を取り消して確認待ちに戻す」で直してください。'
      + 'エラーが残っている間は選手名簿を作成できません。'
    : '';
  return {
    ruleSettingsChanged,
    recheckedSubmissions: submissions.length,
    errorSubmissions,
    warningSubmissions,
    decidedWithErrors,
    message: `${headline}${counts}${decidedNote}`,
  };
}

/** 編集途中のルールを、変更を始めた時点の内容へ戻す。 */
export function abortRuleOnlyChange(): RuleChangeStartResult {
  cancelRuleOnlyChange();
  return { message: 'ルール設定を変更前の内容へ戻しました。申請の検査結果は変わっていません。' };
}

export { isRuleOnlyChangeActive };
