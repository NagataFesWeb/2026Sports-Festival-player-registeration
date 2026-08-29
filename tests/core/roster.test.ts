import { describe, expect, it } from 'vitest';
import {
  assertRosterJobCanStart, buildAthleteIndex, buildClassDistributionPages,
  buildConcurrentRosterTables, buildRegistrationSnapshot,
  buildRosterDistributionPreflight,
  buildEventRosterPages, eventRosterPageTitle, type EventRosterPage,
  diffRosterRegistrations, gradeRosterSheetName, planEventRosterSheetNames,
  replaceRosterMetadataVersion, safeRosterSheetName, selectAffectedRosterPages,
  shouldRebuildWholeReport,
  type RosterBaselineRow,
  normalizeRosterInputName, planRosterJobStep, ROSTER_REPORT_NAMES, rosterGenderLabel,
  selectRosterVersionName,
} from '../../src/core/roster';
import type {
  EventSetting, Registration, Student, Submission, SubmissionItem,
} from '../../src/shared/types';

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
      grade: 1, classNumber: 1, studentId: '1101', studentName: '架空生徒01', gender: 'U',
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

describe('名簿の性別', () => {
  const femaleStudent: Student = { ...student, gender: 'F' };

  it('生徒マスターの性別を登録データへ写す', () => {
    const result = buildRegistrationSnapshot({
      submissions: [submission('approved', '2026-01-01')], items: [item('approved')],
      students: [femaleStudent], versionName: '確認版_v1.0',
      updatedAt: '2026-01-03T00:00:00.000Z', updatedBy: 'staff@example.invalid',
    });
    expect(result[0]?.genderSnapshot).toBe('F');
  });

  it('生徒マスターで性別を確認できない場合はUNKNOWN扱いのUにする', () => {
    const result = buildRegistrationSnapshot({
      submissions: [submission('approved', '2026-01-01')], items: [item('approved')],
      students: [student], versionName: '確認版_v1.0',
      updatedAt: '2026-01-03T00:00:00.000Z', updatedBy: 'staff@example.invalid',
    });
    expect(result[0]?.genderSnapshot).toBe('U');
  });

  it('索引と走順表へ性別を引き継ぐ', () => {
    const registrations = buildRegistrationSnapshot({
      submissions: [submission('approved', '2026-01-01')], items: [item('approved')],
      students: [femaleStudent], versionName: '確認版_v1.0',
      updatedAt: '2026-01-03T00:00:00.000Z', updatedBy: 'staff@example.invalid',
    });
    expect(buildAthleteIndex(registrations)[0]?.gender).toBe('F');
    const tables = buildConcurrentRosterTables(registrations, 1);
    expect(tables[0]?.rows[0]?.athletesByClass[1]?.[0]?.gender).toBe('F');
  });

  it('印刷用の表記は男・女・UNKNOWNの3種類にそろえる', () => {
    expect(rosterGenderLabel('M')).toBe('男');
    expect(rosterGenderLabel('F')).toBe('女');
    expect(rosterGenderLabel('U')).toBe('UNKNOWN');
    expect(rosterGenderLabel(undefined)).toBe('UNKNOWN');
  });
});

