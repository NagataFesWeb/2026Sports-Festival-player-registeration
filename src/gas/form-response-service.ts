import { convertFormAnswer } from '../core/form-response';
import {
  appendRawFormResponse,
  appendSubmissionWithItems,
  findRawFormResponse,
  findSubmission,
  readRawFormResponses,
  removeSubmissionWithItems,
  updateRawFormResponse,
  type RawFormResponseRecord,
} from './repository';
import { SCRIPT_PROPERTIES } from '../shared/constants';
import { readEventSettings, readFormDesign, readFormRegistry } from './settings-repository';
import { revalidateAffectedSubmissions } from './service';
import { assertAuthorized } from './auth-service';
import { invalidateSheetCache } from './sheet-cache';

export interface GeneratedFormSubmitEvent {
  response: GoogleAppsScript.Forms.FormResponse;
  source: GoogleAppsScript.Forms.Form;
}

export interface FormResponseRetryResult {
  checkedCount: number;
  processedCount: number;
  failedCount: number;
  remainingCount: number;
  message: string;
}

/**
 * 送信トリガーからの取込がロックを待つ時間。待っている人がいない裏の処理なので、
 * 全再検査や名簿作成が終わるのを長めに待ち、取込の取りこぼしを減らす。
 * トリガーの実行上限（6分）を超えないよう3分で切り上げる。
 */
const SUBMIT_LOCK_WAIT_MILLISECONDS = 180_000;
/** 再処理は1回の実行で複数件を処理するため、1件あたりの待ち時間は短くする。 */
const RETRY_LOCK_WAIT_MILLISECONDS = 30_000;

export function handleGeneratedFormSubmitEvent(
  event: GeneratedFormSubmitEvent,
  lockWaitMilliseconds: number = SUBMIT_LOCK_WAIT_MILLISECONDS,
): void {
  const lock = LockService.getDocumentLock();
  if (!lock.tryLock(lockWaitMilliseconds)) throw new Error('フォーム回答の取込が混み合っています。しばらくしてから再処理してください。');
  // ロックを取った直後は、ほかの担当者やトリガーが書いた内容を必ず読み直す。
  invalidateSheetCache();
  let rawRow = 0;
  let rawRecord: RawFormResponseRecord | undefined;
  let appendedSubmissionId = '';
  try {
    const formId = event.source.getId();
    const responseId = event.response.getId() ?? Utilities.getUuid();
    const existingRaw = findRawFormResponse(formId, responseId);
    if (existingRaw?.record.processingStatus === 'PROCESSED') return;
    const registry = readFormRegistry(formId);
    if (registry.length === 0) throw new Error('このフォームの項目対応表が見つかりません。設定画面からフォームを作り直してください。');
    const formType = registry[0]!.formType;
    const fieldKeyByItemId = new Map(registry.map((mapping) => [mapping.itemId, mapping.fieldKey]));
    const answersByFieldKey: Record<string, string> = {};
    event.response.getItemResponses().forEach((itemResponse) => {
      const fieldKey = fieldKeyByItemId.get(String(itemResponse.getItem().getId()));
      if (!fieldKey) return;
      const value = itemResponse.getResponse();
      answersByFieldKey[fieldKey] = Array.isArray(value) ? value.join(', ') : String(value ?? '');
    });
    const submittedAt = event.response.getTimestamp()?.toISOString() ?? new Date().toISOString();
    rawRecord = {
      formId, responseId, formType, submittedAt, answerJson: JSON.stringify(answersByFieldKey),
      processingStatus: 'RECEIVED', submissionId: '', processedAt: '', errorCode: '',
    };
    if (existingRaw) {
      rawRow = existingRaw.row;
      updateRawFormResponse(rawRow, rawRecord);
    } else {
      rawRow = appendRawFormResponse(rawRecord);
    }
    const design = readFormDesign();
    const converted = convertFormAnswer({
      formId, responseId, formType, submittedAt,
      respondentEmail: event.response.getRespondentEmail() ?? '',
      receptionOpen: design.formStatus !== '受付停止',
      answersByFieldKey, registry, events: readEventSettings(),
    });
    rawRecord.submissionId = converted.submission.submissionId;
    if (!findSubmission(converted.submission.submissionId)) {
      appendSubmissionWithItems(converted.submission, converted.items);
      appendedSubmissionId = converted.submission.submissionId;
      revalidateAffectedSubmissions([converted.submission.submissionId]);
      appendedSubmissionId = '';
    }
    rawRecord.processingStatus = 'PROCESSED';
    rawRecord.processedAt = new Date().toISOString();
    updateRawFormResponse(rawRow, rawRecord);
  } catch (error) {
    if (appendedSubmissionId) {
      try { removeSubmissionWithItems(appendedSubmissionId); } catch { /* 元のエラーを優先する。 */ }
    }
    if (rawRow > 0 && rawRecord) {
      rawRecord.processingStatus = 'ERROR';
      rawRecord.processedAt = new Date().toISOString();
      rawRecord.errorCode = 'FORM_RESPONSE_PROCESSING_FAILED';
      try { updateRawFormResponse(rawRow, rawRecord); } catch { /* 個人情報をログへ出さない。 */ }
    }
    throw error;
  } finally {
    lock.releaseLock();
  }
}

