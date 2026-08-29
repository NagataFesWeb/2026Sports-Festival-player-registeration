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
  gender: RosterGender;
  eventSummary: string;
}

export interface ConcurrentRosterAthlete {
  registrationId: string;
  studentId: string;
  studentName: string;
  gender: RosterGender;
}

export type RosterGender = NonNullable<Student['gender']>;

/**
 * 名簿へ印刷する性別の表記。承認画面とルール論理式の`UNKNOWN`にそろえ、
 * 生徒マスターで確認できない場合は`UNKNOWN`と表示する。
 */
export function rosterGenderLabel(gender: RosterGender | undefined): string {
  return gender === 'M' ? '男' : gender === 'F' ? '女' : 'UNKNOWN';
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

/** 表示順を何区切りで1ページにまとめるか。 */
export const ROSTER_PAGE_BLOCK_SIZE = 100;

export interface EventRosterPage {
  /** 表示順を100で割った商。ページの並び順でもある。 */
  blockKey: number;
  events: EventSetting[];
}

/**
 * 表示順を100で割った商。名簿のページ分けと、修正フォームのセクション分けで同じ値を使う。
 * 片方だけ区切りが変わると帳票とフォームの並びがずれるため、必ずこの関数を通す。
 */
export function displayOrderBlockKey(displayOrder: number): number {
  const value = Number.isFinite(displayOrder) ? displayOrder : 0;
  return Math.floor(value / ROSTER_PAGE_BLOCK_SIZE);
}

/**
 * 種目別・当日変更用の名簿を、表示順の100区切りでページへ分ける。
 *
 * 表示順0・100・200はそれぞれ別のページになり、300・301・302は同じページへまとまる。
 * 学年別に競技を分けている場合（1年男子100m=301、2年男子100m=302 など）に、
 * 1枚へまとめて印刷できるようにするための区切り。
 * 同じページの中では、表示順、次に招集順で並べる。
 */
export function buildEventRosterPages(events: EventSetting[]): EventRosterPage[] {
  const sorted = [...events].sort((left, right) =>
    left.displayOrder - right.displayOrder || left.assemblyOrder - right.assemblyOrder);
  const pages: EventRosterPage[] = [];
  sorted.forEach((event) => {
    const blockKey = displayOrderBlockKey(event.displayOrder);
    const last = pages[pages.length - 1];
    if (last && last.blockKey === blockKey) {
      last.events.push(event);
      return;
    }
    pages.push({ blockKey, events: [event] });
  });
  return pages;
}

/**
 * ページの見出し。1競技だけならその競技名、複数なら競技名を並べる。
 * 長くなりすぎる場合は先頭の競技名と残りの件数にする（シート名の上限があるため）。
 */
export function eventRosterPageTitle(page: EventRosterPage, maxLength = 40): string {
  const names = page.events.map((event) => event.eventName);
  if (names.length === 1) return names[0] ?? '';
  const joined = names.join('・');
  return joined.length <= maxLength ? joined : `${names[0] ?? ''}ほか${names.length - 1}件`;
}

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
              gender: registration.genderSnapshot ?? 'U',
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
        studentName: first.studentNameSnapshot, gender: first.genderSnapshot ?? 'U', eventSummary,
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

/** 生徒マスターに未登録の学籍番号を名簿へ出すときの氏名表記。 */
export const UNLISTED_STUDENT_NAME = '（名簿未登録）';

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
            // 生徒マスターに未登録の学籍番号は警告どまりで名簿まで届く。氏名欄を空白にすると
            // 印刷物で記入漏れと見分けが付かないため、未登録であることを明示する。
            studentNameSnapshot: (student?.name ?? item.normalizedName ?? item.studentNameInput)
              || UNLISTED_STUDENT_NAME,
            genderSnapshot: student?.gender ?? 'U',
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

// ---------------------------------------------------------------- 差分作成

/**
 * 版フォルダの帳票へ実際に印字されている選手枠。各帳票の`_管理用データ`シートから読む。
 *
 * 差分の比較元にこれを使い、`登録データ`シートは使わない。承認取消のあとは
 * `登録データ`が作り直され、すでに配った帳票の中身とずれるため。
 */
export interface RosterBaselineRow {
  registrationId: string;
  eventId: string;
  grade: number;
  classNumber: number;
  studentId: string;
  studentName: string;
  /** `_管理用データ`は`男`・`女`・`UNKNOWN`の表示名で持つ。比較もこの表記でそろえる。 */
  genderLabel: string;
}

export interface RosterDiff {
  addedCount: number;
  removedCount: number;
  changedCount: number;
  /** 変わった選手枠の合計。0なら前回の版と同じ内容。 */
  totalCount: number;
  hasChanges: boolean;
  /** 書き直しが必要なページを決めるための、変わった枠が属する競技ID。 */
  affectedEventIds: string[];
  /** 書き直しが必要なシートを決めるための、変わった枠が属する学年。 */
  affectedGrades: number[];
}

/**
 * 前回の版の帳票の中身と、今回作る登録内容を選手枠単位で突き合わせる。
 *
 * `registrationId`（学年・組・競技・枠から作る）で対応付ける。氏名や性別だけが変わった枠も
 * 差分に含める。生徒マスターの氏名を直したときに、古い氏名が帳票へ残るのを防ぐため。
 */
export function diffRosterRegistrations(
  baseline: RosterBaselineRow[], next: Registration[],
): RosterDiff {
  const baseById = new Map(baseline.map((row) => [row.registrationId, row]));
  const nextById = new Map(next.map((row) => [row.registrationId, row]));
  const affectedEventIds = new Set<string>();
  const affectedGrades = new Set<number>();
  let addedCount = 0;
  let removedCount = 0;
  let changedCount = 0;

  const mark = (eventId: string, grade: number): void => {
    if (eventId) affectedEventIds.add(eventId);
    if (Number.isFinite(grade)) affectedGrades.add(grade);
  };

  next.forEach((row) => {
    const before = baseById.get(row.registrationId);
    if (!before) {
      addedCount += 1;
      mark(row.eventId, row.grade);
      return;
    }
    const sameAthlete = before.studentId === row.studentId
      && before.studentName === row.studentNameSnapshot
      && before.genderLabel === rosterGenderLabel(row.genderSnapshot);
    if (!sameAthlete) {
      changedCount += 1;
      mark(row.eventId, row.grade);
    }
  });

  baseline.forEach((row) => {
    if (nextById.has(row.registrationId)) return;
    removedCount += 1;
    mark(row.eventId, row.grade);
  });

  const totalCount = addedCount + removedCount + changedCount;
  return {
    addedCount,
    removedCount,
    changedCount,
    totalCount,
    hasChanges: totalCount > 0,
    affectedEventIds: [...affectedEventIds].sort(),
    affectedGrades: [...affectedGrades].sort((left, right) => left - right),
  };
}

/** 変わった競技を含むページの位置。ここだけを書き直す。 */
export function selectAffectedRosterPages(
  pages: EventRosterPage[], affectedEventIds: Iterable<string>,
): number[] {
  const affected = new Set(affectedEventIds);
  const result: number[] = [];
  pages.forEach((page, index) => {
    if (page.events.some((event) => affected.has(event.eventId))) result.push(index);
  });
  return result;
}

/**
 * 書き直すシートが多いときは、複製して直すより最初から作り直したほうが速く、
 * 出来上がりも読みやすい。3分の2以上を書き直すなら差分をあきらめる。
 */
export function shouldRebuildWholeReport(affectedSheetCount: number, totalSheetCount: number): boolean {
  if (totalSheetCount <= 0) return true;
  return affectedSheetCount * 3 >= totalSheetCount * 2;
}

/** シート名に使えない文字を置き換え、上限内に収める。 */
export function safeRosterSheetName(value: string): string {
  const normalized = value.replace(/[\\/?*[\]:]/g, '-').trim() || '名称未設定';
  return normalized.slice(0, 95);
}

/**
 * 種目別・当日変更用のページに割り当てるシート名を、ページの並び順どおりに決める。
 *
 * 差分作成では、複製した帳票のどのシートがどのページかをこの名前で突き合わせる。
 * 作成時と同じ規則で名前を決めないと対応が取れないため、両方がこの関数を使う。
 */
export function planEventRosterSheetNames(
  pages: EventRosterPage[], reservedNames: Iterable<string> = ['自分の競技を探す'],
): string[] {
  const taken = new Set(reservedNames);
  return pages.map((page) => {
    const base = safeRosterSheetName(eventRosterPageTitle(page));
    const name = ((): string => {
      if (!taken.has(base)) return base;
      const suffix = `_${safeRosterSheetName(page.events[0]?.eventId ?? '')}`;
      const candidate = `${base.slice(0, Math.max(1, 100 - suffix.length))}${suffix}`;
      if (!taken.has(candidate)) return candidate;
      let index = 2;
      while (taken.has(`${candidate.slice(0, 96)}_${index}`)) index += 1;
      return `${candidate.slice(0, 96)}_${index}`;
    })();
    taken.add(name);
    return name;
  });
}

/** クラス別・招集順の学年別シート名。 */
export function gradeRosterSheetName(layout: 'クラス別' | '招集順', grade: number): string {
  return `${layout} ${grade}年`;
}

/**
 * 書き直さないシートに残る見出し（`版：… / 作成：… / 登録：…件`）の、版名と作成日時だけを差し替える。
 * 登録件数は変わっていないシートなので、そのまま残す。
 */
export function replaceRosterMetadataVersion(
  current: string, versionName: string, createdLabel: string,
): string {
  if (!current.startsWith('版：')) return current;
  const head = `版：${versionName} / 作成：${createdLabel}`;
  const index = current.indexOf(' / 登録：');
  return index < 0 ? head : `${head}${current.slice(index)}`;
}
