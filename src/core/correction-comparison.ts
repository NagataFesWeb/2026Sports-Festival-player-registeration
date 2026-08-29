import type {
  CorrectionOverlap,
  OverlapSlotRow,
  Registration,
  Student,
  Submission,
  SubmissionItem,
  ValidationIssue,
} from '../shared/types';
import { normalizeStudentId } from './normalization';

/** まだ登録データへ反映されていない申請の状態。 */
const OPEN_STATUSES: ReadonlySet<Submission['status']> = new Set([
  'RECEIVED', 'CHECKED', 'PENDING_APPROVAL', 'NEEDS_CORRECTION', 'ON_HOLD',
]);

/**
 * 同じクラスの、まだ登録されていない登録申請を返す。
 * 修正申請の比較相手になる。複数あるときは新しいものを選ぶ。
 */
export function openInitialFor(
  submissions: Submission[],
  correction: Submission,
): Submission | undefined {
  if (correction.submissionType !== 'CORRECTION') return undefined;
  return submissions
    .filter((candidate) => candidate.submissionType === 'INITIAL')
    .filter((candidate) => candidate.targetGrade === correction.targetGrade
      && candidate.targetClass === correction.targetClass)
    .filter((candidate) => OPEN_STATUSES.has(candidate.status))
    .sort((left, right) => right.submittedAt.localeCompare(left.submittedAt)
      || right.submissionId.localeCompare(left.submissionId))[0];
}

/**
 * 同じクラスへ、その登録申請より後に届いた未処理の修正申請を返す。
 * 登録申請を見ているときに「あとから修正が来ている」と気づけるようにする。
 */
export function openCorrectionsFor(
  submissions: Submission[],
  initial: Submission,
): Submission[] {
  if (initial.submissionType !== 'INITIAL') return [];
  return submissions
    .filter((candidate) => candidate.submissionType === 'CORRECTION')
    .filter((candidate) => candidate.targetGrade === initial.targetGrade
      && candidate.targetClass === initial.targetClass)
    .filter((candidate) => OPEN_STATUSES.has(candidate.status))
    .sort((left, right) => left.submittedAt.localeCompare(right.submittedAt));
}

/** 突き合わせに関わる申請IDを返す。片方を直したらもう片方も検査し直すために使う。 */
export function overlapPartnerIds(submissions: Submission[], target: Submission): string[] {
  if (target.submissionType === 'CORRECTION') {
    const base = openInitialFor(submissions, target);
    return base ? [base.submissionId] : [];
  }
  return openCorrectionsFor(submissions, target).map((candidate) => candidate.submissionId);
}

export interface BuildCorrectionOverlapInput {
  correction: Submission;
  correctionItems: SubmissionItem[];
  /** まだ登録されていない登録申請。無ければ`登録データ`と比べる。 */
  base?: { submission: Submission; items: SubmissionItem[]; issues: ValidationIssue[] };
  registrations: Registration[];
  students: Student[];
  /** 承認取消などで`登録データ`が古いときの説明。 */
  registrationStaleMessage?: string;
}

/**
 * 修正申請の枠を1つずつ、比較相手（未登録の登録申請、または登録済みの内容）と突き合わせる。
 * 競技IDと枠IDで対応付ける。枠名や氏名では対応付けない。
 */
export function buildCorrectionOverlap(
  input: BuildCorrectionOverlapInput,
): CorrectionOverlap | undefined {
  if (input.correction.submissionType !== 'CORRECTION') return undefined;
  const nameById = new Map(input.students.map((student) => [student.studentId, student.name]));
  const displayName = (studentId: string): string =>
    (studentId === '' ? '' : nameById.get(studentId) ?? '名簿にありません');

  const correctionSlots = input.correctionItems
    .filter((item) => item.eventId !== '' && item.slotId !== '');
  if (correctionSlots.length === 0) return undefined;

  const rows = input.base
    ? compareWithSubmission(correctionSlots, input.base, displayName)
    : compareWithRegistrations(
      correctionSlots, input.correction, input.registrations, displayName,
    );
  if (rows.length === 0) return undefined;

  return {
    correctionSubmissionId: input.correction.submissionId,
    correctionSubmittedAt: input.correction.submittedAt,
    baseKind: input.base ? 'OPEN_INITIAL' : 'REGISTRATION',
    baseSubmissionId: input.base?.submission.submissionId ?? '',
    baseSubmittedAt: input.base?.submission.submittedAt ?? '',
    baseStatus: input.base?.submission.status ?? '',
    rows,
    changedCount: rows.filter((row) => row.changed).length,
    baseErrorCount: rows.filter((row) => row.baseHasError).length,
    canImport: Boolean(input.base),
    baseStaleMessage: input.base ? '' : (input.registrationStaleMessage ?? ''),
  };
}

