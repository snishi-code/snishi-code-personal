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
        journalEntries: [
          opening('past', '2026-07-01'),
          opening('future', '2026-08-01'),
        ],
        monthlyCostItems: [],
        recurringRules: [],
      },
      '2026-07-27',
    );

    expect(entries.map((entry) => entry.id)).toEqual(['past']);
  });

  it('未来日の回収を全知識として過去の認識へ遡及するが、回収仕訳自体は基準日前へ漏らさない', () => {
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

    const january = reportEntriesForAsOf(
      {
        accounts,
        journalEntries: [purchase, recovery],
        monthlyCostItems: [item],
        recurringRules: [],
      },
      '2026-01-31',
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

    const januaryRecognition = january.find(
      (entry) => entry.metadata?.continuousCostId === item.id,
    );
    const juneJanuaryRecognition = june.find(
      (entry) =>
        entry.metadata?.continuousCostId === item.id && entry.date === item.startDate,
    );
    expect(januaryRecognition?.lines[0]?.amount).toBe(1_000);
    expect(juneJanuaryRecognition?.lines[0]?.amount).toBe(1_000);
    expect(january.some((entry) => entry.id === recovery.id)).toBe(false);
    expect(june.some((entry) => entry.id === recovery.id)).toBe(true);
  });
});
