import {
  appliesToGrade,
  calculateFormBuildProgress,
  FORM_BUILD_BATCH_BUDGET_MS,
  FORM_BUILD_BATCH_MAX_CHUNKS,
  shouldProcessNextFormBuildChunk,
  validateSettings,
  type SettingsValidationResult,
} from '../core/settings';
import { inspectFormStructure } from '../core/form-structure';
import { SCRIPT_PROPERTIES, SHEETS } from '../shared/constants';
import type { EventSetting, FormDesignSetting, SettingsIssue, Student } from '../shared/types';
import { readStudents } from './repository';
import {
  addCorrectionEventChunk,
  addCorrectionFormBase,
  addNormalEventChunk,
  addNormalFormBase,
  addNormalGradePage,
  finalizeCorrectionFormBranches,
  finalizeNormalFormBranches,
  initializeDraftForms,
} from './form-builder';
import {
  addCorrectionEventChunkViaApi,
  addCorrectionFormBaseViaApi,
  addNormalEventChunkViaApi,
  addNormalFormBaseViaApi,
  addNormalGradePageViaApi,
  finalizeCorrectionFormViaApi,
  finalizeNormalFormViaApi,
} from './forms-api-builder';
import {
  ensureSettingsSheets,
  getSettingsSheet,
  readEventSettings,
  readFormDesign,
  readFormRegistry,
  readRuleSettings,
  prepareFormDesignDeadlineInput,
  replaceSettingsIssues,
  seedDefaultSettings,
  syncRuleEventCheckboxes,
  writeFormDesign,
} from './settings-repository';
import {
  installGeneratedFormTriggers,
  removeGeneratedFormTriggers,
  retireGeneratedForms,
} from './form-trigger';
import {
  assertAuthorized,
  getPracticeRootFolderId,
  isPracticeWorkbook,
} from './auth-service';
import {
  auditPendingSettingsChange,
  cancelPublishedSettingsChange,
  completePublishedSettingsChange,
  isSettingsChangeActive,
} from './settings-change-service';

export interface DraftBuildResult {
  message: string;
  normalEditUrl: string;
  correctionEditUrl: string;
  formsFolderUrl: string;
}

export interface PublishFormsResult {
  normalPublishedUrl: string;
  correctionPublishedUrl: string;
  message: string;
}

export interface DiscardDraftFormsResult {
  message: string;
}

export interface SettingsDashboardData {
  setupRequired: boolean;
  year: number;
  formStatus: string;
  enabledEventCount: number;
  enabledRuleCount: number;
  warningCount: number;
  errorCount: number;
  canBuildDraft: boolean;
  normalEditUrl: string;
  correctionEditUrl: string;
  formsFolderUrl: string;
  formBuildActive: boolean;
  formBuildStatus: '' | 'RUNNING' | 'ERROR';
  formBuildProgress: string;
  formBuildMessage: string;
  formBuildUpdatedAt: string;
  formBuildCompleted: number;
  formBuildTotal: number;
  formBuildPercent: number;
  issues: SettingsIssue[];
}

type FormBuildPhase = 'NORMAL_BASE' | 'NORMAL_EVENTS' | 'NORMAL_FINAL'
  | 'CORRECTION_BASE' | 'CORRECTION_EVENTS' | 'CORRECTION_FINAL' | 'FINALIZE';

interface FormBuildJob {
  jobId: string;
  status: 'RUNNING' | 'ERROR';
  phase: FormBuildPhase;
  eventIds: string[];
  settingsSignature: string;
  previousFormIds: string[];
  normalFormId: string;
  correctionFormId: string;
  normalEditUrl: string;
  correctionEditUrl: string;
  formsFolderId: string;
  formsFolderUrl: string;
  normalQuestionId: number;
  normalGrade: number;
  normalEventIndex: number;
  normalPageIds: number[];
  correctionQuestionId: number;
  correctionEventIndex: number;
  correctionPageIds: number[];
  buildMode?: 'FORMS_API_V1';
  apiSeed?: string;
  normalApiItemCount?: number;
  correctionApiItemCount?: number;
  normalQuestionApiId?: string;
  correctionQuestionApiId?: string;
  normalPageApiIds?: string[];
  correctionPageApiIds?: string[];
  enabledEventCount?: number;
  enabledRuleCount?: number;
  warningCount?: number;
  errorCount?: number;
  message: string;
  updatedAt: string;
}

interface DraftFormHandles {
  normal?: GoogleAppsScript.Forms.Form;
  correction?: GoogleAppsScript.Forms.Form;
}

const FORM_BUILD_JOB_PROPERTY = 'FORM_BUILD_JOB_V1';
const FORM_BUILD_TRIGGER_HANDLER = 'continueDraftFormCreation';

