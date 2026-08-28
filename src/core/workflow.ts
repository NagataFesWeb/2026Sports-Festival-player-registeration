import type { Submission, SubmissionStatus, ValidationResult } from '../shared/types';

export type SubmissionAction = 'APPROVE' | 'HOLD' | 'REJECT' | 'RESUME' | 'RESTORE' | 'REOPEN_APPROVED';

const REVIEWABLE: SubmissionStatus[] = ['PENDING_APPROVAL', 'NEEDS_CORRECTION', 'ON_HOLD'];
const TERMINAL: SubmissionStatus[] = ['APPROVED', 'APPLIED', 'REJECTED', 'CORRECTION_REQUESTED'];

export function assertActionAllowed(
  submission: Submission,
  action: SubmissionAction,
  reason: string,
  validation?: ValidationResult,
): void {
  if (action === 'REOPEN_APPROVED') {
    if (submission.status !== 'APPROVED' && submission.status !== 'APPLIED') {
      throw new Error('承認済みまたは名簿反映済みの申請だけを確認待ちへ戻せます。');
    }
    if (reason.trim() === '') {
      throw new Error('承認済み申請を戻す理由を入力してください。');
    }
    return;
  }
  if (action === 'RESTORE') {
    if (submission.status !== 'REJECTED') {
      throw new Error('却下済みの申請だけを確認待ちへ戻せます。');
    }
    if (reason.trim() === '') {
      throw new Error('却下済み申請を戻す理由を入力してください。');
    }
    return;
  }
  if (TERMINAL.includes(submission.status)) {
    throw new Error('この申請はすでに処理済みです。一覧を開き直して状態を確認してください。');
  }
  if (action === 'REJECT' && reason.trim() === '') {
    throw new Error('却下する理由を入力してください。申請者が次に直せる内容を具体的に書いてください。');
  }
  if (action === 'APPROVE') {
    if (submission.status !== 'PENDING_APPROVAL') {
      throw new Error('この申請は承認待ちではありません。状態を確認してから操作してください。');
    }
    if ((validation?.errorCount ?? submission.errorCount) > 0) {
      throw new Error(`エラーが${validation?.errorCount ?? submission.errorCount}件あるため承認できません。詳細を開き、入力内容を修正してください。`);
    }
    if ((validation?.warningCount ?? submission.warningCount) > 0 && reason.trim() === '') {
      throw new Error('警告付きの申請を承認する理由を入力してください。確認した内容が後から分かるように具体的に書いてください。');
    }
    if (validation?.nextStatus === 'ON_HOLD') {
      throw new Error('受付停止中の修正申請は承認できません。保留のまま内容を確認してください。');
    }
  }
  if (action === 'HOLD' && !REVIEWABLE.includes(submission.status)) {
    throw new Error('この申請は保留にできません。一覧を開き直して状態を確認してください。');
  }
  if (action === 'HOLD' && submission.status === 'ON_HOLD') {
    throw new Error('この申請はすでに保留中です。続けて同じ操作はできません。');
  }
  if (action === 'RESUME' && submission.status !== 'ON_HOLD') {
    throw new Error('保留中の申請だけ確認を再開できます。');
  }
  if (action === 'REJECT' && !REVIEWABLE.includes(submission.status)) {
    throw new Error('この申請は現在の状態では処理できません。一覧を開き直して確認してください。');
  }
}

export function nextStatusForAction(
  action: SubmissionAction,
  validation?: ValidationResult,
): SubmissionStatus {
  if (action === 'APPROVE') return 'APPROVED';
  if (action === 'HOLD') return 'ON_HOLD';
  if (action === 'REJECT') return 'REJECTED';
  if (action === 'RESTORE') return validation?.nextStatus ?? 'PENDING_APPROVAL';
  if (action === 'REOPEN_APPROVED') return validation?.nextStatus ?? 'PENDING_APPROVAL';
  return validation?.nextStatus ?? 'PENDING_APPROVAL';
}
