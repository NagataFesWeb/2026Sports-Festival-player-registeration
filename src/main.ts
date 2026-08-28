import type { DashboardFilter } from './shared/types';
import type { SubmissionAction } from './gas';
import type { GeneratedFormSubmitEvent } from './gas';
import {
  approveAllClearSubmissions as approveAllClearSubmissionsData,
  addDevelopmentMockCorrectionSubmissions as addMockCorrectionsData,
  cancelPlayerRosterCreation as cancelPlayerRosterCreationData,
  continuePlayerRosterCreation as continuePlayerRosterCreationData,
  createPlayerRosters as createPlayerRostersData,
  buildDraftForms as createDraftFormsData,
  buildDraftFormsFromUi as createDraftFormsUiData,
  advanceDraftFormCreationFromUi as advanceDraftFormCreationUiData,
  cancelDraftFormCreation as cancelDraftFormCreationData,
  continueDraftFormCreation as continueDraftFormCreationData,
  getSettingsDashboardData as loadSettingsDashboardData,
  getDashboardData as loadDashboardData,
  getSubmissionDetail as loadSubmissionDetail,
  getPlayerRosterJobStatus as loadPlayerRosterJobStatus,
  handleGeneratedFormSubmitEvent,
  retryFailedFormResponses as retryFailedFormResponsesData,
  editSubmissionItem as updateSubmissionItem,
  initializeDevelopmentWorkbookData,
  deleteDevelopmentWorkbookData,
  prepareRealFormTestData,
  initializeSettings as initializeSettingsData,
  openIssueLocation as selectIssueLocation,
  openSettingsIssue as selectSettingsIssue,
  performSubmissionAction as applySubmissionAction,
  prepareMockDataSettings as prepareMockDataSettingsData,
  revalidateAllSubmissions,
  resumeDraftFormCreation as resumeDraftFormCreationData,
  resumePlayerRosterCreation as resumePlayerRosterCreationData,
  selectDuplicateSubmission as selectDuplicateSubmissionData,
  prepareSettingsFromUi as prepareSettingsUiData,
  publishDraftForms as publishDraftFormsData,
  discardPreparedForms as discardPreparedFormsData,
  discardPreparedFormsFromUi as discardPreparedFormsUiData,
  publishDraftFormsFromUi as publishDraftFormsUiData,
  validateAndRenderSettings,
  validateSettingsFromUi as validateSettingsUiData,
  openSettingsSheet as activateSettingsSheet,
  openProductionStudentSheet as activateProductionStudentSheet,
  setupSystemSheetProtections as applySystemSheetProtections,
  activateProductionMode as activateProductionModeData,
  assertAuthorized,
  isProductionMode,
  auditManagementSharing as auditManagementSharingData,
  getAuthorizedEditorEmails,
  updateAuthorizedEditorEmails,
  createPracticeWorkbookCopy as createPracticeWorkbookCopyData,
  isPracticeWorkbook,
  beginPublishedSettingsChange,
  guardPublishedSettingsEdit,
} from './gas';

