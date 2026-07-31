/*
 * 持ち込み登録（既に持っているものの登録）: createContinuousCost（creditAccountId 未指定）。
 *  - 購入の仕訳が保存される: `借方 継続コスト台帳 / 貸方 初期残高(equity)`・kind='opening'・
 *    日付 = startDate・metadata.monthlyCostId。収入(PL)を通らない。
 *  - 過去日でも制約なく登録できる（作者決定: 過去も変わるのが価値）。
 *  - export → schema 検証の round-trip が通る（不変条件⑥⑦を満たす形で保存される）。
 */
import { describe, expect, it } from 'vitest';
import './setup';
import { createContinuousCost, loadLedger, upsertMonthlyCost } from '../src/data/repository';
import { CONTINUOUS_COST_LEDGER_ACCOUNT_ID } from '../src/domain/constants';
import { reportEntriesForAsOf } from '../src/domain/reportEntries';
import { deriveBalanceSheet, deriveProfitAndLoss } from '../src/domain/accounting';
import { buildExportPackage } from '../src/data/exportImport';
import { ledgerExportPackageSchema } from '../src/domain/schema';
import { LedgerError } from '../src/domain/errors';

async function expenseAccountId(): Promise<string> {
  const ledger = await loadLedger();
  const expense = ledger.accounts.find((a) => a.role === 'expense-category');
  if (!expense) throw new Error('seed に費用カテゴリがない');
  return expense.id;
}

describe('createContinuousCost（持ち込み = 初期残高払い）', () => {
  it('購入の仕訳が保存され、貸方が初期残高になり PL 収入を通らない', async () => {
    const expenseId = await expenseAccountId();
    const item = await createContinuousCost({
      name: '移行PC',
      amount: 12000,
      startDate: '2026-01-01',
      endDate: '2026-12-31',
      expenseAccountId: expenseId,
    });
    expect(item.startDate).toBe('2026-01-01');

    const ledger = await loadLedger();
    const equity = ledger.accounts.find((a) => a.role === 'equity');
    expect(equity).toBeDefined();

    // 購入の仕訳（保存される仕訳): 借方 台帳 / 貸方 初期残高・kind='opening'。
    const purchase = ledger.journalEntries.find(
      (e) => e.metadata?.monthlyCostId === item.id && e.metadata.monthlyCostRecovery !== true,
    );
    expect(purchase).toBeDefined();
    expect(purchase!.kind).toBe('opening');
    expect(purchase!.date).toBe(item.startDate);
    expect(purchase!.lines).toEqual([
      { accountId: CONTINUOUS_COST_LEDGER_ACCOUNT_ID, side: 'debit', amount: 12000 },
      { accountId: equity!.id, side: 'credit', amount: 12000 },
    ]);

    // BS: 6月末断面 → 台帳 = 12000 − 認識6ヶ月ぶん 6000。equity = 12000。
    const derived = reportEntriesForAsOf(ledger, '2026-06-30');
    const bs = deriveBalanceSheet(ledger.accounts, derived, '2026-06-30');
    const ccLedger = bs.assets.find((a) => a.account.id === CONTINUOUS_COST_LEDGER_ACCOUNT_ID);
    expect(ccLedger?.balance).toBe(6000);
    expect(bs.equity.find((a) => a.account.id === equity!.id)?.balance).toBe(12000);

    // PL: 収入 0・1月の費用 1000（初期残高は収入にならない）。
    const pl = deriveProfitAndLoss(ledger.accounts, derived, {
      from: '2026-01-01',
      to: '2026-01-31',
    });
    expect(pl.totalRevenue).toBe(0);
    expect(pl.totalExpense).toBe(1000);
  });

  it('過去日・終了日なしで登録できる（制約なし・費用は 1 円も出ない）', async () => {
    const expenseId = await expenseAccountId();
    const item = await createContinuousCost({
      name: '2023年の洗濯機',
      amount: 240000,
      startDate: '2023-03-10',
      expenseAccountId: expenseId,
    });
    expect(item.endDate).toBeUndefined();
    const ledger = await loadLedger();
    const derived = reportEntriesForAsOf(ledger, '2026-07-30');
    expect(derived.filter((e) => e.metadata?.continuousCostId === item.id)).toHaveLength(0);
    const bs = deriveBalanceSheet(ledger.accounts, derived, '2026-07-30');
    expect(bs.assets.find((a) => a.account.id === CONTINUOUS_COST_LEDGER_ACCOUNT_ID)?.balance).toBe(
      240000,
    );
  });

  it('export → schema 検証が通る（equity 貸方・不変条件⑥⑦を満たす）', async () => {
    const expenseId = await expenseAccountId();
    await createContinuousCost({
      name: '移行保険',
      amount: 6000,
      startDate: '2026-01-01',
      endDate: '2026-06-30',
      expenseAccountId: expenseId,
    });
    const pkg = buildExportPackage(await loadLedger());
    const parsed = ledgerExportPackageSchema.safeParse(pkg);
    expect(parsed.success).toBe(true);
  });

  it('検証: 金額・開始日・終了日<開始日・存在しない費用カテゴリを fail-closed に弾く', async () => {
    const expenseId = await expenseAccountId();
    const base = {
      name: 'x',
      amount: 1000,
      startDate: '2026-01-15',
      expenseAccountId: expenseId,
    };
    await expect(createContinuousCost({ ...base, amount: 0 })).rejects.toThrow(LedgerError);
    await expect(createContinuousCost({ ...base, startDate: '2026/01/15' })).rejects.toThrow(
      LedgerError,
    );
    await expect(createContinuousCost({ ...base, endDate: '2026-01-14' })).rejects.toMatchObject({
      code: 'error.monthlyCost.endBeforeStart',
    });
    await expect(
      createContinuousCost({ ...base, expenseAccountId: 'no-such-account' }),
    ).rejects.toMatchObject({ code: 'error.monthlyCost.expenseCategory' });
    expect((await loadLedger()).monthlyCostItems).toHaveLength(0);
  });

  it('開始日は upsertMonthlyCost では変わらない（購入の仕訳の日付のミラー）', async () => {
    const expenseId = await expenseAccountId();
    const item = await createContinuousCost({
      name: '据え置き',
      amount: 1200,
      startDate: '2026-01-01',
      endDate: '2026-12-31',
      expenseAccountId: expenseId,
    });
    await upsertMonthlyCost({ ...item, startDate: '2025-01-01' });
    const ledger = await loadLedger();
    expect(ledger.monthlyCostItems.find((m) => m.id === item.id)?.startDate).toBe('2026-01-01');
  });
});
