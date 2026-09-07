import { describe, expect, it } from 'vitest';
import {
  evaluateRuleExpression,
  referencedRuleVariables,
  RULE_EXPRESSION_VARIABLES,
  type RuleExpressionValues,
  validateRuleExpression,
} from '../../src/core/rule-expression';

const values = (overrides: Partial<RuleExpressionValues> = {}): RuleExpressionValues => ({
  M: 2, F: 2, N: 4, UNKNOWN: 0, EMPTY: 0, REQUIRED_EMPTY: 0,
  UNIQUE: 4, DUPLICATE: 0, MAX_PER_STUDENT: 1, MAX_PER_EVENT: 1, INVALID_ID: 0,
  NAME_MISMATCH: 0, CLASS_MISMATCH: 0, PENDING: 0,
  ...overrides,
});

describe('ルール論理式', () => {
  it('人数比較、四則演算、括弧、AND/OR/NOTを安全に評価する', () => {
    expect(evaluateRuleExpression('M >= 2 && F >= 2', values())).toBe(true);
    expect(evaluateRuleExpression('(M + F) == N AND NOT(UNKNOWN > 0)', values())).toBe(true);
    expect(evaluateRuleExpression('=M >= 2 && F >= 2', values())).toBe(true);
    expect(evaluateRuleExpression('F == 0 OR M == 0', values())).toBe(false);
  });

  it('英字の大文字小文字と別名を受け付ける', () => {
    expect(evaluateRuleExpression('male == 2 && female == 2 && total == 4', values())).toBe(true);
  });

  it('未知の変数、任意コード、数値だけの結果を拒否する', () => {
    expect(validateRuleExpression('BOY >= 2')).toContain('使用できません');
    expect(validateRuleExpression('M; SpreadsheetApp')).toContain('使用できません');
    expect(validateRuleExpression('M + F')).toContain('TRUEまたはFALSE');
    expect(RULE_EXPRESSION_VARIABLES).toContain('MAX_PER_STUDENT');
  });
});

describe('論理式が参照する変数', () => {
  it('別名を解決し、重複なく出現順に返す', () => {
    expect(referencedRuleVariables('unique >= 40 && MALE > 0 && M < 50')).toEqual(['UNIQUE', 'M']);
    expect(referencedRuleVariables('=N == UNIQUE')).toEqual(['N', 'UNIQUE']);
  });

  it('未知の名前は含めず、壊れた論理式や空欄では空配列を返す', () => {
    expect(referencedRuleVariables('BOY >= 2 && F == 0')).toEqual(['F']);
    expect(referencedRuleVariables('')).toEqual([]);
    expect(referencedRuleVariables('M >= 2 && ;')).toEqual([]);
  });
});