export function onOpen(): void {
  const ui = SpreadsheetApp.getUi();
  const practiceWorkbook = isPracticeWorkbook();
  const filterMenu = ui.createMenu('状態別に開く')
    .addItem('警告がある申請', 'showWarningDashboard')
    .addItem('エラーがある申請', 'showErrorDashboard')
    .addItem('問題がない申請', 'showClearDashboard')
    .addItem('保留中の申請', 'showHoldDashboard')
    .addItem('却下済みの申請', 'showRejectedDashboard');
  filterMenu.addItem('承認済みの申請', 'showApprovedDashboard');
  const settingsMenu = ui.createMenu('フォーム・競技設定')
    .addItem('設定シートを作成・不足分を補う', 'setupSettings')
    .addSeparator()
    .addItem('設定画面を開く', 'showSettingsDashboard')
    .addItem('競技設定を開く', 'showEventSettings')
    .addItem('ルール設定を開く', 'showRuleSettings')
    .addItem('フォーム設計を開く', 'showFormDesign')
    .addSeparator()
    .addItem('受付を停止して設定変更を開始', 'beginSettingsChange')
    .addSeparator()
    .addItem('設定を点検', 'validateSettings')
    .addItem('フォーム下書きを作成', 'createDraftForms')
    .addItem('確認済みフォームを公開', 'publishPreparedForms')
    .addItem('公開前フォームを破棄', 'discardPreparedForms');
  const managementMenu = ui
    .createMenu('選手登録管理')
    .addItem('申請一覧を開く', 'showDashboard')
    .addSubMenu(filterMenu)
    .addSubMenu(settingsMenu)
    .addItem('すべて再検査する', 'revalidateAll')
    .addItem('回答取込を点検・再処理', 'retryFormResponseImport')
    .addSeparator()
    .addItem('承認済みから選手名簿を作成', 'createPlayerRosters')
    .addItem('名簿作成の状況を確認', 'showPlayerRosterStatus')
    .addItem('中断した名簿作成を再開', 'resumePlayerRosterCreation')
    .addItem('途中の名簿作成を取り消す', 'cancelPlayerRosterCreation')
    .addSeparator();
  if (!isProductionMode()) {
    managementMenu
      .addItem('疑似データの対象範囲を設定', 'showMockDataSettings')
      .addItem('開発用の疑似データを作る', 'initializeDevelopmentWorkbook')
      .addItem('疑似の修正申請を追加する', 'addMockCorrectionSubmissions')
      .addItem('開発用の疑似データをすべて削除', 'deleteDevelopmentWorkbook')
      .addSeparator();
  } else {
    managementMenu
      .addItem('練習用コピーを作成', 'createPracticeWorkbookCopy')
      .addSeparator();
  }
  if (!practiceWorkbook) {
    managementMenu
      .addItem('本番用の生徒マスターを開く', 'showProductionStudentMaster')
      .addItem('本番モードへ切り替える', 'enableProductionMode')
      .addItem('管理ファイルの共有範囲を点検', 'auditManagementSharing');
  }
  managementMenu
    .addItem('担当者アカウントを設定', 'configureAuthorizedEditors')
    .addItem('システムシートの保護を設定・更新', 'setupSheetProtections')
    .addToUi();
}

export function onEdit(event: GoogleAppsScript.Events.SheetsOnEdit): void {
  guardPublishedSettingsEdit(event);
}

export function beginSettingsChange(): void {
  const ui = SpreadsheetApp.getUi();
  const response = ui.prompt(
    '受付を停止して設定変更を開始',
    '変更理由を入力してください。公開中の通常フォームと修正フォームは直ちに受付停止します。',
    ui.ButtonSet.OK_CANCEL,
  );
  if (response.getSelectedButton() !== ui.Button.OK) return;
  beginPublishedSettingsChange(response.getResponseText());
  ui.alert(
    '受付を停止しました',
    '設定を編集できます。編集後に「フォーム下書きを作成」し、内容を確認して公開してください。',
    ui.ButtonSet.OK,
  );
}

export function showProductionStudentMaster(): void {
  assertAuthorized();
  if (isPracticeWorkbook()) {
    throw new Error('練習用コピーでは本番用生徒マスターを開けません。本番ファイルを使用してください。');
  }
  activateProductionStudentSheet();
  SpreadsheetApp.getUi().alert(
    '本番用の生徒マスター',
    '黄色のA列に4ケタの学籍番号、B列に氏名、F列に性別（mまたはf）を入力してください。学年・組・出席番号は自動表示されます。\n\n'
      + 'A列またはB列に1人分でも入力すると、この「生徒マスター」が検査に使われます。全行が空欄のときだけ「疑似生徒マスター」を使います。\n\n'
      + '切り替える前に疑似申請を削除し、本番用マスターの入力漏れがないことを確認してください。',
    SpreadsheetApp.getUi().ButtonSet.OK,
  );
}

