import { describe, expect, it } from 'vitest';
import { generateMockStudents } from '../../src/core/mockStudents';
import { ISSUE_CODES, validateSubmission } from '../../src/core/validation';
import { generateMockSubmissions } from '../../src/gas/mock-data';
import type { EventSetting, FormRegistryRow, RuleSetting } from '../../src/shared/types';

const baseEvent: EventSetting = {
  year: 2026, eventId: '', enabled: true, targetGrade: '全学年', eventName: '',
  category: '混合', requiredCount: 0, hasOrder: true, vacancyAllowed: false,
  assemblyOrder: 10, displayOrder: 10, note: '',
};

function slots(
  formType: FormRegistryRow['formType'], formId: string, eventId: string,
  count: number, displayStart: number,
): FormRegistryRow[] {
  const prefix = formType === 'correction' ? 'correction_' : '';
  return Array.from({ length: count }, (_, offset) => {
    const slot = String(offset + 1).padStart(2, '0');
    const base = `${prefix}${eventId}_slot${slot}`;
    return [
      {
        formType, formId, itemId: `${eventId}-id-${slot}`, fieldKey: `${base}_student_id`,
        eventId, title: base, itemType: 'text', displayOrder: displayStart + offset * 10 + 1,
        enabled: true,
      },
      {
        formType, formId, itemId: `${eventId}-name-${slot}`, fieldKey: `${base}_name`,
        eventId, title: base, itemType: 'text', displayOrder: displayStart + offset * 10 + 2,
        enabled: true,
      },
    ];
  }).flat();
}

function events(spec: Array<[string, string, number]>): EventSetting[] {
  return spec.map(([eventId, eventName, requiredCount], offset) => ({
    ...baseEvent, eventId, eventName, requiredCount, displayOrder: offset + 1,
  }));
}

function registryFor(spec: Array<[string, string, number]>): FormRegistryRow[] {
  return spec.flatMap(([eventId, , count], offset) =>
    slots('normal', 'normal-form', eventId, count, offset * 1_000));
}

/** ユーザーの「ルール設定」シートと同じ形の、男女構成・同性構成を指定したルール。 */
const GENDER_RULES: RuleSetting[] = [
  {
    ruleId: 'R000', enabled: true, ruleName: '女子リレー制限', target: '指定競技',
    targetEventIds: 'E000', condition: '', limit: 0, judgment: 'エラー',
    displayMessage: 'この競技は女子のみ出場可能です', note: '', expression: 'MALE == 0',
  },
  {
    ruleId: 'R100', enabled: true, ruleName: '男子リレー制限', target: '指定競技',
    targetEventIds: 'E100', condition: '', limit: 0, judgment: 'エラー',
    displayMessage: 'この競技は男子のみ出場可能です', note: '', expression: 'FEMALE == 0',
  },
  {
    ruleId: 'R200', enabled: true, ruleName: '男女混合リレー　男女数', target: '指定競技',
    targetEventIds: 'E200', condition: '', limit: 0, judgment: 'エラー',
    displayMessage: '男女の数が異なります', note: '', expression: 'MALE <= 2 && FEMALE <= 2',
  },
  {
    ruleId: 'R300', enabled: true, ruleName: '玉入れ　男女数', target: '指定競技',
    targetEventIds: 'E300', condition: '', limit: 0, judgment: 'エラー',
    displayMessage: '男女各１名以上入れてください', note: '',
    expression: 'MALE >= 1 && FEMALE >= 1',
  },
  {
    ruleId: 'R601', enabled: true, ruleName: '騎馬1同性で構成', target: '指定競技',
    targetEventIds: 'E600,E650', condition: '', limit: 0, judgment: 'エラー',
    displayMessage: '騎馬は同性で構成してください', note: '',
    expression: 'MALE == 0 OR FEMALE == 0',
  },
];

