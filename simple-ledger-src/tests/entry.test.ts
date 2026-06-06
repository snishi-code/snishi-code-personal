import { describe, expect, it } from 'vitest';
import {
  buildSimpleEntry,
  reversalInput,
  toSimpleInput,
  validateSimpleEntry,
} from '../src/domain/entry';
import type { JournalEntry } from '../src/domain/types';

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

describe('buildSimpleEntry metadata', () => {
  it('inputMode を保持する', () => {
    const e = buildSimpleEntry({
      date: '2026-06-01',
      description: '給料',
      debitAccountId: 'cash',
      creditAccountId: 'salary',
      amount: 300000,
      metadata: { inputMode: 'income' },
    });
    expect(e.metadata?.inputMode).toBe('income');
  });
  it('空 metadata は付けない', () => {
    const e = buildSimpleEntry({
      date: '2026-06-01',
      description: 'x',
      debitAccountId: 'a',
      creditAccountId: 'b',
      amount: 1,
      metadata: {},
    });
    expect(e.metadata).toBeUndefined();
  });
});

describe('reversalInput', () => {
  const source: JournalEntry = {
    id: 'orig',
    date: '2026-06-01',
    description: 'クレジットで食費',
    kind: 'normal',
    lines: [
      { accountId: 'food', side: 'debit', amount: 1000 },
      { accountId: 'card', side: 'credit', amount: 1000 },
    ],
    createdAt: 'x',
    updatedAt: 'x',
  };

  it('借方/貸方を入れ替えた逆仕訳の入力を作る', () => {
    const input = reversalInput(source);
    // 元: 借方 food / 貸方 card → 逆: 借方 card / 貸方 food
    expect(input.debitAccountId).toBe('card');
    expect(input.creditAccountId).toBe('food');
    expect(input.amount).toBe(1000);
    expect(input.description).toBe('取消: クレジットで食費');
    expect(input.metadata?.inputMode).toBe('reversal');
    expect(input.metadata?.reversalOfEntryId).toBe('orig');
  });

  it('逆仕訳を仕訳化すると元と反対向き・同額で貸借一致する', () => {
    const reversal = buildSimpleEntry(reversalInput(source));
    const debit = reversal.lines.find((l) => l.side === 'debit');
    const credit = reversal.lines.find((l) => l.side === 'credit');
    expect(debit).toMatchObject({ accountId: 'card', amount: 1000 });
    expect(credit).toMatchObject({ accountId: 'food', amount: 1000 });
    expect(reversal.id).not.toBe(source.id); // 元は別仕訳（削除しない）
  });
});