export function setupSheetProtections(): void {
  assertAuthorized();
  const result = applySystemSheetProtections();
  const detail = result.mode === 'STRICT'
    ? '\n\n厳格保護を変更する場合は、Script PropertiesのAUTHORIZED_EDITOR_EMAILSをカンマ区切りで更新してから、もう一度実行してください。'
    : '\n\n体育祭スタッフ共有Gmailアカウントだけに制限する場合は、Script PropertiesのAUTHORIZED_EDITOR_EMAILSへそのアドレスを設定してください。本番モードへの切替時は、切替を実行したアカウントが自動登録されます。';
  SpreadsheetApp.getUi().alert('システムシートの保護', result.message + detail, SpreadsheetApp.getUi().ButtonSet.OK);
}

export function enableProductionMode(): void {
  const ui = SpreadsheetApp.getUi();
  if (isProductionMode()) {
    ui.alert('本番モード', 'すでに本番モードです。疑似データ機能は無効になっています。', ui.ButtonSet.OK);
    return;
  }
  const answer = ui.alert(
    '本番モードへ切り替える',
    '本番用の「生徒マスター」を検査し、現在のGoogleアカウントを担当者として登録します。\n\n'
      + '切り替え後は、実在データを守るため疑似データの作成・追加・削除を実行できません。続けますか？',
    ui.ButtonSet.YES_NO,
  );
  if (answer !== ui.Button.YES) return;
  const result = activateProductionModeData();
  const protection = applySystemSheetProtections();
  ui.alert(
    '本番モードへ切り替えました',
    `${result.message}\n\n${protection.message}\n\nスプレッドシートを再読み込みすると、本番用のメニューへ切り替わります。`,
    ui.ButtonSet.OK,
  );
}

export function auditManagementSharing(): void {
  assertAuthorized();
  const result = auditManagementSharingData();
  SpreadsheetApp.getUi().alert(
    '共有範囲の点検結果',
    result.message,
    SpreadsheetApp.getUi().ButtonSet.OK,
  );
}

export function configureAuthorizedEditors(): void {
  const ui = SpreadsheetApp.getUi();
  const current = getAuthorizedEditorEmails();
  const response = ui.prompt(
    '担当者アカウントを設定',
    '操作を許可するGoogleアカウントを、カンマ区切りで入力してください。原則は体育祭スタッフ共有Gmailアカウント1件です。\n'
      + '引継ぎでは、先にGoogle Driveで管理スプレッドシートを新担当者へ共有し、ここへ追加して動作確認してから旧担当者を整理します。\n\n'
      + `現在：${current.join(', ') || '未設定'}`,
    ui.ButtonSet.OK_CANCEL,
  );
  if (response.getSelectedButton() !== ui.Button.OK) return;
  const updated = updateAuthorizedEditorEmails(response.getResponseText());
  const protection = applySystemSheetProtections();
  ui.alert(
    '担当者を更新しました',
    `${updated.length}件のGoogleアカウントを登録しました。\n\n${protection.message}`,
    ui.ButtonSet.OK,
  );
}

export function createPracticeWorkbookCopy(): void {
  const ui = SpreadsheetApp.getUi();
  const answer = ui.alert(
    '練習用コピーを作成',
    '現在の本番ファイルをコピーし、本番フォームID・実回答・登録データ・履歴・生徒マスターをコピー側から切り離します。\n\n'
      + '本番ファイルと本番フォームは変更しません。続けますか？',
    ui.ButtonSet.YES_NO,
  );
  if (answer !== ui.Button.YES) return;
  const result = createPracticeWorkbookCopyData();
  ui.alert(
    '練習用コピーを作成しました',
    `${result.message}\n\n${result.name}\n${result.spreadsheetUrl}\n\nコピーを開き、練習用フォームを新しく作成してから疑似データを作ってください。`,
    ui.ButtonSet.OK,
  );
}

