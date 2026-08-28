import type {
  EventSetting,
  FormDesignSetting,
  RuleSetting,
  SettingsIssue,
} from '../shared/types';
import { validateRuleExpression } from './rule-expression';

const TARGET_GRADES = new Set(['全学年', '1年', '2年', '3年']);
const EVENT_CATEGORIES = new Set(['男子', '女子', '混合', 'クラス', 'その他']);
const RULE_TARGETS = new Set(['全競技', '個人種目', 'リレー', '指定競技']);
const JUDGMENTS = new Set(['エラー', '警告']);
const JAPANESE_WEEKDAYS = ['日', '月', '火', '水', '木', '金', '土'] as const;

export interface CalendarDateParts {
  year: number;
  month: number;
  day: number;
}

export function parseCalendarDate(value: unknown): CalendarDateParts | undefined {
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: 'Asia/Tokyo', year: 'numeric', month: 'numeric', day: 'numeric',
    }).formatToParts(value);
    const numberPart = (type: Intl.DateTimeFormatPartTypes): number =>
      Number(parts.find((part) => part.type === type)?.value ?? Number.NaN);
    return { year: numberPart('year'), month: numberPart('month'), day: numberPart('day') };
  }
  const match = String(value ?? '').trim().match(/^(\d{4})[/-](\d{1,2})[/-](\d{1,2})/);
  if (!match) return undefined;
  const result = { year: Number(match[1]), month: Number(match[2]), day: Number(match[3]) };
  const date = new Date(Date.UTC(result.year, result.month - 1, result.day));
  if (date.getUTCFullYear() !== result.year || date.getUTCMonth() + 1 !== result.month
    || date.getUTCDate() !== result.day) return undefined;
  return result;
}

export function formatJapaneseCalendarDate(value: unknown): string {
  const parts = parseCalendarDate(value);
  if (!parts) return '';
  const weekday = JAPANESE_WEEKDAYS[new Date(Date.UTC(parts.year, parts.month - 1, parts.day)).getUTCDay()];
  return `${parts.year}/${String(parts.month).padStart(2, '0')}/${String(parts.day).padStart(2, '0')}(${weekday})`;
}

export interface SettingsValidationResult {
  issues: SettingsIssue[];
  eventWarningCount: number;
  eventErrorCount: number;
  ruleWarningCount: number;
  ruleErrorCount: number;
  formWarningCount: number;
  formErrorCount: number;
}

export interface SettingsValidationContext {
  studentCount: number;
  classCountByGrade: Partial<Record<1 | 2 | 3, number>>;
}

