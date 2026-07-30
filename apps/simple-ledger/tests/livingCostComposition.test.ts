/*
 * 生活コストの二重計上防止（P10）の不変条件をドメインで固定する。
 * 生活コスト = 通常支出（PL 費用）+ 月額化コスト formula のみ。
 * 返済・積立（資金移動）・借入・継続コスト資産への資金化そのものは
 * PL 費用に出ない（= 生活コストに混ざらない）。
 */
import { describe, expect, it } from 'vitest';
import './setup';
import { deriveProfitAndLoss } from '../src/domain/accounting';
import {
  expenseCategoryBreakdownForRange,
  livingCostBreakdownForRange,
} from '../src/domain/livingCost';
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
    acc('continuing', 'continuing-cost-asset', 'asset'),
    acc('loan', 'other-liability', 'liability'),
    acc('income', 'income-category', 'revenue'),
    acc('adjustRevenue', 'system-adjustment', 'revenue'),
    acc('food', 'expense-category', 'expense'),
    acc('adjustExpense', 'system-adjustment', 'expense'),
  ];
  const month = { from: '2031-07-01', to: '2031-07-31' };
  const entries: JournalEntry[] = [
    entry('expense', '2031-07-03', 'food', 'cash', 1000), // 通常支出（PL 費用）
    entry('reserveMove', '2031-07-05', 'res', 'cash', 50000), // 積立（資金移動）
    entry('borrow', '2031-07-10', 'res', 'loan', 2_000_000), // 借入実行
    entry('fundContinuing', '2031-07-15', 'continuing', 'res', 3_000_000), // 資産化
  ];

  it('PL 費用は通常支出だけ（積立・借入・資産化は費用にならない）', () => {
    const pl = deriveProfitAndLoss(accounts, entries, month);
    expect(pl.totalExpense).toBe(1000);
  });

  it('継続コストは開始月から月割りで 25,000 / 開始前は 0', () => {
    const item: MonthlyCostItem = {
      id: 'm',
      name: '自動車',
      amount: 3_000_000,
      startDate: '2031-07-15',
      endDate: '2041-06-30', // 120ヶ月
      expenseAccountId: 'food',
      createdAt: 'x',
      updatedAt: 'x',
    };
    expect(monthlyCostForMonth(item, '2031-07')).toBe(25000);
    expect(monthlyCostForMonth(item, '2031-06')).toBe(0);
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

  it('残高調整費を通常支出へ含め、支出合計と内訳が PL と一致する', () => {
    const withAdjustment = [
      ...entries,
      entry('roundingExpense', '2031-07-21', 'adjustExpense', 'cash', 24),
    ];
    const pl = deriveProfitAndLoss(accounts, withAdjustment, month);
    const living = livingCostBreakdownForRange(accounts, withAdjustment, month);
    const categories = expenseCategoryBreakdownForRange(accounts, withAdjustment, month);

    expect(living.total).toBe(pl.totalExpense);
    expect(living.total).toBe(1024);
    expect(living.normalExpense).toBe(1024);
    expect(categories.find((row) => row.account.id === 'adjustExpense')?.amount).toBe(24);
    expect(categories.reduce((sum, row) => sum + row.amount, 0)).toBe(pl.totalExpense);
  });

  it('残高調整収入を通常収入へ含め、収入合計と内訳が PL と一致する', () => {
    const withAdjustment = [
      entry('income', '2031-07-03', 'cash', 'income', 1000),
      entry('roundingRevenue', '2031-07-21', 'cash', 'adjustRevenue', 24),
    ];
    const pl = deriveProfitAndLoss(accounts, withAdjustment, month);

    expect(pl.totalRevenue).toBe(1024);
    expect(pl.revenues.find((row) => row.account.id === 'adjustRevenue')?.balance).toBe(24);
    expect(pl.revenues.reduce((sum, row) => sum + row.balance, 0)).toBe(pl.totalRevenue);
  });
});
