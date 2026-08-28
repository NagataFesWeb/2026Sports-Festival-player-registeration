import { convertFormAnswer } from '../core/form-response';
import { appliesToGrade } from '../core/settings';
import { ISSUE_CODES, validateSubmission } from '../core/validation';
import type {
  EventSetting,
  FormRegistryRow,
  MockDataGenerationConfig,
  RuleSetting,
  Student,
  Submission,
  SubmissionItem,
} from '../shared/types';
import type { RawFormResponseRecord } from './repository';

export interface MockFormSource {
  year: number;
  normalFormId: string;
  correctionFormId: string;
  normalRegistry: FormRegistryRow[];
  correctionRegistry: FormRegistryRow[];
  events: EventSetting[];
  students: Student[];
  rules?: RuleSetting[];
}

export interface MockSubmissions {
  submissions: Submission[];
  items: SubmissionItem[];
  rawResponses: RawFormResponseRecord[];
}

interface ScenarioResult {
  submission: Submission;
  items: SubmissionItem[];
  rawResponse: RawFormResponseRecord;
}

type AnswerMutator = (answers: Record<string, string>, studentIdKeys: string[]) => void;

/** 現在の生成フォームの項目対応表から、疑似フォーム回答と承認待ちデータを作る。 */
export function generateMockSubmissions(
  source: MockFormSource,
  config?: MockDataGenerationConfig,
  startSequence = 1,
): MockSubmissions {
  assertFormSource(source);
  const normalGrades = ([1, 2, 3] as const).filter((grade) =>
    studentIdMappings(source.normalRegistry, 'normal')
      .some((mapping) => source.events.some((event) => event.eventId === mapping.eventId && appliesToGrade(event, grade))),
  );
  const normalGrade = normalGrades[0];
  if (!normalGrade) throw new Error('通常フォームに選手の学籍番号欄がありません。競技設定を確認してフォームを作り直してください。');

  const correctionEventId = studentIdMappings(source.correctionRegistry, 'correction')[0]?.eventId;
  const correctionEvent = source.events.find((event) => event.eventId === correctionEventId);
  if (!correctionEventId || !correctionEvent) {
    throw new Error('修正フォームに競技の学籍番号欄がありません。フォームを作り直してください。');
  }
  const correctionGrade = correctionEvent.targetGrade === '全学年'
    ? normalGrade
    : Number(correctionEvent.targetGrade[0]);

  if (config) return generateConfiguredMockSubmissions(source, config, normalGrades, startSequence);

  const scenarios: ScenarioResult[] = [
    makeScenario(source, 'mock-response-01', 'normal', normalGrade, 1, true),
    makeScenario(source, 'mock-response-02', 'normal', normalGrade, 2, true, (answers) => {
      const proxy = studentAt(source.students, normalGrade, 1, 1);
      answers.submitter_student_id = proxy.studentId;
      answers.submitter_name_input = proxy.name;
      answers.is_proxy = '別のクラスを代理で入力';
    }),
    makeScenario(source, 'mock-response-03', 'normal', normalGrade, 3, true, (answers, keys) => {
      answers[keys[0]!] = '9999';
      answers[keys[0]!.replace(/_student_id$/, '_name')] = '存在しない架空生徒';
      if (keys[1]) {
        const otherClass = studentAt(source.students, normalGrade, 4, 2);
        answers[keys[1]] = otherClass.studentId;
        answers[keys[1].replace(/_student_id$/, '_name')] = otherClass.name;
      }
    }),
    makeScenario(source, 'mock-response-04', 'correction', correctionGrade, 4, false, (answers, keys) => {
      const stateKey = keys[0]?.replace(/_student_id$/, '_state');
      if (stateKey && source.correctionRegistry.some((mapping) => mapping.fieldKey === stateKey)) {
        answers[stateKey] = '現在調整中';
      }
    }, correctionEventId),
    makeScenario(source, 'mock-response-05', 'normal', normalGrade, 1, true),
  ];

  return {
    submissions: scenarios.map((scenario) => scenario.submission),
    items: scenarios.flatMap((scenario) => scenario.items),
    rawResponses: scenarios.map((scenario) => scenario.rawResponse),
  };
}

