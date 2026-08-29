import type {
  Severity,
  RuleSetting,
  Submission,
  SubmissionItem,
  ValidationContext,
  ValidationIssue,
  ValidationResult,
} from '../shared/types';
import { normalizeName, normalizeStudentId } from './normalization';
import {
  evaluateRuleExpression,
  type RuleExpressionValues,
} from './rule-expression';

export const ISSUE_CODES = {
  STUDENT_ID_MISSING: 'STUDENT_ID_MISSING',
  STUDENT_ID_INVALID: 'STUDENT_ID_INVALID',
  STUDENT_NOT_FOUND: 'STUDENT_NOT_FOUND',
  STUDENT_CLASS_MISMATCH: 'STUDENT_CLASS_MISMATCH',
  REQUIRED_SLOT_MISSING: 'REQUIRED_SLOT_MISSING',
  VACANCY_CAPACITY_SHORTFALL: 'VACANCY_CAPACITY_SHORTFALL',
  MULTIPLE_INITIAL_SUBMISSIONS: 'MULTIPLE_INITIAL_SUBMISSIONS',
  PROXY_SUBMISSION: 'PROXY_SUBMISSION',
  REGISTRATION_PENDING: 'REGISTRATION_PENDING',
  CORRECTION_WHILE_CLOSED: 'CORRECTION_WHILE_CLOSED',
  RULE_EXPRESSION_FALSE: 'RULE_EXPRESSION_FALSE',
  RULE_EXPRESSION_INVALID: 'RULE_EXPRESSION_INVALID',
} as const;

type IssueCode = (typeof ISSUE_CODES)[keyof typeof ISSUE_CODES];

interface IssueText {
  title: string;
  instruction: string;
}

const ISSUE_TEXT: Record<IssueCode, IssueText> = {
  STUDENT_ID_MISSING: {
    title: '学籍番号が入力されていません',
    instruction: '選手本人に学籍番号を確認し、半角数字4桁で入力してください。',
  },
  STUDENT_ID_INVALID: {
    title: '学籍番号の書き方を確認してください',
    instruction: '学籍番号を「学年・組・出席番号」の半角数字4桁で入力してください（例：1年3組4番は1304）。',
  },
  STUDENT_NOT_FOUND: {
    title: '生徒マスターにない学籍番号です',
    instruction: '入力ミスか、転入などで生徒マスターへ未登録かを確認してください。番号が誤っていれば直し、実在する生徒なら「生徒マスター」へ追加して再検査します。名簿へ載せる氏名が空欄のままでよければ、この警告を残したまま承認できます。',
  },
  STUDENT_CLASS_MISMATCH: {
    title: '別のクラスの学籍番号です',
    instruction: '画面に表示された「登録対象クラス」と「学籍番号から読み取れる所属」を比べてください。対象クラスの選手なら学籍番号を直し、対象クラスの指定が誤っている場合は回答を却下して正しいフォーム回答を使用してください。',
  },
  REQUIRED_SLOT_MISSING: {
    title: '必須の選手枠が埋まっていません',
    instruction: 'この枠の選手を決め、「選手を登録する」を選んで学籍番号を入力してください。',
  },
  VACANCY_CAPACITY_SHORTFALL: {
    title: '欠員許可により選手を登録していない枠があります',
    instruction: '欠員を許可した競技なので、この警告を残したまま承認できます。実際には選手を登録する場合だけ、該当枠を修正してください。',
  },
  MULTIPLE_INITIAL_SUBMISSIONS: {
    title: '同じクラスから複数の初回回答があります',
    instruction: '各回答の内容と送信日時を確認し、採用する回答を1件選んでください。',
  },
  PROXY_SUBMISSION: {
    title: '入力者が対象クラスの代わりに入力しています',
    instruction: '画面に表示された「入力者の所属」と「登録対象クラス」が異なる場合の表示です。代理入力で間違いなければ、選手内容を確認して警告を残したまま承認できます。',
  },
  REGISTRATION_PENDING: {
    title: '登録状態が「調整中」です',
    instruction: '学籍番号は入力されていますが、まだ最終確定ではありません。サイドバーの「この項目を修正」から登録状態を「選手を登録する」または「出場しない」に変更し、修正理由を保存してください。',
  },
  CORRECTION_WHILE_CLOSED: {
    title: '受付停止中に届いた修正申請です',
    instruction: '内容を確認し、受付を再開するか、この申請を保留のまま個別に対応してください。',
  },
  RULE_EXPRESSION_FALSE: {
    title: '登録内容がルールを満たしていません',
    instruction: '対象競技の選手構成を確認し、表示されたルールを満たすように修正してください。',
  },
  RULE_EXPRESSION_INVALID: {
    title: 'ルール設定の論理式を判定できません',
    instruction: '体育祭スタッフが「ルール設定」シートの論理式を直してから、もう一度検査してください。',
  },
};

