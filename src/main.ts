import type { DashboardFilter } from './shared/types';
import {
  isProductionMigrationConfirmed,
  PRODUCTION_MIGRATION_CONFIRMATION_WORD,
} from './core/system-mode';
import {
  MOCK_ROSTER_SOURCE_LABELS,
  type MockRosterSource,
} from './core/mock-roster-source';
import { findFeature } from './core/feature-catalog';
import { isFeatureVisible, type FeatureVisibilityContext } from './core/feature-availability';
import type { SubmissionAction } from './gas';
import type { GeneratedFormSubmitEvent } from './gas';
import {
  approveAllClearSubmissions as approveAllClearSubmissionsData,
  addDevelopmentMockCorrectionSubmissions as addMockCorrectionsData,
  cancelPlayerRosterCreation as cancelPlayerRosterCreationData,
  continuePlayerRosterCreation as continuePlayerRosterCreationData,
  createPlayerRosters as createPlayerRostersData,
  createPlayerRostersFromLatestVersion as createPlayerRostersFromLatestVersionData,
  describePlayerRosterDiff as loadPlayerRosterDiff,
  buildDraftForms as createDraftFormsData,
  buildDraftFormsFromUi as createDraftFormsUiData,
  buildDraftFormsWithFormAppFromUi as createDraftFormsWithFormAppUiData,
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
  importCorrectionSlots as importCorrectionSlotsData,
  initializeDevelopmentWorkbookData,
  deleteDevelopmentWorkbookData,
  prepareRealFormTestData,
  initializeSettings as initializeSettingsData,
  openIssueLocation as selectIssueLocation,
  openSettingsIssue as selectSettingsIssue,
  performSubmissionAction as applySubmissionAction,
  prepareMockDataSettings as prepareMockDataSettingsData,
  readMockRosterSourceSetting,
  buildFeatureVisibilityContext,
  describeFeatureBlock,
  getFeatureGuideData as loadFeatureGuideData,
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
  describeProductionMigration as describeProductionMigrationData,
  revertToDevelopmentMode as revertToDevelopmentModeData,
  assertAuthorized,
  isProductionMode,
  auditManagementSharing as auditManagementSharingData,
  getAuthorizedEditorEmails,
  updateAuthorizedEditorEmails,
  createPracticeWorkbookCopy as createPracticeWorkbookCopyData,
  isPracticeWorkbook,
  abortRuleOnlyChange,
  applyRuleOnlyChange,
  beginPublishedSettingsChange,
  startRuleOnlyChange,
  guardPublishedSettingsEdit,
  prepareLiveFormTest as prepareLiveFormTestData,
  submitLiveFormTestAutomatically as submitLiveFormTestData,
  collectLiveFormTestResults as collectLiveFormTestData,
  cleanupLiveFormTest as cleanupLiveFormTestData,
  describeLiveFormTestState,
} from './gas';

/**
 * メニューへ1項目足す。表示名と出し分けの条件は機能カタログが持つ。
 *
 * 並び順と区切り線はこの関数の書き方がそのまま正になる。カタログから木を組み直すと
 * 34項目の順番が崩れるので、構造は手書きのまま残し、出す・出さないだけを問い合わせる。
 * GASのメニューには「押せないが見える」状態が無いため、状態による制限はここでは扱わず、
 * 実行時の案内（describeFeatureBlock）と機能紹介ダイアログで伝える。
 */
function addFeatureItem(
  menu: GoogleAppsScript.Base.Menu,
  id: string,
  context: FeatureVisibilityContext,
): GoogleAppsScript.Base.Menu {
  const entry = findFeature(id);
  if (!isFeatureVisible(entry, context)) return menu;
  return menu.addItem(entry.title, entry.entrypoint);
}

