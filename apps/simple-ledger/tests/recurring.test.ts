/*
 * 定期ルール（毎月の支出・収入・振替 = 実仕訳の自動起票）。
 *  - キャッチアップ起票: 経過月ぶんを実仕訳として起票・idempotent・月末クランプ。
 *  - カーソル: 起票済み仕訳を削除しても再起票しない（スキップの尊重）。
 *  - 停止/再開: 停止中は起票しない。再開（startMonth 更新）で過去を遡らない。
 *  - 削除: ルールを消しても起票済み仕訳は通常仕訳として残る（メタデータを剥がす）。
 *  - export → schema round-trip / 必須キー欠落の拒否。
 */
import { describe, expect, it } from 'vitest';
import './setup';
import {
  catchUpRecurringRules,
  createRecurringRule,
  createReserve,
  deleteEntry,
  deleteRecurringRule,
  loadLedger,
  upsertRecurringRule,
} from '../src/data/repository';
import {
  clampDayToMonth,
  recurringPostingsDue,
  recurringProjectionEntries,
} from '../src/domain/recurring';
import { deriveBalanceSheet, deriveProfitAndLoss } from '../src/domain/accounting';
import { reportEntriesForAsOf } from '../src/domain/reportEntries';
import { reportBasis } from '../src/domain/reportPeriod';
import { RESERVE_LEDGER_ACCOUNT_ID } from '../src/domain/constants';
import { buildExportPackage } from '../src/data/exportImport';
import { ledgerExportPackageSchema } from '../src/domain/schema';
import { LedgerError } from '../src/domain/errors';
import type { Account } from '../src/domain/types';

async function accountByName(name: string): Promise<Account> {
  const ledger = await loadLedger();
  const a = ledger.accounts.find((x) => x.name === name);
  if (!a) throw new Error(`seed に ${name} がない`);
  return a;
}

