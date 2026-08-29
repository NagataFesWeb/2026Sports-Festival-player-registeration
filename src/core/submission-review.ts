import type {
  DisplayGender,
  IssueHighlight,
  MultiEventStudent,
  ReviewSlot,
  SameEventDuplicate,
  Severity,
  SubmissionItem,
  SubmissionReview,
  ValidationIssue,
} from '../shared/types';
import { normalizeStudentId } from './normalization';

const DUPLICATE_BADGES = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';

function displayGender(item: SubmissionItem): DisplayGender {
  return item.masterGender === 'M' || item.masterGender === 'F' ? item.masterGender : 'U';
}

function registeredWithStudentId(items: SubmissionItem[]): Array<SubmissionItem & { studentId: string }> {
  return items
    .filter((item) => item.registrationState === 'REGISTER')
    .map((item) => ({ ...item, studentId: normalizeStudentId(item.studentIdInput) }))
    .filter((item) => item.studentId !== '');
}

function toSlot(item: SubmissionItem): ReviewSlot {
  return {
    submissionItemId: item.submissionItemId,
    eventName: item.eventName,
    slotName: item.slotName,
  };
}

/**
 * 同じ競技の中で同じ学籍番号が2回以上登録されている組を返す。
 * 学籍番号だけで同一人物を判定し、同姓同名の別生徒はまとめない。
 */
export function sameEventDuplicates(items: SubmissionItem[]): SameEventDuplicate[] {
  const groups = new Map<string, Array<SubmissionItem & { studentId: string }>>();
  registeredWithStudentId(items).forEach((item) => {
    const key = `${item.eventId}:${item.studentId}`;
    const group = groups.get(key) ?? [];
    group.push(item);
    groups.set(key, group);
  });
  const duplicates: SameEventDuplicate[] = [];
  groups.forEach((group, key) => {
    const first = group[0];
    if (group.length < 2 || !first) return;
    duplicates.push({
      duplicateKey: key,
      badgeLabel: '',
      studentId: first.studentId,
      name: first.masterName ?? '',
      gender: displayGender(first),
      eventId: first.eventId,
      eventName: first.eventName,
      count: group.length,
      slots: group.map(toSlot),
    });
  });
  return duplicates
    .sort((a, b) => a.eventName.localeCompare(b.eventName) || a.studentId.localeCompare(b.studentId))
    .map((duplicate, index) => ({
      ...duplicate,
      badgeLabel: `重複${DUPLICATE_BADGES[index] ?? String(index + 1)}`,
    }));
}

/** 競技をまたいで2競技以上に登録されている生徒を返す。 */
export function multiEventStudents(items: SubmissionItem[]): MultiEventStudent[] {
  const groups = new Map<string, Array<SubmissionItem & { studentId: string }>>();
  registeredWithStudentId(items).forEach((item) => {
    const group = groups.get(item.studentId) ?? [];
    group.push(item);
    groups.set(item.studentId, group);
  });
  const students: MultiEventStudent[] = [];
  groups.forEach((group, studentId) => {
    const eventIds = new Set(group.map((item) => item.eventId));
    const first = group[0];
    if (eventIds.size < 2 || !first) return;
    students.push({
      studentId,
      name: first.masterName ?? '',
      gender: displayGender(first),
      eventCount: eventIds.size,
      slots: group.map(toSlot),
    });
  });
  return students.sort((a, b) => a.studentId.localeCompare(b.studentId));
}

/** 特定の選手枠ではなく申請全体に対する検査結果。枠へは色を付けない。 */
const SUBMISSION_LEVEL_ISSUE_CODES = new Set([
  'MULTIPLE_INITIAL_SUBMISSIONS',
  'PROXY_SUBMISSION',
  'CORRECTION_WHILE_CLOSED',
  'RULE_EXPRESSION_INVALID',
]);

/**
 * `locationText`から競技名の候補を取り出す。
 * `validateSubmission`は競技名を`、`で連結し、枠を並べるときだけ`競技名 / 枠名`の形にする。
 */
function candidateEventNames(locationText: string): string[] {
  return String(locationText ?? '')
    .split('、')
    .flatMap((segment) => [segment, segment.split(' / ')[0] ?? ''])
    .map(normalizeDisplayName)
    .filter((name) => name !== '');
}

