import { describe, expect, it } from 'vitest';
import { CONTINUOUS_COST_LEDGER_ACCOUNT_ID } from '../src/domain/constants';
import {
  deriveRecurringOutputs,
  projectedRuleItems,
  recurringProjectionEntries,
} from '../src/domain/recurring';
import type { Account, JournalEntry, RecurringRule } from '../src/domain/types';

function rule(overrides: Partial<RecurringRule> = {}): RecurringRule {
  return {
    id: 'rule',
    name: '毎月のもの',
    amount: 1000,
    dayOfMonth: 20,
    everyMonths: 1,
    debitAccountId: 'expense',
    creditAccountId: 'cash',
    startMonth: '2026-04',
    startDate: '2026-04-12',
    createdAt: '2026-04-12T00:00:00.000Z',
    updatedAt: '2026-04-12T00:00:00.000Z',
    ...overrides,
  };
}

function spreadRule(overrides: Partial<RecurringRule> = {}): RecurringRule {
  return rule({
    debitAccountId: CONTINUOUS_COST_LEDGER_ACCOUNT_ID,
    spreadExpenseAccountId: 'expense',
    ...overrides,
  });
}

function account(overrides: Partial<Account> & Pick<Account, 'id' | 'type' | 'role'>): Account {
  return {
    name: overrides.id,
    archived: false,
    startDate: '2026-01-01',
    createdAt: 'x',
    updatedAt: 'x',
    ...overrides,
  };
}

const accounts: Account[] = [
  account({ id: 'cash', type: 'asset', role: 'daily-asset' }),
  account({ id: 'expense', type: 'expense', role: 'expense-category' }),
  account({
    id: CONTINUOUS_COST_LEDGER_ACCOUNT_ID,
    type: 'asset',
    role: 'continuing-cost-asset',
  }),
];

/** 購入行だけ（月割りの費用行を除く）。 */
function purchaseRows(entries: JournalEntry[]): JournalEntry[] {
  return entries.filter((entry) => entry.id.startsWith('rec-'));
}