export function getSettingsDashboardData(): SettingsDashboardData {
  assertAuthorized();
  const spreadsheet = SpreadsheetApp.getActiveSpreadsheet();
  const required = [SHEETS.eventSettings, SHEETS.ruleSettings, SHEETS.formDesign];
  if (required.some((name) => !spreadsheet.getSheetByName(name))) {
    return {
      setupRequired: true, year: new Date().getFullYear(), formStatus: '未作成',
      enabledEventCount: 0, enabledRuleCount: 0, warningCount: 0, errorCount: 0,
      canBuildDraft: false, normalEditUrl: '', correctionEditUrl: '', formsFolderUrl: '',
      formBuildActive: false, formBuildStatus: '', formBuildProgress: '', formBuildMessage: '',
      formBuildUpdatedAt: '', formBuildCompleted: 0, formBuildTotal: 0, formBuildPercent: 0,
      issues: [],
    };
  }
  const job = loadFormBuildJob();
  if (job) {
    const design = readFormDesign();
    const events = readEventSettings();
    const progress = calculateFormBuildProgress({
      phase: job.phase,
      eventIds: job.eventIds,
      normalGrade: job.normalGrade,
      normalEventIndex: job.normalEventIndex,
      normalPageCount: job.buildMode === 'FORMS_API_V1'
        ? (job.normalPageApiIds?.length ?? 0) : job.normalPageIds.length,
      correctionEventIndex: job.correctionEventIndex,
    }, events);
    return {
      setupRequired: false, year: design.year, formStatus: design.formStatus,
      enabledEventCount: job.enabledEventCount ?? job.eventIds.length,
      enabledRuleCount: job.enabledRuleCount ?? 0,
      warningCount: job.warningCount ?? 0, errorCount: job.errorCount ?? 0,
      canBuildDraft: false,
      normalEditUrl: design.normalEditUrl, correctionEditUrl: design.correctionEditUrl,
      formsFolderUrl: design.formsFolderUrl,
      formBuildActive: true, formBuildStatus: job.status,
      formBuildProgress: formBuildProgress(job), formBuildMessage: job.message,
      formBuildUpdatedAt: job.updatedAt, formBuildCompleted: progress.completed,
      formBuildTotal: progress.total, formBuildPercent: progress.percent, issues: [],
    };
  }
  prepareFormDesignDeadlineInput();
  const design = readFormDesign();
  const events = readEventSettings();
  const rules = readRuleSettings();
  const result = validateSettings(events, rules, design, studentContext());
  const warningCount = result.eventWarningCount + result.ruleWarningCount + result.formWarningCount;
  const errorCount = result.eventErrorCount + result.ruleErrorCount + result.formErrorCount;
  return {
    setupRequired: false, year: design.year, formStatus: design.formStatus,
    enabledEventCount: events.filter((event) => event.enabled && event.year === design.year).length,
    enabledRuleCount: rules.filter((rule) => rule.enabled).length,
    warningCount, errorCount,
    canBuildDraft: errorCount === 0 && design.formStatus !== '公開前確認',
    normalEditUrl: design.normalEditUrl, correctionEditUrl: design.correctionEditUrl,
    formsFolderUrl: design.formsFolderUrl,
    formBuildActive: false, formBuildStatus: '', formBuildProgress: '', formBuildMessage: '',
    formBuildUpdatedAt: '', formBuildCompleted: 0, formBuildTotal: 0, formBuildPercent: 0,
    issues: result.issues,
  };
}

export function prepareSettingsFromUi(): SettingsDashboardData {
  initializeSettings();
  return getSettingsDashboardData();
}

export function validateSettingsFromUi(): SettingsDashboardData {
  validateAndRenderSettings();
  return getSettingsDashboardData();
}

export function buildDraftFormsFromUi(): SettingsDashboardData {
  buildDraftForms();
  return getSettingsDashboardData();
}

export function publishDraftFormsFromUi(): SettingsDashboardData {
  publishDraftForms();
  return getSettingsDashboardData();
}

export function discardPreparedFormsFromUi(): SettingsDashboardData {
  discardPreparedForms();
  return getSettingsDashboardData();
}

export function initializeSettings(): SettingsValidationResult {
  assertAuthorized();
  seedDefaultSettings();
  return validateAndRenderSettings();
}

export function validateAndRenderSettings(): SettingsValidationResult {
  assertAuthorized();
  ensureSettingsSheets();
  const design = readFormDesign();
  const result = validateSettings(readEventSettings(), readRuleSettings(), design, studentContext());
  replaceSettingsIssues(result.issues);
  renderSettingsDashboard(result, design.year, design.formStatus);
  return result;
}