describe('定期ルールのキャッチアップ起票', () => {
  it('経過月ぶんの実仕訳を起票し、2 回目は起票しない（idempotent）', async () => {
    const bank = await accountByName('預金');
    const invest = await accountByName('投資');
    await createRecurringRule({
      name: 'NISA積立',
      amount: 33333,
      dayOfMonth: 1,
      debitAccountId: invest.id,
      creditAccountId: bank.id,
      startMonth: '2026-05', // 過去開始 → 5,6,7 月ぶんが起票される（今日 = 2026-07-23）
    });

    const first = await catchUpRecurringRules('2026-07-23');
    expect(first).toBe(3);
    const ledger = await loadLedger();
    const posted = ledger.journalEntries.filter((e) => e.metadata?.recurringRuleId);
    expect(posted.map((e) => e.date).sort()).toEqual(['2026-05-01', '2026-06-01', '2026-07-01']);
    expect(posted[0]!.lines).toEqual(
      expect.arrayContaining([
        { accountId: invest.id, side: 'debit', amount: 33333 },
        { accountId: bank.id, side: 'credit', amount: 33333 },
      ]),
    );

    expect(await catchUpRecurringRules('2026-07-23')).toBe(0);
  });

  it('並行キャッチアップでも同じ月は 1 仕訳に収束する', async () => {
    const bank = await accountByName('預金');
    const invest = await accountByName('投資');
    const rule = await createRecurringRule({
      name: '並行積立',
      amount: 80000,
      dayOfMonth: 1,
      debitAccountId: invest.id,
      creditAccountId: bank.id,
      startMonth: '2026-05',
    });

    await Promise.all([
      catchUpRecurringRules('2026-07-23'),
      catchUpRecurringRules('2026-07-23'),
    ]);

    const posted = (await loadLedger()).journalEntries.filter(
      (entry) => entry.metadata?.recurringRuleId === rule.id,
    );
    expect(posted).toHaveLength(3);
    expect(posted.map((entry) => entry.id).sort()).toEqual([
      `rec-${rule.id}-2026-05`,
      `rec-${rule.id}-2026-06`,
      `rec-${rule.id}-2026-07`,
    ]);
    expect(
      posted.reduce(
        (sum, entry) =>
          sum + (entry.lines.find((line) => line.side === 'debit')?.amount ?? 0),
        0,
      ),
    ).toBe(240000);
  });

  it('起票日が未到来の当月は起票せず、到来後の実行で起票される', async () => {
    const bank = await accountByName('預金');
    const cardCat = await accountByName('固定費');
    await createRecurringRule({
      name: 'Netflix',
      amount: 1490,
      dayOfMonth: 27,
      debitAccountId: cardCat.id,
      creditAccountId: bank.id,
      startMonth: '2026-07',
    });
    expect(await catchUpRecurringRules('2026-07-23')).toBe(0); // 27 日未到来
    expect(await catchUpRecurringRules('2026-07-27')).toBe(1);
    const ledger = await loadLedger();
    const posted = ledger.journalEntries.filter((e) => e.metadata?.recurringRuleId);
    expect(posted[0]!.date).toBe('2026-07-27');
  });

  it('起票済み仕訳を削除しても再起票しない（カーソルでスキップを尊重）', async () => {
    const bank = await accountByName('預金');
    const invest = await accountByName('投資');
    await createRecurringRule({
      name: '積立',
      amount: 1000,
      dayOfMonth: 1,
      debitAccountId: invest.id,
      creditAccountId: bank.id,
      startMonth: '2026-07',
    });
    expect(await catchUpRecurringRules('2026-07-23')).toBe(1);
    const ledger = await loadLedger();
    const posted = ledger.journalEntries.find((e) => e.metadata?.recurringRuleId)!;
    await deleteEntry(posted.id);
    expect(await catchUpRecurringRules('2026-07-23')).toBe(0);
  });

  it('停止中は起票せず、再開（startMonth=当月）で停止中の月を遡らない', async () => {
    const bank = await accountByName('預金');
    const invest = await accountByName('投資');
    const rule = await createRecurringRule({
      name: '積立',
      amount: 1000,
      dayOfMonth: 1,
      debitAccountId: invest.id,
      creditAccountId: bank.id,
      startMonth: '2026-05',
    });
    await upsertRecurringRule({ ...rule, paused: true, updatedAt: rule.updatedAt });
    expect(await catchUpRecurringRules('2026-07-23')).toBe(0);
    // 再開 = paused 解除 + startMonth を現在月へ（UI と同じ手順）→ 当月ぶんだけ起票。
    await upsertRecurringRule({
      ...rule,
      paused: false,
      startMonth: '2026-07',
      updatedAt: rule.updatedAt,
    });
    expect(await catchUpRecurringRules('2026-07-23')).toBe(1);
    const ledger = await loadLedger();
    const posted = ledger.journalEntries.filter((e) => e.metadata?.recurringRuleId);
    expect(posted.map((e) => e.date)).toEqual(['2026-07-01']);
  });

  it('ルール削除で起票済み仕訳は通常仕訳として残る（メタデータを剥がす）', async () => {
    const bank = await accountByName('預金');
    const invest = await accountByName('投資');
    const rule = await createRecurringRule({
      name: '積立',
      amount: 1000,
      dayOfMonth: 1,
      debitAccountId: invest.id,
      creditAccountId: bank.id,
      startMonth: '2026-07',
    });
    await catchUpRecurringRules('2026-07-23');
    await deleteRecurringRule(rule.id);

    const ledger = await loadLedger();
    expect(ledger.recurringRules.length).toBe(0);
    const entry = ledger.journalEntries.find((e) => e.description === '積立')!;
    expect(entry).toBeDefined();
    expect(entry.metadata?.recurringRuleId).toBeUndefined();
    // 剥がした後も export → schema 検証が通る（strict な存在チェックと両立）。
    const parsed = ledgerExportPackageSchema.safeParse(buildExportPackage(ledger));
    expect(parsed.success).toBe(true);
  });

  it('同じ定期ルール・月の仕訳が重複した package は拒否する', async () => {
    const bank = await accountByName('預金');
    const invest = await accountByName('投資');
    const rule = await createRecurringRule({
      name: '積立',
      amount: 1000,
      dayOfMonth: 1,
      debitAccountId: invest.id,
      creditAccountId: bank.id,
      startMonth: '2026-07',
    });
    await catchUpRecurringRules('2026-07-23');
    const pkg = buildExportPackage(await loadLedger());
    const posted = pkg.journalEntries.find(
      (entry) => entry.metadata?.recurringRuleId === rule.id,
    )!;
    const parsed = ledgerExportPackageSchema.safeParse({
      ...pkg,
      journalEntries: [...pkg.journalEntries, { ...posted, id: 'duplicate-recurring-entry' }],
    });
    expect(parsed.success).toBe(false);
  });

  it('簿記編集: 健康保険を「銀行 → 収入」で収入減として毎月起票できる', async () => {
    const bank = await accountByName('預金');
    const income = await accountByName('給与'); // income-category
    // 借方 収入カテゴリ / 貸方 資金 = 収入のマイナス（定型3種に当てはまらない）。
    await createRecurringRule({
      name: '健康保険',
      amount: 4000,
      dayOfMonth: 5,
      debitAccountId: income.id,
      creditAccountId: bank.id,
      startMonth: '2026-07',
    });
    expect(await catchUpRecurringRules('2026-07-23')).toBe(1);
    const ledger = await loadLedger();
    const posted = ledger.journalEntries.find((e) => e.metadata?.recurringRuleId)!;
    expect(posted.metadata?.inputMode).toBe('manual');
    expect(posted.lines).toEqual(
      expect.arrayContaining([
        { accountId: income.id, side: 'debit', amount: 4000 },
        { accountId: bank.id, side: 'credit', amount: 4000 },
      ]),
    );
  });

  it('簿記編集: クレカ積立を「カード → 投資」で毎月起票できる', async () => {
    const card = await accountByName('クレジットカード'); // payment-liability
    const invest = await accountByName('投資'); // investment-asset
    await createRecurringRule({
      name: 'クレカ積立',
      amount: 10000,
      dayOfMonth: 1,
      debitAccountId: invest.id,
      creditAccountId: card.id,
      startMonth: '2026-07',
    });
    expect(await catchUpRecurringRules('2026-07-23')).toBe(1);
    const ledger = await loadLedger();
    const posted = ledger.journalEntries.find((e) => e.metadata?.recurringRuleId)!;
    expect(posted.metadata?.inputMode).toBe('manual');
    expect(posted.lines).toEqual(
      expect.arrayContaining([
        { accountId: invest.id, side: 'debit', amount: 10000 },
        { accountId: card.id, side: 'credit', amount: 10000 },
      ]),
    );
  });

  it('同一科目・内部集約科目は fail-closed に弾く（自動起票の対象外）', async () => {
    const bank = await accountByName('預金');
    // 源泉=行き先 は不可。
    await expect(
      createRecurringRule({
        name: 'same',
        amount: 100,
        dayOfMonth: 1,
        debitAccountId: bank.id,
        creditAccountId: bank.id,
        startMonth: '2026-07',
      }),
    ).rejects.toThrow(LedgerError);
    // 目的別資金の集約口座（reserve-asset）は毎月起票の対象外。
    await createReserve({ name: '旅行積立' });
    await expect(
      createRecurringRule({
        name: 'reserve',
        amount: 100,
        dayOfMonth: 1,
        debitAccountId: RESERVE_LEDGER_ACCOUNT_ID,
        creditAccountId: bank.id,
        startMonth: '2026-07',
      }),
    ).rejects.toThrow(LedgerError);
  });

  it('export round-trip と必須キー欠落の拒否', async () => {
    const bank = await accountByName('預金');
    const invest = await accountByName('投資');
    await createRecurringRule({
      name: '積立',
      amount: 1000,
      dayOfMonth: 31,
      debitAccountId: invest.id,
      creditAccountId: bank.id,
      startMonth: '2026-07',
    });
    const pkg = buildExportPackage(await loadLedger());
    expect(ledgerExportPackageSchema.safeParse(pkg).success).toBe(true);
    // 後方互換はコードに持たないため、recurringRules キー欠落は fail-closed に拒否する。
    const legacy: Record<string, unknown> = { ...pkg };
    delete legacy.recurringRules;
    const parsed = ledgerExportPackageSchema.safeParse(legacy);
    expect(parsed.success).toBe(false);
  });

  it('未来基準日まではカーソル後の月だけを仮想投影し、実仕訳を保存しない', async () => {
    const bank = await accountByName('預金');
    const fixed = await accountByName('固定費');
    const rule = await createRecurringRule({
      name: '未来家賃',
      amount: 80000,
      dayOfMonth: 1,
      debitAccountId: fixed.id,
      creditAccountId: bank.id,
      startMonth: '2026-07',
    });
    await catchUpRecurringRules('2026-07-23');
    const before = await loadLedger();

    const entries = reportEntriesForAsOf(before, '2026-10-31', '2026-07-23');
    const forRule = entries
      .filter((entry) => entry.metadata?.recurringRuleId === rule.id)
      .sort((a, b) => a.date.localeCompare(b.date));
    expect(forRule.map((entry) => entry.metadata?.recurringMonth)).toEqual([
      '2026-07',
      '2026-08',
      '2026-09',
      '2026-10',
    ]);
    expect(forRule.map((entry) => entry.metadata?.virtual ?? false)).toEqual([
      false,
      true,
      true,
      true,
    ]);
    expect(new Set(forRule.map((entry) => entry.metadata?.recurringMonth)).size).toBe(
      forRule.length,
    );

    const octoberBasis = reportBasis({ mode: 'month', year: 2026, month: 10 }, '2026-07-23');
    expect(deriveProfitAndLoss(before.accounts, forRule, octoberBasis.flowRange).totalExpense).toBe(
      80000,
    );
    expect(deriveBalanceSheet(before.accounts, forRule, octoberBasis.asOf).assets).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          account: expect.objectContaining({ id: bank.id }),
          balance: -320000,
        }),
      ]),
    );

    const after = await loadLedger();
    expect(after.journalEntries).toEqual(before.journalEntries);
    expect(after.recurringRules).toEqual(before.recurringRules);
  });
});

