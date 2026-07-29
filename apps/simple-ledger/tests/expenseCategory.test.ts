/*
 * 費用カテゴリ別内訳（支出の内訳ページの主表示）の不変条件。
 *  - 費用カテゴリ別合計は livingCostBreakdownForRange().total（= ホーム「支出」）と一致する。
 *  - 継続コストの月割り認識（ccKind='recognition'）は、認識先の費用カテゴリへ合算される。
 *  - system-adjustment も通常支出として内訳へ含める。
 */
import { describe, expect, it } from 'vitest';
import './setup';
import {
  expenseCategoryBreakdownForRange,
  livingCostBreakdownForRange,
} from '../src/domain/livingCost';
import { deriveBalanceSheet, deriveProfitAndLoss } from '../src/domain/accounting';
import type { Account, EntryMetadata, JournalEntry } from '../src/domain/types';

function acc(id: string, role: Account['role'], type: Account['type']): Account {
  return { id, name: id, type, role, archived: false, createdAt: 'x', updatedAt: 'x' };
}
function entry(
  id: string,
  date: string,
  debit: string,
  credit: string,
  amount: number,
  metadata?: EntryMetadata,
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
    ...(metadata ? { metadata } : {}),
    createdAt: 'x',
    updatedAt: 'x',
  };
}

describe('expenseCategoryBreakdownForRange（費用カテゴリ別内訳）', () => {
  const accounts: Account[] = [
    acc('cash', 'daily-asset', 'asset'),
    acc('ccAsset', 'reserve-asset', 'asset'), // 継続コスト対象資産
    acc('food', 'expense-category', 'expense'),
    acc('fixed', 'expense-category', 'expense'),
    acc('adjustment', 'system-adjustment', 'expense'),
  ];
  const month = { from: '2031-07-01', to: '2031-07-31' };
  const entries: JournalEntry[] = [
    entry('e1', '2031-07-03', 'food', 'cash', 1000), // 通常支出 → food
    entry('e2', '2031-07-04', 'fixed', 'cash', 2000), // 通常支出 → fixed
    // 継続コストの月割り認識（仮想）: 対象資産 → fixed カテゴリへ 5,000。
    entry('rec', '2031-07-31', 'fixed', 'ccAsset', 5000, { ccKind: 'recognition' }),
    entry('adj', '2031-07-20', 'adjustment', 'cash', 800),
  ];

  it('費用カテゴリ別合計はホーム「支出」（total）と一致する', () => {
    const cats = expenseCategoryBreakdownForRange(accounts, entries, month);
    const sum = cats.reduce((s, c) => s + c.amount, 0);
    const total = livingCostBreakdownForRange(accounts, entries, month).total;
    // food 1,000 + fixed(2,000 + 月割り 5,000) + 残高調整 800 = 8,800。
    expect(total).toBe(8800);
    expect(sum).toBe(total);
  });

  it('継続コストの月割り分は選ばれた費用カテゴリ（fixed）に合算される', () => {
    const cats = expenseCategoryBreakdownForRange(accounts, entries, month);
    expect(cats.find((c) => c.account.id === 'fixed')?.amount).toBe(7000);
    expect(cats.find((c) => c.account.id === 'food')?.amount).toBe(1000);
  });

  it('system-adjustment も費用内訳に出す', () => {
    const cats = expenseCategoryBreakdownForRange(accounts, entries, month);
    expect(cats.find((c) => c.account.id === 'adjustment')?.amount).toBe(800);
  });

  it('金額の大きい順に並ぶ', () => {
    const cats = expenseCategoryBreakdownForRange(accounts, entries, month);
    expect(cats.map((c) => c.account.id)).toEqual(['fixed', 'food', 'adjustment']);
  });
});

describe('継続コスト認識の生活コスト分類', () => {
  const accounts: Account[] = [
    acc('source', 'daily-asset', 'asset'),
    acc('expense', 'expense-category', 'expense'),
    acc('revenue', 'income-category', 'revenue'),
    acc('asset', 'daily-asset', 'asset'),
    acc('liability', 'other-liability', 'liability'),
    acc('equity', 'equity', 'equity'),
  ];
  const recognition = (id: string, debit: string, amount: number) =>
    entry(id, '2031-07-01', debit, 'source', amount, { ccKind: 'recognition' });

  it('借方の会計 type が expense の認識だけを継続コストへ含める', () => {
    const result = livingCostBreakdownForRange(
      accounts,
      [
        recognition('expense-recognition', 'expense', 100),
        recognition('revenue-recognition', 'revenue', 200),
        recognition('asset-recognition', 'asset', 300),
        recognition('liability-recognition', 'liability', 400),
        recognition('equity-recognition', 'equity', 500),
      ],
      { from: '2031-07-01', to: '2031-07-31' },
    );

    expect(result).toEqual({ normalExpense: 0, monthlyCost: 100, total: 100 });
  });

  it('revenue への認識は収入減として PL に反映する', () => {
    const entries = [recognition('revenue-recognition', 'revenue', 200)];
    const range = { from: '2031-07-01', to: '2031-07-31' };

    expect(deriveProfitAndLoss(accounts, entries, range)).toMatchObject({
      totalRevenue: -200,
      totalExpense: 0,
    });
    expect(livingCostBreakdownForRange(accounts, entries, range).total).toBe(0);
  });

  it.each([
    ['asset', 300],
    ['liability', 400],
  ] as const)('%s への認識は BS 内の振替となり純資産を変えない', (debit, amount) => {
    const entries = [recognition(`${debit}-recognition`, debit, amount)];
    const range = { from: '2031-07-01', to: '2031-07-31' };

    expect(deriveProfitAndLoss(accounts, entries, range)).toMatchObject({
      totalRevenue: 0,
      totalExpense: 0,
    });
    expect(deriveBalanceSheet(accounts, entries, range.to).netAssets).toBe(0);
    expect(livingCostBreakdownForRange(accounts, entries, range).total).toBe(0);
  });
});
