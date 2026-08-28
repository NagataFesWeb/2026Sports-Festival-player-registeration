import {
  EVENT_SETTING_HEADERS,
  FORM_DESIGN_HEADERS,
  FORM_REGISTRY_HEADERS,
  RAW_FORM_RESPONSE_HEADERS,
  RULE_EVENT_TARGET_HEADER_PREFIX,
  RULE_SETTING_HEADERS,
  SETTINGS_ISSUE_HEADERS,
  SETTINGS_CHANGE_HISTORY_HEADERS,
  PUBLIC_SETTINGS_SNAPSHOT_HEADERS,
  SHEETS,
} from '../shared/constants';
import type {
  EventSetting,
  FormDesignSetting,
  RuleSetting,
  SettingsIssue,
  FormRegistryRow,
} from '../shared/types';
import {
  formatJapaneseCalendarDate,
  hasConfigInput,
  hasRuleConfigInput,
  parseCalendarDate,
  resolveRuleTargetSelection,
  splitEventIds,
} from '../core/settings';

type Value = string | number | boolean | Date;
type Sheet = GoogleAppsScript.Spreadsheet.Sheet;

const FORM_KEYS = {
  year: '年度', normalTitle: '通常フォームタイトル', correctionTitle: '修正フォームタイトル',
  deadline: '締切', sendResponseCopy: '回答コピー送信', loginRequired: 'ログイン必須',
  gradeBranching: '学年別分岐', normalResubmission: '通常フォーム再提出',
  applyBeforeApproval: '承認前反映', formStatus: 'フォーム状態', normalFormId: '通常フォームID',
  correctionFormId: '修正フォームID', normalEditUrl: '通常フォーム編集URL',
  correctionEditUrl: '修正フォーム編集URL',
  formsFolderId: 'フォーム保存フォルダID', formsFolderUrl: 'フォーム保存フォルダURL',
} as const;

function book(): GoogleAppsScript.Spreadsheet.Spreadsheet {
  const value = SpreadsheetApp.getActiveSpreadsheet();
  if (!value) throw new Error('管理用スプレッドシートを開いてから、もう一度操作してください。');
  return value;
}

function ensure(name: string, headers: readonly string[]): Sheet {
  const sheet = book().getSheetByName(name) ?? book().insertSheet(name);
  if (name === SHEETS.ruleSettings && sheet.getLastColumn() >= 11) {
    const oldEleventhHeader = sheet.getRange(1, 11).getDisplayValue();
    if (oldEleventhHeader.startsWith(RULE_EVENT_TARGET_HEADER_PREFIX)) {
      // 論理式列の追加前はK列から対象競技チェック欄だった。列を挿入して選択を保持する。
      sheet.insertColumnBefore(11);
    }
  }
  if (headers.length > 0) {
    sheet.getRange(1, 1, 1, headers.length).setValues([[...headers]]).setFontWeight('bold');
    sheet.setFrozenRows(1);
  }
  return sheet;
}

export function ensureSettingsSheets(): void {
  ensure(SHEETS.settingsDashboard, []);
  ensure(SHEETS.eventSettings, EVENT_SETTING_HEADERS);
  ensure(SHEETS.formDesign, FORM_DESIGN_HEADERS);
  ensure(SHEETS.formRegistry, FORM_REGISTRY_HEADERS);
  ensure(SHEETS.ruleSettings, RULE_SETTING_HEADERS);
  ensure(SHEETS.settingsIssues, SETTINGS_ISSUE_HEADERS);
  ensure(SHEETS.rawFormResponses, RAW_FORM_RESPONSE_HEADERS);
  ensure(SHEETS.settingsChangeHistory, SETTINGS_CHANGE_HISTORY_HEADERS);
  ensure(SHEETS.publicSettingsSnapshot, PUBLIC_SETTINGS_SNAPSHOT_HEADERS).hideSheet();
}

