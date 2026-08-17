import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { InvestmentProjectionTruncationNotice } from '../src/ui/components/InvestmentProjectionTruncationNotice';
import { Journal } from '../src/ui/screens/Journal';
import * as reportEntriesModule from '../src/domain/reportEntries';
import { SCHEMA_VERSION } from '../src/domain/constants';
import type { Account, JournalEntry, Ledger } from '../src/domain/types';
import './setup';

const ledgerState = vi.hoisted(() => ({ ledger: null as Ledger | null }));

vi.mock('../src/state/store', () => ({
  useLedger: () => ({
    ledger: ledgerState.ledger,
    removeEntry: async () => undefined,
    deleteOpening: async () => undefined,
    deleteAdjustment: async () => undefined,
  }),
  useOptionalLedger: () => ({ ledger: ledgerState.ledger }),
}));

const timestamp = '2026-01-01T00:00:00.000Z';

function account(id: string, name: string, type: Account['type'], role: Account['role']): Account {
  return { id, name, type, role, archived: false, createdAt: timestamp, updatedAt: timestamp };
}

function fixtureLedger(): Ledger {
  const accounts = [
    account('investment', '投資', 'asset', 'investment-asset'),
    account('gain', '投資益', 'revenue', 'income-category'),
    account('equity', '元手', 'equity', 'equity'),
  ];
  const opening: JournalEntry = {
    id: 'opening',
    date: '2026-01-01',
    description: '初期残高',
    kind: 'opening',
    lines: [
      { accountId: 'investment', side: 'debit', amount: 100_000 },
      { accountId: 'equity', side: 'credit', amount: 100_000 },
    ],
    createdAt: timestamp,
    updatedAt: timestamp,
  };
  return {
    meta: {
      id: 'ledger',
      schemaVersion: SCHEMA_VERSION,
      revision: 1,
      deviceId: 'device',
      createdAt: timestamp,
      updatedAt: timestamp,
    },
    settings: { ledgerName: 'test', currency: '円', displayFractionDigits: 0 },
    accounts,
    journalEntries: [opening],
    monthlyCostItems: [],
    recurringRules: [],
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(2026, 6, 15, 12));
  ledgerState.ledger = fixtureLedger();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.useRealTimers();
  ledgerState.ledger = null;
});

describe('投資投影の打ち切り通知', () => {
  it('全画面で共有する文言に科目名と最初の打ち切り月を入れ、同じ科目は重複表示しない', () => {
    render(
      <InvestmentProjectionTruncationNotice
        truncations={[
          { accountId: 'investment', month: '2026-10' },
          { accountId: 'investment', month: '2026-09' },
        ]}
        accounts={ledgerState.ledger!.accounts}
      />,
    );

    const notes = screen.getAllByRole('note');
    expect(notes).toHaveLength(1);
    expect(notes[0]).toHaveTextContent('「投資」の投影');
    expect(notes[0]).toHaveTextContent('2026-09 で打ち切り');
    expect(notes[0]).toHaveTextContent('それ以降の投影は表示に含まれません');
  });

  it('仕訳一覧は実際の展開上限の診断を捨てずに表示する', () => {
    const ledger = ledgerState.ledger!;
    const expand = vi.spyOn(reportEntriesModule, 'displayEntriesResultForAsOf').mockReturnValue({
      entries: ledger.journalEntries,
      investmentProjectionTruncations: [{ accountId: 'investment', month: '2026-09' }],
    });

    render(
      <Journal
        onEditEntry={() => undefined}
        onReverse={() => undefined}
        onOpenAllocations={() => undefined}
        onOpenAccount={() => undefined}
        filter={{ to: '2026-12-31' }}
        period={{ mode: 'all' }}
        onClearFilter={() => undefined}
      />,
    );

    expect(expand).toHaveBeenCalledWith(ledger, '2026-12-31');
    expect(screen.getByRole('note')).toHaveTextContent('「投資」の投影');
    expect(screen.getByRole('note')).toHaveTextContent('2026-09');
  });
});
