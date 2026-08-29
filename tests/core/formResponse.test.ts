import { describe, expect, it } from 'vitest';
import { convertFormAnswer } from '../../src/core/form-response';
import type { EventSetting, FormRegistryRow } from '../../src/shared/types';

const event: EventSetting = {
  year: 2026, eventId: 'RELAY', enabled: true, targetGrade: '全学年', eventName: '400mリレー',
  category: '混合', requiredCount: 2, hasOrder: true, vacancyAllowed: false,
  assemblyOrder: 10, displayOrder: 10, note: '',
};
const mapping = (fieldKey: string, itemId: string, eventId = ''): FormRegistryRow => ({
  formType: 'normal', formId: 'form-1', itemId, fieldKey, eventId,
  title: eventId ? `400mリレー 第${fieldKey.includes('02') ? '2' : '1'}走者 ${fieldKey.endsWith('_name') ? '氏名' : '学籍番号'}` : fieldKey,
  itemType: 'text', displayOrder: Number(itemId), enabled: true,
});

describe('フォーム回答の申請変換', () => {
  it('通常フォームの回答を承認待ち用の申請と全競技項目へ変換する', () => {
    const result = convertFormAnswer({
      formId: 'form-1', responseId: 'response-1', formType: 'normal',
      submittedAt: '2026-07-17T00:00:00.000Z', respondentEmail: 'mock@example.invalid', receptionOpen: true,
      answersByFieldKey: {
        submitter_student_id: '1101', submitter_name_input: '架空生徒', target_grade: '1年',
        target_class: '1組', is_proxy: '自分のクラスを入力',
        RELAY_slot01_student_id: '1102', RELAY_slot01_name: '架空生徒02',
        RELAY_slot02_student_id: '1103', RELAY_slot02_name: '架空生徒03',
      },
      registry: [
        mapping('RELAY_slot01_student_id', '10', 'RELAY'), mapping('RELAY_slot01_name', '11', 'RELAY'),
        mapping('RELAY_slot02_student_id', '20', 'RELAY'), mapping('RELAY_slot02_name', '21', 'RELAY'),
        mapping('RELAY_slot01_student_id', '99', 'RELAY'),
      ], events: [event],
    });
    expect(result.submission.submissionId).toBe('FORM-form-1-response-1');
    expect(result.submission.targetGrade).toBe(1);
    expect(result.items.map((item) => item.slotName)).toEqual(['第1走者', '第2走者']);
    expect(result.items.map((item) => item.studentIdInput)).toEqual(['1102', '1103']);
    expect(result.items).toHaveLength(2);
  });

  it('氏名欄のないフォーム回答を学籍番号だけで変換する', () => {
    const result = convertFormAnswer({
      formId: 'form-3', responseId: 'response-3', formType: 'normal',
      submittedAt: '2026-07-17T00:00:00.000Z', respondentEmail: 'mock@example.invalid', receptionOpen: true,
      answersByFieldKey: {
        submitter_student_id: '1101', submitter_name_input: '架空生徒', target_grade: '1年',
        target_class: '1組', is_proxy: '自分のクラスを入力',
        RELAY_slot01_student_id: '1102',
        RELAY_slot02_student_id: '1103',
      },
      registry: [
        mapping('RELAY_slot01_student_id', '10', 'RELAY'),
        mapping('RELAY_slot02_student_id', '20', 'RELAY'),
      ], events: [event],
    });
    expect(result.items.map((item) => item.studentIdInput)).toEqual(['1102', '1103']);
    expect(result.items.map((item) => item.studentNameInput)).toEqual(['', '']);
    expect(result.items.map((item) => item.registrationState)).toEqual(['REGISTER', 'REGISTER']);
  });

  it('修正フォームは選択した1競技の全走者をCORRECTIONとして変換する', () => {
    const registry = [1, 2].flatMap((slot) => [
      { ...mapping(`correction_RELAY_slot0${slot}_student_id`, `${slot}0`, 'RELAY'), formType: 'correction' as const },
      { ...mapping(`correction_RELAY_slot0${slot}_name`, `${slot}1`, 'RELAY'), formType: 'correction' as const },
    ]);
    const result = convertFormAnswer({
      formId: 'form-2', responseId: 'response-2', formType: 'correction',
      submittedAt: '2026-07-17T00:00:00.000Z', respondentEmail: 'mock@example.invalid', receptionOpen: true,
      answersByFieldKey: {
        submitter_student_id: '1101', submitter_name_input: '架空生徒', target_class: '1年1組',
        correction_RELAY_slot01_student_id: '1102', correction_RELAY_slot01_name: '架空生徒02',
        correction_RELAY_slot02_student_id: '1104', correction_RELAY_slot02_name: '架空生徒04',
      }, registry, events: [event],
    });
    expect(result.submission.submissionType).toBe('CORRECTION');
    expect(result.items).toHaveLength(2);
  });

  it('同じフォーム回答は同じ申請IDになる', () => {
    const context = {
      formId: 'form-1', responseId: 'same', formType: 'normal' as const,
      submittedAt: '2026-07-17T00:00:00.000Z', respondentEmail: '', receptionOpen: true,
      answersByFieldKey: { target_grade: '1年', target_class: '1組' }, registry: [], events: [],
    };
    expect(convertFormAnswer(context).submission.submissionId).toBe(convertFormAnswer(context).submission.submissionId);
  });
});