function compareWithSubmission(
  correctionSlots: SubmissionItem[],
  base: NonNullable<BuildCorrectionOverlapInput['base']>,
  displayName: (studentId: string) => string,
): OverlapSlotRow[] {
  const baseBySlot = new Map(base.items
    .filter((item) => item.eventId !== '' && item.slotId !== '')
    .map((item) => [slotKey(item.eventId, item.slotId), item]));
  const errorItemIds = new Set(base.issues
    .filter((issue) => issue.severity === 'ERROR')
    .flatMap((issue) => [
      issue.submissionItemId,
      ...String(issue.relatedItemIds ?? '').split(',').map((value) => value.trim()),
    ])
    .filter((value) => value !== ''));
  return correctionSlots.map((item) => {
    const baseItem = baseBySlot.get(slotKey(item.eventId, item.slotId));
    const correctionStudentId = normalizeStudentId(item.studentIdInput);
    const baseStudentId = baseItem ? normalizeStudentId(baseItem.studentIdInput) : '';
    return {
      eventId: item.eventId,
      eventName: item.eventName,
      slotId: item.slotId,
      slotName: item.slotName,
      correctionItemId: item.submissionItemId,
      correctionStudentId,
      correctionStudentName: displayName(correctionStudentId),
      correctionState: item.registrationState,
      baseItemId: baseItem?.submissionItemId ?? '',
      baseStudentId,
      baseStudentName: displayName(baseStudentId),
      baseState: baseItem?.registrationState ?? '',
      baseExists: Boolean(baseItem),
      changed: !baseItem || baseStudentId !== correctionStudentId
        || baseItem.registrationState !== item.registrationState,
      baseHasError: Boolean(baseItem && errorItemIds.has(baseItem.submissionItemId)),
    };
  });
}

function compareWithRegistrations(
  correctionSlots: SubmissionItem[],
  correction: Submission,
  registrations: Registration[],
  displayName: (studentId: string) => string,
): OverlapSlotRow[] {
  const registeredBySlot = new Map(registrations
    .filter((registration) => registration.grade === correction.targetGrade
      && registration.classNumber === correction.targetClass)
    .map((registration) => [slotKey(registration.eventId, registration.slotId), registration]));
  // 登録済みの競技に触れていない修正申請は、比べるものがない。
  const touchesRegisteredEvent = correctionSlots.some((item) =>
    registeredBySlot.has(slotKey(item.eventId, item.slotId)));
  if (!touchesRegisteredEvent) return [];
  return correctionSlots.map((item) => {
    const registered = registeredBySlot.get(slotKey(item.eventId, item.slotId));
    const correctionStudentId = normalizeStudentId(item.studentIdInput);
    const baseStudentId = registered?.studentId ?? '';
    return {
      eventId: item.eventId,
      eventName: item.eventName,
      slotId: item.slotId,
      slotName: item.slotName,
      correctionItemId: item.submissionItemId,
      correctionStudentId,
      correctionStudentName: displayName(correctionStudentId),
      correctionState: item.registrationState,
      baseItemId: '',
      baseStudentId,
      baseStudentName: registered?.studentNameSnapshot ?? displayName(baseStudentId),
      baseState: registered ? ('REGISTER' as const) : '',
      baseExists: Boolean(registered),
      changed: baseStudentId !== correctionStudentId,
      baseHasError: false,
    };
  });
}

function slotKey(eventId: string, slotId: string): string {
  return `${eventId}:${slotId}`;
}
