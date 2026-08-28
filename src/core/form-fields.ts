export const STUDENT_ID_RESPONSE_PATTERN = '^[0-9]{4}$';

export const STUDENT_ID_RESPONSE_ERROR = '4ケタの学籍番号を数値で入力してください';

export function isStudentIdField(fieldKey: string): boolean {
  return fieldKey.endsWith('_student_id');
}
