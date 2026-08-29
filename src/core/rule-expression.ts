export const RULE_EXPRESSION_VARIABLES = [
  'M', 'F', 'N', 'UNKNOWN', 'EMPTY', 'REQUIRED_EMPTY', 'UNIQUE',
  'DUPLICATE', 'MAX_PER_STUDENT', 'MAX_PER_EVENT', 'INVALID_ID', 'NAME_MISMATCH', 'CLASS_MISMATCH', 'PENDING',
] as const;

export type RuleExpressionVariable = typeof RULE_EXPRESSION_VARIABLES[number];
export type RuleExpressionValues = Record<RuleExpressionVariable, number>;

type Value = number | boolean;
type Token = { type: 'NUMBER' | 'IDENTIFIER' | 'OPERATOR' | 'LPAREN' | 'RPAREN' | 'EOF'; text: string };

const ALIASES: Record<string, RuleExpressionVariable> = {
  MALE: 'M', FEMALE: 'F', TOTAL: 'N', UNKNOWNS: 'UNKNOWN',
};

function tokenize(source: string): Token[] {
  if (source.length > 500) throw new Error('論理式は500文字以内で入力してください。');
  const tokens: Token[] = [];
  let index = 0;
  while (index < source.length) {
    const rest = source.slice(index);
    const whitespace = rest.match(/^\s+/);
    if (whitespace) { index += whitespace[0].length; continue; }
    const number = rest.match(/^(?:\d+(?:\.\d+)?|\.\d+)/);
    if (number) { tokens.push({ type: 'NUMBER', text: number[0] }); index += number[0].length; continue; }
    const identifier = rest.match(/^[A-Za-z_][A-Za-z0-9_]*/);
    if (identifier) {
      const text = identifier[0].toUpperCase();
      tokens.push(['AND', 'OR', 'NOT'].includes(text)
        ? { type: 'OPERATOR', text }
        : { type: 'IDENTIFIER', text });
      index += identifier[0].length;
      continue;
    }
    const operator = rest.match(/^(?:&&|\|\||>=|<=|==|!=|[!><+\-*/%])/);
    if (operator) { tokens.push({ type: 'OPERATOR', text: operator[0] }); index += operator[0].length; continue; }
    if (rest[0] === '(') { tokens.push({ type: 'LPAREN', text: '(' }); index += 1; continue; }
    if (rest[0] === ')') { tokens.push({ type: 'RPAREN', text: ')' }); index += 1; continue; }
    throw new Error(`「${rest[0]}」は論理式で使用できません。`);
  }
  tokens.push({ type: 'EOF', text: '' });
  return tokens;
}

class Parser {
  private index = 0;

  constructor(private readonly tokens: Token[], private readonly values: RuleExpressionValues) {}

  parse(): boolean {
    const value = this.parseOr();
    if (this.current().type !== 'EOF') throw new Error(`「${this.current().text}」の前後を確認してください。`);
    if (typeof value !== 'boolean') throw new Error('論理式の結果がTRUEまたはFALSEになるように比較演算子を入れてください。');
    return value;
  }

  private current(): Token { return this.tokens[this.index]!; }
  private take(): Token { const token = this.current(); this.index += 1; return token; }
  private match(...texts: string[]): boolean {
    if (this.current().type !== 'OPERATOR' || !texts.includes(this.current().text)) return false;
    this.take(); return true;
  }
  private boolean(value: Value, operator: string): boolean {
    if (typeof value !== 'boolean') throw new Error(`${operator}の左右にはTRUEまたはFALSEになる式を入力してください。`);
    return value;
  }
  private number(value: Value, operator: string): number {
    if (typeof value !== 'number') throw new Error(`${operator}の左右には人数または数字を入力してください。`);
    return value;
  }
  private parseOr(): Value {
    let left = this.parseAnd();
    while (this.match('||', 'OR')) {
      const right = this.parseAnd();
      left = this.boolean(left, 'OR') || this.boolean(right, 'OR');
    }
    return left;
  }
  private parseAnd(): Value {
    let left = this.parseComparison();
    while (this.match('&&', 'AND')) {
      const right = this.parseComparison();
      left = this.boolean(left, 'AND') && this.boolean(right, 'AND');
    }
    return left;
  }
  private parseComparison(): Value {
    let left = this.parseAdditive();
    while (this.current().type === 'OPERATOR' && ['>=', '<=', '==', '!=', '>', '<'].includes(this.current().text)) {
      const operator = this.take().text;
      const right = this.parseAdditive();
      if (operator === '==') left = left === right;
      else if (operator === '!=') left = left !== right;
      else {
        const a = this.number(left, operator); const b = this.number(right, operator);
        left = operator === '>=' ? a >= b : operator === '<=' ? a <= b : operator === '>' ? a > b : a < b;
      }
    }
    return left;
  }
  private parseAdditive(): Value {
    let left = this.parseMultiplicative();
    while (this.current().type === 'OPERATOR' && ['+', '-'].includes(this.current().text)) {
      const operator = this.take().text; const right = this.parseMultiplicative();
      left = operator === '+' ? this.number(left, operator) + this.number(right, operator)
        : this.number(left, operator) - this.number(right, operator);
    }
    return left;
  }
  private parseMultiplicative(): Value {
    let left = this.parseUnary();
    while (this.current().type === 'OPERATOR' && ['*', '/', '%'].includes(this.current().text)) {
      const operator = this.take().text; const right = this.number(this.parseUnary(), operator);
      const a = this.number(left, operator);
      if ((operator === '/' || operator === '%') && right === 0) throw new Error('0で割ることはできません。');
      left = operator === '*' ? a * right : operator === '/' ? a / right : a % right;
    }
    return left;
  }
  private parseUnary(): Value {
    if (this.match('!', 'NOT')) return !this.boolean(this.parseUnary(), 'NOT');
    if (this.match('-')) return -this.number(this.parseUnary(), '-');
    return this.parsePrimary();
  }
  private parsePrimary(): Value {
    const token = this.take();
    if (token.type === 'NUMBER') return Number(token.text);
    if (token.type === 'IDENTIFIER') {
      if (token.text === 'TRUE') return true;
      if (token.text === 'FALSE') return false;
      const variable = ALIASES[token.text] ?? token.text as RuleExpressionVariable;
      if (!RULE_EXPRESSION_VARIABLES.includes(variable)) {
        throw new Error(`変数「${token.text}」は使用できません。`);
      }
      return this.values[variable];
    }
    if (token.type === 'LPAREN') {
      const value = this.parseOr();
      if (this.take().type !== 'RPAREN') throw new Error('閉じ括弧「)」を入力してください。');
      return value;
    }
    throw new Error('数字、変数、または括弧内の式を入力してください。');
  }
}

export function evaluateRuleExpression(expression: string, values: RuleExpressionValues): boolean {
  const normalized = expression.normalize('NFKC').trim().replace(/^=\s*/, '');
  if (!normalized) throw new Error('論理式を入力してください。');
  return new Parser(tokenize(normalized), values).parse();
}

export function validateRuleExpression(expression: string): string | undefined {
  const zeroValues = Object.fromEntries(RULE_EXPRESSION_VARIABLES.map((name) => [name, 0])) as RuleExpressionValues;
  try { evaluateRuleExpression(expression, zeroValues); return undefined; }
  catch (error) { return error instanceof Error ? error.message : String(error); }
}
