/*
 * ローン返済の導出合流（v13.13 §2.2）:
 *  - reportEntries の第 3 の導出源としてローン item の返済行が合流する。
 *  - 台帳（継続コスト資産）はローンに関与しない（台帳残高がローンに影響されない）。
 *  - 同日一致: 各刻み日に負債の減りと資金の出が同日同額。完済日で負債残高 0（合計厳密一致）。
 *  - 一括返済（loanSettlement 実仕訳）後は残額が [start, end] へ再按分される。
 *  - 参照追跡（監査 #5・critical）: 返済元は accountRefs の「使用中」に乗る。
 */
import { describe, expect, it } from 'vitest';
import './setup';
import { reportEntriesForAsOf } from '../src/domain/reportEntries';
import { accountBalance } from '../src/domain/accounting';
import { isAccountReferenced, referencedAccountIds } from '../src/domain/accountRefs';
import { accountReferenceIntervals } from '../src/domain/accountLifetime';
import { CONTINUOUS_COST_LEDGER_ACCOUNT_ID } from '../src/domain/constants';
import type { Account, JournalEntry, MonthlyCostItem, RecurringRule } from '../src/domain/types';

function account(id: string, name: string, type: Account['type'], role: Account['role']): Account {
  return { id, name, type, role, archived: false, createdAt: 'x', updatedAt: 'x' };
}

const accounts: Account[] = [
  account('cash', '現金', 'asset', 'daily-asset'),
  account('liab', '家電ローン', 'liability', 'other-liability'),
  account('food', '食費', 'expense', 'expense-category'),
];

/** 10,000 借入・2026-08-18 購入・完済日 2027-02-18（6 回）。 */
const loanItem: MonthlyCostItem = {
  id: 'loan1',
  name: '家電ローン',
  amount: 10000,
  startDate: '2026-08-18',
  endDate: '2027-02-18',
  expenseAccountId: 'liab',
  repaymentSourceAccountId: 'cash',
  createdAt: 'x',
  updatedAt: 'x',
};

const borrow: JournalEntry = {
  id: 'b1',
  date: '2026-08-18',
  description: '家電',
  kind: 'normal',
  lines: [
    { accountId: 'food', side: 'debit', amount: 10000 },
    { accountId: 'liab', side: 'credit', amount: 10000 },
  ],
  metadata: { inputMode: 'expense', loanItemId: 'loan1' },
  createdAt: 'x',
  updatedAt: 'x',
};

function ledgerOf(over: {
  monthlyCostItems?: MonthlyCostItem[];
  journalEntries?: JournalEntry[];
  recurringRules?: RecurringRule[];
}) {
  return {
    accounts,
    journalEntries: over.journalEntries ?? [borrow],
    monthlyCostItems: over.monthlyCostItems ?? [loanItem],
    recurringRules: over.recurringRules ?? [],
  };
}

function balanceAt(
  ledger: ReturnType<typeof ledgerOf>,
  accountId: string,
  type: Account['type'],
  asOf: string,
): number {
  return accountBalance(accountId, type, reportEntriesForAsOf(ledger, asOf));
}

describe('返済行の合流（第 3 の導出源）', () => {
  it('刻みごとに返済の導出行が現れ、断面で切れる', () => {
    const ledger = ledgerOf({});
    const rows = reportEntriesForAsOf(ledger, '2026-10-01').filter(
      (e) => e.metadata?.ccKind === 'loan-repayment',
    );
    expect(rows.map((e) => e.id)).toEqual(['loan-pay-loan1-2026-09']);
    expect(rows[0]!.lines).toEqual([
      { accountId: 'liab', side: 'debit', amount: 1667 },
      { accountId: 'cash', side: 'credit', amount: 1667 },
    ]);
  });

  it('同日一致: 負債の減りと資金の出が同日同額・完済日で負債残高 0（合計厳密一致）', () => {
    const ledger = ledgerOf({});
    // 購入直後: 負債 10,000・現金 0（返済はまだ）。
    expect(balanceAt(ledger, 'liab', 'liability', '2026-08-18')).toBe(10000);
    expect(balanceAt(ledger, 'cash', 'asset', '2026-08-18')).toBe(0);
    // 初回刻み日: 負債 −1,667 と現金 −1,667 が同日に起きる（1 刻み遅れの解消）。
    expect(balanceAt(ledger, 'liab', 'liability', '2026-09-18')).toBe(10000 - 1667);
    expect(balanceAt(ledger, 'cash', 'asset', '2026-09-18')).toBe(-1667);
    // 前日の断面では両方とも動いていない（同日にだけ動く）。
    expect(balanceAt(ledger, 'liab', 'liability', '2026-09-17')).toBe(10000);
    expect(balanceAt(ledger, 'cash', 'asset', '2026-09-17')).toBe(0);
    // 完済日: 端数が残らない（旧 floor 設計は 4 が残った）。
    expect(balanceAt(ledger, 'liab', 'liability', '2027-02-18')).toBe(0);
    expect(balanceAt(ledger, 'cash', 'asset', '2027-02-18')).toBe(-10000);
  });

  it('台帳（継続コスト資産）はローンに関与しない（どの断面でも台帳残高 0）', () => {
    const ledger = ledgerOf({});
    for (const asOf of ['2026-08-18', '2026-12-31', '2027-02-18', '2030-01-01']) {
      expect(balanceAt(ledger, CONTINUOUS_COST_LEDGER_ACCOUNT_ID, 'asset', asOf)).toBe(0);
    }
  });
});

