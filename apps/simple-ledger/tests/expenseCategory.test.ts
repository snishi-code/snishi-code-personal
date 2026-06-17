/*
 * 費用カテゴリ別内訳（支出の内訳ページの主表示）の不変条件。
 *  - 費用カテゴリ別合計は livingCostBreakdownForRange().total（= ホーム「支出」）と一致する。
 *  - 継続コストの月割り認識（ccKind='recognition'）は、認識先の費用カテゴリへ合算される。
 *  - 投資評価損等（system-adjustment）は支出ではないので内訳から除外する。
 */
import { describe, expect, it } from 'vitest';
import './setup';
import {
  expenseCategoryBreakdownForRange,
  livingCostBreakdownForRange,
} from '../src/domain/livingCost';
import { DEFAULT_MANAGEMENT_SCOPE_ID } from '../src/domain/constants';
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
    managementScopeId: DEFAULT_MANAGEMENT_SCOPE_ID,
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
    acc('valuation', 'system-adjustment', 'expense'), // 投資評価損（支出に含めない）
  ];
  const month = { from: '2031-07-01', to: '2031-07-31' };
  const entries: JournalEntry[] = [
    entry('e1', '2031-07-03', 'food', 'cash', 1000), // 通常支出 → food
    entry('e2', '2031-07-04', 'fixed', 'cash', 2000), // 通常支出 → fixed
    // 継続コストの月割り認識（仮想）: 対象資産 → fixed カテゴリへ 5,000。
    entry('rec', '2031-07-31', 'fixed', 'ccAsset', 5000, { ccKind: 'recognition' }),
    // 投資評価損（system-adjustment 役割の費用科目）。支出には数えない。
    entry('val', '2031-07-20', 'valuation', 'cash', 800),
  ];

  it('費用カテゴリ別合計はホーム「支出」（total）と一致する', () => {
    const cats = expenseCategoryBreakdownForRange(accounts, entries, month);
    const sum = cats.reduce((s, c) => s + c.amount, 0);
    const total = livingCostBreakdownForRange(accounts, entries, month).total;
    // food 1,000 + fixed(2,000 + 月割り 5,000) = 8,000（評価損 800 は除外）。
    expect(total).toBe(8000);
    expect(sum).toBe(total);
  });

  it('継続コストの月割り分は選ばれた費用カテゴリ（fixed）に合算される', () => {
    const cats = expenseCategoryBreakdownForRange(accounts, entries, month);
    expect(cats.find((c) => c.account.id === 'fixed')?.amount).toBe(7000);
    expect(cats.find((c) => c.account.id === 'food')?.amount).toBe(1000);
  });

  it('投資評価損（system-adjustment）は費用カテゴリ別内訳に出さない', () => {
    const cats = expenseCategoryBreakdownForRange(accounts, entries, month);
    expect(cats.some((c) => c.account.id === 'valuation')).toBe(false);
  });

  it('金額の大きい順に並ぶ', () => {
    const cats = expenseCategoryBreakdownForRange(accounts, entries, month);
    expect(cats.map((c) => c.account.id)).toEqual(['fixed', 'food']);
  });
});
