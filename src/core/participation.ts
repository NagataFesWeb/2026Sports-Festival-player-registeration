import type { GlobalWarning, Student } from '../shared/types';

export function buildParticipationWarnings(
  students: Student[],
  registeredStudentIds: Iterable<string>,
): GlobalWarning[] {
  const registered = new Set(registeredStudentIds);
  const affectedStudents = students
    .filter((student) => !registered.has(student.studentId))
    .sort((left, right) => left.grade - right.grade
      || left.classNumber - right.classNumber
      || left.studentId.localeCompare(right.studentId))
    .map((student) => ({
      studentId: student.studentId,
      grade: student.grade,
      classNumber: student.classNumber,
      name: student.name,
    }));
  const count = affectedStudents.length;
  if (count === 0) return [];
  return [{
    code: 'STUDENTS_WITHOUT_REGISTRATION',
    title: `出場していない生徒が${count}人います`,
    message: '全校の生徒マスターと、現在登録されている選手の学籍番号を比べた結果です。',
    fixInstruction: '登録漏れがないか確認してください。出場しないことが正しい生徒は、修正せずそのままで構いません。',
    count,
    affectedStudents,
  }];
}