export function onOpen(): void {
  const ui = SpreadsheetApp.getUi();
  const context = buildFeatureVisibilityContext();
  const filterMenu = ui.createMenu('状態別に開く');
  addFeatureItem(filterMenu, 'review.dashboard.warning', context);
  addFeatureItem(filterMenu, 'review.dashboard.error', context);
  addFeatureItem(filterMenu, 'review.dashboard.clear', context);
  addFeatureItem(filterMenu, 'review.dashboard.hold', context);
  addFeatureItem(filterMenu, 'review.dashboard.rejected', context);
  addFeatureItem(filterMenu, 'review.dashboard.approved', context);

  const settingsMenu = ui.createMenu('フォーム・競技設定');
  addFeatureItem(settingsMenu, 'setup.initialize', context);
  settingsMenu.addSeparator();
  addFeatureItem(settingsMenu, 'setup.dashboard', context);
  addFeatureItem(settingsMenu, 'setup.openEvents', context);
  addFeatureItem(settingsMenu, 'setup.openRules', context);
  addFeatureItem(settingsMenu, 'setup.openFormDesign', context);
  settingsMenu.addSeparator();
  addFeatureItem(settingsMenu, 'change.beginSettingsChange', context);
  settingsMenu.addSeparator();
  addFeatureItem(settingsMenu, 'change.beginRuleChange', context);
  addFeatureItem(settingsMenu, 'change.applyRuleChange', context);
  addFeatureItem(settingsMenu, 'change.cancelRuleChange', context);
  settingsMenu.addSeparator();
  addFeatureItem(settingsMenu, 'setup.validate', context);
  addFeatureItem(settingsMenu, 'setup.buildDraft', context);
  addFeatureItem(settingsMenu, 'setup.publish', context);
  addFeatureItem(settingsMenu, 'setup.discard', context);

  const liveTestMenu = ui.createMenu('実機テスト（本物のフォームで確認）');
  addFeatureItem(liveTestMenu, 'liveTest.prepare', context);
  addFeatureItem(liveTestMenu, 'liveTest.submit', context);
  addFeatureItem(liveTestMenu, 'liveTest.collect', context);
  addFeatureItem(liveTestMenu, 'liveTest.cleanup', context);

  const managementMenu = ui.createMenu('選手登録管理');
  addFeatureItem(managementMenu, 'guide.show', context);
  managementMenu.addSeparator();
  addFeatureItem(managementMenu, 'review.dashboard', context);
  managementMenu.addSubMenu(filterMenu).addSubMenu(settingsMenu);
  addFeatureItem(managementMenu, 'review.revalidate', context);
  addFeatureItem(managementMenu, 'review.retryImport', context);
  managementMenu.addSeparator();
  addFeatureItem(managementMenu, 'roster.create', context);
  addFeatureItem(managementMenu, 'roster.createDiff', context);
  addFeatureItem(managementMenu, 'roster.status', context);
  addFeatureItem(managementMenu, 'roster.resume', context);
  addFeatureItem(managementMenu, 'roster.cancel', context);
  managementMenu.addSeparator();
  // 疑似データは開発用モードのときだけ、本番運用への切替は本番モードのときだけ出す。
  // どちらを出すかはカタログの visibility が決める。
  addFeatureItem(managementMenu, 'mock.settings', context);
  addFeatureItem(managementMenu, 'mock.initialize', context);
  addFeatureItem(managementMenu, 'mock.addCorrections', context);
  addFeatureItem(managementMenu, 'mock.delete', context);
  addFeatureItem(managementMenu, 'mode.practiceCopy', context);
  addFeatureItem(managementMenu, 'mode.disableProduction', context);
  managementMenu.addSeparator();
  addFeatureItem(managementMenu, 'mode.showProductionMaster', context);
  addFeatureItem(managementMenu, 'mode.enableProduction', context);
  addFeatureItem(managementMenu, 'mode.auditSharing', context);
  managementMenu.addSeparator();
  managementMenu.addSubMenu(liveTestMenu);
  addFeatureItem(managementMenu, 'security.editors', context);
  addFeatureItem(managementMenu, 'security.protections', context);
  managementMenu.addToUi();
}

/** この管理表でできることの一覧を、幅の広いダイアログで開く。 */
export function showFeatureGuide(): void {
  const template = HtmlService.createTemplateFromFile('FeatureGuide');
  template.uiTokens = HtmlService.createHtmlOutputFromFile('UiTokens').getContent();
  SpreadsheetApp.getUi().showModalDialog(
    template.evaluate().setWidth(1200).setHeight(750),
    'この管理表でできること',
  );
}

export function getFeatureGuideData(): ReturnType<typeof loadFeatureGuideData> {
  return loadFeatureGuideData();
}

/**
 * メニューから実行したときに、前提を満たしていなければ理由を出して中止する。
 * `true`なら続けてよい。
 */