describe('一括返済（終了）の再按分', () => {
  // 2026-11-20 に理論残債で一括返済 → endDate = 11-20 へ短縮 + 実仕訳。
  // 変更前スケジュールで 11-20 までの経過 = 1667×3 = 5001 → 理論残債 4,999。
  const settledItem: MonthlyCostItem = { ...loanItem, endDate: '2026-11-20' };
  const settlement: JournalEntry = {
    id: 's1',
    date: '2026-11-20',
    description: '一括返済',
    kind: 'normal',
    lines: [
      { accountId: 'liab', side: 'debit', amount: 4999 },
      { accountId: 'cash', side: 'credit', amount: 4999 },
    ],
    metadata: { inputMode: 'transfer', loanItemId: 'loan1', loanSettlement: true },
    createdAt: 'x',
    updatedAt: 'x',
  };
  const ledger = ledgerOf({
    monthlyCostItems: [settledItem],
    journalEntries: [borrow, settlement],
  });

  it('残額（amount − 一括返済）が [start, D] へ再按分され、D 以降の負債残高は 0', () => {
    // spreadTotal = 10,000 − 4,999 = 5,001 を 9/18〜11/18 の 3 刻みへ（1667×3）。
    const rows = reportEntriesForAsOf(ledger, '2100-12-31').filter(
      (e) => e.metadata?.ccKind === 'loan-repayment',
    );
    expect(rows.map((e) => e.date)).toEqual(['2026-09-18', '2026-10-18', '2026-11-18']);
    expect(rows.map((e) => e.lines[0]!.amount)).toEqual([1667, 1667, 1667]);
    // D より前の各断面の残高は端数再配分の範囲でほぼ保存される（この例では完全一致）。
    expect(balanceAt(ledger, 'liab', 'liability', '2026-10-01')).toBe(10000 - 1667);
    // D 当日: 導出 3 本 + 実仕訳 4,999 で 0。
    expect(balanceAt(ledger, 'liab', 'liability', '2026-11-20')).toBe(0);
    expect(balanceAt(ledger, 'cash', 'asset', '2026-11-20')).toBe(-10000);
    // 以後の刻みは生まれない。
    expect(balanceAt(ledger, 'liab', 'liability', '2027-02-18')).toBe(0);
  });

  it('mutation 感度: 一括返済の控除を外すと（= spreadTotal を素の amount にすると）過返済になる', () => {
    // 控除なしの世界を直接組んで、控除の有無が残高で観測できることを固定する
    // （spreadTotal 控除を外す変異は完済日の負債残高が −4,999 になり落ちる）。
    const noDeduction = ledgerOf({
      monthlyCostItems: [{ ...settledItem }],
      journalEntries: [
        borrow,
        { ...settlement, metadata: { inputMode: 'transfer' } }, // 印を失った一括返済
      ],
    });
    expect(balanceAt(noDeduction, 'liab', 'liability', '2026-11-20')).toBe(-4999);
  });
});

describe('参照追跡（監査 #5・critical）', () => {
  it('返済元はローン item だけからでも「使用中」になる', () => {
    const collections = {
      entries: [] as JournalEntry[],
      monthlyCostItems: [loanItem],
      recurringRules: [] as RecurringRule[],
    };
    expect(isAccountReferenced('cash', collections)).toBe(true);
    expect(referencedAccountIds(collections).has('cash')).toBe(true);
  });

  it('返済元の参照区間 = 先頭刻み〜完済日（借入仕訳の日 = 購入日からは縛らない）', () => {
    const collections = {
      entries: [] as JournalEntry[],
      monthlyCostItems: [loanItem],
      recurringRules: [] as RecurringRule[],
    };
    expect(accountReferenceIntervals('cash', collections)).toEqual([
      { kind: 'monthlyCost', from: '2026-09-18', to: '2027-02-18' },
    ]);
    // 計上先（負債）は購入日から完済日まで。台帳にはローンの区間が乗らない。
    expect(accountReferenceIntervals('liab', collections)).toEqual([
      { kind: 'monthlyCost', from: '2026-08-18', to: '2027-02-18' },
    ]);
    expect(accountReferenceIntervals(CONTINUOUS_COST_LEDGER_ACCOUNT_ID, collections)).toEqual([]);
  });
});
