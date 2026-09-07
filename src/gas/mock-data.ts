import { convertFormAnswer } from '../core/form-response';
import {
  assignMockStudents,
  canLeaveVacant,
  findRuleViolationCandidates,
  type MockAssignmentInput,
  type MockSlot,
} from '../core/mock-assignment';
import { appliesToGrade, buildCorrectionSections, type CorrectionSection } from '../core/settings';
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
  /**
   * 疑似データは作ったうえで、担当者へ知らせること。
   * 満たせなかったルールと、意図的なエラー・警告をどう作ったかを入れる。
   */
  notices: string[];
}

/** 意図的に作る問題の指定。 */
interface ProblemIntent {
  kind: 'ERROR' | 'WARNING';
  /** 何件目か。ルールを順番に切り替えて、同じルールばかり壊さないようにする。 */
  sequence: number;
}

/** 枠（`競技ID:枠番号`）ごとの学籍番号。同じクラスの通常回答と修正回答をそろえるために使う。 */
type SlotAssignmentMap = Map<string, string>;

interface ScenarioResult {
  submission: Submission;
  items: SubmissionItem[];
  rawResponse: RawFormResponseRecord;
  /**
   * この回答で埋めた枠と学籍番号。意図的な問題を入れる前の内容。
   * 同じクラスの修正回答へそろえるために使うので、わざと入れた誤りは含めない。
   */
  slotAssignments: SlotAssignmentMap;
  /** 満たせなかったルールなど、そのまま担当者へ伝えること。 */
  notices: string[];
  /** 意図的な問題をどの方法で作ったか。空なら意図的な問題なし。 */
  problemLabel: string;
}

type AnswerMutator = (answers: Record<string, string>, studentIdKeys: string[]) => void;

/** 知らせる内容を並べる最大件数。これを超えた分は件数だけ知らせる。 */
const MAX_LISTED_MOCK_NOTICES = 20;
/** 意図的な問題を作るときに、実際に検査して確かめる差し替え案の数。 */
const VIOLATION_TRIAL_LIMIT = 6;

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
  const defaultCorrectionSection = applicableCorrectionSections(
    source,
    correctionEvent.targetGrade === '全学年' ? normalGrade : Number(correctionEvent.targetGrade[0]),
  ).find((section) => section.events.some((event) => event.eventId === correctionEventId));
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
      if (keys[1]) {
        const otherClass = studentAt(source.students, normalGrade, 4, 2);
        answers[keys[1]] = otherClass.studentId;
      }
    }),
    makeScenario(source, 'mock-response-04', 'correction', correctionGrade, 4, false, (answers, keys) => {
      const stateKey = keys[0]?.replace(/_student_id$/, '_state');
      if (stateKey && source.correctionRegistry.some((mapping) => mapping.fieldKey === stateKey)) {
        answers[stateKey] = '現在調整中';
      }
    }, defaultCorrectionSection),
    makeScenario(source, 'mock-response-05', 'normal', normalGrade, 1, true),
  ];

  return collectScenarios(scenarios, []);
}

function collectScenarios(scenarios: ScenarioResult[], extraNotices: string[]): MockSubmissions {
  const notices = [...scenarios.flatMap((scenario) => scenario.notices), ...extraNotices]
    .filter((notice, index, all) => all.indexOf(notice) === index);
  return {
    submissions: scenarios.map((scenario) => scenario.submission),
    items: scenarios.flatMap((scenario) => scenario.items),
    rawResponses: scenarios.map((scenario) => scenario.rawResponse),
    notices: notices.length > MAX_LISTED_MOCK_NOTICES
      ? [...notices.slice(0, MAX_LISTED_MOCK_NOTICES),
        `（ほか${notices.length - MAX_LISTED_MOCK_NOTICES}件あります。）`]
      : notices,
  };
}

/**
 * 作った疑似データが指定どおりかを確かめ、違っていたら知らせる文を返す。
 * ここでは止めない。指定どおりでなくても、疑似データは作って渡す。
 */