export function retryFailedFormResponses(limit = 25): FormResponseRetryResult {
  assertAuthorized();
  const cappedLimit = Math.max(1, Math.min(100, Math.floor(limit)));
  const rawRecords = readRawFormResponses();
  const rawByKey = new Map(rawRecords.map((record) => [
    `${record.formId}:${record.responseId}`,
    record,
  ]));
  const design = readFormDesign();
  const configuredIds = [design.normalFormId, design.correctionFormId].filter(Boolean);
  const pendingPrevious = PropertiesService.getDocumentProperties()
    .getProperty(SCRIPT_PROPERTIES.pendingPreviousFormIds);
  const previousIds = pendingPrevious
    ? (JSON.parse(pendingPrevious) as unknown[]).filter((value): value is string => typeof value === 'string')
    : [];
  const failedFormIds = rawRecords
    .filter((record) => record.processingStatus !== 'PROCESSED')
    .map((record) => record.formId);
  const activeIds = design.formStatus === '公開前確認' && previousIds.length > 0
    ? previousIds
    : configuredIds;
  const formIds = [...new Set([...activeIds, ...failedFormIds])];
  const candidates: GeneratedFormSubmitEvent[] = [];
  formIds.forEach((formId) => {
    const form = FormApp.openById(formId);
    form.getResponses().forEach((response) => {
      const responseId = response.getId();
      if (!responseId) return;
      const raw = rawByKey.get(`${formId}:${responseId}`);
      if (raw?.processingStatus === 'PROCESSED') return;
      candidates.push({ source: form, response });
    });
  });

  let processedCount = 0;
  let failedCount = 0;
  candidates.slice(0, cappedLimit).forEach((event) => {
    try {
      handleGeneratedFormSubmitEvent(event, RETRY_LOCK_WAIT_MILLISECONDS);
      processedCount += 1;
    } catch {
      failedCount += 1;
    }
  });
  const checkedCount = Math.min(candidates.length, cappedLimit);
  const remainingCount = Math.max(0, candidates.length - checkedCount);
  return {
    checkedCount,
    processedCount,
    failedCount,
    remainingCount,
    message: remainingCount > 0
      ? `${processedCount}件を取り込みました。残り${remainingCount}件は、もう一度「回答取込を点検・再処理」を実行してください。`
      : failedCount > 0
        ? `${processedCount}件を取り込み、${failedCount}件は再処理できませんでした。フォーム項目対応表と設定を確認してください。`
        : `${processedCount}件を取り込みました。未取込の回答はありません。`,
  };
}
