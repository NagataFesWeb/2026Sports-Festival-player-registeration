import { describe, expect, it } from 'vitest';
import {
  buildLiveFormTestCases,
  compareLiveFormTestOutcome,
  correctionSectionChoiceFor,
  describeDifference,
  isSameAnswerSet,
  pickRegistryRowForAnswer,
  readSlotFields,
  summarizeItems,
  type LiveFormTestBuildInput,
} from '../../src/core/live-form-test';
import type {
  EventSetting,
  FormRegistryRow,
  Student,
  SubmissionItem,
} from '../../src/shared/types';

const relay: EventSetting = {
  year: 2026, eventId: 'RELAY', enabled: true, targetGrade: '全学年', eventName: '400mリレー',
  category: '混合', requiredCount: 2, hasOrder: true, vacancyAllowed: false,
  assemblyOrder: 10, displayOrder: 10, note: '',
};
const boysRace: EventSetting = {
  ...relay, eventId: 'M100', eventName: '男子100m', category: '男子',
  requiredCount: 1, hasOrder: false, vacancyAllowed: true, displayOrder: 20,
};

const registryRow = (
  formType: 'normal' | 'correction',
  fieldKey: string,
  itemId: string,
  eventId = '',
  displayOrder = Number(itemId),
): FormRegistryRow => ({
  formType, formId: formType === 'normal' ? 'form-normal' : 'form-correction',
  itemId, fieldKey, eventId, title: fieldKey, itemType: 'text', displayOrder, enabled: true,
});

const normalRegistry: FormRegistryRow[] = [
  registryRow('normal', 'submitter_student_id', '1'),
  registryRow('normal', 'submitter_name_input', '2'),
  registryRow('normal', 'target_class', '3'),
  registryRow('normal', 'is_proxy', '4'),
  registryRow('normal', 'target_grade', '5'),
  registryRow('normal', 'RELAY_slot1_student_id', '11', 'RELAY', 1011),
  registryRow('normal', 'RELAY_slot2_student_id', '12', 'RELAY', 1021),
  registryRow('normal', 'M100_slot1_state', '13', 'M100', 2010),
  registryRow('normal', 'M100_slot1_student_id', '14', 'M100', 2011),
];

const correctionRegistry: FormRegistryRow[] = [
  registryRow('correction', 'submitter_student_id', '21'),
  registryRow('correction', 'submitter_name_input', '22'),
  registryRow('correction', 'target_class', '23'),
  registryRow('correction', 'correction_reason', '24'),
  registryRow('correction', 'correction_event_id', '25'),
  registryRow('correction', 'correction_RELAY_slot1_student_id', '31', 'RELAY', 1011),
  registryRow('correction', 'correction_RELAY_slot2_student_id', '32', 'RELAY', 1021),
];

const student = (studentId: string, gender: NonNullable<Student['gender']>): Student => ({
  studentId,
  grade: Number(studentId[0]),
  classNumber: Number(studentId[1]),
  attendanceNumber: Number(studentId.slice(2)),
  name: `架空生徒${studentId}`,
  gender,
});

const input = (override: Partial<LiveFormTestBuildInput> = {}): LiveFormTestBuildInput => ({
  targetGrade: 3,
  targetClass: 8,
  classStudents: [
    student('3801', 'F'), student('3802', 'M'), student('3803', 'F'), student('3804', 'M'),
  ],
  otherClassStudentId: '3701',
  unknownStudentId: '3899',
  submitterStudentId: '9999',
  submitterName: '実機テスト（削除予定）',
  correctionReason: '実機テストのための送信です。',
  events: [relay, boysRace],
  normalRegistry,
  correctionRegistry,
  ...override,
});