export function validateSettings(
  events: EventSetting[],
  rules: RuleSetting[],
  form: FormDesignSetting,
  context?: SettingsValidationContext,
): SettingsValidationResult {
  const issues: SettingsIssue[] = [];
  const add = (
    category: SettingsIssue['category'], severity: SettingsIssue['severity'],
    targetId: string, rowNumber: number, title: string, instruction: string,
  ): void => { issues.push({ category, severity, targetId, rowNumber, title, instruction }); };

  if (!Number.isInteger(form.year) || form.year < 2000) {
    add('フォーム設計', 'ERROR', '年度', 2, '年度が正しくありません',
      '「フォーム設計」シートの年度に、西暦を半角数字4桁で入力してください（例：2026）。');
  }
  if (!form.normalTitle.trim()) {
    add('フォーム設計', 'ERROR', '通常フォームタイトル', 3, '通常フォームのタイトルが空欄です',
      '「フォーム設計」シートの通常フォームタイトルを入力してください。');
  }
  if (!form.correctionTitle.trim()) {
    add('フォーム設計', 'ERROR', '修正フォームタイトル', 4, '修正フォームのタイトルが空欄です',
      '「フォーム設計」シートの修正フォームタイトルを入力してください。');
  }
  if (!parseCalendarDate(form.deadline)) {
    add('フォーム設計', 'ERROR', '締切', 5, '締切日が正しくありません',
      '「フォーム設計」シートの締切セルをクリックし、カレンダーから日付を選んでください。例：2026/09/13(日)');
  }
  if (!form.loginRequired) {
    add('フォーム設計', 'ERROR', 'ログイン必須', 7, '回答者のGoogleログインが無効です',
      'Gmailアカウントで運用する場合も、回答者メールを記録するため「ログイン必須」にチェックを入れてください。');
  }

  const eventIds = new Map<string, number[]>();
  const displayOrders = new Map<number, string[]>();
  events.forEach((event, index) => {
    const row = event.rowNumber ?? index + 2;
    const id = event.eventId.trim();
    const rows = eventIds.get(id) ?? [];
    rows.push(row);
    eventIds.set(id, rows);
    if (!id) add('競技設定', 'ERROR', `行${row}`, row, 'event_idが空欄です',
      `「競技設定」シートの${row}行目に、年度内で重複しないIDを入力してください（例：E001）。`);
    if (!event.eventName.trim()) add('競技設定', 'ERROR', id || `行${row}`, row, '競技名が空欄です',
      `「競技設定」シートの${row}行目に、フォームへ表示する競技名を入力してください。`);
    if (!TARGET_GRADES.has(event.targetGrade)) add('競技設定', 'ERROR', id || `行${row}`, row, '対象学年を確認してください',
      `「競技設定」シートの${row}行目で、対象学年を「全学年」「1年」「2年」「3年」のいずれかにしてください。`);
    if (!EVENT_CATEGORIES.has(event.category)) add('競技設定', 'ERROR', id || `行${row}`, row, '区分を確認してください',
      `「競技設定」シートの${row}行目で、区分を男子・女子・混合・クラス・その他から選んでください。`);
    if (event.enabled && (!Number.isInteger(event.requiredCount) || event.requiredCount <= 0)) {
      add('競技設定', 'ERROR', id || `行${row}`, row, '必要人数は1以上の整数にしてください',
        `「競技設定」シートの${row}行目に、必要人数を半角数字で入力してください（例：2）。`);
    }
    if (event.enabled && event.year !== form.year) add('競技設定', 'WARNING', id || `行${row}`, row, 'フォーム年度と競技の年度が異なります',
      `現在のフォーム年度は${form.year}年度です。${row}行目を今年度に直すか、「有効」をFALSEにしてください。`);
    if (event.enabled) {
      const ids = displayOrders.get(event.displayOrder) ?? [];
      ids.push(id || `行${row}`);
      displayOrders.set(event.displayOrder, ids);
    }
  });
  for (const [id, rows] of eventIds) {
    if (id && rows.length > 1) rows.forEach((row) => add('競技設定', 'ERROR', id, row, 'event_idが重複しています',
      `「競技設定」シートで${id}が複数回使われています。年度内で異なるIDにしてください。`));
  }
  for (const [order, ids] of displayOrders) {
    if (ids.length > 1) add('競技設定', 'WARNING', ids.join(','), 0, `表示順「${order}」が重複しています`,
      `「競技設定」シートの表示順を確認し、競技ごとに異なる半角数字を入力してください。対象：${ids.join('、')}`);
  }
  if (!events.some((event) => event.enabled && event.year === form.year)) {
    add('競技設定', 'ERROR', '有効な競技', 0, 'フォームに表示できる競技がありません',
      `「競技設定」シートで${form.year}年度の競技を確認し、フォームへ出す競技の「有効」にチェックを入れてください。`);
  }
  if (context && context.studentCount > 0) {
    const registrationCapacity = calculateRegistrationCapacity(events, form.year, context.classCountByGrade);
    if (registrationCapacity < context.studentCount) {
      const shortage = context.studentCount - registrationCapacity;
      add('競技設定', 'WARNING', '合計人数', 0,
        `競技で登録できる合計人数が、生徒マスターより${shortage}人少なくなっています`,
        `現在の登録枠は合計${registrationCapacity}人分、生徒マスターは${context.studentCount}人です。全員が少なくとも1競技へ出る運用の場合は、「競技設定」シートの必要人数・対象学年・有効のチェックを確認してください。全員参加を求めない場合は、警告を確認したうえで下書きを作成できます。`);
    } else if (registrationCapacity > context.studentCount) {
      const surplus = registrationCapacity - context.studentCount;
      add('競技設定', 'WARNING', '合計人数', 0,
        `競技参加に必要な合計人数が、生徒マスターより${surplus}人多くなっています`,
        `現在の登録枠は合計${registrationCapacity}人分、生徒マスターは${context.studentCount}人です。同じ生徒が複数の競技へ出る予定なら、この警告を確認したうえで下書きを作成できます。1人1競技を想定している場合は、「競技設定」シートの必要人数・対象学年・有効のチェックを確認してください。`);
    }
  }

  const knownEventIds = new Set(events.map((event) => event.eventId.trim()).filter(Boolean));
  const ruleIds = new Set<string>();
  rules.forEach((rule, index) => {
    const row = rule.rowNumber ?? index + 2;
    const id = rule.ruleId.trim();
    if (!hasRuleInput(rule)) return;
    if (!id) add('ルール設定', 'ERROR', `行${row}`, row, 'rule_idが空欄です',
      `「ルール設定」シートの${row}行目にルールIDを入力してください（例：R001）。`);
    else if (ruleIds.has(id)) add('ルール設定', 'ERROR', id, row, 'rule_idが重複しています',
      `「ルール設定」シートで${id}が複数回使われています。異なるIDにしてください。`);
    ruleIds.add(id);
    if (!rule.enabled) return;
    if (!rule.ruleName.trim()) add('ルール設定', 'ERROR', id || `行${row}`, row, 'ルール名が空欄です',
      `「ルール設定」シートの${row}行目に、画面へ表示するルール名を入力してください。`);
    if (!RULE_TARGETS.has(rule.target)) add('ルール設定', 'ERROR', id || `行${row}`, row, 'ルールの対象を確認してください',
      `「ルール設定」シートの${row}行目で、対象を選択肢から選んでください。`);
    if (!JUDGMENTS.has(rule.judgment)) add('ルール設定', 'ERROR', id || `行${row}`, row, '判定を確認してください',
      `「ルール設定」シートの${row}行目で、判定を「エラー」または「警告」にしてください。`);
    const expression = (rule.expression ?? '').trim();
    if (expression) {
      const expressionError = validateRuleExpression(expression);
      if (expressionError) add('ルール設定', 'ERROR', id || `行${row}`, row, '論理式を確認してください',
        `「ルール設定」シートの${row}行目の論理式を直してください。${expressionError}`);
    } else if (!rule.condition.trim()) {
      add('ルール設定', 'ERROR', id || `行${row}`, row, '論理式が空欄です',
        `「ルール設定」シートの${row}行目に、TRUEまたはFALSEになる論理式を入力してください。例：M >= 2 && F >= 2`);
    }
    if (rule.target === '指定競技') {
      if (splitEventIds(rule.targetEventIds).length === 0) {
        add('ルール設定', 'ERROR', id || `行${row}`, row, '対象競技が選ばれていません',
          `「ルール設定」シートの${row}行目で、このルールを適用する競技に1つ以上チェックを入れてください。`);
      }
      const missing = splitEventIds(rule.targetEventIds).filter((eventId) => !knownEventIds.has(eventId));
      if (missing.length) add('ルール設定', 'ERROR', id || `行${row}`, row, '指定された競技IDが見つかりません',
        `「ルール設定」シートの${row}行目にある対象event_idを確認してください。見つからないID：${missing.join('、')}`);
    }
  });

  const count = (category: SettingsIssue['category'], severity: SettingsIssue['severity']): number =>
    issues.filter((issue) => issue.category === category && issue.severity === severity).length;
  return {
    issues,
    eventWarningCount: count('競技設定', 'WARNING'), eventErrorCount: count('競技設定', 'ERROR'),
    ruleWarningCount: count('ルール設定', 'WARNING'), ruleErrorCount: count('ルール設定', 'ERROR'),
    formWarningCount: count('フォーム設計', 'WARNING'), formErrorCount: count('フォーム設計', 'ERROR'),
  };
}

