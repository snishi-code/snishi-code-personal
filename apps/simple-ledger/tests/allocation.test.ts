import { describe, expect, it } from 'vitest';
import './setup';
import {
  addMonths,
  buildAllocation,
  isCompleted,
  monthlyAmounts,
  monthsBetween,
  recognizedMonths,
  remainingMonths,
  unrecognizedBalance,
} from '../src/domain/allocation';
import { journalEntrySchema } from '../src/domain/schema';
import type { Account } from '../src/domain/types';

describe('monthlyAmounts', () => {
  it('割り切れる場合は均等', () => {
    const a = monthlyAmounts(240000, 48);
    expect(a).toHaveLength(48);
    expect(a.every((x) => x === 5000)).toBe(true);
    expect(a.reduce((s, x) => s + x, 0)).toBe(240000);
  });
  it('割り切れない端数は先頭から 1 円ずつ配り、合計は総額に一致', () => {
    expect(monthlyAmounts(1000, 3)).toEqual([334, 333, 333]);
    expect(monthlyAmounts(100, 3)).toEqual([34, 33, 33]);
    expect(monthlyAmounts(100, 3).reduce((s, x) => s + x, 0)).toBe(100);
    expect(monthlyAmounts(99991, 7).reduce((s, x) => s + x, 0)).toBe(99991);
  });
});

describe('month 計算', () => {
  it('addMonths', () => {
    expect(addMonths('2026-06', 0)).toBe('2026-06');
    expect(addMonths('2026-11', 3)).toBe('2027-02');
    expect(addMonths('2026-06', 47)).toBe('2030-05');
  });
  it('monthsBetween', () => {
    expect(monthsBetween('2026-06', '2026-09')).toBe(3);
    expect(monthsBetween('2026-06', '2026-05')).toBe(-1);
  });
});

describe('buildAllocation', () => {
  const built = buildAllocation({
    date: '2026-06-15',
    description: 'PC',
    totalAmount: 240000,
    months: 48,
    expenseAccountId: 'exp',
    paymentAccountId: 'pay',
    deferredAccountId: 'def',
  });

  it('原始仕訳は 借方 按分中資産 / 貸方 支払元・総額', () => {
    const { sourceEntry } = built;
    expect(sourceEntry.lines.find((l) => l.side === 'debit')).toMatchObject({
      accountId: 'def',
      amount: 240000,
    });
    expect(sourceEntry.lines.find((l) => l.side === 'credit')).toMatchObject({
      accountId: 'pay',
      amount: 240000,
    });
    expect(sourceEntry.metadata?.allocationRole).toBe('source');
    expect(sourceEntry.metadata?.allocationId).toBe(built.item.id);
  });

  it('月次認識仕訳は months 件、合計が総額に一致、すべて 2 行で valid', () => {
    const { recognitionEntries } = built;
    expect(recognitionEntries).toHaveLength(48);
    const total = recognitionEntries.reduce(
      (s, e) => s + (e.lines.find((l) => l.side === 'debit')?.amount ?? 0),
      0,
    );
    expect(total).toBe(240000);
    for (const e of recognitionEntries) {
      expect(journalEntrySchema.safeParse(e).success).toBe(true);
      expect(e.lines.find((l) => l.side === 'debit')?.accountId).toBe('exp');
      expect(e.lines.find((l) => l.side === 'credit')?.accountId).toBe('def');
      expect(e.metadata?.allocationRole).toBe('recognition');
    }
    expect(recognitionEntries[0]?.date).toBe('2026-06-01');
    expect(recognitionEntries[1]?.date).toBe('2026-07-01');
    expect(recognitionEntries[47]?.date).toBe('2030-05-01');
  });

  it('AllocationItem に仕訳 ID と開始月を保持', () => {
    const { item, sourceEntry, recognitionEntries } = built;
    expect(item.startMonth).toBe('2026-06');
    expect(item.sourceEntryId).toBe(sourceEntry.id);
    expect(item.recognitionEntryIds).toEqual(recognitionEntries.map((e) => e.id));
    expect(item.status).toBe('active');
  });
});

describe('按分の導出（現在月から）', () => {
  const item = buildAllocation({
    date: '2026-06-15',
    description: 'PC',
    totalAmount: 240000,
    months: 48,
    expenseAccountId: 'exp',
    paymentAccountId: 'pay',
    deferredAccountId: 'def',
  }).item;

  it('開始月は 1 か月認識済み・残り 47・未認識 235000', () => {
    expect(recognizedMonths(item, '2026-06')).toBe(1);
    expect(remainingMonths(item, '2026-06')).toBe(47);
    expect(unrecognizedBalance(item, '2026-06')).toBe(235000);
    expect(isCompleted(item, '2026-06')).toBe(false);
  });
  it('最終認識月で完了・未認識 0', () => {
    expect(remainingMonths(item, '2030-05')).toBe(0);
    expect(isCompleted(item, '2030-05')).toBe(true);
    expect(unrecognizedBalance(item, '2030-05')).toBe(0);
  });
  it('開始前は未認識', () => {
    expect(recognizedMonths(item, '2026-05')).toBe(0);
    expect(remainingMonths(item, '2026-05')).toBe(48);
  });
});

describe('BS は as-of 日付で未来の按分認識を含めない', () => {
  const acc = (id: string, type: 'asset' | 'expense'): Account => ({
    id,
    name: id,
    type,
    role: type === 'asset' ? 'daily-asset' : 'expense-category',
    archived: false,
    createdAt: 'x',
    updatedAt: 'x',
  });
  const built = buildAllocation({
    date: '2026-06-15',
    description: 'PC',
    totalAmount: 120000,
    months: 12,
    expenseAccountId: 'exp',
    paymentAccountId: 'pay',
    deferredAccountId: 'def',
  });
  const accounts = [acc('exp', 'expense'), acc('pay', 'asset'), acc('def', 'asset')];
  const entries = [built.sourceEntry, ...built.recognitionEntries];

  it('当月末時点では按分中資産に未認識残高が残る', async () => {
    const { deriveBalanceSheet } = await import('../src/domain/accounting');
    const bs = deriveBalanceSheet(accounts, entries, '2026-06-30');
    // 6月分(10000)のみ認識 → def = 120000 - 10000 = 110000
    expect(bs.assets.find((a) => a.account.id === 'def')?.balance).toBe(110000);
  });
  it('全期間（asOf なし）では按分中資産は 0 に取り崩される', async () => {
    const { deriveBalanceSheet } = await import('../src/domain/accounting');
    const bs = deriveBalanceSheet(accounts, entries);
    expect(bs.assets.find((a) => a.account.id === 'def')?.balance ?? 0).toBe(0);
  });
});
