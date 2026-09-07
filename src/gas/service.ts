import { generateMockStudents } from '../core/mockStudents';
import { buildRegistrationSnapshot } from '../core/roster';
import { buildParticipationWarnings } from '../core/participation';
import { clearApprovalCandidates, countReviewQueue } from '../core/dashboard';
import { toClientSafe } from '../core/client-transfer';
import { affectedSubmissionIds, duplicateCandidates } from '../core/duplicate-selection';
import {
  buildCorrectionOverlap,
  openCorrectionsFor,
  openInitialFor,
} from '../core/correction-comparison';
import { reviewSubmission } from '../core/submission-review';
import { isDevelopmentMockSubmissionId } from '../core/mock-data-lifecycle';
import {
  MOCK_ROSTER_SOURCE_LABELS,
  emptyRosterMessage,
  type MockRosterSource,
} from '../core/mock-roster-source';
import { getSystemMode, isPracticeWorkbook } from './mode-probe';
import { generateMockSubmissions } from './mock-data';
import { initializeSettings } from './settings-service';
import { readEventSettings, readFormDesign, readFormRegistry, readRuleSettings } from './settings-repository';
import { normalizeStudentId } from '../core/normalization';
import { ISSUE_CODES, validateSubmission } from '../core/validation';
import {
  assertActionAllowed,
  nextStatusForAction,
  type SubmissionAction
} from '../core/workflow';
import type {
  CorrectionOverlap,
  DashboardFilter,
  GlobalWarning,
  Registration,
  Submission,
  SubmissionDetail,
  SubmissionItem,
  SubmissionStatus,
  SubmissionSummary,
  Student,
  ValidationContext,
  ValidationResult
} from '../shared/types';
import { ITEM_HEADERS, SCRIPT_PROPERTIES, SHEETS, SUBMISSION_HEADERS } from '../shared/constants';
import { assertAuthorized, assertDevelopmentMode } from './auth-service';
import {
  appendApproval,
  appendChangeHistory,
  deleteDevelopmentMockRows,
  deleteDevelopmentMockSubmissionRows,
  ensureApplicationSheets,
  ensureMockDataSettings,
  findSubmission,
  findRawFormResponseBySubmissionId,
  findItem,
  assertMockRosterSourceConsistent,
  readMockRosterSourceSetting,
  writeMockRosterSourceStamp,
  readIssues,
  readApprovalHistory,
  readItems,
  readMockDataSettings,
  readMockStudents,
  readProductionStudents,
  nextDevelopmentMockResponseSequence,
  readRawFormResponses,
  readRegistrations,
  readStudents,
  readSubmissions,
  removeFailedApprovalRow,
  removeFailedChangeHistoryRow,
  resetApprovalHistory,
  replaceIssues,
  replaceIssuesForSubmissions,
  replaceItems,
  replaceRegistrations,
  replaceRawFormResponses,
  replaceStudents,
  replaceSubmissions,
  requireSheet,
  updateItemInput,
  updateValidatedItems,
  updateSubmission
} from './repository';

export type { SubmissionAction } from '../core/workflow';

/**
 * 画面が「この操作を出すか・押せるか」を決めるための情報。
 * 重い判定はここへ入れない。`buildDashboardData`は再検査のたびに通る道なので、
 * 追加の読み取りが要らないものと、シート1〜2枚で済むものだけにする。
 */
export interface DashboardEnvironment {
  mode: 'DEVELOPMENT' | 'PRODUCTION';
  practiceWorkbook: boolean;
  mockSubmissionsExist: boolean;
  rosterSourceLabel: string;
}

export interface DashboardData {
  warning: number;
  error: number;
  clear: number;
  hold: number;
  pending: number;
  rejected: number;
  approved: number;
  rosterRebuildRequired: boolean;
  rosterRebuildMessage: string;
  submissions: SubmissionSummary[];
  globalWarnings: GlobalWarning[];
  environment: DashboardEnvironment;
  /**
   * 疑似データを作った直後だけ入る、担当者への連絡事項。
   * 満たせなかったルールと、意図的なエラー・警告をどう作ったかを入れる。
   */
  mockGenerationNotices?: string[];
}

export interface ActionResult {
  submissionId: string;
  status: SubmissionStatus;
  message: string;
}

export interface OpenIssueLocationResult {
  sheetName: string;
  rangeA1: string;
}

export interface EditItemResult {
  submissionId: string;
  submissionItemId: string;
  message: string;
}

export interface DuplicateSelectionResult {
  selectedSubmissionId: string;
  rejectedCount: number;
  message: string;
}

export interface BulkApprovalResult {
  approvedCount: number;
  skippedCount: number;
  message: string;
}

export interface CorrectionImportResult {
  targetSubmissionId: string;
  importedCount: number;
  /** 取り込みきったので修正申請を閉じたか。 */
  closedCorrection: boolean;
  message: string;
}

export interface AdditionalMockCorrectionResult {
  addedCount: number;
  pendingCount: number;
  message: string;
}

const REVIEWABLE: SubmissionStatus[] = ['PENDING_APPROVAL', 'NEEDS_CORRECTION', 'ON_HOLD'];
const TERMINAL: SubmissionStatus[] = ['APPROVED', 'APPLIED', 'REJECTED', 'CORRECTION_REQUESTED'];
const DASHBOARD_BUTTON_IMAGE_TITLE = '選手登録管理:件数ボタン';
const DASHBOARD_COLORS = {
  warning: '#9a5a00',
  error: '#b4232c',
  clear: '#2f6b56',
  hold: '#52645b',
  rejected: '#6b4f4f',
  approved: '#315b7d',
  buttonText: '#ffffff'
} as const;
const TRANSPARENT_PIXEL_PNG =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNgYAAAAAMAASsJTYQAAAAASUVORK5CYII=';

/**
 * 疑似申請に使う名簿を決め、その名簿の生徒を返す。
 * 空のときは、どちらの名簿が空なのかが分かる文言で止める。
 */
function resolveMockRoster(): { source: MockRosterSource; students: Student[] } {
  const source = readMockRosterSourceSetting();
  const students = source === 'PRODUCTION_STUDENTS' ? readProductionStudents() : readMockStudents();
  if (students.length === 0) throw new Error(emptyRosterMessage(source));
  return { source, students };
}

export function initializeDevelopmentWorkbookData(): DashboardData {
  // 申請・項目・回答原本を丸ごと作り直すので、取込トリガーと同時に動かさない。
  const lock = LockService.getDocumentLock();
  if (!lock.tryLock(30_000)) throw new Error('ほかの担当者が処理中です。少し待ってから、もう一度実行してください。');
  try {
    return createDevelopmentWorkbookData();
  } finally {
    lock.releaseLock();
  }
}

