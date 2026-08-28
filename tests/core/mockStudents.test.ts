import { describe, expect, it } from 'vitest';
import { generateMockStudents } from '../../src/core/mockStudents';

describe('generateMockStudents', () => {
  it('1〜3年・1〜8組について39・40・41人を決定的に生成する', () => {
    const first = generateMockStudents();
    const second = generateMockStudents();

    expect(second).toEqual(first);
    expect(first).toHaveLength(3 * (39 + 40 + 41 + 39 + 40 + 41 + 39 + 40));
    for (let grade = 1; grade <= 3; grade += 1) {
      for (let classNumber = 1; classNumber <= 8; classNumber += 1) {
        const expected = 39 + ((classNumber - 1) % 3);
        expect(first.filter((student) => student.grade === grade && student.classNumber === classNumber)).toHaveLength(expected);
      }
    }
  });

  it('各学年4組には出席番号7番の欠番がある', () => {
    const students = generateMockStudents();
    for (let grade = 1; grade <= 3; grade += 1) {
      expect(students.some((student) => student.studentId === `${grade}407`)).toBe(false);
      expect(students.some((student) => student.studentId === `${grade}440`)).toBe(true);
    }
  });

  it('学籍番号が異なる同姓同名の疑似生徒を含む', () => {
    const sameNameStudents = generateMockStudents().filter((student) => student.name === '架空同姓同名-1年8組');
    expect(sameNameStudents).toHaveLength(2);
    expect(new Set(sameNameStudents.map((student) => student.studentId)).size).toBe(2);
  });
});
