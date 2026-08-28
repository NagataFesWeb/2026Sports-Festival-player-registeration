import { describe, expect, it } from 'vitest';
import type { Submission } from '../../src/shared/types';
import { clearApprovalCandidates, countReviewQueue } from '../../src/core/dashboard';

function submission(
  id: string,
  warningCount: number,
  errorCount: number,
  status: Submission['status'] = 'PENDING_APPROVAL',
): Submission {
  return {
    submissionId: id,
    submissionType: 'INITIAL',
    submittedAt: '2026-07-17T00:00:00.000Z',
    submitterStudentId: '1101',
    submitterNameInput: '架空生徒',
    submitterEmail: 'mock@example.invalid',
    targetGrade: 1,
    targetClass: 1,
    isProxy: false,
    receptionOpen: true,
    status,
    warningCount,
    errorCount,
  };
}

describe('確認待ち件数', () => {
  it('警告とエラーは申請数ではなく問題件数を合計する', () => {
    const result = countReviewQueue([
      submission('a', 2, 1),
      submission('b', 3, 0),
      submission('c', 0, 0),
    ]);
    expect(result).toEqual({ warning: 5, error: 1, clear: 1, hold: 0, pending: 3, rejected: 0, approved: 0 });
  });

  it('保留中と処理済みは警告・エラー件数から除外する', () => {
    const result = countReviewQueue([
      submission('hold', 4, 2, 'ON_HOLD'),
      submission('done', 8, 3, 'APPROVED'),
      submission('applied', 0, 0, 'APPLIED'),
    ]);
    expect(result).toEqual({ warning: 0, error: 0, clear: 0, hold: 1, pending: 1, rejected: 0, approved: 2 });
  });

  it('一括承認候補は警告0・エラー0の承認待ちだけにする', () => {
    const result = clearApprovalCandidates([
      submission('clear', 0, 0),
      submission('warning', 1, 0),
      submission('error', 0, 1),
      submission('hold', 0, 0, 'ON_HOLD'),
      submission('done', 0, 0, 'APPROVED'),
    ]);
    expect(result.map((value) => value.submissionId)).toEqual(['clear']);
  });
});
