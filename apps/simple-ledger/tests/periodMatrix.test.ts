import { describe, expect, it } from 'vitest';
import {
  buildPeriodMatrix,
  periodMatrixAsOf,
  type PeriodMatrixScope,
} from '../src/domain/periodMatrix';
import { deriveBalanceSheet, deriveProfitAndLoss } from '../src/domain/accounting';
import { reportEntriesForAsOf } from '../src/domain/reportEntries';
import { SCHEMA_VERSION } from '../src/domain/constants';
import type {
  Account,
  EntryMetadata,
  JournalEntry,
  Ledger,
  MonthlyCostItem,
} from '../src/domain/types';
import './setup';

function account(
  id: string,
  type: Account['type'],
  role: Account['role'],
  options: { archived?: boolean; sortIndex?: number } = {},
): Account {
  return {
    id,
    name: id,
    type,
    role,
    archived: options.archived ?? false,
    ...(options.sortIndex !== undefined ? { sortIndex: options.sortIndex } : {}),
    createdAt: 'x',
    updatedAt: 'x',
  };
}

function entry(
  id: string,
  date: string,
  debitAccountId: string,
  creditAccountId: string,
  amount: number,
  metadata?: EntryMetadata,
): JournalEntry {
  return {
    id,
    date,
    description: id,
    kind: 'normal',
    lines: [
      { accountId: debitAccountId, side: 'debit', amount },
      { accountId: creditAccountId, side: 'credit', amount },
    ],
    ...(metadata ? { metadata } : {}),
    createdAt: 'x',
    updatedAt: 'x',
  };
}

const accounts: Account[] = [
  account('cash', 'asset', 'daily-asset'),
  account('continuing', 'asset', 'continuing-cost-asset'),
  account('loan', 'liability', 'other-liability'),
  account('equity', 'equity', 'equity'),
  account('salary', 'revenue', 'income-category'),
  account('fixed', 'expense', 'expense-category', { archived: true, sortIndex: 0 }),
  account('food', 'expense', 'expense-category', { sortIndex: 1 }),
  account('cancelled', 'expense', 'expense-category', { sortIndex: 2 }),
  account('zero', 'expense', 'expense-category', { sortIndex: 3 }),
];

