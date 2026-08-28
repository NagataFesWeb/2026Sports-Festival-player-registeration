import type { Student } from '../shared/types';

/**
 * Generates a deterministic, obviously fictional student master for local tests.
 * Class sizes repeat 39, 40, and 41. Class 4 in each grade deliberately skips
 * attendance number 7 while retaining its configured class size.
 */
export function generateMockStudents(): Student[] {
  const students: Student[] = [];

  for (let grade = 1; grade <= 3; grade += 1) {
    for (let classNumber = 1; classNumber <= 8; classNumber += 1) {
      const classSize = 39 + ((classNumber - 1) % 3);
      const hasGap = classNumber === 4;
      const lastAttendanceNumber = classSize + (hasGap ? 1 : 0);

      for (let attendanceNumber = 1; attendanceNumber <= lastAttendanceNumber; attendanceNumber += 1) {
        if (hasGap && attendanceNumber === 7) continue;

        const duplicateName = classNumber === 8 && (attendanceNumber === 38 || attendanceNumber === 39);
        students.push({
          studentId: `${grade}${classNumber}${String(attendanceNumber).padStart(2, '0')}`,
          grade,
          classNumber,
          attendanceNumber,
          name: duplicateName
            ? `架空同姓同名-${grade}年8組`
            : `架空生徒-${grade}年${classNumber}組${String(attendanceNumber).padStart(2, '0')}番`,
          gender: attendanceNumber % 2 === 0 ? 'F' : 'M',
        });
      }
    }
  }

  return students;
}