describe('実機テストのケース組み立て', () => {
  it('対応表から競技の選手枠を表示順で取り出し、登録状態欄の有無を見分ける', () => {
    const slots = readSlotFields(normalRegistry);
    expect(slots.map((slot) => slot.studentIdFieldKey))
      .toEqual(['RELAY_slot1_student_id', 'RELAY_slot2_student_id', 'M100_slot1_student_id']);
    expect(slots[0]?.stateFieldKey).toBe('');
    expect(slots[2]?.stateFieldKey).toBe('M100_slot1_state');
  });

  it('通常フォームの全枠を在籍する生徒で埋め、対象の学年・組を回答へ入れる', () => {
    const cases = buildLiveFormTestCases(input());
    const normal = cases.find((testCase) => testCase.formType === 'normal');
    expect(normal?.caseId).toBe('LT-01');
    expect(normal?.answersByFieldKey.target_grade).toBe('3年');
    expect(normal?.answersByFieldKey.target_class).toBe('8組');
    expect(normal?.answersByFieldKey.submitter_student_id).toBe('9999');
    expect(normal?.answersByFieldKey.M100_slot1_state).toBe('選手を登録する');
    const filled = [
      normal?.answersByFieldKey.RELAY_slot1_student_id ?? '',
      normal?.answersByFieldKey.RELAY_slot2_student_id ?? '',
      normal?.answersByFieldKey.M100_slot1_student_id ?? '',
    ];
    expect(filled.every((studentId) => studentId.startsWith('38'))).toBe(true);
    expect(new Set(filled).size).toBe(3);
  });

  it('男子競技には男子の生徒を割り当てる', () => {
    const cases = buildLiveFormTestCases(input());
    const normal = cases.find((testCase) => testCase.formType === 'normal');
    expect(['3802', '3804']).toContain(normal?.answersByFieldKey.M100_slot1_student_id);
  });

  it('修正フォームでは正常・存在しない番号・別クラス番号の3件を作る', () => {
    const cases = buildLiveFormTestCases(input());
    const correction = cases.filter((testCase) => testCase.formType === 'correction');
    expect(correction.map((testCase) => testCase.kind)).toEqual([
      'CORRECTION_VALID', 'CORRECTION_STUDENT_NOT_FOUND', 'CORRECTION_CLASS_MISMATCH',
    ]);
    expect(correction[0]?.answersByFieldKey.target_class).toBe('3年8組');
    expect(correction[0]?.answersByFieldKey.correction_event_id).toBe('400mリレー ほか1競技');
    expect(correction[1]?.answersByFieldKey.correction_RELAY_slot1_student_id).toBe('3899');
    expect(correction[2]?.answersByFieldKey.correction_RELAY_slot1_student_id).toBe('3701');
    expect(correction[2]?.answersByFieldKey.correction_RELAY_slot2_student_id)
      .toBe(correction[0]?.answersByFieldKey.correction_RELAY_slot2_student_id);
  });

  it('別クラスの生徒や空き番号が用意できない場合はそのケースを作らない', () => {
    const cases = buildLiveFormTestCases(input({ otherClassStudentId: '', unknownStudentId: '' }));
    expect(cases.map((testCase) => testCase.kind)).toEqual(['NORMAL_VALID', 'CORRECTION_VALID']);
  });

  it('生徒が枠数より少ない場合も、足りない分は先頭の生徒を再利用して回答を作る', () => {
    const cases = buildLiveFormTestCases(input({ classStudents: [student('3801', 'M')] }));
    const normal = cases.find((testCase) => testCase.formType === 'normal');
    expect(normal?.answersByFieldKey.RELAY_slot1_student_id).toBe('3801');
    expect(normal?.answersByFieldKey.RELAY_slot2_student_id).toBe('3801');
  });

  it('修正する競技の選択肢をセクション単位でフォーム作成時と同じ文言で組み立てる', () => {
    // 表示順10と20は同じ100番台なので1つのセクションにまとまる。
    expect(correctionSectionChoiceFor([relay, boysRace], boysRace)).toBe('400mリレー ほか1競技');
    // 表示順を100番台へ離すと別セクションになり、単独の競技名で選べる。
    const separated = { ...boysRace, displayOrder: 120 };
    expect(correctionSectionChoiceFor([relay, separated], separated)).toBe('男子100m（男子 / M100）');
  });
});

