import { describe, expect, it } from 'vitest';
import {
  accountExistsAt,
  accountLifetimeViolation,
  accountReferenceIntervals,
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
  it('開始日未設定は過去へ開いた線分（createdAt を暗黙開始日にしない・§A 案1）', () => {
    // 旧仕様（createdAt を暗黙開始日として存在判定に使う）は 2026-08-11 に廃止。
    // createdAt より古い日付でも存在し、endDate だけが線分を閉じる。
    const subject = account({ archived: true, endDate: '2026-01-31' });
    expect(accountExistsAt(subject, '2019-01-01')).toBe(true);
    expect(accountExistsAt(subject, '2026-01-09')).toBe(true);
    expect(accountExistsAt(subject, '2026-01-31')).toBe(true);
    expect(accountExistsAt(subject, '2026-02-01')).toBe(false);
  });

  it('開始日未設定はどんな過去の参照も包含する（保存境界の下限は明示 startDate のみ・§A 案1）', () => {
    const references = accountReferenceIntervals('cash', {
      entries: [entry('2019-01-01')],
      monthlyCostItems: [],
      recurringRules: [],
    });
    expect(accountLifetimeViolation(account(), references)).toBeUndefined();
    expect(accountLifetimeViolation(account({ startDate: '2020-01-01' }), references)?.edge).toBe(
      'start',
    );
  });

  it('仕訳・item・ruleの参照期間を集約し、線分を短くする変更を検出する', () => {
    const references = accountReferenceIntervals('cash', {
      entries: [entry('2026-02-01')],
      monthlyCostItems: [],
      recurringRules: [
        {
          id: 'rule',
          name: '積立',
          amount: 100,
          dayOfMonth: 31,
          everyMonths: 1,
          spreadExpenseAccountId: 'investment',
          debitAccountId: 'investment',
          creditAccountId: 'cash',
          startMonth: '2026-04',
          startDate: '2026-04-01',
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

  it('item の参照期間は startDate〜endDate', () => {
    const deferredItem = {
      id: 'm-deferred',
      name: '前払い',
      amount: 60000,
      startDate: '2026-01-15',
      endDate: '2026-12-31',
      expenseAccountId: 'expense',
      createdAt: 'x',
      updatedAt: 'x',
    };
    expect(
      accountReferenceIntervals('expense', {
        entries: [],
        monthlyCostItems: [deferredItem],
        recurringRules: [],
      }),
    ).toEqual([{ kind: 'monthlyCost', from: '2026-01-15', to: '2026-12-31' }]);
  });

  it('定期ルールの参照開始は存在期間内で位相に乗る最初の起票日になる（v13: カーソルなし）', () => {
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
      startDate: '2026-01-01',
      createdAt: 'x',
      updatedAt: 'x',
    };
    // 位相は 1 月起点の 3 か月ごと（1・4・7 月）。存在開始 1/1 以降の最初の起票日 = 1/31。
    expect(recurringRuleReferenceStartDate(rule)).toBe('2026-01-31');
  });

  it('既存itemの期間はルールの次回参照を止めない', () => {
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
      startDate: '2026-01-01',
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

    expect(recurringRuleReferenceStartDate(rule)).toBe('2026-01-01');
    expect(
      accountReferenceIntervals('cash', {
        entries: [],
        monthlyCostItems: [openItem],
        recurringRules: [rule],
      }),
    ).toEqual([{ kind: 'recurringRule', from: '2026-01-01' }]);
  });

  it('有限の費用ルールは最後に生成するitemの終端まで費用科目を参照する', () => {
    const rule = {
      id: 'annual-rule',
      name: '年払い',
      amount: 12000,
      dayOfMonth: 20,
      everyMonths: 12,
      debitAccountId: 'continuing-cost-ledger',
      creditAccountId: 'cash',
      spreadExpenseAccountId: 'expense',
      startMonth: '2026-01',
      startDate: '2026-01-01',
      endDate: '2026-02-01',
      createdAt: 'x',
      updatedAt: 'x',
    };

    // 最後の起票は 2026-01-20（ルールは 2026-02-01 排他終了）。その 1 起票が作る item は
    // [2026-01-20, 次回起票日と同日] = recurringRuleItemEndDate('2026-01', 12, 20)
    // = clampDayToMonth('2027-01', 20) = 2027-01-20。費用科目の参照はそこまで伸びる。
    expect(
      accountReferenceIntervals('expense', {
        entries: [],
        monthlyCostItems: [],
        recurringRules: [rule],
      }),
    ).toEqual([{ kind: 'recurringRule', from: '2026-01-20', to: '2027-01-20' }]);
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
