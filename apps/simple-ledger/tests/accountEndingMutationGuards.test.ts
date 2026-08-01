/*
 * 終了済みの資産・負債は、終了日の残高が常に 0 でなければならない。
 *
 * 終了操作そのものだけでなく、その後に過去の仕訳・補正・継続コストを変更する
 * 保存経路も同じ不変条件を守ることを固定する。
 */
import { describe, expect, it } from 'vitest';
import './setup';
import {
  archiveMonthlyCost,
  createAdjustment,
  createContinuousCost,
  createRecurringRule,
  deleteAdjustment,
  deleteEntry,
  deleteMonthlyCost,
  deleteRecurringRule,
  loadLedger,
  upsertAccount,
  upsertEntry,
  upsertMonthlyCost,
  upsertRecurringRule,
} from '../src/data/repository';
import { accountBalance } from '../src/domain/accounting';
import { buildSimpleEntry } from '../src/domain/entry';
import { reportEntriesForAsOf } from '../src/domain/reportEntries';
import type { Account, JournalEntry, MonthlyCostItem, RecurringRule } from '../src/domain/types';

const START_DATE = '2025-01-01';
const END_DATE = '2025-12-31';
const CREATED_AT = '2025-01-01T00:00:00.000Z';

async function accountByName(name: string): Promise<Account> {
  const ledger = await loadLedger();
  const account = ledger.accounts.find((candidate) => candidate.name === name);
  if (!account) throw new Error(`seed に ${name} がない`);
  return account;
}

function balanceSheetAccount(
  id: string,
  name: string,
  type: 'asset' | 'liability' = 'asset',
): Account {
  return {
    id,
    name,
    type,
    role: type === 'asset' ? 'daily-asset' : 'other-liability',
    archived: false,
    startDate: START_DATE,
    createdAt: CREATED_AT,
    updatedAt: CREATED_AT,
  };
}

async function endAccountAtZero(accountId: string): Promise<void> {
  const ledger = await loadLedger();
  const account = ledger.accounts.find((candidate) => candidate.id === accountId)!;
  const derived = reportEntriesForAsOf(ledger, END_DATE);
  expect(accountBalance(account.id, account.type, derived)).toBe(0);
  await upsertAccount({
    ...account,
    archived: true,
    endDate: END_DATE,
    updatedAt: '2025-12-31T00:00:00.000Z',
  });
  expect(
    (await loadLedger()).accounts.find((candidate) => candidate.id === accountId),
  ).toMatchObject({
    archived: true,
    endDate: END_DATE,
  });
}

async function seedEndedAssetWithNormalEntries(): Promise<{
  target: Account;
  incoming: JournalEntry;
  outgoing: JournalEntry;
}> {
  const target = balanceSheetAccount('ended-normal-asset', '終了済み通常資産');
  await upsertAccount(target);
  const income = await accountByName('給与');
  const expense = await accountByName('変動費');
  const incoming = buildSimpleEntry({
    date: '2025-01-10',
    description: '終了前の入金',
    debitAccountId: target.id,
    creditAccountId: income.id,
    amount: 100,
  });
  const outgoing = buildSimpleEntry({
    date: '2025-06-30',
    description: '終了前の出金',
    debitAccountId: expense.id,
    creditAccountId: target.id,
    amount: 100,
  });
  await upsertEntry(incoming);
  await upsertEntry(outgoing);
  await endAccountAtZero(target.id);
  return { target, incoming, outgoing };
}

async function seedEndedLiability(): Promise<{
  liability: Account;
  repayment: JournalEntry;
}> {
  const liability = balanceSheetAccount('ended-normal-liability', '終了済み通常負債', 'liability');
  await upsertAccount(liability);
  const expense = await accountByName('変動費');
  const bank = await accountByName('預金');
  await upsertEntry(
    buildSimpleEntry({
      date: '2025-02-01',
      description: '終了前の借入',
      debitAccountId: expense.id,
      creditAccountId: liability.id,
      amount: 100,
    }),
  );
  const repayment = buildSimpleEntry({
    date: '2025-06-30',
    description: '終了前の返済',
    debitAccountId: liability.id,
    creditAccountId: bank.id,
    amount: 100,
  });
  await upsertEntry(repayment);
  await endAccountAtZero(liability.id);
  return { liability, repayment };
}

async function seedEndedAssetBackedByAdjustment(): Promise<{
  target: Account;
  adjustment: JournalEntry;
}> {
  const target = balanceSheetAccount('ended-adjusted-asset', '補正で閉じた資産');
  await upsertAccount(target);
  const income = await accountByName('給与');
  await upsertEntry(
    buildSimpleEntry({
      date: '2025-01-10',
      description: '補正前残高',
      debitAccountId: target.id,
      creditAccountId: income.id,
      amount: 100,
    }),
  );
  const adjustment = await createAdjustment({
    accountId: target.id,
    date: '2025-06-30',
    actualBalance: 0,
  });
  expect(adjustment).not.toBeNull();
  await endAccountAtZero(target.id);
  return { target, adjustment: adjustment! };
}