describe('実機テストの結果照合', () => {
  const item = (override: Partial<SubmissionItem>): SubmissionItem => ({
    submissionItemId: 'S-item-001', submissionId: 'S', eventId: 'RELAY', eventName: '400mリレー',
    slotId: 'RELAY-slot-01', slotName: '第1走者', studentIdInput: '3801', studentNameInput: '',
    normalizedStudentId: '3801', normalizedName: '', registrationState: 'REGISTER', required: true,
    ...override,
  });

  it('空欄を無視して同じ回答内容かを判定する', () => {
    expect(isSameAnswerSet(
      { submitter_student_id: '9999', RELAY_slot1_student_id: '3801', RELAY_slot2_student_id: '' },
      { submitter_student_id: '9999', RELAY_slot1_student_id: '3801' },
    )).toBe(true);
    expect(isSameAnswerSet(
      { RELAY_slot1_student_id: '3801' },
      { RELAY_slot1_student_id: '3802' },
    )).toBe(false);
    expect(isSameAnswerSet(
      { RELAY_slot1_student_id: '3801' },
      { RELAY_slot1_student_id: '3801', RELAY_slot2_student_id: '3802' },
    )).toBe(false);
  });

  it('申請項目を学籍番号なしの形へ畳む', () => {
    expect(summarizeItems([item({}), item({ normalizedStudentId: '', slotId: 'RELAY-slot-02' })]))
      .toEqual(['RELAY/RELAY-slot-01/REGISTER/FILLED/REQUIRED', 'RELAY/RELAY-slot-02/REGISTER/EMPTY/REQUIRED']);
  });

  it('期待と実際が一致すればOKと判定する', () => {
    const outcome = {
      issueCodes: ['STUDENT_NOT_FOUND'], targetGrade: 3, targetClass: 8,
      itemInputs: ['RELAY/RELAY-slot-01/REGISTER/FILLED/REQUIRED'],
    };
    const difference = compareLiveFormTestOutcome(outcome, { ...outcome });
    expect(difference.ok).toBe(true);
    expect(describeDifference(difference)).toBe('');
  });

  it('検出されなかった判定と想定外の判定を、重複も数えて示す', () => {
    const difference = compareLiveFormTestOutcome(
      {
        issueCodes: ['STUDENT_NOT_FOUND', 'STUDENT_NOT_FOUND'], targetGrade: 3, targetClass: 8,
        itemInputs: ['RELAY/RELAY-slot-01/REGISTER/FILLED/REQUIRED'],
      },
      {
        issueCodes: ['STUDENT_NOT_FOUND', 'PROXY_SUBMISSION'], targetGrade: 3, targetClass: 7,
        itemInputs: [],
      },
    );
    expect(difference.ok).toBe(false);
    expect(difference.missingIssueCodes).toEqual(['STUDENT_NOT_FOUND']);
    expect(difference.unexpectedIssueCodes).toEqual(['PROXY_SUBMISSION']);
    expect(difference.itemMismatchCount).toBe(1);
    expect(difference.targetMismatch).toBe(true);
    expect(describeDifference(difference)).toContain('検出されなかった判定：STUDENT_NOT_FOUND');
    expect(describeDifference(difference)).toContain('想定外の判定：PROXY_SUBMISSION');
    expect(describeDifference(difference)).toContain('対象学年・組が投入内容と一致しません');
  });
});

describe('pickRegistryRowForAnswer', () => {
  // 全学年の競技は学年ページごとに同じfield_keyの設問が作られる。
  const gradePages: FormRegistryRow[] = [
    registryRow('normal', 'RELAY_slot1_student_id', '101', 'RELAY', 1011),
    registryRow('normal', 'RELAY_slot1_student_id', '201', 'RELAY', 1011),
    registryRow('normal', 'RELAY_slot1_student_id', '301', 'RELAY', 1011),
  ];

  it('回答が進むページにある設問を選ぶ', () => {
    const picked = pickRegistryRowForAnswer(
      gradePages, 'RELAY_slot1_student_id', new Set(['201', '202']),
    );
    expect(picked?.itemId).toBe('201');
  });

  it('ページを特定できない場合は最初の設問を使う', () => {
    const picked = pickRegistryRowForAnswer(gradePages, 'RELAY_slot1_student_id', new Set());
    expect(picked?.itemId).toBe('101');
  });

  it('無効な行は選ばない', () => {
    const picked = pickRegistryRowForAnswer(
      [{ ...gradePages[0]!, enabled: false }, gradePages[1]!],
      'RELAY_slot1_student_id',
      new Set(),
    );
    expect(picked?.itemId).toBe('201');
  });

  it('対応表にないfield_keyでは何も返さない', () => {
    expect(pickRegistryRowForAnswer(gradePages, 'unknown_key', new Set())).toBeUndefined();
  });
});
