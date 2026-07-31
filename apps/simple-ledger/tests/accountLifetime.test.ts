import { describe, expect, it } from 'vitest';
import {
  accountExistsAt,
  accountLifetimeViolation,
  accountReferenceIntervals,
  effectiveAccountStartDate,
  recurringRuleReferenceStartDate,
} from '../src/domain/accountLifetime';
import { groupedAccountsByRole } from '../src/ui/accountOptions';
import { groupAccountsByBox } from '../src/ui/accountBoxes';
import type { Account, JournalEntry } from '../src/domain/types';
import './setup';

function account(overrides: Partial<Account> = {}): Account {
  return {
    id: 'cash',
    name: '預金',
    type: 'asset',
    role: 'daily-asset',
    archived: false,
    createdAt: '2026-01-10T12:00:00.000Z',
    updatedAt: '2026-01-10T12:00:00.000Z',
    ...overrides,
  };
}

function entry(date: string): JournalEntry {
  return {
    id: `entry-${date}`,
    date,
    description: '仕訳',
    kind: 'normal',
    lines: [
      { accountId: 'cash', side: 'debit', amount: 100 },
      { accountId: 'equity', side: 'credit', amount: 100 },
    ],
    createdAt: 'x',
    updatedAt: 'x',
  };
}

describe('勘定科目の存在期間', () => {
  it('開始日未設定はcreatedAtの日付を使い、両端を含めて存在判定する', () => {
    const subject = account({ archived: true, endDate: '2026-01-31' });
    expect(effectiveAccountStartDate(subject)).toBe('2026-01-10');
    expect(accountExistsAt(subject, '2026-01-09')).toBe(false);
    expect(accountExistsAt(subject, '2026-01-10')).toBe(true);
    expect(accountExistsAt(subject, '2026-01-31')).toBe(true);
    expect(accountExistsAt(subject, '2026-02-01')).toBe(false);
  });

  it('仕訳・予定・item・ruleの参照期間を集約し、線分を短くする変更を検出する', () => {
    const references = accountReferenceIntervals('cash', {
      entries: [entry('2026-02-01')],
      schedules: [
        {
          id: 'schedule',
          title: '予定',
          dueDate: '2026-03-01',
          amount: 100,
          direction: 'outflow',
          accountId: 'cash',
          source: 'manual',
          status: 'planned',
          createdAt: 'x',
          updatedAt: 'x',
        },
      ],
      monthlyCostItems: [],
      recurringRules: [
        {
          id: 'rule',
          name: '積立',
          amount: 100,
          dayOfMonth: 31,
          everyMonths: 1,
          debitAccountId: 'investment',
          creditAccountId: 'cash',
          startMonth: '2026-04',
          createdAt: 'x',
          updatedAt: 'x',
        },
      ],
    });

    expect(accountLifetimeViolation(account({ startDate: '2026-02-02' }), references)?.edge).toBe(
      'start',
    );
    expect(accountLifetimeViolation(account({ endDate: '2026-03-31' }), references)?.edge).toBe(
      'end',
    );
    expect(
      accountLifetimeViolation(account({ startDate: '2026-02-01' }), references),
    ).toBeUndefined();
  });

  it('定期ルールの参照開始はカーソルと既存item被覆後の次回周期日になる', () => {
    const rule = {
      id: 'rule',
      name: '年払い',
      amount: 12000,
      dayOfMonth: 31,
      everyMonths: 3,
      debitAccountId: 'continuing-cost-ledger',
      creditAccountId: 'cash',
      spreadExpenseAccountId: 'expense',
      startMonth: '2026-01',
      postedThroughMonth: '2026-04',
      createdAt: 'x',
      updatedAt: 'x',
    };
    expect(recurringRuleReferenceStartDate(rule, [])).toBe('2026-07-31');
    expect(
      recurringRuleReferenceStartDate(rule, [
        {
          id: 'ccr-rule-2026-07',
          name: '年払い',
          amount: 12000,
          startDate: '2026-07-31',
          endDate: '2026-10-31',
          expenseAccountId: 'expense',
          createdAt: 'x',
          updatedAt: 'x',
        },
      ]),
    ).toBe('2027-01-31');
  });

  it('終了日なしの既存itemが将来を覆うとルールの次回参照は存在しない', () => {
    const rule = {
      id: 'rule',
      name: '保留',
      amount: 100,
      dayOfMonth: 1,
      everyMonths: 1,
      debitAccountId: 'continuing-cost-ledger',
      creditAccountId: 'cash',
      spreadExpenseAccountId: 'expense',
      startMonth: '2026-01',
      createdAt: 'x',
      updatedAt: 'x',
    };
    const openItem = {
      id: 'ccr-rule-2026-01',
      name: '保留',
      amount: 100,
      startDate: '2026-01-01',
      expenseAccountId: 'expense',
      createdAt: 'x',
      updatedAt: 'x',
    };

    expect(recurringRuleReferenceStartDate(rule, [openItem])).toBeUndefined();
    expect(
      accountReferenceIntervals('cash', {
        entries: [],
        schedules: [],
        monthlyCostItems: [openItem],
        recurringRules: [rule],
      }),
    ).toEqual([]);
  });

  it('仕訳ピッカーはヘッダーではなく入力日付時点で存在する科目だけを返す', () => {
    const accounts = [
      account({ id: 'past', startDate: '2020-01-01', endDate: '2025-12-31', archived: true }),
      account({ id: 'current', startDate: '2026-01-01' }),
    ];

    expect(
      groupedAccountsByRole(accounts, ['daily-asset'], 'past', '2025-06-01')
        .flatMap((group) => group.accounts)
        .map(({ id }) => id),
    ).toEqual(['past']);
    expect(
      groupedAccountsByRole(accounts, ['daily-asset'], 'past', '2026-06-01')
        .flatMap((group) => group.accounts)
        .map(({ id }) => id),
    ).toEqual(['current']);
  });

  it('勘定科目一覧はヘッダー断面に存在する科目だけを通常表示する', () => {
    const accounts = [
      account({ id: 'past', startDate: '2020-01-01', endDate: '2025-12-31', archived: true }),
      account({ id: 'current', startDate: '2026-01-01' }),
    ];
    const idsAt = (date: string) =>
      groupAccountsByBox(accounts, false, date).flatMap((group) =>
        group.accounts.map(({ id }) => id),
      );

    expect(idsAt('2025-06-01')).toEqual(['past']);
    expect(idsAt('2026-06-01')).toEqual(['current']);
    expect(
      groupAccountsByBox(accounts, true, '2026-06-01')
        .flatMap((group) => group.accounts)
        .map(({ id }) => id),
    ).toEqual(expect.arrayContaining(['past', 'current']));
  });
});
