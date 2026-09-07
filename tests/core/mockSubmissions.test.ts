import { describe, expect, it } from 'vitest';
import { generateMockStudents } from '../../src/core/mockStudents';
import { ISSUE_CODES, validateSubmission } from '../../src/core/validation';
import { generateMockSubmissions } from '../../src/gas/mock-data';
import type { EventSetting, FormRegistryRow } from '../../src/shared/types';

const event: EventSetting = {
  year: 2026, eventId: 'RELAY', enabled: true, targetGrade: '全学年', eventName: '400mリレー',
  category: '混合', requiredCount: 2, hasOrder: true, vacancyAllowed: true,
  assemblyOrder: 10, displayOrder: 10, note: '',
};

function registry(formType: FormRegistryRow['formType'], formId: string): FormRegistryRow[] {
  const prefix = formType === 'correction' ? 'correction_' : '';
  return [1, 2].flatMap((slot) => {
    const base = `${prefix}RELAY_slot0${slot}`;
    return [
      row(formType, formId, `${base}_state`, `state-${slot}`, 'multiple_choice', slot * 10),
      row(formType, formId, `${base}_student_id`, `id-${slot}`, 'text', slot * 10 + 1),
      row(formType, formId, `${base}_name`, `name-${slot}`, 'text', slot * 10 + 2),
    ];
  });
}

function row(
  formType: FormRegistryRow['formType'], formId: string, fieldKey: string,
  itemId: string, itemType: string, displayOrder: number,
): FormRegistryRow {
  return {
    formType, formId, itemId, fieldKey, eventId: 'RELAY', title: fieldKey,
    itemType, displayOrder, enabled: true,
  };
}

function eventRegistry(
  formType: FormRegistryRow['formType'], formId: string, eventId: string,
  count: number, displayStart: number, includeState = false,
): FormRegistryRow[] {
  const prefix = formType === 'correction' ? 'correction_' : '';
  return Array.from({ length: count }, (_, offset) => {
    const slot = String(offset + 1).padStart(2, '0');
    const base = `${prefix}${eventId}_slot${slot}`;
    return [
      ...(includeState ? [{ ...row(formType, formId, `${base}_state`, `${eventId}-state-${slot}`, 'multiple_choice', displayStart + offset * 10), eventId }] : []),
      { ...row(formType, formId, `${base}_student_id`, `${eventId}-id-${slot}`, 'text', displayStart + offset * 10 + 1), eventId },
      { ...row(formType, formId, `${base}_name`, `${eventId}-name-${slot}`, 'text', displayStart + offset * 10 + 2), eventId },
    ];
  }).flat();
}