export function buildDraftForms(): DraftBuildResult {
  assertAuthorized();
  const lock = LockService.getDocumentLock();
  if (!lock.tryLock(30_000)) throw new Error('ほかの担当者が設定を処理中です。少し待ってから、もう一度実行してください。');
  try {
    const design = readFormDesign();
    if (design.formStatus === '公開前確認') {
      throw new Error('公開前確認中のフォームがあります。公開するか「公開前フォームを破棄」してから作り直してください。');
    }
    const events = readEventSettings();
    const rules = readRuleSettings();
    const result = validateSettings(events, rules, design, studentContext());
    replaceSettingsIssues(result.issues);
    const errors = result.eventErrorCount + result.ruleErrorCount + result.formErrorCount;
    if (errors > 0) {
      renderSettingsDashboard(result, design.year, design.formStatus);
      throw new Error(`設定にエラーが${errors}件あるため、フォームを作成できません。「設定点検結果」シートで直し方を確認してください。`);
    }
    if (loadFormBuildJob()) {
      throw new Error('フォームを作成中です。設定画面に表示される進み具合を確認してください。');
    }
    auditPendingSettingsChange();
    const enabledEvents = enabledEventsForBuild(events, design);
    const warningCount = result.eventWarningCount + result.ruleWarningCount + result.formWarningCount;
    const built = initializeDraftForms(design);
    const job: FormBuildJob = {
      jobId: Utilities.getUuid(), status: 'RUNNING', phase: 'NORMAL_BASE',
      eventIds: enabledEvents.map((event) => event.eventId),
      settingsSignature: settingsSignature(enabledEvents, design),
      previousFormIds: [design.normalFormId, design.correctionFormId].filter(Boolean),
      ...built,
      normalQuestionId: 0, normalGrade: 1, normalEventIndex: 0, normalPageIds: [],
      correctionQuestionId: 0, correctionEventIndex: 0, correctionPageIds: [],
      buildMode: 'FORMS_API_V1', apiSeed: Utilities.getUuid(),
      normalApiItemCount: 0, correctionApiItemCount: 0,
      normalPageApiIds: [], correctionPageApiIds: [],
      enabledEventCount: enabledEvents.length,
      enabledRuleCount: rules.filter((rule) => rule.enabled).length,
      warningCount, errorCount: errors,
      message: '通常フォームの基本項目を準備しています。', updatedAt: new Date().toISOString(),
    };
    saveFormBuildJob(job);
    scheduleFormBuildContinuation();
    renderSettingsDashboard(result, design.year, '作成中');
    return {
      message: 'フォーム下書きの分割作成を開始しました。設定画面を開いたまま進み具合を確認できます。',
      normalEditUrl: '', correctionEditUrl: '', formsFolderUrl: built.formsFolderUrl,
    };
  } finally {
    lock.releaseLock();
  }
}

export function continueDraftFormCreation(): void {
  assertAuthorized();
  const lock = LockService.getDocumentLock();
  if (!lock.tryLock(1_000)) {
    scheduleFormBuildContinuation();
    return;
  }
  try {
    const job = loadFormBuildJob();
    if (!job || job.status !== 'RUNNING') {
      clearFormBuildTriggers();
      return;
    }
    try {
      const orderedEvents = orderedEventsForJob(job);
      const formHandles: DraftFormHandles = {};
      const startedAt = Date.now();
      let completedChunks = 0;
      while (shouldProcessNextFormBuildChunk(
        completedChunks, Date.now() - startedAt,
        FORM_BUILD_BATCH_MAX_CHUNKS, FORM_BUILD_BATCH_BUDGET_MS,
      )) {
        processFormBuildChunk(job, orderedEvents, formHandles);
        completedChunks += 1;
        job.updatedAt = new Date().toISOString();
        // 競技ごとに保存するため、後続処理が失敗しても完了済み地点から再開できる。
        saveFormBuildJob(job);
        if (job.phase === 'FINALIZE') {
          finalizeFormBuild(job);
          return;
        }
      }
    } catch (error) {
      job.status = 'ERROR';
      job.message = `作成を中断しました：${error instanceof Error ? error.message : String(error)}`;
      job.updatedAt = new Date().toISOString();
      saveFormBuildJob(job);
      clearFormBuildTriggers();
      return;
    }
    scheduleFormBuildContinuation();
  } finally {
    lock.releaseLock();
  }
}

export function resumeDraftFormCreation(): SettingsDashboardData {
  assertAuthorized();
  const job = loadFormBuildJob();
  if (!job) throw new Error('再開できるフォーム作成処理はありません。');
  job.status = 'RUNNING';
  job.message = '中断した場所からフォーム作成を再開します。';
  job.updatedAt = new Date().toISOString();
  saveFormBuildJob(job);
  scheduleFormBuildContinuation();
  return getSettingsDashboardData();
}