function createDevelopmentWorkbookData(): DashboardData {
  assertAuthorized();
  assertDevelopmentMode();
  ensureApplicationSheets();
  initializeSettings();
  const source = readMockRosterSourceSetting();
  // 生徒マスターを選んだときは疑似生徒マスターを一切作らない（実在名簿だけで試す）。
  const students = source === 'PRODUCTION_STUDENTS' ? readProductionStudents() : generateMockStudents();
  if (students.length === 0) throw new Error(emptyRosterMessage(source));
  const mockConfig = readMockDataSettings(students);
  const design = readFormDesign();
  const generated = generateMockSubmissions({
    year: design.year,
    normalFormId: design.normalFormId,
    correctionFormId: design.correctionFormId,
    normalRegistry: readFormRegistry(design.normalFormId),
    correctionRegistry: readFormRegistry(design.correctionFormId),
    events: readEventSettings().filter((event) => event.enabled && event.year === design.year),
    rules: readRuleSettings().filter((rule) => rule.enabled),
    students,
  }, mockConfig);
  if (!Array.isArray(generated.submissions) || !Array.isArray(generated.items)
    || !Array.isArray(generated.rawResponses)) {
    throw new Error('疑似申請データを作成できませんでした。開発用データの設定を確認してください。');
  }
  if (source === 'MOCK_STUDENTS') replaceStudents(students);
  writeMockRosterSourceStamp(source);
  replaceSubmissions(generated.submissions);
  replaceItems(generated.items);
  replaceRawFormResponses(generated.rawResponses);
  replaceIssues([]);
  resetApprovalHistory();
  const result = revalidateAllSubmissionsWithinLock();
  writeDashboard(result);
  return generated.notices.length > 0 ? { ...result, mockGenerationNotices: generated.notices } : result;
}

export function prepareMockDataSettings(): ReturnType<typeof readMockDataSettings> {
  assertAuthorized();
  assertDevelopmentMode();
  ensureApplicationSheets();
  // 名簿行そのものを読むので、`ensureMockDataSettings`より前に選択を確かめる。
  const source = readMockRosterSourceSetting();
  const students = source === 'PRODUCTION_STUDENTS' ? readProductionStudents() : generateMockStudents();
  if (students.length === 0) throw new Error(emptyRosterMessage(source));
  ensureMockDataSettings(students);
  return readMockDataSettings(students);
}

export function addDevelopmentMockCorrectionSubmissions(count: number): AdditionalMockCorrectionResult {
  assertDevelopmentMode();
  if (!Number.isInteger(count) || count < 1 || count > 100) {
    throw new Error('追加する件数は1件から100件までの整数で入力してください。');
  }
  const lock = LockService.getDocumentLock();
  if (!lock.tryLock(30_000)) throw new Error('ほかの担当者が処理中です。少し待ってから、もう一度実行してください。');
  let beforeSubmissions: Submission[] = [];
  let beforeItems: SubmissionItem[] = [];
  let beforeRawResponses: ReturnType<typeof readRawFormResponses> = [];
  let snapshotsReady = false;
  try {
    assertAuthorized();
    ensureApplicationSheets();
    beforeSubmissions = readSubmissions();
    beforeItems = readItems();
    beforeRawResponses = readRawFormResponses();
    snapshotsReady = true;
    if (!beforeSubmissions.some((submission) => isDevelopmentMockSubmissionId(submission.submissionId))) {
      throw new Error('追加先となる疑似申請がありません。先に「開発用の疑似データを作る」を実行してください。');
    }
    assertMockRosterSourceConsistent(beforeSubmissions);
    const { students } = resolveMockRoster();
    const settings = readMockDataSettings(students);
    const design = readFormDesign();
    const generated = generateMockSubmissions({
      year: design.year,
      normalFormId: design.normalFormId,
      correctionFormId: design.correctionFormId,
      normalRegistry: readFormRegistry(design.normalFormId),
      correctionRegistry: readFormRegistry(design.correctionFormId),
      events: readEventSettings().filter((event) => event.enabled && event.year === design.year),
      rules: readRuleSettings().filter((rule) => rule.enabled),
      students,
    }, {
      submissionCount: count,
      targetGrades: settings.targetGrades,
      targetClasses: settings.targetClasses,
      targetFormTypes: ['correction'],
      errorSubmissionCount: 0,
      warningSubmissionCount: 0,
    }, nextDevelopmentMockResponseSequence());
    replaceSubmissions([...beforeSubmissions, ...generated.submissions]);
    replaceItems([...beforeItems, ...generated.items]);
    replaceRawFormResponses([...beforeRawResponses, ...generated.rawResponses]);
    const dashboard = revalidateAllSubmissionsWithinLock();
    return {
      addedCount: generated.submissions.length,
      pendingCount: dashboard.pending,
      message: `既存データを残したまま、疑似の修正申請を${generated.submissions.length}件追加しました。`
        + (generated.notices.length > 0 ? `\n\n${generated.notices.join('\n')}` : ''),
    };
  } catch (error) {
    if (snapshotsReady) {
      replaceSubmissions(beforeSubmissions);
      replaceItems(beforeItems);
      replaceRawFormResponses(beforeRawResponses);
    }
    throw error;
  } finally {
    lock.releaseLock();
  }
}

export function deleteDevelopmentWorkbookData(): DashboardData {
  const lock = LockService.getDocumentLock();
  if (!lock.tryLock(30_000)) throw new Error('ほかの担当者が処理中です。少し待ってから、もう一度実行してください。');
  try {
    assertAuthorized();
    assertDevelopmentMode();
    ensureApplicationSheets();
    deleteDevelopmentMockRows();
    const result = buildDashboardData(readSubmissions(), 'ALL');
    writeDashboard(result);
    return result;
  } finally {
    lock.releaseLock();
  }
}

export function prepareRealFormTestData(): DashboardData {
  const lock = LockService.getDocumentLock();
  if (!lock.tryLock(30_000)) throw new Error('ほかの担当者が処理中です。少し待ってから、もう一度実行してください。');
  try {
    assertAuthorized();
    assertDevelopmentMode();
    ensureApplicationSheets();
    deleteDevelopmentMockSubmissionRows();
    const result = buildDashboardData(readSubmissions(), 'ALL');
    writeDashboard(result);
    return result;
  } finally {
    lock.releaseLock();
  }
}

/**
 * すべての申請を検査し直す。`申請項目`・`検査結果`・`承認待ち`の3シートを丸ごと
 * 書き換えるため、必ずドキュメントロックを持っている間だけ呼ぶ。
 * ロックの外で呼ぶと、読み込みから書き戻しまでの間に届いたフォーム回答を
 * 古い内容で上書きし、`フォーム回答原本`が取込済みのまま申請だけが消える。
 * ロックを持っていない呼び出し側は`revalidateAllSubmissions()`を使う。
 */
