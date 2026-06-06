import { describe, expect, it } from 'vitest';
import { buildSimpleEntry, toSimpleInput, validateSimpleEntry } from '../src/domain/entry';

describe('validateSimpleEntry', () => {
  it('完全な入力はエラーなし', () => {
    expect(
      validateSimpleEntry({
        date: '2026-06-01',
        description: 'ランチ',
        debitAccountId: 'a',
        creditAccountId: 'b',
        amount: 1000,
      }),
    ).toEqual([]);
  });
  it('未入力・同一科目・不正金額を検出', () => {
    const errs = validateSimpleEntry({
      date: '',
      description: '  ',
      debitAccountId: 'a',
      creditAccountId: 'a',
      amount: 0,
    });
    expect(errs).toContain('date-required');
    expect(errs).toContain('description-required');
    expect(errs).toContain('same-account');
    expect(errs).toContain('amount-invalid');
  });
});

describe('buildSimpleEntry', () => {
  it('借方・貸方 2 行の同額仕訳を作る', () => {
    const e = buildSimpleEntry({
      date: '2026-06-01',
      description: ' ランチ ',
      debitAccountId: 'food',
      creditAccountId: 'cash',
      amount: 1000,
    });
    expect(e.lines).toHaveLength(2);
    expect(e.description).toBe('ランチ');
    expect(e.lines.find((l) => l.side === 'debit')).toMatchObject({
      accountId: 'food',
      amount: 1000,
    });
    expect(e.lines.find((l) => l.side === 'credit')).toMatchObject({
      accountId: 'cash',
      amount: 1000,
    });
    expect(e.kind).toBe('normal');
    expect(e.id).toBeTruthy();
  });
  it('編集時は id/createdAt を引き継ぐ', () => {
    const e = buildSimpleEntry(
      {
        date: '2026-06-02',
        description: 'x',
        debitAccountId: 'a',
        creditAccountId: 'b',
        amount: 5,
      },
      { id: 'keep', createdAt: 'orig' },
    );
    expect(e.id).toBe('keep');
    expect(e.createdAt).toBe('orig');
  });
});

describe('toSimpleInput', () => {
  it('round-trip で借方/貸方/金額を復元', () => {
    const e = buildSimpleEntry({
      date: '2026-06-01',
      description: 'ランチ',
      debitAccountId: 'food',
      creditAccountId: 'cash',
      amount: 1000,
      memo: 'メモ',
    });
    const input = toSimpleInput(e);
    expect(input).toMatchObject({
      debitAccountId: 'food',
      creditAccountId: 'cash',
      amount: 1000,
      memo: 'メモ',
    });
  });
});