describe('clampDayToMonth / recurringPostingsDue / recurringProjectionEntries', () => {
  it('31 日は月末へクランプされる', () => {
    expect(clampDayToMonth('2026-02', 31)).toBe('2026-02-28');
    expect(clampDayToMonth('2024-02', 31)).toBe('2024-02-29');
    expect(clampDayToMonth('2026-04', 31)).toBe('2026-04-30');
  });

  it('停止中は起票対象なし', () => {
    const rule = {
      id: 'r',
      name: 'x',
      amount: 1,
      dayOfMonth: 1,
      debitAccountId: 'd',
      creditAccountId: 'c',
      startMonth: '2026-01',
      paused: true,
      createdAt: 't',
      updatedAt: 't',
    };
    expect(recurringPostingsDue(rule, '2026-07-23')).toEqual([]);
  });

  it('未来投影は決定的IDで、停止中ルールを含めない', () => {
    const accounts: Account[] = [
      {
        id: 'cash',
        name: '現金',
        type: 'asset',
        role: 'daily-asset',
        archived: false,
        createdAt: 't',
        updatedAt: 't',
      },
      {
        id: 'expense',
        name: '固定費',
        type: 'expense',
        role: 'expense-category',
        archived: false,
        createdAt: 't',
        updatedAt: 't',
      },
    ];
    const base = {
      id: 'rule',
      name: '家賃',
      amount: 80000,
      dayOfMonth: 27,
      debitAccountId: 'expense',
      creditAccountId: 'cash',
      startMonth: '2026-07',
      postedThroughMonth: '2026-07',
      createdAt: 't',
      updatedAt: 't',
    };
    const projected = recurringProjectionEntries([base], accounts, '2026-10-31');
    expect(projected.map((entry) => entry.id)).toEqual([
      'rec-proj-rule-2026-08',
      'rec-proj-rule-2026-09',
      'rec-proj-rule-2026-10',
    ]);
    expect(recurringProjectionEntries([base], accounts, '2026-10-31')).toEqual(projected);
    expect(recurringProjectionEntries([{ ...base, paused: true }], accounts, '2026-10-31')).toEqual(
      [],
    );
  });
});

