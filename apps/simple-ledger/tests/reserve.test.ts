import { describe, expect, it } from 'vitest';
import { reserveBalances, unassignedReserveBalance } from '../src/domain/reserve';
import type { JournalEntry, ReserveItem } from '../src/domain/types';
import './setup';

const reserves: ReserveItem[] = [
  {
    id: 'trip',
    name: '旅行',
    reserveAccountId: 'reserve-ledger',
    createdAt: 'x',
    updatedAt: 'x',
  },
  {
    id: 'tax',
    name: '税金',
    reserveAccountId: 'reserve-ledger',
    createdAt: 'x',
    updatedAt: 'x',
  },
];

describe('unassignedReserveBalance', () => {
  it('親残高から現在表示する目的別残高を引き、親と全サブ行の合計を一致させる', () => {
    const balances = new Map([
      ['trip', 300],
      ['tax', 100],
      ['deleted-reserve', 50],
    ]);
    const unassigned = unassignedReserveBalance(500, reserves, balances);

    expect(unassigned).toBe(100);
    expect(300 + 100 + unassigned).toBe(500);
  });

  it('目的別行合計が親残高を上回る場合は負値を返す', () => {
    const balances = new Map([
      ['trip', 300],
      ['tax', 100],
    ]);

    expect(unassignedReserveBalance(350, reserves, balances)).toBe(-50);
  });
});

describe('reserveBalances の基準日', () => {
  it('asOf より後の実仕訳を目的別残高へ混ぜない', () => {
    const makeEntry = (id: string, date: string, amount: number): JournalEntry => ({
      id,
      date,
      description: id,
      kind: 'normal',
      managementScopeId: 'scope-personal',
      lines: [
        { accountId: 'reserve-ledger', side: 'debit', amount },
        { accountId: 'cash', side: 'credit', amount },
      ],
      metadata: { reserveId: 'trip' },
      createdAt: 'x',
      updatedAt: 'x',
    });
    const balances = reserveBalances(
      [makeEntry('current', '2026-07-01', 100), makeEntry('future', '2026-08-01', 300)],
      '2026-07-27',
    );

    expect(balances.get('trip')).toBe(100);
  });
});
