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

describe('取消（reversalInput）と取り置き', () => {
  it('取消は reserveId を引き継ぎ、目的別残高が集約口座と同じだけ減る', async () => {
    const { reversalInput } = await import('../src/domain/entry');
    const source: JournalEntry = {
      id: 'src',
      date: '2026-07-01',
      description: '旅行の取り置き',
      kind: 'normal',
      lines: [
        { accountId: 'reserve-ledger', side: 'debit', amount: 50000 },
        { accountId: 'bank', side: 'credit', amount: 50000 },
      ],
      metadata: { inputMode: 'transfer', reserveId: 'trip' },
      createdAt: 'x',
      updatedAt: 'x',
    };
    const input = reversalInput(source);
    expect(input.metadata?.reserveId).toBe('trip');
    // 取消仕訳を実体化して合算すると目的別残高が 0 に戻る（未割り当てが負にならない）。
    const reversal: JournalEntry = {
      ...source,
      id: 'rev',
      description: input.description,
      lines: [
        { accountId: input.debitAccountId, side: 'debit', amount: input.amount },
        { accountId: input.creditAccountId, side: 'credit', amount: input.amount },
      ],
      metadata: input.metadata,
    };
    const balances = reserveBalances([source, reversal], '2026-07-27');
    expect(balances.get('trip') ?? 0).toBe(0);
  });
});
