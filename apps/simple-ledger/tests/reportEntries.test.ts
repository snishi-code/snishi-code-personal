import { describe, expect, it } from 'vitest';
import { reportEntriesForAsOf } from '../src/domain/reportEntries';
import type { Account, JournalEntry } from '../src/domain/types';
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
    name: '開始残高',
    type: 'equity',
    role: 'equity',
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
      '2026-07-27',
    );

    expect(entries.map((entry) => entry.id)).toEqual(['past']);
  });
});