/**
 * サイドバーを開いている間は時間主導トリガーの遅延を待たず、画面側から最大8区切り進める。
 * DocumentLockによりバックグラウンド処理との二重実行を防ぐ。
 */
export function advanceDraftFormCreationFromUi(): SettingsDashboardData {
  continueDraftFormCreation();
  return getSettingsDashboardData();
}

export function cancelDraftFormCreation(): SettingsDashboardData {
  assertAuthorized();
  const lock = LockService.getDocumentLock();
  if (!lock.tryLock(30_000)) throw new Error('フォーム作成処理が動いています。少し待ってから取り消してください。');
  try {
    const job = loadFormBuildJob();
    clearFormBuildTriggers();
    if (job) {
      const jobFormIds = [job.normalFormId, job.correctionFormId];
      assertPracticeManagedFormIds(jobFormIds);
      retireGeneratedForms(jobFormIds);
    }
    clearFormBuildJob();
    validateAndRenderSettings();
    return getSettingsDashboardData();
  } finally {
    lock.releaseLock();
  }
}

function orderedEventsForJob(job: FormBuildJob): EventSetting[] {
  const design = readFormDesign();
  const allEvents = readEventSettings();
  const events = enabledEventsForBuild(allEvents, design);
  if (settingsSignature(events, design) !== job.settingsSignature) {
    throw new Error('作成開始後に競技設定またはフォーム設計が変更されました。「途中の作成を取り消す」後、作り直してください。');
  }
  const eventById = new Map(events.map((event) => [event.eventId, event]));
  return job.eventIds.map((id) => eventById.get(id)).filter((event): event is EventSetting => Boolean(event));
}

function processFormBuildChunk(
  job: FormBuildJob,
  orderedEvents: EventSetting[],
  forms: DraftFormHandles,
): void {
  if (job.buildMode === 'FORMS_API_V1') {
    processFormsApiBuildChunk(job, orderedEvents);
    return;
  }
  if (job.phase === 'NORMAL_BASE') {
    job.normalQuestionId = addNormalFormBase(draftForm(forms, 'normal', job.normalFormId));
    job.phase = 'NORMAL_EVENTS';
    job.message = '通常フォームの1年の項目を作っています。';
    return;
  }
  if (job.phase === 'NORMAL_EVENTS') {
    while (job.normalGrade <= 3) {
      if (job.normalPageIds.length < job.normalGrade) {
        job.normalPageIds.push(addNormalGradePage(draftForm(forms, 'normal', job.normalFormId), job.normalGrade));
        job.message = `通常フォームの${job.normalGrade}年ページを作りました。`;
        return;
      }
      const gradeEvents = orderedEvents.filter((event) => appliesToGrade(event, job.normalGrade));
      if (job.normalEventIndex < gradeEvents.length) {
        const event = gradeEvents[job.normalEventIndex]!;
        addNormalEventChunk(draftForm(forms, 'normal', job.normalFormId), event);
        job.normalEventIndex += 1;
        job.message = `通常フォーム：${job.normalGrade}年「${event.eventName}」まで作成しました。`;
        return;
      }
      job.normalGrade += 1;
      job.normalEventIndex = 0;
    }
    job.phase = 'NORMAL_FINAL';
    job.message = '通常フォームの分岐を設定します。';
    return;
  }
  if (job.phase === 'NORMAL_FINAL') {
    finalizeNormalFormBranches(
      draftForm(forms, 'normal', job.normalFormId), job.normalQuestionId, job.normalPageIds,
    );
    job.phase = 'CORRECTION_BASE';
    job.message = '通常フォームが完成しました。修正フォームを作り始めます。';
    return;
  }
  if (job.phase === 'CORRECTION_BASE') {
    job.correctionQuestionId = addCorrectionFormBase(draftForm(forms, 'correction', job.correctionFormId));
    job.phase = 'CORRECTION_EVENTS';
    job.message = '修正フォームの競技項目を作っています。';
    return;
  }
  if (job.phase === 'CORRECTION_EVENTS') {
    if (job.correctionEventIndex >= orderedEvents.length) {
      job.phase = 'CORRECTION_FINAL';
      return;
    }
    const event = orderedEvents[job.correctionEventIndex]!;
    job.correctionPageIds.push(addCorrectionEventChunk(
      draftForm(forms, 'correction', job.correctionFormId), event,
    ));
    job.correctionEventIndex += 1;
    job.message = `修正フォーム：「${event.eventName}」まで作成しました。`;
    return;
  }
  if (job.phase === 'CORRECTION_FINAL') {
    finalizeCorrectionFormBranches(
      draftForm(forms, 'correction', job.correctionFormId),
      job.correctionQuestionId, orderedEvents, job.correctionPageIds,
    );
    job.phase = 'FINALIZE';
    job.message = '2つのフォームを正式な下書きとして切り替えています。';
  }
}

