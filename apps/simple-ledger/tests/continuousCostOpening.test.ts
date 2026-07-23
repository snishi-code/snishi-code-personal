/*
 * 継続コストの移行登録（初期残高）: createContinuousCostFromOpening。
 *  - funding 仮想仕訳の貸方が 開始残高(equity) になり、収入(PL)を通らない。
 *  - 残っている価値は継続コスト台帳(資産)へ、認識は費用カテゴリへ月次で流れる。
 *  - export → schema 検証の round-trip が通る（equity 支払い元を拒否しない）。
 */
import { describe, expect, it } from 'vitest';
import './setup';
import {
  createContinuousCostFromOpening,
  loadLedger,
} from '../src/data/repository';
import { CONTINUOUS_COST_LEDGER_ACCOUNT_ID } from '../src/domain/constants';
import { deriveBalanceSheet, deriveProfitAndLoss } from '../src/domain/accounting';
import { buildExportPackage } from '../src/data/exportImport';
import { ledgerExportPackageSchema } from '../src/domain/schema';
import { LedgerError } from '../src/domain/errors';
import { currentYearMonth, todayLocal } from '../src/util/time';

function thisMonth(): string {
  const { year, month } = currentYearMonth();
  return `${year}-${String(month).padStart(2, '0')}`;
}

async function expenseAccountId(): Promise<string> {
  const ledger = await loadLedger();
  const expense = ledger.accounts.find((a) => a.role === 'expense-category');
  if (!expense) throw new Error('seed に費用カテゴリがない');
  return expense.id;
}

describe('createContinuousCostFromOpening（移行登録=開始残高）', () => {
  it('funding の貸方が開始残高になり、資産・純資産へ計上され PL 収入を通らない', async () => {
    const expenseId = await expenseAccountId();
    const item = await createContinuousCostFromOpening({
      name: '移行PC',
      amount: 12000,
      costMonths: 12,
      startMonth: thisMonth(),
      expenseAccountId: expenseId,
    });

    const ledger = await loadLedger();
    const equity = ledger.accounts.find((a) => a.role === 'equity');
    expect(equity).toBeDefined();
    expect(item.paymentSourceAccountId).toBe(equity!.id);
    expect(item.recognitionCreditAccountId).toBe(CONTINUOUS_COST_LEDGER_ACCOUNT_ID);
    expect(item.repeatEveryMonths).toBeUndefined();

    // 仮想 funding: 借方 台帳 / 貸方 開始残高（実仕訳は作らない）。
    expect(ledger.journalEntries.length).toBe(0);
    const funding = ledger.derivedEntries.find(
      (e) => e.metadata?.ccKind === 'funding' && e.metadata.continuousCostId === item.id,
    );
    expect(funding).toBeDefined();
    expect(funding!.lines).toEqual([
      { accountId: CONTINUOUS_COST_LEDGER_ACCOUNT_ID, side: 'debit', amount: 12000 },
      { accountId: equity!.id, side: 'credit', amount: 12000 },
    ]);

    // BS: 台帳残高 = 12000 − 当月認識 1000。純資産側は開始残高 12000。
    const today = todayLocal();
    const bs = deriveBalanceSheet(ledger.accounts, ledger.derivedEntries, today);
    const ccLedger = bs.assets.find((a) => a.account.id === CONTINUOUS_COST_LEDGER_ACCOUNT_ID);
    expect(ccLedger?.balance).toBe(11000);
    const eqBal = bs.equity.find((a) => a.account.id === equity!.id);
    expect(eqBal?.balance).toBe(12000);

    // PL: 収入 0・当月費用 1000（開始残高は収入にならない）。
    const ym = thisMonth();
    const pl = deriveProfitAndLoss(ledger.accounts, ledger.derivedEntries, {
      from: `${ym}-01`,
      to: `${ym}-31`,
    });
    expect(pl.totalRevenue).toBe(0);
    expect(pl.totalExpense).toBe(1000);
  });

  it('export → schema 検証が通る（equity 支払い元を拒否しない）', async () => {
    const expenseId = await expenseAccountId();
    await createContinuousCostFromOpening({
      name: '移行保険',
      amount: 6000,
      costMonths: 6,
      startMonth: thisMonth(),
      expenseAccountId: expenseId,
    });
    const pkg = buildExportPackage(await loadLedger());
    const parsed = ledgerExportPackageSchema.safeParse(pkg);
    expect(parsed.success).toBe(true);
  });

  it('移行登録（開始残高 funding）の項目に継続購入は設定できない', async () => {
    const expenseId = await expenseAccountId();
    const item = await createContinuousCostFromOpening({
      name: 'Netflix誤登録',
      amount: 1490,
      costMonths: 1,
      startMonth: thisMonth(),
      expenseAccountId: expenseId,
    });
    const { upsertMonthlyCost } = await import('../src/data/repository');
    await expect(
      upsertMonthlyCost({ ...item, repeatEveryMonths: 1, updatedAt: item.updatedAt }),
    ).rejects.toThrow(LedgerError);
  });

  it('検証: 金額・月数・開始月・費用カテゴリを fail-closed に弾く', async () => {
    const expenseId = await expenseAccountId();
    const base = {
      name: 'x',
      amount: 1000,
      costMonths: 10,
      startMonth: thisMonth(),
      expenseAccountId: expenseId,
    };
    await expect(createContinuousCostFromOpening({ ...base, amount: 0 })).rejects.toThrow(
      LedgerError,
    );
    await expect(createContinuousCostFromOpening({ ...base, costMonths: 0 })).rejects.toThrow(
      LedgerError,
    );
    await expect(createContinuousCostFromOpening({ ...base, startMonth: '2026/07' })).rejects.toThrow(
      LedgerError,
    );
    const ledger = await loadLedger();
    const cash = ledger.accounts.find((a) => a.role === 'daily-asset');
    await expect(
      createContinuousCostFromOpening({ ...base, expenseAccountId: cash!.id }),
    ).rejects.toThrow(LedgerError);
  });
});
