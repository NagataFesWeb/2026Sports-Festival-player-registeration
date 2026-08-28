import { describe, expect, it } from 'vitest';
import { buildParticipationWarnings } from '../../src/core/participation';
import type { Student } from '../../src/shared/types';

const students: Student[] = [
  { studentId: '1101', grade: 1, classNumber: 1, attendanceNumber: 1, name: '架空1' },
  { studentId: '1102', grade: 1, classNumber: 1, attendanceNumber: 2, name: '架空2' },
  { studentId: '1103', grade: 1, classNumber: 1, attendanceNumber: 3, name: '架空3' },
];

describe('全体の未出場警告', () => {
  it('未出場人数を何人でも1件の警告へまとめる', () => {
    const warnings = buildParticipationWarnings(students, ['1101']);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.title).toBe('出場していない生徒が2人います');
    expect(warnings[0]?.affectedStudents).toEqual([
      { studentId: '1102', grade: 1, classNumber: 1, name: '架空2' },
      { studentId: '1103', grade: 1, classNumber: 1, name: '架空3' },
    ]);
  });

  it('全員が登録されていれば警告しない', () => {
    expect(buildParticipationWarnings(students, students.map((student) => student.studentId))).toEqual([]);
  });
});
