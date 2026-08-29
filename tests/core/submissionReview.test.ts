import { describe, expect, it } from 'vitest';
import type { RuleSetting, Submission, SubmissionItem, ValidationIssue } from '../../src/shared/types';
import { generateMockStudents } from '../../src/core/mockStudents';
import { validateSubmission } from '../../src/core/validation';
import {
  issueHighlights,
  multiEventStudents,
  reviewSubmission,
  sameEventDuplicates,
} from '../../src/core/submission-review';

const students = generateMockStudents();

function submission(overrides: Partial<Submission> = {}): Submission {
  return {
    submissionId: 'sub-review-001',
    submissionType: 'INITIAL',
    submittedAt: '2026-07-16T12:00:00+09:00',
    submitterStudentId: '1101',
    submitterNameInput: '架空生徒-1年1組01番',
    submitterEmail: 'fictional@example.invalid',
    targetGrade: 1,
    targetClass: 1,
    isProxy: false,
    receptionOpen: true,
    status: 'RECEIVED',
    warningCount: 0,
    errorCount: 0,
    ...overrides,
  };
}

function item(overrides: Partial<SubmissionItem> = {}): SubmissionItem {
  return {
    submissionItemId: 'item-001',
    submissionId: 'sub-review-001',
    eventId: 'event-001',
    eventName: '架空競技A',
    slotId: 'slot-001',
    slotName: '第1走者',
    studentIdInput: '1101',
    studentNameInput: '',
    normalizedStudentId: '',
    normalizedName: '',
    registrationState: 'REGISTER',
    required: true,
    masterName: '架空生徒-1年1組01番',
    masterGender: 'M',
    ...overrides,
  };
}

function issue(overrides: Partial<ValidationIssue> = {}): ValidationIssue {
  return {
    issueId: 'sub-review-001-issue-001',
    submissionId: 'sub-review-001',
    submissionItemId: '',
    severity: 'ERROR',
    issueCode: 'STUDENT_NOT_FOUND',
    displayTitle: '学籍番号が確認できません',
    locationText: '架空競技A / 第1走者',
    currentValue: '9999',
    fixInstruction: '直してください',
    status: 'UNCONFIRMED',
    relatedItemIds: '',
    ...overrides,
  };
}

describe('同一競技内の重複登録', () => {
  it('同じ競技に同じ学籍番号が2回あるとき1組にまとめる', () => {
    const groups = sameEventDuplicates([
      item({ submissionItemId: 'item-001', slotName: '第1走者', studentIdInput: '1101' }),
      item({ submissionItemId: 'item-002', slotName: '第2走者', studentIdInput: '1101' }),
      item({ submissionItemId: 'item-003', slotName: '第3走者', studentIdInput: '1102' }),
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0]?.studentId).toBe('1101');
    expect(groups[0]?.count).toBe(2);
    expect(groups[0]?.badgeLabel).toBe('重複A');
    expect(groups[0]?.slots.map((slot) => slot.slotName)).toEqual(['第1走者', '第2走者']);
  });

  it('全角数字で入力された学籍番号も同じ生徒として数える', () => {
    const groups = sameEventDuplicates([
      item({ submissionItemId: 'item-001', studentIdInput: '1101' }),
      item({ submissionItemId: 'item-002', slotName: '第2走者', studentIdInput: '１１０１' }),
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0]?.count).toBe(2);
  });

  it('競技が違えば重複にしない', () => {
    const groups = sameEventDuplicates([
      item({ submissionItemId: 'item-001', eventId: 'event-001', eventName: '架空競技A' }),
      item({ submissionItemId: 'item-002', eventId: 'event-002', eventName: '架空競技B' }),
    ]);
    expect(groups).toEqual([]);
  });

  it('同姓同名でも学籍番号が違えば重複にしない', () => {
    const groups = sameEventDuplicates([
      item({ submissionItemId: 'item-001', studentIdInput: '1101', masterName: '架空 同名' }),
      item({ submissionItemId: 'item-002', slotName: '第2走者', studentIdInput: '1102', masterName: '架空 同名' }),
    ]);
    expect(groups).toEqual([]);
  });

  it('出場しない枠と調整中の枠は数えない', () => {
    const groups = sameEventDuplicates([
      item({ submissionItemId: 'item-001', studentIdInput: '', registrationState: 'NOT_PARTICIPATING' }),
      item({ submissionItemId: 'item-002', slotName: '第2走者', studentIdInput: '', registrationState: 'NOT_PARTICIPATING' }),
      item({ submissionItemId: 'item-003', slotName: '第3走者', studentIdInput: '1101', registrationState: 'PENDING' }),
      item({ submissionItemId: 'item-004', slotName: '第4走者', studentIdInput: '1101' }),
    ]);
    expect(groups).toEqual([]);
  });

  it('複数の重複組へ別々の目印を付ける', () => {
    const groups = sameEventDuplicates([
      item({ submissionItemId: 'item-001', studentIdInput: '1101' }),
      item({ submissionItemId: 'item-002', slotName: '第2走者', studentIdInput: '1101' }),
      item({ submissionItemId: 'item-003', eventId: 'event-002', eventName: '架空競技B', studentIdInput: '1102' }),
      item({ submissionItemId: 'item-004', eventId: 'event-002', eventName: '架空競技B', slotName: '第2走者', studentIdInput: '1102' }),
    ]);
    expect(groups.map((group) => group.badgeLabel)).toEqual(['重複A', '重複B']);
  });
});

