import { describe, expect, it } from 'vitest';
import { issueHighlights } from '../../src/core/submission-review';
import { ISSUE_CODES, validateSubmission } from '../../src/core/validation';
import type { RuleSetting, Student, Submission, SubmissionItem } from '../../src/shared/types';

// 設定シートの競技名は末尾に空白が入っていることがある。照合はそれでも通らなければならない。
const RELAY = '女子６×100ｍリレー ';

const students: Student[] = [
  { studentId: '1101', grade: 1, classNumber: 1, attendanceNumber: 1, name: '架空01', gender: 'M' },
  { studentId: '1102', grade: 1, classNumber: 1, attendanceNumber: 2, name: '架空02', gender: 'F' },
  { studentId: '1103', grade: 1, classNumber: 1, attendanceNumber: 3, name: '架空03', gender: 'M' },
  { studentId: '1104', grade: 1, classNumber: 1, attendanceNumber: 4, name: '架空04', gender: 'F' },
];

const submission: Submission = {
  submissionId: 'sub-1', submissionType: 'INITIAL', submittedAt: '2026-07-01T00:00:00.000Z',
  submitterStudentId: '1101', submitterNameInput: '架空01', submitterEmail: 'a@example.invalid',
  targetGrade: 1, targetClass: 1, isProxy: false, receptionOpen: true,
  status: 'RECEIVED', warningCount: 0, errorCount: 0,
};

function item(slot: number, studentId: string): SubmissionItem {
  return {
    submissionItemId: `sub-1-item-${String(slot).padStart(3, '0')}`,
    submissionId: 'sub-1', eventId: 'E000', eventName: RELAY,
    slotId: `E000-slot-0${slot}`, slotName: `第${slot}走者`,
    studentIdInput: studentId, studentNameInput: '',
    normalizedStudentId: '', normalizedName: '',
    registrationState: 'REGISTER', required: true,
  };
}

function rule(judgment: RuleSetting['judgment'], expression: string, message: string): RuleSetting {
  return {
    ruleId: 'R000', enabled: true, ruleName: 'テストルール', target: '指定競技',
    targetEventIds: 'E000', condition: '', limit: 0, judgment,
    displayMessage: message, note: '', expression,
  };
}

function highlightFor(items: SubmissionItem[], rules: RuleSetting[]): {
  itemIds: string[];
  eventIds: string[];
  fixInstruction: string;
} {
  const validation = validateSubmission(submission, items, {
    students, sameClassInitialSubmissionCount: 1, rules,
  });
  const issue = validation.issues.find((candidate) =>
    candidate.issueCode === ISSUE_CODES.RULE_EXPRESSION_FALSE);
  if (!issue) throw new Error('論理式の検査結果が出ていません');
  const highlight = issueHighlights(validation.normalizedItems, validation.issues)
    .find((candidate) => candidate.issueId === issue.issueId)!;
  return {
    itemIds: highlight.submissionItemIds,
    eventIds: highlight.eventIds,
    fixInstruction: issue.fixInstruction,
  };
}

describe('論理式ルールの「直す枠」', () => {
  it('名簿に無い学籍番号を1件だけ指し、競技名に末尾の空白があっても競技を見つける', () => {
    const items = [item(1, '1102'), item(2, '1104'), item(3, '1199')];
    const result = highlightFor(items, [rule('警告', 'UNKNOWN == 0', '学籍番号が確認できません')]);
    expect(result.itemIds).toEqual(['sub-1-item-003']);
    // 周りの登録を並べるため、競技も同時に示す。
    expect(result.eventIds).toEqual(['E000']);
    expect(result.fixInstruction).toContain('直す枠');
    expect(result.fixInstruction).toContain('第3走者');
  });

  it('女子限定の競技に男子が複数いるときは、男子の枠をすべて指す', () => {
    const items = [item(1, '1102'), item(2, '1101'), item(3, '1104'), item(4, '1103')];
    const result = highlightFor(items, [rule('エラー', 'MALE == 0', 'この競技は女子のみ出場可能です')]);
    expect(result.itemIds).toEqual(['sub-1-item-002', 'sub-1-item-004']);
  });

  it('同性で構成するルールでは、少数派の枠だけを指す', () => {
    const items = [item(1, '1102'), item(2, '1104'), item(3, '1101')];
    const result = highlightFor(items, [rule('エラー', 'MALE == 0 OR FEMALE == 0', '同性で構成してください')]);
    expect(result.itemIds).toEqual(['sub-1-item-003']);
  });

  it('同じ生徒の重複では、2件目の枠を指す', () => {
    const items = [item(1, '1102'), item(2, '1102'), item(3, '1104')];
    const result = highlightFor(items, [rule('エラー', 'MAX_PER_EVENT <= 1', '同じ選手が重複しています')]);
    expect(result.itemIds).toEqual(['sub-1-item-002']);
  });

  it('人数が足りない種類のルールは枠を絞らず、競技全体を示す', () => {
    const items = [item(1, '1102'), item(2, '1104')];
    const result = highlightFor(items, [rule('エラー', 'MALE >= 1 && FEMALE >= 1', '男女各１名以上入れてください')]);
    expect(result.itemIds).toEqual([]);
    expect(result.eventIds).toEqual(['E000']);
    expect(result.fixInstruction).toContain('足りない条件');
  });

  it('欠員警告も、競技名に末尾の空白があるまま枠を指す', () => {
    const items = [
      item(1, '1102'),
      { ...item(2, ''), required: false, registrationState: 'NOT_PARTICIPATING' as const },
    ];
    const validation = validateSubmission(submission, items, {
      students, sameClassInitialSubmissionCount: 1,
    });
    const issue = validation.issues.find((candidate) =>
      candidate.issueCode === ISSUE_CODES.VACANCY_CAPACITY_SHORTFALL)!;
    const highlight = issueHighlights(validation.normalizedItems, validation.issues)
      .find((candidate) => candidate.issueId === issue.issueId)!;
    expect(highlight.submissionItemIds).toEqual(['sub-1-item-002']);
  });
});