const GENDER_SPEC: Array<[string, string, number]> = [
  ['E000', '女子６×100ｍリレー', 6],
  ['E100', '男子スウェーデンリレー', 4],
  ['E200', '男女混合リレー', 4],
  ['E300', '玉入れ', 10],
  ['E600', '騎馬　騎馬上 1', 1],
  ['E650', '騎馬　騎馬下 1', 3],
];

describe('ルール設定を読む疑似データ生成', () => {
  it('問題なしの疑似申請は、男女構成・同性構成のルールをすべて満たす', () => {
    const students = generateMockStudents();
    const generated = generateMockSubmissions({
      year: 2026, normalFormId: 'normal-form', correctionFormId: 'correction-form',
      normalRegistry: registryFor(GENDER_SPEC),
      correctionRegistry: slots('correction', 'correction-form', 'E000', 6, 1),
      events: events(GENDER_SPEC), students, rules: GENDER_RULES,
    }, {
      submissionCount: 1, targetGrades: [1], targetClasses: [1], targetFormTypes: ['normal'],
      errorSubmissionCount: 0, warningSubmissionCount: 0,
    });
    const validation = validateSubmission(generated.submissions[0]!, generated.items, {
      students, sameClassInitialSubmissionCount: 1, rules: GENDER_RULES,
    });
    expect(generated.notices).toEqual([]);
    expect(validation.errorCount).toBe(0);

    const gendersIn = (eventId: string): string[] => generated.items
      .filter((item) => item.eventId === eventId)
      .map((item) => students.find((candidate) => candidate.studentId === item.studentIdInput)?.gender ?? 'U');
    expect(gendersIn('E000').every((gender) => gender === 'F')).toBe(true);
    expect(gendersIn('E100').every((gender) => gender === 'M')).toBe(true);
    expect(new Set(gendersIn('E300')).size).toBe(2);
    expect(new Set([...gendersIn('E600'), ...gendersIn('E650')]).size).toBe(1);
  });

  it('指定した件数だけ、ルールを破ったエラー申請と警告申請を作る', () => {
    const students = generateMockStudents();
    const spec: Array<[string, string, number]> = [
      ['E000', '女子６×100ｍリレー', 6],
      ['E100', '男子スウェーデンリレー', 4],
    ];
    const rules: RuleSetting[] = [
      ...GENDER_RULES.filter((rule) => ['R000', 'R100'].includes(rule.ruleId)),
      {
        ruleId: 'R900', enabled: true, ruleName: '存在しない学籍番号は登録確認', target: '全競技',
        targetEventIds: 'E000,E100', condition: '', limit: 0, judgment: '警告',
        displayMessage: '学籍番号が確認できません', note: '', expression: 'UNKNOWN == 0',
      },
    ];
    const generated = generateMockSubmissions({
      year: 2026, normalFormId: 'normal-form', correctionFormId: 'correction-form',
      normalRegistry: registryFor(spec),
      correctionRegistry: slots('correction', 'correction-form', 'E000', 6, 1),
      events: events(spec), students, rules,
    }, {
      submissionCount: 5, targetGrades: [1], targetClasses: [1, 2, 3, 4, 5],
      targetFormTypes: ['normal'], errorSubmissionCount: 2, warningSubmissionCount: 1,
    });
    const results = generated.submissions.map((submission) => validateSubmission(
      submission,
      generated.items.filter((item) => item.submissionId === submission.submissionId),
      { students, sameClassInitialSubmissionCount: 1, rules },
    ));
    expect(generated.submissions).toHaveLength(5);
    expect(results.filter((result) => result.errorCount > 0)).toHaveLength(2);
    expect(results.filter((result) => result.errorCount === 0 && result.warningCount > 0))
      .toHaveLength(1);
    expect(results.filter((result) => result.errorCount === 0 && result.warningCount === 0))
      .toHaveLength(2);
    expect(results[0]!.issues.map((issue) => issue.issueCode))
      .toContain(ISSUE_CODES.RULE_EXPRESSION_FALSE);
    expect(generated.notices.join('\n')).toContain('意図的な問題の作り方');
  });

  it('判定=警告のルールが1つも無ければ、代理入力の警告で代用して作成は続ける', () => {
    const students = generateMockStudents();
    const spec: Array<[string, string, number]> = [['E000', '女子６×100ｍリレー', 6]];
    const rules = GENDER_RULES.filter((rule) => rule.ruleId === 'R000');
    const generated = generateMockSubmissions({
      year: 2026, normalFormId: 'normal-form', correctionFormId: 'correction-form',
      normalRegistry: registryFor(spec),
      correctionRegistry: slots('correction', 'correction-form', 'E000', 6, 1),
      events: events(spec), students, rules,
    }, {
      submissionCount: 2, targetGrades: [1], targetClasses: [1, 2],
      targetFormTypes: ['normal'], errorSubmissionCount: 0, warningSubmissionCount: 1,
    });
    const results = generated.submissions.map((submission) => validateSubmission(
      submission,
      generated.items.filter((item) => item.submissionId === submission.submissionId),
      { students, sameClassInitialSubmissionCount: 1, rules },
    ));
    expect(results.filter((result) => result.errorCount === 0 && result.warningCount > 0))
      .toHaveLength(1);
    expect(generated.notices.join('\n')).toContain('代理入力の警告で代用');
  });

  it('矛盾したルールでも疑似申請は作り、満たせなかったルールを知らせる', () => {
    const students = generateMockStudents();
    const spec: Array<[string, string, number]> = [['E000', '女子６×100ｍリレー', 6]];
    const rules: RuleSetting[] = [
      GENDER_RULES[0]!,
      {
        ruleId: 'R001', enabled: true, ruleName: '矛盾する男子限定', target: '指定競技',
        targetEventIds: 'E000', condition: '', limit: 0, judgment: 'エラー',
        displayMessage: 'この競技は男子のみ出場可能です', note: '', expression: 'FEMALE == 0',
      },
    ];
    const generated = generateMockSubmissions({
      year: 2026, normalFormId: 'normal-form', correctionFormId: 'correction-form',
      normalRegistry: registryFor(spec),
      correctionRegistry: slots('correction', 'correction-form', 'E000', 6, 1),
      events: events(spec), students, rules,
    }, {
      submissionCount: 1, targetGrades: [1], targetClasses: [1],
      targetFormTypes: ['normal'], errorSubmissionCount: 0, warningSubmissionCount: 0,
    });
    // 片方は必ず満たせないが、疑似申請そのものは作る。
    expect(generated.submissions).toHaveLength(1);
    expect(generated.items).toHaveLength(6);
    expect(generated.notices.join('\n')).toContain('ルールを満たす割り当てが見つかりませんでした');
  });

  it('全校規模の競技数・ルール数でも、問題なしの疑似申請は全ルールを満たす', () => {
    const students = generateMockStudents();
    const spec: Array<[string, string, number]> = [
      ['E000', '女子６×100ｍリレー', 6], ['E100', '男子スウェーデンリレー', 4],
      ['E200', '男女混合リレー', 4], ['E300', '玉入れ', 10],
      ['E400', '大縄跳び 前半', 20], ['E401', '大縄跳び 後半', 19],
    ];
    for (let team = 0; team < 12; team += 1) {
      spec.push([`E5${String(team).padStart(2, '0')}`, `棒引き 1~4回戦チーム${team + 1}`, 3]);
    }
    for (let horse = 0; horse < 9; horse += 1) {
      spec.push([`E6${String(horse).padStart(2, '0')}`, `騎馬\u3000騎馬上 ${horse + 1}`, 1]);
      spec.push([`E6${String(50 + horse)}`, `騎馬\u3000騎馬下 ${horse + 1}`, 3]);
    }
    const stickIds = spec.filter(([id]) => id.startsWith('E5')).map(([id]) => id).join(',');
    const horseIds = spec.filter(([id]) => id.startsWith('E6')).map(([id]) => id).join(',');
    const rules: RuleSetting[] = [
      ...GENDER_RULES,
      {
        ruleId: 'R400', enabled: true, ruleName: '大縄跳び片方出場制限', target: '指定競技',
        targetEventIds: 'E400,E401', condition: '', limit: 0, judgment: 'エラー',
        displayMessage: '大縄跳びの前半・後半の片方のみに出場可能です', note: '',
        expression: 'MAX_PER_STUDENT <= 1',
      },
      {
        ruleId: 'R500', enabled: true, ruleName: '1人あたりの出場数上限 棒引き', target: '指定競技',
        targetEventIds: stickIds, condition: '', limit: 0, judgment: 'エラー',
        displayMessage: '同じ生徒が登録上限を超えています', note: '',
        expression: 'MAX_PER_STUDENT <= 2',
      },
      {
        ruleId: 'R600', enabled: true, ruleName: '騎馬戦１人あたり出場数制限', target: '指定競技',
        targetEventIds: horseIds, condition: '', limit: 0, judgment: 'エラー',
        displayMessage: '一人が構成できる騎馬は１つまでです', note: '',
        expression: 'MAX_PER_STUDENT <= 1',
      },
      // 騎馬ごとの「同性で構成」。1枠ずつ直しても抜け出せない組み合わせになりやすい。
      ...Array.from({ length: 9 }, (_, horse) => ({
        ruleId: `R60${horse + 1}`, enabled: true, ruleName: `騎馬${horse + 1}同性で構成`,
        target: '指定競技' as const,
        targetEventIds: `E6${String(horse).padStart(2, '0')},E6${String(50 + horse)}`,
        condition: '', limit: 0, judgment: 'エラー' as const,
        displayMessage: '騎馬は同性で構成してください', note: '',
        expression: 'MALE == 0 OR FEMALE == 0',
      })),
      {
        ruleId: 'R902', enabled: true, ruleName: '同一競技内の重複登録は禁止', target: '全競技',
        targetEventIds: spec.map(([id]) => id).join(','), condition: '', limit: 1,
        judgment: 'エラー', displayMessage: '同じ選手が重複しています', note: '',
        expression: 'MAX_PER_EVENT <= 1',
      },
    ];
    const generated = generateMockSubmissions({
      year: 2026, normalFormId: 'normal-form', correctionFormId: 'correction-form',
      normalRegistry: registryFor(spec),
      correctionRegistry: slots('correction', 'correction-form', 'E000', 6, 1),
      events: events(spec), students, rules,
    }, {
      submissionCount: 3, targetGrades: [1], targetClasses: [1, 2, 3],
      targetFormTypes: ['normal'], errorSubmissionCount: 1, warningSubmissionCount: 0,
    });
    const results = generated.submissions.map((submission) => validateSubmission(
      submission,
      generated.items.filter((item) => item.submissionId === submission.submissionId),
      { students, sameClassInitialSubmissionCount: 1, rules },
    ));
    expect(results.filter((result) => result.errorCount > 0)).toHaveLength(1);
    expect(results.slice(1).every((result) => result.errorCount === 0)).toBe(true);
    expect(generated.notices.filter((notice) => notice.includes('見つかりませんでした'))).toEqual([]);
    // 騎馬は9組とも同性で構成されている。
    for (let horse = 0; horse < 9; horse += 1) {
      const eventIds = [`E6${String(horse).padStart(2, '0')}`, `E6${String(50 + horse)}`];
      const genders = generated.items
        .filter((item) => item.submissionId === generated.submissions[1]!.submissionId)
        .filter((item) => eventIds.includes(item.eventId))
        .map((item) => students.find((candidate) => candidate.studentId === item.studentIdInput)?.gender);
      expect(genders).toHaveLength(4);
      expect(new Set(genders).size).toBe(1);
    }
  });
});