export function validateSubmission(
  submission: Submission,
  items: SubmissionItem[],
  context: ValidationContext,
): ValidationResult {
  const normalizedItems = items.map((item) => ({
    ...item,
    normalizedStudentId: normalizeStudentId(item.studentIdInput),
    normalizedName: normalizeName(item.studentNameInput),
  }));
  const studentsById = new Map(context.students.map((student) => [student.studentId, student]));
  const issues: ValidationIssue[] = [];

  const addIssue = (
    code: IssueCode,
    severity: Severity,
    item: SubmissionItem | undefined,
    currentValue: string,
    override?: Partial<Pick<ValidationIssue, 'displayTitle' | 'locationText' | 'fixInstruction'>>,
  ): void => {
    const text = ISSUE_TEXT[code];
    issues.push({
      issueId: `${submission.submissionId}-issue-${String(issues.length + 1).padStart(3, '0')}`,
      submissionId: submission.submissionId,
      submissionItemId: item?.submissionItemId ?? '',
      severity,
      issueCode: code,
      displayTitle: override?.displayTitle ?? text.title,
      locationText: override?.locationText ?? (item ? `${item.eventName} / ${item.slotName}` : '申請全体'),
      currentValue,
      fixInstruction: override?.fixInstruction ?? text.instruction,
      status: 'UNCONFIRMED',
    });
  };

  const firstItem = normalizedItems[0];
  if (submission.submissionType === 'INITIAL' && context.sameClassInitialSubmissionCount > 1) {
    addIssue(ISSUE_CODES.MULTIPLE_INITIAL_SUBMISSIONS, 'WARNING', firstItem, `${context.sameClassInitialSubmissionCount}件`);
  }
  const submitter = studentsById.get(normalizeStudentId(submission.submitterStudentId));
  const isActualProxy = Boolean(submitter
    && (submitter.grade !== submission.targetGrade || submitter.classNumber !== submission.targetClass));
  if (isActualProxy) {
    addIssue(ISSUE_CODES.PROXY_SUBMISSION, 'WARNING', undefined, `${submission.targetGrade}年${submission.targetClass}組`);
  }
  const correctionWhileClosed = submission.submissionType === 'CORRECTION' && !submission.receptionOpen;
  if (correctionWhileClosed) {
    addIssue(ISSUE_CODES.CORRECTION_WHILE_CLOSED, 'WARNING', firstItem, '受付停止中');
  }

  for (const item of normalizedItems) {
    const hasStudentInput = item.normalizedStudentId !== '' || item.normalizedName !== '';
    if (item.required && item.registrationState === 'NOT_PARTICIPATING') {
      addIssue(ISSUE_CODES.REQUIRED_SLOT_MISSING, 'ERROR', item, registrationStateLabel(item.registrationState));
    }
    if (item.required && item.registrationState === 'PENDING' && !hasStudentInput) {
      addIssue(ISSUE_CODES.REQUIRED_SLOT_MISSING, 'ERROR', item, registrationStateLabel(item.registrationState));
    }
    if (item.registrationState === 'PENDING') {
      addIssue(ISSUE_CODES.REGISTRATION_PENDING, 'WARNING', item, '調整中');
    }
    if (item.registrationState === 'NOT_PARTICIPATING' || (item.registrationState === 'PENDING' && !hasStudentInput)) continue;

    const studentId = item.normalizedStudentId;
    if (studentId === '') {
      addIssue(ISSUE_CODES.STUDENT_ID_MISSING, 'ERROR', item, '未入力');
      continue;
    }
    if (!/^[1-3][1-8][0-9]{2}$/.test(studentId)) {
      addIssue(ISSUE_CODES.STUDENT_ID_INVALID, 'ERROR', item, item.studentIdInput);
      continue;
    }

    const student = studentsById.get(studentId);
    if (!student) {
      // 転入直後などで生徒マスターへ未登録の生徒が稀にいるため警告とする。エラーにすると
      // クラス全体の申請が承認できず名簿作成が止まる。厳しくしたい年度は「ルール設定」へ
      // 判定エラーの`INVALID_ID == 0`を追加する。
      addIssue(ISSUE_CODES.STUDENT_NOT_FOUND, 'WARNING', item, studentId);
      continue;
    }
    if (student.grade !== submission.targetGrade || student.classNumber !== submission.targetClass) {
      addIssue(ISSUE_CODES.STUDENT_CLASS_MISMATCH, 'ERROR', item, studentId);
    }
  }

  addExpressionRuleIssues(
    submission, normalizedItems, studentsById, context.rules, addIssue,
  );
  addVacancyWarnings(normalizedItems, addIssue);

  const warningCount = issues.filter((issue) => issue.severity === 'WARNING').length;
  const errorCount = issues.filter((issue) => issue.severity === 'ERROR').length;

  return {
    normalizedItems,
    issues,
    warningCount,
    errorCount,
    nextStatus: correctionWhileClosed ? 'ON_HOLD' : errorCount > 0 ? 'NEEDS_CORRECTION' : 'PENDING_APPROVAL',
  };
}