function processFormsApiBuildChunk(job: FormBuildJob, orderedEvents: EventSetting[]): void {
  const seed = job.apiSeed ?? job.jobId;
  if (job.phase === 'NORMAL_BASE') {
    const result = addNormalFormBaseViaApi(job.normalFormId, seed, job.normalApiItemCount ?? 0);
    job.normalApiItemCount = result.nextIndex;
    job.normalQuestionApiId = result.questionId;
    job.phase = 'NORMAL_EVENTS';
    job.message = '通常フォームの基本項目を高速作成しました。1年の項目を作っています。';
    return;
  }
  if (job.phase === 'NORMAL_EVENTS') {
    while (job.normalGrade <= 3) {
      const pageIds = job.normalPageApiIds ?? [];
      job.normalPageApiIds = pageIds;
      if (pageIds.length < job.normalGrade) {
        const result = addNormalGradePageViaApi(
          job.normalFormId, seed, job.normalApiItemCount ?? 0, job.normalGrade,
        );
        job.normalApiItemCount = result.nextIndex;
        pageIds.push(result.pageId);
        job.message = `通常フォームの${job.normalGrade}年ページを高速作成しました。`;
        return;
      }
      const gradeEvents = orderedEvents.filter((event) => appliesToGrade(event, job.normalGrade));
      if (job.normalEventIndex < gradeEvents.length) {
        const event = gradeEvents[job.normalEventIndex]!;
        job.normalApiItemCount = addNormalEventChunkViaApi(
          job.normalFormId, seed, job.normalApiItemCount ?? 0, job.normalGrade, event,
        );
        job.normalEventIndex += 1;
        job.message = `通常フォーム：${job.normalGrade}年「${event.eventName}」を一括作成しました。`;
        return;
      }
      job.normalGrade += 1;
      job.normalEventIndex = 0;
    }
    job.phase = 'NORMAL_FINAL';
    job.message = '通常フォームの分岐と学籍番号の入力検査を設定します。';
    return;
  }
  if (job.phase === 'NORMAL_FINAL') {
    finalizeNormalFormViaApi(
      job.normalFormId,
      requiredApiId(job.normalQuestionApiId),
      job.normalPageApiIds ?? [],
    );
    job.phase = 'CORRECTION_BASE';
    job.message = '通常フォームが完成しました。修正フォームを作り始めます。';
    return;
  }
  if (job.phase === 'CORRECTION_BASE') {
    const result = addCorrectionFormBaseViaApi(job.correctionFormId, seed, job.correctionApiItemCount ?? 0);
    job.correctionApiItemCount = result.nextIndex;
    job.correctionQuestionApiId = result.questionId;
    job.phase = 'CORRECTION_EVENTS';
    job.message = '修正フォームの競技項目を高速作成しています。';
    return;
  }
  if (job.phase === 'CORRECTION_EVENTS') {
    if (job.correctionEventIndex >= orderedEvents.length) {
      job.phase = 'CORRECTION_FINAL';
      return;
    }
    const event = orderedEvents[job.correctionEventIndex]!;
    const result = addCorrectionEventChunkViaApi(
      job.correctionFormId, seed, job.correctionApiItemCount ?? 0, event,
    );
    job.correctionApiItemCount = result.nextIndex;
    const pageIds = job.correctionPageApiIds ?? [];
    pageIds.push(result.pageId);
    job.correctionPageApiIds = pageIds;
    job.correctionEventIndex += 1;
    job.message = `修正フォーム：「${event.eventName}」を一括作成しました。`;
    return;
  }
  if (job.phase === 'CORRECTION_FINAL') {
    finalizeCorrectionFormViaApi(
      job.correctionFormId,
      requiredApiId(job.correctionQuestionApiId),
      orderedEvents,
      job.correctionPageApiIds ?? [],
    );
    job.phase = 'FINALIZE';
    job.message = '2つのフォームを正式な下書きとして切り替えています。';
  }
}

function requiredApiId(value: string | undefined): string {
  if (!value) throw new Error('フォーム作成の再開位置を確認できません。途中の作成を取り消して作り直してください。');
  return value;
}

function draftForm(
  handles: DraftFormHandles,
  type: 'normal' | 'correction',
  formId: string,
): GoogleAppsScript.Forms.Form {
  const existing = handles[type];
  if (existing) return existing;
  const opened = FormApp.openById(formId);
  handles[type] = opened;
  return opened;
}