/**
 * 競技名・枠名の照合用に前後の空白を落とす。
 * 設定シートの競技名は末尾に空白が入っていることがあり、
 * `locationText`側だけを整えると競技を見つけられなくなる。
 */
function normalizeDisplayName(value: string): string {
  return String(value ?? '').trim();
}

/**
 * `競技名 / 枠名、枠名`の形の`locationText`から、実際の選手枠を探す。
 * 欠員警告のように1件で複数の枠を指す検査結果を、枠単位で示すために使う。
 */
function slotItemIds(locationText: string, items: SubmissionItem[]): string[] {
  const separator = String(locationText ?? '').indexOf(' / ');
  if (separator < 0) return [];
  const eventName = normalizeDisplayName(locationText.slice(0, separator));
  const slotNames = new Set(locationText.slice(separator + 3).split('、')
    .map(normalizeDisplayName).filter((name) => name !== ''));
  if (eventName === '' || slotNames.size === 0) return [];
  const matched = items
    .filter((item) => normalizeDisplayName(item.eventName) === eventName
      && slotNames.has(normalizeDisplayName(item.slotName)))
    .map((item) => item.submissionItemId);
  return matched.length === slotNames.size ? matched : [];
}

/**
 * 検査結果を、画面で色を付ける枠・競技へ対応付ける。
 *
 * - 申請項目に結び付く検査結果はその枠だけを示す。
 * - 論理式ルール（`RULE_EXPRESSION_FALSE`）や欠員警告は枠を1つに定められないため、
 *   `validateSubmission`が`locationText`へ入れた競技名から競技単位で示す。
 * - どちらにも当てはまらない検査結果は申請全体の扱いとし、枠へは色を付けない。
 */
export function issueHighlights(
  items: SubmissionItem[],
  issues: ValidationIssue[],
): IssueHighlight[] {
  const eventIdsByName = new Map<string, string[]>();
  items.forEach((item) => {
    const key = normalizeDisplayName(item.eventName);
    const ids = eventIdsByName.get(key) ?? [];
    if (!ids.includes(item.eventId)) ids.push(item.eventId);
    eventIdsByName.set(key, ids);
  });
  const itemIds = new Set(items.map((item) => item.submissionItemId));
  const numbers: Record<Severity, number> = { WARNING: 0, ERROR: 0 };
  return issues.map((issue) => {
    numbers[issue.severity] += 1;
    const submissionLevel = SUBMISSION_LEVEL_ISSUE_CODES.has(issue.issueCode);
    // 検査が「直す枠」を絞り込めた場合は、それを最優先で使う。
    const relatedIds = String(issue.relatedItemIds ?? '').split(',')
      .map((value) => value.trim())
      .filter((value) => value !== '' && itemIds.has(value));
    const submissionItemIds = !submissionLevel && issue.submissionItemId
      && itemIds.has(issue.submissionItemId)
      ? [issue.submissionItemId]
      : relatedIds;
    const slotIds = submissionLevel || submissionItemIds.length > 0
      ? []
      : slotItemIds(issue.locationText, items);
    // 論理式ルールは「直す枠」と「判断に使った競技」の両方が要る。
    // 枠だけだと周りの登録が見えず、競技だけだとどこを直すか分からない。
    const needsEventContext = issue.issueCode === 'RULE_EXPRESSION_FALSE';
    const eventIds = submissionLevel
      || (!needsEventContext && (submissionItemIds.length > 0 || slotIds.length > 0))
      ? []
      : candidateEventNames(issue.locationText)
        .flatMap((name) => eventIdsByName.get(name) ?? []);
    return {
      issueId: issue.issueId,
      severity: issue.severity,
      displayNumber: numbers[issue.severity],
      submissionItemIds: submissionItemIds.length > 0 ? submissionItemIds : slotIds,
      eventIds: [...new Set(eventIds)],
    };
  });
}

export function reviewSubmission(
  items: SubmissionItem[],
  issues: ValidationIssue[],
): SubmissionReview {
  return {
    sameEventDuplicates: sameEventDuplicates(items),
    multiEventStudents: multiEventStudents(items),
    issueHighlights: issueHighlights(items, issues),
  };
}
