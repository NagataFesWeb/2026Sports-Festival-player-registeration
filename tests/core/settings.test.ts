import { describe, expect, it } from 'vitest';
import { appliesToGrade, buildCorrectionSlotDefinitions, calculateFormBuildProgress, calculateRegistrationCapacity, formatJapaneseCalendarDate, hasConfigInput, hasRuleConfigInput, parseCalendarDate, resolveRuleTargetSelection, shouldProcessNextFormBuildChunk, validateSettings } from '../../src/core/settings';
import type { EventSetting, FormDesignSetting, RuleSetting } from '../../src/shared/types';

const form: FormDesignSetting = {
  year: 2026, normalTitle: '通常フォーム', correctionTitle: '修正フォーム', deadline: '2026/09/05(土)',
  sendResponseCopy: true, loginRequired: true, gradeBranching: true, normalResubmission: '禁止',
  applyBeforeApproval: '禁止', formStatus: '未作成', normalFormId: '', correctionFormId: '',
  normalEditUrl: '', correctionEditUrl: '',
  formsFolderId: '', formsFolderUrl: '',
};
const event = (values: Partial<EventSetting> = {}): EventSetting => ({
  year: 2026, eventId: 'E001', enabled: true, targetGrade: '全学年', eventName: '100m走',
  category: '男子', requiredCount: 2, hasOrder: true, vacancyAllowed: false,
  assemblyOrder: 10, displayOrder: 10, note: '', ...values,
});
const rule = (values: Partial<RuleSetting> = {}): RuleSetting => ({
  ruleId: 'R001', enabled: true, ruleName: '指定競技の確認', target: '指定競技',
  targetEventIds: 'E001', condition: '同一生徒の登録数', limit: 2, judgment: 'エラー',
  displayMessage: '上限を確認してください', note: '', ...values,
});

describe('フォーム作成の一括処理上限', () => {
  it('8区切り未満かつ2分未満なら次を処理する', () => {
    expect(shouldProcessNextFormBuildChunk(7, 119_999)).toBe(true);
  });

  it('8区切り完了または2分到達で次回へ引き継ぐ', () => {
    expect(shouldProcessNextFormBuildChunk(8, 1_000)).toBe(false);
    expect(shouldProcessNextFormBuildChunk(1, 120_000)).toBe(false);
  });
});

describe('フォーム作成プログレスバー', () => {
  it('学年ページと学年別競技数を含めて進捗を計算する', () => {
    expect(calculateFormBuildProgress({
      phase: 'NORMAL_EVENTS', eventIds: ['E001'], normalGrade: 2,
      normalEventIndex: 1, normalPageCount: 2, correctionEventIndex: 0,
    }, [event()])).toEqual({ completed: 5, total: 11, percent: 45 });
  });

  it('最終切替時は100パーセントになる', () => {
    expect(calculateFormBuildProgress({
      phase: 'FINALIZE', eventIds: ['E001'], normalGrade: 4,
      normalEventIndex: 0, normalPageCount: 3, correctionEventIndex: 1,
    }, [event()])).toEqual({ completed: 11, total: 11, percent: 100 });
  });
});

describe('日本標準時の締切日', () => {
  it('曜日を日付から再計算して一般的な日本語形式にする', () => {
    expect(formatJapaneseCalendarDate('2026/09/13(木)')).toBe('2026/09/13(日)');
    expect(formatJapaneseCalendarDate('2026-09-05 17:00')).toBe('2026/09/05(土)');
  });

  it('存在しない日付を拒否する', () => {
    expect(parseCalendarDate('2026/02/30')).toBeUndefined();
    const result = validateSettings([], [], { ...form, deadline: '2026/02/30' });
    expect(result.issues.some((issue) => issue.targetId === '締切')).toBe(true);
  });
});