export function seedDefaultSettings(): void {
  ensureSettingsSheets();
  const events = book().getSheetByName(SHEETS.eventSettings)!;
  if (events.getLastRow() < 2) {
    events.getRange(2, 1, 4, EVENT_SETTING_HEADERS.length).setValues([
      [2026, 'E001', true, '全学年', '100m走', '男子', 2, true, false, 10, 10, ''],
      [2026, 'E002', true, '全学年', '100m走', '女子', 2, true, false, 20, 20, ''],
      [2026, 'E003', true, '1年', '学年競技', '混合', 8, false, true, 30, 30, '疑似設定'],
      [2026, 'E004', true, '2年', '学年競技', '混合', 10, false, true, 40, 40, '疑似設定'],
    ]);
  }
  const rules = book().getSheetByName(SHEETS.ruleSettings)!;
  if (rules.getLastRow() < 2) {
    rules.getRange(2, 1, 9, RULE_SETTING_HEADERS.length).setValues([
      ['R001', true, '存在しない学籍番号は登録不可', '全競技', '', '生徒マスター存在確認', 0, 'エラー', '学籍番号が確認できません', '', ''],
      ['R002', true, '学籍番号と氏名が異なる場合は確認', '全競技', '', '氏名照合', 0, '警告', '氏名の表記を確認してください', '', ''],
      ['R003', true, '同一競技内の重複登録は禁止', '全競技', '', '同一生徒の重複', 1, 'エラー', '同じ選手が重複しています', '', ''],
      ['R004', true, '必要人数に足りない場合は確認', '全競技', '', '必要人数', 0, 'エラー', '必要な選手枠を確認してください', '', ''],
      ['R005', false, '1人あたりの出場数上限', '全競技', '', '同一生徒の登録数', 2, 'エラー', '同じ生徒が登録上限を超えています', '互換用見本', ''],
      ['R006', false, 'リレー重複制限', 'リレー', '', '同一生徒の登録数', 1, 'エラー', 'リレーの重複を確認してください', '互換用見本', ''],
      ['R007', false, '男子のみ', '指定競技', '', '', '', 'エラー', '男子のみ登録できます', '対象競技を選んで有効にします', 'F == 0 && UNKNOWN == 0'],
      ['R008', false, '女子のみ', '指定競技', '', '', '', 'エラー', '女子のみ登録できます', '対象競技を選んで有効にします', 'M == 0 && UNKNOWN == 0'],
      ['R009', false, '男女各2名以上', '指定競技', '', '', '', 'エラー', '男子・女子を各2名以上登録してください', '対象競技を選んで有効にします', 'M >= 2 && F >= 2'],
    ]);
  }
  const design = book().getSheetByName(SHEETS.formDesign)!;
  if (design.getLastRow() < 2) writeFormDesign(defaultFormDesign());
  syncRuleEventCheckboxes();
  applySettingsValidations();
}

function targetEventIdFromHeader(header: string): string {
  if (!header.startsWith(RULE_EVENT_TARGET_HEADER_PREFIX)) return '';
  return header.slice(RULE_EVENT_TARGET_HEADER_PREFIX.length).split('｜')[0]?.trim() ?? '';
}

function targetEventHeader(event: EventSetting): string {
  return `${RULE_EVENT_TARGET_HEADER_PREFIX}${event.eventId}｜${event.eventName}`;
}

function legacyTargetIncludesEvent(row: Value[], event: EventSetting): boolean {
  const target = text(row[3]);
  if (target === '全競技') return true;
  if (target === '指定競技') return splitEventIds(text(row[4])).includes(event.eventId);
  if (target === 'リレー') return event.eventName.includes('リレー');
  if (target === '個人種目') return !event.eventName.includes('リレー') && event.category !== 'クラス';
  return false;
}