export function revalidateAllSubmissionsWithinLock(): DashboardData {
  assertAuthorized();
  const submissions = readSubmissions();
  assertMockRosterSourceConsistent(submissions);
  const students = readStudents();
  const allItems = readItems();
  const rules = readRuleSettings();
  const normalizedItems: SubmissionItem[] = [];
  const issues = [] as ReturnType<typeof readIssues>;
  const checkedSubmissions = submissions.map((submission) => {
    const items = allItems.filter((item) => item.submissionId === submission.submissionId);
    const sameClassInitialSubmissionCount = duplicateCandidates(submissions, submission).length;
    const overlappingSubmission = overlapContextFor(submission, submissions, allItems);
    const validation = validateSubmission(submission, items, {
      students,
      sameClassInitialSubmissionCount,
      rules,
      ...(overlappingSubmission ? { overlappingSubmission } : {}),
    });
    normalizedItems.push(...validation.normalizedItems);
    issues.push(...validation.issues);
    return withValidation(submission, validation);
  });
  replaceItems(normalizedItems);
  replaceIssues(issues);
  replaceSubmissions(checkedSubmissions);
  const data = buildDashboardData(checkedSubmissions, 'ALL');
  writeDashboard(data);
  return data;
}

/** メニューなど、ロックを持たない場所からの全再検査。取込との衝突を待って防ぐ。 */
export function revalidateAllSubmissions(): DashboardData {
  const lock = LockService.getDocumentLock();
  if (!lock.tryLock(30_000)) throw new Error('ほかの担当者が処理中です。少し待ってから、もう一度実行してください。');
  try {
    return revalidateAllSubmissionsWithinLock();
  } finally {
    lock.releaseLock();
  }
}

/**
 * Revalidates only the requested submissions and the initial submissions in the
 * same classes whose duplicate-answer warning can change as a consequence.
 *
 * 対象行だけを書き換えるが、読み込みから書き戻しまでの間に届いた回答とは競合する。
 * 呼び出し側がドキュメントロックを持っている間だけ呼ぶこと。
 */
export function revalidateAffectedSubmissions(submissionIds: string[]): DashboardData {
  assertAuthorized();
  const submissions = readSubmissions();
  assertMockRosterSourceConsistent(submissions);
  const requested = new Set(affectedSubmissionIds(submissions, submissionIds));

  if (requested.size === 0) {
    const data = buildDashboardData(submissions, 'ALL');
    writeDashboard(data);
    return data;
  }

  const students = readStudents();
  const allItems = readItems();
  const rules = readRuleSettings();
  const updatedById = new Map<string, Submission>();
  const normalizedItems: SubmissionItem[] = [];
  const issues: ReturnType<typeof readIssues> = [];
  submissions.filter((submission) => requested.has(submission.submissionId))
    .forEach((submission) => {
      const validation = validateSubmission(
        submission,
        allItems.filter((item) => item.submissionId === submission.submissionId),
        {
          students,
          sameClassInitialSubmissionCount: duplicateCandidates(submissions, submission).length,
          rules,
          ...overlapContextArgument(overlapContextFor(submission, submissions, allItems)),
        },
      );
      normalizedItems.push(...validation.normalizedItems);
      issues.push(...validation.issues);
      updatedById.set(submission.submissionId, withValidation(submission, validation));
    });

  updateValidatedItems(normalizedItems);
  replaceIssuesForSubmissions([...requested], issues);
  updatedById.forEach((submission) => updateSubmission(submission));
  const updatedSubmissions = submissions.map((submission) =>
    updatedById.get(submission.submissionId) ?? submission);
  const data = buildDashboardData(updatedSubmissions, 'ALL');
  writeDashboard(data);
  return data;
}

function withValidation(submission: Submission, result: ValidationResult): Submission {
  if (TERMINAL.includes(submission.status) || submission.status === 'ON_HOLD') {
    return { ...submission, warningCount: result.warningCount, errorCount: result.errorCount };
  }
  return {
    ...submission,
    warningCount: result.warningCount,
    errorCount: result.errorCount,
    status: result.nextStatus
  };
}

export function getDashboardData(filter: DashboardFilter = 'ALL'): DashboardData {
  assertAuthorized();
  return buildDashboardData(readSubmissions(), filter);
}

export function listPendingSubmissions(filter: DashboardFilter = 'ALL'): SubmissionSummary[] {
  return getDashboardData(filter).submissions;
}

function buildDashboardData(submissions: Submission[], filter: DashboardFilter): DashboardData {
  const reviewable = submissions.filter((submission) => REVIEWABLE.includes(submission.status));
  const counts = countReviewQueue(submissions);
  const filterSource = filter === 'REJECTED'
    ? submissions.filter((submission) => submission.status === 'REJECTED')
    : filter === 'APPROVED'
      ? submissions.filter((submission) =>
        submission.status === 'APPROVED' || submission.status === 'APPLIED')
      : reviewable;
  const filtered = filterSource.filter((submission) => matchesFilter(submission, filter));
  const globalWarnings = participationWarnings();
  const rosterRebuildMessage = PropertiesService.getDocumentProperties()
    .getProperty(SCRIPT_PROPERTIES.rosterRebuildRequired) ?? '';
  const mode = getSystemMode();
  return {
    ...counts,
    warning: counts.warning + globalWarnings.length,
    submissions: filtered.map(toSummary).sort((a, b) => b.submittedAt.localeCompare(a.submittedAt)),
    globalWarnings: filter === 'ALL' || filter === 'WARNING' ? globalWarnings : [],
    rosterRebuildRequired: rosterRebuildMessage !== '',
    rosterRebuildMessage,
    environment: {
      mode,
      practiceWorkbook: isPracticeWorkbook(),
      // 引数の配列から数えるので、追加の読み取りは発生しない。
      mockSubmissionsExist: submissions.some((submission) =>
        isDevelopmentMockSubmissionId(submission.submissionId)),
      rosterSourceLabel: mode === 'PRODUCTION'
        ? MOCK_ROSTER_SOURCE_LABELS.PRODUCTION_STUDENTS
        : MOCK_ROSTER_SOURCE_LABELS[readMockRosterSourceSetting()],
    },
  };
}

function participationWarnings(): GlobalWarning[] {
  const students = readStudents();
  if (students.length === 0) return [];
  const registrations = readRegistrations();
  const submissions = readSubmissions();
  const developmentMode = submissions.some((submission) =>
    isDevelopmentMockSubmissionId(submission.submissionId));
  const eligibleSubmissionIds = new Set(submissions
    .filter((submission) => submission.status !== 'REJECTED' && submission.status !== 'CORRECTION_REQUESTED')
    .map((submission) => submission.submissionId));
  const registeredStudentIds = registrations.length > 0 && !developmentMode
    ? registrations.map((registration) => registration.studentId)
    : readItems()
      .filter((item) => eligibleSubmissionIds.has(item.submissionId) && item.registrationState === 'REGISTER')
      .map((item) => item.normalizedStudentId || item.studentIdInput);
  return buildParticipationWarnings(students, registeredStudentIds);
}