describe('設定点検', () => {
  it('正しい設定はエラー0件になる', () => {
    expect(validateSettings([event()], [rule()], form).issues).toEqual([]);
  });

  it('個人Googleアカウント運用でも回答者メールを記録するためログインを必須にする', () => {
    const result = validateSettings([event()], [rule()], { ...form, loginRequired: false });
    expect(result.issues.some((issue) => issue.targetId === 'ログイン必須')).toBe(true);
  });

  it('重複ID、必要人数、存在しない対象競技を初心者向けに示す', () => {
    const result = validateSettings(
      [event({ requiredCount: 0 }), event({ eventName: 'リレー', displayOrder: 20 })],
      [rule({ targetEventIds: 'E099' })], form,
    );
    expect(result.eventErrorCount).toBeGreaterThanOrEqual(3);
    expect(result.ruleErrorCount).toBe(1);
    expect(result.issues.map((issue) => issue.instruction).join('\n')).toContain('競技設定');
    expect(result.issues.map((issue) => issue.instruction).join('\n')).toContain('E099');
  });

  it('無効ルールは未確定値を保持したまま検査対象外にできる', () => {
    const result = validateSettings([event()], [rule({ enabled: false, targetEventIds: 'E999' })], form);
    expect(result.ruleErrorCount).toBe(0);
  });

  it('全学年と学年指定をフォーム分岐へ使える', () => {
    expect(appliesToGrade(event(), 3)).toBe(true);
    expect(appliesToGrade(event({ targetGrade: '2年' }), 1)).toBe(false);
    expect(appliesToGrade(event({ targetGrade: '2年' }), 2)).toBe(true);
  });

  it('未使用行のチェックボックスFALSEだけでは入力済み行にしない', () => {
    expect(hasConfigInput(['', '', false, '', '', '', '', false, false, '', '', ''], [2, 7, 8])).toBe(false);
    expect(hasConfigInput(['', '', false, '', '100m走', '', '', false, false, '', '', ''], [2, 7, 8])).toBe(true);
    expect(hasConfigInput(['', false, '', '', '', '', '', '', '', ''], [1])).toBe(false);
  });

  it('互換用の対象値だけが入った空白ルール行をエラーにしない', () => {
    const emptyRule: RuleSetting = {
      ruleId: '', enabled: false, ruleName: '', target: '指定競技', targetEventIds: '',
      condition: '', limit: Number.NaN, judgment: '' as RuleSetting['judgment'],
      displayMessage: '', note: '',
    };
    expect(validateSettings([event()], [emptyRule], form).ruleErrorCount).toBe(0);
  });

  it('ルール設定行の使用中判定は自動生成列と互換列を除いて行う', () => {
    // 列順: rule_id, 有効, ルール名, 対象, 対象event_id, 旧条件, 旧上限, 判定, 表示メッセージ, 備考, 論理式
    expect(hasRuleConfigInput(['', false, '', '指定競技', 'E001', '', '', '', '', '', ''])).toBe(false);
    expect(hasRuleConfigInput(['', false, '', '', '', '同一生徒の登録数', 2, '', '', '', ''])).toBe(false);
    expect(hasRuleConfigInput(['', false, '', '', '', '', '', '', '', '', ''])).toBe(false);
    expect(hasRuleConfigInput(['', true, '', '', '', '', '', '', '', '', ''])).toBe(true);
    expect(hasRuleConfigInput(['R001', false, '', '', '', '', '', '', '', '', ''])).toBe(true);
    expect(hasRuleConfigInput(['', false, '', '', '', '', '', '', '', '', 'M >= 2'])).toBe(true);
  });

  it('対象競技のチェックだけが残った空白行をrule_id未入力にしない', () => {
    const leftoverRule: RuleSetting = {
      ruleId: '', enabled: false, ruleName: '', target: '指定競技', targetEventIds: 'E001',
      condition: '', limit: Number.NaN, judgment: '' as RuleSetting['judgment'],
      displayMessage: '', note: '', expression: '',
    };
    expect(validateSettings([event()], [leftoverRule], form).ruleErrorCount).toBe(0);
  });

  it('非表示の旧条件・旧上限だけが残った空白行を検査対象にしない', () => {
    const legacyOnlyRule: RuleSetting = {
      ruleId: '', enabled: false, ruleName: '', target: '全競技', targetEventIds: '',
      condition: '同一生徒の登録数', limit: 2, judgment: '' as RuleSetting['judgment'],
      displayMessage: '', note: '', expression: '',
    };
    expect(validateSettings([event()], [legacyOnlyRule], form).ruleErrorCount).toBe(0);
  });

  it('有効にチェックされた行はrule_id未入力を検出する', () => {
    const enabledBlankRule: RuleSetting = {
      ruleId: '', enabled: true, ruleName: '', target: '全競技', targetEventIds: '',
      condition: '', limit: Number.NaN, judgment: '' as RuleSetting['judgment'],
      displayMessage: '', note: '', expression: '',
    };
    const result = validateSettings([event()], [enabledBlankRule], form);
    expect(result.issues.some((issue) => issue.title === 'rule_idが空欄です')).toBe(true);
  });

  it('空白行を除外してもシート上の行番号で案内する', () => {
    const result = validateSettings(
      [event({ rowNumber: 9, eventId: '' })],
      [rule({ rowNumber: 12, ruleId: '' })],
      form,
    );
    const eventIssue = result.issues.find((issue) => issue.title === 'event_idが空欄です');
    const ruleIssue = result.issues.find((issue) => issue.title === 'rule_idが空欄です');
    expect(eventIssue?.rowNumber).toBe(9);
    expect(eventIssue?.instruction).toContain('9行目');
    expect(ruleIssue?.rowNumber).toBe(12);
    expect(ruleIssue?.instruction).toContain('12行目');
  });

  it('対象学年のクラス数を掛けて競技の登録枠合計を計算する', () => {
    const capacity = calculateRegistrationCapacity([
      event({ requiredCount: 2, targetGrade: '全学年' }),
      event({ eventId: 'E002', requiredCount: 3, targetGrade: '2年' }),
    ], 2026, { 1: 8, 2: 8, 3: 8 });
    expect(capacity).toBe(72);
  });

  it('競技の登録枠合計が生徒マスター人数より少ない場合は警告する', () => {
    const result = validateSettings(
      [event({ requiredCount: 1 })], [], form,
      { studentCount: 936, classCountByGrade: { 1: 8, 2: 8, 3: 8 } },
    );
    expect(result.eventWarningCount).toBe(1);
    expect(result.issues[0]?.title).toContain('912人少なく');
    expect(result.issues[0]?.instruction).toContain('登録枠は合計24人分');
  });

  it('競技の登録枠合計が生徒数と同じなら人数警告を出さない', () => {
    const result = validateSettings(
      [event({ requiredCount: 39 })], [], form,
      { studentCount: 936, classCountByGrade: { 1: 8, 2: 8, 3: 8 } },
    );
    expect(result.eventWarningCount).toBe(0);
  });

  it('競技の登録枠合計が生徒マスター人数を超える場合は超過人数を警告する', () => {
    const result = validateSettings(
      [event({ requiredCount: 40 })], [], form,
      { studentCount: 936, classCountByGrade: { 1: 8, 2: 8, 3: 8 } },
    );
    expect(result.eventWarningCount).toBe(1);
    expect(result.issues[0]?.title).toContain('24人多く');
    expect(result.issues[0]?.instruction).toContain('登録枠は合計960人分');
    expect(result.issues[0]?.instruction).toContain('複数の競技へ出る予定');
  });

  it('修正フォーム用に競技の全枠を走順どおり生成する', () => {
    const slots = buildCorrectionSlotDefinitions(event({ eventId: 'RELAY', requiredCount: 4, hasOrder: true }));
    expect(slots).toHaveLength(4);
    expect(slots.map((slot) => slot.label)).toEqual(['第1走者', '第2走者', '第3走者', '第4走者']);
    expect(slots[3]?.studentIdFieldKey).toBe('correction_RELAY_slot04_student_id');
    expect(slots[3]?.nameFieldKey).toBe('correction_RELAY_slot04_name');
  });

  it('フォーム対象の有効な競技がなければエラーにする', () => {
    const result = validateSettings([event({ enabled: false })], [], form);
    expect(result.eventErrorCount).toBe(1);
    expect(result.issues[0]?.title).toContain('競技がありません');
  });

  it('競技設定から複数選択したevent_idをルール対象へ変換する', () => {
    expect(resolveRuleTargetSelection(['E001', 'E003', 'E001'], ['E001', 'E002', 'E003']))
      .toEqual({ target: '指定競技', targetEventIds: 'E001,E003' });
    expect(resolveRuleTargetSelection(['E001', 'E002'], ['E001', 'E002']))
      .toEqual({ target: '全競技', targetEventIds: 'E001,E002' });
  });

  it('有効なルールで対象競技が未選択なら直し方を表示する', () => {
    const result = validateSettings([event()], [rule({ targetEventIds: '' })], form);
    expect(result.ruleErrorCount).toBe(1);
    expect(result.issues[0]?.title).toContain('対象競技が選ばれていません');
    expect(result.issues[0]?.instruction).toContain('チェック');
  });

  it('論理式の未知変数や数値だけの結果を設定エラーにする', () => {
    const unknown = validateSettings([event()], [rule({ expression: 'BOYS >= 2' })], form);
    expect(unknown.issues.some((issue) => issue.title === '論理式を確認してください')).toBe(true);
    const notBoolean = validateSettings([event()], [rule({ expression: 'M + F' })], form);
    expect(notBoolean.issues.some((issue) => issue.instruction.includes('TRUEまたはFALSE'))).toBe(true);
  });

  it('性別人数を使う正しい論理式を受け付ける', () => {
    const result = validateSettings([event()], [rule({
      condition: '', limit: Number.NaN, expression: 'M >= 2 && F >= 2 && UNKNOWN == 0',
    })], form);
    expect(result.ruleErrorCount).toBe(0);
  });
});