describe('競技をまたいだ出場', () => {
  it('2競技以上に登録された生徒を出場数として返す', () => {
    const list = multiEventStudents([
      item({ submissionItemId: 'item-001', eventId: 'event-001', eventName: '架空競技A', studentIdInput: '1101' }),
      item({ submissionItemId: 'item-002', eventId: 'event-002', eventName: '架空競技B', studentIdInput: '1101' }),
      item({ submissionItemId: 'item-003', eventId: 'event-002', eventName: '架空競技B', slotName: '第2走者', studentIdInput: '1102' }),
    ]);
    expect(list).toHaveLength(1);
    expect(list[0]?.studentId).toBe('1101');
    expect(list[0]?.eventCount).toBe(2);
  });

  it('同じ競技内だけの重複は競技をまたいだ出場に数えない', () => {
    const list = multiEventStudents([
      item({ submissionItemId: 'item-001', studentIdInput: '1101' }),
      item({ submissionItemId: 'item-002', slotName: '第2走者', studentIdInput: '1101' }),
    ]);
    expect(list).toEqual([]);
  });
});

describe('検査結果と選手枠の対応', () => {
  it('申請項目に結び付く検査結果はその枠だけを示す', () => {
    const items = [item({ submissionItemId: 'item-001' }), item({ submissionItemId: 'item-002' })];
    const highlights = issueHighlights(items, [issue({ submissionItemId: 'item-002' })]);
    expect(highlights[0]?.submissionItemIds).toEqual(['item-002']);
    expect(highlights[0]?.eventIds).toEqual([]);
  });

  it('重要度ごとに通し番号を付ける', () => {
    const items = [item()];
    const highlights = issueHighlights(items, [
      issue({ issueId: 'i1', severity: 'WARNING' }),
      issue({ issueId: 'i2', severity: 'ERROR' }),
      issue({ issueId: 'i3', severity: 'WARNING' }),
    ]);
    expect(highlights.map((highlight) => highlight.displayNumber)).toEqual([1, 1, 2]);
  });

  it('申請全体の警告は枠へ結び付けない', () => {
    const items = [item({ submissionItemId: 'item-001' })];
    const highlights = issueHighlights(items, [
      issue({ issueCode: 'MULTIPLE_INITIAL_SUBMISSIONS', severity: 'WARNING', submissionItemId: 'item-001' }),
    ]);
    expect(highlights[0]?.submissionItemIds).toEqual([]);
    expect(highlights[0]?.eventIds).toEqual([]);
  });

  it('論理式ルールの検査結果を判定対象の競技へ結び付ける', () => {
    const items = [
      item({ submissionItemId: 'item-001', eventId: 'event-001', eventName: '架空競技A', studentIdInput: '1101' }),
      item({ submissionItemId: 'item-002', eventId: 'event-001', eventName: '架空競技A', slotName: '第2走者', studentIdInput: '1101' }),
      item({ submissionItemId: 'item-003', eventId: 'event-002', eventName: '架空競技B', studentIdInput: '1102' }),
    ];
    const rule: RuleSetting = {
      ruleId: 'R-DUP', enabled: true, ruleName: '同じ競技で重複させない', target: '全競技',
      targetEventIds: '', condition: '', limit: Number.NaN, judgment: 'エラー',
      displayMessage: '同じ競技に同じ選手を登録できません', note: '', expression: 'MAX_PER_EVENT <= 1',
    };
    const result = validateSubmission(submission(), items, {
      students, sameClassInitialSubmissionCount: 1, rules: [rule],
    });
    const ruleIssue = result.issues.find((candidate) => candidate.issueCode === 'RULE_EXPRESSION_FALSE');
    expect(ruleIssue).toBeDefined();
    const highlights = issueHighlights(items, result.issues);
    const ruleHighlight = highlights.find((highlight) => highlight.issueId === ruleIssue?.issueId);
    expect(ruleHighlight?.eventIds).toEqual(['event-001', 'event-002']);
  });

  it('欠員警告を対象の競技へ結び付ける', () => {
    const items = [
      item({ submissionItemId: 'item-001', required: false, studentIdInput: '', registrationState: 'NOT_PARTICIPATING' }),
      item({ submissionItemId: 'item-002', required: false, slotName: '第2走者', studentIdInput: '', registrationState: 'NOT_PARTICIPATING' }),
    ];
    const result = validateSubmission(submission(), items, { students, sameClassInitialSubmissionCount: 1 });
    const vacancy = result.issues.find((candidate) => candidate.issueCode === 'VACANCY_CAPACITY_SHORTFALL');
    expect(vacancy).toBeDefined();
    const highlights = issueHighlights(items, result.issues);
    const vacancyHighlight = highlights.find((highlight) => highlight.issueId === vacancy?.issueId);
    expect(vacancyHighlight?.submissionItemIds).toEqual(['item-001', 'item-002']);
    expect(vacancyHighlight?.eventIds).toEqual([]);
  });

  it('枠名を特定できない検査結果は競技単位で示す', () => {
    const items = [item({ submissionItemId: 'item-001', eventId: 'event-001', eventName: '架空競技A' })];
    const highlights = issueHighlights(items, [
      issue({ submissionItemId: '', locationText: '架空競技A / 存在しない枠' }),
    ]);
    expect(highlights[0]?.submissionItemIds).toEqual([]);
    expect(highlights[0]?.eventIds).toEqual(['event-001']);
  });
});

describe('reviewSubmission', () => {
  it('重複・出場数・対応表をまとめて返す', () => {
    const items = [
      item({ submissionItemId: 'item-001', studentIdInput: '1101' }),
      item({ submissionItemId: 'item-002', slotName: '第2走者', studentIdInput: '1101' }),
      item({ submissionItemId: 'item-003', eventId: 'event-002', eventName: '架空競技B', studentIdInput: '1101' }),
    ];
    const review = reviewSubmission(items, [issue({ submissionItemId: 'item-001' })]);
    expect(review.sameEventDuplicates).toHaveLength(1);
    expect(review.multiEventStudents).toHaveLength(1);
    expect(review.issueHighlights).toHaveLength(1);
  });
});