/** clasp run用。個人情報を返さず、適用した保護モードとシート数だけを返す。 */
export function setupSheetProtectionsForClasp(): ReturnType<typeof applySystemSheetProtections> {
  assertAuthorized();
  return applySystemSheetProtections();
}

export function handleGeneratedFormSubmit(event: GeneratedFormSubmitEvent): void {
  handleGeneratedFormSubmitEvent(event);
}

export function retryFormResponseImport(): void {
  const result = retryFailedFormResponsesData();
  SpreadsheetApp.getUi().alert(
    '回答取込の点検結果',
    result.message,
    SpreadsheetApp.getUi().ButtonSet.OK,
  );
}

export function showSettingsDashboard(): void {
  const template = HtmlService.createTemplateFromFile('SettingsSidebar');
  template.uiTokens = HtmlService.createHtmlOutputFromFile('UiTokens').getContent();
  SpreadsheetApp.getUi().showSidebar(
    template.evaluate().setTitle('フォーム準備'),
  );
}
export function showEventSettings(): void { activateSettingsSheet('競技設定'); }
export function showRuleSettings(): void { activateSettingsSheet('ルール設定'); }
export function showFormDesign(): void { activateSettingsSheet('フォーム設計'); }

export function setupSettings(): void {
  const ui = SpreadsheetApp.getUi();
  const answer = ui.alert(
    '設定シートを作成・不足分を補う',
    'フォームを準備するために必要な「競技設定」「ルール設定」「フォーム設計」などのシートを追加します。\n\n'
      + '空の設定シートには、書き方の見本となる疑似設定を入れます。すでに入力してある設定行は消さず、不足しているシート・見出し・選択欄だけを補います。\n\n'
      + 'この操作だけではGoogleフォームを作らず、申請・登録データ・帳票も変更しません。続けますか？',
    ui.ButtonSet.YES_NO,
  );
  if (answer !== ui.Button.YES) return;
  const result = initializeSettingsData();
  const errors = result.eventErrorCount + result.ruleErrorCount + result.formErrorCount;
  SpreadsheetApp.getActiveSpreadsheet().toast(
    `設定シートを準備しました。エラー${errors}件です。`,
    '設定の準備が完了しました', 6,
  );
  showSettingsDashboard();
}

export function getSettingsDashboardData(): ReturnType<typeof loadSettingsDashboardData> {
  return loadSettingsDashboardData();
}

export function prepareSettingsFromUi(): ReturnType<typeof prepareSettingsUiData> {
  return prepareSettingsUiData();
}

export function validateSettingsFromUi(): ReturnType<typeof validateSettingsUiData> {
  return validateSettingsUiData();
}

export function buildDraftFormsFromUi(): ReturnType<typeof createDraftFormsUiData> {
  return createDraftFormsUiData();
}

export function advanceDraftFormCreationFromUi(): ReturnType<typeof advanceDraftFormCreationUiData> {
  return advanceDraftFormCreationUiData();
}

export function resumeDraftFormCreationFromUi(): ReturnType<typeof resumeDraftFormCreationData> {
  return resumeDraftFormCreationData();
}

export function cancelDraftFormCreationFromUi(): ReturnType<typeof cancelDraftFormCreationData> {
  return cancelDraftFormCreationData();
}

/** 時間主導トリガーから呼ばれ、フォームを1区切りずつ作成する。 */
export function continueDraftFormCreation(): void {
  continueDraftFormCreationData();
}

export function openSettingsSheetFromUi(name: string): void {
  activateSettingsSheet(name);
}

export function openSettingsIssueFromUi(category: '競技設定' | 'ルール設定' | 'フォーム設計', rowNumber: number): void {
  selectSettingsIssue(category, rowNumber);
}