function matchesFilter(submission: Submission, filter: DashboardFilter): boolean {
  if (filter === 'WARNING') return submission.status !== 'ON_HOLD' && submission.warningCount > 0;
  if (filter === 'ERROR') return submission.status !== 'ON_HOLD' && submission.errorCount > 0;
  if (filter === 'CLEAR') return submission.warningCount === 0 && submission.errorCount === 0 && submission.status !== 'ON_HOLD';
  if (filter === 'HOLD') return submission.status === 'ON_HOLD';
  if (filter === 'REJECTED') return submission.status === 'REJECTED';
  if (filter === 'APPROVED') return submission.status === 'APPROVED' || submission.status === 'APPLIED';
  return true;
}

const toSummary = (submission: Submission): SubmissionSummary => ({
  submissionId: submission.submissionId,
  submissionType: submission.submissionType,
  submittedAt: submission.submittedAt,
  targetGrade: submission.targetGrade,
  targetClass: submission.targetClass,
  status: submission.status,
  warningCount: submission.warningCount,
  errorCount: submission.errorCount
});

export function getSubmissionDetail(submissionId: string): SubmissionDetail {
  assertAuthorized();
  const submission = findSubmission(submissionId);
  if (!submission) throw new Error('指定された申請が見つかりません。一覧を開き直してください。');
  const rawResponse = findRawFormResponseBySubmissionId(submissionId);
  let responseNote = '';
  if (rawResponse?.answerJson) {
    try {
      const answers = JSON.parse(rawResponse.answerJson) as Record<string, unknown>;
      responseNote = String(answers.correction_reason ?? '');
    } catch {
      responseNote = '';
    }
  }
  const allItems = readItems();
  // フォームは学籍番号だけを受け取るので、確認画面へは名簿から引いた氏名と性別を添える。
  // 性別は男女別ルールの判定根拠になるため、名簿に無い学籍番号は論理式の`UNKNOWN`と
  // 同じ扱いで`U`を返す。
  const students = readStudents();
  const studentById = new Map(students.map((student) => [student.studentId, student]));
  const withMasterName = (item: SubmissionItem): SubmissionItem => {
    const student = studentById.get(normalizeStudentId(item.studentIdInput));
    return { ...item, masterName: student?.name ?? '', masterGender: student?.gender ?? 'U' };
  };
  const detailItems = allItems.filter((item) => item.submissionId === submissionId)
    .map(withMasterName);
  const allIssues = readIssues();
  const detailIssues = allIssues.filter((issue) => issue.submissionId === submissionId);
  const allSubmissions = readSubmissions();
  return toClientSafe({
    submission,
    items: detailItems,
    issues: detailIssues,
    approvalHistory: readApprovalHistory(submissionId).map((record) => ({
      action: record.action, actorEmail: record.actorEmail, reason: record.reason, actedAt: record.actedAt,
    })),
    responseNote,
    duplicateCandidates: duplicateCandidates(allSubmissions, submission).map((candidate) => ({
      submission: candidate,
      items: allItems.filter((item) => item.submissionId === candidate.submissionId).map(withMasterName),
    })),
    review: reviewSubmission(detailItems, detailIssues),
    ...correctionOverlapArgument({
      submission, allItems, allIssues, allSubmissions, students, withMasterName,
    }),
  });
}

interface DetailOverlapInput {
  submission: Submission;
  allItems: SubmissionItem[];
  allIssues: ReturnType<typeof readIssues>;
  allSubmissions: Submission[];
  students: Student[];
  withMasterName: (item: SubmissionItem) => SubmissionItem;
}

/**
 * 突き合わせ表を作る。修正申請からは「まだ登録していない登録申請」または「登録済みの内容」と、
 * 登録申請からは「あとから届いた修正申請」と比べる。無ければ項目自体を付けない。
 */
function correctionOverlapArgument(
  input: DetailOverlapInput,
): { correctionOverlap: CorrectionOverlap } | Record<string, never> {
  const overlap = buildDetailCorrectionOverlap(input);
  return overlap ? { correctionOverlap: overlap } : {};
}

function buildDetailCorrectionOverlap(input: DetailOverlapInput): CorrectionOverlap | undefined {
  const { submission, allItems, allIssues, students, withMasterName } = input;
  const submissions = input.allSubmissions;
  const itemsOf = (id: string): SubmissionItem[] =>
    allItems.filter((item) => item.submissionId === id).map(withMasterName);
  const issuesOf = (id: string): ReturnType<typeof readIssues> =>
    allIssues.filter((issue) => issue.submissionId === id);
  const staleMessage = PropertiesService.getDocumentProperties()
    .getProperty(SCRIPT_PROPERTIES.rosterRebuildRequired) ?? '';

  const pairs: Array<{ correction: Submission; base?: Submission }> =
    submission.submissionType === 'CORRECTION'
      ? [{ correction: submission, ...withBase(openInitialFor(submissions, submission)) }]
      : openCorrectionsFor(submissions, submission)
        .map((correction) => ({ correction, base: submission }));

  // 登録データは、登録済みのクラスと突き合わせるときだけ読む。
  let registrations: Registration[] | undefined;
  for (const pair of pairs) {
    if (!pair.base && !registrations) registrations = readRegistrations();
    const overlap = buildCorrectionOverlap({
      correction: pair.correction,
      correctionItems: itemsOf(pair.correction.submissionId),
      ...(pair.base
        ? {
          base: {
            submission: pair.base,
            items: itemsOf(pair.base.submissionId),
            issues: issuesOf(pair.base.submissionId),
          },
        }
        : {}),
      registrations: registrations ?? [],
      students,
      registrationStaleMessage: staleMessage,
    });
    if (overlap) return overlap;
  }
  return undefined;
}

function withBase(base: Submission | undefined): { base?: Submission } {
  return base ? { base } : {};
}

/**
 * 修正申請の枠を、まだ登録されていない登録申請へ取り込む。
 * 取り込む枠は担当者が選ぶ。取り込まなかった枠は登録申請の内容のまま残る。
 * 食い違いがすべて無くなったら、その修正申請は取り込み済みとして閉じる。
 */
