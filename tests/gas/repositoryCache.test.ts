import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ISSUE_HEADERS,
  ITEM_HEADERS,
  SHEETS,
  SUBMISSION_HEADERS,
} from '../../src/shared/constants';
import type { Submission, SubmissionItem, ValidationIssue } from '../../src/shared/types';
import { invalidateSheetCache } from '../../src/gas/sheet-cache';
import {
  appendSubmissionWithItems,
  readIssues,
  readItems,
  readSubmissions,
  removeSubmissionWithItems,
  replaceIssuesForSubmissions,
  requireSheet,
  updateSubmission,
  updateValidatedItems,
} from '../../src/gas/repository';
import { FakeSpreadsheet, fakeSpreadsheetApp, type FakeSheet } from './fakeSpreadsheet';

/**
 * 実行内メモの効きと、書き込み後に必ず読み直すことを、偽物の`SpreadsheetApp`で確かめる。
 * 値はすべて架空。実在の生徒名・学籍番号は使わない。
 */
const submission = (submissionId: string, status: Submission['status'] = 'PENDING_APPROVAL'): Submission => ({
  submissionId, submissionType: 'INITIAL', submittedAt: '2026-05-01T00:00:00.000Z',
  submitterStudentId: '1101', submitterNameInput: 'テスト太郎', submitterEmail: '',
  targetGrade: 1, targetClass: 1, isProxy: false, receptionOpen: true,
  status, warningCount: 0, errorCount: 0,
});

const item = (submissionItemId: string, submissionId: string): SubmissionItem => ({
  submissionItemId, submissionId, eventId: 'E1', eventName: '100m', slotId: 'S1', slotName: '1走',
  studentIdInput: '1102', studentNameInput: '', normalizedStudentId: '1102', normalizedName: '',
  registrationState: 'REGISTER', required: true,
});

const issue = (issueId: string, submissionId: string): ValidationIssue => ({
  issueId, submissionId, submissionItemId: '', severity: 'WARNING', issueCode: 'TEST',
  displayTitle: 'テスト', locationText: '', currentValue: '', fixInstruction: '', status: 'UNCONFIRMED',
  relatedItemIds: '',
});

const submissionRow = (value: Submission): (string | number | boolean)[] => [
  value.submissionId, value.submissionType, value.submittedAt, value.submitterStudentId,
  value.submitterNameInput, value.submitterEmail, value.targetGrade, value.targetClass,
  value.isProxy, value.receptionOpen, value.status, value.warningCount, value.errorCount,
];

let book: FakeSpreadsheet;
let submissionSheet: FakeSheet;
let itemSheet: FakeSheet;
let issueSheet: FakeSheet;

beforeEach(() => {
  invalidateSheetCache();
  book = new FakeSpreadsheet();
  submissionSheet = book.addSheet(SHEETS.submissions, [
    [...SUBMISSION_HEADERS],
    submissionRow(submission('sub-1')),
    submissionRow(submission('sub-2', 'APPROVED')),
  ]);
  itemSheet = book.addSheet(SHEETS.items, [
    [...ITEM_HEADERS],
    ['item-1', 'sub-1', '1101', 'テスト太郎', 'E1', '100m', 'S1', '1走', '1102', '', '1102', '', 'REGISTER', true],
  ]);
  issueSheet = book.addSheet(SHEETS.issues, [
    [...ISSUE_HEADERS],
    ['issue-1', 'sub-1', '', 'WARNING', 'TEST', 'テスト', '', '', '', 'UNCONFIRMED', ''],
  ]);
  vi.stubGlobal('SpreadsheetApp', fakeSpreadsheetApp(book));
});

describe('repository の実行内メモ', () => {
  it('同じ実行内で申請を2回読んでも、シートは1回しか読まない', () => {
    const first = readSubmissions();
    const second = readSubmissions();
    expect(first).toHaveLength(2);
    expect(second).toEqual(first);
    expect(submissionSheet.reads.values).toBe(1);
  });

  it('申請項目はヘッダーとデータをまとめて1回で読み、2回目はメモから返す', () => {
    readItems();
    readItems();
    expect(itemSheet.reads.display).toBe(1);
    expect(itemSheet.reads.values).toBe(1);
    expect(readItems()[0]?.studentIdInput).toBe('1102');
  });

  it('updateSubmission の後は、次の読み取りが書き込んだ内容を返す', () => {
    readSubmissions();
    updateSubmission({ ...submission('sub-1'), status: 'APPROVED' });
    const after = readSubmissions();
    expect(after.find((value) => value.submissionId === 'sub-1')?.status).toBe('APPROVED');
    expect(submissionSheet.reads.values).toBe(2);
  });

  it('appendSubmissionWithItems の後は、申請と申請項目の両方に新しい行が見える', () => {
    readSubmissions();
    readItems();
    appendSubmissionWithItems(submission('sub-3'), [item('item-3', 'sub-3')]);
    expect(readSubmissions().map((value) => value.submissionId)).toEqual(['sub-1', 'sub-2', 'sub-3']);
    expect(readItems().map((value) => value.submissionItemId)).toEqual(['item-1', 'item-3']);
  });

  it('removeSubmissionWithItems の後は、消した申請が読み取りに残らない', () => {
    readSubmissions();
    readItems();
    removeSubmissionWithItems('sub-1');
    expect(readSubmissions().map((value) => value.submissionId)).toEqual(['sub-2']);
    expect(readItems()).toEqual([]);
  });

  it('updateValidatedItems の後は、正規化した値が読み取りに反映される', () => {
    readItems();
    updateValidatedItems([{ ...item('item-1', 'sub-1'), normalizedStudentId: '1103', normalizedName: '正規化' }]);
    expect(readItems()[0]?.normalizedStudentId).toBe('1103');
    expect(readItems()[0]?.normalizedName).toBe('正規化');
  });

  it('replaceIssuesForSubmissions は対象申請の検査結果だけを入れ替え、直後の読み取りへ反映される', () => {
    issueSheet.getRange(3, 1, 1, ISSUE_HEADERS.length)
      .setValues([['issue-2', 'sub-2', '', 'ERROR', 'TEST', 'ほか', '', '', '', 'UNCONFIRMED', '']]);
    readIssues();
    replaceIssuesForSubmissions(['sub-1'], [issue('issue-new', 'sub-1')]);
    const ids = readIssues().map((value) => value.issueId).sort();
    expect(ids).toEqual(['issue-2', 'issue-new']);
  });

  it('requireSheet でシートを外へ渡すと、そのシートのメモを捨てる', () => {
    readSubmissions();
    const sheet = requireSheet(SHEETS.submissions);
    sheet.getRange(2, 11).setValue('ON_HOLD');
    expect(readSubmissions()[0]?.status).toBe('ON_HOLD');
    expect(submissionSheet.reads.values).toBe(2);
  });

  it('読み取り結果を書き換えても、次の読み取りには影響しない', () => {
    const first = readSubmissions();
    first[0]!.status = 'REJECTED';
    first.pop();
    expect(readSubmissions().map((value) => value.status)).toEqual(['PENDING_APPROVAL', 'APPROVED']);
  });

  it('別のシートへ書いても、関係ないシートのメモは残る', () => {
    readSubmissions();
    updateValidatedItems([item('item-1', 'sub-1')]);
    readSubmissions();
    expect(submissionSheet.reads.values).toBe(1);
  });
});
