import { SHEETS } from '../shared/constants';
import {
  FEATURE_CATALOG,
  FEATURE_CATEGORY_DESCRIPTIONS,
  FEATURE_CATEGORY_TITLES,
  findFeature,
  type FeatureEntry,
} from '../core/feature-catalog';
import {
  evaluateCatalog,
  evaluateFeature,
  isFeatureVisible,
  type FeatureAvailability,
  type FeatureConditionSnapshot,
  type FeatureVisibilityContext,
} from '../core/feature-availability';
import { MOCK_ROSTER_SOURCE_LABELS } from '../core/mock-roster-source';
import { isDevelopmentMockSubmissionId } from '../core/mock-data-lifecycle';
import { getSystemMode, isPracticeWorkbook } from './mode-probe';
import {
  activeRosterSource,
  isProductionStudentMasterActive,
  readRosterHistory,
  readStudents,
  readSubmissions,
} from './repository';
import { isPlayerRosterJobActive } from './roster-service';
import { readFormDesign } from './settings-repository';
import { isRuleOnlyChangeActive, isSettingsChangeActive } from './settings-change-service';
import { isFormBuildJobActive } from './settings-service';
import { listConfiguredEditorEmails } from './auth-service';

/**
 * メニューを組むときだけに使う軽い文脈。
 *
 * `onOpen`はスプレッドシートを開くたびに走るので、ここでは設定の点検など重い処理を一切しない。
 * 状態による無効化の判定は`buildFeatureConditionSnapshot()`のほうで行う。
 */
export function buildFeatureVisibilityContext(): FeatureVisibilityContext {
  return { mode: getSystemMode(), practiceWorkbook: isPracticeWorkbook() };
}

function isSettingsSheetsReady(): boolean {
  const book = SpreadsheetApp.getActiveSpreadsheet();
  return Boolean(book?.getSheetByName(SHEETS.eventSettings) && book?.getSheetByName(SHEETS.ruleSettings));
}

function settingsErrorCount(): number {
  const sheet = SpreadsheetApp.getActiveSpreadsheet()?.getSheetByName(SHEETS.settingsIssues);
  if (!sheet || sheet.getLastRow() < 2) return 0;
  return sheet.getRange(2, 2, sheet.getLastRow() - 1, 1).getDisplayValues()
    .filter((row) => (row[0] ?? '').indexOf('エラー') >= 0).length;
}

/**
 * サイドバーと機能紹介ダイアログのための、全条件を評価した文脈。
 *
 * 読むのは既にある軽い経路だけにする。設定の再点検（`validateSettings`）はここでは走らせず、
 * 前回の点検結果シートの件数を見る。画面を開くたびに重い処理を走らせないため。
 */
export function buildFeatureConditionSnapshot(): FeatureConditionSnapshot {
  const settingsReady = isSettingsSheetsReady();
  const design = settingsReady ? readFormDesign() : undefined;
  const formsExist = Boolean(design?.normalFormId && design?.correctionFormId);
  const submissions = settingsReady ? readSubmissions() : [];
  // Properties の保存先をここで推測しない。実際に書き込むモジュールの判定関数を
  // そのまま呼び、メニューの有効・無効と実行時の判定が食い違うことを防ぐ。
  const rosterJobActive = isPlayerRosterJobActive();
  const formBuildActive = isFormBuildJobActive();
  const ruleChangeActive = isRuleOnlyChangeActive();
  const settingsChangeActive = isSettingsChangeActive();

  return {
    mode: getSystemMode(),
    practiceWorkbook: isPracticeWorkbook(),
    conditions: {
      SETTINGS_SHEETS_READY: settingsReady,
      SETTINGS_NO_ERROR: settingsReady && settingsErrorCount() === 0,
      FORMS_EXIST: formsExist,
      FORMS_PUBLISHED: design?.formStatus === '公開中',
      DRAFT_FORMS_PREPARED: design?.formStatus === '公開前確認',
      FORM_BUILD_IDLE: !formBuildActive,
      FORM_BUILD_ACTIVE: formBuildActive,
      SETTINGS_CHANGE_IDLE: !settingsChangeActive,
      RULE_CHANGE_ACTIVE: ruleChangeActive,
      RULE_CHANGE_IDLE: !ruleChangeActive,
      ROSTER_JOB_IDLE: !rosterJobActive,
      ROSTER_JOB_ACTIVE: rosterJobActive,
      ROSTER_VERSION_EXISTS: settingsReady && readRosterHistory().length > 0,
      SUBMISSIONS_EXIST: submissions.length > 0,
      APPROVED_SUBMISSIONS_EXIST: submissions.some((submission) =>
        submission.status === 'APPROVED' || submission.status === 'APPLIED'),
      MOCK_SUBMISSIONS_EXIST: submissions.some((submission) =>
        isDevelopmentMockSubmissionId(submission.submissionId)),
      MOCK_ROSTER_READY: settingsReady && readStudents().length > 0,
      PRODUCTION_MASTER_FILLED: isProductionStudentMasterActive(),
      AUTHORIZED_EDITORS_SET: listConfiguredEditorEmails().length > 0,
    },
  };
}