/** 競技設定の有効競技を、ルール設定の複数選択チェックボックス列へ同期する。 */
export function syncRuleEventCheckboxes(): void {
  const sheet = book().getSheetByName(SHEETS.ruleSettings) ?? ensure(SHEETS.ruleSettings, RULE_SETTING_HEADERS);
  const design = readFormDesign();
  const events = readEventSettings()
    .filter((event) => event.enabled && event.year === design.year && event.eventId.trim())
    .sort((left, right) => left.displayOrder - right.displayOrder || left.eventId.localeCompare(right.eventId));
  const oldWidth = Math.max(sheet.getLastColumn(), RULE_SETTING_HEADERS.length);
  const oldHeaders = sheet.getRange(1, 1, 1, oldWidth).getDisplayValues()[0] ?? [];
  const oldEventColumn = new Map<string, number>();
  oldHeaders.forEach((header, index) => {
    const eventId = targetEventIdFromHeader(header);
    if (eventId) oldEventColumn.set(eventId, index);
  });
  const rowCount = Math.max(0, sheet.getLastRow() - 1);
  const oldRows = rowCount > 0
    ? sheet.getRange(2, 1, rowCount, oldWidth).getValues() as Value[][]
    : [];
  const eventIds = events.map((event) => event.eventId);
  const newRows = oldRows.map((oldRow) => {
    const selections = events.map((event) => {
      const oldIndex = oldEventColumn.get(event.eventId);
      return oldIndex == null ? legacyTargetIncludesEvent(oldRow, event) : bool(oldRow[oldIndex]);
    });
    const selectedIds = events.filter((_, index) => selections[index]).map((event) => event.eventId);
    const resolved = resolveRuleTargetSelection(selectedIds, eventIds);
    const fixed = Array.from({ length: RULE_SETTING_HEADERS.length }, (_, index) => oldRow[index] ?? '');
    const configured = hasRuleConfigInput(oldRow) || selections.some(Boolean);
    // 空白行へ互換列の「指定競技」を書くと入力済み行に見えてしまうため、空欄のまま保つ。
    fixed[3] = configured ? resolved.target : '';
    fixed[4] = configured ? resolved.targetEventIds : '';
    return [...fixed, ...selections];
  });
  const headers = [...RULE_SETTING_HEADERS, ...events.map(targetEventHeader)];
  sheet.getRange(1, 1, 1, headers.length).setValues([headers]).setFontWeight('bold');
  if (newRows.length > 0) sheet.getRange(2, 1, newRows.length, headers.length).setValues(newRows);
  if (oldWidth > headers.length) {
    sheet.getRange(1, headers.length + 1, Math.max(1, sheet.getMaxRows()), oldWidth - headers.length).clear();
  }
  if (events.length > 0) {
    const checkboxRows = Math.max(sheet.getMaxRows() - 1, 1);
    sheet.getRange(2, RULE_SETTING_HEADERS.length + 1, checkboxRows, events.length)
      .setDataValidation(SpreadsheetApp.newDataValidation().requireCheckbox().build())
      .setHorizontalAlignment('center');
    events.forEach((event, index) => {
      const column = RULE_SETTING_HEADERS.length + index + 1;
      sheet.setColumnWidth(column, 150);
      sheet.getRange(1, column).setNote(`「${event.eventName}」へこのルールを適用する場合にチェックします。event_id: ${event.eventId}`);
    });
    sheet.getRange(1, RULE_SETTING_HEADERS.length + 1, 1, events.length)
      .setBackground('#d9ead3').setWrap(true).setVerticalAlignment('middle');
  }
  sheet.hideColumns(4, 2);
  sheet.hideColumns(6, 2);
  sheet.setFrozenColumns(3);
}

export function defaultFormDesign(): FormDesignSetting {
  return {
    year: 2026,
    normalTitle: '2026年度 体育祭 選手登録フォーム',
    correctionTitle: '2026年度 体育祭 選手登録 修正申請フォーム',
    deadline: '2026/09/05(土)',
    sendResponseCopy: true,
    loginRequired: true,
    gradeBranching: true,
    normalResubmission: '禁止',
    applyBeforeApproval: '禁止',
    formStatus: '未作成',
    normalFormId: '', correctionFormId: '', normalEditUrl: '', correctionEditUrl: '',
    formsFolderId: '', formsFolderUrl: '',
  };
}

