import { describe, expect, it } from 'vitest';
import type { Submission, ValidationResult } from '../../src/shared/types';
import { assertActionAllowed, nextStatusForAction } from '../../src/core/workflow';

function submission(status: Submission['status'] = 'PENDING_APPROVAL'): Submission {
  return {
    submissionId: 'mock-workflow-01', submissionType: 'INITIAL',
    submittedAt: '2026-07-16T00:00:00.000Z', submitterStudentId: '1101',
    submitterNameInput: '架空生徒', submitterEmail: 'mock@example.invalid',
    targetGrade: 1, targetClass: 1, isProxy: false, receptionOpen: true,
    status, warningCount: 0, errorCount: 0,
  };
}

function validation(errorCount = 0, nextStatus: ValidationResult['nextStatus'] = 'PENDING_APPROVAL'): ValidationResult {
  return { normalizedItems: [], issues: [], warningCount: 0, errorCount, nextStatus };
}

describe('申請の状態操作', () => {
  it('エラー0件の承認だけをAPPROVEDにできる', () => {
    expect(() => assertActionAllowed(submission(), 'APPROVE', '', validation())).not.toThrow();
    expect(nextStatusForAction('APPROVE', validation())).toBe('APPROVED');
    expect(() => assertActionAllowed(submission(), 'APPROVE', '', validation(1, 'NEEDS_CORRECTION'))).toThrow('承認できません');
  });

  it('受付停止中の修正申請は承認できない', () => {
    expect(() => assertActionAllowed(submission(), 'APPROVE', '', validation(0, 'ON_HOLD'))).toThrow('受付停止中');
  });

  it('警告付き申請の承認は理由を必須にする', () => {
    const warningValidation = { ...validation(), warningCount: 1 };
    expect(() => assertActionAllowed(submission(), 'APPROVE', '  ', warningValidation)).toThrow('理由');
    expect(() => assertActionAllowed(
      submission(), 'APPROVE', '欠員で正しいことを担当者へ確認済み', warningValidation,
    )).not.toThrow();
  });

  it('REJECTは理由を必須にする', () => {
    expect(() => assertActionAllowed(submission(), 'REJECT', '  ')).toThrow();
    expect(() => assertActionAllowed(submission(), 'REJECT', '入力箇所を確認してください')).not.toThrow();
  });

  it('保留と確認再開の遷移を制限する', () => {
    expect(nextStatusForAction('HOLD')).toBe('ON_HOLD');
    expect(() => assertActionAllowed(submission('ON_HOLD'), 'HOLD', '')).toThrow('すでに保留中');
    expect(() => assertActionAllowed(submission(), 'RESUME', '')).toThrow('保留中');
    expect(() => assertActionAllowed(submission('ON_HOLD'), 'RESUME', '', validation())).not.toThrow();
    expect(nextStatusForAction('RESUME', validation(2, 'NEEDS_CORRECTION'))).toBe('NEEDS_CORRECTION');
  });

  it('処理済み申請への二重操作を拒否する', () => {
    expect(() => assertActionAllowed(submission('APPROVED'), 'HOLD', '')).toThrow('処理済み');
  });

  it('却下済み申請だけを理由付きで再検査状態へ戻せる', () => {
    expect(() => assertActionAllowed(submission('REJECTED'), 'RESTORE', '')).toThrow('理由');
    expect(() => assertActionAllowed(submission('REJECTED'), 'RESTORE', '誤って却下したため', validation())).not.toThrow();
    expect(nextStatusForAction('RESTORE', validation(1, 'NEEDS_CORRECTION'))).toBe('NEEDS_CORRECTION');
    expect(() => assertActionAllowed(submission(), 'RESTORE', '戻す')).toThrow('却下済み');
  });

  it('名簿未反映の承認済み申請だけを理由付きで確認待ちへ戻せる', () => {
    expect(() => assertActionAllowed(submission('APPROVED'), 'REOPEN_APPROVED', '')).toThrow('理由');
    expect(() => assertActionAllowed(
      submission('APPROVED'), 'REOPEN_APPROVED', '承認内容を再確認するため', validation(),
    )).not.toThrow();
    expect(nextStatusForAction('REOPEN_APPROVED', validation(1, 'NEEDS_CORRECTION'))).toBe('NEEDS_CORRECTION');
    expect(() => assertActionAllowed(
      submission('APPLIED'), 'REOPEN_APPROVED', '登録内容を再確認するため', validation(),
    )).not.toThrow();
  });
});