function reviewConfiguredScenarios(
  source: MockFormSource,
  scenarios: ScenarioResult[],
  config: MockDataGenerationConfig,
): string[] {
  const notices: string[] = [];
  scenarios.forEach((scenario, index) => {
    const validation = validateSubmission(scenario.submission, scenario.items, {
      students: source.students,
      sameClassInitialSubmissionCount: 1,
      ...(source.rules ? { rules: source.rules } : {}),
    });
    const intent = index < config.errorSubmissionCount
      ? 'ERROR'
      : index < config.errorSubmissionCount + config.warningSubmissionCount
        ? 'WARNING'
        : 'CLEAN';
    const target = `${scenario.submission.targetGrade}年${scenario.submission.targetClass}組`
      + `（疑似申請${index + 1}件目）`;
    if (intent === 'ERROR' && validation.errorCount === 0) {
      notices.push(`${target}：エラーを1件出すつもりでしたが、エラーになりませんでした。`);
      return;
    }
    if (intent === 'WARNING' && validation.warningCount === 0) {
      notices.push(`${target}：警告を1件出すつもりでしたが、警告になりませんでした。`);
      return;
    }
    if (intent === 'CLEAN') {
      validation.issues
        .filter((issue) => issue.severity === 'ERROR')
        .forEach((issue) => notices.push(describeUnexpectedIssue(target, issue)));
    }
    if (intent === 'WARNING' && validation.errorCount > 0) {
      validation.issues
        .filter((issue) => issue.severity === 'ERROR')
        .forEach((issue) => notices.push(
          `${target}：警告だけにするつもりでしたが、エラーも出ています。${describeUnexpectedIssue(target, issue)}`,
        ));
    }
  });
  return notices;
}

function describeUnexpectedIssue(target: string, issue: { locationText: string; displayTitle: string; currentValue: string; fixInstruction: string; issueCode: string }): string {
  return [
    `${target}`,
    `どこ：${issue.locationText}`,
    `内容：${issue.displayTitle}`,
    `いまの集計：${issue.currentValue}`,
    `直し方：${issue.fixInstruction}`,
    `検査コード：${issue.issueCode}`,
  ].join(' ／ ');
}

/** 意図的なエラーで使う、ルールに関係しない誤り。ルールを壊せないときの受け皿。 */
function fallbackErrorCode(sequence: number): string {
  return sequence % 2 === 0
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
  const assignmentsByClass = new Map<string, SlotAssignmentMap>();
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
    const correctionSections = applicableCorrectionSections(source, grade);
    const correctionSection = formType === 'correction'
      ? correctionSections[classOccurrence % correctionSections.length]
      : undefined;
    const classKey = `${grade}-${classNumber}`;
    const warningIndex = index - config.errorSubmissionCount;
    const problem: ProblemIntent | undefined = index < config.errorSubmissionCount
      ? { kind: 'ERROR', sequence: index }
      : warningIndex >= 0 && warningIndex < config.warningSubmissionCount
        ? { kind: 'WARNING', sequence: warningIndex }
        : undefined;
    const scenario = makeScenario(
      source,
      `mock-response-${String(startSequence + index).padStart(6, '0')}`,
      formType,
      grade,
      classNumber,
      true,
      undefined,
      correctionSection,
      classOccurrence,
      problem,
      // 同じクラスの通常回答があるなら、重なる枠は同じ選手にそろえる。
      // そろえないと「まだ登録していない登録申請と食い違っています」の警告が全件に付く。
      formType === 'correction' ? assignmentsByClass.get(classKey) : undefined,
    );
    if (formType === 'normal') assignmentsByClass.set(classKey, scenario.slotAssignments);
    scenarios.push(scenario);
  }
  const overlapNotice = formTypes.size === 2 && config.errorSubmissionCount + config.warningSubmissionCount > 0
    ? ['通常フォームと修正フォームの両方を選んだので、同じクラスに登録申請と修正申請が並びます。'
      + '意図的な問題を入れたクラスは内容が食い違うため、両方の申請へ「まだ登録していない同じクラスの申請と、同じ枠が重なっています」の警告が付きます。'
      + '申請を開くと「登録申請と修正申請の突き合わせ」が出るので、そのまま取り込みを試せます。']
    : [];
  return collectScenarios(scenarios, [
    ...summarizeProblemLabels(scenarios),
    ...overlapNotice,
    ...reviewConfiguredScenarios(source, scenarios, config),
  ]);
}

