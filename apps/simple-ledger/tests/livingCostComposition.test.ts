/*
 * 生活コストの二重計上防止（P10）の不変条件をドメインで固定する。
 * 生活コスト = 通常支出（PL 費用）+ 月額化コスト formula のみ。
 * 返済・積立（資金移動）・借入・固定資産購入そのものは PL 費用に出ない（= 生活コストに混ざらない）。
 */
import { describe, expect, it } from 'vitest';
import './setup';
import { deriveProfitAndLoss } from '../src/domain/accounting';
import { monthlyCostForMonth } from '../src/domain/monthlyCost';
import { monthlyAmounts } from '../src/domain/allocation';
import type { Account, JournalEntry, MonthlyCostItem } from '../src/domain/types';

function acc(id: string, role: Account['role'], type: Account['type']): Account {
  return { id, name: id, type, role, archived: false, createdAt: 'x', updatedAt: 'x' };
}
function entry(
  id: string,
  date: string,
  debit: string,
  credit: string,
  amount: number,
): JournalEntry {
  return {
    id,
    date,
    description: id,
    kind: 'normal',
    lines: [
      { accountId: debit, side: 'debit', amount },
      { accountId: credit, side: 'credit', amount },
    ],
    createdAt: 'x',
    updatedAt: 'x',
  };
}

describe('生活コストの二重計上防止（PL 費用の構成）', () => {
  const accounts: Account[] = [
    acc('cash', 'daily-asset', 'asset'),
    acc('res', 'reserve-asset', 'asset'),
    acc('car', 'fixed-asset', 'asset'),
    acc('loan', 'other-liability', 'liability'),
    acc('food', 'expense-category', 'expense'),
  ];
  const month = { from: '2031-07-01', to: '2031-07-31' };
  const entries: JournalEntry[] = [
    entry('expense', '2031-07-03', 'food', 'cash', 1000), // 通常支出（PL 費用）
    entry('reserveMove', '2031-07-05', 'res', 'cash', 50000), // 積立（資金移動）
    entry('borrow', '2031-07-10', 'res', 'loan', 2_000_000), // 借入実行
    entry('buyCar', '2031-07-15', 'car', 'res', 3_000_000), // 固定資産購入
  ];

  it('PL 費用は通常支出だけ（積立・借入・固定資産購入は費用にならない）', () => {
    const pl = deriveProfitAndLoss(accounts, entries, month);
    expect(pl.totalExpense).toBe(1000);
  });

  it('固定資産の月額化は購入月から formula で 25,000 / 購入前は 0', () => {
    const car: MonthlyCostItem = {
      id: 'm',
      name: '自動車',
      kind: 'durable-asset',
      amount: 3_000_000,
      costMonths: 120,
      startMonth: '2031-07',
      expenseAccountId: 'food',
      recognitionCreditAccountId: 'car',
      status: 'active',
      createdAt: 'x',
      updatedAt: 'x',
    };
    expect(monthlyCostForMonth(car, '2031-07')).toBe(25000);
    expect(monthlyCostForMonth(car, '2031-06')).toBe(0);
  });

  it('ローン返済は 借方 負債 / 貸方 資金 の振替仕訳であり PL 費用ではない（約33,333/月）', () => {
    // 返済は未来日付の実仕訳（借方 負債 / 貸方 返済元資金）として登録される。monthlyAmounts の
    // 月割り配分は合計が元本に一致する。
    const parts = monthlyAmounts(2_000_000, 60);
    expect(parts).toHaveLength(60);
    expect(parts.reduce((s, x) => s + x, 0)).toBe(2_000_000);
    expect(parts[0]).toBeGreaterThanOrEqual(33333);
    expect(parts[0]).toBeLessThanOrEqual(33334);
    // 対象月に返済仕訳（借方 loan / 貸方 cash）が入っても PL 費用は増えない。
    const withRepay = [...entries, entry('repay1', '2031-07-20', 'loan', 'cash', parts[0] ?? 0)];
    const pl = deriveProfitAndLoss(accounts, withRepay, month);
    expect(pl.totalExpense).toBe(1000);
  });
});