function expressionTargetItems(items: SubmissionItem[], rule: RuleSetting): SubmissionItem[] {
  const eventIds = new Set(rule.targetEventIds.split(',').map((value) => value.trim()).filter(Boolean));
  return items.filter((item) => rule.target === '全競技' || eventIds.has(item.eventId)
    || (rule.target === 'リレー' && item.eventName.includes('リレー'))
    || (rule.target === '個人種目' && !item.eventName.includes('リレー')));
}

function expressionValues(
  submission: Submission,
  items: SubmissionItem[],
  studentsById: Map<string, ValidationContext['students'][number]>,
): RuleExpressionValues {
  const registered = items.filter((item) => item.registrationState === 'REGISTER');
  const ids = registered.map((item) => item.normalizedStudentId).filter(Boolean);
  const counts = new Map<string, number>();
  ids.forEach((id) => counts.set(id, (counts.get(id) ?? 0) + 1));
  const students = registered.map((item) => studentsById.get(item.normalizedStudentId));
  const male = students.filter((student) => student?.gender === 'M').length;
  const female = students.filter((student) => student?.gender === 'F').length;
  const invalidId = registered.filter((item) => !studentsById.has(item.normalizedStudentId)).length;
  const nameMismatch = registered.filter((item) => {
    // 氏名の入力がある回答だけを数える。学籍番号のみのフォームでは常に0になる。
    if (item.studentNameInput.trim() === '') return false;
    const student = studentsById.get(item.normalizedStudentId);
    return Boolean(student && normalizeName(student.name) !== item.normalizedName);
  }).length;
  const classMismatch = registered.filter((item) => {
    const student = studentsById.get(item.normalizedStudentId);
    return Boolean(student
      && (student.grade !== submission.targetGrade || student.classNumber !== submission.targetClass));
  }).length;
  const maximum = Math.max(0, ...counts.values());
  // 同じ競技の中で同じ生徒が何回登録されているかの最大値。競技をまたぐ出場は数えない。
  const countsPerEvent = new Map<string, number>();
  registered.forEach((item) => {
    if (!item.normalizedStudentId) return;
    const key = `${item.eventId}:${item.normalizedStudentId}`;
    countsPerEvent.set(key, (countsPerEvent.get(key) ?? 0) + 1);
  });
  const maximumPerEvent = Math.max(0, ...countsPerEvent.values());
  return {
    M: male,
    F: female,
    N: registered.length,
    UNKNOWN: registered.length - male - female,
    EMPTY: items.filter((item) => item.registrationState === 'NOT_PARTICIPATING').length,
    REQUIRED_EMPTY: items.filter((item) => item.required && item.registrationState !== 'REGISTER').length,
    UNIQUE: new Set(ids).size,
    DUPLICATE: [...counts.values()].reduce((total, count) => total + Math.max(0, count - 1), 0),
    MAX_PER_STUDENT: maximum,
    MAX_PER_EVENT: maximumPerEvent,
    INVALID_ID: invalidId,
    NAME_MISMATCH: nameMismatch,
    CLASS_MISMATCH: classMismatch,
    PENDING: items.filter((item) => item.registrationState === 'PENDING').length,
  };
}