export function validateSettings(): void {
  const result = validateAndRenderSettings();
  const errors = result.eventErrorCount + result.ruleErrorCount + result.formErrorCount;
  const warnings = result.eventWarningCount + result.ruleWarningCount + result.formWarningCount;
  SpreadsheetApp.getActiveSpreadsheet().toast(
    `警告${warnings}件、エラー${errors}件です。設定点検結果を確認してください。`,
    '設定点検が完了しました', 8,
  );
  activateSettingsSheet(errors + warnings > 0 ? '設定点検結果' : '設定画面');
}

export function createDraftForms(): void {
  const result = createDraftFormsData();
  SpreadsheetApp.getUi().alert(
    'フォーム下書きの作成を開始しました',
    `${result.message}\n\n保存先：${result.formsFolderUrl}\n\nメニューの「設定画面を開く」で進み具合を確認できます。`,
    SpreadsheetApp.getUi().ButtonSet.OK,
  );
}

export function publishPreparedForms(): void {
  const ui = SpreadsheetApp.getUi();
  const answer = ui.alert(
    '確認済みフォームを公開',
    '公開前確認の通常フォームと修正フォームを回答可能にし、回答取込を開始します。\n\n'
      + '新しいフォームの公開とトリガー設定が成功するまでは、現在使用中のフォームを停止しません。続けますか？',
    ui.ButtonSet.YES_NO,
  );
  if (answer !== ui.Button.YES) return;
  const result = publishDraftFormsData();
  ui.alert(
    'フォームを公開しました',
    `${result.message}\n\n通常フォーム：${result.normalPublishedUrl}\n\n修正フォーム：${result.correctionPublishedUrl}`,
    ui.ButtonSet.OK,
  );
}

export function publishDraftFormsFromUi(): ReturnType<typeof publishDraftFormsUiData> {
  return publishDraftFormsUiData();
}

export function discardPreparedForms(): void {
  const ui = SpreadsheetApp.getUi();
  const answer = ui.alert(
    '公開前フォームを破棄',
    'まだ公開していない新しい通常フォームと修正フォームをゴミ箱へ移します。現在使用中のフォームは停止しません。続けますか？',
    ui.ButtonSet.YES_NO,
  );
  if (answer !== ui.Button.YES) return;
  const result = discardPreparedFormsData();
  ui.alert('公開前フォームを破棄しました', result.message, ui.ButtonSet.OK);
}

export function discardPreparedFormsFromUi(): ReturnType<typeof discardPreparedFormsUiData> {
  return discardPreparedFormsUiData();
}

function formatSelectedNumbers(values: number[], suffix: string): string {
  const sorted = [...values].sort((left, right) => left - right);
  const groups: string[] = [];
  let start = sorted[0];
  let previous = sorted[0];
  sorted.slice(1).forEach((value) => {
    if (previous !== undefined && value === previous + 1) {
      previous = value;
      return;
    }
    if (start !== undefined && previous !== undefined) {
      groups.push(start === previous ? `${start}${suffix}` : `${start}〜${previous}${suffix}`);
    }
    start = value;
    previous = value;
  });
  if (start !== undefined && previous !== undefined) {
    groups.push(start === previous ? `${start}${suffix}` : `${start}〜${previous}${suffix}`);
  }
  return groups.join('・');
}