export function calculateRegistrationCapacity(
  events: EventSetting[],
  year: number,
  classCountByGrade: SettingsValidationContext['classCountByGrade'],
): number {
  const allClassCount = (classCountByGrade[1] ?? 0) + (classCountByGrade[2] ?? 0) + (classCountByGrade[3] ?? 0);
  return events
    .filter((event) => event.enabled && event.year === year && Number.isInteger(event.requiredCount) && event.requiredCount > 0)
    .reduce((total, event) => {
      const classCount = event.targetGrade === '全学年'
        ? allClassCount
        : classCountByGrade[Number(event.targetGrade.slice(0, 1)) as 1 | 2 | 3] ?? 0;
      return total + event.requiredCount * classCount;
    }, 0);
}

export function resolveRuleTargetSelection(
  selectedEventIds: readonly string[],
  availableEventIds: readonly string[],
): Pick<RuleSetting, 'target' | 'targetEventIds'> {
  const available = new Set(availableEventIds);
  const selected = [...new Set(selectedEventIds.filter((eventId) => available.has(eventId)))];
  return {
    target: selected.length > 0 && selected.length === available.size ? '全競技' : '指定競技',
    targetEventIds: selected.join(','),
  };
}

export function splitEventIds(value: string): string[] {
  return value.split(',').map((part) => part.trim()).filter(Boolean);
}

export function appliesToGrade(event: EventSetting, grade: number): boolean {
  return event.targetGrade === '全学年' || event.targetGrade === `${grade}年`;
}

/** ルール設定の中で、利用者が直接入力する列の位置。 */
const RULE_INPUT_COLUMN_INDEXES = [0, 2, 7, 8, 9, 10] as const;
const RULE_ENABLED_COLUMN_INDEX = 1;

/**
 * ルール設定の1行が利用中かを判定する。
 * 対象・対象event_idは対象競技チェック欄から自動生成され、
 * 旧条件・旧上限は非表示の互換列なので、これらだけでは入力済み行としない。
 */