/** 意図的な問題をどのルールで作ったかを1行にまとめる。 */
function summarizeProblemLabels(scenarios: ScenarioResult[]): string[] {
  const counts = new Map<string, number>();
  scenarios
    .filter((scenario) => scenario.problemLabel)
    .forEach((scenario) => counts.set(scenario.problemLabel, (counts.get(scenario.problemLabel) ?? 0) + 1));
  if (counts.size === 0) return [];
  return ['意図的な問題の作り方：' + [...counts.entries()]
    .map(([label, count]) => `${label}（${count}件）`)
    .join('、')];
}

/**
 * 修正フォームは表示順100ごとのセクション単位で1ページなので、疑似回答もセクション単位で作る。
 * その学年に出せる競技が1つでも含まれるセクションだけを対象にする。
 */
function applicableCorrectionSections(source: MockFormSource, grade: number): CorrectionSection[] {
  const formEventIds = new Set(studentIdMappings(source.correctionRegistry, 'correction')
    .map((row) => row.eventId));
  const events = [...source.events]
    .filter((event) => formEventIds.has(event.eventId))
    .sort((left, right) => left.displayOrder - right.displayOrder);
  const sections = buildCorrectionSections(events)
    .filter((section) => section.events.some((event) => appliesToGrade(event, grade)));
  if (sections.length === 0) {
    throw new Error(`${grade}年に対応する修正フォームの競技がありません。フォームを作り直してください。`);
  }
  return sections;
}

