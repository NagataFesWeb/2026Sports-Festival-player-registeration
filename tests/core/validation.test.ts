import { describe, expect, it } from 'vitest';
import type { Submission, SubmissionItem, ValidationResult } from '../../src/shared/types';
import { generateMockStudents } from '../../src/core/mockStudents';
import { normalizeName, normalizeStudentId } from '../../src/core/normalization';
import { ISSUE_CODES, validateSubmission } from '../../src/core/validation';

const students = generateMockStudents();

function submission(overrides: Partial<Submission> = {}): Submission {
  return {
    submissionId: 'sub-test-001',
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
    submissionId: 'sub-test-001',
    eventId: 'event-001',
    eventName: '架空競技',
    slotId: 'slot-001',
    slotName: '第1走者',
    studentIdInput: '1101',
    studentNameInput: '架空生徒-1年1組01番',
    normalizedStudentId: '',
    normalizedName: '',
    registrationState: 'REGISTER',
    required: true,
    ...overrides,
  };
}

function validate(
  submissionValue = submission(),
  itemValues = [item()],
  sameClassInitialSubmissionCount = 1,
): ValidationResult {
  return validateSubmission(submissionValue, itemValues, { students, sameClassInitialSubmissionCount });
}

describe('normalization', () => {
  it('全角数字と空白を半角4桁へ正規化する', () => {
    expect(normalizeStudentId(' １ １\u3000０１ ')).toBe('1101');
  });

  it('氏名をNFKC化して全空白を除去する', () => {
    expect(normalizeName(' 架空\u3000生徒－１ ')).toBe('架空生徒-1');
  });

  it('生徒マスターの字間空白とゼロ幅空白を無視する', () => {
    expect(normalizeName('神\u3000山\u3000瑠\u3000星')).toBe('神山瑠星');
    expect(normalizeName('神\u200B山 瑠\t星')).toBe('神山瑠星');
  });
});

