/*
 * 投影（想定利回り）と終了点残高 0 の不変条件（v13.8 監査 F/G）:
 *  - F: 終了済み投資科目の投影条件（想定利回り・計上先）を変えると導出益が変わる。
 *    保存境界は post-state で終了点残高を再検証し、0 でなくなる変更を拒否する。
 *  - G: 投影計上先（soft reference）の削除・終了は参照元の導出益を消す。
 *    その益込みで 0 だった終了済み投資科目が壊れるなら、削除・終了を拒否する。
 */
import { describe, expect, it } from 'vitest';
import {
  archiveAccount,
  createOpening,
  deleteAccount,
  loadLedger,
  upsertAccount,
  upsertEntry,
} from '../src/data/repository';
import { accountBalance, filterByDateRange } from '../src/domain/accounting';
import { reportEntriesForAsOf } from '../src/domain/reportEntries';
import type { Account } from '../src/domain/types';
import './setup';

/**
 * 「終了点残高 0（導出益込み）」の終了済み投資科目を作る。
 *  1. 投資科目に利回り + 計上先（給与）を設定し、初期残高を入れる
 *  2. endDate 時点の導出込み残高をそのまま endDate 当日に預金へ振り替える
 *     （endDate は月次刻み日とずらしてあるので、この振替が過去の複利へ影響しない）
 *  3. archived + endDate で保存（残高 0 なので通る）
 */
async function seedEndedInvestment(endDate: string): Promise<{
  investment: Account;
  income: Account;
}> {
  const ledger = await loadLedger();
  const investment = ledger.accounts.find((a) => a.name === '投資')!;
  const income = ledger.accounts.find((a) => a.name === '給与')!;
  const bank = ledger.accounts.find((a) => a.name === '預金')!;

  await upsertAccount({
    ...investment,
    annualReturnBp: 12000,
    projectionAccountId: income.id,
    updatedAt: '2026-01-01T00:00:00.000Z',
  });
  await createOpening({ accountId: investment.id, amount: 10000000, date: '2026-01-01' });

  const withGains = reportEntriesForAsOf(await loadLedger(), endDate);
  const balance = accountBalance(
    investment.id,
    'asset',
    filterByDateRange(withGains, undefined, endDate),
  );
  expect(balance).toBeGreaterThan(10000000); // 導出益が乗っている前提の確認。

  await upsertEntry({
    id: 'close-investment',
    date: endDate,
    description: '投資の払い出し',
    kind: 'normal',
    lines: [
      { accountId: bank.id, side: 'debit', amount: balance },
      { accountId: investment.id, side: 'credit', amount: balance },
    ],
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  });
  const archived: Account = {
    ...(await loadLedger()).accounts.find((a) => a.id === investment.id)!,
    archived: true,
    endDate,
  };
  await upsertAccount(archived);
  const saved = (await loadLedger()).accounts.find((a) => a.id === investment.id)!;
  expect(saved.archived).toBe(true);
  return { investment: saved, income };
}

describe('F: 終了済み投資科目の投影条件変更は post-state で残高を再検証する', () => {
  it('アーカイブ後に想定利回りだけ変えると導出益が変わるため拒否する', async () => {
    const { investment, income } = await seedEndedInvestment('2026-06-15');
    await expect(
      upsertAccount({ ...investment, annualReturnBp: 24000, projectionAccountId: income.id }),
    ).rejects.toThrow('error.account.archiveBalance');
    // 利回り設定の解除（セットで外す）も導出益ごと消えるので拒否する。
    const cleared = { ...investment };
    delete cleared.annualReturnBp;
    delete cleared.projectionAccountId;
    await expect(upsertAccount(cleared)).rejects.toThrow('error.account.archiveBalance');
  });

  it('投影条件を変えない編集（改名）は通る', async () => {
    const { investment } = await seedEndedInvestment('2026-06-15');
    await upsertAccount({ ...investment, name: '投資（終了）' });
    expect((await loadLedger()).accounts.find((a) => a.id === investment.id)?.name).toBe(
      '投資（終了）',
    );
  });
});

describe('G: 投影計上先の削除・終了は終了済み投資科目へ逆伝播させない', () => {
  it('計上先の削除は、依存する終了済み投資科目の残高が壊れるため拒否する', async () => {
    const { income } = await seedEndedInvestment('2026-06-15');
    await expect(deleteAccount(income.id)).rejects.toThrow('error.account.projectionDependents');
    expect((await loadLedger()).accounts.some((a) => a.id === income.id)).toBe(true);
  });

  it('未来の終了点を持つ投資科目があるとき、計上先の終了（今日）も拒否する', async () => {
    // endDate が未来 = 今日で計上先を終了すると、今日より後の投影行が消えて残高が壊れる。
    const { income } = await seedEndedInvestment('2027-02-15');
    await expect(archiveAccount(income.id)).rejects.toThrow('error.account.projectionDependents');
    expect((await loadLedger()).accounts.find((a) => a.id === income.id)?.archived).toBe(false);
  });

  it('過去に終了済みの投資科目だけなら、計上先の終了（今日）は通る', async () => {
    // 投影行はすべて今日以前 = 計上先は今日まで存在し続けるので導出益は変わらない。
    const { income } = await seedEndedInvestment('2026-06-15');
    await archiveAccount(income.id);
    expect((await loadLedger()).accounts.find((a) => a.id === income.id)?.archived).toBe(true);
  });
});