export function importCorrectionSlots(
  correctionSubmissionId: string,
  targetSubmissionId: string,
  correctionItemIds: string[],
  reason: string,
): CorrectionImportResult {
  const lock = LockService.getDocumentLock();
  if (!lock.tryLock(15_000)) {
    throw new Error('ほかの担当者が処理中です。少し待ってから、もう一度操作してください。');
  }
  const restoreItems: SubmissionItem[] = [];
  const historyRows: number[] = [];
  let closedCorrection = false;
  let correctionBefore: Submission | undefined;
  let importedCount = 0;
  let keptCount = 0;
  try {
    const actorEmail = assertAuthorized();
    if (reason.trim() === '') {
      throw new Error('取り込む理由を入力してください。どの申請の内容を採用したか後から確認できるようにします。');
    }
    const correction = findSubmission(correctionSubmissionId);
    const target = findSubmission(targetSubmissionId);
    if (!correction || !target) throw new Error('取り込む申請が見つかりません。一覧を開き直してください。');
    if (correction.submissionType !== 'CORRECTION' || target.submissionType !== 'INITIAL') {
      throw new Error('取り込みは、修正申請から登録申請へだけ行えます。');
    }
    if (correction.targetGrade !== target.targetGrade || correction.targetClass !== target.targetClass) {
      throw new Error('学年・クラスが違う申請どうしは取り込めません。');
    }
    if (!REVIEWABLE.includes(correction.status) || !REVIEWABLE.includes(target.status)) {
      throw new Error('どちらかの申請が確認できる状態ではありません。一覧を開き直してください。');
    }
    assertMockRosterSourceConsistent([correction, target]);
    const selected = new Set(correctionItemIds.filter(Boolean));
    if (selected.size === 0) throw new Error('取り込む枠を1つ以上選んでください。');

    const allItems = readItems();
    const itemsOf = (id: string): SubmissionItem[] =>
      allItems.filter((item) => item.submissionId === id);
    const overlap = buildCorrectionOverlap({
      correction,
      correctionItems: itemsOf(correctionSubmissionId),
      base: {
        submission: target,
        items: itemsOf(targetSubmissionId),
        issues: readIssues().filter((issue) => issue.submissionId === targetSubmissionId),
      },
      registrations: [],
      students: readStudents(),
    });
    if (!overlap) throw new Error('突き合わせできる枠がありません。申請を再検査してください。');
    const targets = overlap.rows.filter((row) =>
      selected.has(row.correctionItemId) && row.baseItemId !== '' && row.changed);
    if (targets.length === 0) {
      throw new Error('選んだ枠は登録申請と同じ内容です。取り込む必要はありません。');
    }

    const historyNameById = new Map(readStudents().map((student) => [student.studentId, student.name]));
    for (const row of targets) {
      const before = findItem(row.baseItemId);
      if (!before) throw new Error('取り込み先の選手枠が見つかりません。詳細を開き直してください。');
      restoreItems.push(before);
      const after = updateItemInput(row.baseItemId, row.correctionStudentId, row.correctionState);
      historyRows.push(appendChangeHistory({
        changeId: Utilities.getUuid(),
        submissionId: targetSubmissionId,
        submissionItemId: row.baseItemId,
        beforeStudentId: before.studentIdInput,
        afterStudentId: after.studentIdInput,
        beforeStudentName: historyNameById.get(normalizeStudentId(before.studentIdInput)) ?? before.studentNameInput,
        afterStudentName: historyNameById.get(normalizeStudentId(after.studentIdInput)) ?? after.studentNameInput,
        beforeRegistrationState: before.registrationState,
        afterRegistrationState: after.registrationState,
        reason: `修正申請${correctionSubmissionId}から取り込み：${reason.trim()}`,
        actorEmail,
        changedAt: new Date().toISOString(),
      }));
      importedCount += 1;
    }

    // 取り込みが終わったら、この修正申請は必ず閉じる。
    // 開いたまま残すと、登録申請を承認したあとにこの修正申請だけを承認できてしまい、
    // 「登録申請のまま残す」と決めた枠が競技ごと上書きされる。もう一度使うときは却下済みから戻す。
    const remaining = buildCorrectionOverlap({
      correction,
      correctionItems: itemsOf(correctionSubmissionId),
      base: { submission: target, items: readItems().filter((item) => item.submissionId === targetSubmissionId), issues: [] },
      registrations: [],
      students: [],
    });
    keptCount = remaining?.changedCount ?? 0;
    correctionBefore = correction;
    updateSubmission({ ...correction, status: 'REJECTED' });
    appendApproval({
      approvalId: Utilities.getUuid(), submissionId: correctionSubmissionId,
      action: '登録申請へ取り込み済み', actorEmail,
      reason: `内容を登録申請${targetSubmissionId}へ取り込みました。取り込んだ枠${importedCount}件／登録申請のまま残した枠${keptCount}件。${reason.trim()}`,
      actedAt: new Date().toISOString(),
    });
    closedCorrection = true;
  } catch (error) {
    restoreItems.reverse().forEach((item) => {
      try { updateItemInput(item.submissionItemId, item.studentIdInput, item.registrationState); }
      catch { /* 元のエラーを優先する。 */ }
    });
    historyRows.reverse().forEach((row) => {
      try { removeFailedChangeHistoryRow(row); } catch { /* 元のエラーを優先する。 */ }
    });
    if (correctionBefore) {
      try { updateSubmission(correctionBefore); } catch { /* 元のエラーを優先する。 */ }
    }
    throw error;
  } finally {
    lock.releaseLock();
  }
  revalidateAffectedSubmissions([targetSubmissionId, correctionSubmissionId]);
  return {
    targetSubmissionId,
    importedCount,
    closedCorrection,
    message: `${importedCount}枠を登録申請へ取り込みました。`
      + (keptCount > 0 ? `残り${keptCount}枠は登録申請の内容のままです。` : '')
      + 'この修正申請は取り込み済みとして閉じました。もう一度使う場合は、却下済みから確認待ちへ戻してください。',
  };
}

export function selectDuplicateSubmission(selectedSubmissionId: string): DuplicateSelectionResult {
  const lock = LockService.getDocumentLock();
  if (!lock.tryLock(15_000)) throw new Error('ほかの担当者が処理中です。少し待ってから、もう一度実行してください。');
  const historyRows: number[] = [];
  const originals: Submission[] = [];
  let rejectedCount = 0;
  try {
    const actorEmail = assertAuthorized();
    const submissions = readSubmissions();
    const selected = submissions.find((submission) => submission.submissionId === selectedSubmissionId);
    if (!selected) throw new Error('採用する回答が見つかりません。申請一覧を開き直してください。');
    const candidates = duplicateCandidates(submissions, selected);
    if (candidates.length < 2) throw new Error('比較できる回答が2件以上ありません。申請を再検査してください。');
    originals.push(...candidates);
    candidates.forEach((candidate) => {
      const selectedCandidate = candidate.submissionId === selectedSubmissionId;
      if (!selectedCandidate) {
        updateSubmission({ ...candidate, status: 'REJECTED' });
        rejectedCount += 1;
      }
      historyRows.push(appendApproval({
        approvalId: Utilities.getUuid(), submissionId: candidate.submissionId,
        action: selectedCandidate ? '重複回答から採用' : '重複回答のため不採用', actorEmail,
        reason: selectedCandidate
          ? '同じクラスの複数回答を比較し、この回答を採用しました。'
          : `同じクラスの複数回答を比較し、${selectedSubmissionId}を採用しました。`,
        actedAt: new Date().toISOString(),
      }));
    });
  } catch (error) {
    originals.forEach((submission) => {
      try { updateSubmission(submission); } catch { /* 元のエラーを優先する。 */ }
    });
    historyRows.reverse().forEach((row) => {
      try { removeFailedApprovalRow(row); } catch { /* 元のエラーを優先する。 */ }
    });
    throw error;
  } finally {
    lock.releaseLock();
  }
  revalidateAffectedSubmissions(originals.map((submission) => submission.submissionId));
  return {
    selectedSubmissionId, rejectedCount,
    message: `この回答を採用し、ほかの${rejectedCount}件を不採用にしました。`,
  };
}

