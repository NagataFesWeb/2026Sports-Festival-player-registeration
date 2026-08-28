import { describe, expect, it } from 'vitest';
import {
  assertRosterJobCanStart, buildAthleteIndex, buildClassDistributionPages,
  buildConcurrentRosterTables, buildRegistrationSnapshot,
  buildRosterDistributionPreflight,
  normalizeRosterInputName, planRosterJobStep, ROSTER_REPORT_NAMES, selectRosterVersionName,
} from '../../src/core/roster';
import type { EventSetting, Student, Submission, SubmissionItem } from '../../src/shared/types';

const student: Student = { studentId: '1101', grade: 1, classNumber: 1, attendanceNumber: 1, name: '架空生徒01' };
const submission = (id: string, submittedAt: string, status: Submission['status'] = 'APPROVED'): Submission => ({
  submissionId: id, submissionType: 'INITIAL', submittedAt,
  submitterStudentId: '1101', submitterNameInput: '架空生徒01', submitterEmail: 'fake@example.invalid',
  targetGrade: 1, targetClass: 1, isProxy: false, receptionOpen: true,
  status, warningCount: 0, errorCount: 0,
});
const item = (submissionId: string, state: SubmissionItem['registrationState'] = 'REGISTER'): SubmissionItem => ({
  submissionItemId: `${submissionId}-item`, submissionId, eventId: 'relay', eventName: '400mリレー',
  slotId: 'runner-1', slotName: '第1走者', studentIdInput: '1101', studentNameInput: '入力名',
  normalizedStudentId: state === 'REGISTER' ? '1101' : '', normalizedName: '架空生徒01',
  registrationState: state, required: true,
});

describe('buildRegistrationSnapshot', () => {
  it('承認済みと反映済みだけを正式登録へ変換する', () => {
    const result = buildRegistrationSnapshot({
      submissions: [submission('approved', '2026-01-01'), submission('pending', '2026-01-02', 'PENDING_APPROVAL')],
      items: [item('approved'), item('pending')], students: [student], versionName: '確認版_v1.0',
      updatedAt: '2026-01-03T00:00:00.000Z', updatedBy: 'staff@example.invalid',
    });
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ sourceSubmissionId: 'approved', studentNameSnapshot: '架空生徒01' });
  });

  it('後から承認された同一クラス・同一競技の回答で競技全体を置き換える', () => {
    const result = buildRegistrationSnapshot({
      submissions: [submission('old', '2026-01-01'), submission('new', '2026-01-02')],
      items: [item('old'), item('new', 'NOT_PARTICIPATING')], students: [student], versionName: '確認版_v1.1',
      updatedAt: '2026-01-03T00:00:00.000Z', updatedBy: 'staff@example.invalid',
    });
    expect(result).toEqual([]);
  });
});

describe('名簿の版名', () => {
  it('初回をv1.0、重複時を次の空き番号にする', () => {
    expect(selectRosterVersionName('第1回確認版', [])).toBe('第1回確認版_v1.0');
    expect(selectRosterVersionName('第1回確認版', ['第1回確認版_v1.0', '第1回確認版_v1.1']))
      .toBe('第1回確認版_v1.2');
  });

  it('空欄を拒否し、フォルダ名で紛らわしい文字を置き換える', () => {
    expect(() => selectRosterVersionName('  ', [])).toThrow('名前を入力');
    expect(normalizeRosterInputName('確認/版')).toBe('確認-版');
  });
});

describe('時間切れから再開できる名簿作成手順', () => {
  it('3種類のスプレッドシートとクラス配布PDFを作る', () => {
    expect(ROSTER_REPORT_NAMES)
      .toEqual(['種目別', 'クラス別・招集順', '当日変更用', 'クラス配布用PDF']);
  });

  it('4ファイルを1つずつ処理した後だけ正式反映へ進む', () => {
    expect(Array.from({ length: 4 }, (_, index) => planRosterJobStep(index, 4)))
      .toEqual(Array.from({ length: 4 }, (_, index) => ({ kind: 'REPORT', reportIndex: index })));
    expect(planRosterJobStep(4, 4)).toEqual({ kind: 'FINALIZE' });
  });

  it('失敗時に番号を進めなければ同じファイルから再開できる', () => {
    expect(planRosterJobStep(2, 3)).toEqual({ kind: 'REPORT', reportIndex: 2 });
    expect(planRosterJobStep(2, 3)).toEqual({ kind: 'REPORT', reportIndex: 2 });
  });

  it('作成中の版があれば二重開始を拒否する', () => {
    expect(() => assertRosterJobCanStart('確認版_v1.0')).toThrow('二重作成');
    expect(() => assertRosterJobCanStart()).not.toThrow();
  });
});

describe('クラス配布PDFのページ構成', () => {
  it('生徒マスターにある各クラスを1ページ分として並べ、空のクラスも残す', () => {
    const students: Student[] = [
      student,
      { studentId: '1201', grade: 1, classNumber: 2, attendanceNumber: 1, name: '架空生徒02' },
    ];
    const registration = buildRegistrationSnapshot({
      submissions: [submission('approved', '2026-01-01')],
      items: [item('approved')], students, versionName: '配布版_v1.0',
      updatedAt: '2026-01-03T00:00:00.000Z', updatedBy: 'staff@example.invalid',
    });
    const pages = buildClassDistributionPages(registration, students);
    expect(pages.map((page) => `${page.grade}-${page.classNumber}`)).toEqual(['1-1', '1-2']);
    expect(pages[0]?.registrations).toHaveLength(1);
    expect(pages[1]?.registrations).toEqual([]);
  });
});