function makeScenario(
  source: MockFormSource,
  responseId: string,
  formType: FormRegistryRow['formType'],
  grade: number,
  classNumber: number,
  receptionOpen: boolean,
  mutate?: AnswerMutator,
  correctionSection?: CorrectionSection,
  studentOffset = 0,
  problem?: ProblemIntent,
  reuse?: SlotAssignmentMap,
): ScenarioResult {
  const registry = formType === 'normal' ? source.normalRegistry : source.correctionRegistry;
  const formId = formType === 'normal' ? source.normalFormId : source.correctionFormId;
  // 修正フォームはセクション単位で1ページなので、そのセクションの全競技の枠を埋める。
  const sectionEventIds = new Set(correctionSection?.events.map((event) => event.eventId) ?? []);
  const mappings = studentIdMappings(registry, formType).filter((mapping) => {
    const event = source.events.find((candidate) => candidate.eventId === mapping.eventId);
    return formType === 'correction'
      ? sectionEventIds.has(mapping.eventId)
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
  if (formType === 'correction') answers.correction_event_id = correctionSection?.choice ?? '';

  const slots = mappings.map<MockSlot>((mapping) => {
    const event = source.events.find((candidate) => candidate.eventId === mapping.eventId);
    const stateKey = mapping.fieldKey.replace(/_student_id$/, '_state');
    return {
      eventId: mapping.eventId,
      eventName: event?.eventName ?? mapping.eventId,
      required: !registryKeys.has(stateKey),
      vacancyAllowed: Boolean(event?.vacancyAllowed),
    };
  });
  assertClassCanFillEvents(slots, classStudents.length, grade, classNumber);
  const assignmentInput: MockAssignmentInput = {
    slots,
    classStudents,
    students: source.students,
    rules: source.rules ?? [],
    grade,
    classNumber,
    studentOffset,
  };
  const slotKeys = mappings.map((mapping) => slotAssignmentKey(mapping));
  // 同じクラスの通常回答で全部の枠が決まっているなら、割り当てをやり直さない。
  // 疑似データ作成の時間はほとんどが割り当てなので、修正回答でここを飛ばせるかが所要時間を決める。
  const reusesEverySlot = Boolean(reuse)
    && slotKeys.every((key) => key !== '' && reuse!.has(key));
  const assignment = reusesEverySlot
    ? { studentIds: slotKeys.map((key) => reuse!.get(key)!), unsatisfiedRules: [] }
    : assignMockStudents(assignmentInput);
  const notices = assignment.unsatisfiedRules.map((rule) =>
    `${grade}年${classNumber}組：ルールを満たす割り当てが見つかりませんでした。${rule}`);
  // 同じクラスの通常回答で決まっている枠は、その選手をそのまま使う。空けた枠も空けたままにする。
  const studentIds = assignment.studentIds.map((studentId, index) => {
    const key = slotKeys[index] ?? '';
    return reuse?.has(key) === true ? reuse.get(key)! : studentId;
  });

  const applyStudentIds = (studentIds: readonly string[]): void => {
    mappings.forEach((mapping, index) => {
      const studentId = studentIds[index] ?? '';
      const stateKey = mapping.fieldKey.replace(/_student_id$/, '_state');
      answers[mapping.fieldKey] = studentId;
      if (registryKeys.has(stateKey)) {
        answers[stateKey] = studentId ? '選手を登録する' : '出場しない';
      }
    });
  };
  applyStudentIds(studentIds);

  const submittedAt = new Date(Date.UTC(source.year, 6, 1, 0, Number(responseId.slice(-2)) || 1)).toISOString();
  const convert = (): ReturnType<typeof convertFormAnswer> => convertFormAnswer({
    formId, responseId, formType, submittedAt,
    respondentEmail: `mock-${grade}${classNumber}@example.invalid`, receptionOpen,
    answersByFieldKey: answers, registry, events: source.events,
  });

  let problemLabel = '';
  if (problem) {
    problemLabel = applyIntentionalProblem({
      source, problem, assignmentInput, studentIds,
      mappings, answers, registryKeys, convert, grade, classNumber,
      applyStudentIds,
    });
  }

  const allStudentIdKeys = mappings.map((mapping) => mapping.fieldKey);
  const populatedStudentIdKeys = allStudentIdKeys.filter((key) => answers[key]);
  const studentIdKeys = populatedStudentIdKeys.length > 0 ? populatedStudentIdKeys : allStudentIdKeys;
  mutate?.(answers, studentIdKeys);

  const converted = convert();
  return {
    ...converted,
    rawResponse: {
      formId, responseId, formType, submittedAt, answerJson: JSON.stringify(answers),
      processingStatus: 'PROCESSED', submissionId: converted.submission.submissionId,
      processedAt: submittedAt, errorCode: '',
    },
    notices,
    problemLabel,
    // 空けた枠も`''`のまま残す。修正回答へ「ここは出場しない」までそろえるために使う。
    slotAssignments: new Map(slotKeys
      .map((key, index) => [key, studentIds[index] ?? ''] as const)
      .filter(([key]) => key !== '')),
  };
}

/** 通常フォームと修正フォームで同じ枠を指す鍵。項目名の`correction_`は無視する。 */
function slotAssignmentKey(mapping: FormRegistryRow): string {
  const slot = mapping.fieldKey.match(/_slot(\d+)_student_id$/)?.[1] ?? '';
  return slot === '' ? '' : `${mapping.eventId}:${slot}`;
}

interface IntentionalProblemContext {
  source: MockFormSource;
  problem: ProblemIntent;
  assignmentInput: MockAssignmentInput;
  studentIds: readonly string[];
  mappings: FormRegistryRow[];
  answers: Record<string, string>;
  registryKeys: Set<string>;
  convert: () => { submission: Submission; items: SubmissionItem[] };
  applyStudentIds: (studentIds: readonly string[]) => void;
  grade: number;
  classNumber: number;
}

/**
 * 指定した判定のルールを1つ壊して、意図的なエラー・警告を作る。
 * 実際に検査して、狙った重さ（エラーだけ／警告だけ）になった案だけを採用する。
 * どのルールも使えないときは、ルールに関係しない誤りで代用する。
 */
function applyIntentionalProblem(context: IntentionalProblemContext): string {
  const { problem, assignmentInput, studentIds, mappings, answers, registryKeys } = context;
  const judgment: RuleSetting['judgment'] = problem.kind === 'ERROR' ? 'エラー' : '警告';
  const candidates = findRuleViolationCandidates(
    assignmentInput, studentIds, judgment, problem.sequence, VIOLATION_TRIAL_LIMIT,
  );
  for (const candidate of candidates) {
    const mapping = mappings[candidate.slotIndex];
    if (!mapping) continue;
    const trial = [...studentIds];
    trial[candidate.slotIndex] = candidate.studentId;
    context.applyStudentIds(trial);
    if (matchesIntent(context, problem.kind)) {
      return `${candidate.ruleLabel} を破る（${candidate.eventName}）`;
    }
  }
  context.applyStudentIds(studentIds);

  if (problem.kind === 'WARNING') {
    const otherClass = context.classNumber === 1 ? 2 : 1;
    const proxy = studentAt(context.source.students, context.grade, otherClass, 1);
    answers.submitter_student_id = proxy.studentId;
    answers.submitter_name_input = proxy.name;
    answers.is_proxy = '別のクラスを代理で入力';
    return matchesIntent(context, 'WARNING')
      ? '判定=警告のルールを壊せないため、代理入力の警告で代用'
      : '警告を作れませんでした';
  }

  const filledIndex = studentIds.findIndex((studentId) => studentId !== '');
  const slotIndex = filledIndex >= 0 ? filledIndex : 0;
  const key = mappings[slotIndex]?.fieldKey;
  if (!key) return 'エラーを作れませんでした';
  const stateKey = key.replace(/_student_id$/, '_state');
  if (registryKeys.has(stateKey)) answers[stateKey] = '選手を登録する';
  if (fallbackErrorCode(problem.sequence) === ISSUE_CODES.STUDENT_ID_INVALID) {
    answers[key] = '9999';
    return matchesIntent(context, 'ERROR')
      ? '判定=エラーのルールを壊せないため、学籍番号の書式違反で代用'
      : 'エラーを作れませんでした';
  }
  const otherClass = context.classNumber === 8 ? 7 : context.classNumber + 1;
  answers[key] = studentAt(context.source.students, context.grade, otherClass, 1).studentId;
  return matchesIntent(context, 'ERROR')
    ? '判定=エラーのルールを壊せないため、別クラスの学籍番号で代用'
    : 'エラーを作れませんでした';
}

/** いま作った回答が、狙った重さの検査結果になるかを実際に検査して確かめる。 */
function matchesIntent(context: IntentionalProblemContext, kind: ProblemIntent['kind']): boolean {
  const converted = context.convert();
  const validation = validateSubmission(converted.submission, converted.items, {
    students: context.source.students,
    sameClassInitialSubmissionCount: 1,
    ...(context.source.rules ? { rules: context.source.rules } : {}),
  });
  return kind === 'ERROR'
    ? validation.errorCount >= 1
    : validation.warningCount >= 1 && validation.errorCount === 0;
}

/**
 * 同じ競技へ同じ生徒は登録できないので、空けられない枠がクラスの人数を超えていたら作れない。
 * これはルールの satisfiability ではなく物理的な不足なので、ここだけは止める。
 */
function assertClassCanFillEvents(
  slots: MockSlot[],
  studentCount: number,
  grade: number,
  classNumber: number,
): void {
  const requiredByEvent = new Map<string, { name: string; count: number }>();
  slots.filter((slot) => !canLeaveVacant(slot)).forEach((slot) => {
    const current = requiredByEvent.get(slot.eventId) ?? { name: slot.eventName, count: 0 };
    current.count += 1;
    requiredByEvent.set(slot.eventId, current);
  });
  for (const [eventId, event] of requiredByEvent) {
    if (event.count <= studentCount) continue;
    throw new Error(
      `${grade}年${classNumber}組の「${event.name}（${eventId}）」は、「出場しない」を選べない登録枠が${event.count}人分あるのに、クラスの生徒は${studentCount}人です。同じ競技へ同じ生徒は登録できないため、疑似データを作れません。競技設定の必要人数か欠員許可を確認してください。欠員許可を変えた場合は、フォーム下書きも作り直してください。疑似データは書き換えていません。`,
    );
  }
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