describe('疑似フォーム回答の検査', () => {
  it('追加生成では指定した連番から修正回答だけを作る', () => {
    const students = generateMockStudents();
    const generated = generateMockSubmissions({
      year: 2026, normalFormId: 'normal-form', correctionFormId: 'correction-form',
      normalRegistry: registry('normal', 'normal-form'),
      correctionRegistry: registry('correction', 'correction-form'),
      events: [event], students,
    }, {
      submissionCount: 3, targetGrades: [1], targetClasses: [1, 2],
      targetFormTypes: ['correction'], errorSubmissionCount: 0, warningSubmissionCount: 0,
    }, 25);
    expect(generated.submissions).toHaveLength(3);
    expect(generated.submissions.every((submission) => submission.submissionType === 'CORRECTION')).toBe(true);
    expect(generated.rawResponses.map((response) => response.responseId)).toEqual([
      'mock-response-000025', 'mock-response-000026', 'mock-response-000027',
    ]);
  });

  it('問題なし、警告、エラー、受付停止を同じデータセットで再現する', () => {
    const students = generateMockStudents();
    const { submissions, items, rawResponses } = generateMockSubmissions({
      year: 2026, normalFormId: 'normal-form', correctionFormId: 'correction-form',
      normalRegistry: registry('normal', 'normal-form'),
      correctionRegistry: registry('correction', 'correction-form'),
      events: [event], students,
    });
    const results = submissions.map((submission) => validateSubmission(
      submission,
      items.filter((item) => item.submissionId === submission.submissionId),
      {
        students,
        sameClassInitialSubmissionCount: submissions.filter((candidate) =>
          candidate.submissionType === 'INITIAL' &&
          candidate.targetGrade === submission.targetGrade &&
          candidate.targetClass === submission.targetClass
        ).length,
      },
    ));

    expect(results).toHaveLength(5);
    expect(submissions[1]?.submitterStudentId).toBe('1101');
    expect(submissions[1]?.targetClass).toBe(2);
    expect(items.every((item) => item.eventId === 'RELAY' && item.eventName === '400mリレー')).toBe(true);
    expect(rawResponses).toHaveLength(5);
    expect(rawResponses.every((response) => ['normal-form', 'correction-form'].includes(response.formId))).toBe(true);
    expect(results.some((result) => result.errorCount === 0)).toBe(true);
    expect(results.some((result) => result.errorCount > 0)).toBe(true);
    expect(results.some((result) => result.nextStatus === 'ON_HOLD')).toBe(true);

    const issueCodes = results.flatMap((result) => result.issues.map((issue) => issue.issueCode));
    expect(issueCodes).toContain(ISSUE_CODES.MULTIPLE_INITIAL_SUBMISSIONS);
    expect(issueCodes).toContain(ISSUE_CODES.PROXY_SUBMISSION);
    expect(issueCodes).toContain(ISSUE_CODES.STUDENT_ID_INVALID);
    expect(issueCodes).toContain(ISSUE_CODES.STUDENT_CLASS_MISMATCH);
    expect(issueCodes).toContain(ISSUE_CODES.CORRECTION_WHILE_CLOSED);
  });

  it('作成済みフォームがなければ、先に下書きを作るよう案内する', () => {
    expect(() => generateMockSubmissions({
      year: 2026, normalFormId: '', correctionFormId: '',
      normalRegistry: [], correctionRegistry: [], events: [event], students: generateMockStudents(),
    })).toThrow('先に「フォーム下書きを作成」を実行');
  });

  it('設定した全校規模の件数とエラー・警告件数で疑似申請を作る', () => {
    const students = generateMockStudents();
    const generated = generateMockSubmissions({
      year: 2026, normalFormId: 'normal-form', correctionFormId: 'correction-form',
      normalRegistry: registry('normal', 'normal-form'),
      correctionRegistry: registry('correction', 'correction-form'),
      events: [event], students,
    }, {
      submissionCount: students.length,
      targetGrades: [1, 2, 3],
      targetClasses: [1, 2, 3, 4, 5, 6, 7, 8],
      targetFormTypes: ['normal', 'correction'],
      errorSubmissionCount: 12,
      warningSubmissionCount: 18,
    });
    expect(generated.submissions).toHaveLength(students.length);
    expect(generated.rawResponses).toHaveLength(students.length);
    const initialSubmissions = generated.submissions.filter((entry) => entry.submissionType === 'INITIAL');
    expect(initialSubmissions).toHaveLength(24);
    expect(new Set(initialSubmissions.map((entry) => `${entry.targetGrade}:${entry.targetClass}`)).size).toBe(24);
    const results = generated.submissions.map((submission) => validateSubmission(
      submission,
      generated.items.filter((item) => item.submissionId === submission.submissionId),
      { students, sameClassInitialSubmissionCount: 1 },
    ));
    expect(results.filter((result) => result.errorCount > 0)).toHaveLength(12);
    expect(results.filter((result) => result.errorCount === 0 && result.warningCount > 0)).toHaveLength(18);
  });

  it('選んだ学年・組だけに疑似申請を作る', () => {
    const students = generateMockStudents();
    const targetStudents = students.filter((candidate) =>
      candidate.grade === 1 && [1, 2, 3].includes(candidate.classNumber));
    const generated = generateMockSubmissions({
      year: 2026, normalFormId: 'normal-form', correctionFormId: 'correction-form',
      normalRegistry: registry('normal', 'normal-form'),
      correctionRegistry: registry('correction', 'correction-form'),
      events: [event], students,
    }, {
      submissionCount: targetStudents.length,
      targetGrades: [1], targetClasses: [1, 2, 3],
      targetFormTypes: ['normal', 'correction'],
      errorSubmissionCount: 0, warningSubmissionCount: 0,
    });
    expect(generated.submissions).toHaveLength(targetStudents.length);
    expect(new Set(generated.submissions.map((entry) => entry.targetGrade))).toEqual(new Set([1]));
    expect(new Set(generated.submissions.map((entry) => entry.targetClass))).toEqual(new Set([1, 2, 3]));
  });

  it('通常フォームだけを選ぶと全件を通常回答として作る', () => {
    const students = generateMockStudents();
    const generated = generateMockSubmissions({
      year: 2026, normalFormId: 'normal-form', correctionFormId: 'correction-form',
      normalRegistry: registry('normal', 'normal-form'),
      correctionRegistry: registry('correction', 'correction-form'),
      events: [event], students,
    }, {
      submissionCount: 20, targetGrades: [1], targetClasses: [1],
      targetFormTypes: ['normal'], errorSubmissionCount: 0, warningSubmissionCount: 0,
    });
    expect(generated.submissions).toHaveLength(1);
    expect(new Set(generated.submissions.map((entry) => entry.submissionType))).toEqual(new Set(['INITIAL']));
  });

  it('両方を選ぶと各クラスの最初だけ通常回答、その後を修正回答にする', () => {
    const students = generateMockStudents();
    const generated = generateMockSubmissions({
      year: 2026, normalFormId: 'normal-form', correctionFormId: 'correction-form',
      normalRegistry: registry('normal', 'normal-form'),
      correctionRegistry: registry('correction', 'correction-form'),
      events: [event], students,
    }, {
      submissionCount: 4, targetGrades: [1], targetClasses: [1],
      targetFormTypes: ['normal', 'correction'], errorSubmissionCount: 0, warningSubmissionCount: 0,
    });
    expect(generated.submissions.map((entry) => entry.submissionType))
      .toEqual(['INITIAL', 'CORRECTION', 'CORRECTION', 'CORRECTION']);
  });

  it('ルール設定で意図しない重複になる疑似データは保存前点検で停止する', () => {
    const students = generateMockStudents();
    const classSize = students.filter((candidate) => candidate.grade === 1 && candidate.classNumber === 1).length;
    const requiredCount = classSize + 1;
    const largeEvent = { ...event, requiredCount, vacancyAllowed: false };
    const largeRegistry = Array.from({ length: requiredCount }, (_, offset) => {
      const slot = offset + 1;
      const base = `RELAY_slot${String(slot).padStart(2, '0')}`;
      return [
        row('normal', 'normal-form', `${base}_state`, `state-${slot}`, 'multiple_choice', slot * 10),
        row('normal', 'normal-form', `${base}_student_id`, `id-${slot}`, 'text', slot * 10 + 1),
        row('normal', 'normal-form', `${base}_name`, `name-${slot}`, 'text', slot * 10 + 2),
      ];
    }).flat();
    expect(() => generateMockSubmissions({
      year: 2026, normalFormId: 'normal-form', correctionFormId: 'correction-form',
      normalRegistry: largeRegistry, correctionRegistry: registry('correction', 'correction-form'),
      events: [largeEvent], students,
      rules: [{
        ruleId: 'R003', enabled: true, ruleName: '同一競技内の重複登録は禁止',
        target: '全競技', targetEventIds: '', condition: '同一生徒の重複', limit: 1,
        judgment: 'エラー', displayMessage: '同じ選手が重複しています', note: '',
      }],
    }, {
      submissionCount: 1, targetGrades: [1], targetClasses: [1], targetFormTypes: ['normal'],
      errorSubmissionCount: 0, warningSubmissionCount: 0,
    })).toThrow('登録枠');
  });

  it('登録枠が生徒数を超えても、同じ競技内で重複させずに枠を埋める', () => {
    const students = generateMockStudents();
    const classSize = students.filter((candidate) => candidate.grade === 1 && candidate.classNumber === 1).length;
    const events: EventSetting[] = [
      { ...event, eventId: 'E001', eventName: '男子リレー', requiredCount: 1, displayOrder: 1, vacancyAllowed: false },
      { ...event, eventId: 'E003', eventName: '学年競技', requiredCount: classSize - 1, displayOrder: 2, vacancyAllowed: false },
      { ...event, eventId: 'E002', eventName: '女子リレー', requiredCount: 1, displayOrder: 3, vacancyAllowed: false },
    ];
    // ルールは論理式で書く。疑似データの割り当ては論理式を読まず、
    // 同じ競技内で重複させないことと、全体をできるだけ均等にすることだけを守る。
    const rules = [
      { ruleId: 'R005', enabled: true, ruleName: '1人あたりの出場数上限', target: '全競技' as const,
        targetEventIds: '', condition: '', limit: Number.NaN, judgment: '警告' as const,
        displayMessage: '', note: '', expression: 'MAX_PER_STUDENT <= 2' },
    ];
    const generated = generateMockSubmissions({
      year: 2026, normalFormId: 'normal-form', correctionFormId: 'correction-form',
      normalRegistry: [
        ...eventRegistry('normal', 'normal-form', 'E001', 1, 1),
        ...eventRegistry('normal', 'normal-form', 'E003', classSize - 1, 100),
        ...eventRegistry('normal', 'normal-form', 'E002', 1, 10_000),
      ],
      correctionRegistry: eventRegistry('correction', 'correction-form', 'E001', 1, 1),
      events, students, rules,
    }, {
      submissionCount: 1, targetGrades: [1], targetClasses: [1], targetFormTypes: ['normal'],
      errorSubmissionCount: 0, warningSubmissionCount: 0,
    });
    expect(generated.items).toHaveLength(classSize + 1);
    expect(generated.items.every((item) => item.studentIdInput !== '')).toBe(true);
    const countsByEvent = new Map<string, string[]>();
    generated.items.forEach((item) => {
      countsByEvent.set(item.eventId, [...(countsByEvent.get(item.eventId) ?? []), item.studentIdInput]);
    });
    countsByEvent.forEach((ids) => expect(new Set(ids).size).toBe(ids.length));
    const usage = new Map<string, number>();
    generated.items.forEach((item) =>
      usage.set(item.studentIdInput, (usage.get(item.studentIdInput) ?? 0) + 1));
    expect(Math.max(...usage.values())).toBe(2);
    expect([...usage.values()].filter((count) => count === 2)).toHaveLength(1);
  });

  it('修正回答は、同じクラスの登録回答の枠をそのまま引き継ぐ（空けた枠も含む）', () => {
    const students = generateMockStudents();
    const classSize = students
      .filter((candidate) => candidate.grade === 2 && candidate.classNumber === 1).length;
    const requiredCount = classSize + 1;
    const vacancyEvent: EventSetting = {
      ...event, eventId: 'E005', eventName: '学年競技', targetGrade: '2年',
      requiredCount, vacancyAllowed: true,
    };
    const generated = generateMockSubmissions({
      year: 2026, normalFormId: 'normal-form', correctionFormId: 'correction-form',
      normalRegistry: eventRegistry('normal', 'normal-form', 'E005', requiredCount, 1, true),
      correctionRegistry: eventRegistry('correction', 'correction-form', 'E005', requiredCount, 1, true),
      events: [vacancyEvent], students,
    }, {
      submissionCount: 2, targetGrades: [2], targetClasses: [1],
      targetFormTypes: ['normal', 'correction'],
      errorSubmissionCount: 0, warningSubmissionCount: 0,
    });
    expect(generated.submissions.map((submission) => submission.submissionType))
      .toEqual(['INITIAL', 'CORRECTION']);
    const bySubmission = generated.submissions.map((submission) => generated.items
      .filter((item) => item.submissionId === submission.submissionId)
      .map((item) => `${item.slotId}=${item.studentIdInput}:${item.registrationState}`));
    // 枠ごとの選手も登録状態も一致する。空けた枠を修正回答が埋め直さない。
    expect(bySubmission[1]).toEqual(bySubmission[0]);
    expect(bySubmission[0]!.filter((slot) => slot.endsWith('NOT_PARTICIPATING'))).toHaveLength(1);
  });

  it('欠員許可の競技は生徒数を超えた枠を空けて警告だけにする', () => {
    const students = generateMockStudents();
    const classSize = students.filter((candidate) => candidate.grade === 2 && candidate.classNumber === 1).length;
    const requiredCount = classSize + 1;
    const vacancyEvent: EventSetting = {
      ...event, eventId: 'E005', eventName: '学年競技 変更', targetGrade: '2年',
      requiredCount, vacancyAllowed: true,
    };
    const generated = generateMockSubmissions({
      year: 2026, normalFormId: 'normal-form', correctionFormId: 'correction-form',
      normalRegistry: eventRegistry('normal', 'normal-form', 'E005', requiredCount, 1, true),
      correctionRegistry: eventRegistry('correction', 'correction-form', 'E005', requiredCount, 1, true),
      events: [vacancyEvent], students,
      rules: [{
        ruleId: 'R003', enabled: true, ruleName: '同一競技内の重複登録は禁止',
        target: '全競技', targetEventIds: 'E005', condition: '同一生徒の重複', limit: 1,
        judgment: 'エラー', displayMessage: '', note: '',
      }],
    }, {
      submissionCount: 1, targetGrades: [2], targetClasses: [1], targetFormTypes: ['normal'],
      errorSubmissionCount: 0, warningSubmissionCount: 0,
    });
    const validation = validateSubmission(generated.submissions[0]!, generated.items, {
      students, sameClassInitialSubmissionCount: 1,
      rules: [{
        ruleId: 'R003', enabled: true, ruleName: '同一競技内の重複登録は禁止',
        target: '全競技', targetEventIds: 'E005', condition: '同一生徒の重複', limit: 1,
        judgment: 'エラー', displayMessage: '', note: '',
      }],
    });
    expect(validation.errorCount).toBe(0);
    expect(validation.issues.map((issue) => issue.issueCode))
      .toEqual([ISSUE_CODES.VACANCY_CAPACITY_SHORTFALL]);
    expect(generated.items.filter((item) => item.registrationState === 'NOT_PARTICIPATING')).toHaveLength(1);
  });
});