describe('buildPeriodMatrix（年間）', () => {
  it('月末・月初を別列へ帰属させ、当月・未来列も列末まで数値化する', () => {
    const input = [
      entry('future-real', '2026-06-16', 'food', 'cash', 999),
      entry('current-income', '2026-06-15', 'cash', 'salary', 500),
      entry('month-start', '2026-06-01', 'food', 'cash', 200),
      entry('month-end', '2026-05-31', 'food', 'cash', 100),
      entry('opening', '2025-12-31', 'cash', 'equity', 1000),
    ];
    const originalOrder = input.map(({ id }) => id);

    const matrix = buildPeriodMatrix(accounts, input, { mode: 'year', year: 2026 });

    expect(matrix.columns).toHaveLength(12);
    expect(matrix.columns[4]).toMatchObject({
      key: '2026-05',
      from: '2026-05-01',
      to: '2026-05-31',
      asOf: '2026-05-31',
    });
    expect(matrix.columns[5]).toMatchObject({ key: '2026-06', asOf: '2026-06-30' });
    expect(matrix.rows.expense.slice(4, 7)).toEqual([100, 1199, 0]);
    expect(matrix.rows.revenue.slice(4, 7)).toEqual([0, 500, 0]);
    expect(matrix.rows.net.slice(4, 7)).toEqual([-100, -699, 0]);
    expect(matrix.rows.totalAssets.slice(4, 7)).toEqual([900, 201, 201]);
    expect(matrix.rows.netAssets.slice(4, 7)).toEqual([900, 201, 201]);
    expect(input.map(({ id }) => id)).toEqual(originalOrder);
  });

  it('資産・負債の自然符号を累積し、各月末の純資産を総資産−総負債で返す', () => {
    const matrix = buildPeriodMatrix(
      accounts,
      [
        entry('opening', '2025-12-31', 'cash', 'equity', 1000),
        entry('borrow', '2026-01-10', 'cash', 'loan', 400),
        entry('spend', '2026-01-31', 'food', 'cash', 100),
        entry('repay', '2026-02-01', 'loan', 'cash', 150),
      ],
      { mode: 'year', year: 2026 },
    );

    expect(matrix.rows.totalAssets.slice(0, 2)).toEqual([1300, 1150]);
    expect(matrix.rows.netAssets.slice(0, 2)).toEqual([900, 900]);
    expect(matrix.rows.netAssets[0]).toBe(matrix.rows.totalAssets[0]! - 400);
    expect(matrix.rows.netAssets[1]).toBe(matrix.rows.totalAssets[1]! - 250);
  });

  it('導出月割りだけを継続コストの費用純増減へ分類する', () => {
    const matrix = buildPeriodMatrix(
      accounts,
      [
        entry('opening-cash', '2025-12-31', 'cash', 'equity', 1000),
        entry('opening-continuing', '2025-12-31', 'continuing', 'equity', 500),
        entry('derived', '2026-01-31', 'fixed', 'continuing', 120, {
          virtual: true,
          ccKind: 'monthly-allocation',
        }),
        entry('normal', '2026-01-25', 'food', 'cash', 50),
      ],
      { mode: 'year', year: 2026 },
    );

    expect(matrix.rows.expense[0]).toBe(170);
    expect(matrix.rows.monthlyCost[0]).toBe(120);
    expect(matrix.expenseCategories.map(({ account: a }) => a.id)).toEqual(['fixed', 'food']);
    expect(matrix.expenseCategories[0]?.values[0]).toBe(120);
    expect(matrix.expenseCategories[1]?.values[0]).toBe(50);
  });

  it('全表示列が 0 のカテゴリを除外し、月ごとに増減があれば通期純額 0 でも残す', () => {
    const matrix = buildPeriodMatrix(
      accounts,
      [
        entry('cancelled-debit', '2026-01-10', 'cancelled', 'cash', 100),
        entry('cancelled-credit', '2026-02-10', 'cash', 'cancelled', 100),
        entry('zero-debit', '2026-03-10', 'zero', 'cash', 50),
        entry('zero-credit', '2026-03-11', 'cash', 'zero', 50),
      ],
      { mode: 'year', year: 2026 },
    );

    expect(matrix.expenseCategories.map(({ account: a }) => a.id)).toEqual(['cancelled']);
    expect(matrix.expenseCategories[0]?.values.slice(0, 3)).toEqual([100, -100, 0]);
  });

  it('未来年も年末断面として固定行・カテゴリ行を数値で返す', () => {
    const matrix = buildPeriodMatrix(
      accounts,
      [entry('future', '2027-01-01', 'food', 'cash', 100)],
      { mode: 'year', year: 2027 },
    );

    expect(matrix.columns.every((column) => column.asOf === column.to)).toBe(true);
    expect(matrix.rows.expense[0]).toBe(100);
    expect(matrix.rows.net[0]).toBe(-100);
    expect(matrix.rows.totalAssets.every((value) => value === -100)).toBe(true);
    expect(matrix.expenseCategories[0]?.values[0]).toBe(100);
  });

  it('未来月列はホームが同じ月末断面で出すPL・BSと一致する', () => {
    const entries = [
      entry('opening', '2026-12-31', 'cash', 'equity', 1_000),
      entry('future-income', '2027-01-10', 'cash', 'salary', 500),
      entry('future-expense', '2027-01-20', 'food', 'cash', 120),
    ];
    const matrix = buildPeriodMatrix(accounts, entries, { mode: 'year', year: 2027 });
    const pl = deriveProfitAndLoss(accounts, entries, {
      from: '2027-01-01',
      to: '2027-01-31',
    });
    const bs = deriveBalanceSheet(accounts, entries, '2027-01-31');

    expect(matrix.rows.revenue[0]).toBe(pl.totalRevenue);
    expect(matrix.rows.expense[0]).toBe(pl.totalExpense);
    expect(matrix.rows.net[0]).toBe(pl.netIncome);
    expect(matrix.rows.totalAssets[0]).toBe(bs.totalAssets);
    expect(matrix.rows.netAssets[0]).toBe(bs.netAssets);
  });
});

