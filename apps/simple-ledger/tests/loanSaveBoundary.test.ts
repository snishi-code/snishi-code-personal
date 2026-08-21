/*
 * ローン保存境界（v13.13・ローン = 月割り台帳の item）:
 *  - createLoanPurchase = 負債科目 + 借入の仕訳（loanItemId・金額/日付ミラー）+ ローン item を 1 tx。
 *    ルールは作らない（旧形ローンルールの廃止）。
 *  - 端数は按分機構（合計厳密一致）に乗る = 旧 noRepayment / monthlyTooSmall の拒否は存在しない。
 *  - 返済期間の上限（1,200 か月）は黙って飽和せず拒否する。
 *  - 旧形（計上先が負債のルール・計上先が負債の通常 item）は保存境界が拒否する（両層の片方 =
 *    §6-5 の save 層。wire 層は loanSchema.test.ts）。
 *  - settleLoan（終了 = 一括返済）: endDate + 実仕訳を 1 tx・過返済は拒否。
 */
import { describe, expect, it } from 'vitest';
import {
  createContinuousCost,
  createLoanPurchase,
  createOpenings,
  createRecurringRule,
  deleteEntry,
  deleteMonthlyCost,
  loadLedger,
  settleLoan,
  upsertMonthlyCost,
} from '../src/data/repository';
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

async function makeLoan(over: Partial<Parameters<typeof createLoanPurchase>[0]> = {}) {
  const { cash, expense } = await seed();
  const created = await createLoanPurchase({
    loanName: '家電ローン',
    date: todayLocal(),
    description: '家電',
    amount: 10000,
    expenseAccountId: expense.id,
    repaymentSourceAccountId: cash.id,
    // 6 回払い（完済日 = 6 か月後・inclusive）。
    repaymentEndDate: addMonthsToDate(todayLocal(), 6),
    ...over,
  });
  return { ...created, cash, expense };
}

describe('createLoanPurchase（登録 = 1 tx・ミラー不変条件）', () => {
  it('負債科目 + 借入の仕訳 + ローン item ができ、ルールは作られない', async () => {
    const { liability, purchase, loanItem, cash } = await makeLoan();
    const ledger = await loadLedger();
    expect(ledger.recurringRules).toHaveLength(0);
    // 負債科目。
    const saved = ledger.accounts.find((a) => a.id === liability.id)!;
    expect(saved.role).toBe('other-liability');
    // ローン item: 計上先 = 負債・返済元・完済日必須。
    const item = ledger.monthlyCostItems.find((m) => m.id === loanItem.id)!;
    expect(item.expenseAccountId).toBe(liability.id);
    expect(item.repaymentSourceAccountId).toBe(cash.id);
    expect(item.endDate).toBe(addMonthsToDate(todayLocal(), 6));
    // 借入の仕訳: 貸方 = 負債・金額/日付が item とミラー・loanItemId 付き。
    const borrow = ledger.journalEntries.find((e) => e.id === purchase.id)!;
    expect(borrow.metadata?.loanItemId).toBe(item.id);
    expect(borrow.lines.find((l) => l.side === 'credit')!.accountId).toBe(liability.id);
    expect(borrow.lines.find((l) => l.side === 'credit')!.amount).toBe(item.amount);
    expect(borrow.date).toBe(item.startDate);
  });

  it('割り切れない借入も拒否しない（端数は按分機構が解決 = 旧 monthlyTooSmall の廃止）', async () => {
    // 総額 5 を 11 回相当の完済日で（旧設計は月額 0 で拒否していた）。
    const { loanItem } = await makeLoan({
      loanName: '極小ローン',
      amount: 5,
      repaymentEndDate: addMonthsToDate(todayLocal(), 11),
    });
    expect(loanItem.amount).toBe(5);
  });

  it('完済日 = 購入日（1 か月未満の縮退）も登録できる（完済日に全額 1 本）', async () => {
    const { loanItem } = await makeLoan({ repaymentEndDate: todayLocal() });
    expect(loanItem.endDate).toBe(todayLocal());
  });

  it('返済期間が上限（1,200 か月）を超える完済日は拒否し、何も書かない', async () => {
    const { cash, expense } = await seed();
    const before = await loadLedger();
    await expect(
      createLoanPurchase({
        loanName: '超長期ローン',
        date: '2000-01-15',
        description: '超長期',
        amount: 12_000_000,
        expenseAccountId: expense.id,
        repaymentSourceAccountId: cash.id,
        repaymentEndDate: '2100-12-31', // 1,212 か月 > 1,200
      }),
    ).rejects.toThrow('error.loan.termTooLong');
    const after = await loadLedger();
    expect(after.accounts.map((a) => a.id)).toEqual(before.accounts.map((a) => a.id));
    expect(after.monthlyCostItems).toHaveLength(0);
    expect(after.journalEntries).toHaveLength(before.journalEntries.length);
  });

  it('購入日より前の完済日は拒否する', async () => {
    const { cash, expense } = await seed();
    await expect(
      createLoanPurchase({
        loanName: 'x',
        date: todayLocal(),
        description: 'x',
        amount: 10000,
        expenseAccountId: expense.id,
        repaymentSourceAccountId: cash.id,
        repaymentEndDate: '2000-01-01',
      }),
    ).rejects.toThrow('error.monthlyCost.endBeforeStart');
  });
});

