/*
 * mutation 検証 ②（ローン作成の 1 tx 原子性）。
 *
 * 「ローンで払う」は負債科目・購入の仕訳・返済ルール（+ 持ち物）を**1 トランザクション**で
 * 作る。テスト内で domain/loan の月額計算を壊し（0 = 保存できない金額）、**最後の工程である
 * ルールの検証だけが失敗する**状況を作る。それでも先に組み立てた負債科目・購入の仕訳・
 * 持ち物が 1 件も残らないこと = 途中まで書いて止まる経路が無いことを見る（fail-closed）。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/domain/loan', async () => {
  const actual = await vi.importActual<typeof import('../src/domain/loan')>('../src/domain/loan');
  return {
    ...actual,
    // 反転: 月額が上限超え（amountSchema の max が拒む）＝ルールの検証（最終工程）だけが
    // 必ず失敗する。0 にしない: 月額 < 1 は v13.8 監査 D の早期ガードで工程の頭で
    // 弾かれるようになり、「最後の工程で失敗しても何も残らない」の検証にならない。
    loanMonthlyAmount: () => 10 ** 12 + 1,
  };
});

const { createLoanPurchase, createOpenings, loadLedger } = await import('../src/data/repository');
const { addMonthsToDate } = await import('../src/domain/allocation');
const { todayLocal } = await import('../src/util/time');
await import('./setup');

afterEach(() => {
  vi.restoreAllMocks();
});

async function seed() {
  const ledger = await loadLedger();
  const cash = ledger.accounts.find((a) => a.name === '現金')!;
  const expense = ledger.accounts.find((a) => a.role === 'expense-category')!;
  await createOpenings([{ accountId: cash.id, amount: 500000000, date: '2000-01-01' }]);
  return { cash, expense };
}

describe('mutation: ルールの保存に失敗したら何も残らない', () => {
  it('負債科目・購入の仕訳・ルールのどれも書かれない（費用カテゴリ払い）', async () => {
    const { cash, expense } = await seed();
    const before = await loadLedger();

    await expect(
      createLoanPurchase({
        loanName: '自動車ローン',
        date: todayLocal(),
        description: '自動車',
        amount: 12000000,
        expenseAccountId: expense.id,
        repaymentFromAccountId: cash.id,
        repaymentEndDate: addMonthsToDate(todayLocal(), 13),
      }),
    ).rejects.toThrow();

    const after = await loadLedger();
    expect(after.accounts.map((a) => a.id)).toEqual(before.accounts.map((a) => a.id));
    expect(after.journalEntries).toHaveLength(before.journalEntries.length);
    expect(after.recurringRules).toHaveLength(0);
    expect(after.monthlyCostItems).toHaveLength(0);
    // 版も進めない（書込 transaction そのものへ入っていない）。
    expect(after.meta.revision).toBe(before.meta.revision);
  });

  it('持ち物との併用でも item が残らない（4 ストアぶんまとめて中断）', async () => {
    const { cash, expense } = await seed();
    const before = await loadLedger();

    await expect(
      createLoanPurchase({
        loanName: '自動車ローン',
        date: todayLocal(),
        description: '自動車',
        amount: 12000000,
        expenseAccountId: expense.id,
        repaymentFromAccountId: cash.id,
        repaymentEndDate: addMonthsToDate(todayLocal(), 13),
        continuousCost: { name: '自動車', endDate: addMonthsToDate(todayLocal(), 60) },
      }),
    ).rejects.toThrow();

    const after = await loadLedger();
    expect(after.monthlyCostItems).toHaveLength(0);
    expect(after.journalEntries).toHaveLength(before.journalEntries.length);
    expect(after.accounts.map((a) => a.name)).not.toContain('自動車ローン');
    expect(after.meta.revision).toBe(before.meta.revision);
  });
});