export function initializeDevelopmentWorkbook(): void {
  const ui = SpreadsheetApp.getUi();
  const config = prepareMockDataSettingsData();
  const gradeText = formatSelectedNumbers(config.targetGrades, '年');
  const classText = formatSelectedNumbers(config.targetClasses, '組');
  const formText = config.targetFormTypes.map((type) => type === 'normal' ? '通常フォーム' : '修正フォーム').join('・');
  const answer = ui.alert(
    '開発用の疑似データを作る',
    'この機能は、作成済みの通常フォームと修正フォームをもとに、実在しない回答を作って操作を練習・確認するためのものです。先にフォーム下書きを作成してください。\n\n'
      + 'フォームから読み取るもの：競技、選手枠、走順、必須・任意、通常・修正フォームの区別。\n\n'
      + `作成対象：${gradeText}の${classText}\n使用するフォーム：${formText}\n作成する疑似申請：${config.submissionCount}件（エラーを含む申請${config.errorSubmissionCount}件、警告を含む申請${config.warningSubmissionCount}件）\n\n`
      + '対象を変えたい場合は、いったん「いいえ」を押し、メニューの「疑似データの対象範囲を設定」で学年とクラスをチェックしてください。\n\n'
      + '置き換わるもの：現在の「疑似生徒マスター」「フォーム回答原本」「承認待ち」「申請項目」「検査結果」。承認履歴も空になります。\n\n'
      + '変更しないもの：Googleフォーム、登録データ、帳票。\n\n'
      + '現在の疑似申請を残したい場合は「いいえ」を押してください。作り直しますか？',
    ui.ButtonSet.YES_NO,
  );
  if (answer !== ui.Button.YES) return;
  const result = initializeDevelopmentWorkbookData();
  SpreadsheetApp.getActiveSpreadsheet().toast(
    `疑似申請${result.pending}件を作成しました。警告${result.warning}件、エラー${result.error}件です。`,
    '初期設定が完了しました',
    6
  );
  showDashboard();
}

export function addMockCorrectionSubmissions(): void {
  const ui = SpreadsheetApp.getUi();
  const response = ui.prompt(
    '疑似の修正申請を追加する',
    '今ある疑似申請・承認履歴を残したまま、修正フォームが追加送信された想定の申請を作ります。\n\n'
      + '追加する件数を1～100の数字で入力してください。追加分は、現在の疑似データ設定で選択されている学年・クラスへ順番に割り当てます。意図的なエラー・警告は付けませんが、欠員許可など現在のルールに基づく警告は表示される場合があります。',
    ui.ButtonSet.OK_CANCEL,
  );
  if (response.getSelectedButton() !== ui.Button.OK) return;
  const value = response.getResponseText().trim();
  if (!/^\d+$/.test(value)) {
    ui.alert('1～100の整数で入力してください。');
    return;
  }
  const result = addMockCorrectionsData(Number(value));
  SpreadsheetApp.getActiveSpreadsheet().toast(result.message, '疑似修正申請を追加しました', 7);
  showDashboard();
}

export function addMockCorrectionSubmissionsFromUi(count: number): ReturnType<typeof addMockCorrectionsData> {
  return addMockCorrectionsData(Number(count));
}

export function showMockDataSettings(): void {
  const config = prepareMockDataSettingsData();
  const gradeText = formatSelectedNumbers(config.targetGrades, '年');
  const classText = formatSelectedNumbers(config.targetClasses, '組');
  const formText = config.targetFormTypes.map((type) => type === 'normal' ? '通常フォーム' : '修正フォーム').join('・');
  const book = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = book.getSheetByName('疑似データ設定');
  if (!sheet) throw new Error('「疑似データ設定」シートを作成できませんでした。');
  book.setActiveSheet(sheet);
  SpreadsheetApp.getUi().alert(
    '疑似データの対象範囲を設定',
    `現在の対象は「${gradeText}の${classText}」、使用するフォームは「${formText}」です。作成する疑似申請は${config.submissionCount}件です。\n\n緑色の行で学年、青色の行でクラス、紫色の行で通常フォーム・修正フォームをチェックしてください。通常フォームは各クラスにつき1回答だけ作ります。両方にチェックした場合、各クラスの最初の1回答を通常フォーム、その後を修正フォームとして作ります。修正フォームだけの場合は、対象範囲の疑似生徒数と同じ件数を作ります。\n\n黄色の行ではエラー・警告を含む申請数を変更できます。変更後、メニューから「開発用の疑似データを作る」を実行してください。`,
    SpreadsheetApp.getUi().ButtonSet.OK,
  );
}