describe('編集・削除と起票カーソルの整合（check-then-act の封鎖）', () => {
  it('古いルールオブジェクトで upsert してもカーソルは巻き戻らない（二重起票しない）', async () => {
    const bank = await accountByName('預金');
    const invest = await accountByName('投資');
    const stale = await createRecurringRule({
      name: 'カーソル保持',
      amount: 10000,
      dayOfMonth: 1,
      debitAccountId: invest.id,
      creditAccountId: bank.id,
      startMonth: '2026-05',
    });
    // catchUp がカーソルを進めたあと、進める前に読んだ古いオブジェクトで編集を保存する。
    expect(await catchUpRecurringRules('2026-07-23')).toBe(3);
    await upsertRecurringRule({ ...stale, amount: 12000 });
    // カーソルが巻き戻っていなければ再起票は 0 件のまま。
    expect(await catchUpRecurringRules('2026-07-23')).toBe(0);
    const ledger = await loadLedger();
    const rule = ledger.recurringRules.find((r) => r.id === stale.id)!;
    expect(rule.amount).toBe(12000);
    expect(rule.postedThroughMonth).toBe('2026-07');
  });

  it('削除済みルールを古いオブジェクトの upsert で復活させない', async () => {
    const bank = await accountByName('預金');
    const invest = await accountByName('投資');
    const stale = await createRecurringRule({
      name: '復活禁止',
      amount: 5000,
      dayOfMonth: 1,
      debitAccountId: invest.id,
      creditAccountId: bank.id,
      startMonth: '2026-06',
    });
    await deleteRecurringRule(stale.id);
    await expect(upsertRecurringRule({ ...stale, amount: 6000 })).rejects.toMatchObject({
      code: 'error.recurring.notFound',
    });
    const ledger = await loadLedger();
    expect(ledger.recurringRules.some((r) => r.id === stale.id)).toBe(false);
  });
});