function finalizeFormBuild(job: FormBuildJob): void {
  const design = readFormDesign();
  PropertiesService.getDocumentProperties().setProperty(
    SCRIPT_PROPERTIES.pendingPreviousFormIds,
    JSON.stringify(job.previousFormIds),
  );
  writeFormDesign({
    ...design, formStatus: '公開前確認', normalFormId: job.normalFormId,
    correctionFormId: job.correctionFormId, normalEditUrl: job.normalEditUrl,
    correctionEditUrl: job.correctionEditUrl, formsFolderId: job.formsFolderId,
    formsFolderUrl: job.formsFolderUrl,
  });
  clearFormBuildTriggers();
  clearFormBuildJob();
  const result = validateSettings(readEventSettings(), readRuleSettings(), readFormDesign(), studentContext());
  renderSettingsDashboard(result, design.year, '公開前確認');
}

function assertGeneratedFormStructure(form: GoogleAppsScript.Forms.Form): void {
  const answerItemTypes = new Set([
    'TEXT', 'PARAGRAPH_TEXT', 'MULTIPLE_CHOICE', 'LIST', 'CHECKBOX', 'SCALE',
    'GRID', 'CHECKBOX_GRID', 'DATE', 'DATETIME', 'TIME', 'DURATION',
  ]);
  const actualItems = form.getItems()
    .map((item) => ({
      itemId: String(item.getId()),
      title: item.getTitle(),
      itemType: String(item.getType()),
    }))
    .filter((item) => answerItemTypes.has(item.itemType));
  const differences = inspectFormStructure(readFormRegistry(form.getId()), actualItems);
  if (differences.length === 0) return;
  const detail = differences.slice(0, 5).map((difference) => `・${difference.message}`).join('\n');
  throw new Error(
    `フォーム構造に${differences.length}件の差分があるため公開しません。\n${detail}`
      + '\n設定画面からフォームを作り直し、公開前にもう一度確認してください。',
  );
}

export function publishDraftForms(): PublishFormsResult {
  assertAuthorized();
  const lock = LockService.getDocumentLock();
  if (!lock.tryLock(30_000)) {
    throw new Error('ほかの担当者がフォームを処理中です。少し待ってから、もう一度実行してください。');
  }
  const published: GoogleAppsScript.Forms.Form[] = [];
  try {
    const design = readFormDesign();
    if (design.formStatus !== '公開前確認') {
      throw new Error('公開前確認まで完了したフォームがありません。先にフォーム下書きを作成してください。');
    }
    const formIds = [design.normalFormId, design.correctionFormId].filter(Boolean);
    if (formIds.length !== 2 || formIds.some((formId) => readFormRegistry(formId).length === 0)) {
      throw new Error('フォームと項目対応表を確認できません。公開せず、設定画面からフォームを作り直してください。');
    }
    const forms = formIds.map((formId) => FormApp.openById(formId));
    forms.forEach(assertGeneratedFormStructure);
    forms.forEach((form) => {
      const publishable = form as typeof form & {
        setPublished(enabled: boolean): GoogleAppsScript.Forms.Form;
        isPublished(): boolean;
      };
      publishable.setPublished(true);
      form.setAcceptingResponses(true);
      if (!publishable.isPublished() || !form.isAcceptingResponses()) {
        throw new Error('フォームを回答可能な状態にできませんでした。現在のフォーム設定を確認してください。');
      }
      published.push(form);
    });
    installGeneratedFormTriggers(formIds);
    const rawPrevious = PropertiesService.getDocumentProperties()
      .getProperty(SCRIPT_PROPERTIES.pendingPreviousFormIds);
    const previousIds = rawPrevious
      ? (JSON.parse(rawPrevious) as unknown[]).filter((value): value is string => typeof value === 'string')
      : [];
    const current = new Set(formIds);
    const previousToRetire = previousIds.filter((formId) => !current.has(formId));
    assertPracticeManagedFormIds(previousToRetire);
    writeFormDesign({ ...design, formStatus: '公開中' });
    completePublishedSettingsChange();
    PropertiesService.getDocumentProperties().deleteProperty(SCRIPT_PROPERTIES.pendingPreviousFormIds);
    const failedRetirements: string[] = [];
    previousToRetire.forEach((formId) => {
      try { retireGeneratedForms([formId]); } catch { failedRetirements.push(formId); }
    });
    return {
      normalPublishedUrl: forms[0]!.getPublishedUrl(),
      correctionPublishedUrl: forms[1]!.getPublishedUrl(),
      message: failedRetirements.length === 0
        ? '通常フォームと修正フォームを公開し、回答取込を開始しました。'
        : `新しいフォームを公開しました。旧フォーム${failedRetirements.length}件を停止できなかったため、管理者が旧フォームを手動で受付停止してください。`,
    };
  } catch (error) {
    try {
      removeGeneratedFormTriggers(published.map((form) => form.getId()));
    } catch { /* 元のエラーを優先する。 */ }
    published.forEach((form) => {
      try {
        form.setAcceptingResponses(false);
        (form as typeof form & { setPublished(enabled: boolean): GoogleAppsScript.Forms.Form })
          .setPublished(false);
      } catch { /* 元のエラーを優先する。 */ }
    });
    throw error;
  } finally {
    lock.releaseLock();
  }
}