describe('PDF配布前の点検', () => {
  it('未処理の警告・エラー申請をまとめて注意表示する', () => {
    const warning = submission('warning', '2026-01-01', 'PENDING_APPROVAL');
    warning.warningCount = 1;
    const error = submission('error', '2026-01-02', 'NEEDS_CORRECTION');
    error.errorCount = 1;
    const approved = submission('approved', '2026-01-03', 'APPROVED');
    approved.errorCount = 1;
    const result = buildRosterDistributionPreflight([warning, error, approved]);
    expect(result.problemSubmissionCount).toBe(2);
    expect(result.message).toContain('PDF配布前');
  });
});

describe('配布用の自分の競技索引', () => {
  it('同じ選手の競技と走順を1行へまとめる', () => {
    const base = {
      registrationId: 'REG-1', sourceSubmissionId: 'SUB-1', studentId: '1101',
      studentNameSnapshot: '架空生徒01', grade: 1, classNumber: 1,
      version: '確認版_v1.0', updatedAt: '2026-01-01', updatedBy: 'staff@example.invalid',
    };
    const result = buildAthleteIndex([
      { ...base, eventId: 'relay', eventName: '400mリレー', slotId: '2', slotName: '第2走者' },
      { ...base, registrationId: 'REG-2', eventId: 'dash', eventName: '100m走', slotId: '1', slotName: '第1走者' },
    ]);
    expect(result).toEqual([{
      grade: 1, classNumber: 1, studentId: '1101', studentName: '架空生徒01',
      eventSummary: '100m走（第1走者）\n400mリレー（第2走者）',
    }]);
  });
});

describe('学年別の走順・クラス表', () => {
  it('同じ走順をクラスごとに横へ並べる', () => {
    const base = {
      sourceSubmissionId: 'SUB-1', eventId: 'relay', eventName: '400mリレー',
      version: '確認版_v1.0', updatedAt: '2026-01-01', updatedBy: 'staff@example.invalid',
    };
    const result = buildConcurrentRosterTables([
      { ...base, registrationId: 'REG-1', slotId: 'runner-2', slotName: '第2走者',
        studentId: '1102', studentNameSnapshot: '1組第2走者', grade: 1, classNumber: 1 },
      { ...base, registrationId: 'REG-2', slotId: 'runner-1', slotName: '第1走者',
        studentId: '1201', studentNameSnapshot: '2組第1走者', grade: 1, classNumber: 2 },
      { ...base, registrationId: 'REG-3', slotId: 'runner-1', slotName: '第1走者',
        studentId: '1101', studentNameSnapshot: '1組第1走者', grade: 1, classNumber: 1 },
    ], 1);

    expect(result).toHaveLength(1);
    expect(result[0]?.rows.map((row) => row.slotName)).toEqual(['第1走者', '第2走者']);
    expect(result[0]?.rows[0]?.athletesByClass[1]?.[0]?.studentName).toBe('1組第1走者');
    expect(result[0]?.rows[0]?.athletesByClass[2]?.[0]?.studentName).toBe('2組第1走者');
  });

  it('同じクラス・同じ走順の複数人を同じセル用の配列へまとめ、別学年は含めない', () => {
    const base = {
      sourceSubmissionId: 'SUB-1', eventId: 'group', eventName: '団体競技',
      slotId: 'slot-1', slotName: '第1組', version: '確認版_v1.0',
      updatedAt: '2026-01-01', updatedBy: 'staff@example.invalid', classNumber: 1,
    };
    const result = buildConcurrentRosterTables([
      { ...base, registrationId: 'REG-2', studentId: '1102', studentNameSnapshot: '二人目', grade: 1 },
      { ...base, registrationId: 'REG-1', studentId: '1101', studentNameSnapshot: '一人目', grade: 1 },
      { ...base, registrationId: 'REG-3', studentId: '2101', studentNameSnapshot: '別学年', grade: 2 },
    ], 1);

    expect(result[0]?.rows[0]?.athletesByClass[1]?.map((athlete) => athlete.studentId))
      .toEqual(['1101', '1102']);
  });

  it('競技設定にある未登録の競技と走順も空欄として残す', () => {
    const events: EventSetting[] = [{
      year: 2026, eventId: 'relay', enabled: true, targetGrade: '全学年', eventName: '400mリレー',
      category: '混合', requiredCount: 4, hasOrder: true, vacancyAllowed: false,
      assemblyOrder: 10, displayOrder: 10, note: '',
    }, {
      year: 2026, eventId: 'dash', enabled: true, targetGrade: '1年', eventName: '100m走',
      category: '男子', requiredCount: 2, hasOrder: false, vacancyAllowed: false,
      assemblyOrder: 20, displayOrder: 20, note: '',
    }];
    const result = buildConcurrentRosterTables([], 1, events);
    expect(result.map((table) => table.eventName)).toEqual(['400mリレー', '100m走']);
    expect(result[0]?.rows.map((row) => row.slotName))
      .toEqual(['第1走者', '第2走者', '第3走者', '第4走者']);
    expect(result[1]?.rows.map((row) => row.slotName)).toEqual(['1人目', '2人目']);
    expect(buildConcurrentRosterTables([], 2, events).map((table) => table.eventName))
      .toEqual(['400mリレー']);
  });
});
