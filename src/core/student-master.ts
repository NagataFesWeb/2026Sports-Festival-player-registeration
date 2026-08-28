import type { Student } from '../shared/types';

export interface ProductionStudentInputRow {
  rowNumber: number;
  studentId: string;
  name: string;
  gender?: string;
}

export function normalizeProductionStudentId(value: string): string {
  return value.trim().replace(/[０-９]/g, (digit) =>
    String.fromCharCode(digit.charCodeAt(0) - 0xFEE0));
}

export function normalizeGender(value: string | undefined): NonNullable<Student['gender']> {
  const normalized = String(value ?? '').normalize('NFKC').trim().toUpperCase();
  return normalized === 'M' ? 'M' : normalized === 'F' ? 'F' : 'U';
}

export function buildProductionStudents(rows: ProductionStudentInputRow[]): Student[] {
  const errors: string[] = [];
  const seen = new Map<string, number>();
  const students = rows.map((row) => {
    const studentId = normalizeProductionStudentId(row.studentId);
    const name = row.name.trim();
    const gender = normalizeGender(row.gender);
    if (!/^\d{4}$/.test(studentId)) {
      errors.push(`${row.rowNumber}行目：学籍番号は4ケタの数字で入力してください。`);
    }
    if (name === '') errors.push(`${row.rowNumber}行目：氏名を入力してください。`);
    if (gender === 'U') errors.push(`${row.rowNumber}行目：性別はmまたはfで入力してください。`);
    const previousRow = seen.get(studentId);
    if (studentId && previousRow) {
      errors.push(`${row.rowNumber}行目：学籍番号${studentId}は${previousRow}行目と重複しています。`);
    }
    if (studentId) seen.set(studentId, row.rowNumber);
    return {
      studentId,
      name,
      grade: Number(studentId.slice(0, 1)),
      classNumber: Number(studentId.slice(1, 2)),
      attendanceNumber: Number(studentId.slice(2, 4)),
      gender,
    };
  });
  if (errors.length > 0) {
    throw new Error(`「生徒マスター」を直してください。\n${errors.slice(0, 10).join('\n')}${errors.length > 10 ? `\nほか${errors.length - 10}件` : ''}`);
  }
  return students;
}