function allowFeature(id: string): boolean {
  // 状態を調べる前に権限を確かめる。順番を逆にすると、権限のないアカウントへ
  // 「疑似申請がありません」のような中の状況が漏れる。
  assertAuthorized();
  const reason = describeFeatureBlock(id);
  if (reason === '') return true;
  const entry = findFeature(id);
  SpreadsheetApp.getUi().alert(
    `${entry.title}は、今は使えません`,
    `${reason}\n\n「選手登録管理」→「この管理表でできること」で、`
      + '今できる操作と、その前にすることを一覧できます。',
    SpreadsheetApp.getUi().ButtonSet.OK,
  );
  return false;
}

export function onEdit(event: GoogleAppsScript.Events.SheetsOnEdit): void {
  guardPublishedSettingsEdit(event);
}

export function beginSettingsChange(): void {
  if (!allowFeature('change.beginSettingsChange')) return;
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

export function beginRuleChange(): void {
  if (!allowFeature('change.beginRuleChange')) return;
  const ui = SpreadsheetApp.getUi();
  const response = ui.prompt(
    'ルール設定だけを変更する',
    'ルールを変える理由を入力してください。フォームの受付は止めず、フォームも作り直しません。',
    ui.ButtonSet.OK_CANCEL,
  );
  if (response.getSelectedButton() !== ui.Button.OK) return;
  const result = startRuleOnlyChange(response.getResponseText());
  ui.alert('ルール設定を編集できます', result.message, ui.ButtonSet.OK);
}

export function applyRuleChange(): void {
  if (!allowFeature('change.applyRuleChange')) return;
  const ui = SpreadsheetApp.getUi();
  const confirmed = ui.alert(
    'ルール変更を確定して全申請を再検査',
    '編集したルールを確定し、受信済みの申請をすべて新しいルールで検査し直します。' + '\n' + '\n'
      + '承認済み・名簿反映済みの申請は状態を変えず、警告・エラーの件数だけを更新します。よろしいですか。',
    ui.ButtonSet.OK_CANCEL,
  );
  if (confirmed !== ui.Button.OK) return;
  const result = applyRuleOnlyChange();
  ui.alert('新しいルールで検査し直しました', result.message, ui.ButtonSet.OK);
}

export function cancelRuleChange(): void {
  if (!allowFeature('change.cancelRuleChange')) return;
  const ui = SpreadsheetApp.getUi();
  const confirmed = ui.alert(
    'ルール変更を取り消す',
    'ルール設定を、変更を始めた時点の内容へ戻します。編集した内容は失われます。よろしいですか。',
    ui.ButtonSet.OK_CANCEL,
  );
  if (confirmed !== ui.Button.OK) return;
  const result = abortRuleOnlyChange();
  ui.alert('ルール設定を元に戻しました', result.message, ui.ButtonSet.OK);
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
      + 'このシートに入力しても、疑似データの機能は使えます。'
      + '検査にどちらの名簿を使うかは、メニューの「疑似データの対象範囲を設定」にある'
      + '「疑似申請に使う名簿」で選びます。実在の生徒を疑似申請に使いたくない場合は'
      + `「${MOCK_ROSTER_SOURCE_LABELS.MOCK_STUDENTS}」のままにしてください。\n\n`
      + '本番モードへ切り替える前に疑似申請を削除し、このシートの入力漏れがないことを確認してください。',
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
  if (!allowFeature('mode.enableProduction')) return;
  const ui = SpreadsheetApp.getUi();
  if (isProductionMode()) {
    ui.alert(
      '本番モード',
      'すでに本番モードです。疑似データ機能は無効になっています。\n\n開発用モードへ戻す場合は、'
        + 'メニューの「選手登録管理」→「開発用モードへ戻す」を実行してください。',
      ui.ButtonSet.OK,
    );
    return;
  }
  const preview = describeProductionMigrationData();
  if (preview.productionStudentCount === 0) {
    ui.alert(
      '本番モードへ切り替えられません',
      '本番用の「生徒マスター」が空です。\n\nメニューの「本番用の生徒マスターを開く」から'
        + '学籍番号と氏名を入力し、内容を確認してから、もう一度実行してください。',
      ui.ButtonSet.OK,
    );
    return;
  }
  const response = ui.prompt('本番モードへ切り替える', preview.text, ui.ButtonSet.OK_CANCEL);
  if (response.getSelectedButton() !== ui.Button.OK) return;
  if (!isProductionMigrationConfirmed(response.getResponseText())) {
    ui.alert(
      '切り替えを中止しました',
      `入力が「${PRODUCTION_MIGRATION_CONFIRMATION_WORD}」と一致しませんでした。データは削除していません。`,
      ui.ButtonSet.OK,
    );
    return;
  }
  const result = activateProductionModeData();
  const protection = applySystemSheetProtections();
  const folders = result.rosterFolderUrls.length > 0
    ? '\n\n開発中に作った選手名簿のフォルダは残っています。不要なら次のURLを開いて削除してください。\n'
      + result.rosterFolderUrls.join('\n')
    : '';
  ui.alert(
    '本番モードへ切り替えました',
    `${result.message}\n\n${protection.message}${folders}`
      + '\n\nスプレッドシートを再読み込みすると、本番用のメニューへ切り替わります。',
    ui.ButtonSet.OK,
  );
}

export function disableProductionMode(): void {
  const ui = SpreadsheetApp.getUi();
  if (!isProductionMode()) {
    ui.alert('開発用モード', 'すでに開発用モードです。', ui.ButtonSet.OK);
    return;
  }
  const response = ui.prompt(
    '開発用モードへ戻す',
    '本番運用を止めて、開発用モードへ戻します。\n\n'
      + '申請、登録データ、履歴、フォームは削除しません。運用モードだけを戻します。\n'
      + '本番用の「生徒マスター」に入力がある間は、疑似データの機能は使えないままです。'
      + '疑似データで練習する場合は「練習用コピーを作成」で作ったコピーを使ってください。\n\n'
      + '戻す理由を入力してOKを押してください。設定変更履歴へ記録します。',
    ui.ButtonSet.OK_CANCEL,
  );
  if (response.getSelectedButton() !== ui.Button.OK) return;
  const result = revertToDevelopmentModeData(response.getResponseText());
  ui.alert(
    '開発用モードへ戻しました',
    `${result.message}\n\nスプレッドシートを再読み込みすると、開発用のメニューへ切り替わります。`,
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
  if (!allowFeature('review.retryImport')) return;
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
export function showEventSettings(): void {
  if (!allowFeature('setup.openEvents')) return;
  activateSettingsSheet('競技設定');
}
export function showRuleSettings(): void {
  if (!allowFeature('setup.openRules')) return;
  activateSettingsSheet('ルール設定');
}
export function showFormDesign(): void {
  if (!allowFeature('setup.openFormDesign')) return;
  activateSettingsSheet('フォーム設計');
}

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

export function buildDraftFormsWithFormAppFromUi(): ReturnType<typeof createDraftFormsWithFormAppUiData> {
  return createDraftFormsWithFormAppUiData();
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
  if (!allowFeature('setup.validate')) return;
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
  if (!allowFeature('setup.buildDraft')) return;
  const result = createDraftFormsData();
  SpreadsheetApp.getUi().alert(
    'フォーム下書きの作成を開始しました',
    `${result.message}\n\n保存先：${result.formsFolderUrl}\n\nメニューの「設定画面を開く」で進み具合を確認できます。`,
    SpreadsheetApp.getUi().ButtonSet.OK,
  );
}

export function publishPreparedForms(): void {
  if (!allowFeature('setup.publish')) return;
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
  if (!allowFeature('setup.discard')) return;
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

/** 疑似データの確認ダイアログへ、いま選ばれている名簿と、その結果を書き添える。 */
function mockRosterNotice(source: MockRosterSource): string {
  const label = MOCK_ROSTER_SOURCE_LABELS[source];
  return source === 'PRODUCTION_STUDENTS'
    ? `今回使う名簿：${label}\n`
      + '実在の生徒の氏名が「承認待ち」「申請項目」「検査結果」「フォーム回答原本」に入ります。'
      + '「開発用の疑似データをすべて削除」で消えます。'
      + '実在の生徒を使いたくない場合は、「疑似データの対象範囲を設定」で'
      + `「${MOCK_ROSTER_SOURCE_LABELS.MOCK_STUDENTS}」へ変えてください。\n\n`
    : `今回使う名簿：${label}（実在しない生徒だけを使います）\n\n`;
}

export function initializeDevelopmentWorkbook(): void {
  if (!allowFeature('mock.initialize')) return;
  const ui = SpreadsheetApp.getUi();
  const config = prepareMockDataSettingsData();
  const rosterSource = readMockRosterSourceSetting();
  const gradeText = formatSelectedNumbers(config.targetGrades, '年');
  const classText = formatSelectedNumbers(config.targetClasses, '組');
  const formText = config.targetFormTypes.map((type) => type === 'normal' ? '通常フォーム' : '修正フォーム').join('・');
  const answer = ui.alert(
    '開発用の疑似データを作る',
    'この機能は、作成済みの通常フォームと修正フォームをもとに、実在しない回答を作って操作を練習・確認するためのものです。先にフォーム下書きを作成してください。\n\n'
      + 'フォームから読み取るもの：競技、選手枠、走順、必須・任意、通常・修正フォームの区別。\n\n'
      + `作成対象：${gradeText}の${classText}\n使用するフォーム：${formText}\n作成する疑似申請：${config.submissionCount}件（エラーを含む申請${config.errorSubmissionCount}件、警告を含む申請${config.warningSubmissionCount}件）\n\n`
      + mockRosterNotice(rosterSource)
      + '対象を変えたい場合は、いったん「いいえ」を押し、メニューの「疑似データの対象範囲を設定」で学年とクラスをチェックしてください。\n\n'
      + (rosterSource === 'PRODUCTION_STUDENTS'
        ? '置き換わるもの：現在の「フォーム回答原本」「承認待ち」「申請項目」「検査結果」。承認履歴も空になります。「疑似生徒マスター」には書き込みません。\n\n'
        : '置き換わるもの：現在の「疑似生徒マスター」「フォーム回答原本」「承認待ち」「申請項目」「検査結果」。承認履歴も空になります。\n\n')
      + '変更しないもの：Googleフォーム、登録データ、帳票、本番用の「生徒マスター」。\n\n'
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
  // 満たせなかったルールや、意図的なエラー・警告の作り方はトーストでは読み切れないので別に出す。
  const notices = result.mockGenerationNotices ?? [];
  if (notices.length > 0) {
    ui.alert(
      '疑似データを作成しました（確認してほしいことがあります）',
      `${notices.join('\n\n')}\n\n疑似申請そのものは作成済みです。ルール設定を直したい場合は、直してから作り直してください。`,
      ui.ButtonSet.OK,
    );
  }
  showDashboard();
}

export function addMockCorrectionSubmissions(): void {
  if (!allowFeature('mock.addCorrections')) return;
  const ui = SpreadsheetApp.getUi();
  const response = ui.prompt(
    '疑似の修正申請を追加する',
    '今ある疑似申請・承認履歴を残したまま、修正フォームが追加送信された想定の申請を作ります。\n\n'
      + `${mockRosterNotice(readMockRosterSourceSetting())}`
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
  const rosterSource = readMockRosterSourceSetting();
  const gradeText = formatSelectedNumbers(config.targetGrades, '年');
  const classText = formatSelectedNumbers(config.targetClasses, '組');
  const formText = config.targetFormTypes.map((type) => type === 'normal' ? '通常フォーム' : '修正フォーム').join('・');
  const book = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = book.getSheetByName('疑似データ設定');
  if (!sheet) throw new Error('「疑似データ設定」シートを作成できませんでした。');
  book.setActiveSheet(sheet);
  SpreadsheetApp.getUi().alert(
    '疑似データの対象範囲を設定',
    `現在の対象は「${gradeText}の${classText}」、使用するフォームは「${formText}」です。作成する疑似申請は${config.submissionCount}件です。\n\n`
      + `${mockRosterNotice(rosterSource)}`
      + '緑色の行で学年、青色の行でクラス、紫色の行で通常フォーム・修正フォームをチェックしてください。通常フォームは各クラスにつき1回答だけ作ります。両方にチェックした場合、各クラスの最初の1回答を通常フォーム、その後を修正フォームとして作ります。修正フォームだけの場合は、対象範囲の生徒数と同じ件数を作ります。\n\n'
      + '黄色の行ではエラー・警告を含む申請数を変更できます。\n\n'
      + 'ピンク色の行では、疑似申請の選手をどちらの名簿から選ぶかを変えられます。'
      + '疑似申請がすでにある状態でここを変えると、作り直すまで再検査・承認・名簿作成ができなくなります。\n\n'
      + '変更後、メニューから「開発用の疑似データを作る」を実行してください。',
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
  if (!allowFeature('mock.delete')) return;
  const ui = SpreadsheetApp.getUi();
  const answer = ui.alert(
    '開発用の疑似データをすべて削除',
    'このボタンは、動作確認のために作成した疑似データを空に戻します。\n\n'
      + '削除するもの：疑似生徒マスター、mock-responseで始まる疑似フォーム回答、それに対応する承認待ち、申請項目、検査結果、承認履歴、変更履歴。\n\n'
      + '残すもの：通常フォーム、修正フォーム、formsフォルダ、競技設定、ルール設定、フォーム設計、フォーム項目対応表、登録データ、帳票、本番用の「生徒マスター」。\n\n'
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

/** 実機テストの対象クラスを聞き、事前入力URLを作る。 */
export function prepareLiveFormTest(): void {
  if (!allowFeature('liveTest.prepare')) return;
  const ui = SpreadsheetApp.getUi();
  const answer = ui.prompt(
    '実機テストを準備',
    '本物のGoogleフォームへテスト送信するクラスを、「3年8組」のように入力してください。\n\n'
      + '入力者は実在しない番号（9999）と「実機テスト（削除予定）」で送信します。'
      + 'テストの申請は承認待ちへ実際に追加されるため、確認後に「テストの申請を片付ける」で削除してください。\n\n'
      + 'まだ申請のないクラスを選ぶことをおすすめします。',
    ui.ButtonSet.OK_CANCEL,
  );
  if (answer.getSelectedButton() !== ui.Button.OK) return;
  const match = answer.getResponseText().trim().match(/^([1-3])年([1-8])組$/);
  if (!match) {
    ui.alert('入力を確認してください', '「3年8組」のように、学年と組を入力してください。', ui.ButtonSet.OK);
    return;
  }
  const grade = Number(match[1]);
  const classNumber = Number(match[2]);
  let result;
  try {
    result = prepareLiveFormTestData(grade, classNumber);
  } catch (error) {
    const message = error instanceof Error ? error.message : '準備できませんでした。';
    const retry = message.includes('すでに申請')
      ? ui.alert('このクラスには申請があります', `${message}\n\nそれでもこのクラスでテストしますか。`, ui.ButtonSet.YES_NO)
      : ui.Button.NO;
    if (retry !== ui.Button.YES) {
      ui.alert('実機テストを準備できませんでした', message, ui.ButtonSet.OK);
      return;
    }
    result = prepareLiveFormTestData(grade, classNumber, true);
  }
  ui.alert('実機テストの準備が終わりました', result.message, ui.ButtonSet.OK);
}

/** 実機テストを自動送信する。フォーム画面を開かずに本物の回答を投入する。 */
export function submitLiveFormTest(): void {
  if (!allowFeature('liveTest.submit')) return;
  const ui = SpreadsheetApp.getUi();
  const state = describeLiveFormTestState();
  const answer = ui.alert(
    'テストを自動送信します',
    `用意したテスト${state.caseCount}件を、本物のフォームへ送信します。\n\n`
      + '送信すると承認待ちへテストの申請が追加されます。実行しますか。',
    ui.ButtonSet.YES_NO,
  );
  if (answer !== ui.Button.YES) return;
  const result = submitLiveFormTestData();
  ui.alert('自動送信が終わりました', result.message, ui.ButtonSet.OK);
}

/** 送信済みのテストについて、取込結果と検査結果を照合する。 */
export function collectLiveFormTest(): void {
  if (!allowFeature('liveTest.collect')) return;
  const ui = SpreadsheetApp.getUi();
  const result = collectLiveFormTestData();
  ui.alert('照合が終わりました', `${result.message}\n\n詳しい差分は「実機テスト」シートの「判定」「差分」列を確認してください。`, ui.ButtonSet.OK);
}

/** 実機テストで作られた申請と回答原本を削除する。承認履歴は監査のため残す。 */
export function cleanupLiveFormTest(): void {
  if (!allowFeature('liveTest.cleanup')) return;
  const ui = SpreadsheetApp.getUi();
  const state = describeLiveFormTestState();
  const answer = ui.alert(
    'テストの申請を片付けます',
    `承認待ちのテスト申請${state.pendingCleanupCount}件と、その回答原本・検査結果を削除します。\n\n`
      + '生徒マスター、設定、フォーム、本物の申請は削除しません。承認履歴は監査のため残します。\n\n実行しますか。',
    ui.ButtonSet.YES_NO,
  );
  if (answer !== ui.Button.YES) return;
  const result = cleanupLiveFormTestData();
  ui.alert('片付けが終わりました', result.message, ui.ButtonSet.OK);
  showDashboard();
}

/** clasp run用。個人情報を返さず、実機テストの準備結果だけを確認する。 */
export function prepareLiveFormTestForClasp(
  targetGrade: number,
  targetClass: number,
  allowExistingClassData = false,
): ReturnType<typeof prepareLiveFormTestData> {
  return prepareLiveFormTestData(targetGrade, targetClass, allowExistingClassData);
}

/** clasp run用。自動送信と取込経路の測定結果を返す。 */
export function submitLiveFormTestForClasp(): ReturnType<typeof submitLiveFormTestData> {
  return submitLiveFormTestData();
}

/** clasp run用。判定と差分だけを返し、氏名・学籍番号は返さない。 */
export function collectLiveFormTestForClasp(): ReturnType<typeof collectLiveFormTestData> {
  return collectLiveFormTestData();
}

/** clasp run用。テスト申請の後片付けを行う。 */
export function cleanupLiveFormTestForClasp(): ReturnType<typeof cleanupLiveFormTestData> {
  return cleanupLiveFormTestData();
}

export function revalidateAll(): void {
  if (!allowFeature('review.revalidate')) return;
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

export function importCorrectionSlots(
  correctionSubmissionId: string,
  targetSubmissionId: string,
  correctionItemIds: string[],
  reason: string
): ReturnType<typeof importCorrectionSlotsData> {
  return importCorrectionSlotsData(correctionSubmissionId, targetSubmissionId, correctionItemIds, reason);
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
  if (!allowFeature('roster.create')) return;
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

export function createPlayerRostersFromDiff(): void {
  if (!allowFeature('roster.createDiff')) return;
  const ui = SpreadsheetApp.getUi();
  const preview = loadPlayerRosterDiff();
  if (!preview.canRun) {
    ui.alert('変更点だけを反映して選手名簿を作成', preview.message, ui.ButtonSet.OK);
    return;
  }
  // 競技が多いときはダイアログが読めなくなるため、先頭だけを出して残りは件数にする。
  const eventNames = preview.affectedEventNames.slice(0, 12);
  const rest = preview.affectedEventNames.length - eventNames.length;
  const events = eventNames.length > 0
    ? `\n\n書き直す競技：${eventNames.join('、')}${rest > 0 ? ` ほか${rest}件` : ''}`
    : '';
  const answer = ui.alert(
    '変更点だけを反映して選手名簿を作成',
    `${preview.message}${events}\n\n`
      + `前回の版「${preview.baseVersionName}」のファイルを複製し、変わったページだけを書き直して`
      + `「${preview.nextVersionName}」を作ります。名前は前回と同じものを引き継ぎます。\n\n`
      + '前回までの版のフォルダはそのまま残ります。クラス配布用PDFだけは差分にできないため作り直します。\n\n'
      + '作成しますか？',
    ui.ButtonSet.YES_NO,
  );
  if (answer !== ui.Button.YES) return;
  const result = createPlayerRostersFromLatestVersionData();
  ui.alert(
    '選手名簿の作成を開始しました',
    `版：${result.versionName}（複製元：${result.baseVersionName}）\n`
      + `変わった選手枠：${result.changedCount}件\n登録予定：${result.registrationCount}件\n\n`
      + `${result.message}\n\n保存先：${result.folderUrl}\n\n`
      + '「名簿作成の状況を確認」で進み具合を確認できます。完了するまで正式データは変更しません。',
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
  if (!allowFeature('roster.resume')) return;
  const status = resumePlayerRosterCreationData();
  SpreadsheetApp.getUi().alert(
    '名簿作成を再開しました',
    `版：${status.versionName}\n進み具合：${status.progress}\n\n自動処理を再開しました。「名簿作成の状況を確認」で確認できます。`,
    SpreadsheetApp.getUi().ButtonSet.OK,
  );
}

export function cancelPlayerRosterCreation(): void {
  if (!allowFeature('roster.cancel')) return;
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
