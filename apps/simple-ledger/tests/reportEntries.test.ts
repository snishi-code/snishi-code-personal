import { describe, expect, it } from 'vitest';
import { CONTINUOUS_COST_LEDGER_ACCOUNT_ID } from '../src/domain/constants';
import { reportEntriesForAsOf } from '../src/domain/reportEntries';
import type { Account, JournalEntry, MonthlyCostItem } from '../src/domain/types';
import './setup';

const accounts: Account[] = [
  {
    id: 'cash',
    name: '現金',
    type: 'asset',
    role: 'daily-asset',
    archived: false,
    createdAt: 'x',
    updatedAt: 'x',
  },
  {
    id: 'equity',
    name: '初期残高',
    type: 'equity',
    role: 'equity',
    archived: false,
    createdAt: 'x',
    updatedAt: 'x',
  },
  {
    id: CONTINUOUS_COST_LEDGER_ACCOUNT_ID,
    name: '継続コスト資産',
    type: 'asset',
    role: 'continuing-cost-asset',
    archived: false,
    createdAt: 'x',
    updatedAt: 'x',
  },
  {
    id: 'expense',
    name: '固定費',
    type: 'expense',
    role: 'expense-category',
    archived: false,
    createdAt: 'x',
    updatedAt: 'x',
  },
];

function opening(id: string, date: string): JournalEntry {
  return {
    id,
    date,
    description: id,
    kind: 'opening',
    lines: [
      { accountId: 'cash', side: 'debit', amount: 100 },
      { accountId: 'equity', side: 'credit', amount: 100 },
    ],
    createdAt: 'x',
    updatedAt: 'x',
  };
}

describe('reportEntriesForAsOf', () => {
  it('実仕訳も基準日までに切り、未来の実仕訳を呼び出し側へ漏らさない', () => {
    const entries = reportEntriesForAsOf(
      {
        accounts,
        journalEntries: [opening('past', '2026-07-01'), opening('future', '2026-08-01')],
        monthlyCostItems: [],
        recurringRules: [],
      },
      '2026-07-27',
    );

    expect(entries.map((entry) => entry.id)).toEqual(['past']);
  });

  it('未来日の回収を全知識として過去の月割りへ遡及するが、回収仕訳自体は基準日前へ漏らさない', () => {
    const item: MonthlyCostItem = {
      id: 'annual',
      name: '年払い',
      amount: 12_000,
      startDate: '2026-01-01',
      endDate: '2026-06-30',
      expenseAccountId: 'expense',
      createdAt: 'x',
      updatedAt: 'x',
    };
    const purchase: JournalEntry = {
      id: 'purchase',
      date: item.startDate,
      description: item.name,
      kind: 'normal',
      lines: [
        { accountId: CONTINUOUS_COST_LEDGER_ACCOUNT_ID, side: 'debit', amount: item.amount },
        { accountId: 'cash', side: 'credit', amount: item.amount },
      ],
      metadata: { monthlyCostId: item.id },
      createdAt: 'x',
      updatedAt: 'x',
    };
    const recovery: JournalEntry = {
      id: 'future-recovery',
      date: '2026-06-30',
      description: '返金',
      kind: 'normal',
      lines: [
        { accountId: 'cash', side: 'debit', amount: 6_000 },
        { accountId: CONTINUOUS_COST_LEDGER_ACCOUNT_ID, side: 'credit', amount: 6_000 },
      ],
      metadata: { monthlyCostId: item.id, monthlyCostRecovery: true },
      createdAt: 'x',
      updatedAt: 'x',
    };

    // 同日刻み: 2026-01-01 起点の刻み日は 2026-02-01〜2026-06-01 の 5 本（購入日当日は費用 0）。
    // 割り振る総額 = 12,000 − 回収 6,000 = 6,000 → 1 本 1,200。
    // 断面は最初の刻みを含む 2 月末（1 月末は刻みが 1 本もない = 全知識の遡及を見られない）。
    const february = reportEntriesForAsOf(
      {
        accounts,
        journalEntries: [purchase, recovery],
        monthlyCostItems: [item],
        recurringRules: [],
      },
      '2026-02-28',
    );
    const june = reportEntriesForAsOf(
      {
        accounts,
        journalEntries: [purchase, recovery],
        monthlyCostItems: [item],
        recurringRules: [],
      },
      '2026-06-30',
    );

    // 最初の刻み（2026-02-01）は、回収より前の断面でも回収後の断面でも同じ 1,200。
    const firstCutDate = '2026-02-01';
    const februaryAllocation = february.find(
      (entry) => entry.metadata?.continuousCostId === item.id && entry.date === firstCutDate,
    );
    const juneFirstAllocation = june.find(
      (entry) => entry.metadata?.continuousCostId === item.id && entry.date === firstCutDate,
    );
    expect(februaryAllocation?.lines[0]?.amount).toBe(1_200);
    expect(juneFirstAllocation?.lines[0]?.amount).toBe(1_200);
    expect(february.some((entry) => entry.id === recovery.id)).toBe(false);
    expect(june.some((entry) => entry.id === recovery.id)).toBe(true);
  });
});