describe('旧形の拒否（保存境界の層・§6-5 mutation の save 側）', () => {
  it('計上先が負債の定期ルールは作れない（旧形ローンルール）', async () => {
    const { liability, cash } = await makeLoan();
    await expect(
      createRecurringRule({
        name: '旧形ローン',
        amount: 100000,
        dayOfMonth: 15,
        debitAccountId: liability.id,
        creditAccountId: cash.id,
      }),
    ).rejects.toThrow('error.recurring.liabilityDestination');
  });

  it('計上先が負債の通常 item（返済元なし）は作れない', async () => {
    const { liability, cash } = await makeLoan();
    await expect(
      createContinuousCost({
        name: '片肺ローン',
        amount: 10000,
        startDate: todayLocal(),
        endDate: addMonthsToDate(todayLocal(), 6),
        expenseAccountId: liability.id,
        creditAccountId: cash.id,
      }),
    ).rejects.toThrow('error.monthlyCost.liabilityExpense');
  });

  it('編集でローンかどうか（返済元の有無）は変えられない', async () => {
    const { loanItem } = await makeLoan();
    const broken = { ...loanItem };
    delete broken.repaymentSourceAccountId;
    await expect(upsertMonthlyCost(broken)).rejects.toThrow('error.loan.structure');
  });
});

describe('settleLoan（終了 = 一括返済）', () => {
  it('endDate と一括返済の実仕訳を 1 tx で書く（借方 負債 / 貸方 返済元・印付き）', async () => {
    const { loanItem, liability, cash } = await makeLoan();
    const settleDate = addMonthsToDate(todayLocal(), 2);
    await settleLoan({
      id: loanItem.id,
      endDate: settleDate,
      settlement: { amount: 4999, sourceAccountId: cash.id },
    });
    const ledger = await loadLedger();
    expect(ledger.monthlyCostItems[0]!.endDate).toBe(settleDate);
    const settlement = ledger.journalEntries.find((e) => e.metadata?.loanSettlement === true)!;
    expect(settlement.date).toBe(settleDate);
    expect(settlement.metadata?.loanItemId).toBe(loanItem.id);
    expect(settlement.lines.find((l) => l.side === 'debit')!.accountId).toBe(liability.id);
    expect(settlement.lines.find((l) => l.side === 'credit')!.accountId).toBe(cash.id);
  });

  it('一括返済の合計 > 借入総額（過返済）は拒否し、何も書かない', async () => {
    const { loanItem, cash } = await makeLoan();
    const before = await loadLedger();
    await expect(
      settleLoan({
        id: loanItem.id,
        endDate: addMonthsToDate(todayLocal(), 2),
        settlement: { amount: 10001, sourceAccountId: cash.id },
      }),
    ).rejects.toThrow('error.loan.overSettled');
    const after = await loadLedger();
    expect(after.journalEntries).toHaveLength(before.journalEntries.length);
    expect(after.monthlyCostItems[0]!.endDate).toBe(before.monthlyCostItems[0]!.endDate);
    // 2 回目の一括返済も合算で判定する。
    await settleLoan({
      id: loanItem.id,
      endDate: addMonthsToDate(todayLocal(), 2),
      settlement: { amount: 6000, sourceAccountId: cash.id },
    });
    await expect(
      settleLoan({
        id: loanItem.id,
        endDate: addMonthsToDate(todayLocal(), 2),
        settlement: { amount: 6000, sourceAccountId: cash.id },
      }),
    ).rejects.toThrow('error.loan.overSettled');
  });

  it('一括返済 0（省略）= 単なる短縮。通常 item は settleLoan の対象外', async () => {
    const { loanItem, cash, expense } = await makeLoan();
    const shorter = addMonthsToDate(todayLocal(), 3);
    await settleLoan({ id: loanItem.id, endDate: shorter });
    const ledger = await loadLedger();
    expect(ledger.monthlyCostItems[0]!.endDate).toBe(shorter);
    expect(ledger.journalEntries.some((e) => e.metadata?.loanSettlement === true)).toBe(false);
    // 通常 item は archiveMonthlyCost の世界（settleLoan は拒否）。
    const normal = await createContinuousCost({
      name: '洗濯機',
      amount: 12000,
      startDate: todayLocal(),
      expenseAccountId: expense.id,
      creditAccountId: cash.id,
    });
    await expect(settleLoan({ id: normal.id, endDate: todayLocal() })).rejects.toThrow(
      'error.loan.structure',
    );
  });

  it('借入総額を一括返済の合計より小さく編集できない（編集側の過返済ガード）', async () => {
    const { loanItem, cash } = await makeLoan();
    await settleLoan({
      id: loanItem.id,
      endDate: addMonthsToDate(todayLocal(), 2),
      settlement: { amount: 6000, sourceAccountId: cash.id },
    });
    const ledger = await loadLedger();
    const item = ledger.monthlyCostItems.find((m) => m.id === loanItem.id)!;
    await expect(upsertMonthlyCost({ ...item, amount: 5999 })).rejects.toThrow(
      'error.loan.overSettled',
    );
  });
});

