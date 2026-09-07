import { SCRIPT_PROPERTIES, SHEETS } from '../shared/constants';
import {
  buildProductionMigrationText,
  isRosterStagingSheetName,
  type ProductionMigrationPreview,
} from '../core/system-mode';
import {
  MOCK_ROSTER_SOURCE_LABELS,
  type MockRosterSource,
} from '../core/mock-roster-source';
import {
  assertAuthorized,
  currentEditorEmail,
  isPracticeWorkbook,
  isProductionMode,
  listConfiguredEditorEmails,
  writeSystemMode,
} from './auth-service';
import {
  clearSheetDataRows,
  countSheetDataRows,
  deleteSheetsWhere,
  ensureApplicationSheets,
  isProductionStudentMasterActive,
  readMockRosterSourceSetting,
  readProductionStudents,
  readRosterHistory,
} from './repository';
import { readFormDesign } from './settings-repository';
import { auditManagementSharing } from './security-audit-service';
import { appendSettingsChangeHistory } from './settings-change-service';
import { getPlayerRosterJobStatus } from './roster-service';
import { invalidateSheetCache } from './sheet-cache';

/** 本番開始前に空にするシート。開発中に作った申請・回答・履歴・帳票データはここへ集約されている。 */
const CLEARED_SHEETS = [
  SHEETS.submissions,
  SHEETS.items,
  SHEETS.issues,
  SHEETS.approvals,
  SHEETS.changeHistory,
  SHEETS.rawFormResponses,
  SHEETS.registrations,
  SHEETS.students,
  SHEETS.mockDataSettings,
  SHEETS.rosterHistory,
  SHEETS.liveFormTest,
  SHEETS.settingsIssues,
] as const;

/** 切替後も引き継ぐシート。設定と本番の生徒マスターは消さない。 */
const KEPT_SHEETS = [
  SHEETS.eventSettings,
  SHEETS.ruleSettings,
  SHEETS.formDesign,
  SHEETS.formRegistry,
  SHEETS.settingsChangeHistory,
] as const;

const ROSTER_STATUS_SHEET = '名簿作成状況';

export interface ProductionModeResult {
  mode: 'PRODUCTION';
  actorEmail: string;
  deletedRowCount: number;
  deletedFormResponseCount: number;
  rosterFolderUrls: string[];
  message: string;
}

export interface DevelopmentModeResult {
  mode: 'DEVELOPMENT';
  actorEmail: string;
  /** 開発用モードへ戻した直後に、疑似申請が使う名簿。 */
  rosterSource: MockRosterSource;
  message: string;
}

/** 公開待ちの旧フォームにもテスト回答が残るため、削除対象へ含める。 */
function pendingPreviousFormIds(): string[] {
  const raw = PropertiesService.getDocumentProperties()
    .getProperty(SCRIPT_PROPERTIES.pendingPreviousFormIds);
  if (!raw) return [];
  try {
    return (JSON.parse(raw) as unknown[]).filter((value): value is string => typeof value === 'string');
  } catch {
    return [];
  }
}

function configuredFormIds(): string[] {
  const design = readFormDesign();
  return [...new Set([
    design.normalFormId,
    design.correctionFormId,
    ...pendingPreviousFormIds(),
  ].filter(Boolean))];
}

function countFormResponses(formIds: readonly string[]): number {
  return formIds.reduce((total, formId) => {
    try {
      return total + FormApp.openById(formId).getResponses().length;
    } catch {
      // 削除済み・権限のないフォームは件数0として扱い、確認画面を止めない。
      return total;
    }
  }, 0);
}

function deleteFormResponses(formIds: readonly string[]): number {
  return formIds.reduce((total, formId) => {
    let form: GoogleAppsScript.Forms.Form;
    try {
      form = FormApp.openById(formId);
    } catch {
      return total;
    }
    const count = form.getResponses().length;
    if (count === 0) return total;
    form.deleteAllResponses();
    return total + count;
  }, 0);
}

/** 切替前に、何を消して何を残すかを件数付きで示す。読み取りだけで、データは変更しない。 */
export function describeProductionMigration(): ProductionMigrationPreview & { text: string } {
  assertAuthorized();
  ensureApplicationSheets();
  const rosterFolderUrls = [...new Set(readRosterHistory()
    .map((record) => record.folderUrl)
    .filter((url) => url !== ''))];
  const preview: ProductionMigrationPreview = {
    clearedSheets: [...CLEARED_SHEETS],
    keptSheets: [...KEPT_SHEETS],
    counts: {
      submissions: countSheetDataRows(SHEETS.submissions),
      items: countSheetDataRows(SHEETS.items),
      issues: countSheetDataRows(SHEETS.issues),
      approvals: countSheetDataRows(SHEETS.approvals),
      changes: countSheetDataRows(SHEETS.changeHistory),
      rawResponses: countSheetDataRows(SHEETS.rawFormResponses),
      registrations: countSheetDataRows(SHEETS.registrations),
      mockStudents: countSheetDataRows(SHEETS.students),
      rosterHistory: countSheetDataRows(SHEETS.rosterHistory),
      formResponses: countFormResponses(configuredFormIds()),
    },
    rosterFolderUrls,
    productionStudentCount: countSheetDataRows(SHEETS.productionStudents),
  };
  return { ...preview, text: buildProductionMigrationText(preview) };
}