export interface FeatureGuideItem extends FeatureEntry, FeatureAvailability {
  /** 「メニュー：選手登録管理 › 状態別に開く › 警告がある申請」のような道案内。 */
  readonly locationText: string;
}

export interface FeatureGuideCategory {
  readonly key: string;
  readonly title: string;
  readonly description: string;
  readonly features: readonly FeatureGuideItem[];
}

export interface FeatureGuideData {
  readonly modeLabel: string;
  readonly modeNote: string;
  readonly rosterSourceLabel: string;
  readonly usableCount: number;
  readonly visibleCount: number;
  readonly categories: readonly FeatureGuideCategory[];
}

const SIDEBAR_TITLES: Record<'REVIEW' | 'FORM_SETUP', string> = {
  REVIEW: '申請を確認する画面',
  FORM_SETUP: 'フォーム準備の画面',
};

function locationText(entry: FeatureEntry): string {
  return entry.placement.map((placement) => placement.kind === 'MENU'
    ? ['メニュー：選手登録管理', ...placement.path, entry.title].join(' › ')
    : `${SIDEBAR_TITLES[placement.screen]}：${placement.section}`).join(' / ');
}

/** 機能紹介ダイアログが読むデータ。個人情報は一切含めない。 */
export function getFeatureGuideData(): FeatureGuideData {
  const snapshot = buildFeatureConditionSnapshot();
  const availability = evaluateCatalog(snapshot);
  const byId = new Map(availability.map((item) => [item.id, item]));
  const visible = FEATURE_CATALOG
    .map((entry) => ({ entry, state: byId.get(entry.id)! }))
    .filter((pair) => pair.state.visible);

  const categories = (Object.keys(FEATURE_CATEGORY_TITLES) as (keyof typeof FEATURE_CATEGORY_TITLES)[])
    .map((category) => ({
      key: category,
      title: FEATURE_CATEGORY_TITLES[category],
      description: FEATURE_CATEGORY_DESCRIPTIONS[category],
      features: visible
        .filter((pair) => pair.entry.category === category)
        .map(({ entry, state }): FeatureGuideItem => ({
          ...entry, ...state, locationText: locationText(entry),
        })),
    }))
    .filter((category) => category.features.length > 0);

  const production = snapshot.mode === 'PRODUCTION';
  return {
    modeLabel: snapshot.practiceWorkbook ? '練習用コピー' : (production ? '本番モード' : '開発用モード'),
    modeNote: snapshot.practiceWorkbook
      ? 'このファイルは練習用のコピーです。本番のデータには影響しません。'
      : (production
        ? '実在の生徒データを扱っています。疑似データの機能は表示していません。'
        : '疑似データで練習できます。実際の受付を始める前に「本番モードへ切り替える」を実行してください。'),
    rosterSourceLabel: production
      ? MOCK_ROSTER_SOURCE_LABELS.PRODUCTION_STUDENTS
      : MOCK_ROSTER_SOURCE_LABELS[activeRosterSource()],
    usableCount: visible.filter((pair) => pair.state.enabled).length,
    visibleCount: visible.length,
    categories,
  };
}

/**
 * メニューから実行したときに、前提を満たしていなければ理由を出して中止する。
 *
 * GASのメニューには無効化した見た目が無いため、押せてしまう。押した直後に
 * 「先に何をすればよいか」を1行で伝えることで、無効化の代わりにする。
 * 実際の禁止は各サービスの例外が引き続き行う。ここはその手前の案内。
 */
export function describeFeatureBlock(id: string): string {
  const entry = findFeature(id);
  const context = buildFeatureVisibilityContext();
  if (!isFeatureVisible(entry, context)) {
    return context.mode === 'PRODUCTION'
      ? '本番モードでは、この操作は使えません。'
      : 'この管理表では、この操作は使えません。';
  }
  if (entry.requires.length === 0) return '';
  return evaluateFeature(entry, buildFeatureConditionSnapshot()).blockedReason;
}