function applySettingsValidations(): void {
  const events = book().getSheetByName(SHEETS.eventSettings)!;
  EVENT_SETTING_HEADERS.forEach((header, index) => events.getRange(1, index + 1).setNote(eventHeaderNote(header)));
  events.autoResizeColumns(1, EVENT_SETTING_HEADERS.length);
  events.setColumnWidth(5, 180); events.setColumnWidth(12, 220);
  const rowCount = Math.max(events.getMaxRows() - 1, 1);
  events.getRange(2, 3, rowCount).setDataValidation(SpreadsheetApp.newDataValidation().requireCheckbox().build());
  events.getRange(2, 4, rowCount).setDataValidation(SpreadsheetApp.newDataValidation().requireValueInList(['全学年', '1年', '2年', '3年'], true).build());
  events.getRange(2, 6, rowCount).setDataValidation(SpreadsheetApp.newDataValidation().requireValueInList(['男子', '女子', '混合', 'クラス', 'その他'], true).build());
  events.getRange(2, 8, rowCount, 2).setDataValidation(SpreadsheetApp.newDataValidation().requireCheckbox().build());
  const rules = book().getSheetByName(SHEETS.ruleSettings)!;
  RULE_SETTING_HEADERS.forEach((header, index) => rules.getRange(1, index + 1).setNote(ruleHeaderNote(header)));
  rules.autoResizeColumns(1, RULE_SETTING_HEADERS.length);
  rules.setColumnWidth(3, 220); rules.setColumnWidth(9, 260); rules.setColumnWidth(10, 220);
  rules.setColumnWidth(11, 260);
  const ruleRows = Math.max(rules.getMaxRows() - 1, 1);
  rules.getRange(2, 2, ruleRows).setDataValidation(SpreadsheetApp.newDataValidation().requireCheckbox().build());
  rules.getRange(2, 4, ruleRows).setDataValidation(SpreadsheetApp.newDataValidation().requireValueInList(['全競技', '個人種目', 'リレー', '指定競技'], true).build());
  rules.getRange(2, 8, ruleRows).setDataValidation(SpreadsheetApp.newDataValidation().requireValueInList(['エラー', '警告'], true).build());
  rules.getRange(2, 11, ruleRows).setNumberFormat('@');

  applyFormDesignDeadlineValidation();
}

function applyFormDesignDeadlineValidation(): void {
  book().setSpreadsheetTimeZone('Asia/Tokyo');
  book().setSpreadsheetLocale('ja_JP');
  const design = book().getSheetByName(SHEETS.formDesign)!;
  const designKeys = design.getRange(1, 1, Math.max(1, design.getLastRow()), 1).getDisplayValues().flat();
  const deadlineRow = designKeys.findIndex((key) => key === FORM_KEYS.deadline) + 1;
  if (deadlineRow > 0) {
    const cell = design.getRange(deadlineRow, 2);
    const parts = parseCalendarDate(cell.getValue());
    if (parts && !(cell.getValue() instanceof Date)) {
      cell.setValue(new Date(parts.year, parts.month - 1, parts.day));
    }
    cell.setDataValidation(
      SpreadsheetApp.newDataValidation().requireDate().setAllowInvalid(false)
        .setHelpText('セルをクリックし、カレンダーから締切日を選んでください。時刻は入力しません。').build(),
    ).setNumberFormat('yyyy/mm/dd(ddd)').setNote(
      '日本標準時の日付です。セルをクリックしてカレンダーから選びます。曜日は自動表示されます。',
    );
  }
}

export function prepareFormDesignDeadlineInput(): void {
  applyFormDesignDeadlineValidation();
}

function eventHeaderNote(header: string): string {
  const notes: Record<string, string> = {
    '年度': '対象年度を半角数字4桁で入力します。', 'event_id': '年度内で重複しないIDです。年度途中で変えません。',
    '有効': 'チェックした競技だけフォームへ出します。', '対象学年': '全学年・1年・2年・3年から選びます。',
    '競技名': 'フォームに表示する名前です。', '区分': '男子・女子・混合・クラス・その他から選びます。',
    '必要人数': '各クラスが登録する人数を1以上の半角数字で入力します。', '走順あり': '第1走者のように順番を表示するときチェックします。',
    '欠員許可': '現在調整中を選べるようにするときチェックします。', '招集順': '招集名簿での順番です。',
    '表示順': 'フォームに出す順番です。重複しない数字を使います。', '備考': '担当者向けのメモです。フォームには表示しません。',
  };
  return notes[header] ?? '';
}

function ruleHeaderNote(header: string): string {
  const notes: Record<string, string> = {
    'rule_id': '重複しないルールIDです。', '有効': 'チェックしたルールだけ次回検査に使います。',
    'ルール名': '確認画面に表示する名前です。', '対象': 'ルールを適用する競技の範囲です。',
    '対象event_id': '対象競技のチェックから自動保存されます。',
    '旧条件（互換）': '従来ルール用です。新しいルールでは空欄にします。',
    '旧上限（互換）': '従来ルール用です。新しいルールでは空欄にします。',
    '判定': '論理式がFALSEのとき、エラーは承認不可、警告は確認後に承認できます。',
    '表示メッセージ': '問題が見つかったとき利用者へ表示します。', '備考': '未確定のルールは有効を外し、ここへ理由を残します。',
    '論理式（TRUEなら問題なし）': '例：M >= 2 && F >= 2。TRUEなら問題なし、FALSEなら判定列のエラー・警告になります。',
  };
  return notes[header] ?? '';
}

