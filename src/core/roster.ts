import type { EventSetting, Registration, Student, Submission, SubmissionItem } from '../shared/types';

export interface RegistrationSnapshotInput {
  submissions: Submission[];
  items: SubmissionItem[];
  students: Student[];
  versionName: string;
  updatedAt: string;
  updatedBy: string;
}

export interface AthleteIndexRow {
  grade: number;
  classNumber: number;
  studentId: string;
  studentName: string;
  eventSummary: string;
}

export interface ConcurrentRosterAthlete {
  registrationId: string;
  studentId: string;
  studentName: string;
}

export interface ConcurrentRosterRow {
  slotId: string;
  slotName: string;
  athletesByClass: Record<number, ConcurrentRosterAthlete[]>;
}

export interface ConcurrentRosterTable {
  eventId: string;
  eventName: string;
  rows: ConcurrentRosterRow[];
}

export type RosterJobStep = { kind: 'REPORT'; reportIndex: number } | { kind: 'FINALIZE' };

export const ROSTER_REPORT_NAMES = ['種目別', 'クラス別・招集順', '当日変更用', 'クラス配布用PDF'] as const;

export interface ClassDistributionPage {
  grade: number;
  classNumber: number;
  registrations: Registration[];
}

export function buildClassDistributionPages(
  registrations: Registration[], students: Student[],
): ClassDistributionPage[] {
  const classKeys = new Set<string>();
  students.forEach((student) => classKeys.add(`${student.grade}:${student.classNumber}`));
  registrations.forEach((row) => classKeys.add(`${row.grade}:${row.classNumber}`));
  return [...classKeys]
    .map((key) => {
      const [grade, classNumber] = key.split(':').map(Number);
      return {
        grade: grade!,
        classNumber: classNumber!,
        registrations: registrations
          .filter((row) => row.grade === grade && row.classNumber === classNumber)
          .sort((left, right) => left.eventName.localeCompare(right.eventName, 'ja')
            || numberIn(left.slotName || left.slotId) - numberIn(right.slotName || right.slotId)
            || left.studentId.localeCompare(right.studentId)),
      };
    })
    .sort((left, right) => left.grade - right.grade || left.classNumber - right.classNumber);
}

export function planRosterJobStep(nextReportIndex: number, reportCount: number): RosterJobStep {
  if (!Number.isInteger(nextReportIndex) || nextReportIndex < 0
    || !Number.isInteger(reportCount) || reportCount < 1 || nextReportIndex > reportCount) {
    throw new Error('名簿作成の進み具合が正しくありません。作成状況を確認してください。');
  }
  return nextReportIndex < reportCount
    ? { kind: 'REPORT', reportIndex: nextReportIndex }
    : { kind: 'FINALIZE' };
}

export function assertRosterJobCanStart(activeVersionName = ''): void {
  if (activeVersionName) {
    throw new Error(`「${activeVersionName}」を作成中です。二重作成はできません。`);
  }
}

export interface RosterDistributionPreflight {
  problemSubmissionCount: number;
  message: string;
}

export function buildRosterDistributionPreflight(submissions: Submission[]): RosterDistributionPreflight {
  const problemSubmissionCount = submissions.filter((submission) =>
    !['APPROVED', 'APPLIED', 'REJECTED'].includes(submission.status)
    && (submission.warningCount > 0 || submission.errorCount > 0)).length;
  return {
    problemSubmissionCount,
    message: problemSubmissionCount > 0
      ? `未処理の警告・エラーがある申請が${problemSubmissionCount}件あります。PDF配布前に申請一覧を確認してください。`
      : '未処理の警告・エラーがある申請はありません。PDF化する前に名簿の空欄と改ページを目視確認してください。',
  };
}

function numberIn(value: string): number {
  const match = value.match(/\d+/);
  return match ? Number(match[0]) : Number.MAX_SAFE_INTEGER;
}

/**
 * 同じ時刻に出場する選手を横方向へ比較できるよう、競技・走順・クラスでまとめる。
 * registrations の並び順を競技の表示順として維持する。
 */
export function buildConcurrentRosterTables(
  registrations: Registration[], grade: number, configuredEvents?: EventSetting[],
): ConcurrentRosterTable[] {
  const gradeRows = registrations.filter((registration) => registration.grade === grade);
  const configured = (configuredEvents ?? []).filter((event) => event.enabled
    && (event.targetGrade === '全学年' || event.targetGrade === `${grade}年`));
  const configuredIds = new Set(configured.map((event) => event.eventId));
  const eventOrder = configuredEvents
    ? [...configured.map((event) => event.eventId),
      ...new Set(gradeRows.map((registration) => registration.eventId)
        .filter((eventId) => !configuredIds.has(eventId)))]
    : [...new Set(gradeRows.map((registration) => registration.eventId))];

  return eventOrder.map((eventId) => {
    const eventRows = gradeRows.filter((registration) => registration.eventId === eventId);
    const event = configured.find((candidate) => candidate.eventId === eventId);
    const first = eventRows[0];
    const slots = new Map<string, Registration[]>();
    eventRows.forEach((registration) => {
      const current = slots.get(registration.slotId) ?? [];
      current.push(registration);
      slots.set(registration.slotId, current);
    });

    const existingRows = [...slots.entries()]
      .sort(([, left], [, right]) =>
        numberIn(left[0]?.slotName ?? '') - numberIn(right[0]?.slotName ?? '')
        || (left[0]?.slotName ?? '').localeCompare(right[0]?.slotName ?? '', 'ja'))
      .map(([slotId, slotRegistrations]) => {
        const athletesByClass: Record<number, ConcurrentRosterAthlete[]> = {};
        slotRegistrations
          .sort((left, right) => left.classNumber - right.classNumber
            || left.studentId.localeCompare(right.studentId))
          .forEach((registration) => {
            const athletes = athletesByClass[registration.classNumber] ?? [];
            athletes.push({
              registrationId: registration.registrationId,
              studentId: registration.studentId,
              studentName: registration.studentNameSnapshot,
            });
            athletesByClass[registration.classNumber] = athletes;
          });
        return { slotId, slotName: slotRegistrations[0]?.slotName ?? slotId, athletesByClass };
      });
    const rows = event
      ? Array.from({ length: Math.max(0, event.requiredCount) }, (_, offset) => {
        const index = offset + 1;
        return existingRows.find((row) => numberIn(row.slotName || row.slotId) === index) ?? {
          slotId: `${event.eventId}-slot-${String(index).padStart(2, '0')}`,
          slotName: event.hasOrder ? `第${index}走者` : `${index}人目`,
          athletesByClass: {},
        };
      }).concat(existingRows.filter((row) => numberIn(row.slotName || row.slotId) > event.requiredCount))
      : existingRows;
    return { eventId, eventName: event?.eventName ?? first?.eventName ?? eventId, rows };
  });
}