export function discardPreparedForms(): DiscardDraftFormsResult {
  assertAuthorized();
  const lock = LockService.getDocumentLock();
  if (!lock.tryLock(30_000)) {
    throw new Error('ほかの担当者がフォームを処理中です。少し待ってから、もう一度実行してください。');
  }
  try {
    const design = readFormDesign();
    if (design.formStatus !== '公開前確認') {
      throw new Error('破棄できる公開前フォームはありません。');
    }
    const rawPrevious = PropertiesService.getDocumentProperties()
      .getProperty(SCRIPT_PROPERTIES.pendingPreviousFormIds);
    const previousIds = rawPrevious
      ? (JSON.parse(rawPrevious) as unknown[]).filter((value): value is string => typeof value === 'string')
      : [];
    const preparedIds = [design.normalFormId, design.correctionFormId].filter(Boolean);
    assertPracticeManagedFormIds(preparedIds);
    retireGeneratedForms(preparedIds);
    if (isSettingsChangeActive()) {
      cancelPublishedSettingsChange();
      PropertiesService.getDocumentProperties().deleteProperty(SCRIPT_PROPERTIES.pendingPreviousFormIds);
      return { message: '公開前フォームを破棄し、設定変更を取り消して元のフォームの受付を再開しました。' };
    }
    const previousNormal = previousIds[0] ?? '';
    const previousCorrection = previousIds[1] ?? '';
    writeFormDesign({
      ...design,
      formStatus: previousNormal && previousCorrection ? '公開中' : '未作成',
      normalFormId: previousNormal,
      correctionFormId: previousCorrection,
      normalEditUrl: previousNormal ? FormApp.openById(previousNormal).getEditUrl() : '',
      correctionEditUrl: previousCorrection ? FormApp.openById(previousCorrection).getEditUrl() : '',
    });
    PropertiesService.getDocumentProperties().deleteProperty(SCRIPT_PROPERTIES.pendingPreviousFormIds);
    return {
      message: previousNormal && previousCorrection
        ? '公開前フォームを破棄し、現在使用中のフォームへ戻しました。'
        : '公開前フォームを破棄しました。',
    };
  } finally {
    lock.releaseLock();
  }
}

function assertPracticeManagedFormIds(formIds: string[]): void {
  if (!isPracticeWorkbook()) return;
  const rootFolderId = getPracticeRootFolderId();
  const belongsToPracticeRoot = (formId: string): boolean => {
    if (!rootFolderId) return false;
    const parents = DriveApp.getFileById(formId).getParents();
    while (parents.hasNext()) {
      const formFolder = parents.next();
      if (formFolder.getId() === rootFolderId) return true;
      const grandparents = formFolder.getParents();
      while (grandparents.hasNext()) {
        if (grandparents.next().getId() === rootFolderId) return true;
      }
    }
    return false;
  };
  const unsafe = formIds.filter(Boolean).filter((formId) => !belongsToPracticeRoot(formId));
  if (unsafe.length > 0) {
    throw new Error('練習用コピーから作成されたことを確認できないフォームは停止・削除できません。本番フォームを守るため処理を中止しました。');
  }
}

function enabledEventsForBuild(events: EventSetting[], design: FormDesignSetting): EventSetting[] {
  return events.filter((event) => event.enabled && event.year === design.year)
    .sort((left, right) => left.displayOrder - right.displayOrder);
}

function settingsSignature(events: EventSetting[], design: FormDesignSetting): string {
  // 行番号は表示用の情報なので、空白行の挿入だけで作成中のフォームを中断させない。
  const source = JSON.stringify({
    events: events.map((event) => ({ ...event, rowNumber: undefined })),
    design,
  });
  const digest = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, source, Utilities.Charset.UTF_8);
  return Utilities.base64EncodeWebSafe(digest);
}

function loadFormBuildJob(): FormBuildJob | undefined {
  const raw = PropertiesService.getDocumentProperties().getProperty(FORM_BUILD_JOB_PROPERTY);
  return raw ? JSON.parse(raw) as FormBuildJob : undefined;
}

function saveFormBuildJob(job: FormBuildJob): void {
  PropertiesService.getDocumentProperties().setProperty(FORM_BUILD_JOB_PROPERTY, JSON.stringify(job));
}

function clearFormBuildJob(): void {
  PropertiesService.getDocumentProperties().deleteProperty(FORM_BUILD_JOB_PROPERTY);
}