export function hasRuleConfigInput(row: readonly unknown[]): boolean {
  const enabled = row[RULE_ENABLED_COLUMN_INDEX];
  if (enabled === true || String(enabled ?? '').toUpperCase() === 'TRUE') return true;
  return hasConfigInput(RULE_INPUT_COLUMN_INDEXES.map((index) => row[index]), []);
}

/** 読み取り済みルールが空白行でないかを、hasRuleConfigInputと同じ列で判定する。 */
export function hasRuleInput(rule: RuleSetting): boolean {
  return hasRuleConfigInput([
    rule.ruleId, rule.enabled, rule.ruleName, '', '', '', '',
    rule.judgment, rule.displayMessage, rule.note, rule.expression ?? '',
  ]);
}

/** 未使用行のチェックボックスFALSEを入力扱いにしない。 */
export function hasConfigInput(row: readonly unknown[], checkboxIndexes: readonly number[]): boolean {
  const checkboxColumns = new Set(checkboxIndexes);
  return row.some((value, index) =>
    !checkboxColumns.has(index) && value !== '' && value !== null && value !== undefined,
  );
}

export interface CorrectionSlotDefinition {
  index: number;
  slot: string;
  label: string;
  stateFieldKey: string;
  studentIdFieldKey: string;
  nameFieldKey: string;
}

export function buildCorrectionSlotDefinitions(event: EventSetting): CorrectionSlotDefinition[] {
  return Array.from({ length: Math.max(0, event.requiredCount) }, (_, offset) => {
    const index = offset + 1;
    const slot = String(index).padStart(2, '0');
    return {
      index,
      slot,
      label: event.hasOrder ? `第${index}走者` : `${index}人目`,
      stateFieldKey: `correction_${event.eventId}_slot${slot}_state`,
      studentIdFieldKey: `correction_${event.eventId}_slot${slot}_student_id`,
      nameFieldKey: `correction_${event.eventId}_slot${slot}_name`,
    };
  });
}

export const FORM_BUILD_BATCH_MAX_CHUNKS = 8;
export const FORM_BUILD_BATCH_BUDGET_MS = 120_000;

export function shouldProcessNextFormBuildChunk(
  completedChunks: number,
  elapsedMs: number,
  maxChunks = FORM_BUILD_BATCH_MAX_CHUNKS,
  budgetMs = FORM_BUILD_BATCH_BUDGET_MS,
): boolean {
  return completedChunks < maxChunks && elapsedMs < budgetMs;
}

export type FormBuildProgressPhase = 'NORMAL_BASE' | 'NORMAL_EVENTS' | 'NORMAL_FINAL'
  | 'CORRECTION_BASE' | 'CORRECTION_EVENTS' | 'CORRECTION_FINAL' | 'FINALIZE';

export interface FormBuildProgressInput {
  phase: FormBuildProgressPhase;
  eventIds: string[];
  normalGrade: number;
  normalEventIndex: number;
  normalPageCount: number;
  correctionEventIndex: number;
}

export function calculateFormBuildProgress(
  input: FormBuildProgressInput,
  allEvents: EventSetting[],
): { completed: number; total: number; percent: number } {
  const eventById = new Map(allEvents.map((event) => [event.eventId, event]));
  const events = input.eventIds.map((id) => eventById.get(id))
    .filter((event): event is EventSetting => Boolean(event));
  const normalCounts = [1, 2, 3].map((grade) =>
    events.filter((event) => appliesToGrade(event, grade)).length);
  const normalEventTotal = normalCounts.reduce((sum, count) => sum + count, 0);
  const total = 1 + 3 + normalEventTotal + 1 + 1 + events.length + 1;
  const normalComplete = 1 + 3 + normalEventTotal;
  let completed = 0;
  if (input.phase === 'NORMAL_EVENTS') {
    const priorGradeEvents = normalCounts.slice(0, Math.max(0, input.normalGrade - 1))
      .reduce((sum, count) => sum + count, 0);
    completed = 1 + input.normalPageCount + priorGradeEvents + input.normalEventIndex;
  } else if (input.phase === 'NORMAL_FINAL') {
    completed = normalComplete;
  } else if (input.phase === 'CORRECTION_BASE') {
    completed = normalComplete + 1;
  } else if (input.phase === 'CORRECTION_EVENTS') {
    completed = normalComplete + 2 + input.correctionEventIndex;
  } else if (input.phase === 'CORRECTION_FINAL') {
    completed = normalComplete + 2 + events.length;
  } else if (input.phase === 'FINALIZE') {
    completed = total;
  }
  completed = Math.max(0, Math.min(total, completed));
  return { completed, total, percent: total > 0 ? Math.round(completed / total * 100) : 0 };
}
