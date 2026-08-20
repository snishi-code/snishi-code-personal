/*
 * 台帳全体の金額容量ガード（v13.9 項目 6・監査 #5）。
 *
 * 終了日の無い科目を含む累計残高が安全整数域（Number.MAX_SAFE_INTEGER）を超える保存を
 * 保存境界で拒否し、Dashboard の集計（checked sum = safeSum）が render 中に throw して
 * root ErrorBoundary が全画面を落とす経路（監査 #5 のシナリオ）に到達させない。
 */
import { describe, expect, it } from 'vitest';
import { ledgerAmountCapacityExceeded } from '../src/domain/accountEnding';
import { MAX_AMOUNT_MINOR } from '../src/domain/schema';
import { createEntries, loadLedger } from '../src/data/repository';
import type { JournalEntry, RecurringRule } from '../src/domain/types';
import './setup';

const TS = '2026-01-01T00:00:00.000Z';

function bigEntry(i: number, debitId: string, creditId: string): JournalEntry {
  return {
    id: `bulk-${i}`,
    date: '2026-01-05',
    description: `上限級 ${i}`,
    kind: 'normal',
    lines: [
      { accountId: debitId, side: 'debit', amount: MAX_AMOUNT_MINOR },
      { accountId: creditId, side: 'credit', amount: MAX_AMOUNT_MINOR },
    ],
    metadata: { inputMode: 'expense' },
    createdAt: TS,
    updatedAt: TS,
  };
}

describe('ledgerAmountCapacityExceeded（上界の判定・純関数）', () => {
  it('実用域の台帳（1 万件 × 10 万 minor）では超過しない', () => {
    const modest = Array.from({ length: 10_000 }, (_, i) => ({
      ...bigEntry(i, 'a', 'b'),
      lines: bigEntry(i, 'a', 'b').lines.map((line) => ({ ...line, amount: 100_000 })),
    }));
    expect(
      ledgerAmountCapacityExceeded({
        accounts: [],
        journalEntries: modest,
        monthlyCostItems: [],
        recurringRules: [],
      }),
    ).toBe(false);
  });

  it('上限級の仕訳の累計が安全整数域を出ると超過になる', () => {
    const entries = Array.from({ length: 2_300 }, (_, i) => bigEntry(i, 'a', 'b'));
    expect(
      ledgerAmountCapacityExceeded({
        accounts: [],
        journalEntries: entries,
        monthlyCostItems: [],
        recurringRules: [],
      }),
    ).toBe(true);
  });

  it('終了日の無い定期ルールは導出地平（2100 年）までの起票回数で数える', () => {
    const rule = (id: string): RecurringRule => ({
      id,
      name: '巨額ルール',
      amount: MAX_AMOUNT_MINOR,
      dayOfMonth: 1,
      everyMonths: 1,
      spreadExpenseAccountId: 'e',
      debitAccountId: 'continuing-cost-ledger',
      creditAccountId: 'c',
      startMonth: '2000-01',
      startDate: '2000-01-01',
      createdAt: TS,
      updatedAt: TS,
    });
    // 1 本（約 1,212 回 ×4 ×10^12 ≈ 4.8×10^15）は収まり、2 本で安全整数域を出る。
    const base = { accounts: [], journalEntries: [], monthlyCostItems: [] };
    expect(ledgerAmountCapacityExceeded({ ...base, recurringRules: [rule('r1')] })).toBe(false);
    expect(
      ledgerAmountCapacityExceeded({ ...base, recurringRules: [rule('r1'), rule('r2')] }),
    ).toBe(true);
  });
});

describe('保存境界（repository）での拒否', () => {
  it('累計があふれる一括登録を保存時にエラーにし、何も書かない', async () => {
    const ledger = await loadLedger();
    const cash = ledger.accounts.find((a) => a.name === '現金')!;
    const expense = ledger.accounts.find((a) => a.role === 'expense-category')!;
    // 2,000 件（合計 8×10^15 = 上界の内側）は保存できる。
    await createEntries(Array.from({ length: 2_000 }, (_, i) => bigEntry(i, expense.id, cash.id)));
    expect((await loadLedger()).journalEntries).toHaveLength(2_000);
    // さらに 300 件を足すと上界（安全整数域）を出る → 保存時に拒否・1 件も入らない。
    await expect(
      createEntries(
        Array.from({ length: 300 }, (_, i) => bigEntry(10_000 + i, expense.id, cash.id)),
      ),
    ).rejects.toThrow('error.amount.overflow');
    expect((await loadLedger()).journalEntries).toHaveLength(2_000);
  });
});