function rows(sheetName: string, width: number): Value[][] {
  const sheet = book().getSheetByName(sheetName);
  if (!sheet || sheet.getLastRow() < 2) return [];
  return sheet.getRange(2, 1, sheet.getLastRow() - 1, width).getValues() as Value[][];
}

/** シート上の行番号を保ったまま値を読む。未使用行を除外しても行番号がずれない。 */
function numberedRows(sheetName: string, width: number): { row: Value[]; rowNumber: number }[] {
  return rows(sheetName, width).map((row, index) => ({ row, rowNumber: index + 2 }));
}

const text = (value: Value | undefined): string => value == null ? '' : String(value);
const num = (value: Value | undefined): number => value === '' || value == null ? Number.NaN : Number(value);
const bool = (value: Value | undefined): boolean => value === true || String(value).toUpperCase() === 'TRUE';

export function readEventSettings(): EventSetting[] {
  return numberedRows(SHEETS.eventSettings, EVENT_SETTING_HEADERS.length)
    .filter(({ row }) => hasConfigInput(row, [2, 7, 8]))
    .map(({ row, rowNumber }) => ({
    year: num(row[0]), eventId: text(row[1]), enabled: bool(row[2]),
    targetGrade: text(row[3]) as EventSetting['targetGrade'], eventName: text(row[4]),
    category: text(row[5]) as EventSetting['category'], requiredCount: num(row[6]),
    hasOrder: bool(row[7]), vacancyAllowed: bool(row[8]), assemblyOrder: num(row[9]),
    displayOrder: num(row[10]), note: text(row[11]), rowNumber,
  }));
}

export function readRuleSettings(): RuleSetting[] {
  syncRuleEventCheckboxes();
  const sheet = book().getSheetByName(SHEETS.ruleSettings)!;
  const width = sheet.getLastColumn();
  const headers = sheet.getRange(1, 1, 1, width).getDisplayValues()[0] ?? [];
  const availableEventIds = headers.slice(RULE_SETTING_HEADERS.length).map(targetEventIdFromHeader).filter(Boolean);
  return numberedRows(SHEETS.ruleSettings, width)
    .filter(({ row }) => hasRuleConfigInput(row))
    .map(({ row, rowNumber }) => {
      const selectedEventIds = availableEventIds.filter((_, index) =>
        bool(row[RULE_SETTING_HEADERS.length + index]));
      const resolved = resolveRuleTargetSelection(selectedEventIds, availableEventIds);
      return {
        ruleId: text(row[0]), enabled: bool(row[1]), ruleName: text(row[2]),
        target: resolved.target, targetEventIds: resolved.targetEventIds,
        condition: text(row[5]), limit: num(row[6]), judgment: text(row[7]) as RuleSetting['judgment'],
        displayMessage: text(row[8]), note: text(row[9]), expression: text(row[10]), rowNumber,
      };
    });
}

export function readFormDesign(): FormDesignSetting {
  const values = new Map(rows(SHEETS.formDesign, 2).map((row) => [text(row[0]), row[1]]));
  const fallback = defaultFormDesign();
  return {
    year: num(values.get(FORM_KEYS.year)) || fallback.year,
    normalTitle: text(values.get(FORM_KEYS.normalTitle)), correctionTitle: text(values.get(FORM_KEYS.correctionTitle)),
    deadline: formatJapaneseCalendarDate(values.get(FORM_KEYS.deadline)), sendResponseCopy: bool(values.get(FORM_KEYS.sendResponseCopy)),
    loginRequired: bool(values.get(FORM_KEYS.loginRequired)), gradeBranching: bool(values.get(FORM_KEYS.gradeBranching)),
    normalResubmission: text(values.get(FORM_KEYS.normalResubmission)) as FormDesignSetting['normalResubmission'],
    applyBeforeApproval: '禁止', formStatus: (text(values.get(FORM_KEYS.formStatus)) || '未作成') as FormDesignSetting['formStatus'],
    normalFormId: text(values.get(FORM_KEYS.normalFormId)), correctionFormId: text(values.get(FORM_KEYS.correctionFormId)),
    normalEditUrl: text(values.get(FORM_KEYS.normalEditUrl)), correctionEditUrl: text(values.get(FORM_KEYS.correctionEditUrl)),
    formsFolderId: text(values.get(FORM_KEYS.formsFolderId)), formsFolderUrl: text(values.get(FORM_KEYS.formsFolderUrl)),
  };
}