describe('buildEventRosterPages', () => {
  const event = (
    eventId: string, eventName: string, displayOrder: number,
    overrides: Partial<EventSetting> = {},
  ): EventSetting => ({
    year: 2026, eventId, enabled: true, targetGrade: '全学年', eventName,
    category: '混合', requiredCount: 2, hasOrder: false, vacancyAllowed: false,
    assemblyOrder: displayOrder, displayOrder, note: '', ...overrides,
  });

  it('表示順0・100・200はそれぞれ別のページになる', () => {
    const pages = buildEventRosterPages([
      event('a', '開会式入場', 0),
      event('b', '綱引き', 100),
      event('c', '大玉送り', 200),
    ]);
    expect(pages.map((page) => page.blockKey)).toEqual([0, 1, 2]);
    expect(pages.map((page) => page.events.map((item) => item.eventId))).toEqual([['a'], ['b'], ['c']]);
  });

  it('表示順300・301・302は1つのページにまとまる', () => {
    const pages = buildEventRosterPages([
      event('d1', '1年男子100m', 300, { targetGrade: '1年' }),
      event('d2', '2年男子100m', 301, { targetGrade: '2年' }),
      event('d3', '3年男子100m', 302, { targetGrade: '3年' }),
    ]);
    expect(pages).toHaveLength(1);
    expect(pages[0]?.blockKey).toBe(3);
    expect(pages[0]?.events.map((item) => item.eventId)).toEqual(['d1', 'd2', 'd3']);
  });

  it('100番台の境目でページが変わる', () => {
    const pages = buildEventRosterPages([
      event('a', '99番', 99),
      event('b', '100番', 100),
      event('c', '199番', 199),
      event('d', '200番', 200),
    ]);
    expect(pages.map((page) => page.events.map((item) => item.eventId)))
      .toEqual([['a'], ['b', 'c'], ['d']]);
  });

  it('表示順が前後していても、並べ替えてからページへ分ける', () => {
    const pages = buildEventRosterPages([
      event('c', '3番目', 302),
      event('a', '1番目', 100),
      event('b', '2番目', 300),
    ]);
    expect(pages.map((page) => page.events.map((item) => item.eventId)))
      .toEqual([['a'], ['b', 'c']]);
  });

  it('同じ表示順の競技は同じページに残す', () => {
    const pages = buildEventRosterPages([
      event('a', '競技A', 300, { assemblyOrder: 2 }),
      event('b', '競技B', 300, { assemblyOrder: 1 }),
    ]);
    expect(pages).toHaveLength(1);
    // 表示順が同じときは招集順で並べる。
    expect(pages[0]?.events.map((item) => item.eventId)).toEqual(['b', 'a']);
  });

  it('競技が無いときは空を返す', () => {
    expect(buildEventRosterPages([])).toEqual([]);
  });
});

describe('eventRosterPageTitle', () => {
  const event = (eventName: string, displayOrder: number): EventSetting => ({
    year: 2026, eventId: eventName, enabled: true, targetGrade: '全学年', eventName,
    category: '混合', requiredCount: 2, hasOrder: false, vacancyAllowed: false,
    assemblyOrder: displayOrder, displayOrder, note: '',
  });

  it('1競技だけならその競技名', () => {
    expect(eventRosterPageTitle({ blockKey: 1, events: [event('綱引き', 100)] })).toBe('綱引き');
  });

  it('複数競技なら競技名を並べる', () => {
    expect(eventRosterPageTitle({
      blockKey: 3,
      events: [event('1年男子100m', 300), event('2年男子100m', 301)],
    })).toBe('1年男子100m・2年男子100m');
  });

  it('長くなりすぎる場合は先頭の競技名と残りの件数にする', () => {
    const events = [1, 2, 3, 4, 5].map((index) => event(`とても長い競技名${index}番`, 300 + index));
    expect(eventRosterPageTitle({ blockKey: 3, events })).toBe('とても長い競技名1番ほか4件');
  });
});

describe('diffRosterRegistrations', () => {
  const baseline = (
    registrationId: string, overrides: Partial<RosterBaselineRow> = {},
  ): RosterBaselineRow => ({
    registrationId, eventId: 'relay', grade: 1, classNumber: 1,
    studentId: '1101', studentName: '架空生徒01', genderLabel: '男', ...overrides,
  });
  const registration = (
    registrationId: string, overrides: Partial<Registration> = {},
  ): Registration => ({
    registrationId, sourceSubmissionId: 'sub-1', eventId: 'relay', eventName: '400mリレー',
    slotId: 'runner-1', slotName: '第1走者', studentId: '1101', studentNameSnapshot: '架空生徒01',
    genderSnapshot: 'M', grade: 1, classNumber: 1, version: '確認版_v1.1',
    updatedAt: '2026-01-01T00:00:00.000Z', updatedBy: 'staff@example.invalid', ...overrides,
  });

  it('同じ内容なら差分なしになる', () => {
    const diff = diffRosterRegistrations([baseline('REG-1')], [registration('REG-1')]);
    expect(diff.hasChanges).toBe(false);
    expect(diff.totalCount).toBe(0);
    expect(diff.affectedEventIds).toEqual([]);
  });

  it('選手が入れ替わった枠を変更として数える', () => {
    const diff = diffRosterRegistrations(
      [baseline('REG-1')], [registration('REG-1', { studentId: '1102', studentNameSnapshot: '架空生徒02' })],
    );
    expect(diff).toMatchObject({ changedCount: 1, addedCount: 0, removedCount: 0, totalCount: 1 });
    expect(diff.affectedEventIds).toEqual(['relay']);
    expect(diff.affectedGrades).toEqual([1]);
  });

  it('学籍番号が同じでも氏名だけ直った枠を差分に含める', () => {
    const diff = diffRosterRegistrations(
      [baseline('REG-1', { studentName: '旧表記' })], [registration('REG-1')],
    );
    expect(diff.changedCount).toBe(1);
  });

  it('性別の表示が変わった枠も差分に含める', () => {
    const diff = diffRosterRegistrations(
      [baseline('REG-1', { genderLabel: 'UNKNOWN' })], [registration('REG-1')],
    );
    expect(diff.changedCount).toBe(1);
  });

  it('前回になかった枠は追加、無くなった枠は取り消しとして数える', () => {
    const diff = diffRosterRegistrations(
      [baseline('REG-1'), baseline('REG-2', { eventId: 'tug', grade: 2 })],
      [registration('REG-1'), registration('REG-3', { eventId: 'ball', grade: 3 })],
    );
    expect(diff).toMatchObject({ addedCount: 1, removedCount: 1, changedCount: 0, totalCount: 2 });
    expect(diff.affectedEventIds).toEqual(['ball', 'tug']);
    expect(diff.affectedGrades).toEqual([2, 3]);
  });
});

