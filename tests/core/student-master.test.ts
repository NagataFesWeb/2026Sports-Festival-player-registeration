import { describe, expect, it } from 'vitest';
import { buildProductionStudents } from '../../src/core/student-master';

describe('本番用生徒マスター', () => {
  it('学籍番号から学年・組・出席番号を生成する', () => {
    expect(buildProductionStudents([
      { rowNumber: 2, studentId: '１３２４', name: 'テスト生徒', gender: 'f' },
    ])).toEqual([{
      studentId: '1324', name: 'テスト生徒', grade: 1, classNumber: 3, attendanceNumber: 24,
      gender: 'F',
    }]);
  });

  it('性別はm/fを正規化し、それ以外を行番号付きで拒否する', () => {
    expect(buildProductionStudents([
      { rowNumber: 2, studentId: '1324', name: 'テスト生徒', gender: 'Ｍ' },
    ])[0]?.gender).toBe('M');
    expect(() => buildProductionStudents([
      { rowNumber: 4, studentId: '1325', name: 'テスト生徒2', gender: 'x' },
    ])).toThrow('4行目：性別はmまたはf');
  });

  it('入力不足と重複を行番号付きで拒否する', () => {
    expect(() => buildProductionStudents([
      { rowNumber: 2, studentId: '1324', name: 'テスト生徒' },
      { rowNumber: 3, studentId: '1324', name: '' },
      { rowNumber: 5, studentId: '123', name: 'テスト生徒2' },
    ])).toThrow(/3行目：氏名.*3行目：学籍番号1324.*5行目：学籍番号/s);
  });
});