describe('完全導出（deriveRecurringOutputs）', () => {
  it('カーソル（postedThroughMonth）を無視して存在期間の全体を導出する', () => {
    const withCursor = deriveRecurringOutputs(
      [rule({ postedThroughMonth: '2026-12' })],
      accounts,
      '2026-07-31',
    );
    const withoutCursor = deriveRecurringOutputs([rule()], accounts, '2026-07-31');

    expect(withCursor).toEqual(withoutCursor);
    expect(withCursor.entries.map((entry) => entry.date)).toEqual([
      '2026-04-20',
      '2026-05-20',
      '2026-06-20',
      '2026-07-20',
    ]);
  });

  it('月割りルールは catch-up の保存形をミラーする（virtual と時刻だけが差）', () => {
    const subject = spreadRule({ id: 'r-1' });
    const { entries, items } = deriveRecurringOutputs([subject], accounts, '2026-05-31');

    expect(entries).toEqual([
      {
        id: 'rec-r-1-2026-04',
        date: '2026-04-20',
        description: '毎月のもの',
        kind: 'normal',
        lines: [
          { accountId: CONTINUOUS_COST_LEDGER_ACCOUNT_ID, side: 'debit', amount: 1000 },
          { accountId: 'cash', side: 'credit', amount: 1000 },
        ],
        metadata: {
          virtual: true,
          inputMode: 'expense',
          recurringRuleId: 'r-1',
          recurringMonth: '2026-04',
          monthlyCostId: 'ccr-r-1-2026-04',
        },
        createdAt: subject.createdAt,
        updatedAt: subject.updatedAt,
      },
      {
        id: 'rec-r-1-2026-05',
        date: '2026-05-20',
        description: '毎月のもの',
        kind: 'normal',
        lines: [
          { accountId: CONTINUOUS_COST_LEDGER_ACCOUNT_ID, side: 'debit', amount: 1000 },
          { accountId: 'cash', side: 'credit', amount: 1000 },
        ],
        metadata: {
          virtual: true,
          inputMode: 'expense',
          recurringRuleId: 'r-1',
          recurringMonth: '2026-05',
          monthlyCostId: 'ccr-r-1-2026-05',
        },
        createdAt: subject.createdAt,
        updatedAt: subject.updatedAt,
      },
    ]);
    expect(items).toEqual([
      {
        id: 'ccr-r-1-2026-04',
        name: '毎月のもの',
        amount: 1000,
        startDate: '2026-04-20',
        endDate: '2026-05-20',
        expenseAccountId: 'expense',
        createdAt: subject.createdAt,
        updatedAt: subject.updatedAt,
      },
      {
        id: 'ccr-r-1-2026-05',
        name: '毎月のもの',
        amount: 1000,
        startDate: '2026-05-20',
        endDate: '2026-06-20',
        expenseAccountId: 'expense',
        createdAt: subject.createdAt,
        updatedAt: subject.updatedAt,
      },
    ]);
  });

  it('台帳を経由しないルールは item を作らず inputMode を役割から導出する', () => {
    const { entries, items } = deriveRecurringOutputs([rule()], accounts, '2026-04-30');

    expect(items).toEqual([]);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.metadata).toEqual({
      virtual: true,
      inputMode: 'expense',
      recurringRuleId: 'rule',
      recurringMonth: '2026-04',
    });
    expect(entries[0]!.lines[0]).toEqual({ accountId: 'expense', side: 'debit', amount: 1000 });
  });

  it('カーソル無しルールでは既存投影（購入行）と同じ集合を導出する', () => {
    const subject = spreadRule({ id: 'r-p' });
    const derived = deriveRecurringOutputs([subject], accounts, '2026-08-31');
    const projected = purchaseRows(recurringProjectionEntries([subject], accounts, '2026-08-31'));

    const normalize = (entry: JournalEntry) => ({
      date: entry.date,
      description: entry.description,
      lines: entry.lines,
      inputMode: entry.metadata?.inputMode,
      recurringRuleId: entry.metadata?.recurringRuleId,
      recurringMonth: entry.metadata?.recurringMonth,
    });
    expect(derived.entries.map(normalize)).toEqual(projected.map(normalize));

    const projectedItems = projectedRuleItems([subject], accounts, '2026-08-31');
    expect(derived.items.map((item) => ({ ...item, id: undefined }))).toEqual(
      projectedItems.map((p) => ({ ...p.item, id: undefined })),
    );
    expect(derived.items.map((item) => item.id)).toEqual(
      projectedItems.map((p) => `ccr-${p.rule.id}-${p.postingMonth}`),
    );
  });

  it('切り替え（半開区間）の境界日は後継の線分だけが導出する', () => {
    const oldRule = rule({ id: 'old', amount: 3000, endDate: '2026-06-20' });
    const successor = rule({
      id: 'new',
      amount: 5000,
      startDate: '2026-06-20',
      splitFromRuleId: 'old',
    });
    const { entries } = deriveRecurringOutputs([oldRule, successor], accounts, '2026-07-31');

    const june = entries.filter((entry) => entry.date === '2026-06-20');
    expect(june).toHaveLength(1);
    expect(june[0]!.id).toBe('rec-new-2026-06');
    expect(june[0]!.lines[0]!.amount).toBe(5000);
    expect(entries.map((entry) => `${entry.id}:${entry.date}`)).toEqual([
      'rec-old-2026-04:2026-04-20',
      'rec-old-2026-05:2026-05-20',
      'rec-new-2026-06:2026-06-20',
      'rec-new-2026-07:2026-07-20',
    ]);
  });

  it('科目が存在しない期間・参照が壊れたルールは fail-soft に落とす', () => {
    const lateCredit = [
      account({ id: 'cash', type: 'asset', role: 'daily-asset', startDate: '2026-05-01' }),
      account({ id: 'expense', type: 'expense', role: 'expense-category' }),
    ];
    const filtered = deriveRecurringOutputs([rule()], lateCredit, '2026-06-30');
    expect(filtered.entries.map((entry) => entry.date)).toEqual(['2026-05-20', '2026-06-20']);

    const missingCredit = deriveRecurringOutputs(
      [rule()],
      [account({ id: 'expense', type: 'expense', role: 'expense-category' })],
      '2026-06-30',
    );
    expect(missingCredit.entries).toEqual([]);
  });

  it('asOf は起票日当日を含む地平になる', () => {
    expect(deriveRecurringOutputs([rule()], accounts, '2026-04-20').entries).toHaveLength(1);
    expect(deriveRecurringOutputs([rule()], accounts, '2026-04-19').entries).toHaveLength(0);
  });

  it('everyMonths の位相は startMonth 基点のまま（切り替え後継も同じ）', () => {
    const quarterly = rule({
      startMonth: '2026-01',
      startDate: '2026-02-01',
      endDate: '2026-10-01',
      everyMonths: 3,
      postedThroughMonth: '2026-07',
    });
    const { entries } = deriveRecurringOutputs([quarterly], accounts, '2026-12-31');
    expect(entries.map((entry) => entry.date)).toEqual(['2026-04-20', '2026-07-20']);
  });

  it('月に無い日は月末へクランプする', () => {
    const endOfMonth = rule({
      dayOfMonth: 31,
      startMonth: '2026-01',
      startDate: '2026-01-01',
    });
    const { entries } = deriveRecurringOutputs([endOfMonth], accounts, '2026-03-31');
    expect(entries.map((entry) => entry.date)).toEqual(['2026-01-31', '2026-02-28', '2026-03-31']);
  });

  it('月割り item の終了日は次回起票日と同日（年払いも同じ規則）', () => {
    const yearly = spreadRule({
      id: 'y',
      everyMonths: 12,
      startMonth: '2026-04',
      startDate: '2026-04-12',
    });
    const { items } = deriveRecurringOutputs([yearly], accounts, '2026-12-31');
    expect(items).toHaveLength(1);
    expect(items[0]!.startDate).toBe('2026-04-20');
    expect(items[0]!.endDate).toBe('2027-04-20');
  });
});