describe('借入の仕訳・ローン item の削除規約', () => {
  it('借入の仕訳は個別に削除できない・ローン削除で cascade する', async () => {
    const { loanItem, purchase, liability } = await makeLoan();
    await expect(deleteEntry(purchase.id)).rejects.toThrow('error.entry.loanLinked');
    await deleteMonthlyCost(loanItem.id);
    const ledger = await loadLedger();
    expect(ledger.monthlyCostItems).toHaveLength(0);
    expect(ledger.journalEntries.some((e) => e.id === purchase.id)).toBe(false);
    // 負債科目は残る（参照ゼロになったので削除可能だが、削除は別操作）。
    expect(ledger.accounts.some((a) => a.id === liability.id)).toBe(true);
  });

  it('一括返済の仕訳は普通の振替として削除できる（残額は全期間へ再按分）', async () => {
    const { loanItem, cash } = await makeLoan();
    await settleLoan({
      id: loanItem.id,
      endDate: addMonthsToDate(todayLocal(), 2),
      settlement: { amount: 4999, sourceAccountId: cash.id },
    });
    const ledger = await loadLedger();
    const settlement = ledger.journalEntries.find((e) => e.metadata?.loanSettlement === true)!;
    await deleteEntry(settlement.id);
    const after = await loadLedger();
    expect(after.journalEntries.some((e) => e.id === settlement.id)).toBe(false);
  });

  it('ローン払いの持ち物（併用）は持ち物側から削除できない・ローン削除で一緒に消える', async () => {
    const { cash, expense } = await seed();
    const { loanItem, item } = await createLoanPurchase({
      loanName: '自動車ローン',
      date: todayLocal(),
      description: '自動車',
      amount: 12000000,
      expenseAccountId: expense.id,
      repaymentSourceAccountId: cash.id,
      repaymentEndDate: addMonthsToDate(todayLocal(), 12),
      continuousCost: { name: '自動車', endDate: addMonthsToDate(todayLocal(), 60) },
    });
    await expect(deleteMonthlyCost(item!.id)).rejects.toThrow('error.monthlyCost.deleteLiability');
    await deleteMonthlyCost(loanItem.id);
    const ledger = await loadLedger();
    expect(ledger.monthlyCostItems).toHaveLength(0);
    expect(ledger.journalEntries.some((e) => e.metadata?.loanItemId !== undefined)).toBe(false);
  });
});
