import { describe, expect, it } from 'vitest';
import {
  MOCK_ROSTER_SOURCE_LABELS,
  detectRosterSourceConflict,
  emptyRosterMessage,
  firstRosterToRead,
  parseMockRosterSource,
  resolveRosterSourceFromCounts,
  rosterFallbackAllowed,
  rosterSourceConflictMessage,
} from '../../src/core/mock-roster-source';

describe('parseMockRosterSource', () => {
  it('「生徒マスター」と書かれているときだけ本番名簿を選ぶ', () => {
    expect(parseMockRosterSource('生徒マスター')).toBe('PRODUCTION_STUDENTS');
    expect(parseMockRosterSource('  生徒マスター  ')).toBe('PRODUCTION_STUDENTS');
  });

  it('空欄・未設定・見慣れない値は疑似生徒マスターにする', () => {
    expect(parseMockRosterSource('')).toBe('MOCK_STUDENTS');
    expect(parseMockRosterSource(undefined)).toBe('MOCK_STUDENTS');
    expect(parseMockRosterSource('疑似生徒マスター')).toBe('MOCK_STUDENTS');
    expect(parseMockRosterSource('本番')).toBe('MOCK_STUDENTS');
  });
});

describe('firstRosterToRead', () => {
  it('本番モードでは選択を見ずに生徒マスターを読む', () => {
    expect(firstRosterToRead({ mode: 'PRODUCTION', configured: 'MOCK_STUDENTS' }))
      .toBe('PRODUCTION_STUDENTS');
    expect(firstRosterToRead({ mode: 'PRODUCTION', configured: 'PRODUCTION_STUDENTS' }))
      .toBe('PRODUCTION_STUDENTS');
  });

  it('開発モードでは選択どおりの名簿を先に読む', () => {
    expect(firstRosterToRead({ mode: 'DEVELOPMENT', configured: 'MOCK_STUDENTS' }))
      .toBe('MOCK_STUDENTS');
    expect(firstRosterToRead({ mode: 'DEVELOPMENT', configured: 'PRODUCTION_STUDENTS' }))
      .toBe('PRODUCTION_STUDENTS');
  });
});

describe('rosterFallbackAllowed', () => {
  it('本番モードでは疑似生徒マスターへ落ちない', () => {
    expect(rosterFallbackAllowed('PRODUCTION')).toBe(false);
    expect(rosterFallbackAllowed('DEVELOPMENT')).toBe(true);
  });
});

describe('resolveRosterSourceFromCounts', () => {
  it('本番モードは件数に関係なく生徒マスター', () => {
    expect(resolveRosterSourceFromCounts({
      mode: 'PRODUCTION', configured: 'MOCK_STUDENTS',
      mockStudentCount: 960, productionStudentCount: 0,
    })).toBe('PRODUCTION_STUDENTS');
  });

  it('生徒マスターに入力があっても、疑似生徒マスターを選んでいればそちらを使う', () => {
    expect(resolveRosterSourceFromCounts({
      mode: 'DEVELOPMENT', configured: 'MOCK_STUDENTS',
      mockStudentCount: 960, productionStudentCount: 800,
    })).toBe('MOCK_STUDENTS');
  });

  it('生徒マスターを選べば、疑似生徒マスターがあってもそちらを使う', () => {
    expect(resolveRosterSourceFromCounts({
      mode: 'DEVELOPMENT', configured: 'PRODUCTION_STUDENTS',
      mockStudentCount: 960, productionStudentCount: 800,
    })).toBe('PRODUCTION_STUDENTS');
  });

  it('選んだ名簿が空なら、入力のあるもう一方へ落とす', () => {
    expect(resolveRosterSourceFromCounts({
      mode: 'DEVELOPMENT', configured: 'MOCK_STUDENTS',
      mockStudentCount: 0, productionStudentCount: 800,
    })).toBe('PRODUCTION_STUDENTS');
    expect(resolveRosterSourceFromCounts({
      mode: 'DEVELOPMENT', configured: 'PRODUCTION_STUDENTS',
      mockStudentCount: 960, productionStudentCount: 0,
    })).toBe('MOCK_STUDENTS');
  });

  it('両方とも空なら疑似生徒マスターを返す', () => {
    expect(resolveRosterSourceFromCounts({
      mode: 'DEVELOPMENT', configured: 'PRODUCTION_STUDENTS',
      mockStudentCount: 0, productionStudentCount: 0,
    })).toBe('MOCK_STUDENTS');
  });
});

describe('detectRosterSourceConflict', () => {
  it('疑似申請が無ければ食い違いを見ない', () => {
    expect(detectRosterSourceConflict({
      resolved: 'PRODUCTION_STUDENTS', stamped: 'MOCK_STUDENTS', mockSubmissionExists: false,
    })).toBe('');
  });

  it('記録が無ければ（旧版のブック）止めない', () => {
    expect(detectRosterSourceConflict({
      resolved: 'PRODUCTION_STUDENTS', stamped: '', mockSubmissionExists: true,
    })).toBe('');
  });

  it('作成時と同じ名簿なら通す', () => {
    expect(detectRosterSourceConflict({
      resolved: 'MOCK_STUDENTS', stamped: 'MOCK_STUDENTS', mockSubmissionExists: true,
    })).toBe('');
  });

  it('疑似申請が残ったまま名簿が変わっていたら止める', () => {
    expect(detectRosterSourceConflict({
      resolved: 'PRODUCTION_STUDENTS', stamped: 'MOCK_STUDENTS', mockSubmissionExists: true,
    })).toBe('MOCK_ROSTER_SOURCE_CHANGED');
    expect(detectRosterSourceConflict({
      resolved: 'MOCK_STUDENTS', stamped: 'PRODUCTION_STUDENTS', mockSubmissionExists: true,
    })).toBe('MOCK_ROSTER_SOURCE_CHANGED');
  });
});

describe('表示文言', () => {
  it('食い違いの案内に、戻すべき名簿名と次の操作を書く', () => {
    const message = rosterSourceConflictMessage('MOCK_STUDENTS');
    expect(message).toContain(MOCK_ROSTER_SOURCE_LABELS.MOCK_STUDENTS);
    expect(message).toContain('疑似申請に使う名簿');
    expect(message).toContain('開発用の疑似データをすべて削除');
  });

  it('空の名簿の案内は、どちらの名簿が空かで文面を変える', () => {
    expect(emptyRosterMessage('PRODUCTION_STUDENTS')).toContain('「生徒マスター」');
    expect(emptyRosterMessage('PRODUCTION_STUDENTS')).toContain('4ケタの学籍番号');
    expect(emptyRosterMessage('MOCK_STUDENTS')).toContain('「疑似生徒マスター」');
    expect(emptyRosterMessage('MOCK_STUDENTS')).toContain('開発用の疑似データを作る');
  });
});