function addExpressionRuleIssues(
  submission: Submission,
  items: SubmissionItem[],
  studentsById: Map<string, ValidationContext['students'][number]>,
  rules: RuleSetting[] | undefined,
  addIssue: (
    code: IssueCode, severity: Severity, item: SubmissionItem | undefined,
    currentValue: string,
    override?: Partial<Pick<ValidationIssue, 'displayTitle' | 'locationText' | 'fixInstruction'>>,
  ) => void,
): void {
  (rules ?? []).filter((rule) => rule.enabled && (rule.expression ?? '').trim()).forEach((rule) => {
    const targetItems = expressionTargetItems(items, rule);
    if (targetItems.length === 0) return;
    const values = expressionValues(submission, targetItems, studentsById);
    const valueText = `M=${values.M}, F=${values.F}, N=${values.N}, UNKNOWN=${values.UNKNOWN}, `
      + `EMPTY=${values.EMPTY}, UNIQUE=${values.UNIQUE}, MAX_PER_STUDENT=${values.MAX_PER_STUDENT}, `
      + `MAX_PER_EVENT=${values.MAX_PER_EVENT}`;
    try {
      if (evaluateRuleExpression(rule.expression ?? '', values)) return;
      const eventNames = [...new Set(targetItems.map((item) => item.eventName))];
      addIssue(
        ISSUE_CODES.RULE_EXPRESSION_FALSE,
        rule.judgment === '警告' ? 'WARNING' : 'ERROR',
        undefined,
        valueText,
        {
          displayTitle: rule.displayMessage.trim() || `「${rule.ruleName || rule.ruleId}」を満たしていません`,
          locationText: eventNames.length > 0 ? eventNames.join('、') : '対象競技',
          fixInstruction: `対象競技の登録を確認してください。ルール：${rule.ruleName || rule.ruleId} / 論理式：${rule.expression}`,
        },
      );
    } catch (error) {
      addIssue(ISSUE_CODES.RULE_EXPRESSION_INVALID, 'ERROR', undefined, rule.expression ?? '', {
        displayTitle: `「${rule.ruleName || rule.ruleId}」の論理式を判定できません`,
        locationText: 'ルール設定',
        fixInstruction: `「ルール設定」シートの論理式を直してください。${error instanceof Error ? error.message : String(error)}`,
      });
    }
  });
}

function addVacancyWarnings(
  items: SubmissionItem[],
  addIssue: (
    code: IssueCode, severity: Severity, item: SubmissionItem | undefined,
    currentValue: string,
    override?: Partial<Pick<ValidationIssue, 'displayTitle' | 'locationText' | 'fixInstruction'>>,
  ) => void,
): void {
  const byEvent = new Map<string, SubmissionItem[]>();
  items.filter((item) => !item.required && item.registrationState === 'NOT_PARTICIPATING')
    .forEach((item) => {
      const group = byEvent.get(item.eventId) ?? [];
      group.push(item);
      byEvent.set(item.eventId, group);
    });
  for (const vacancies of byEvent.values()) {
    const eventName = vacancies[0]?.eventName ?? '競技';
    addIssue(ISSUE_CODES.VACANCY_CAPACITY_SHORTFALL, 'WARNING', undefined, `${vacancies.length}枠`, {
      displayTitle: `${eventName}は欠員許可により${vacancies.length}枠を空けています`,
      locationText: `${eventName} / ${vacancies.map((item) => item.slotName).join('、')}`,
    });
  }
}

function registrationStateLabel(state: SubmissionItem['registrationState']): string {
  if (state === 'PENDING') return '調整中';
  if (state === 'NOT_PARTICIPATING') return '出場しない';
  return '登録済み';
}
