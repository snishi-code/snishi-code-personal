import { describe, expect, it } from 'vitest';
import './setup';
import {
  buildAdjustmentEntry,
  counterpartName,
  counterpartRole,
  type AdjustmentInput,
} from '../src/domain/adjustment';

function base(over: Partial<AdjustmentInput>): AdjustmentInput {
  return {
    kind: 'unknown-balance',
    accountId: 'acc',
    accountType: 'asset',
    date: '2026-06-01',
    description: '残高補正',
    expectedBalance: 10000,
    actualBalance: 10000,
    counterpartAccountId: 'ctr',
    ...over,
  };
}

describe('counterpartRole / counterpartName', () => {
  it('損益方向', () => {
    expect(counterpartRole('asset', 2000)).toBe('revenue'); // 資産増 = 益
    expect(counterpartRole('asset', -2000)).toBe('expense'); // 資産減 = 損
    expect(counterpartRole('liability', 2000)).toBe('expense'); // 負債増 = 損
    expect(counterpartRole('liability', -2000)).toBe('revenue'); // 負債減 = 益
  });
  it('名称', () => {
    expect(counterpartName('unknown-balance', 'expense')).toBe('残高調整費');
    expect(counterpartName('unknown-balance', 'revenue')).toBe('残高調整収入');
    expect(counterpartName('investment-valuation', 'expense')).toBe('投資評価損');
    expect(counterpartName('investment-valuation', 'revenue')).toBe('投資評価益');
  });
});

describe('buildAdjustmentEntry', () => {
  it('資産 actual<expected: 借方 相手(費) / 貸方 資産', () => {
    const e = buildAdjustmentEntry(base({ expectedBalance: 10000, actualBalance: 8000 }))!;
    expect(e.lines.find((l) => l.side === 'debit')).toMatchObject({
      accountId: 'ctr',
      amount: 2000,
    });
    expect(e.lines.find((l) => l.side === 'credit')).toMatchObject({
      accountId: 'acc',
      amount: 2000,
    });
    expect(e.metadata?.adjustment?.delta).toBe(-2000);
  });
  it('資産 actual>expected: 借方 資産 / 貸方 相手(収入)', () => {
    const e = buildAdjustmentEntry(base({ expectedBalance: 10000, actualBalance: 12000 }))!;
    expect(e.lines.find((l) => l.side === 'debit')).toMatchObject({
      accountId: 'acc',
      amount: 2000,
    });
    expect(e.lines.find((l) => l.side === 'credit')).toMatchObject({
      accountId: 'ctr',
      amount: 2000,
    });
  });
  it('負債 actual>expected: 借方 相手(費) / 貸方 負債', () => {
    const e = buildAdjustmentEntry(
      base({ accountType: 'liability', expectedBalance: 10000, actualBalance: 12000 }),
    )!;
    expect(e.lines.find((l) => l.side === 'debit')).toMatchObject({
      accountId: 'ctr',
      amount: 2000,
    });
    expect(e.lines.find((l) => l.side === 'credit')).toMatchObject({
      accountId: 'acc',
      amount: 2000,
    });
  });
  it('負債 actual<expected: 借方 負債 / 貸方 相手(収入)', () => {
    const e = buildAdjustmentEntry(
      base({ accountType: 'liability', expectedBalance: 10000, actualBalance: 8000 }),
    )!;
    expect(e.lines.find((l) => l.side === 'debit')).toMatchObject({
      accountId: 'acc',
      amount: 2000,
    });
    expect(e.lines.find((l) => l.side === 'credit')).toMatchObject({
      accountId: 'ctr',
      amount: 2000,
    });
  });
  it('delta=0 は仕訳を作らない（null）', () => {
    expect(buildAdjustmentEntry(base({ expectedBalance: 5000, actualBalance: 5000 }))).toBeNull();
  });
  it('existing 指定で id / createdAt を引き継ぎ、updatedAt は更新する（編集の上書き）', () => {
    const e = buildAdjustmentEntry(
      base({
        expectedBalance: 10000,
        actualBalance: 8000,
        existing: { id: 'fixed-id', createdAt: '2026-01-01T00:00:00.000Z' },
      }),
    )!;
    expect(e.id).toBe('fixed-id');
    expect(e.createdAt).toBe('2026-01-01T00:00:00.000Z');
    expect(e.updatedAt).not.toBe(e.createdAt);
  });
});