function assertConfiguredScenariosMatchRequestedProblems(
  source: MockFormSource,
  scenarios: ScenarioResult[],
  config: MockDataGenerationConfig,
): void {
  scenarios.forEach((scenario, index) => {
    const validation = validateSubmission(scenario.submission, scenario.items, {
      students: source.students,
      sameClassInitialSubmissionCount: 1,
      ...(source.rules ? { rules: source.rules } : {}),
    });
    const expectedCodes = index < config.errorSubmissionCount
      ? new Set([configuredErrorCode(source, index)])
      : index < config.errorSubmissionCount + config.warningSubmissionCount
        ? new Set([ISSUE_CODES.PROXY_SUBMISSION])
        : new Set<string>();
    validation.issues
      .filter((issue) => issue.issueCode === ISSUE_CODES.VACANCY_CAPACITY_SHORTFALL)
      .forEach((issue) => expectedCodes.add(issue.issueCode));
    const unexpected = validation.issues.filter((issue) => !expectedCodes.has(issue.issueCode));
    const missingExpected = [...expectedCodes].filter((code) =>
      !validation.issues.some((issue) => issue.issueCode === code));
    if (unexpected.length === 0 && missingExpected.length === 0) return;
    const problem = unexpected[0];
    const target = `${scenario.submission.targetGrade}年${scenario.submission.targetClass}組`;
    if (problem?.issueCode === ISSUE_CODES.DUPLICATE_STUDENT) {
      throw new Error(
        `疑似データを作成する前の点検で、${target}に意図しない選手重複が見つかりました。${problem.displayTitle}。競技設定の必要人数と、ルール設定の重複上限・対象競技を確認してください。疑似データは書き換えていません。`,
      );
    }
    throw new Error(
      `疑似データを作成する前の点検で、${target}に指定していない問題が見つかりました。${problem?.displayTitle ?? '指定した問題を再現できません'}。ルール設定と競技設定を確認してください。疑似データは書き換えていません。`,
    );
  });
}

function configuredErrorCode(source: MockFormSource, index: number): string {
  const studentMasterErrorEnabled = !source.rules || source.rules.some((rule) =>
    rule.enabled && rule.condition.includes('生徒マスター存在確認') && rule.judgment === 'エラー');
  return studentMasterErrorEnabled && index % 2 === 0
    ? ISSUE_CODES.STUDENT_ID_INVALID
    : ISSUE_CODES.STUDENT_CLASS_MISMATCH;
}

function generateConfiguredMockSubmissions(
  source: MockFormSource,
  config: MockDataGenerationConfig,
  normalGrades: readonly number[],
  startSequence: number,
): MockSubmissions {
  if (!Number.isInteger(startSequence) || startSequence < 1) {
    throw new Error('疑似回答の開始番号が正しくありません。既存の疑似回答を確認してください。');
  }
  if (!Number.isInteger(config.submissionCount) || config.submissionCount < 1) {
    throw new Error('疑似申請数は1以上の整数で入力してください。');
  }
  if (config.targetGrades.length === 0 || config.targetClasses.length === 0) {
    throw new Error('疑似データを作る学年とクラスを1つ以上選んでください。');
  }
  if (config.targetFormTypes.length === 0) {
    throw new Error('疑似データを作る通常フォームまたは修正フォームを1つ以上選んでください。');
  }
  const targetClasses = config.targetGrades
    .filter((grade) => normalGrades.includes(grade))
    .flatMap((grade) => config.targetClasses
      .filter((classNumber) => source.students.some((student) =>
        student.grade === grade && student.classNumber === classNumber))
      .map((classNumber) => ({ grade, classNumber })));
  if (targetClasses.length === 0) {
    throw new Error('選択した学年・組に対応する通常フォームの入力欄がありません。競技設定とフォームを確認してください。');
  }

  const scenarios: ScenarioResult[] = [];
  const formTypes = new Set(config.targetFormTypes);
  // 通常フォームはクラス単位の初回登録なので、意図しない重複回答を作らない。
  // 修正フォームも選ばれている場合だけ、指定件数まで修正回答を追加する。
  const effectiveSubmissionCount = formTypes.has('correction')
    ? config.submissionCount
    : Math.min(config.submissionCount, targetClasses.length);
  if (!Number.isInteger(config.errorSubmissionCount) || !Number.isInteger(config.warningSubmissionCount)
    || config.errorSubmissionCount < 0 || config.warningSubmissionCount < 0
    || config.errorSubmissionCount + config.warningSubmissionCount > effectiveSubmissionCount) {
    throw new Error('エラー数と警告数の合計は、実際に作成する疑似申請数以下の0以上の整数にしてください。');
  }
  for (let index = 0; index < effectiveSubmissionCount; index += 1) {
    const target = targetClasses[index % targetClasses.length]!;
    const grade = target.grade;
    const classNumber = target.classNumber;
    const classOccurrence = Math.floor(index / targetClasses.length);
    const formType: FormRegistryRow['formType'] = formTypes.size === 2
      ? classOccurrence === 0 ? 'normal' : 'correction'
      : formTypes.has('normal') ? 'normal' : 'correction';
    const correctionEventIds = applicableCorrectionEventIds(source, grade);
    const correctionEventId = formType === 'correction'
      ? correctionEventIds[classOccurrence % correctionEventIds.length]!
      : '';
    const isError = index < config.errorSubmissionCount;
    const warningIndex = index - config.errorSubmissionCount;
    const isWarning = warningIndex >= 0 && warningIndex < config.warningSubmissionCount;
    const receptionOpen = true;
    const mutate: AnswerMutator | undefined = isError
      ? (answers, keys): void => {
        const key = keys[0]!;
        if (configuredErrorCode(source, index) === ISSUE_CODES.STUDENT_ID_INVALID) {
          answers[key] = '9999';
          answers[key.replace(/_student_id$/, '_name')] = '存在しない架空生徒';
        } else {
          const otherClass = classNumber === 8 ? 7 : classNumber + 1;
          const other = studentAt(source.students, grade, otherClass, 1);
          answers[key] = other.studentId;
          answers[key.replace(/_student_id$/, '_name')] = other.name;
        }
      }
      : isWarning
        ? (answers, keys): void => {
          void keys;
          const otherClass = classNumber === 1 ? 2 : 1;
          const proxy = studentAt(source.students, grade, otherClass, 1);
          answers.submitter_student_id = proxy.studentId;
          answers.submitter_name_input = proxy.name;
          answers.is_proxy = '別のクラスを代理で入力';
        }
        : undefined;
    scenarios.push(makeScenario(
      source,
      `mock-response-${String(startSequence + index).padStart(6, '0')}`,
      formType,
      grade,
      classNumber,
      receptionOpen,
      mutate,
      correctionEventId,
      classOccurrence,
    ));
  }
  assertConfiguredScenariosMatchRequestedProblems(source, scenarios, config);
  return {
    submissions: scenarios.map((scenario) => scenario.submission),
    items: scenarios.flatMap((scenario) => scenario.items),
    rawResponses: scenarios.map((scenario) => scenario.rawResponse),
  };
}