export function writeFormDesign(value: FormDesignSetting): void {
  const sheet = book().getSheetByName(SHEETS.formDesign) ?? ensure(SHEETS.formDesign, FORM_DESIGN_HEADERS);
  if (sheet.getLastRow() > 1) sheet.getRange(2, 1, sheet.getLastRow() - 1, 2).clearContent();
  const data: Value[][] = [
    [FORM_KEYS.year, value.year], [FORM_KEYS.normalTitle, value.normalTitle], [FORM_KEYS.correctionTitle, value.correctionTitle],
    [FORM_KEYS.deadline, deadlineSheetValue(value.deadline)], [FORM_KEYS.sendResponseCopy, value.sendResponseCopy], [FORM_KEYS.loginRequired, value.loginRequired],
    [FORM_KEYS.gradeBranching, value.gradeBranching], [FORM_KEYS.normalResubmission, value.normalResubmission],
    [FORM_KEYS.applyBeforeApproval, value.applyBeforeApproval], [FORM_KEYS.formStatus, value.formStatus],
    [FORM_KEYS.normalFormId, value.normalFormId], [FORM_KEYS.correctionFormId, value.correctionFormId],
    [FORM_KEYS.normalEditUrl, value.normalEditUrl], [FORM_KEYS.correctionEditUrl, value.correctionEditUrl],
    [FORM_KEYS.formsFolderId, value.formsFolderId], [FORM_KEYS.formsFolderUrl, value.formsFolderUrl],
  ];
  sheet.getRange(2, 1, data.length, 2).setValues(data);
  applyFormDesignDeadlineValidation();
}

function deadlineSheetValue(value: string): Date | string {
  const parts = parseCalendarDate(value);
  return parts ? new Date(parts.year, parts.month - 1, parts.day) : value;
}

export function replaceSettingsIssues(issues: SettingsIssue[]): void {
  const sheet = book().getSheetByName(SHEETS.settingsIssues) ?? ensure(SHEETS.settingsIssues, SETTINGS_ISSUE_HEADERS);
  if (sheet.getLastRow() > 1) sheet.getRange(2, 1, sheet.getLastRow() - 1, SETTINGS_ISSUE_HEADERS.length).clearContent();
  if (issues.length) sheet.getRange(2, 1, issues.length, SETTINGS_ISSUE_HEADERS.length).setValues(issues.map((issue) => [
    issue.category, issue.severity === 'ERROR' ? 'エラー' : '警告', issue.targetId,
    issue.rowNumber || '', issue.title, issue.instruction,
  ]));
}

export function appendFormRegistry(values: FormRegistryRow[]): void {
  const sheet = book().getSheetByName(SHEETS.formRegistry) ?? ensure(SHEETS.formRegistry, FORM_REGISTRY_HEADERS);
  if (values.length) sheet.getRange(sheet.getLastRow() + 1, 1, values.length, FORM_REGISTRY_HEADERS.length).setValues(values.map((value) => [
    value.formType, value.formId, value.itemId, value.fieldKey, value.eventId,
    value.title, value.itemType, value.displayOrder, value.enabled,
  ]));
}

export function readFormRegistry(formId: string): FormRegistryRow[] {
  return rows(SHEETS.formRegistry, FORM_REGISTRY_HEADERS.length)
    .filter((row) => text(row[1]) === formId)
    .map((row) => ({
      formType: text(row[0]) as FormRegistryRow['formType'], formId: text(row[1]),
      itemId: text(row[2]), fieldKey: text(row[3]), eventId: text(row[4]), title: text(row[5]),
      itemType: text(row[6]), displayOrder: num(row[7]), enabled: bool(row[8]),
    }));
}

export function readManagedFormIds(): string[] {
  return [...new Set(
    rows(SHEETS.formRegistry, FORM_REGISTRY_HEADERS.length)
      .map((row) => text(row[1]))
      .filter(Boolean),
  )];
}

export function getSettingsSheet(name: string): Sheet {
  const sheet = book().getSheetByName(name);
  if (!sheet) throw new Error(`「${name}」シートがありません。開発用の疑似データを作り直してください。`);
  return sheet;
}