describe('validateSubmission', () => {
  it('正常な回答は承認待ちになる', () => {
    const result = validate();
    expect(result.issues).toEqual([]);
    expect(result.nextStatus).toBe('PENDING_APPROVAL');
  });

  it('全角数字・空白および氏名の空白は正常化後に一致する', () => {
    const result = validate(submission(), [item({ studentIdInput: '１ １ ０ １', studentNameInput: ' 架空生徒-1年 1組01番 ' })]);
    expect(result.errorCount).toBe(0);
    expect(result.warningCount).toBe(0);
    expect(result.normalizedItems[0]?.normalizedStudentId).toBe('1101');
  });

  it('氏名表記差は警告になる', () => {
    const result = validate(submission(), [item({ studentNameInput: '架空生徒-別表記' })]);
    expect(result.issues.map((issue) => issue.issueCode)).toContain(ISSUE_CODES.STUDENT_NAME_MISMATCH);
    expect(result.nextStatus).toBe('PENDING_APPROVAL');
  });

  it.each([
    ['', ISSUE_CODES.STUDENT_ID_MISSING],
    ['123', ISSUE_CODES.STUDENT_ID_INVALID],
    ['1999', ISSUE_CODES.STUDENT_ID_INVALID],
    ['1199', ISSUE_CODES.STUDENT_NOT_FOUND],
  ])('学籍番号 %j をエラーにする', (studentIdInput, expectedCode) => {
    const result = validate(submission(), [item({ studentIdInput })]);
    expect(result.issues.map((issue) => issue.issueCode)).toContain(expectedCode);
    expect(result.nextStatus).toBe('NEEDS_CORRECTION');
  });

  it('別クラスの学籍番号はエラーになる', () => {
    const result = validate(submission(), [item({ studentIdInput: '1201', studentNameInput: '架空生徒-1年2組01番' })]);
    expect(result.issues.map((issue) => issue.issueCode)).toContain(ISSUE_CODES.STUDENT_CLASS_MISMATCH);
  });

  it('必須枠不足と調整中をそれぞれ数える', () => {
    const result = validate(submission(), [item({ registrationState: 'PENDING', studentIdInput: '', studentNameInput: '' })]);
    expect(result.issues.map((issue) => issue.issueCode)).toEqual([
      ISSUE_CODES.REQUIRED_SLOT_MISSING,
      ISSUE_CODES.REGISTRATION_PENDING,
    ]);
    expect(result.errorCount).toBe(1);
    expect(result.warningCount).toBe(1);
  });

  it('調整中でも学籍番号と氏名が入力済みなら必須枠エラーにしない', () => {
    const result = validate(submission(), [item({ registrationState: 'PENDING' })]);
    expect(result.errorCount).toBe(0);
    expect(result.warningCount).toBe(1);
    expect(result.issues.map((issue) => issue.issueCode)).toEqual([ISSUE_CODES.REGISTRATION_PENDING]);
  });

  it('同一生徒の重複登録は登録場所をまとめた1件のエラーにする', () => {
    const result = validate(submission(), [
      item(),
      item({ submissionItemId: 'item-002', slotId: 'slot-002', slotName: '第2走者' }),
      item({ submissionItemId: 'item-003', slotId: 'slot-003', slotName: '第3走者' }),
    ]);
    const duplicateIssues = result.issues.filter((issue) => issue.issueCode === ISSUE_CODES.DUPLICATE_STUDENT);
    expect(duplicateIssues).toHaveLength(1);
    expect(duplicateIssues[0]?.displayTitle).toContain('3件の登録で重複');
    expect(duplicateIssues[0]?.locationText).toContain('第1走者');
    expect(duplicateIssues[0]?.locationText).toContain('第3走者');
    expect(duplicateIssues[0]?.fixInstruction).toContain('上限の1件');
  });

  it('同一競技内の重複ルールでは別競技への出場を重複扱いしない', () => {
    const result = validateSubmission(submission(), [
      item(),
      item({ submissionItemId: 'item-002', eventId: 'event-002', eventName: '別の架空競技' }),
    ], {
      students,
      sameClassInitialSubmissionCount: 1,
      rules: [{
        ruleId: 'R003', enabled: true, ruleName: '同一競技内の重複登録は禁止',
        target: '全競技', targetEventIds: '', condition: '同一生徒の重複', limit: 1,
        judgment: 'エラー', displayMessage: '同じ選手が重複しています', note: '',
      }],
    });
    expect(result.issues.map((issue) => issue.issueCode)).not.toContain(ISSUE_CODES.DUPLICATE_STUDENT);
  });

  it('性別人数の論理式がTRUEなら問題なし、FALSEなら指定したエラーにする', () => {
    const genderRule = {
      ruleId: 'R-GENDER', enabled: true, ruleName: '男女各1名以上',
      target: '全競技' as const, targetEventIds: '', condition: '', limit: Number.NaN,
      judgment: 'エラー' as const, displayMessage: '男子・女子を各1名以上登録してください',
      note: '', expression: 'M >= 1 && F >= 1',
    };
    const passing = validateSubmission(submission(), [
      item(),
      item({ submissionItemId: 'item-002', slotId: 'slot-002', slotName: '第2走者',
        studentIdInput: '1102', studentNameInput: '架空生徒-1年1組02番' }),
    ], { students, sameClassInitialSubmissionCount: 1, rules: [genderRule] });
    expect(passing.issues).toEqual([]);

    const failing = validateSubmission(submission(), [item()], {
      students, sameClassInitialSubmissionCount: 1, rules: [genderRule],
    });
    const issue = failing.issues.find((candidate) =>
      candidate.issueCode === ISSUE_CODES.RULE_EXPRESSION_FALSE);
    expect(issue?.displayTitle).toBe('男子・女子を各1名以上登録してください');
    expect(issue?.currentValue).toContain('M=1, F=0');
    expect(failing.nextStatus).toBe('NEEDS_CORRECTION');
  });

  it('女子0人の式で男子のみを表せる', () => {
    const result = validateSubmission(submission(), [item()], {
      students,
      sameClassInitialSubmissionCount: 1,
      rules: [{
        ruleId: 'R-MALE', enabled: true, ruleName: '男子のみ', target: '全競技',
        targetEventIds: '', condition: '', limit: Number.NaN, judgment: '警告',
        displayMessage: '男子のみ登録できます', note: '', expression: 'F == 0 && UNKNOWN == 0',
      }],
    });
    expect(result.issues).toEqual([]);
  });

  it('申請に含まれない対象競技の論理式は判定しない', () => {
    const result = validateSubmission(submission(), [item()], {
      students,
      sameClassInitialSubmissionCount: 1,
      rules: [{
        ruleId: 'R-OTHER', enabled: true, ruleName: '別競技の必要人数', target: '指定競技',
        targetEventIds: 'event-other', condition: '', limit: Number.NaN, judgment: 'エラー',
        displayMessage: '別競技の人数不足', note: '', expression: 'N >= 99',
      }],
    });
    expect(result.issues).toEqual([]);
  });

  it('同じクラスから複数の初回回答があれば警告する', () => {
    const result = validate(submission(), [item()], 2);
    expect(result.issues.map((issue) => issue.issueCode)).toContain(ISSUE_CODES.MULTIPLE_INITIAL_SUBMISSIONS);
  });

  it('代理入力を警告する', () => {
    const result = validate(
      submission({ targetClass: 2, isProxy: true }),
      [item({ studentIdInput: '1201', studentNameInput: '架空生徒-1年2組01番' })],
    );
    const issue = result.issues.find((candidate) => candidate.issueCode === ISSUE_CODES.PROXY_SUBMISSION);
    expect(issue).toBeDefined();
    expect(issue?.submissionItemId).toBe('');
  });

  it('入力者と対象クラスが同じなら代理入力を警告しない', () => {
    const result = validate(submission({ isProxy: true }), [item()]);
    expect(result.issues.map((issue) => issue.issueCode)).not.toContain(ISSUE_CODES.PROXY_SUBMISSION);
  });

  it('受付停止中の修正は警告し、エラーがあっても保留にする', () => {
    const result = validate(
      submission({ submissionType: 'CORRECTION', receptionOpen: false }),
      [item({ studentIdInput: '' })],
    );
    expect(result.issues.map((issue) => issue.issueCode)).toContain(ISSUE_CODES.CORRECTION_WHILE_CLOSED);
    expect(result.nextStatus).toBe('ON_HOLD');
  });

  it('エラー文は内部コードと分離され、修正箇所と方法を示す', () => {
    const issue = validate(submission(), [item({ studentIdInput: '' })]).issues[0];
    expect(issue?.displayTitle).not.toContain(ISSUE_CODES.STUDENT_ID_MISSING);
    expect(issue?.locationText).toContain('架空競技');
    expect(issue?.fixInstruction).toContain('半角数字4桁');
  });
});