export function buildAthleteIndex(registrations: Registration[]): AthleteIndexRow[] {
  const byStudent = new Map<string, Registration[]>();
  registrations.forEach((registration) => {
    const key = `${registration.grade}:${registration.classNumber}:${registration.studentId}`;
    const current = byStudent.get(key) ?? [];
    current.push(registration);
    byStudent.set(key, current);
  });
  return [...byStudent.values()]
    .map((rows) => {
      const first = rows[0]!;
      const eventSummary = [...rows]
        .sort((left, right) => left.eventName.localeCompare(right.eventName, 'ja')
          || left.slotName.localeCompare(right.slotName, 'ja'))
        .map((row) => row.slotName ? `${row.eventName}（${row.slotName}）` : row.eventName)
        .join('\n');
      return {
        grade: first.grade, classNumber: first.classNumber, studentId: first.studentId,
        studentName: first.studentNameSnapshot, eventSummary,
      };
    })
    .sort((left, right) => left.grade - right.grade || left.classNumber - right.classNumber
      || left.studentId.localeCompare(right.studentId));
}

export function normalizeRosterInputName(value: string): string {
  return Array.from(value)
    .map((character) => {
      const code = character.charCodeAt(0);
      return character === '/' || character === '\\' || code < 32 || code === 127 ? '-' : character;
    })
    .join('')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80);
}

export function selectRosterVersionName(inputName: string, existingFolderNames: Iterable<string>): string {
  const normalized = normalizeRosterInputName(inputName);
  if (!normalized) throw new Error('選手名簿の名前を入力してください。例：「第1回確認版」');
  const existing = new Set(existingFolderNames);
  for (let minor = 0; minor < 10_000; minor += 1) {
    const candidate = `${normalized}_v1.${minor}`;
    if (!existing.has(candidate)) return candidate;
  }
  throw new Error('同じ名前の版が多すぎるため作成できません。別の名前を入力してください。');
}

const accepted = (submission: Submission): boolean =>
  submission.status === 'APPROVED' || submission.status === 'APPLIED';

const timestamp = (value: string): number => {
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? 0 : parsed;
};

const registrationKey = (grade: number, classNumber: number, eventId: string, slotId: string): string =>
  `${grade}:${classNumber}:${eventId}:${slotId}`;

const safeIdPart = (value: string): string => encodeURIComponent(value).replace(/%/g, '_');

export function buildRegistrationSnapshot(input: RegistrationSnapshotInput): Registration[] {
  const students = new Map(input.students.map((student) => [student.studentId, student]));
  const itemsBySubmission = new Map<string, SubmissionItem[]>();
  input.items.forEach((item) => {
    const current = itemsBySubmission.get(item.submissionId) ?? [];
    current.push(item);
    itemsBySubmission.set(item.submissionId, current);
  });

  const registrations = new Map<string, Registration>();
  [...input.submissions]
    .filter(accepted)
    .sort((left, right) => timestamp(left.submittedAt) - timestamp(right.submittedAt)
      || left.submissionId.localeCompare(right.submissionId))
    .forEach((submission) => {
      const submissionItems = itemsBySubmission.get(submission.submissionId) ?? [];
      const eventIds = new Set(submissionItems.map((item) => item.eventId).filter(Boolean));

      // A later accepted answer replaces the whole event for that class. This also
      // lets a correction form clear a previously registered runner.
      eventIds.forEach((eventId) => {
        [...registrations.entries()].forEach(([key, registration]) => {
          if (registration.grade === submission.targetGrade
            && registration.classNumber === submission.targetClass
            && registration.eventId === eventId) registrations.delete(key);
        });
      });

      submissionItems
        .filter((item) => item.registrationState === 'REGISTER' && item.normalizedStudentId !== '')
        .forEach((item) => {
          const key = registrationKey(
            submission.targetGrade, submission.targetClass, item.eventId, item.slotId,
          );
          const student = students.get(item.normalizedStudentId);
          registrations.set(key, {
            registrationId: `REG-${submission.targetGrade}-${submission.targetClass}-${safeIdPart(item.eventId)}-${safeIdPart(item.slotId)}`,
            sourceSubmissionId: submission.submissionId,
            eventId: item.eventId,
            eventName: item.eventName,
            slotId: item.slotId,
            slotName: item.slotName,
            studentId: item.normalizedStudentId,
            studentNameSnapshot: student?.name ?? item.normalizedName ?? item.studentNameInput,
            grade: submission.targetGrade,
            classNumber: submission.targetClass,
            version: input.versionName,
            updatedAt: input.updatedAt,
            updatedBy: input.updatedBy,
          });
        });
    });

  return [...registrations.values()];
}