async function seedEndedAssetBackedByContinuousCost(options?: {
  recoveryAmount?: number;
}): Promise<{
  target: Account;
  item: MonthlyCostItem;
  recovery?: JournalEntry;
}> {
  const target = balanceSheetAccount('ended-continuous-cost-asset', '月割りで閉じた資産');
  await upsertAccount(target);
  const bank = await accountByName('預金');
  const item = await createContinuousCost({
    name: '終了済み科目を使う継続コスト',
    amount: 600,
    startDate: '2025-01-01',
    endDate: '2025-06-30',
    expenseAccountId: target.id,
    creditAccountId: bank.id,
  });

  let recovery: JournalEntry | undefined;
  if (options?.recoveryAmount !== undefined) {
    await archiveMonthlyCost({
      id: item.id,
      endDate: '2025-06-30',
      recovery: {
        destinationAccountId: bank.id,
        amount: options.recoveryAmount,
      },
    });
    recovery = (await loadLedger()).journalEntries.find(
      (entry) =>
        entry.metadata?.monthlyCostId === item.id && entry.metadata.monthlyCostRecovery === true,
    );
  }

  const recognizedAmount = item.amount - (options?.recoveryAmount ?? 0);
  await upsertEntry(
    buildSimpleEntry({
      date: '2025-06-30',
      description: '月割り残高の消し込み',
      debitAccountId: bank.id,
      creditAccountId: target.id,
      amount: recognizedAmount,
    }),
  );
  await endAccountAtZero(target.id);
  return { target, item, ...(recovery ? { recovery } : {}) };
}

async function seedEndedAssetBalancedByRecurringRule(): Promise<{
  target: Account;
  rule: RecurringRule;
}> {
  const target = balanceSheetAccount('ended-recurring-asset', '定期ルールで閉じた資産');
  await upsertAccount(target);
  const income = await accountByName('給与');
  const bank = await accountByName('預金');
  await upsertEntry(
    buildSimpleEntry({
      date: '2025-01-10',
      description: '定期振替前残高',
      debitAccountId: target.id,
      creditAccountId: income.id,
      amount: 100,
    }),
  );
  const rule = await createRecurringRule({
    name: '終了前の残高消し込み',
    amount: 100,
    dayOfMonth: 1,
    debitAccountId: bank.id,
    creditAccountId: target.id,
    startMonth: '2025-12',
    startDate: '2025-12-01',
    endDate: '2025-12-02',
  });
  await endAccountAtZero(target.id);
  return { target, rule };
}

describe('終了済み資産・負債と通常仕訳', () => {
  it('終了済み資産の残高を発生させる通常仕訳の追加を拒否する', async () => {
    const { target } = await seedEndedAssetWithNormalEntries();
    const expense = await accountByName('固定費');
    const added = buildSimpleEntry({
      date: '2025-09-01',
      description: '終了残高を壊す追加',
      debitAccountId: target.id,
      creditAccountId: expense.id,
      amount: 1,
    });

    await expect(upsertEntry(added)).rejects.toMatchObject({
      code: 'error.account.archiveBalance',
    });
    expect((await loadLedger()).journalEntries.some((entry) => entry.id === added.id)).toBe(false);
  });

  it('終了済み資産の残高を変える通常仕訳の編集を拒否する', async () => {
    const { outgoing } = await seedEndedAssetWithNormalEntries();
    const changed = {
      ...outgoing,
      lines: outgoing.lines.map((line) => ({ ...line, amount: 99 })),
    };

    await expect(upsertEntry(changed)).rejects.toMatchObject({
      code: 'error.account.archiveBalance',
    });
    expect(
      (await loadLedger()).journalEntries
        .find((entry) => entry.id === outgoing.id)
        ?.lines.every((line) => line.amount === 100),
    ).toBe(true);
  });

  it('終了済み資産を 0 にした通常仕訳の削除を拒否する', async () => {
    const { outgoing } = await seedEndedAssetWithNormalEntries();

    await expect(deleteEntry(outgoing.id)).rejects.toMatchObject({
      code: 'error.account.archiveBalance',
    });
    expect((await loadLedger()).journalEntries.some((entry) => entry.id === outgoing.id)).toBe(
      true,
    );
  });

  it('終了済み負債を 0 にした通常仕訳の削除も拒否する', async () => {
    const { repayment } = await seedEndedLiability();

    await expect(deleteEntry(repayment.id)).rejects.toMatchObject({
      code: 'error.account.archiveBalance',
    });
    expect((await loadLedger()).journalEntries.some((entry) => entry.id === repayment.id)).toBe(
      true,
    );
  });
});

describe('終了済み資産と残高補正', () => {
  it('終了済み資産を 0 にした補正の削除を拒否する', async () => {
    const { adjustment } = await seedEndedAssetBackedByAdjustment();

    await expect(deleteAdjustment(adjustment.id)).rejects.toMatchObject({
      code: 'error.account.archiveBalance',
    });
    expect((await loadLedger()).journalEntries.some((entry) => entry.id === adjustment.id)).toBe(
      true,
    );
  });
});

