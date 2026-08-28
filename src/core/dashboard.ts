import type { Submission, SubmissionStatus } from '../shared/types';

const REVIEWABLE: SubmissionStatus[] = ['PENDING_APPROVAL', 'NEEDS_CORRECTION', 'ON_HOLD'];

export interface ReviewQueueCounts {
  warning: number;
  error: number;
  clear: number;
  hold: number;
  pending: number;
  rejected: number;
  approved: number;
}

export function clearApprovalCandidates(submissions: Submission[]): Submission[] {
  return submissions.filter((submission) =>
    submission.status === 'PENDING_APPROVAL'
    && submission.warningCount === 0
    && submission.errorCount === 0,
  );
}

export function countReviewQueue(submissions: Submission[]): ReviewQueueCounts {
  const reviewable = submissions.filter((submission) => REVIEWABLE.includes(submission.status));
  const active = reviewable.filter((submission) => submission.status !== 'ON_HOLD');
  return {
    warning: active.reduce((total, submission) => total + submission.warningCount, 0),
    error: active.reduce((total, submission) => total + submission.errorCount, 0),
    clear: clearApprovalCandidates(submissions).length,
    hold: reviewable.filter((submission) => submission.status === 'ON_HOLD').length,
    pending: reviewable.length,
    rejected: submissions.filter((submission) => submission.status === 'REJECTED').length,
    approved: submissions.filter((submission) =>
      submission.status === 'APPROVED' || submission.status === 'APPLIED').length,
  };
}
