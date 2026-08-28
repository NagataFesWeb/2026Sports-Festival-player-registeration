import { describe, expect, it } from 'vitest';
import { toClientSafe } from '../../src/core/client-transfer';

describe('サイドバーへ返すデータ', () => {
  it('入れ子の配列にあるDateも文字列へ変換する', () => {
    const result = toClientSafe({ candidates: [{ submittedAt: new Date('2026-07-17T00:00:00.000Z') }] });
    expect(result.candidates[0]?.submittedAt).toBe('2026-07-17T00:00:00.000Z');
  });
});
