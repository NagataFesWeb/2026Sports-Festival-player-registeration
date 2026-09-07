import { overlapPartnerIds } from './correction-comparison';
import type { Submission } from '../shared/types';

export function duplicateCandidates(
  submissions: Submission[],
  target: Submission,
): Submission[] {
  if (target.submissionType !== 'INITIAL') return [];
  return submissions
    .filter((candidate) => candidate.submissionType === 'INITIAL')
    .filter((candidate) => candidate.targetGrade === target.targetGrade && candidate.targetClass === target.targetClass)
    .filter((candidate) => candidate.status !== 'REJECTED' && candidate.status !== 'CORRECTION_REQUESTED')
    .sort((a, b) => b.submittedAt.localeCompare(a.submittedAt));
}

export function affectedSubmissionIds(
  submissions: Submission[],
  requestedIds: string[],
): string[] {
  const affected = new Set(requestedIds.filter(Boolean));
  // 突き合わせの相手を先に足す。片方を直したのに、もう片方の警告が古いままにならないようにする。
  submissions.filter((submission) => affected.has(submission.submissionId))
    .forEach((target) =>
      overlapPartnerIds(submissions, target).forEach((id) => affected.add(id)));
  // そのうえで、同じクラスの初回回答をまとめて検査し直す。重複警告が変わるため。
  submissions.filter((submission) => affected.has(submission.submissionId))
    .filter((submission) => submission.submissionType === 'INITIAL')
    .forEach((target) => submissions
      .filter((candidate) => candidate.submissionType === 'INITIAL')
      .filter((candidate) =>
        candidate.targetGrade === target.targetGrade && candidate.targetClass === target.targetClass)
      .forEach((candidate) => affected.add(candidate.submissionId)));
  return [...affected];
}
