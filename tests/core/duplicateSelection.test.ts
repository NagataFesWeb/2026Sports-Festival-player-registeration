import { describe, expect, it } from 'vitest';
import { affectedSubmissionIds, duplicateCandidates } from '../../src/core/duplicate-selection';
import type { Submission } from '../../src/shared/types';

const submission = (id: string, values: Partial<Submission> = {}): Submission => ({
  submissionId: id, submissionType: 'INITIAL', submittedAt: `2026-07-17T00:0${id.slice(-1)}:00.000Z`,
  submitterStudentId: '1101', submitterNameInput: '架空生徒', submitterEmail: '',
  targetGrade: 1, targetClass: 1, isProxy: false, receptionOpen: true,
  status: 'PENDING_APPROVAL', warningCount: 1, errorCount: 0, ...values,
});

describe('重複回答の採用候補', () => {
  it('同じクラスの有効な初回回答だけを新しい順に返す', () => {
    const target = submission('answer-1');
    const result = duplicateCandidates([
      target,
      submission('answer-2'),
      submission('answer-3', { status: 'REJECTED' }),
      submission('answer-4', { targetClass: 2 }),
      submission('answer-5', { submissionType: 'CORRECTION' }),
    ], target);
    expect(result.map((candidate) => candidate.submissionId)).toEqual(['answer-2', 'answer-1']);
  });

  it('変更した初回回答と同じクラスだけを再検査対象にする', () => {
    const submissions = [
      submission('answer-1'),
      submission('answer-2'),
      submission('answer-3', { targetClass: 2 }),
    ];
    expect(new Set(affectedSubmissionIds(submissions, ['answer-1'])))
      .toEqual(new Set(['answer-1', 'answer-2']));
    expect(affectedSubmissionIds(submissions, ['answer-3'])).toEqual(['answer-3']);
  });

  it('同じクラスの未登録の登録申請と修正申請は、互いに再検査対象へ含める', () => {
    // 片方の内容が変わると、もう片方の「枠が重なっています」警告も変わる。
    const submissions = [
      submission('answer-1'),
      submission('answer-2'),
      submission('answer-3', { targetClass: 2 }),
      submission('answer-4', { submissionType: 'CORRECTION' }),
    ];
    expect(new Set(affectedSubmissionIds(submissions, ['answer-4'])))
      .toEqual(new Set(['answer-4', 'answer-1', 'answer-2']));
    expect(new Set(affectedSubmissionIds(submissions, ['answer-1'])))
      .toEqual(new Set(['answer-1', 'answer-2', 'answer-4']));
    // 登録済みのクラスは突き合わせの相手にならない。
    const registered = submissions.map((candidate) => candidate.submissionType === 'INITIAL'
      ? { ...candidate, status: 'APPLIED' as const }
      : candidate);
    expect(affectedSubmissionIds(registered, ['answer-4'])).toEqual(['answer-4']);
  });
});