/** 開発用に作ったデータを本番開始前に消す。承認履歴・変更履歴も含めて空にする。 */
function purgeDevelopmentData(formIds: readonly string[]): {
  deletedRowCount: number;
  deletedFormResponseCount: number;
} {
  const deletedRowCount = CLEARED_SHEETS
    .reduce((total, sheetName) => total + clearSheetDataRows(sheetName), 0)
    + clearSheetDataRows(ROSTER_STATUS_SHEET)
    + clearSheetDataRows(SHEETS.dashboard);
  deleteSheetsWhere(isRosterStagingSheetName);
  const properties = PropertiesService.getDocumentProperties();
  properties.deleteProperty(SCRIPT_PROPERTIES.playerRosterJob);
  properties.deleteProperty(SCRIPT_PROPERTIES.rosterRebuildRequired);
  properties.deleteProperty(SCRIPT_PROPERTIES.pendingPreviousFormIds);
  const deletedFormResponseCount = deleteFormResponses(formIds);
  return { deletedRowCount, deletedFormResponseCount };
}

export function activateProductionMode(): ProductionModeResult {
  assertAuthorized();
  if (isPracticeWorkbook()) {
    throw new Error('練習用コピーを本番モードへ切り替えることはできません。本番ファイルを開いて操作してください。');
  }
  if (isProductionMode()) {
    throw new Error('すでに本番モードです。開発用モードへ戻す場合は「開発用モードへ戻す」を実行してください。');
  }
  if (!isProductionStudentMasterActive()) {
    throw new Error('本番用の「生徒マスター」が空です。学籍番号と氏名を入力し、内容を確認してから切り替えてください。');
  }
  // 入力不足・学籍番号不正・重複を本番切替前に必ず検出する。
  // 名簿の選択を通すと疑似生徒マスターを検証してしまうため、生徒マスターだけを直接読む。
  readProductionStudents();
  const sharing = auditManagementSharing();
  if (sharing.broadSharingCount > 0) throw new Error(sharing.message);
  const rosterJob = getPlayerRosterJobStatus();
  if (rosterJob.active) {
    throw new Error('選手名簿の作成が実行中です。「途中の名簿作成を取り消す」を実行してから、本番モードへ切り替えてください。');
  }
  if (readFormDesign().formStatus === '公開前確認') {
    throw new Error('公開前確認中のフォームがあります。「確認済みフォームを公開」または「公開前フォームを破棄」を実行してから、本番モードへ切り替えてください。');
  }
  const properties = PropertiesService.getScriptProperties();
  let editors = listConfiguredEditorEmails();
  const email = currentEditorEmail();
  if (editors.length === 0) {
    if (!email) throw new Error('担当者のGoogleアカウントを確認できないため、本番モードへ切り替えられません。');
    properties.setProperty(SCRIPT_PROPERTIES.authorizedEditorEmails, email);
    editors = [email];
  }
  if (!email || !editors.includes(email)) {
    throw new Error('現在のGoogleアカウントが担当者一覧にありません。本番切替は登録済み担当者が実行してください。');
  }
  const lock = LockService.getDocumentLock();
  if (!lock.tryLock(30_000)) throw new Error('ほかの担当者が処理中です。少し待ってから、もう一度実行してください。');
  // ロックを取った直後は、ほかの担当者やトリガーが書いた内容を必ず読み直す。
  invalidateSheetCache();
  try {
    ensureApplicationSheets();
    const rosterFolderUrls = [...new Set(readRosterHistory()
      .map((record) => record.folderUrl)
      .filter((url) => url !== ''))];
    const formIds = configuredFormIds();
    // 先に開発用データを消し、消し終わってからモードを切り替える。途中で失敗したら開発用モードのまま残す。
    const purged = purgeDevelopmentData(formIds);
    writeSystemMode('PRODUCTION');
    appendSettingsChangeHistory(
      '本番モードへ切替',
      `開発用データを削除して本番運用を開始（${purged.deletedRowCount}行、フォーム回答${purged.deletedFormResponseCount}件を削除）`,
      [...CLEARED_SHEETS].join('、'),
    );
    return {
      mode: 'PRODUCTION',
      actorEmail: email,
      deletedRowCount: purged.deletedRowCount,
      deletedFormResponseCount: purged.deletedFormResponseCount,
      rosterFolderUrls,
      message: '本番モードへ切り替えました。開発用の疑似データ'
        + `${purged.deletedRowCount}行と、Googleフォームの回答${purged.deletedFormResponseCount}件を削除しました。`
        + '疑似データの作成・追加・削除は無効になりました。',
    };
  } finally {
    lock.releaseLock();
  }
}

/** 本番モードから開発用モードへ戻す。データは消さず、運用モードだけを戻す。 */
export function revertToDevelopmentMode(reason: string): DevelopmentModeResult {
  const actor = assertAuthorized();
  const trimmedReason = reason.trim();
  if (trimmedReason === '') {
    throw new Error('開発用モードへ戻す理由を入力してください。設定変更履歴へ記録します。');
  }
  if (isPracticeWorkbook()) {
    throw new Error('練習用コピーはもともと開発用モードです。切り替えは不要です。');
  }
  if (!isProductionMode()) {
    throw new Error('すでに開発用モードです。');
  }
  writeSystemMode('DEVELOPMENT');
  appendSettingsChangeHistory('開発用モードへ戻す', trimmedReason, SHEETS.systemConfig);
  const rosterSource = readMockRosterSourceSetting();
  return {
    mode: 'DEVELOPMENT',
    actorEmail: actor,
    rosterSource,
    message: '開発用モードへ戻しました。申請・登録データ・履歴は消していません。\n\n'
      + '疑似データの機能を使えます。'
      + `疑似申請の選手は、いまの設定では「${MOCK_ROSTER_SOURCE_LABELS[rosterSource]}」から選ばれます。\n\n`
      + '別の名簿を使うときは、メニューの「疑似データの対象範囲を設定」を開き、'
      + '「疑似申請に使う名簿」を変えてください。'
      + '実在の生徒を疑似申請に使いたくない場合は「疑似生徒マスター」のままにします。',
  };
}