export function approveAllClearSubmissions(): BulkApprovalResult {
  const lock = LockService.getDocumentLock();
  if (!lock.tryLock(30_000)) throw new Error('ほかの担当者が処理中です。少し待ってから、もう一度実行してください。');
  const historyRows: number[] = [];
  const originals: Submission[] = [];
  let approvedCount = 0;
  let skippedCount = 0;
  try {
    const actorEmail = assertAuthorized();
    const submissions = readSubmissions();
    assertMockRosterSourceConsistent(submissions);
    const allItems = readItems();
    const students = readStudents();
    const rules = readRuleSettings();
    const candidates = clearApprovalCandidates(submissions);
    candidates.forEach((candidate) => {
      const validation = validateSubmission(
        candidate,
        allItems.filter((item) => item.submissionId === candidate.submissionId),
        {
          students,
          sameClassInitialSubmissionCount: duplicateCandidates(submissions, candidate).length,
          rules,
          // 突き合わせ待ちの申請は警告が付くので、まとめて承認の対象から外れる。
          ...overlapContextArgument(overlapContextFor(candidate, submissions, allItems)),
        },
      );
      if (validation.warningCount > 0 || validation.errorCount > 0 || validation.nextStatus !== 'PENDING_APPROVAL') {
        skippedCount += 1;
        return;
      }
      originals.push(candidate);
      updateSubmission({ ...candidate, status: 'APPROVED', warningCount: 0, errorCount: 0 });
      historyRows.push(appendApproval({
        approvalId: Utilities.getUuid(), submissionId: candidate.submissionId,
        action: '問題なしを一括承認', actorEmail,
        reason: '警告0件・エラー0件であることを再検査し、一括承認しました。',
        actedAt: new Date().toISOString(),
      }));
      approvedCount += 1;
    });
  } catch (error) {
    originals.forEach((submission) => {
      try { updateSubmission(submission); } catch { /* 元のエラーを優先する。 */ }
    });
    historyRows.reverse().forEach((row) => {
      try { removeFailedApprovalRow(row); } catch { /* 元のエラーを優先する。 */ }
    });
    throw error;
  } finally {
    lock.releaseLock();
  }
  revalidateAffectedSubmissions(originals.map((submission) => submission.submissionId));
  return {
    approvedCount, skippedCount,
    message: skippedCount > 0
      ? `${approvedCount}件を承認しました。再検査で問題が見つかった${skippedCount}件は承認していません。`
      : `${approvedCount}件をまとめて承認しました。`,
  };
}

export function openIssueLocation(
  submissionId: string,
  submissionItemId = ''
): OpenIssueLocationResult {
  assertAuthorized();
  const itemTarget = submissionItemId.trim() !== '';
  const sheetName = itemTarget ? SHEETS.items : SHEETS.submissions;
  const targetId = itemTarget ? submissionItemId : submissionId;
  const sheet = requireSheet(sheetName);
  const row = findRowById(sheet, targetId);
  if (row < 2) {
    throw new Error(itemTarget
      ? '修正する入力欄が見つかりません。申請を再検査してから、もう一度開いてください。'
      : '対象の申請行が見つかりません。一覧を開き直してください。');
  }
  const range = itemTarget
    ? sheet.getRange(row, ITEM_HEADERS.indexOf('student_id_input') + 1, 1, 2)
    : sheet.getRange(row, 1, 1, SUBMISSION_HEADERS.length);
  const book = SpreadsheetApp.getActiveSpreadsheet();
  book.setActiveSheet(sheet);
  book.setActiveRange(range);
  book.toast(
    itemTarget
      ? '青く選択された学籍番号を確認してください。直した後は「すべて再検査する」を実行します。'
      : '青く選択された申請全体の情報を確認してください。',
    '修正箇所を開きました',
    8
  );
  return { sheetName, rangeA1: range.getA1Notation() };
}

export function editSubmissionItem(
  submissionId: string,
  submissionItemId: string,
  studentIdInput: string,
  registrationState: SubmissionItem['registrationState'],
  reason: string
): EditItemResult {
  const lock = LockService.getDocumentLock();
  if (!lock.tryLock(15_000)) {
    throw new Error('ほかの担当者が処理中です。少し待ってから、もう一度操作してください。');
  }
  let result: EditItemResult;
  try {
    const actorEmail = assertAuthorized();
    const submission = findSubmission(submissionId);
    if (!submission) throw new Error('指定された申請が見つかりません。一覧を開き直してください。');
    if (!REVIEWABLE.includes(submission.status)) {
      throw new Error('この申請は現在修正できる状態ではありません。申請一覧を開き直してください。');
    }
    if (reason.trim() === '') {
      throw new Error('修正理由を入力してください。何をどう直したか後から確認できるようにします。');
    }
    const before = findItem(submissionItemId);
    if (!before || before.submissionId !== submissionId) {
      throw new Error('修正する申請項目が見つかりません。詳細を開き直してください。');
    }
    const normalizedStudentIdInput = studentIdInput.trim();
    const after = updateItemInput(submissionItemId, normalizedStudentIdInput, registrationState);
    // 学籍番号だけの入力なので、変更履歴へは名簿から引いた氏名を残す。
    const historyNameById = new Map(readStudents().map((student) => [student.studentId, student.name]));
    const historyName = (item: SubmissionItem): string =>
      historyNameById.get(normalizeStudentId(item.studentIdInput)) ?? item.studentNameInput;
    try {
      appendChangeHistory({
        changeId: Utilities.getUuid(),
        submissionId,
        submissionItemId,
        beforeStudentId: before.studentIdInput,
        afterStudentId: after.studentIdInput,
        beforeStudentName: historyName(before),
        afterStudentName: historyName(after),
        beforeRegistrationState: before.registrationState,
        afterRegistrationState: after.registrationState,
        reason: reason.trim(),
        actorEmail,
        changedAt: new Date().toISOString()
      });
    } catch (error) {
      updateItemInput(submissionItemId, before.studentIdInput, before.registrationState);
      throw error;
    }
    result = {
      submissionId,
      submissionItemId,
      message: '修正を保存しました。自動再検査後に結果を更新します。'
    };
  } finally {
    lock.releaseLock();
  }
  revalidateAffectedSubmissions([submissionId]);
  return result;
}

function findRowById(sheet: ReturnType<typeof requireSheet>, targetId: string): number {
  if (sheet.getLastRow() < 2) return 0;
  const found = sheet.getRange(2, 1, sheet.getLastRow() - 1, 1)
    .createTextFinder(targetId)
    .matchEntireCell(true)
    .findNext();
  return found?.getRow() ?? 0;
}