describe('buildPeriodMatrix（全体）', () => {
  it('疎な年列でも中間年の移動を次のBSへ繰り越し、全列を年末まで扱う', () => {
    const matrix = buildPeriodMatrix(
      accounts,
      [
        entry('opening', '2023-12-31', 'cash', 'equity', 1000),
        entry('year-end', '2024-12-31', 'cash', 'salary', 100),
        entry('hidden-year', '2025-06-01', 'cash', 'salary', 50),
        entry('year-start', '2026-01-01', 'food', 'cash', 25),
        entry('borrow', '2026-06-15', 'cash', 'loan', 200),
        entry('after-today', '2026-06-16', 'food', 'cash', 999),
        entry('future-year', '2027-01-01', 'cash', 'salary', 999),
      ],
      { mode: 'all', years: [2027, 2024, 2026, 2026] },
    );

    expect(matrix.columns.map(({ key }) => key)).toEqual(['2024', '2026', '2027']);
    expect(matrix.columns.map(({ asOf }) => asOf)).toEqual([
      '2024-12-31',
      '2026-12-31',
      '2027-12-31',
    ]);
    expect(matrix.rows.revenue).toEqual([100, 0, 999]);
    expect(matrix.rows.expense).toEqual([0, 1024, 0]);
    expect(matrix.rows.net).toEqual([100, -1024, 999]);
    expect(matrix.rows.totalAssets).toEqual([1100, 326, 1325]);
    expect(matrix.rows.netAssets).toEqual([1100, 126, 1125]);
    expect(matrix.expenseCategories[0]?.values).toEqual([0, 1024, 0]);
  });

  it('後年の回収を全知識として使い、年間表示と全体表示の同じ年を一致させる', () => {
    const item: MonthlyCostItem = {
      id: 'cross-year-cost',
      name: '年またぎ費用',
      amount: 60_000,
      startDate: '2025-10-05',
      endDate: '2026-03-31',
      expenseAccountId: 'fixed',
      createdAt: 'x',
      updatedAt: 'x',
    };
    const ledger: Ledger = {
      meta: {
        id: 'ledger',
        schemaVersion: SCHEMA_VERSION,
        revision: 1,
        deviceId: 'device',
        createdAt: 'x',
        updatedAt: 'x',
      },
      settings: { ledgerName: 'test', currency: 'JPY', locale: 'ja' },
      accounts,
      journalEntries: [
        entry('opening', '2025-01-01', 'cash', 'equity', 500_000),
        entry('purchase', item.startDate, 'continuing', 'cash', item.amount, {
          monthlyCostId: item.id,
        }),
        entry('recovery', '2026-03-31', 'cash', 'continuing', 30_000, {
          monthlyCostId: item.id,
          monthlyCostRecovery: true,
        }),
      ],
      tags: [],
      monthlyCostItems: [item],
      recurringRules: [],
      importProfiles: [],
      profileBindings: [],
      importDecisions: [],
    };

    const annualEntries = reportEntriesForAsOf(ledger, '2025-12-31');
    const allEntries = reportEntriesForAsOf(ledger, '2026-12-31');
    const annual = buildPeriodMatrix(accounts, annualEntries, { mode: 'year', year: 2025 });
    const all = buildPeriodMatrix(accounts, allEntries, {
      mode: 'all',
      years: [2025, 2026],
    });
    const annualTotal = (values: readonly number[]) =>
      values.reduce((sum, value) => sum + value, 0);

    expect(annualTotal(annual.rows.monthlyCost)).toBe(15_000);
    expect(annualTotal(annual.rows.monthlyCost)).toBe(all.rows.monthlyCost[0]);
    expect(annualTotal(annual.rows.expense)).toBe(all.rows.expense[0]);
    expect(annual.rows.totalAssets[11]).toBe(all.rows.totalAssets[0]);
    expect(annual.rows.netAssets[11]).toBe(all.rows.netAssets[0]);
  });
});

describe('periodMatrixAsOf', () => {
  it.each([
    [{ mode: 'year', year: 2025 } as PeriodMatrixScope, '2025-12-31'],
    [{ mode: 'year', year: 2026 } as PeriodMatrixScope, '2026-12-31'],
    [{ mode: 'year', year: 2027 } as PeriodMatrixScope, '2027-12-31'],
    [{ mode: 'all', years: [2026, 2024, 2026] } as PeriodMatrixScope, '2026-12-31'],
    [{ mode: 'all', years: [] } as PeriodMatrixScope, '2026-06-15'],
  ])('%j の最大展開日を返す', (scope, expected) => {
    expect(periodMatrixAsOf(scope, '2026-06-15')).toBe(expected);
  });
});
