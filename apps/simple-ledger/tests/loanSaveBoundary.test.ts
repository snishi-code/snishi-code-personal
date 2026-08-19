/*
 * ローン保存境界の金額不変条件（v13.8 監査 D）:
 *  - 月額は切り捨て（総額 ÷ 回数）。「月額 × 回数 ≤ 総額」= 返済し切った負債が
 *    マイナス残高（過返済）にならない。
 *  - 回数 > 総額（月額 1 未満）は保存境界で拒否する（error.loan.monthlyTooSmall）。
 *  - 端数（総額 − 月額×回数）は正の負債残高として最後に残る（作者が手仕訳か補正で始末する）。
 */
import { describe, expect, it } from 'vitest';
import { createLoanPurchase, createOpenings, loadLedger } from '../src/data/repository';
import { loanScheduledTotal } from '../src/domain/loan';
import { addMonthsToDate } from '../src/domain/allocation';
import { todayLocal } from '../src/util/time';
import './setup';

async function seed() {
  const ledger = await loadLedger();
  const cash = ledger.accounts.find((a) => a.name === '現金')!;
  const expense = ledger.accounts.find((a) => a.role === 'expense-category')!;
  await createOpenings([{ accountId: cash.id, amount: 500000000, date: '2000-01-01' }]);
  return { cash, expense };
}

describe('ローンの月額（保存境界・監査 D）', () => {
  it('割り切れない借入は月額を切り捨て、予定合計が総額を超えない', async () => {
    const { cash, expense } = await seed();
    const { rule } = await createLoanPurchase({
      loanName: '家電ローン',
      date: todayLocal(),
      description: '家電',
      amount: 10000,
      expenseAccountId: expense.id,
      repaymentFromAccountId: cash.id,
      // 初回返済（+1 か月）から 6 回で終わる終了日。
      repaymentEndDate: addMonthsToDate(todayLocal(), 7),
    });
    expect(rule.amount).toBe(1666);
    expect(loanScheduledTotal(rule.amount, 6)).toBeLessThanOrEqual(10000);
    // 端数 4 は負債残高に正として残る（過返済 = マイナス残高にならない）。
    expect(10000 - loanScheduledTotal(rule.amount, 6)).toBe(4);
  });

  it('回数 > 総額（月額 1 未満）は拒否し、何も書かない', async () => {
    const { cash, expense } = await seed();
    const before = await loadLedger();
    await expect(
      createLoanPurchase({
        loanName: '極小ローン',
        date: todayLocal(),
        description: '極小',
        amount: 5,
        expenseAccountId: expense.id,
        repaymentFromAccountId: cash.id,
        repaymentEndDate: addMonthsToDate(todayLocal(), 11),
      }),
    ).rejects.toThrow('error.loan.monthlyTooSmall');
    const after = await loadLedger();
    expect(after.accounts.map((a) => a.id)).toEqual(before.accounts.map((a) => a.id));
    expect(after.journalEntries).toHaveLength(before.journalEntries.length);
    expect(after.recurringRules).toHaveLength(0);
  });
});