/** clasp run用。個人情報やフォーム回答は返さず、疑似データ設定の移行結果だけを確認する。 */
export function verifyMockDataSettingsForClasp(): {
  ok: true;
  targetGrades: number[];
  targetClasses: number[];
  targetFormTypes: Array<'normal' | 'correction'>;
  submissionCount: number;
  errorSubmissionCount: number;
  warningSubmissionCount: number;
} {
  const config = prepareMockDataSettingsData();
  return { ok: true, ...config };
}

export function deleteDevelopmentWorkbook(): void {
  const ui = SpreadsheetApp.getUi();
  const answer = ui.alert(
    '開発用の疑似データをすべて削除',
    'このボタンは、動作確認のために作成した疑似データを空に戻します。\n\n'
      + '削除するもの：疑似生徒マスター、mock-responseで始まる疑似フォーム回答、それに対応する承認待ち、申請項目、検査結果、承認履歴、変更履歴。\n\n'
      + '残すもの：通常フォーム、修正フォーム、formsフォルダ、競技設定、ルール設定、フォーム設計、フォーム項目対応表、登録データ、帳票。\n\n'
      + '疑似データを削除すると元に戻せません。すべて削除しますか？',
    ui.ButtonSet.YES_NO,
  );
  if (answer !== ui.Button.YES) return;
  deleteDevelopmentWorkbookData();
  SpreadsheetApp.getActiveSpreadsheet().toast(
    '開発用の疑似データを削除しました。フォームと設定は残しています。',
    '疑似データの削除が完了しました',
    7,
  );
  showDashboard();
}

/** 管理サイドバーから、確認後に疑似データだけを削除する。 */
export function deleteDevelopmentWorkbookFromUi(): ReturnType<typeof deleteDevelopmentWorkbookData> {
  return deleteDevelopmentWorkbookData();
}

/** 疑似マスターを残し、実際のGoogleフォーム送信を試せる空の確認状態へ切り替える。 */
export function prepareRealFormTestFromUi(): ReturnType<typeof prepareRealFormTestData> {
  return prepareRealFormTestData();
}

export function revalidateAll(): void {
  const result = revalidateAllSubmissions();
  SpreadsheetApp.getActiveSpreadsheet().toast(
    `未処理${result.pending}件を再検査しました。`,
    '再検査が完了しました',
    5
  );
}

export function showDashboard(): void {
  showDashboardWithFilter('ALL');
}

export function showWarningDashboard(): void {
  showDashboardWithFilter('WARNING');
}

export function showErrorDashboard(): void {
  showDashboardWithFilter('ERROR');
}

export function showClearDashboard(): void {
  showDashboardWithFilter('CLEAR');
}

export function showHoldDashboard(): void {
  showDashboardWithFilter('HOLD');
}

export function showRejectedDashboard(): void {
  showDashboardWithFilter('REJECTED');
}

export function showApprovedDashboard(): void {
  showDashboardWithFilter('APPROVED');
}

function showDashboardWithFilter(filter: DashboardFilter): void {
  const template = HtmlService.createTemplateFromFile('Sidebar');
  template.initialFilter = filter;
  template.uiTokens = HtmlService.createHtmlOutputFromFile('UiTokens').getContent();
  SpreadsheetApp.getUi().showSidebar(template.evaluate().setTitle('申請を確認する'));
}

export function getDashboardData(filter: DashboardFilter = 'ALL'): ReturnType<typeof loadDashboardData> {
  return loadDashboardData(filter);
}

export function getSubmissionDetail(submissionId: string): ReturnType<typeof loadSubmissionDetail> {
  return loadSubmissionDetail(submissionId);
}

export function openIssueLocation(
  submissionId: string,
  submissionItemId = ''
): ReturnType<typeof selectIssueLocation> {
  return selectIssueLocation(submissionId, submissionItemId);
}