export function performSubmissionAction(
  submissionId: string,
  action: SubmissionAction,
  reason = ''
): ActionResult {
  const lock = LockService.getDocumentLock();
  if (!lock.tryLock(15_000)) {
    throw new Error('ほかの担当者が処理中です。少し待ってから、もう一度操作してください。');
  }
  let historyRow = 0;
  let previous: Submission | undefined;
  let previousItems: SubmissionItem[] | undefined;
  let previousIssues: ReturnType<typeof readIssues> | undefined;
  let previousRegistrations: ReturnType<typeof readRegistrations> | undefined;
  let previousRosterRebuildMessage: string | null = null;
  try {
    const actorEmail = assertAuthorized();
    const submission = findSubmission(submissionId);
    if (!submission) throw new Error('指定された申請が見つかりません。一覧を開き直してください。');
    assertMockRosterSourceConsistent([submission]);
    previous = submission;
    previousItems = readItems().filter((item) => item.submissionId === submissionId);
    previousIssues = readIssues().filter((issue) => issue.submissionId === submissionId);
    if (action === 'REOPEN_APPROVED' && submission.status === 'APPLIED') {
      if (PropertiesService.getDocumentProperties().getProperty(SCRIPT_PROPERTIES.playerRosterJob)) {
        throw new Error('選手名簿を作成中のため、名簿反映済み申請は戻せません。名簿作成が完了するか、途中の作成を取り消してから実行してください。');
      }
      previousRegistrations = readRegistrations();
      previousRosterRebuildMessage = PropertiesService.getDocumentProperties()
        .getProperty(SCRIPT_PROPERTIES.rosterRebuildRequired);
    }
    if (action === 'APPROVE' && previousIssues.some((issue) =>
      issue.submissionId === submissionId && issue.issueCode === ISSUE_CODES.MULTIPLE_INITIAL_SUBMISSIONS)) {
      throw new Error('同じクラスの回答が複数あります。先に回答を比較し、採用する1件を選んでください。');
    }
    // 修正申請を単独で承認すると、まだ登録されていない登録申請の競技が登録されないまま残る。
    // 取り込み済みの修正申請は閉じてあるので、ここへは来ない。
    if (action === 'APPROVE' && submission.submissionType === 'CORRECTION') {
      const openInitial = openInitialFor(readSubmissions(), submission);
      if (openInitial) {
        throw new Error(`同じクラスの登録申請（${openInitial.submissionId}）がまだ登録されていません。先に「登録申請と修正申請の突き合わせ」で内容を取り込むか、登録申請を処理してから承認してください。`);
      }
    }
    const validationTarget = action === 'RESUME'
      ? { ...submission, receptionOpen: true }
      : action === 'RESTORE' || action === 'REOPEN_APPROVED'
        ? { ...submission, status: 'PENDING_APPROVAL' as const }
        : submission;
    const validation = action === 'APPROVE' || action === 'RESUME'
      || action === 'RESTORE' || action === 'REOPEN_APPROVED'
      ? revalidateOne(validationTarget)
      : undefined;
    assertActionAllowed(submission, action, reason, validation);
    const candidate = validation ? {
      ...validationTarget,
      warningCount: validation.warningCount,
      errorCount: validation.errorCount
    } : submission;
    const status = nextStatusForAction(action, validation);
    const updated = { ...candidate, status };
    updateSubmission(updated);
    try {
      historyRow = appendApproval({
        approvalId: Utilities.getUuid(), submissionId, action, actorEmail,
        reason: reason.trim(), actedAt: new Date().toISOString()
      });
    } catch (error) {
      updateSubmission(submission);
      throw error;
    }
    if (validation) {
      updateValidatedItems(validation.normalizedItems);
      replaceIssuesForSubmissions([submissionId], validation.issues);
    }
    if (action === 'REOPEN_APPROVED' && submission.status === 'APPLIED') {
      const appliedOnly = readSubmissions().map((current) => current.status === 'APPROVED'
        ? { ...current, status: 'PENDING_APPROVAL' as const }
        : current);
      const timestamp = new Date();
      replaceRegistrations(buildRegistrationSnapshot({
        submissions: appliedOnly,
        items: readItems(),
        students: readStudents(),
        versionName: `承認取消_${Utilities.formatDate(timestamp, 'Asia/Tokyo', 'yyyyMMdd_HHmmss')}`,
        updatedAt: timestamp.toISOString(),
        updatedBy: actorEmail,
      }));
      PropertiesService.getDocumentProperties().setProperty(
        SCRIPT_PROPERTIES.rosterRebuildRequired,
        '名簿反映済み申請の承認を取り消したため、配布用名簿は旧版です。申請を修正・再承認して、新しい名簿版を作成してください。',
      );
    }
    writeDashboard(buildDashboardData(readSubmissions(), 'ALL'));
    return { submissionId, status, message: actionMessage(action) };
  } catch (error) {
    if (historyRow > 0 && previous) {
      try {
        removeFailedApprovalRow(historyRow);
        updateSubmission(previous);
        if (previousItems) updateValidatedItems(previousItems);
        if (previousIssues) replaceIssuesForSubmissions([submissionId], previousIssues);
        if (previousRegistrations) replaceRegistrations(previousRegistrations);
        if (previousRegistrations) {
          const properties = PropertiesService.getDocumentProperties();
          if (previousRosterRebuildMessage == null) {
            properties.deleteProperty(SCRIPT_PROPERTIES.rosterRebuildRequired);
          } else {
            properties.setProperty(SCRIPT_PROPERTIES.rosterRebuildRequired, previousRosterRebuildMessage);
          }
        }
      } catch {
        // 元のエラーを優先する。個人情報はログへ出力しない。
      }
    }
    throw error;
  } finally {
    lock.releaseLock();
  }
}

/**
 * 同じクラスの、まだ登録されていない相手の申請と枠が食い違っているかを調べる。
 * 登録申請から見れば「あとから届いた修正申請」、修正申請から見れば「まだ登録していない登録申請」。
 */
function overlapContextFor(
  submission: Submission,
  submissions: Submission[],
  allItems: SubmissionItem[],
): ValidationContext['overlappingSubmission'] {
  const partners = submission.submissionType === 'CORRECTION'
    ? [openInitialFor(submissions, submission)].filter(Boolean) as Submission[]
    : openCorrectionsFor(submissions, submission);
  const itemsOf = (id: string): SubmissionItem[] =>
    allItems.filter((item) => item.submissionId === id);
  for (const partner of partners) {
    const correction = submission.submissionType === 'CORRECTION' ? submission : partner;
    const base = submission.submissionType === 'CORRECTION' ? partner : submission;
    const overlap = buildCorrectionOverlap({
      correction,
      correctionItems: itemsOf(correction.submissionId),
      base: { submission: base, items: itemsOf(base.submissionId), issues: [] },
      registrations: [],
      students: [],
    });
    if (!overlap || overlap.changedCount === 0) continue;
    return {
      submissionId: partner.submissionId,
      submissionType: partner.submissionType,
      submittedAt: partner.submittedAt,
      changedSlotCount: overlap.changedCount,
    };
  }
  return undefined;
}

