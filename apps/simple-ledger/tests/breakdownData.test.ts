import { describe, expect, it } from 'vitest';
import { deriveBalanceSheet, deriveProfitAndLoss } from '../src/domain/accounting';
import { reportEntriesForAsOf } from '../src/domain/reportEntries';
import { reportBasis } from '../src/domain/reportPeriod';
import type { Account, JournalEntry, Ledger } from '../src/domain/types';
import { buildSectionTrends } from '../src/ui/screens/breakdownData';
import './setup';

const ts = '2026-07-01T00:00:00.000Z';
const accounts: Account[] = [
  {
    id: 'cash',
    name: '現金',
    type: 'asset',
    role: 'daily-asset',
    archived: false,
    createdAt: ts,
    updatedAt: ts,
  },
  {
    id: 'opening',
    name: '初期残高',
    type: 'equity',
    role: 'equity',
    archived: false,
    createdAt: ts,
    updatedAt: ts,
  },
  {
    id: 'living',
    name: '生活費',
    type: 'expense',
    role: 'expense-category',
    archived: false,
    createdAt: ts,
    updatedAt: ts,
  },
];

function entry(
  id: string,
  date: string,
  debitAccountId: string,
  creditAccountId: string,
  amount: number,
  kind: JournalEntry['kind'] = 'normal',
): JournalEntry {
  return {
    id,
    date,
    description: id,
    kind,
    lines: [
      { accountId: debitAccountId, side: 'debit', amount },
      { accountId: creditAccountId, side: 'credit', amount },
    ],
    createdAt: ts,
    updatedAt: ts,
  };
}

function ledgerOf(journalEntries: JournalEntry[]): Ledger {
  return {
    meta: {
      id: 'ledger',
      schemaVersion: 1,
      revision: 0,
      deviceId: 'test',
      createdAt: ts,
      updatedAt: ts,
    },
    settings: { ledgerName: 'test', currency: 'JPY', locale: 'ja' },
    accounts,
    journalEntries,
    cashflowSchedules: [],
    reserves: [],
    tags: [],
    monthlyCostItems: [],
    recurringRules: [],
  };
}

describe('buildSectionTrends（画面サマリーと同じ期間基準）', () => {
  const today = '2026-07-27';
  const opening = entry('opening-entry', '2026-07-01', 'cash', 'opening', 100_000, 'opening');
  const futureExpense = entry('future-expense', '2026-07-29', 'living', 'cash', 80_000);
  const ledger = ledgerOf([opening, futureExpense]);

  it('当月の資産サマリーと年推移の当月ストック点が一致する', () => {
    const basis = reportBasis({ mode: 'date', date: today }, today);
    const entries = reportEntriesForAsOf(ledger, basis.asOf, today);
    const summary = deriveBalanceSheet(accounts, entries, basis.asOf);
    const trends = buildSectionTrends({ mode: 'year', year: 2026 }, ledger, today);
    const july = trends?.assets.find((point) => point.key === '2026-07');

    expect(summary.totalAssets).toBe(100_000);
    expect(july?.value).toBe(summary.totalAssets);
  });

  it('当期フローだけを今日で止め、初期残高−支出と純資産を一致させる', () => {
    const basis = reportBasis({ mode: 'date', date: today }, today);
    const entries = reportEntriesForAsOf(ledger, basis.asOf, today);
    const pl = deriveProfitAndLoss(accounts, entries, basis.flowRange);
    const bs = deriveBalanceSheet(accounts, entries, basis.asOf);

    expect(pl.totalExpense).toBe(0);
    expect(bs.netAssets).toBe(100_000);
    expect(100_000 - pl.totalExpense).toBe(bs.netAssets);
  });

  it.each([
    ['過去月', { mode: 'date', date: '2026-05-31' } as const, 20_000, 70_000],
    ['過去年', { mode: 'year', year: 2025 } as const, 10_000, 90_000],
  ])('%sは期間末までの既存数値を変えない', (_label, period, expense, netAssets) => {
    const pastLedger = ledgerOf([
      entry('old-opening', '2025-01-01', 'cash', 'opening', 100_000, 'opening'),
      entry('old-expense', '2025-12-15', 'living', 'cash', 10_000),
      entry('last-month-expense', '2026-05-20', 'living', 'cash', 20_000),
      futureExpense,
    ]);
    const basis = reportBasis(period, today);
    const entries = reportEntriesForAsOf(pastLedger, basis.asOf, today);
    const pl = deriveProfitAndLoss(accounts, entries, basis.flowRange);
    const bs = deriveBalanceSheet(accounts, entries, basis.asOf);

    expect(pl.totalExpense).toBe(expense);
    expect(bs.netAssets).toBe(netAssets);
  });
});