const rosterPage = (entries: Array<[string, string]>): EventRosterPage => ({
  blockKey: 0,
  events: entries.map(([eventId, eventName]) => ({
    year: 2026, eventId, enabled: true, targetGrade: '全学年', eventName,
    category: '混合', requiredCount: 2, hasOrder: false, vacancyAllowed: false,
    assemblyOrder: 1, displayOrder: 1, note: '',
  })),
});

describe('selectAffectedRosterPages', () => {
  const page = (...eventIds: string[]): EventRosterPage =>
    rosterPage(eventIds.map((eventId) => [eventId, eventId]));

  it('変わった競技を含むページだけを返す', () => {
    expect(selectAffectedRosterPages([page('a'), page('b', 'c'), page('d')], ['c'])).toEqual([1]);
  });

  it('変わった競技がなければ何も返さない', () => {
    expect(selectAffectedRosterPages([page('a'), page('b')], [])).toEqual([]);
  });
});

describe('shouldRebuildWholeReport', () => {
  it('3分の2以上を書き直すなら全面作成にする', () => {
    expect(shouldRebuildWholeReport(4, 6)).toBe(true);
    expect(shouldRebuildWholeReport(3, 6)).toBe(false);
  });

  it('ページが1枚もないときは全面作成にする', () => {
    expect(shouldRebuildWholeReport(0, 0)).toBe(true);
  });
});

describe('planEventRosterSheetNames', () => {
  const page = (eventId: string, eventName: string): EventRosterPage =>
    rosterPage([[eventId, eventName]]);

  it('ページの並び順どおりにシート名を決める', () => {
    expect(planEventRosterSheetNames([page('a', '綱引き'), page('b', '大玉送り')]))
      .toEqual(['綱引き', '大玉送り']);
  });

  it('同じ競技名が重なったら競技IDを足して分ける', () => {
    expect(planEventRosterSheetNames([page('a', '綱引き'), page('b', '綱引き')]))
      .toEqual(['綱引き', '綱引き_b']);
  });

  it('索引シートと同じ名前は避ける', () => {
    expect(planEventRosterSheetNames([page('a', '自分の競技を探す')])).toEqual(['自分の競技を探す_a']);
  });
});

describe('safeRosterSheetName', () => {
  it('シート名に使えない文字を置き換える', () => {
    expect(safeRosterSheetName('100m/200m')).toBe('100m-200m');
  });

  it('空文字は既定の名前にする', () => {
    expect(safeRosterSheetName('   ')).toBe('名称未設定');
  });
});

describe('gradeRosterSheetName', () => {
  it('学年別シートの名前を作る', () => {
    expect(gradeRosterSheetName('クラス別', 2)).toBe('クラス別 2年');
    expect(gradeRosterSheetName('招集順', 3)).toBe('招集順 3年');
  });
});

describe('replaceRosterMetadataVersion', () => {
  it('版名と作成日時だけを差し替え、登録件数は残す', () => {
    expect(replaceRosterMetadataVersion(
      '版：確認版_v1.0 / 作成：2026/05/01 09:00 / 登録：24件', '確認版_v1.1', '2026/05/02 10:00',
    )).toBe('版：確認版_v1.1 / 作成：2026/05/02 10:00 / 登録：24件');
  });

  it('見出しの形が違う行は触らない', () => {
    expect(replaceRosterMetadataVersion('走順・役割', '確認版_v1.1', '2026/05/02 10:00'))
      .toBe('走順・役割');
  });
});