export function editSubmissionItem(
  submissionId: string,
  submissionItemId: string,
  studentIdInput: string,
  registrationState: ReturnType<typeof loadSubmissionDetail>['items'][number]['registrationState'],
  reason: string
): ReturnType<typeof updateSubmissionItem> {
  return updateSubmissionItem(submissionId, submissionItemId, studentIdInput, registrationState, reason);
}

export function performSubmissionAction(
  submissionId: string,
  action: SubmissionAction,
  reason = ''
): ReturnType<typeof applySubmissionAction> {
  return applySubmissionAction(submissionId, action, reason);
}

export function selectDuplicateSubmission(submissionId: string): void {
  selectDuplicateSubmissionData(submissionId);
}

export function approveAllClearSubmissions(): ReturnType<typeof approveAllClearSubmissionsData> {
  return approveAllClearSubmissionsData();
}

export function createPlayerRosters(): void {
  const ui = SpreadsheetApp.getUi();
  const response = ui.prompt(
    '承認済みから選手名簿を作成',
    '作成する名簿の名前を入力してください。例：「第1回確認版」\n\n'
      + '承認済みの申請だけを正式な「登録データ」へ反映し、種目別・クラス別と招集順の統合版・当日変更用の3ファイルと、1ページ1クラスの配布用PDFを作ります。走順別ファイルは作りません。\n\n'
      + 'すべてのファイルの先頭に、選手が自分の氏名から全競技と走順を探せる配布用ページを付けます。\n\n'
      + '入力した名前には v1.0 が付きます。同じ名前がある場合は v1.1、v1.2 のように自動で番号が進みます。',
    ui.ButtonSet.OK_CANCEL,
  );
  if (response.getSelectedButton() !== ui.Button.OK) return;
  const result = createPlayerRostersData(response.getResponseText());
  ui.alert(
    '選手名簿の作成を開始しました',
    `版：${result.versionName}\n登録予定：${result.registrationCount}件\n元にした承認済み申請：${result.sourceSubmissionCount}件\n\n${result.message}\n\n保存先：${result.folderUrl}\n\n3種類のスプレッドシートと配布用PDFを1ファイルずつ自動作成します。「名簿作成の状況を確認」で進み具合を確認できます。完了するまで正式データは変更しません。`,
    ui.ButtonSet.OK,
  );
}

/** 時間主導トリガーから呼ばれる。UIを表示しない。 */
export function continuePlayerRosterCreation(): void {
  continuePlayerRosterCreationData();
}

export function showPlayerRosterStatus(): void {
  const status = loadPlayerRosterJobStatus();
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('名簿作成状況');
  if (sheet) SpreadsheetApp.getActiveSpreadsheet().setActiveSheet(sheet);
  SpreadsheetApp.getUi().alert(
    '名簿作成の状況',
    `版：${status.versionName || '未実行'}\n進み具合：${status.progress}\n${status.message}${status.folderUrl ? `\n\n保存先：${status.folderUrl}` : ''}`,
    SpreadsheetApp.getUi().ButtonSet.OK,
  );
}

export function resumePlayerRosterCreation(): void {
  const status = resumePlayerRosterCreationData();
  SpreadsheetApp.getUi().alert(
    '名簿作成を再開しました',
    `版：${status.versionName}\n進み具合：${status.progress}\n\n自動処理を再開しました。「名簿作成の状況を確認」で確認できます。`,
    SpreadsheetApp.getUi().ButtonSet.OK,
  );
}

export function cancelPlayerRosterCreation(): void {
  const ui = SpreadsheetApp.getUi();
  const answer = ui.alert(
    '途中の名簿作成を取り消す',
    '作成途中の版フォルダをゴミ箱へ移動し、自動処理を停止します。正式データは変更しません。取り消しますか？',
    ui.ButtonSet.YES_NO,
  );
  if (answer !== ui.Button.YES) return;
  const status = cancelPlayerRosterCreationData();
  ui.alert('名簿作成を取り消しました', status.message, ui.ButtonSet.OK);
}
