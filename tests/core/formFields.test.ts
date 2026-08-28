import { describe, expect, it } from 'vitest';
import {
  isStudentIdField,
  STUDENT_ID_RESPONSE_ERROR,
  STUDENT_ID_RESPONSE_PATTERN,
} from '../../src/core/form-fields';

describe('Googleフォームの学籍番号欄', () => {
  it('入力者・通常申請・修正申請の学籍番号欄をすべて判定する', () => {
    expect(isStudentIdField('submitter_student_id')).toBe(true);
    expect(isStudentIdField('RELAY_slot01_student_id')).toBe(true);
    expect(isStudentIdField('correction_RELAY_slot04_student_id')).toBe(true);
    expect(isStudentIdField('submitter_name_input')).toBe(false);
    expect(isStudentIdField('RELAY_slot01_name')).toBe(false);
  });

  it('半角数字4桁だけを受け付ける', () => {
    const pattern = new RegExp(STUDENT_ID_RESPONSE_PATTERN);
    expect(pattern.test('1101')).toBe(true);
    expect(pattern.test('123')).toBe(false);
    expect(pattern.test('12345')).toBe(false);
    expect(pattern.test('12a4')).toBe(false);
    expect(pattern.test('１２３４')).toBe(false);
    expect(pattern.test(' 1101 ')).toBe(false);
  });

  it('指定されたエラー内容を表示する', () => {
    expect(STUDENT_ID_RESPONSE_ERROR).toBe('4ケタの学籍番号を数値で入力してください');
  });
});
