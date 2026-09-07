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
  count: number, displayStart: number, includeState = false,
): FormRegistryRow[] {
  const prefix = formType === 'correction' ? 'correction_' : '';
  return Array.from({ length: count }, (_, offset) => {
    const slot = String(offset + 1).padStart(2, '0');
    const base = `${prefix}${eventId}_slot${slot}`;
    return [
      // 欠員許可の競技だけ、フォームに登録状態の質問が並ぶ。
      ...(includeState ? [{
        formType, formId, itemId: `${eventId}-state-${slot}`, fieldKey: `${base}_state`,
        eventId, title: base, itemType: 'multiple_choice', displayOrder: displayStart + offset * 10,
        enabled: true,
      }] : []),
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
  describe('欠員許可を考慮した割り当て', () => {
    /** 欠員許可の競技だけで構成した疑似申請を1件作り、検査結果と一緒に返す。 */
    function generateVacancy(spec: Array<[string, string, number]>, rules: RuleSetting[]): {
      filled: number; vacant: number; errorCount: number; notices: string[];
    } {
      const students = generateMockStudents();
      const generated = generateMockSubmissions({
        year: 2026, normalFormId: 'normal-form', correctionFormId: 'correction-form',
        normalRegistry: spec.flatMap(([eventId, , count], offset) =>
          slots('normal', 'normal-form', eventId, count, offset * 1_000, true)),
        correctionRegistry: slots('correction', 'correction-form', spec[0]![0], spec[0]![2], 1, true),
        events: spec.map(([eventId, eventName, requiredCount], offset) => ({
          ...baseEvent, eventId, eventName, requiredCount, vacancyAllowed: true,
          displayOrder: offset + 1,
        })),
        students, rules,
      }, {
        submissionCount: 1, targetGrades: [1], targetClasses: [1], targetFormTypes: ['normal'],
        errorSubmissionCount: 0, warningSubmissionCount: 0,
      });
      const validation = validateSubmission(generated.submissions[0]!, generated.items, {
        students, sameClassInitialSubmissionCount: 1, rules,
      });
      return {
        filled: generated.items.filter((item) => item.registrationState === 'REGISTER').length,
        vacant: generated.items
          .filter((item) => item.registrationState === 'NOT_PARTICIPATING').length,
        errorCount: validation.errorCount,
        notices: generated.notices,
      };
    }

    const equalGenders = (ruleId: string, eventIds: string): RuleSetting => ({
      ruleId, enabled: true, ruleName: '男女同数', target: '指定競技',
      targetEventIds: eventIds, condition: '', limit: 0, judgment: 'エラー',
      displayMessage: '男女同数で登録してください', note: '', expression: 'M == F',
    });
    const atLeast = (ruleId: string, eventIds: string, total: number): RuleSetting => ({
      ruleId, enabled: true, ruleName: `最低${total}人`, target: '指定競技',
      targetEventIds: eventIds, condition: '', limit: 0, judgment: 'エラー',
      displayMessage: `${total}人以上を登録してください`, note: '', expression: `N >= ${total}`,
    });

    /** 前半・後半に片方しか出られない大縄跳び。枠の合計がクラスの人数を5つ超える。 */
    const JUMP_RULES: RuleSetting[] = [{
      ruleId: 'R400', enabled: true, ruleName: '大縄跳び片方出場制限', target: '指定競技',
      targetEventIds: 'E400,E401', condition: '', limit: 0, judgment: 'エラー',
      displayMessage: '大縄跳びの前半・後半の片方のみに出場可能です', note: '',
      expression: 'MAX_PER_STUDENT <= 1',
    }];

    function generateJump(vacancyAllowed: boolean, errorSubmissionCount: number): {
      students: ReturnType<typeof generateMockStudents>;
      generated: ReturnType<typeof generateMockSubmissions>;
    } {
      const students = generateMockStudents();
      const classSize = students
        .filter((student) => student.grade === 1 && student.classNumber === 1).length;
      const spec: Array<[string, string, number]> = [
        ['E400', '大縄跳び 前半', 20], ['E401', '大縄跳び 後半', classSize - 20 + 5],
      ];
      const generated = generateMockSubmissions({
        year: 2026, normalFormId: 'normal-form', correctionFormId: 'correction-form',
        normalRegistry: spec.flatMap(([eventId, , count], offset) =>
          slots('normal', 'normal-form', eventId, count, offset * 1_000, vacancyAllowed)),
        correctionRegistry: slots('correction', 'correction-form', 'E400', 20, 1, vacancyAllowed),
        events: spec.map(([eventId, eventName, requiredCount], offset) => ({
          ...baseEvent, eventId, eventName, requiredCount, vacancyAllowed, displayOrder: offset + 1,
        })),
        students, rules: JUMP_RULES,
      }, {
        submissionCount: 1, targetGrades: [1], targetClasses: [1], targetFormTypes: ['normal'],
        errorSubmissionCount, warningSubmissionCount: 0,
      });
      return { students, generated };
    }

    it('欠員許可の枠は、誰を入れてもルールを破るなら空けて警告だけにする', () => {
      const { students, generated } = generateJump(true, 0);
      const validation = validateSubmission(generated.submissions[0]!, generated.items, {
        students, sameClassInitialSubmissionCount: 1, rules: JUMP_RULES,
      });
      expect(validation.errorCount).toBe(0);
      expect(validation.issues.map((issue) => issue.issueCode))
        .toEqual([ISSUE_CODES.VACANCY_CAPACITY_SHORTFALL]);
      expect(generated.notices).toEqual([]);
      // 空けたのは超過した5枠だけ。埋められる枠は埋めたままにする。
      expect(generated.items.filter((item) => item.registrationState === 'NOT_PARTICIPATING'))
        .toHaveLength(5);
    });

    it('欠員を許可していない同じ競技では、空けずにルール違反として知らせる', () => {
      const { students, generated } = generateJump(false, 0);
      const validation = validateSubmission(generated.submissions[0]!, generated.items, {
        students, sameClassInitialSubmissionCount: 1, rules: JUMP_RULES,
      });
      expect(generated.items.every((item) => item.studentIdInput !== '')).toBe(true);
      expect(validation.issues.map((issue) => issue.issueCode))
        .toContain(ISSUE_CODES.RULE_EXPRESSION_FALSE);
      expect(generated.notices.join('\n')).toContain('ルールを満たす割り当てが見つかりませんでした');
    });

    it('枠を空けたあとでも、意図的なエラーの疑似申請はルールを破って作れる', () => {
      const { students, generated } = generateJump(true, 1);
      const validation = validateSubmission(generated.submissions[0]!, generated.items, {
        students, sameClassInitialSubmissionCount: 1, rules: JUMP_RULES,
      });
      expect(validation.errorCount).toBeGreaterThan(0);
      expect(generated.notices.join('\n')).toContain('R400｜大縄跳び片方出場制限 を破る');
    });

    it('途中の集計だけを見て枠を空けない。男女同数のルールでも全枠を埋める', () => {
      // 1枠目を埋めた時点では`M == F`が崩れるが、4枠そろえば成立する。
      // 決めかけの状態で空けると、空けたほうが成立して見えて全枠が空いてしまう。
      const result = generateVacancy([['E200', '男女混合リレー', 4]], [equalGenders('R500', 'E200')]);
      expect(result.filled).toBe(4);
      expect(result.vacant).toBe(0);
      expect(result.errorCount).toBe(0);
      expect(result.notices).toEqual([]);
    });

    it('登録人数の下限（N >= x）を、複数競技をまたいでも満たす', () => {
      const result = generateVacancy(
        [['E200', '男女混合リレー 前', 4], ['E201', '男女混合リレー 後', 4]],
        [equalGenders('R500', 'E200'), equalGenders('R501', 'E201'),
          atLeast('R502', 'E200,E201', 8)],
      );
      expect(result.filled).toBe(8);
      expect(result.vacant).toBe(0);
      expect(result.errorCount).toBe(0);
      expect(result.notices).toEqual([]);
    });

    it('枠を空けるルールと登録人数の下限があっても、両方を満たす', () => {
      const students = generateMockStudents();
      const classSize = students
        .filter((student) => student.grade === 1 && student.classNumber === 1).length;
      // 44枠・39人。5枠を空ければ`MAX_PER_STUDENT <= 1`と`N >= 36`の両方が成り立つ。
      const result = generateVacancy(
        [['E400', '大縄跳び 前半', 20], ['E401', '大縄跳び 後半', classSize - 20 + 5]],
        [...JUMP_RULES, atLeast('R402', 'E400,E401', 36)],
      );
      expect(result.filled).toBe(classSize);
      expect(result.vacant).toBe(5);
      expect(result.errorCount).toBe(0);
      expect(result.notices).toEqual([]);
    });

    it('空けても下限を満たせないルールは、空けずに満たせなかったと知らせる', () => {
      const students = generateMockStudents();
      const classSize = students
        .filter((student) => student.grade === 1 && student.classNumber === 1).length;
      // `N >= 40`はクラスの人数を超えるので、`MAX_PER_STUDENT <= 1`と両立しない。
      const result = generateVacancy(
        [['E400', '大縄跳び 前半', 20], ['E401', '大縄跳び 後半', classSize - 20 + 5]],
        [...JUMP_RULES, atLeast('R402', 'E400,E401', classSize + 1)],
      );
      expect(result.vacant).toBe(0);
      expect(result.errorCount).toBeGreaterThan(0);
      expect(result.notices.join('\n')).toContain('ルールを満たす割り当てが見つかりませんでした');
    });

    it('欠員許可にしてもフォームへ登録状態の質問が無ければ、枠を空けられないので停止する', () => {
      const students = generateMockStudents();
      const classSize = students
        .filter((student) => student.grade === 1 && student.classNumber === 1).length;
      const requiredCount = classSize + 1;
      // 競技設定を`欠員許可=TRUE`にしたあと、フォーム下書きを作り直していない状態。
      const build = (): unknown => generateMockSubmissions({
        year: 2026, normalFormId: 'normal-form', correctionFormId: 'correction-form',
        normalRegistry: slots('normal', 'normal-form', 'E300', requiredCount, 0),
        correctionRegistry: slots('correction', 'correction-form', 'E300', requiredCount, 0),
        events: [{ ...baseEvent, eventId: 'E300', eventName: '玉入れ', requiredCount,
          vacancyAllowed: true, displayOrder: 1 }],
        students, rules: [],
      }, {
        submissionCount: 1, targetGrades: [1], targetClasses: [1], targetFormTypes: ['normal'],
        errorSubmissionCount: 0, warningSubmissionCount: 0,
      });
      expect(build).toThrow('「出場しない」を選べない登録枠');
      expect(build).toThrow('フォーム下書きも作り直してください');
    });

    it('全員を埋められる欠員許可の競技は、空けずに全枠を埋める', () => {
      const students = generateMockStudents();
      const rules = GENDER_RULES.filter((rule) => rule.ruleId === 'R300');
      const generated = generateMockSubmissions({
        year: 2026, normalFormId: 'normal-form', correctionFormId: 'correction-form',
        normalRegistry: slots('normal', 'normal-form', 'E300', 10, 0, true),
        correctionRegistry: slots('correction', 'correction-form', 'E300', 10, 0, true),
        events: [{ ...baseEvent, eventId: 'E300', eventName: '玉入れ', requiredCount: 10,
          vacancyAllowed: true, displayOrder: 1 }],
        students, rules,
      }, {
        submissionCount: 1, targetGrades: [1], targetClasses: [1], targetFormTypes: ['normal'],
        errorSubmissionCount: 0, warningSubmissionCount: 0,
      });
      const validation = validateSubmission(generated.submissions[0]!, generated.items, {
        students, sameClassInitialSubmissionCount: 1, rules,
      });
      expect(generated.items.every((item) => item.studentIdInput !== '')).toBe(true);
      expect(validation.errorCount).toBe(0);
      expect(validation.warningCount).toBe(0);
    });
  });
});