function applicableCorrectionEventIds(source: MockFormSource, grade: number): string[] {
  const ids = [...new Set(studentIdMappings(source.correctionRegistry, 'correction').map((row) => row.eventId))]
    .filter((eventId) => {
      const event = source.events.find((candidate) => candidate.eventId === eventId);
      return Boolean(event && appliesToGrade(event, grade));
    });
  if (ids.length === 0) {
    throw new Error(`${grade}年に対応する修正フォームの競技がありません。フォームを作り直してください。`);
  }
  return ids;
}

function makeScenario(
  source: MockFormSource,
  responseId: string,
  formType: FormRegistryRow['formType'],
  grade: number,
  classNumber: number,
  receptionOpen: boolean,
  mutate?: AnswerMutator,
  correctionEventId = '',
  studentOffset = 0,
): ScenarioResult {
  const registry = formType === 'normal' ? source.normalRegistry : source.correctionRegistry;
  const formId = formType === 'normal' ? source.normalFormId : source.correctionFormId;
  const mappings = studentIdMappings(registry, formType).filter((mapping) => {
    const event = source.events.find((candidate) => candidate.eventId === mapping.eventId);
    return formType === 'correction'
      ? mapping.eventId === correctionEventId
      : Boolean(event && appliesToGrade(event, grade));
  });
  if (mappings.length === 0) throw new Error(`${grade}年用フォームに選手の入力欄がありません。競技設定を確認してください。`);
  const submitter = studentAt(source.students, grade, classNumber, 1);
  const classStudents = source.students.filter((student) => student.grade === grade && student.classNumber === classNumber);
  const registryKeys = new Set(registry.map((mapping) => mapping.fieldKey));
  const answers: Record<string, string> = {
    submitter_student_id: submitter.studentId,
    submitter_name_input: submitter.name,
    target_grade: `${grade}年`,
    target_class: formType === 'correction' ? `${grade}年${classNumber}組` : `${classNumber}組`,
    is_proxy: '自分のクラスを入力',
  };
  if (formType === 'correction') answers.correction_event_id = correctionEventId;
  const assignedStudents = assignStudentsWithoutRuleViolations(
    source, mappings, classStudents, studentOffset, grade, classNumber,
  );
  mappings.forEach((mapping, index) => {
    const student = assignedStudents[index];
    const stateKey = mapping.fieldKey.replace(/_student_id$/, '_state');
    if (student) {
      answers[mapping.fieldKey] = student.studentId;
      answers[mapping.fieldKey.replace(/_student_id$/, '_name')] = student.name;
      if (registryKeys.has(stateKey)) answers[stateKey] = '選手を登録する';
    } else {
      answers[mapping.fieldKey] = '';
      answers[mapping.fieldKey.replace(/_student_id$/, '_name')] = '';
      if (registryKeys.has(stateKey)) answers[stateKey] = '出場しない';
    }
  });
  const allStudentIdKeys = mappings.map((mapping) => mapping.fieldKey);
  const populatedStudentIdKeys = allStudentIdKeys.filter((key) => answers[key]);
  const studentIdKeys = populatedStudentIdKeys.length > 0 ? populatedStudentIdKeys : allStudentIdKeys;
  mutate?.(answers, studentIdKeys);
  const submittedAt = new Date(Date.UTC(source.year, 6, 1, 0, Number(responseId.slice(-2)) || 1)).toISOString();
  const converted = convertFormAnswer({
    formId, responseId, formType, submittedAt,
    respondentEmail: `mock-${grade}${classNumber}@example.invalid`, receptionOpen,
    answersByFieldKey: answers, registry, events: source.events,
  });
  return {
    ...converted,
    rawResponse: {
      formId, responseId, formType, submittedAt, answerJson: JSON.stringify(answers),
      processingStatus: 'PROCESSED', submissionId: converted.submission.submissionId,
      processedAt: submittedAt, errorCode: '',
    },
  };
}