function clearFormBuildTriggers(): void {
  ScriptApp.getProjectTriggers()
    .filter((trigger) => trigger.getHandlerFunction() === FORM_BUILD_TRIGGER_HANDLER)
    .forEach((trigger) => ScriptApp.deleteTrigger(trigger));
}

function scheduleFormBuildContinuation(): void {
  clearFormBuildTriggers();
  ScriptApp.newTrigger(FORM_BUILD_TRIGGER_HANDLER).timeBased().after(5_000).create();
}

function formBuildProgress(job: FormBuildJob): string {
  if (job.phase === 'NORMAL_BASE') return '通常フォーム：基本項目の準備前';
  if (job.phase === 'NORMAL_EVENTS') return `通常フォーム：${job.normalGrade}年・${job.normalEventIndex}競技完了`;
  if (job.phase === 'NORMAL_FINAL') return '通常フォーム：分岐設定中';
  if (job.phase === 'CORRECTION_BASE') return '通常フォーム完了／修正フォーム：基本項目の準備前';
  if (job.phase === 'CORRECTION_EVENTS') return `修正フォーム：${job.correctionEventIndex}/${job.eventIds.length}競技完了`;
  if (job.phase === 'CORRECTION_FINAL') return '修正フォーム：分岐設定中';
  return '最終切替中';
}


function studentContext(): { studentCount: number; classCountByGrade: Partial<Record<1 | 2 | 3, number>> } | undefined {
  const spreadsheet = SpreadsheetApp.getActiveSpreadsheet();
  if (!spreadsheet.getSheetByName(SHEETS.students)) return undefined;
  const students = readStudents();
  if (students.length === 0) return undefined;
  const countClasses = (grade: 1 | 2 | 3): number => new Set(
    students.filter((student: Student) => student.grade === grade).map((student: Student) => student.classNumber),
  ).size;
  return {
    studentCount: students.length,
    classCountByGrade: { 1: countClasses(1), 2: countClasses(2), 3: countClasses(3) },
  };
}

export function openSettingsSheet(name: string): void {
  assertAuthorized();
  const allowed: string[] = [SHEETS.eventSettings, SHEETS.ruleSettings, SHEETS.formDesign, SHEETS.settingsIssues, SHEETS.formRegistry];
  if (!allowed.includes(name)) throw new Error('指定された設定シートは開けません。');
  if (name === SHEETS.ruleSettings) syncRuleEventCheckboxes();
  const sheet = getSettingsSheet(name);
  SpreadsheetApp.getActiveSpreadsheet().setActiveSheet(sheet);
}

export function openSettingsIssue(category: SettingsIssue['category'], rowNumber: number): void {
  assertAuthorized();
  const sheet = getSettingsSheet(category);
  const row = Math.max(1, rowNumber || 1);
  SpreadsheetApp.getActiveSpreadsheet().setActiveSheet(sheet);
  sheet.setActiveRange(sheet.getRange(row, 1, 1, Math.max(1, sheet.getLastColumn())));
  SpreadsheetApp.getActiveSpreadsheet().toast(
    rowNumber > 0 ? `${rowNumber}行目を選択しました。赤い説明に沿って直してください。` : '対象の設定を開きました。',
    '修正する場所を開きました', 6,
  );
}

function renderSettingsDashboard(
  result: SettingsValidationResult,
  year: number,
  status: string,
): void {
  const sheet = getSettingsSheet(SHEETS.settingsDashboard);
  sheet.getImages().forEach((image) => image.remove());
  sheet.clear();
  const rows = [
    ['体育祭 フォーム設定', ''],
    ['年度', `${year}年度`],
    ['フォーム状態', status],
    ['競技設定', `警告 ${result.eventWarningCount}件 / エラー ${result.eventErrorCount}件`],
    ['ルール設定', `警告 ${result.ruleWarningCount}件 / エラー ${result.ruleErrorCount}件`],
    ['フォーム設計', `警告 ${result.formWarningCount}件 / エラー ${result.formErrorCount}件`],
    ['', ''],
    ['設定を点検', '上の「選手登録管理」メニュー →「設定を点検」'],
    ['設定を編集', '同メニューから「競技設定を開く」「ルール設定を開く」'],
    ['下書きを作成', 'エラー0件にしてから「フォーム下書きを作成」'],
  ];
  sheet.getRange(1, 1, rows.length, 2).setValues(rows);
  sheet.getRange('A1:B1').merge().setFontWeight('bold').setFontSize(16).setBackground('#174f3f').setFontColor('#ffffff');
  sheet.getRange('A2:A6').setFontWeight('bold');
  sheet.getRange('A4:B6').setBackground('#eef5f1');
  sheet.setColumnWidth(1, 180); sheet.setColumnWidth(2, 460); sheet.setFrozenRows(1);
}
