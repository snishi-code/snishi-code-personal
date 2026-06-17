import { describe, expect, it } from 'vitest';
import './setup';
import {
  accountBalance,
  deriveBalanceSheet,
  deriveProfitAndLoss,
  filterByDateRange,
  isDebitNormal,
  monthRange,
} from '../src/domain/accounting';
import { defaultRoleForType } from '../src/domain/accountRoles';
import { DEFAULT_MANAGEMENT_SCOPE_ID } from '../src/domain/constants';
import type { Account, JournalEntry } from '../src/domain/types';

function acc(id: string, name: string, type: Account['type']): Account {
  return {
    id,
    name,
    type,
    role: defaultRoleForType(type),
    archived: false,
    createdAt: '2026-01-01',
    updatedAt: '2026-01-01',
  };
}

function entry(
  id: string,
  date: string,
  debit: string,
  credit: string,
  amount: number,
  kind: JournalEntry['kind'] = 'normal',
): JournalEntry {
  return {
    id,
    date,
    description: id,
    kind,
    managementScopeId: DEFAULT_MANAGEMENT_SCOPE_ID,
    lines: [
      { accountId: debit, side: 'debit', amount },
      { accountId: credit, side: 'credit', amount },
    ],
    createdAt: date,
    updatedAt: date,
  };
}

const cash = acc('cash', '現金', 'asset');
const food = acc('food', '食費', 'expense');
const salary = acc('salary', '給与', 'revenue');
const card = acc('card', 'カード', 'liability');
const capital = acc('capital', '元入金', 'equity');
const accounts = [cash, food, salary, card, capital];

const entries: JournalEntry[] = [
  entry('open', '2026-06-01', 'cash', 'capital', 100_000, 'opening'),
  entry('pay', '2026-06-10', 'cash', 'salary', 300_000),
  entry('lunch', '2026-06-15', 'food', 'cash', 1_000),
];

describe('isDebitNormal', () => {
  it('asset/expense は借方正', () => {
    expect(isDebitNormal('asset')).toBe(true);
    expect(isDebitNormal('expense')).toBe(true);
    expect(isDebitNormal('liability')).toBe(false);
    expect(isDebitNormal('equity')).toBe(false);
    expect(isDebitNormal('revenue')).toBe(false);
  });
});

describe('accountBalance', () => {
  it('資産は debit - credit', () => {
    // cash: +100000 +300000 -1000
    expect(accountBalance('cash', 'asset', entries)).toBe(399_000);
  });
  it('収益は credit - debit', () => {
    expect(accountBalance('salary', 'revenue', entries)).toBe(300_000);
  });
  it('費用は debit - credit', () => {
    expect(accountBalance('food', 'expense', entries)).toBe(1_000);
  });
});

describe('filterByDateRange', () => {
  it('両端を含む', () => {
    const r = filterByDateRange(entries, '2026-06-10', '2026-06-15');
    expect(r.map((e) => e.id)).toEqual(['pay', 'lunch']);
  });
});

describe('deriveProfitAndLoss', () => {
  it('全期間の収益・費用・純損益', () => {
    const pl = deriveProfitAndLoss(accounts, entries);
    expect(pl.totalRevenue).toBe(300_000);
    expect(pl.totalExpense).toBe(1_000);
    expect(pl.netIncome).toBe(299_000);
  });
  it('期間で絞ると範囲外の仕訳は除外', () => {
    const pl = deriveProfitAndLoss(accounts, entries, { from: '2026-07-01', to: '2026-07-31' });
    expect(pl.totalRevenue).toBe(0);
    expect(pl.netIncome).toBe(0);
  });
});

describe('deriveBalanceSheet', () => {
  it('資産・負債・純資産が導出され、貸借が一致する', () => {
    const bs = deriveBalanceSheet(accounts, entries);
    expect(bs.totalAssets).toBe(399_000);
    expect(bs.totalLiabilities).toBe(0);
    expect(bs.totalEquityAccounts).toBe(100_000);
    expect(bs.retainedEarnings).toBe(299_000);
    expect(bs.netAssets).toBe(399_000);
    expect(bs.balanced).toBe(true);
  });
  it('asOf より後の仕訳は含めない', () => {
    const bs = deriveBalanceSheet(accounts, entries, '2026-06-01');
    expect(bs.totalAssets).toBe(100_000); // open のみ
    expect(bs.balanced).toBe(true);
  });
});

describe('monthRange', () => {
  it('月初〜月末を返す（月により末日が変わる）', () => {
    expect(monthRange(2026, 6)).toEqual({ from: '2026-06-01', to: '2026-06-30' });
    expect(monthRange(2026, 2)).toEqual({ from: '2026-02-01', to: '2026-02-28' });
    expect(monthRange(2024, 2)).toEqual({ from: '2024-02-01', to: '2024-02-29' }); // 閏年
  });
});