interface MockDuplicateRule {
  ruleId: string;
  ruleName: string;
  limit: number;
  perEvent: boolean;
  applies: (mapping: FormRegistryRow) => boolean;
}

function assignStudentsWithoutRuleViolations(
  source: MockFormSource,
  mappings: FormRegistryRow[],
  classStudents: Student[],
  studentOffset: number,
  grade: number,
  classNumber: number,
): Array<Student | undefined> {
  const rules = mockDuplicateRules(source);
  assertMockRuleCapacity(source, rules, mappings, classStudents.length, grade, classNumber);
  const counts = new Map<string, number>();
  const totalByStudent = new Map<string, number>();
  const assignments = new Map<number, Student | undefined>();
  const orderedMappings = mappings.map((mapping, originalIndex) => ({
    mapping,
    originalIndex,
    applicableRules: rules.filter((rule) => rule.applies(mapping)),
  })).sort((left, right) =>
    Number(eventAllowsVacancy(source, left.mapping)) - Number(eventAllowsVacancy(source, right.mapping))
    || right.applicableRules.length - left.applicableRules.length
    || Math.min(...left.applicableRules.map((rule) => rule.limit), Number.MAX_SAFE_INTEGER)
      - Math.min(...right.applicableRules.map((rule) => rule.limit), Number.MAX_SAFE_INTEGER)
    || left.originalIndex - right.originalIndex);
  orderedMappings.forEach(({ mapping, originalIndex, applicableRules }, allocationIndex) => {
    const rotated = classStudents.map((student, index) => ({
      student,
      rotationRank: (index - studentOffset - allocationIndex - 1 + classStudents.length * 2)
        % classStudents.length,
    })).sort((left, right) =>
      (totalByStudent.get(left.student.studentId) ?? 0) - (totalByStudent.get(right.student.studentId) ?? 0)
      || left.rotationRank - right.rotationRank);
    const selected = rotated.find(({ student }) => applicableRules.every((rule) => {
      const scope = rule.perEvent ? mapping.eventId : '対象競技全体';
      return (counts.get(`${rule.ruleId}:${scope}:${student.studentId}`) ?? 0) < rule.limit;
    }))?.student;
    if (!selected) {
      if (eventAllowsVacancy(source, mapping)) {
        assignments.set(originalIndex, undefined);
        return;
      }
      const event = source.events.find((candidate) => candidate.eventId === mapping.eventId);
      throw new Error(
        `${grade}年${classNumber}組の「${event?.eventName ?? mapping.eventId}」へ、重複ルールを守って疑似選手を割り当てられません。ルール設定の上限・対象競技と、競技設定の必要人数を確認してください。疑似データは書き換えていません。`,
      );
    }
    applicableRules.forEach((rule) => {
      const scope = rule.perEvent ? mapping.eventId : '対象競技全体';
      const key = `${rule.ruleId}:${scope}:${selected.studentId}`;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    });
    totalByStudent.set(selected.studentId, (totalByStudent.get(selected.studentId) ?? 0) + 1);
    assignments.set(originalIndex, selected);
  });
  return mappings.map((_, index) => assignments.get(index));
}

