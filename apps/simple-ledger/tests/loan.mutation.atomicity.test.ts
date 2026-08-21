/*
 * mutation 検証 ②（ローン作成の 1 tx 原子性・v13.13）。
 *
 * 「ローンで払う」は負債科目・借入の仕訳・ローン item（+ 持ち物）を**1 トランザクション**で
 * 作る。テスト内で**最後の検証工程**（assertEndedAssetLiabilityBalances が使う
 * accountEndingBalanceViolations）を必ず失敗させ、先に組み立てた負債科目・借入の仕訳・
 * item が 1 件も残らないこと = 途中まで書いて止まる経路が無いことを見る（fail-closed）。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/domain/accountEnding', async () => {
  const actual = await vi.importActual<typeof import('../src/domain/accountEnding')>(
    '../src/domain/accountEnding',
  );
  return {
    ...actual,
    // 反転: 全保存経路の共通検証（最終工程）が必ず違反を報告する。
    accountEndingBalanceViolations: () => [
      { account: { id: 'x', name: 'x' } } as unknown as ReturnType<
        typeof actual.accountEndingBalanceViolations
      >[number],
    ],
  };
});

const { createLoanPurchase, loadLedger } = await import('../src/data/repository');
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
  // opening は張らない: 事前の opening 自体も同じ共通検証（反転済み）で失敗するため。
  // ローンの登録に残高は要らない（残高 0 の現金を返済元にできる = 無差別原則）。
  return { cash, expense };
}

describe('mutation: 最終検証に失敗したら何も残らない', () => {
  it('負債科目・借入の仕訳・ローン item のどれも書かれない（費用カテゴリ払い）', async () => {
    const { cash, expense } = await seed();
    const before = await loadLedger();

    await expect(
      createLoanPurchase({
        loanName: '自動車ローン',
        date: todayLocal(),
        description: '自動車',
        amount: 12000000,
        expenseAccountId: expense.id,
        repaymentSourceAccountId: cash.id,
        repaymentEndDate: addMonthsToDate(todayLocal(), 12),
      }),
    ).rejects.toThrow();

    const after = await loadLedger();
    expect(after.accounts.map((a) => a.id)).toEqual(before.accounts.map((a) => a.id));
    expect(after.journalEntries).toHaveLength(before.journalEntries.length);
    expect(after.monthlyCostItems).toHaveLength(0);
    // 版も進めない（書込 transaction そのものへ入っていない）。
    expect(after.meta.revision).toBe(before.meta.revision);
  });

  it('持ち物との併用でも item が残らない（複数ストアぶんまとめて中断）', async () => {
    const { cash, expense } = await seed();
    const before = await loadLedger();

    await expect(
      createLoanPurchase({
        loanName: '自動車ローン',
        date: todayLocal(),
        description: '自動車',
        amount: 12000000,
        expenseAccountId: expense.id,
        repaymentSourceAccountId: cash.id,
        repaymentEndDate: addMonthsToDate(todayLocal(), 12),
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