function revalidateOne(submission: Submission): ValidationResult {
  const allSubmissions = readSubmissions().map((candidate) =>
    candidate.submissionId === submission.submissionId ? submission : candidate);
  return validateSubmission(
    submission,
    readItems().filter((item) => item.submissionId === submission.submissionId),
    {
      students: readStudents(),
      sameClassInitialSubmissionCount: duplicateCandidates(allSubmissions, submission).length,
      rules: readRuleSettings(),
      ...overlapContextArgument(overlapContextFor(submission, allSubmissions, readItems())),
    }
  );
}

/** `exactOptionalPropertyTypes`のため、値があるときだけ項目を足す。 */
function overlapContextArgument(
  overlappingSubmission: ValidationContext['overlappingSubmission'],
): Pick<ValidationContext, 'overlappingSubmission'> | Record<string, never> {
  return overlappingSubmission ? { overlappingSubmission } : {};
}

function actionMessage(action: SubmissionAction): string {
  if (action === 'APPROVE') return '申請を承認しました。正式データと帳票はまだ変更していません。';
  if (action === 'HOLD') return '申請を保留にしました。';
  if (action === 'REJECT') return '申請を却下しました。';
  if (action === 'RESTORE') return '却下済み申請を再検査し、確認できる状態へ戻しました。';
  if (action === 'REOPEN_APPROVED') return '承認を取り消し、申請を再検査して確認待ちへ戻しました。名簿反映済みだった場合は登録データも再構築しました。修正・再承認後に新しい名簿版を作成してください。';
  return '申請の確認を再開しました。';
}

function writeDashboard(data: DashboardData): void {
  const sheet = requireSheet(SHEETS.dashboard);
  // 既存の結合範囲が現在のデータ範囲より広い場合も安全に解除する。
  sheet.getRange(1, 1, sheet.getMaxRows(), sheet.getMaxColumns()).breakApart();
  sheet.clear();
  const rows: SheetValueForDashboard[][] = [
    ['体育祭 選手登録管理', ''],
    ['現在の確認状況', '件数'],
    ['未処理の申請', data.pending],
    ['警告', `${data.warning}件  開く`],
    ['エラー', `${data.error}件  開く`],
    ['問題なし', `${data.clear}件  開く`],
    ['保留', `${data.hold}件  開く`],
    ['却下済み', `${data.rejected}件  開く`],
    ['承認済み', `${data.approved}件  開く`],
    ['配布用名簿', data.rosterRebuildRequired ? '要再作成' : '最新'],
    ['', ''],
    ['操作方法', '色付きの「開く」を押してください。反応しない場合は、上の「選手登録管理」メニューから開けます。']
  ];
  sheet.getRange(1, 1, rows.length, 2).setValues(rows);
  sheet.getRange('A1:B1').merge().setFontWeight('bold').setFontSize(16);
  sheet.getRange('A2:B2').setFontWeight('bold').setBackground('#d9ead3');
  sheet.getRange('A4:A9').setFontWeight('bold').setVerticalAlignment('middle');
  sheet.getRange('B4:B9')
    .setFontWeight('bold')
    .setFontColor(DASHBOARD_COLORS.buttonText)
    .setHorizontalAlignment('center')
    .setVerticalAlignment('middle');
  sheet.getRange('B4').setBackground(DASHBOARD_COLORS.warning);
  sheet.getRange('B5').setBackground(DASHBOARD_COLORS.error);
  sheet.getRange('B6').setBackground(DASHBOARD_COLORS.clear);
  sheet.getRange('B7').setBackground(DASHBOARD_COLORS.hold);
  sheet.getRange('B8').setBackground(DASHBOARD_COLORS.rejected);
  sheet.getRange('B9').setBackground(DASHBOARD_COLORS.approved);
  sheet.getRange('A10:B10').setFontWeight('bold')
    .setBackground(data.rosterRebuildRequired ? '#fce8e6' : '#e6f4ea')
    .setFontColor(data.rosterRebuildRequired ? DASHBOARD_COLORS.error : DASHBOARD_COLORS.clear);
  sheet.setRowHeights(4, 6, 44);
  sheet.setColumnWidth(1, 180);
  sheet.setColumnWidth(2, 420);
  sheet.setFrozenRows(2);
  installDashboardButtons(sheet);
}

type SheetValueForDashboard = string | number;

function installDashboardButtons(sheet: ReturnType<typeof requireSheet>): void {
  sheet.getImages()
    .filter((image) => image.getAltTextTitle() === DASHBOARD_BUTTON_IMAGE_TITLE)
    .forEach((image) => image.remove());

  const buttonSpecs = [
    { row: 4, script: 'showWarningDashboard', label: '警告がある申請を開く' },
    { row: 5, script: 'showErrorDashboard', label: 'エラーがある申請を開く' },
    { row: 6, script: 'showClearDashboard', label: '問題がない申請を開く' },
    { row: 7, script: 'showHoldDashboard', label: '保留中の申請を開く' },
    { row: 8, script: 'showRejectedDashboard', label: '却下済みの申請を開く' },
    { row: 9, script: 'showApprovedDashboard', label: '承認済みの申請を開く' }
  ];
  const imageBlob = Utilities.newBlob(
    Utilities.base64Decode(TRANSPARENT_PIXEL_PNG),
    'image/png',
    'dashboard-button.png'
  );
  buttonSpecs.forEach(({ row, script, label }) => {
    sheet.insertImage(imageBlob, 2, row, 2, 2)
      .setWidth(416)
      .setHeight(40)
      .setAltTextTitle(DASHBOARD_BUTTON_IMAGE_TITLE)
      .setAltTextDescription(label)
      .assignScript(script);
  });
}

export function dashboardFilterFromSelection(): DashboardFilter {
  const range = SpreadsheetApp.getActiveRange();
  if (!range || range.getSheet().getName() !== SHEETS.dashboard) return 'ALL';
  const label = String(range.getSheet().getRange(range.getRow(), 1).getDisplayValue());
  if (label.includes('警告')) return 'WARNING';
  if (label.includes('エラー')) return 'ERROR';
  if (label.includes('問題なし')) return 'CLEAR';
  if (label.includes('保留')) return 'HOLD';
  if (label.includes('却下')) return 'REJECTED';
  if (label.includes('承認済み')) return 'APPROVED';
  return 'ALL';
}

export function showFilteredSidebarFromSelection(): void {
  const template = HtmlService.createTemplateFromFile('Sidebar');
  template.initialFilter = dashboardFilterFromSelection();
  template.uiTokens = HtmlService.createHtmlOutputFromFile('UiTokens').getContent();
  SpreadsheetApp.getUi().showSidebar(template.evaluate().setTitle('申請を確認する'));
}