function eventAllowsVacancy(source: MockFormSource, mapping: FormRegistryRow): boolean {
  return Boolean(source.events.find((event) => event.eventId === mapping.eventId)?.vacancyAllowed);
}

function assertMockRuleCapacity(
  source: MockFormSource,
  rules: MockDuplicateRule[],
  mappings: FormRegistryRow[],
  studentCount: number,
  grade: number,
  classNumber: number,
): void {
  for (const rule of rules) {
    const applicable = mappings.filter((mapping) => rule.applies(mapping));
    const groups = new Map<string, FormRegistryRow[]>();
    applicable.forEach((mapping) => {
      const scope = rule.perEvent ? mapping.eventId : '対象競技全体';
      const group = groups.get(scope) ?? [];
      group.push(mapping);
      groups.set(scope, group);
    });
    for (const [scope, group] of groups) {
      const capacity = studentCount * rule.limit;
      const requiredCount = group.filter((mapping) => !eventAllowsVacancy(source, mapping)).length;
      if (requiredCount <= capacity) continue;
      const event = sourceEventNameForCapacity(source, scope, group);
      throw new Error(
        `${grade}年${classNumber}組では「${rule.ruleName}」を満たせません。対象：${event}、欠員不可の登録枠${requiredCount}人分、生徒${studentCount}人、1人あたり上限${rule.limit}件のため、最大${capacity}人分です。${requiredCount - capacity}人分超えています。競技設定の必要人数またはルール設定の上限・対象競技を確認してください。疑似データは書き換えていません。`,
      );
    }
  }
}

function sourceEventNameForCapacity(
  source: MockFormSource,
  scope: string,
  mappings: FormRegistryRow[],
): string {
  if (scope === '対象競技全体') return 'ルールの対象競技全体';
  const eventId = mappings[0]?.eventId ?? scope;
  const event = source.events.find((candidate) => candidate.eventId === eventId);
  return event ? `${event.eventName}（${eventId}）` : `${eventId}（同一競技内）`;
}

function mockDuplicateRules(source: MockFormSource): MockDuplicateRule[] {
  const configured = source.rules?.filter((rule) => rule.enabled && rule.condition.includes('同一生徒'));
  if (!configured) return [{
    ruleId: 'DEFAULT_DUPLICATE', ruleName: '同一選手の重複', limit: 1, perEvent: false,
    applies: () => true,
  }];
  return configured.map((rule) => ({
    ruleId: rule.ruleId,
    ruleName: rule.ruleName || rule.ruleId,
    limit: Number.isFinite(rule.limit) && rule.limit >= 1 ? Math.trunc(rule.limit) : 1,
    perEvent: rule.condition.includes('重複') && !rule.condition.includes('登録数'),
    applies: (mapping: FormRegistryRow): boolean => {
      const event = source.events.find((candidate) => candidate.eventId === mapping.eventId);
      if (rule.target === '全競技') return true;
      if (rule.target === '指定競技') {
        return rule.targetEventIds.split(',').map((value) => value.trim()).includes(mapping.eventId);
      }
      if (rule.target === 'リレー') return Boolean(event?.eventName.includes('リレー'));
      return Boolean(event && !event.eventName.includes('リレー'));
    },
  }));
}

function studentIdMappings(
  registry: FormRegistryRow[],
  formType: FormRegistryRow['formType'],
): FormRegistryRow[] {
  const prefix = formType === 'correction' ? 'correction_' : '';
  const seen = new Set<string>();
  return registry
    .filter((mapping) => mapping.enabled && mapping.formType === formType && mapping.eventId)
    .filter((mapping) => mapping.fieldKey.startsWith(prefix) && mapping.fieldKey.endsWith('_student_id'))
    .sort((a, b) => a.displayOrder - b.displayOrder)
    .filter((mapping) => {
      if (seen.has(mapping.fieldKey)) return false;
      seen.add(mapping.fieldKey);
      return true;
    });
}

function studentAt(students: Student[], grade: number, classNumber: number, attendanceNumber: number): Student {
  const student = students.find((candidate) =>
    candidate.grade === grade && candidate.classNumber === classNumber && candidate.attendanceNumber === attendanceNumber,
  );
  if (!student) throw new Error(`${grade}年${classNumber}組${attendanceNumber}番の疑似生徒を作成できませんでした。`);
  return student;
}

function assertFormSource(source: MockFormSource): void {
  if (!source.normalFormId || !source.correctionFormId
    || source.normalRegistry.length === 0 || source.correctionRegistry.length === 0) {
    throw new Error('作成済みフォームが見つかりません。先に「フォーム下書きを作成」を実行してから、疑似データを作ってください。');
  }
}