describe('終了済み資産と継続コストの後続操作', () => {
  it('月割り額を変えて終了残高を壊す item の金額変更を拒否する', async () => {
    const { item } = await seedEndedAssetBackedByContinuousCost();

    await expect(upsertMonthlyCost({ ...item, amount: 1_200 })).rejects.toMatchObject({
      code: 'error.account.archiveBalance',
    });
    expect(
      (await loadLedger()).monthlyCostItems.find((candidate) => candidate.id === item.id)?.amount,
    ).toBe(600);
  });

  it('月割りを外して終了残高を壊す item の行き先変更を拒否する', async () => {
    const { item } = await seedEndedAssetBackedByContinuousCost();
    const otherDestination = await accountByName('変動費');

    await expect(
      upsertMonthlyCost({ ...item, expenseAccountId: otherDestination.id }),
    ).rejects.toMatchObject({
      code: 'error.account.archiveBalance',
    });
    expect(
      (await loadLedger()).monthlyCostItems.find((candidate) => candidate.id === item.id)
        ?.expenseAccountId,
    ).toBe(item.expenseAccountId);
  });

  it('月割り額を遡及変更して終了残高を壊す回収の追加を拒否する', async () => {
    const { item } = await seedEndedAssetBackedByContinuousCost();
    const bank = await accountByName('預金');

    await expect(
      archiveMonthlyCost({
        id: item.id,
        endDate: '2025-06-30',
        recovery: { destinationAccountId: bank.id, amount: 100 },
      }),
    ).rejects.toMatchObject({
      code: 'error.account.archiveBalance',
    });
    expect(
      (await loadLedger()).journalEntries.some(
        (entry) =>
          entry.metadata?.monthlyCostId === item.id && entry.metadata.monthlyCostRecovery === true,
      ),
    ).toBe(false);
  });

  it('月割り額を遡及変更して終了残高を壊す回収の編集を拒否する', async () => {
    const { recovery } = await seedEndedAssetBackedByContinuousCost({ recoveryAmount: 100 });
    const changed = {
      ...recovery!,
      lines: recovery!.lines.map((line) => ({ ...line, amount: 120 })),
    };

    await expect(upsertEntry(changed)).rejects.toMatchObject({
      code: 'error.account.archiveBalance',
    });
    expect(
      (await loadLedger()).journalEntries
        .find((entry) => entry.id === recovery!.id)
        ?.lines.every((line) => line.amount === 100),
    ).toBe(true);
  });

  it('月割り額を遡及変更して終了残高を壊す回収の削除を拒否する', async () => {
    const { recovery } = await seedEndedAssetBackedByContinuousCost({ recoveryAmount: 100 });

    await expect(deleteEntry(recovery!.id)).rejects.toMatchObject({
      code: 'error.account.archiveBalance',
    });
    expect((await loadLedger()).journalEntries.some((entry) => entry.id === recovery!.id)).toBe(
      true,
    );
  });

  it('月割り行を消して終了残高を壊す item の削除を拒否する', async () => {
    const { item } = await seedEndedAssetBackedByContinuousCost();

    await expect(deleteMonthlyCost(item.id)).rejects.toMatchObject({
      code: 'error.account.archiveBalance',
    });
    expect(
      (await loadLedger()).monthlyCostItems.some((candidate) => candidate.id === item.id),
    ).toBe(true);
  });
});

describe('終了済み資産と定期ルールの後続操作', () => {
  it('終了点残高を発生させる定期ルールの新規作成を拒否する', async () => {
    const target = balanceSheetAccount('ended-before-rule-asset', '終了後にルールを追加する資産');
    await upsertAccount(target);
    await endAccountAtZero(target.id);
    const bank = await accountByName('預金');

    await expect(
      createRecurringRule({
        name: '終了残高を壊す追加ルール',
        amount: 100,
        dayOfMonth: 1,
        debitAccountId: target.id,
        creditAccountId: bank.id,
        startMonth: '2025-12',
        startDate: '2025-12-01',
        endDate: '2025-12-02',
      }),
    ).rejects.toMatchObject({ code: 'error.account.archiveBalance' });
    expect((await loadLedger()).recurringRules).toHaveLength(0);
  });

  it('終了点残高を0にする定期ルールの期間変更を拒否する', async () => {
    const { rule } = await seedEndedAssetBalancedByRecurringRule();

    await expect(
      upsertRecurringRule({ ...rule, startDate: '2025-12-02', endDate: '2025-12-03' }),
    ).rejects.toMatchObject({
      code: 'error.account.archiveBalance',
    });
    expect(
      (await loadLedger()).recurringRules.find((candidate) => candidate.id === rule.id)?.startDate,
    ).toBe('2025-12-01');
  });

  it('終了点残高を0にする定期ルールの削除を拒否する', async () => {
    const { rule } = await seedEndedAssetBalancedByRecurringRule();

    await expect(deleteRecurringRule(rule.id)).rejects.toMatchObject({
      code: 'error.account.archiveBalance',
    });
    expect((await loadLedger()).recurringRules.some((candidate) => candidate.id === rule.id)).toBe(
      true,
    );
  });
});
