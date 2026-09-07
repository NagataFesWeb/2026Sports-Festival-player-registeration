import { describe, expect, it } from 'vitest';
import {
  buildCorrectionOverlap,
  openCorrectionsFor,
  openInitialFor,
  overlapPartnerIds,
} from '../../src/core/correction-comparison';
import { ISSUE_CODES, validateSubmission } from '../../src/core/validation';
import type {
  Registration,
  Student,
  Submission,
  SubmissionItem,
  ValidationIssue,
} from '../../src/shared/types';

const students: Student[] = [
  { studentId: '1101', grade: 1, classNumber: 1, attendanceNumber: 1, name: '架空01', gender: 'M' },
  { studentId: '1102', grade: 1, classNumber: 1, attendanceNumber: 2, name: '架空02', gender: 'F' },
  { studentId: '1104', grade: 1, classNumber: 1, attendanceNumber: 4, name: '架空04', gender: 'F' },
];

function submission(id: string, values: Partial<Submission> = {}): Submission {
  return {
    submissionId: id, submissionType: 'INITIAL', submittedAt: '2026-07-01T00:00:00.000Z',
    submitterStudentId: '1101', submitterNameInput: '架空01', submitterEmail: '',
    targetGrade: 1, targetClass: 1, isProxy: false, receptionOpen: true,
    status: 'NEEDS_CORRECTION', warningCount: 0, errorCount: 0, ...values,
  };
}

function item(submissionId: string, slot: number, studentIdInput: string, values: Partial<SubmissionItem> = {}): SubmissionItem {
  return {
    submissionItemId: `${submissionId}-item-${slot}`,
    submissionId, eventId: 'E000', eventName: '女子リレー',
    slotId: `E000-slot-0${slot}`, slotName: `第${slot}走者`,
    studentIdInput, studentNameInput: '',
    normalizedStudentId: '', normalizedName: '',
    registrationState: 'REGISTER', required: true, ...values,
  };
}

const INITIAL = submission('init-1');
const CORRECTION = submission('corr-1', {
  submissionType: 'CORRECTION', submittedAt: '2026-07-02T00:00:00.000Z',
  status: 'PENDING_APPROVAL',
});

describe('登録申請と修正申請の突き合わせ', () => {
  it('まだ登録していない登録申請を、修正申請の比較相手として見つける', () => {
    const all = [INITIAL, CORRECTION];
    expect(openInitialFor(all, CORRECTION)?.submissionId).toBe('init-1');
    expect(openCorrectionsFor(all, INITIAL).map((c) => c.submissionId)).toEqual(['corr-1']);
    expect(overlapPartnerIds(all, CORRECTION)).toEqual(['init-1']);
    expect(overlapPartnerIds(all, INITIAL)).toEqual(['corr-1']);
  });

  it('登録済み・却下済みの登録申請は比較相手にしない', () => {
    ([['APPLIED'], ['APPROVED'], ['REJECTED']] as const).forEach(([status]) => {
      const all = [submission('init-1', { status }), CORRECTION];
      expect(openInitialFor(all, CORRECTION)).toBeUndefined();
    });
  });

  it('エラーになっている枠を示し、内容が違う枠だけを「違う」と数える', () => {
    // 登録申請は第1走者が書式違反でエラー。第2走者は修正申請と同じ内容。
    const initialItems = [
      item('init-1', 1, '9999'),
      item('init-1', 2, '1102'),
      item('init-1', 3, '1104'),
    ];
    const validation = validateSubmission(INITIAL, initialItems, {
      students, sameClassInitialSubmissionCount: 1,
    });
    const overlap = buildCorrectionOverlap({
      correction: CORRECTION,
      correctionItems: [
        item('corr-1', 1, '1101'),
        item('corr-1', 2, '1102'),
        item('corr-1', 3, '', { registrationState: 'NOT_PARTICIPATING', required: false }),
      ],
      base: { submission: INITIAL, items: validation.normalizedItems, issues: validation.issues },
      registrations: [],
      students,
    })!;
    expect(overlap.baseKind).toBe('OPEN_INITIAL');
    expect(overlap.canImport).toBe(true);
    expect(overlap.changedCount).toBe(2);
    expect(overlap.baseErrorCount).toBe(1);

    const first = overlap.rows[0]!;
    expect(first.baseHasError).toBe(true);
    expect(first.baseStudentId).toBe('9999');
    expect(first.correctionStudentId).toBe('1101');
    expect(first.correctionStudentName).toBe('架空01');
    expect(first.baseItemId).toBe('init-1-item-1');
    expect(overlap.rows[1]!.changed).toBe(false);
    // 「出場しない」への変更も食い違いとして出す。
    expect(overlap.rows[2]!.changed).toBe(true);
    expect(overlap.rows[2]!.correctionState).toBe('NOT_PARTICIPATING');
  });

  it('登録済みのクラスでは、登録データと突き合わせて取り込みは行わない', () => {
    const registrations: Registration[] = [{
      registrationId: 'REG-1-1-E000-slot01', sourceSubmissionId: 'init-1',
      eventId: 'E000', eventName: '女子リレー', slotId: 'E000-slot-01', slotName: '第1走者',
      studentId: '1102', studentNameSnapshot: '架空02', grade: 1, classNumber: 1,
      version: 'v1', updatedAt: '2026-07-01T00:00:00.000Z', updatedBy: 'a@example.invalid',
      genderSnapshot: 'F',
    }];
    const overlap = buildCorrectionOverlap({
      correction: CORRECTION,
      correctionItems: [item('corr-1', 1, '1104')],
      registrations,
      students,
      registrationStaleMessage: '配布用名簿は旧版です。',
    })!;
    expect(overlap.baseKind).toBe('REGISTRATION');
    expect(overlap.canImport).toBe(false);
    expect(overlap.baseSubmissionId).toBe('');
    expect(overlap.rows[0]!.baseStudentId).toBe('1102');
    expect(overlap.rows[0]!.baseStudentName).toBe('架空02');
    expect(overlap.rows[0]!.correctionStudentId).toBe('1104');
    expect(overlap.rows[0]!.changed).toBe(true);
    // 登録データが古い可能性はそのまま伝える。
    expect(overlap.baseStaleMessage).toBe('配布用名簿は旧版です。');
  });

  it('登録済みの競技に触れていない修正申請は突き合わせない', () => {
    const overlap = buildCorrectionOverlap({
      correction: CORRECTION,
      correctionItems: [item('corr-1', 1, '1104', { eventId: 'E900', slotId: 'E900-slot-01' })],
      registrations: [],
      students,
    });
    expect(overlap).toBeUndefined();
  });

  it('食い違いがあるときは、両方の申請へ警告を出す', () => {
    const initialItems = [item('init-1', 1, '9999')];
    const result = validateSubmission(INITIAL, initialItems, {
      students,
      sameClassInitialSubmissionCount: 1,
      overlappingSubmission: {
        submissionId: 'corr-1', submissionType: 'CORRECTION',
        submittedAt: CORRECTION.submittedAt, changedSlotCount: 1,
      },
    });
    const issue = result.issues.find((candidate) =>
      candidate.issueCode === ISSUE_CODES.OVERLAPPING_SUBMISSION) as ValidationIssue;
    expect(issue.severity).toBe('WARNING');
    expect(issue.currentValue).toContain('あとから届いた修正申請');
    expect(issue.currentValue).toContain('corr-1');
    expect(issue.locationText).toBe('登録申請と修正申請の突き合わせ');
  });
});
