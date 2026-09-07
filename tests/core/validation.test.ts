import { describe, expect, it } from 'vitest';
import type { RuleSetting, Submission, SubmissionItem, ValidationResult } from '../../src/shared/types';
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

const duplicateRule: RuleSetting = {
  ruleId: 'R-DUP', enabled: true, ruleName: '同じ生徒を重複させない', target: '全競技',
  targetEventIds: '', condition: '', limit: Number.NaN, judgment: 'エラー',
  displayMessage: '同じ選手を重複して登録できません', note: '', expression: 'MAX_PER_STUDENT <= 1',
};

const nameMatchRule: RuleSetting = {
  ruleId: 'R-NAME', enabled: true, ruleName: '氏名照合', target: '全競技',
  targetEventIds: '', condition: '', limit: Number.NaN, judgment: '警告',
  displayMessage: '氏名の表記を確認してください', note: '', expression: 'NAME_MISMATCH == 0',
};

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

  it('氏名照合の論理式で表記差を警告にできる', () => {
    const result = validateSubmission(
      submission(), [item({ studentNameInput: '架空生徒-別表記' })],
      { students, sameClassInitialSubmissionCount: 1, rules: [nameMatchRule] },
    );
    const issue = result.issues.find((candidate) => candidate.issueCode === ISSUE_CODES.RULE_EXPRESSION_FALSE);
    expect(issue?.displayTitle).toBe('氏名の表記を確認してください');
    expect(result.nextStatus).toBe('PENDING_APPROVAL');
  });

  it('氏名入力のない回答は氏名照合の警告を出さない', () => {
    const result = validateSubmission(
      submission(), [item({ studentNameInput: '' })],
      { students, sameClassInitialSubmissionCount: 1, rules: [nameMatchRule] },
    );
    expect(result.warningCount).toBe(0);
    expect(result.errorCount).toBe(0);
    expect(result.nextStatus).toBe('PENDING_APPROVAL');
  });

  it('氏名照合の論理式がなければ表記差を検出しない', () => {
    const result = validate(submission(), [item({ studentNameInput: '架空生徒-別表記' })]);
    expect(result.issues).toEqual([]);
  });

  it('氏名入力のない回答でも学籍番号の誤りは検出する', () => {
    const notFound = validate(submission(), [item({ studentIdInput: '1199', studentNameInput: '' })]);
    expect(notFound.issues.map((issue) => issue.issueCode)).toContain(ISSUE_CODES.STUDENT_NOT_FOUND);
    const otherClass = validate(submission(), [item({ studentIdInput: '1201', studentNameInput: '' })]);
    expect(otherClass.issues.map((issue) => issue.issueCode)).toContain(ISSUE_CODES.STUDENT_CLASS_MISMATCH);
  });

  it.each([
    ['', ISSUE_CODES.STUDENT_ID_MISSING],
    ['123', ISSUE_CODES.STUDENT_ID_INVALID],
    ['1999', ISSUE_CODES.STUDENT_ID_INVALID],
  ])('学籍番号 %j をエラーにする', (studentIdInput, expectedCode) => {
    const result = validate(submission(), [item({ studentIdInput })]);
    expect(result.issues.map((issue) => issue.issueCode)).toContain(expectedCode);
    expect(result.nextStatus).toBe('NEEDS_CORRECTION');
  });

  it('生徒マスターにない学籍番号は警告にとどめ、承認できる状態にする', () => {
    const result = validate(submission(), [item({ studentIdInput: '1199', studentNameInput: '' })]);
    const notFound = result.issues.find((issue) => issue.issueCode === ISSUE_CODES.STUDENT_NOT_FOUND);
    expect(notFound?.severity).toBe('WARNING');
    expect(result.errorCount).toBe(0);
    expect(result.nextStatus).toBe('PENDING_APPROVAL');
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

  it('重複禁止の論理式で同一生徒の重複をエラーにする', () => {
    const result = validateSubmission(submission(), [
      item(),
      item({ submissionItemId: 'item-002', slotId: 'slot-002', slotName: '第2走者' }),
      item({ submissionItemId: 'item-003', slotId: 'slot-003', slotName: '第3走者' }),
    ], { students, sameClassInitialSubmissionCount: 1, rules: [duplicateRule] });
    const issue = result.issues.find((candidate) => candidate.issueCode === ISSUE_CODES.RULE_EXPRESSION_FALSE);
    expect(issue?.displayTitle).toBe('同じ選手を重複して登録できません');
    expect(issue?.severity).toBe('ERROR');
    expect(issue?.currentValue).toContain('MAX_PER_STUDENT=3');
    expect(result.nextStatus).toBe('NEEDS_CORRECTION');
  });

  it('MAX_PER_EVENTは同じ競技内の重複だけを数える', () => {
    const perEventRule: RuleSetting = {
      ...duplicateRule, ruleId: 'R-EVENT', ruleName: '同じ競技へ同じ生徒を2回入れない',
      displayMessage: '同じ競技に同じ選手が重複して登録されています', expression: 'MAX_PER_EVENT <= 1',
    };
    const sameEvent = validateSubmission(submission(), [
      item(),
      item({ submissionItemId: 'item-002', slotId: 'slot-002', slotName: '第2走者' }),
    ], { students, sameClassInitialSubmissionCount: 1, rules: [perEventRule] });
    const issue = sameEvent.issues.find((candidate) => candidate.issueCode === ISSUE_CODES.RULE_EXPRESSION_FALSE);
    expect(issue?.displayTitle).toBe('同じ競技に同じ選手が重複して登録されています');
    expect(issue?.currentValue).toContain('MAX_PER_EVENT=2');

    const differentEvents = validateSubmission(submission(), [
      item(),
      item({ submissionItemId: 'item-002', eventId: 'event-002', eventName: '別の架空競技' }),
    ], { students, sameClassInitialSubmissionCount: 1, rules: [perEventRule] });
    expect(differentEvents.issues).toEqual([]);
  });

  it('重複禁止の論理式がなければ重複を検出しない', () => {
    const result = validate(submission(), [
      item(),
      item({ submissionItemId: 'item-002', slotId: 'slot-002', slotName: '第2走者' }),
    ]);
    expect(result.issues).toEqual([]);
  });

  it('指定競技の重複ルールは対象外の競技を重複扱いしない', () => {
    const result = validateSubmission(submission(), [
      item(),
      item({ submissionItemId: 'item-002', eventId: 'event-002', eventName: '別の架空競技' }),
    ], {
      students,
      sameClassInitialSubmissionCount: 1,
      rules: [{ ...duplicateRule, target: '指定競技', targetEventIds: 'event-001' }],
    });
    expect(result.issues).toEqual([]);
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

describe('足りない形の論理式で未登録の生徒を示す', () => {
  const classStudents = students.filter((student) => student.grade === 1 && student.classNumber === 1);
  const uniqueRule: RuleSetting = {
    ...duplicateRule, ruleId: 'R-ALL', ruleName: 'クラス全員を出す',
    displayMessage: 'クラス全員を登録してください', expression: 'UNIQUE >= 40',
  };
  const twoItems = [
    item(),
    item({ submissionItemId: 'item-002', slotId: 'slot-002', slotName: '第2走者', studentIdInput: '1102', studentNameInput: '' }),
  ];

  it('UNIQUE >= 40 が成立しないとき、対象競技に登録されていないクラスの生徒を出席番号順に並べる', () => {
    const result = validateSubmission(submission(), twoItems,
      { students, sameClassInitialSubmissionCount: 1, rules: [uniqueRule] });
    const issue = result.issues.find((candidate) => candidate.issueCode === ISSUE_CODES.RULE_EXPRESSION_FALSE);
    expect(issue?.fixInstruction).toContain(
      `未登録の生徒（${classStudents.length - 2}人。名簿${classStudents.length}人のうち登録済み2人）：`);
    expect(issue?.fixInstruction).not.toContain('1101 ');
    expect(issue?.fixInstruction).not.toContain('1102 ');
    const third = classStudents.find((student) => student.studentId === '1103')!;
    expect(issue?.fixInstruction).toContain(`1103 ${third.name}（${third.gender === 'M' ? '男' : '女'}）`);
    const listed = (issue?.fixInstruction ?? '').split('未登録の生徒')[1] ?? '';
    const ids = [...listed.matchAll(/(1[1-8][0-9]{2}) /g)].map((match) => match[1]);
    expect(ids).toEqual(classStudents.filter((student) => !['1101', '1102'].includes(student.studentId))
      .map((student) => student.studentId));
    expect(issue?.relatedItemIds).toBe('');
  });

  it('出場しない枠と別クラスの生徒は登録済みに数えない', () => {
    const result = validateSubmission(submission(), [
      item({ registrationState: 'NOT_PARTICIPATING', required: false }),
      item({ submissionItemId: 'item-002', slotId: 'slot-002', studentIdInput: '1201', studentNameInput: '' }),
    ], { students, sameClassInitialSubmissionCount: 1, rules: [uniqueRule] });
    const issue = result.issues.find((candidate) => candidate.issueCode === ISSUE_CODES.RULE_EXPRESSION_FALSE);
    expect(issue?.fixInstruction).toContain(
      `未登録の生徒（${classStudents.length}人。名簿${classStudents.length}人のうち登録済み0人）：`);
    expect(issue?.fixInstruction).toContain('1101 ');
  });

  it('男子だけを数える論理式では未登録の男子だけを並べる', () => {
    const maleRule: RuleSetting = { ...uniqueRule, ruleId: 'R-MALE', expression: 'M >= 30' };
    const result = validateSubmission(submission(), twoItems,
      { students, sameClassInitialSubmissionCount: 1, rules: [maleRule] });
    const issue = result.issues.find((candidate) => candidate.issueCode === ISSUE_CODES.RULE_EXPRESSION_FALSE);
    const expected = classStudents.filter((student) => student.gender === 'M' && !['1101', '1102'].includes(student.studentId));
    const maleCount = classStudents.filter((student) => student.gender === 'M').length;
    expect(issue?.fixInstruction).toContain(
      `未登録の男子（${expected.length}人。名簿${maleCount}人のうち登録済み${maleCount - expected.length}人）：`);
    expect(issue?.fixInstruction).not.toContain('（女）');
  });

  it('直す枠が絞れる論理式や、人数を数えない論理式では未登録の生徒を並べない', () => {
    const noMaleRule: RuleSetting = { ...uniqueRule, ruleId: 'R-NOMALE', expression: 'M == 0' };
    const tooMany = validateSubmission(submission(), twoItems,
      { students, sameClassInitialSubmissionCount: 1, rules: [noMaleRule] });
    const tooManyIssue = tooMany.issues.find((candidate) => candidate.issueCode === ISSUE_CODES.RULE_EXPRESSION_FALSE);
    if (tooManyIssue) expect(tooManyIssue.fixInstruction).not.toContain('未登録');

    const pendingRule: RuleSetting = { ...uniqueRule, ruleId: 'R-PENDING', expression: 'PENDING == 0' };
    const pending = validateSubmission(submission(), [item({ registrationState: 'PENDING' })],
      { students, sameClassInitialSubmissionCount: 1, rules: [pendingRule] });
    const pendingIssue = pending.issues.find((candidate) => candidate.issueCode === ISSUE_CODES.RULE_EXPRESSION_FALSE);
    expect(pendingIssue).toBeDefined();
    expect(pendingIssue?.fixInstruction).not.toContain('未登録');
  });

  it('クラス全員が登録済みなら「なし」と示す', () => {
    const allItems = classStudents.map((student, index) => item({
      submissionItemId: `item-${index}`, slotId: `slot-${index}`, slotName: `${index + 1}番`,
      studentIdInput: student.studentId, studentNameInput: '',
    }));
    const strictRule: RuleSetting = { ...uniqueRule, expression: `UNIQUE >= ${classStudents.length + 1}` };
    const result = validateSubmission(submission(), allItems,
      { students, sameClassInitialSubmissionCount: 1, rules: [strictRule] });
    const issue = result.issues.find((candidate) => candidate.issueCode === ISSUE_CODES.RULE_EXPRESSION_FALSE);
    expect(issue?.fixInstruction).toContain(`未登録の生徒：なし（対象クラスの名簿${classStudents.length}人は全員登録済みです）`);
    expect(issue?.fixInstruction).toContain('例：UNIQUE >= CLASS_SIZE');
    expect(issue?.currentValue).toContain(`CLASS_SIZE=${classStudents.length}`);
  });

  it('CLASS_SIZE を使えば、名簿の人数に合わせて「全員」を判定できる', () => {
    const allItems = classStudents.map((student, index) => item({
      submissionItemId: `item-${index}`, slotId: `slot-${index}`, slotName: `${index + 1}番`,
      studentIdInput: student.studentId, studentNameInput: '',
    }));
    const everyoneRule: RuleSetting = { ...uniqueRule, ruleId: 'R-EVERYONE', expression: 'UNIQUE >= CLASS_SIZE' };
    const satisfied = validateSubmission(submission(), allItems,
      { students, sameClassInitialSubmissionCount: 1, rules: [everyoneRule] });
    expect(satisfied.issues.filter((candidate) => candidate.issueCode === ISSUE_CODES.RULE_EXPRESSION_FALSE)).toEqual([]);

    const short = validateSubmission(submission(), allItems.slice(1),
      { students, sameClassInitialSubmissionCount: 1, rules: [everyoneRule] });
    const issue = short.issues.find((candidate) => candidate.issueCode === ISSUE_CODES.RULE_EXPRESSION_FALSE);
    expect(issue?.fixInstruction).toContain(`未登録の生徒（1人。名簿${classStudents.length}人のうち登録済み${classStudents.length - 1}人）：`);
    expect(issue?.fixInstruction).toContain(`${classStudents[0]!.studentId} ${classStudents[0]!.name}`);

    const otherClass = validateSubmission(submission({ targetClass: 2 }), allItems.slice(0, 3),
      { students, sameClassInitialSubmissionCount: 1, rules: [everyoneRule] });
    const otherIssue = otherClass.issues.find((candidate) => candidate.issueCode === ISSUE_CODES.RULE_EXPRESSION_FALSE);
    const classTwo = students.filter((student) => student.grade === 1 && student.classNumber === 2).length;
    expect(otherIssue?.currentValue).toContain(`CLASS_SIZE=${classTwo}`);
  });
});
