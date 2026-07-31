/*
 * カード・ローンの返済設定（Account.repaymentAccountId / repaymentDay）と返済予定。
 *  - 負債科目にのみ設定でき、返済口座は存在する日常資産。
 *  - 返済口座の削除で設定ポインタが剥がれる（fail-soft）。
 *  - 返済予定（outflow・counter=負債）の実績化は 借方 負債 / 貸方 返済口座。
 *  - nextRepaymentDate は「毎月 day 日」を月末クランプで返す。
 */
import { describe, expect, it } from 'vitest';
import './setup';
import {
  deleteAccount,
  loadLedger,
  postSchedule,
  upsertAccount,
  upsertSchedule,
} from '../src/data/repository';
import { nextRepaymentDate } from '../src/domain/cashflow';
import { ledgerExportPackageSchema } from '../src/domain/schema';
import { buildExportPackage } from '../src/data/exportImport';
import { LedgerError } from '../src/domain/errors';
import { newId } from '../src/domain/ids';
import { nowIso } from '../src/util/time';
import type { Account, CashflowSchedule } from '../src/domain/types';

async function accountByRole(role: string): Promise<Account> {
  const ledger = await loadLedger();
  const a = ledger.accounts.find((x) => x.role === role);
  if (!a) throw new Error(`seed に role=${role} がない`);
  return a;
}

describe('返済設定（勘定科目）', () => {
  it('負債科目へ返済口座・返済日を保存し、再読込後も残る', async () => {
    const card = await accountByRole('payment-liability');
    const bank = await accountByRole('daily-asset');
    await upsertAccount({
      ...card,
      repaymentAccountId: bank.id,
      repaymentDay: 27,
      updatedAt: nowIso(),
    });
    const saved = (await loadLedger()).accounts.find((a) => a.id === card.id);
    expect(saved?.repaymentAccountId).toBe(bank.id);
    expect(saved?.repaymentDay).toBe(27);

    // export → schema 検証も通る。
    const parsed = ledgerExportPackageSchema.safeParse(buildExportPackage(await loadLedger()));
    expect(parsed.success).toBe(true);
  });

  it('負債以外への設定・不正な返済口座/返済日は fail-closed に弾く', async () => {
    const cash = await accountByRole('daily-asset');
    const card = await accountByRole('payment-liability');
    const expense = (await loadLedger()).accounts.find((a) => a.role === 'expense-category');
    await expect(upsertAccount({ ...cash, repaymentDay: 27, updatedAt: nowIso() })).rejects.toThrow(
      LedgerError,
    );
    await expect(
      upsertAccount({ ...card, repaymentAccountId: expense!.id, updatedAt: nowIso() }),
    ).rejects.toThrow(LedgerError);
    await expect(upsertAccount({ ...card, repaymentDay: 0, updatedAt: nowIso() })).rejects.toThrow(
      LedgerError,
    );
    await expect(upsertAccount({ ...card, repaymentDay: 32, updatedAt: nowIso() })).rejects.toThrow(
      LedgerError,
    );
  });

  it('返済口座を削除すると、負債側の設定ポインタが剥がれる', async () => {
    const card = await accountByRole('payment-liability');
    const ts = nowIso();
    const subBank: Account = {
      id: newId(),
      name: 'サブ銀行',
      type: 'asset',
      role: 'daily-asset',
      archived: false,
      createdAt: ts,
      updatedAt: ts,
    };
    await upsertAccount(subBank);
    await upsertAccount({ ...card, repaymentAccountId: subBank.id, updatedAt: nowIso() });
    await deleteAccount(subBank.id);
    const saved = (await loadLedger()).accounts.find((a) => a.id === card.id);
    expect(saved?.repaymentAccountId).toBeUndefined();
  });
});

describe('返済予定の実績化', () => {
  it('outflow（返済口座 → 負債）の実績化は 借方 負債 / 貸方 返済口座', async () => {
    const card = await accountByRole('payment-liability');
    const bank = await accountByRole('daily-asset');
    const ts = nowIso();
    const schedule: CashflowSchedule = {
      id: newId(),
      title: `${card.name}の返済`,
      dueDate: '2026-08-27',
      amount: 45000,
      direction: 'outflow',
      accountId: bank.id,
      counterAccountId: card.id,
      source: 'credit-card',
      status: 'planned',
      createdAt: ts,
      updatedAt: ts,
    };
    await upsertSchedule(schedule);
    const entry = await postSchedule(schedule.id);
    expect(entry.lines).toEqual([
      { accountId: card.id, side: 'debit', amount: 45000 },
      { accountId: bank.id, side: 'credit', amount: 45000 },
    ]);
    const saved = (await loadLedger()).cashflowSchedules.find((s) => s.id === schedule.id);
    expect(saved?.status).toBe('posted');
    expect(saved?.linkedEntryId).toBe(entry.id);
  });
});

describe('nextRepaymentDate', () => {
  it('当月にまだ来ていなければ当月、過ぎていれば翌月', () => {
    expect(nextRepaymentDate('2026-07-10', 27)).toBe('2026-07-27');
    expect(nextRepaymentDate('2026-07-27', 27)).toBe('2026-08-27');
    expect(nextRepaymentDate('2026-07-28', 27)).toBe('2026-08-27');
  });

  it('31 など月に無い日は月末へ丸める', () => {
    expect(nextRepaymentDate('2026-02-10', 31)).toBe('2026-02-28');
    expect(nextRepaymentDate('2026-04-05', 31)).toBe('2026-04-30');
    expect(nextRepaymentDate('2024-02-10', 30)).toBe('2024-02-29');
  });
});
