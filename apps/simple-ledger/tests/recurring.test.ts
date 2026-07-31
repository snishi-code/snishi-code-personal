/*
 * 定期ルール（毎月の支出・収入・振替 = 実仕訳の自動起票）。
 *  - キャッチアップ起票: 経過月ぶんを実仕訳として起票・idempotent・月末クランプ。
 *  - カーソル: 起票済み仕訳を削除しても再起票しない（スキップの尊重）。
 *  - 停止/再開: 停止中は起票しない。再開はカーソルを前月に置き、位相（startMonth）を保ったまま
 *    停止中の月を遡らない（setRecurringRulePaused）。
 *  - everyMonths: startMonth 基点の位相で間引く（周期起票）。
 *  - 月割りするルール（spreadExpenseAccountId）: 起票 = 購入の仕訳 + item の 2 レコード 1 tx・
 *    未来投影は購入行 + 費用行の両方（台帳が積み上がらない = §13-1）。
 *  - 削除: ルールを消しても起票済み仕訳・item は残る（由来メタと決定的item IDを剥がす）。
 *  - export → schema round-trip / 必須キー欠落の拒否。
 */
import { describe, expect, it } from 'vitest';
import './setup';
import {
  catchUpRecurringRules,
  createRecurringRule,
  deleteEntry,
  deleteMonthlyCost,
  deleteRecurringRule,
  loadLedger,
  setRecurringRulePaused,
  upsertEntry,
  upsertMonthlyCost,
  upsertRecurringRule,
} from '../src/data/repository';
import {
  clampDayToMonth,
  recurringPostingsDue,
  recurringProjectionEntries,
} from '../src/domain/recurring';
import {
  accountBalance,
  deriveBalanceSheet,
  deriveProfitAndLoss,
  filterByDateRange,
} from '../src/domain/accounting';
import { livingCostBreakdownForRange } from '../src/domain/livingCost';
import { reportEntriesForAsOf } from '../src/domain/reportEntries';
import { reportBasis } from '../src/domain/reportPeriod';
import { CONTINUOUS_COST_LEDGER_ACCOUNT_ID } from '../src/domain/constants';
import { buildExportPackage } from '../src/data/exportImport';
import { putRecord, STORE } from '../src/data/db';
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
  it('集約台帳の well-known ID が別 role に使われていると費用ルールを保存しない', async () => {
    const bank = await accountByName('預金');
    const fixed = await accountByName('固定費');
    await putRecord(STORE.accounts, {
      id: CONTINUOUS_COST_LEDGER_ACCOUNT_ID,
      name: '偽の継続コスト台帳',
      type: 'asset',
      role: 'daily-asset',
      archived: false,
      createdAt: '2026-04-01T00:00:00.000Z',
      updatedAt: '2026-04-01T00:00:00.000Z',
    });

    await expect(
      createRecurringRule({
        name: '台帳衝突',
        amount: 1000,
        dayOfMonth: 20,
        debitAccountId: fixed.id,
        creditAccountId: bank.id,
        startMonth: '2026-04',
        startDate: '2026-04-12',
      }),
    ).rejects.toMatchObject({ code: 'error.monthlyCost.invalidStructure' });
    expect((await loadLedger()).recurringRules).toHaveLength(0);
  });

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
      startDate: '2026-05-01',
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
      startDate: '2026-05-01',
    });

    const outcomes = await Promise.allSettled([
      catchUpRecurringRules('2026-07-23'),
      catchUpRecurringRules('2026-07-23'),
    ]);
    // 同一タブでは事前読込から直列化され、先行が3件、後続が最新カーソルを見て0件になる。
    expect(outcomes.every((outcome) => outcome.status === 'fulfilled')).toBe(true);
    expect(
      outcomes
        .flatMap((outcome) => (outcome.status === 'fulfilled' ? [outcome.value] : []))
        .sort((a, b) => a - b),
    ).toEqual([0, 3]);

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
        (sum, entry) => sum + (entry.lines.find((line) => line.side === 'debit')?.amount ?? 0),
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
      startDate: '2026-07-27',
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
      startDate: '2026-07-01',
    });
    expect(await catchUpRecurringRules('2026-07-23')).toBe(1);
    const ledger = await loadLedger();
    const posted = ledger.journalEntries.find((e) => e.metadata?.recurringRuleId)!;
    await deleteEntry(posted.id);
    expect(await catchUpRecurringRules('2026-07-23')).toBe(0);
  });

  it('停止中は起票せず、再開（setRecurringRulePaused）で停止中の月を遡らない', async () => {
    const bank = await accountByName('預金');
    const invest = await accountByName('投資');
    const rule = await createRecurringRule({
      name: '積立',
      amount: 1000,
      dayOfMonth: 1,
      debitAccountId: invest.id,
      creditAccountId: bank.id,
      startMonth: '2026-05',
      startDate: '2026-05-01',
    });
    await setRecurringRulePaused(rule.id, true);
    expect(await catchUpRecurringRules('2026-07-23')).toBe(0);
    // 再開: startMonth は書き換えず、カーソル = 前月 → 当月ぶんだけ起票。
    await setRecurringRulePaused(rule.id, false, '2026-07-23');
    expect(await catchUpRecurringRules('2026-07-23')).toBe(1);
    const ledger = await loadLedger();
    const posted = ledger.journalEntries.filter((e) => e.metadata?.recurringRuleId);
    expect(posted.map((e) => e.date)).toEqual(['2026-07-01']);
    // 位相の基点は保たれている。
    expect(ledger.recurringRules[0]?.startMonth).toBe('2026-05');
  });

  it('過去断面から終了済みルールを再開してもカーソルは終了月を越えない', async () => {
    const bank = await accountByName('預金');
    const invest = await accountByName('投資');
    const rule = await createRecurringRule({
      name: '終了済みの一時停止',
      amount: 1000,
      dayOfMonth: 20,
      debitAccountId: invest.id,
      creditAccountId: bank.id,
      startMonth: '2026-04',
      startDate: '2026-04-12',
      endDate: '2026-04-22',
    });
    await setRecurringRulePaused(rule.id, true);
    await setRecurringRulePaused(rule.id, false, '2026-07-31');

    const ledger = await loadLedger();
    expect(ledger.recurringRules[0]).toMatchObject({
      endDate: '2026-04-22',
      postedThroughMonth: '2026-04',
      paused: false,
    });
    expect(ledgerExportPackageSchema.safeParse(buildExportPackage(ledger)).success).toBe(true);
  });

  it('終了月の予定日前に終わるルールは、停止往復後も終了解除で未起票分を発生させる', async () => {
    const bank = await accountByName('預金');
    const invest = await accountByName('投資');
    const rule = await createRecurringRule({
      name: '予定日前に終了',
      amount: 1000,
      dayOfMonth: 20,
      debitAccountId: invest.id,
      creditAccountId: bank.id,
      startMonth: '2026-04',
      startDate: '2026-04-12',
      endDate: '2026-04-18',
    });
    await setRecurringRulePaused(rule.id, true);
    // 再開時の前月と終了月が同じケースでも、予定日前なら前月へ留める。
    await setRecurringRulePaused(rule.id, false, '2026-05-10');

    let ledger = await loadLedger();
    expect(ledger.recurringRules[0]).toMatchObject({
      endDate: '2026-04-18',
      postedThroughMonth: '2026-03',
      paused: false,
    });

    await upsertRecurringRule({ ...ledger.recurringRules[0]!, endDate: undefined });
    expect(await catchUpRecurringRules('2026-07-31')).toBe(4);
    ledger = await loadLedger();
    expect(
      ledger.journalEntries
        .filter((entry) => entry.metadata?.recurringRuleId === rule.id)
        .map((entry) => entry.date)
        .sort(),
    ).toEqual(['2026-04-20', '2026-05-20', '2026-06-20', '2026-07-20']);
  });

  it('everyMonths > 1 は startMonth 基点の位相で間引いて起票する', async () => {
    const bank = await accountByName('預金');
    const fixed = await accountByName('固定費');
    const rule = await createRecurringRule({
      name: '年払い保険',
      amount: 60000,
      dayOfMonth: 25,
      everyMonths: 12,
      spreadExpenseAccountId: fixed.id,
      debitAccountId: fixed.id, // spread 指定時は無視され台帳に固定される
      creditAccountId: bank.id,
      startMonth: '2024-04',
      startDate: '2024-04-25',
    });
    expect(rule.debitAccountId).toBe(CONTINUOUS_COST_LEDGER_ACCOUNT_ID);
    // 2024-04 / 2025-04 / 2026-04 の 3 回ぶん（2026-07 時点）。
    expect(await catchUpRecurringRules('2026-07-23')).toBe(3);
    const ledger = await loadLedger();
    const posted = ledger.journalEntries.filter((e) => e.metadata?.recurringRuleId === rule.id);
    expect(posted.map((e) => e.date).sort()).toEqual(['2024-04-25', '2025-04-25', '2026-04-25']);
    expect(await catchUpRecurringRules('2026-07-23')).toBe(0);
  });

  it('再開後も everyMonths の位相が飛ばない（4月起点の年払いを11月に再開 → 次回は翌年4月）', async () => {
    const bank = await accountByName('預金');
    const fixed = await accountByName('固定費');
    const rule = await createRecurringRule({
      name: '年払い',
      amount: 60000,
      dayOfMonth: 25,
      everyMonths: 12,
      spreadExpenseAccountId: fixed.id,
      debitAccountId: fixed.id,
      creditAccountId: bank.id,
      startMonth: '2026-04',
      startDate: '2026-04-25',
    });
    expect(await catchUpRecurringRules('2026-05-01')).toBe(1); // 2026-04 分
    await setRecurringRulePaused(rule.id, true);
    await setRecurringRulePaused(rule.id, false, '2026-11-10');
    // 11月は位相に乗らないので起票されない。次の該当月は 2027-04。
    expect(await catchUpRecurringRules('2026-11-10')).toBe(0);
    expect(await catchUpRecurringRules('2027-04-25')).toBe(1);
    const ledger = await loadLedger();
    const posted = ledger.journalEntries.filter((e) => e.metadata?.recurringRuleId === rule.id);
    expect(posted.map((e) => e.date).sort()).toEqual(['2026-04-25', '2027-04-25']);
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
      startDate: '2026-07-01',
    });
    await catchUpRecurringRules('2026-07-23');
    const generated = (await loadLedger()).journalEntries.find(
      (entry) => entry.metadata?.recurringRuleId === rule.id,
    )!;
    await putRecord(STORE.journalEntries, {
      id: 'rule-delete-reversal',
      date: generated.date,
      description: '反転',
      kind: 'normal',
      lines: generated.lines.map((line) => ({
        ...line,
        side: line.side === 'debit' ? 'credit' : 'debit',
      })),
      metadata: { reversalOfEntryId: generated.id },
      createdAt: '2026-07-01T00:00:00.000Z',
      updatedAt: '2026-07-01T00:00:00.000Z',
    });
    await putRecord(STORE.cashflowSchedules, {
      id: 'rule-delete-schedule',
      title: '積立予定',
      dueDate: generated.date,
      direction: 'transfer',
      amount: 1000,
      accountId: bank.id,
      counterAccountId: invest.id,
      source: 'manual',
      status: 'posted',
      linkedEntryId: generated.id,
      createdAt: '2026-07-01T00:00:00.000Z',
      updatedAt: '2026-07-01T00:00:00.000Z',
    });
    await deleteRecurringRule(rule.id);

    const ledger = await loadLedger();
    expect(ledger.recurringRules.length).toBe(0);
    const entry = ledger.journalEntries.find((e) => e.description === '積立')!;
    expect(entry).toBeDefined();
    expect(entry.id).not.toBe(generated.id);
    expect(entry.id.startsWith(`rec-${rule.id}-`)).toBe(false);
    expect(entry.metadata?.recurringRuleId).toBeUndefined();
    expect(
      ledger.journalEntries.find((candidate) => candidate.id === 'rule-delete-reversal')?.metadata
        ?.reversalOfEntryId,
    ).toBe(entry.id);
    expect(
      ledger.cashflowSchedules.find((schedule) => schedule.id === 'rule-delete-schedule')
        ?.linkedEntryId,
    ).toBe(entry.id);
    // 剥がした後も export → schema 検証が通る（strict な存在チェックと両立）。
    const parsed = ledgerExportPackageSchema.safeParse(buildExportPackage(ledger));
    expect(parsed.success).toBe(true);
  });

  it('費用ルールを削除しても作成済みの継続コスト資産と購入実績は残る', async () => {
    const bank = await accountByName('預金');
    const fixed = await accountByName('固定費');
    const rule = await createRecurringRule({
      name: '削除後も残る年払い',
      amount: 12000,
      dayOfMonth: 1,
      everyMonths: 12,
      debitAccountId: fixed.id,
      creditAccountId: bank.id,
      startMonth: '2026-07',
      startDate: '2026-07-01',
    });
    await catchUpRecurringRules('2026-07-01');
    await deleteRecurringRule(rule.id);

    const ledger = await loadLedger();
    const oldItemId = `ccr-${rule.id}-2026-07`;
    expect(ledger.recurringRules).toHaveLength(0);
    expect(ledger.monthlyCostItems.some((item) => item.id === oldItemId)).toBe(false);
    const detachedItem = ledger.monthlyCostItems.find(
      (item) => item.name === '削除後も残る年払い',
    );
    expect(detachedItem).toBeDefined();
    expect(detachedItem?.id.startsWith(`ccr-${rule.id}-`)).toBe(false);
    const purchase = ledger.journalEntries.find(
      (entry) => entry.metadata?.monthlyCostId === detachedItem?.id,
    );
    expect(purchase).toBeDefined();
    expect(purchase?.id.startsWith(`rec-${rule.id}-`)).toBe(false);
    expect(purchase?.metadata?.recurringRuleId).toBeUndefined();
    expect(ledgerExportPackageSchema.safeParse(buildExportPackage(ledger)).success).toBe(true);
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
      startDate: '2026-07-01',
    });
    await catchUpRecurringRules('2026-07-23');
    const pkg = buildExportPackage(await loadLedger());
    const posted = pkg.journalEntries.find((entry) => entry.metadata?.recurringRuleId === rule.id)!;
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
      startDate: '2026-07-05',
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
      startDate: '2026-07-01',
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
        startDate: '2026-07-01',
      }),
    ).rejects.toThrow(LedgerError);
    // 継続コスト台帳（内部集約）は簿記編集ルールの科目に直接指定できない
    // （台帳経由は spreadExpenseAccountId を持つ月割りルールだけ）。
    const fixed = await accountByName('固定費');
    await createRecurringRule({
      name: '台帳を生むための家賃',
      amount: 100000,
      dayOfMonth: 27,
      spreadExpenseAccountId: fixed.id,
      debitAccountId: bank.id, // spread では無視され台帳に固定される
      creditAccountId: bank.id,
      startMonth: '2026-07',
      startDate: '2026-07-27',
    });
    await expect(
      createRecurringRule({
        name: 'ledger-direct',
        amount: 100,
        dayOfMonth: 1,
        debitAccountId: CONTINUOUS_COST_LEDGER_ACCOUNT_ID,
        creditAccountId: bank.id,
        startMonth: '2026-07',
        startDate: '2026-07-01',
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
      startDate: '2026-07-31',
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
      startDate: '2026-07-01',
    });
    await catchUpRecurringRules('2026-07-23');
    const before = await loadLedger();

    const entries = reportEntriesForAsOf(before, '2026-10-31');
    const allForRule = entries.filter((entry) => entry.metadata?.recurringRuleId === rule.id);
    const forRule = allForRule
      .filter((entry) => entry.metadata?.ccKind !== 'recognition')
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

    const octoberBasis = reportBasis({ mode: 'date', date: '2026-10-31' }, '2026-07-23');
    expect(
      deriveProfitAndLoss(before.accounts, allForRule, octoberBasis.flowRange).totalExpense,
    ).toBe(80000);
    expect(deriveBalanceSheet(before.accounts, allForRule, octoberBasis.asOf).assets).toEqual(
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
      everyMonths: 1,
      startMonth: '2026-01',
      startDate: '2026-01-01',
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
      {
        id: CONTINUOUS_COST_LEDGER_ACCOUNT_ID,
        name: '継続コスト台帳',
        type: 'asset',
        role: 'continuing-cost-asset',
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
      everyMonths: 1,
      startMonth: '2026-07',
      startDate: '2026-07-01',
      postedThroughMonth: '2026-07',
      createdAt: 't',
      updatedAt: 't',
    };
    const projected = recurringProjectionEntries([base], accounts, '2026-10-31');
    expect(
      projected.filter((entry) => entry.id.startsWith('rec-proj-')).map((entry) => entry.id),
    ).toEqual(['rec-proj-rule-2026-08', 'rec-proj-rule-2026-09', 'rec-proj-rule-2026-10']);
    expect(projected).toHaveLength(6);
    expect(projected.every((entry) => entry.metadata?.continuousCostId !== undefined)).toBe(true);
    expect(recurringProjectionEntries([base], accounts, '2026-10-31')).toEqual(projected);
    expect(recurringProjectionEntries([{ ...base, paused: true }], accounts, '2026-10-31')).toEqual(
      [],
    );
  });

  it('月割りルールの投影購入行は費用行と同じ継続コストIDを持つ', () => {
    const accounts: Account[] = [
      {
        id: CONTINUOUS_COST_LEDGER_ACCOUNT_ID,
        name: '継続コスト台帳',
        type: 'asset',
        role: 'continuing-cost-asset',
        archived: false,
        createdAt: 't',
        updatedAt: 't',
      },
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
    const projected = recurringProjectionEntries(
      [
        {
          id: 'spread-rule',
          name: '家賃',
          amount: 80000,
          dayOfMonth: 27,
          debitAccountId: CONTINUOUS_COST_LEDGER_ACCOUNT_ID,
          creditAccountId: 'cash',
          spreadExpenseAccountId: 'expense',
          everyMonths: 1,
          startMonth: '2026-07',
          startDate: '2026-07-01',
          postedThroughMonth: '2026-07',
          createdAt: 't',
          updatedAt: 't',
        },
      ],
      accounts,
      '2026-08-31',
    );

    const purchase = projected.find((entry) => entry.id === 'rec-proj-spread-rule-2026-08');
    expect(purchase?.metadata?.continuousCostId).toBe('spread-rule-2026-08');
    expect(
      projected.find((entry) => entry.metadata?.ccKind === 'recognition')?.metadata
        ?.continuousCostId,
    ).toBe('spread-rule-2026-08');
  });

  it('費用から直接フローへ変更した後は、既存itemの被覆と独立して次月から投影する', () => {
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
        id: 'investment',
        name: '投資',
        type: 'asset',
        role: 'investment-asset',
        archived: false,
        createdAt: 't',
        updatedAt: 't',
      },
    ];
    const rule = {
      id: 'changed-rule',
      name: '変更後の積立',
      amount: 10_000,
      dayOfMonth: 1,
      debitAccountId: 'investment',
      creditAccountId: 'cash',
      everyMonths: 1,
      startMonth: '2026-01',
      startDate: '2026-01-01',
      postedThroughMonth: '2026-01',
      createdAt: 't',
      updatedAt: 't',
    };
    const existingItem = {
      id: 'ccr-changed-rule-2026-01',
      name: '変更前の年払い',
      amount: 120_000,
      startDate: '2026-01-01',
      endDate: '2026-12-31',
      expenseAccountId: 'expense',
      createdAt: 't',
      updatedAt: 't',
    };

    expect(
      recurringProjectionEntries([rule], accounts, '2027-02-28', [existingItem]).map(
        (entry) => entry.date,
      ),
    ).toEqual([
      '2026-02-01',
      '2026-03-01',
      '2026-04-01',
      '2026-05-01',
      '2026-06-01',
      '2026-07-01',
      '2026-08-01',
      '2026-09-01',
      '2026-10-01',
      '2026-11-01',
      '2026-12-01',
      '2027-01-01',
      '2027-02-01',
    ]);
  });
});

describe('編集・削除と起票カーソルの整合（check-then-act の封鎖）', () => {
  it('金額変更は影響範囲を指定しない限り保存しない', async () => {
    const bank = await accountByName('預金');
    const invest = await accountByName('投資');
    const rule = await createRecurringRule({
      name: '範囲選択必須',
      amount: 10000,
      dayOfMonth: 20,
      debitAccountId: invest.id,
      creditAccountId: bank.id,
      startMonth: '2026-04',
      startDate: '2026-04-12',
    });

    await expect(upsertRecurringRule({ ...rule, amount: 12000 })).rejects.toMatchObject({
      code: 'error.recurring.amountChangeModeRequired',
    });
    expect((await loadLedger()).recurringRules.find((r) => r.id === rule.id)?.amount).toBe(10000);
  });

  it('ルール由来itemだけが残る破損状態では、遡及・分割・削除を全て中断する', async () => {
    const bank = await accountByName('預金');
    const fixed = await accountByName('固定費');
    const rule = await createRecurringRule({
      name: '対応関係破損',
      amount: 1000,
      dayOfMonth: 20,
      debitAccountId: fixed.id,
      creditAccountId: bank.id,
      startMonth: '2026-04',
      startDate: '2026-04-12',
    });
    await putRecord(STORE.monthlyCostItems, {
      id: `ccr-${rule.id}-2026-04`,
      name: rule.name,
      amount: rule.amount,
      startDate: '2026-04-20',
      endDate: '2026-04-30',
      expenseAccountId: fixed.id,
      createdAt: rule.createdAt,
      updatedAt: rule.updatedAt,
    });

    await expect(
      upsertRecurringRule(
        { ...rule, amount: 1500 },
        { amountChangeMode: 'retroactive' },
      ),
    ).rejects.toMatchObject({ code: 'error.recurring.generatedDependency' });
    await expect(
      upsertRecurringRule(
        { ...rule, amount: 1500 },
        { amountChangeMode: 'split', effectiveDate: '2026-04-18' },
      ),
    ).rejects.toMatchObject({ code: 'error.recurring.generatedDependency' });
    await expect(deleteRecurringRule(rule.id)).rejects.toMatchObject({
      code: 'error.recurring.generatedDependency',
    });
    expect((await loadLedger()).recurringRules).toHaveLength(1);
  });

  it('開始前・開始当日の split 指定を遡及変更へ読み替えず拒否する', async () => {
    const bank = await accountByName('預金');
    const invest = await accountByName('投資');
    const rule = await createRecurringRule({
      name: '空の前区間を作らない',
      amount: 10000,
      dayOfMonth: 20,
      debitAccountId: invest.id,
      creditAccountId: bank.id,
      startMonth: '2026-04',
      startDate: '2026-04-12',
    });

    for (const effectiveDate of ['2026-04-11', '2026-04-12']) {
      await expect(
        upsertRecurringRule(
          { ...rule, amount: 12000 },
          { amountChangeMode: 'split', effectiveDate },
        ),
      ).rejects.toMatchObject({ code: 'error.recurring.periodInvalid' });
    }
    const ledger = await loadLedger();
    expect(ledger.recurringRules).toHaveLength(1);
    expect(ledger.recurringRules[0]).toMatchObject({ id: rule.id, amount: 10000 });
  });

  it('金額と起票基準日を同時に変えて分割しても、元の startMonth 位相を後継する', async () => {
    const bank = await accountByName('預金');
    const invest = await accountByName('投資');
    const rule = await createRecurringRule({
      name: '位相継承',
      amount: 1000,
      dayOfMonth: 20,
      debitAccountId: invest.id,
      creditAccountId: bank.id,
      startMonth: '2026-04',
      startDate: '2026-04-12',
    });

    await upsertRecurringRule(
      { ...rule, amount: 1500, startMonth: '2026-05', dayOfMonth: 25 },
      { amountChangeMode: 'split', effectiveDate: '2026-04-18' },
    );

    const successor = (await loadLedger()).recurringRules.find(
      (candidate) => candidate.id !== rule.id,
    )!;
    expect(successor).toMatchObject({ startMonth: '2026-04', dayOfMonth: 25 });
    expect(await catchUpRecurringRules('2026-04-25')).toBe(1);
    expect(
      (await loadLedger()).journalEntries.find(
        (entry) => entry.metadata?.recurringRuleId === successor.id,
      )?.date,
    ).toBe('2026-04-25');
  });

  it('終了点を空にした編集は有限segmentを将来へ再び開く', async () => {
    const bank = await accountByName('預金');
    const invest = await accountByName('投資');
    const rule = await createRecurringRule({
      name: '終了点解除',
      amount: 1000,
      dayOfMonth: 20,
      debitAccountId: invest.id,
      creditAccountId: bank.id,
      startMonth: '2026-04',
      startDate: '2026-04-12',
      endDate: '2026-04-18',
    });
    // 終了月の起票日は存在期間外。この月自体を処理済みにしない。
    expect(await catchUpRecurringRules('2026-04-18')).toBe(0);
    const finite = (await loadLedger()).recurringRules.find((candidate) => candidate.id === rule.id)!;
    expect(finite.postedThroughMonth).toBeUndefined();
    const reopened = { ...finite };
    delete reopened.endDate;
    await upsertRecurringRule(reopened);

    expect(await catchUpRecurringRules('2026-04-20')).toBe(1);
    const ledger = await loadLedger();
    expect(ledger.recurringRules.find((r) => r.id === rule.id)?.endDate).toBeUndefined();
    expect(
      ledger.journalEntries.find((entry) => entry.metadata?.recurringRuleId === rule.id)?.date,
    ).toBe('2026-04-20');
  });

  it('金額変更で分けた境界は旧終了点・後継開始点の片側編集を拒否する', async () => {
    const bank = await accountByName('預金');
    const invest = await accountByName('投資');
    const rule = await createRecurringRule({
      name: '連鎖境界',
      amount: 1000,
      dayOfMonth: 20,
      debitAccountId: invest.id,
      creditAccountId: bank.id,
      startMonth: '2026-04',
      startDate: '2026-04-12',
    });
    await catchUpRecurringRules('2026-04-20');
    await upsertRecurringRule(
      { ...(await loadLedger()).recurringRules[0]!, amount: 1500 },
      { amountChangeMode: 'split', effectiveDate: '2026-04-22' },
    );

    let ledger = await loadLedger();
    const predecessor = ledger.recurringRules.find((candidate) => candidate.id === rule.id)!;
    const successor = ledger.recurringRules.find((candidate) => candidate.id !== rule.id)!;
    expect(successor.splitFromRuleId).toBe(predecessor.id);
    const reopened = { ...predecessor };
    delete reopened.endDate;
    await expect(upsertRecurringRule(reopened)).rejects.toMatchObject({
      code: 'error.recurring.periodInvalid',
    });
    await expect(
      upsertRecurringRule({ ...successor, startDate: '2026-04-21' }),
    ).rejects.toMatchObject({ code: 'error.recurring.periodInvalid' });
    await expect(
      upsertRecurringRule({ ...predecessor, startMonth: '2026-03' }),
    ).rejects.toMatchObject({ code: 'error.recurring.splitPhaseLocked' });
    await expect(
      upsertRecurringRule({ ...successor, startMonth: '2026-05' }),
    ).rejects.toMatchObject({ code: 'error.recurring.splitPhaseLocked' });
    await expect(
      upsertRecurringRule(
        { ...predecessor, amount: 1200 },
        { amountChangeMode: 'split', effectiveDate: '2026-04-21' },
      ),
    ).rejects.toMatchObject({ code: 'error.recurring.periodInvalid' });
    ledger = await loadLedger();
    expect(ledgerExportPackageSchema.safeParse(buildExportPackage(ledger)).success).toBe(true);

    // 片方の segment を物理削除した後は、残った線分の連鎖参照も剥がす。
    await deleteRecurringRule(predecessor.id);
    ledger = await loadLedger();
    expect(ledger.recurringRules).toHaveLength(1);
    expect(ledger.recurringRules[0]?.splitFromRuleId).toBeUndefined();
    expect(ledgerExportPackageSchema.safeParse(buildExportPackage(ledger)).success).toBe(true);
  });

  it('分割連鎖の中間segmentを削除すると、後継の連鎖参照も同時に外す', async () => {
    const bank = await accountByName('預金');
    const invest = await accountByName('投資');
    const first = await createRecurringRule({
      name: '三区間ルール',
      amount: 1000,
      dayOfMonth: 20,
      debitAccountId: invest.id,
      creditAccountId: bank.id,
      startMonth: '2026-04',
      startDate: '2026-04-12',
    });
    await upsertRecurringRule(
      { ...first, amount: 1500 },
      { amountChangeMode: 'split', effectiveDate: '2026-04-22' },
    );
    let ledger = await loadLedger();
    const middle = ledger.recurringRules.find((rule) => rule.id !== first.id)!;
    await upsertRecurringRule(
      { ...middle, amount: 2000 },
      { amountChangeMode: 'split', effectiveDate: '2026-05-22' },
    );

    ledger = await loadLedger();
    const last = ledger.recurringRules.find(
      (rule) => rule.splitFromRuleId === middle.id,
    )!;
    expect(last).toBeDefined();
    await deleteRecurringRule(middle.id);

    ledger = await loadLedger();
    expect(ledger.recurringRules.map((rule) => rule.id).sort()).toEqual(
      [first.id, last.id].sort(),
    );
    expect(ledger.recurringRules.find((rule) => rule.id === last.id)?.splitFromRuleId).toBeUndefined();
    expect(ledgerExportPackageSchema.safeParse(buildExportPackage(ledger)).success).toBe(true);
  });

  it('分割後継を削除しても旧segmentの終了境界を保ち、独立事実を再起票しない', async () => {
    const bank = await accountByName('預金');
    const invest = await accountByName('投資');
    const predecessor = await createRecurringRule({
      name: '後継削除後の境界',
      amount: 1000,
      dayOfMonth: 20,
      debitAccountId: invest.id,
      creditAccountId: bank.id,
      startMonth: '2026-04',
      startDate: '2026-04-12',
    });
    await catchUpRecurringRules('2026-04-20');
    await upsertRecurringRule(
      { ...(await loadLedger()).recurringRules[0]!, amount: 1500 },
      { amountChangeMode: 'split', effectiveDate: '2026-04-22' },
    );
    let ledger = await loadLedger();
    const successor = ledger.recurringRules.find((rule) => rule.id !== predecessor.id)!;
    await catchUpRecurringRules('2026-05-20');
    await deleteRecurringRule(successor.id);

    ledger = await loadLedger();
    const remaining = ledger.recurringRules.find((rule) => rule.id === predecessor.id)!;
    expect(remaining).toMatchObject({ endDate: '2026-04-22', splitEndLocked: true });
    const neutralMayFacts = ledger.journalEntries.filter(
      (entry) => entry.date === '2026-05-20' && entry.description === '後継削除後の境界',
    );
    expect(neutralMayFacts).toHaveLength(1);
    expect(neutralMayFacts[0]?.metadata?.recurringRuleId).toBeUndefined();
    const reopened = { ...remaining };
    delete reopened.endDate;
    await expect(upsertRecurringRule(reopened)).rejects.toMatchObject({
      code: 'error.recurring.periodInvalid',
    });
    expect(await catchUpRecurringRules('2026-05-20')).toBe(0);
    expect(
      (await loadLedger()).journalEntries.filter(
        (entry) =>
          entry.date === '2026-05-20' && entry.description === '後継削除後の境界',
      ),
    ).toHaveLength(1);
  });

  it('終了点を縮めると、期間外の事実がない限りカーソルも最後の存在月へ閉じる', async () => {
    const bank = await accountByName('預金');
    const invest = await accountByName('投資');
    const rule = await createRecurringRule({
      name: '終了点とカーソル',
      amount: 1000,
      dayOfMonth: 1,
      debitAccountId: invest.id,
      creditAccountId: bank.id,
      startMonth: '2026-06',
      startDate: '2026-06-01',
    });
    await catchUpRecurringRules('2026-07-01');
    let ledger = await loadLedger();
    const july = ledger.journalEntries.find(
      (entry) =>
        entry.metadata?.recurringRuleId === rule.id &&
        entry.metadata.recurringMonth === '2026-07',
    )!;
    await deleteEntry(july.id); // 「7月はスキップ」なのでカーソルは7月のまま。
    ledger = await loadLedger();
    const stored = ledger.recurringRules.find((candidate) => candidate.id === rule.id)!;
    await upsertRecurringRule({ ...stored, endDate: '2026-07-01' });

    ledger = await loadLedger();
    expect(ledger.recurringRules[0]).toMatchObject({
      endDate: '2026-07-01',
      postedThroughMonth: '2026-06',
    });
    expect(ledgerExportPackageSchema.safeParse(buildExportPackage(ledger)).success).toBe(true);
  });

  it('起票日当日の分岐は起票済み分を後継へ移し、新旧で二重計上しない', async () => {
    const bank = await accountByName('預金');
    const fixed = await accountByName('固定費');
    const rule = await createRecurringRule({
      name: '当日料金変更',
      amount: 1000,
      dayOfMonth: 20,
      everyMonths: 1,
      debitAccountId: fixed.id,
      creditAccountId: bank.id,
      startMonth: '2026-04',
      startDate: '2026-04-12',
    });
    expect(await catchUpRecurringRules('2026-04-20')).toBe(1);

    let before = await loadLedger();
    const generatedItem = before.monthlyCostItems.find(
      (item) => item.id === `ccr-${rule.id}-2026-04`,
    )!;
    await upsertMonthlyCost({
      ...generatedItem,
      name: '個別編集済みの当日分',
      endDate: '2026-06-30',
    });
    before = await loadLedger();
    const stored = before.recurringRules.find((r) => r.id === rule.id)!;
    await upsertRecurringRule(
      { ...stored, amount: 1500 },
      { amountChangeMode: 'split', effectiveDate: '2026-04-20' },
    );

    const ledger = await loadLedger();
    const predecessor = ledger.recurringRules.find((r) => r.id === rule.id)!;
    const successor = ledger.recurringRules.find((r) => r.id !== rule.id)!;
    expect(predecessor).toMatchObject({ amount: 1000, endDate: '2026-04-20' });
    expect(successor).toMatchObject({ amount: 1500, startDate: '2026-04-20' });
    expect(
      ledger.journalEntries.filter((entry) => entry.metadata?.recurringMonth === '2026-04'),
    ).toHaveLength(1);
    expect(
      ledger.journalEntries.find(
        (entry) => entry.metadata?.recurringRuleId === successor.id,
      )?.lines.every((line) => line.amount === 1500),
    ).toBe(true);
    expect(ledger.monthlyCostItems.some((item) => item.id === `ccr-${rule.id}-2026-04`)).toBe(
      false,
    );
    expect(
      ledger.monthlyCostItems.find((item) => item.id === `ccr-${successor.id}-2026-04`),
    ).toMatchObject({
      name: '個別編集済みの当日分',
      amount: 1500,
      startDate: '2026-04-20',
      endDate: '2026-06-30',
    });
    expect(ledgerExportPackageSchema.safeParse(buildExportPackage(ledger)).success).toBe(true);
  });

  it('月初の分岐では旧ルールのカーソルを前月へ閉じ、後継へ当月分を渡す', async () => {
    const bank = await accountByName('預金');
    const invest = await accountByName('投資');
    const rule = await createRecurringRule({
      name: '月初料金変更',
      amount: 1000,
      dayOfMonth: 1,
      debitAccountId: invest.id,
      creditAccountId: bank.id,
      startMonth: '2026-07',
      startDate: '2026-07-01',
    });
    expect(await catchUpRecurringRules('2026-08-01')).toBe(2);
    const stored = (await loadLedger()).recurringRules.find((r) => r.id === rule.id)!;

    await upsertRecurringRule(
      { ...stored, amount: 1500 },
      { amountChangeMode: 'split', effectiveDate: '2026-08-01' },
    );

    const ledger = await loadLedger();
    const predecessor = ledger.recurringRules.find((r) => r.id === rule.id)!;
    const successor = ledger.recurringRules.find((r) => r.id !== rule.id)!;
    expect(predecessor.postedThroughMonth).toBe('2026-07');
    expect(successor.postedThroughMonth).toBe('2026-08');
    expect(
      ledger.journalEntries.find(
        (entry) => entry.metadata?.recurringRuleId === successor.id,
      ),
    ).toMatchObject({ date: '2026-08-01' });
    expect(ledgerExportPackageSchema.safeParse(buildExportPackage(ledger)).success).toBe(true);
  });

  it('分岐と同時に行き先を費用へ変えても、起票済み当日分の形は保持して次回から反映する', async () => {
    const bank = await accountByName('預金');
    const invest = await accountByName('投資');
    const fixed = await accountByName('固定費');
    const rule = await createRecurringRule({
      name: '積立から費用へ',
      amount: 1000,
      dayOfMonth: 20,
      debitAccountId: invest.id,
      creditAccountId: bank.id,
      startMonth: '2026-04',
      startDate: '2026-04-12',
    });
    await catchUpRecurringRules('2026-04-20');
    const stored = (await loadLedger()).recurringRules.find((r) => r.id === rule.id)!;

    await upsertRecurringRule(
      { ...stored, amount: 1500, debitAccountId: fixed.id },
      { amountChangeMode: 'split', effectiveDate: '2026-04-20' },
    );

    let ledger = await loadLedger();
    const successor = ledger.recurringRules.find((r) => r.id !== rule.id)!;
    expect(ledger.monthlyCostItems).toHaveLength(0);
    const moved = ledger.journalEntries.find(
      (entry) => entry.metadata?.recurringRuleId === successor.id,
    );
    expect(moved?.lines).toEqual(
      expect.arrayContaining([
        { accountId: invest.id, side: 'debit', amount: 1500 },
        { accountId: bank.id, side: 'credit', amount: 1500 },
      ]),
    );

    await catchUpRecurringRules('2026-05-20');
    ledger = await loadLedger();
    expect(
      ledger.monthlyCostItems.find(
        (candidate) => candidate.id === `ccr-${successor.id}-2026-05`,
      ),
    ).toMatchObject({ amount: 1500, expenseAccountId: fixed.id });
    // 境界当日の直接フロー（itemなし）と翌月の費用フロー（itemあり）が混在しても、
    // 後継ルールの通常編集は依存関係破損と誤判定しない。
    const currentSuccessor = ledger.recurringRules.find((candidate) => candidate.id === successor.id)!;
    await upsertRecurringRule({ ...currentSuccessor, name: '積立から費用へ（変更後）' });
    ledger = await loadLedger();
    expect(ledgerExportPackageSchema.safeParse(buildExportPackage(ledger)).success).toBe(true);
  });

  it('費用から直接フローへ分岐した既存itemは通常IDへ切り離し、次回起票を止めない', async () => {
    const bank = await accountByName('預金');
    const fixed = await accountByName('固定費');
    const invest = await accountByName('投資');
    const rule = await createRecurringRule({
      name: '年払いから積立へ',
      amount: 12000,
      dayOfMonth: 20,
      everyMonths: 12,
      debitAccountId: fixed.id,
      creditAccountId: bank.id,
      startMonth: '2026-04',
      startDate: '2026-04-12',
    });
    await catchUpRecurringRules('2026-04-20');
    const stored = (await loadLedger()).recurringRules.find((r) => r.id === rule.id)!;

    const changed = { ...stored, amount: 1500, everyMonths: 1, debitAccountId: invest.id };
    delete changed.spreadExpenseAccountId;
    await upsertRecurringRule(
      changed,
      { amountChangeMode: 'split', effectiveDate: '2026-04-20' },
    );

    let ledger = await loadLedger();
    const successor = ledger.recurringRules.find((r) => r.id !== rule.id)!;
    const detached = ledger.monthlyCostItems[0]!;
    expect(detached.id.startsWith(`ccr-${successor.id}-`)).toBe(false);
    expect(detached).toMatchObject({ amount: 1500, endDate: '2027-03-31' });
    expect(await catchUpRecurringRules('2026-05-20')).toBe(1);
    ledger = await loadLedger();
    expect(
      ledger.journalEntries.find(
        (entry) =>
          entry.metadata?.recurringRuleId === successor.id &&
          entry.metadata.recurringMonth === '2026-05',
      )?.lines,
    ).toEqual(
      expect.arrayContaining([
        { accountId: invest.id, side: 'debit', amount: 1500 },
        { accountId: bank.id, side: 'credit', amount: 1500 },
      ]),
    );

    await upsertRecurringRule(
      { ...ledger.recurringRules.find((candidate) => candidate.id === successor.id)!, amount: 1800 },
      { amountChangeMode: 'retroactive' },
    );
    ledger = await loadLedger();
    expect(ledger.monthlyCostItems.find((item) => item.id === detached.id)?.amount).toBe(1800);
    expect(ledgerExportPackageSchema.safeParse(buildExportPackage(ledger)).success).toBe(true);

    // 通常IDへ切り離したitemも、購入仕訳が重複していれば後続操作を中断する。
    const purchase = ledger.journalEntries.find(
      (entry) =>
        entry.metadata?.recurringRuleId === successor.id &&
        entry.metadata.monthlyCostId === detached.id,
    )!;
    await putRecord(STORE.journalEntries, {
      ...purchase,
      id: 'duplicate-neutral-purchase',
      metadata: { monthlyCostId: detached.id },
    });
    await expect(deleteRecurringRule(successor.id)).rejects.toMatchObject({
      code: 'error.recurring.generatedDependency',
    });
  });

  it('金額を変えない費用→直接フロー編集でも、過去itemは次回起票を止めない', async () => {
    const bank = await accountByName('預金');
    const fixed = await accountByName('固定費');
    const invest = await accountByName('投資');
    const rule = await createRecurringRule({
      name: '年払いから月次積立へ',
      amount: 12000,
      dayOfMonth: 20,
      everyMonths: 12,
      debitAccountId: fixed.id,
      creditAccountId: bank.id,
      startMonth: '2026-04',
      startDate: '2026-04-12',
    });
    await catchUpRecurringRules('2026-04-20');
    const stored = (await loadLedger()).recurringRules.find((candidate) => candidate.id === rule.id)!;
    const changed = { ...stored, everyMonths: 1, debitAccountId: invest.id };
    delete changed.spreadExpenseAccountId;
    await upsertRecurringRule(changed);

    const beforeCatchUp = await loadLedger();
    expect(
      recurringProjectionEntries(
        beforeCatchUp.recurringRules,
        beforeCatchUp.accounts,
        '2026-05-20',
        beforeCatchUp.monthlyCostItems,
      ).some(
        (entry) =>
          entry.metadata?.recurringRuleId === rule.id &&
          entry.metadata.recurringMonth === '2026-05',
      ),
    ).toBe(true);
    expect(await catchUpRecurringRules('2026-05-20')).toBe(1);
    const ledger = await loadLedger();
    expect(
      ledger.journalEntries.find(
        (entry) =>
          entry.metadata?.recurringRuleId === rule.id &&
          entry.metadata.recurringMonth === '2026-05',
      )?.lines,
    ).toEqual(
      expect.arrayContaining([
        { accountId: invest.id, side: 'debit', amount: 12000 },
        { accountId: bank.id, side: 'credit', amount: 12000 },
      ]),
    );
    expect(ledgerExportPackageSchema.safeParse(buildExportPackage(ledger)).success).toBe(true);
  });

  it('分岐で通常IDへ切り離したitemは、再び費用行きにしたとき決定的IDへ戻す', async () => {
    const bank = await accountByName('預金');
    const fixed = await accountByName('固定費');
    const invest = await accountByName('投資');
    const rule = await createRecurringRule({
      name: '年払いの行き先往復',
      amount: 12000,
      dayOfMonth: 20,
      everyMonths: 12,
      debitAccountId: fixed.id,
      creditAccountId: bank.id,
      startMonth: '2026-04',
      startDate: '2026-04-12',
    });
    await catchUpRecurringRules('2026-04-20');
    const stored = (await loadLedger()).recurringRules.find((candidate) => candidate.id === rule.id)!;
    const direct = { ...stored, amount: 1500, everyMonths: 1, debitAccountId: invest.id };
    delete direct.spreadExpenseAccountId;
    await upsertRecurringRule(direct, {
      amountChangeMode: 'split',
      effectiveDate: '2026-04-20',
    });

    let ledger = await loadLedger();
    const successor = ledger.recurringRules.find((candidate) => candidate.id !== rule.id)!;
    const detachedItem = ledger.monthlyCostItems[0]!;
    expect(detachedItem.id.startsWith(`ccr-${successor.id}-`)).toBe(false);

    await upsertRecurringRule({ ...successor, debitAccountId: fixed.id });

    ledger = await loadLedger();
    const expectedItemId = `ccr-${successor.id}-2026-04`;
    expect(ledger.monthlyCostItems.some((item) => item.id === detachedItem.id)).toBe(false);
    expect(ledger.monthlyCostItems.find((item) => item.id === expectedItemId)).toMatchObject({
      amount: 1500,
      expenseAccountId: fixed.id,
    });
    expect(
      ledger.journalEntries.find(
        (entry) =>
          entry.metadata?.recurringRuleId === successor.id &&
          entry.metadata.recurringMonth === '2026-04',
      )?.metadata?.monthlyCostId,
    ).toBe(expectedItemId);
    // 既存の年払い item が 2027-03 まで被覆するため、当該期間は二重起票しない。
    expect(await catchUpRecurringRules('2026-05-20')).toBe(0);
    expect(ledgerExportPackageSchema.safeParse(buildExportPackage(await loadLedger())).success).toBe(
      true,
    );
  });

  it('ルール由来仕訳は由来月をまたぐ日付へ編集できない', async () => {
    const bank = await accountByName('預金');
    const invest = await accountByName('投資');
    const rule = await createRecurringRule({
      name: '日付境界',
      amount: 1000,
      dayOfMonth: 20,
      debitAccountId: invest.id,
      creditAccountId: bank.id,
      startMonth: '2026-04',
      startDate: '2026-04-12',
    });
    await catchUpRecurringRules('2026-04-20');
    const posted = (await loadLedger()).journalEntries.find(
      (entry) => entry.metadata?.recurringRuleId === rule.id,
    )!;

    await expect(upsertEntry({ ...posted, date: '2026-05-01' })).rejects.toMatchObject({
      code: 'error.recurring.periodInvalid',
    });
  });

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
      startDate: '2026-05-01',
    });
    // catchUp がカーソルを進めたあと、進める前に読んだ古いオブジェクトで編集を保存する。
    expect(await catchUpRecurringRules('2026-07-23')).toBe(3);
    await upsertRecurringRule(
      { ...stale, amount: 12000 },
      { amountChangeMode: 'retroactive' },
    );
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
      startDate: '2026-06-01',
    });
    await deleteRecurringRule(stale.id);
    await expect(upsertRecurringRule({ ...stale, amount: 6000 })).rejects.toMatchObject({
      code: 'error.recurring.notFound',
    });
    const ledger = await loadLedger();
    expect(ledger.recurringRules.some((r) => r.id === stale.id)).toBe(false);
  });
});

describe('月割りするルール（spreadExpenseAccountId・継続コスト化）', () => {
  async function createSpreadRule() {
    const bank = await accountByName('預金');
    const fixed = await accountByName('固定費');
    const rule = await createRecurringRule({
      name: '火災保険',
      amount: 60000,
      dayOfMonth: 25,
      everyMonths: 12,
      spreadExpenseAccountId: fixed.id,
      debitAccountId: fixed.id,
      creditAccountId: bank.id,
      startMonth: '2026-04',
      startDate: '2026-04-25',
    });
    return { rule, bank, fixed };
  }

  it('1 起票 = 2 レコード: 購入の仕訳（借方 台帳・monthlyCostId 付き）+ item（endDate = 周期末）', async () => {
    const { rule, bank, fixed } = await createSpreadRule();
    expect(await catchUpRecurringRules('2026-07-23')).toBe(1);
    const ledger = await loadLedger();
    const item = ledger.monthlyCostItems.find((m) => m.id === `ccr-${rule.id}-2026-04`);
    expect(item).toBeDefined();
    expect(item!.name).toBe('火災保険');
    expect(item!.amount).toBe(60000);
    expect(item!.startDate).toBe('2026-04-25');
    expect(item!.endDate).toBe('2027-03-31'); // 周期がカバーする最終月の末日（§7-4）
    expect(item!.expenseAccountId).toBe(fixed.id);
    const purchase = ledger.journalEntries.find((e) => e.metadata?.monthlyCostId === item!.id);
    expect(purchase).toBeDefined();
    expect(purchase!.date).toBe('2026-04-25');
    expect(purchase!.metadata?.recurringRuleId).toBe(rule.id);
    expect(purchase!.lines).toEqual([
      { accountId: CONTINUOUS_COST_LEDGER_ACCOUNT_ID, side: 'debit', amount: 60000 },
      { accountId: bank.id, side: 'credit', amount: 60000 },
    ]);
    // export → schema round-trip（不変条件⑤⑥⑦を満たす形で保存される）。
    expect(ledgerExportPackageSchema.safeParse(buildExportPackage(ledger)).success).toBe(true);
  });

  it('べき等: 2 回連続の catchUp で item・仕訳が増えず、item のユーザー編集が保持される（§13-11）', async () => {
    const { rule } = await createSpreadRule();
    await catchUpRecurringRules('2026-07-23');
    const itemId = `ccr-${rule.id}-2026-04`;
    const before = await loadLedger();
    const item = before.monthlyCostItems.find((m) => m.id === itemId)!;
    // ユーザー編集（終了日を縮める）。
    await upsertMonthlyCost({ ...item, endDate: '2026-09-30' });
    expect(await catchUpRecurringRules('2026-07-23')).toBe(0);
    const after = await loadLedger();
    expect(after.monthlyCostItems.filter((m) => m.id === itemId)).toHaveLength(1);
    expect(after.monthlyCostItems.find((m) => m.id === itemId)?.endDate).toBe('2026-09-30');
  });

  it('「今月はスキップ」= item 削除（購入の仕訳ごと消える）。カーソルは戻らず再生成されない（§13-11）', async () => {
    const { rule } = await createSpreadRule();
    await catchUpRecurringRules('2026-07-23');
    const itemId = `ccr-${rule.id}-2026-04`;
    await deleteMonthlyCost(itemId);
    const mid = await loadLedger();
    expect(mid.monthlyCostItems.some((m) => m.id === itemId)).toBe(false);
    expect(mid.journalEntries.some((e) => e.metadata?.monthlyCostId === itemId)).toBe(false);
    expect(await catchUpRecurringRules('2026-07-23')).toBe(0);
    expect((await loadLedger()).monthlyCostItems.some((m) => m.id === itemId)).toBe(false);
  });

  it('未来断面で台帳が積み上がらない（§13-1: 5年後の asOf で残高 = まだ費用にしていないぶんのみ）', async () => {
    const { rule } = await createSpreadRule();
    await catchUpRecurringRules('2026-07-23');
    const ledger = await loadLedger();
    const derived = reportEntriesForAsOf(ledger, '2031-12-31');
    // 投影は購入行だけでなく費用行（cc-recogp）も出す。
    expect(derived.some((e) => e.id.startsWith(`cc-recogp-${rule.id}-`))).toBe(true);
    // 台帳残高 = 2031-04 サイクルの未費消ぶんのみ（2032-01〜03 = 15,000）。購入総額 360,000 にはならない。
    const balance = accountBalance(
      CONTINUOUS_COST_LEDGER_ACCOUNT_ID,
      'asset',
      filterByDateRange(derived, undefined, '2031-12-31'),
    );
    expect(balance).toBe(15000);
    // PL: 2031 年の費用は 0 ではない（毎月 5,000）。
    const pl = deriveProfitAndLoss(ledger.accounts, derived, {
      from: '2031-01-01',
      to: '2031-12-31',
    });
    expect(pl.totalExpense).toBe(60000);
  });

  it('everyMonths = 1 でも月割りできる（毎月の家賃も台帳経由: item は起票日開始・当月末終了）', async () => {
    const bank = await accountByName('預金');
    const fixed = await accountByName('固定費');
    const rule = await createRecurringRule({
      name: '家賃',
      amount: 80000,
      dayOfMonth: 27,
      everyMonths: 1,
      spreadExpenseAccountId: fixed.id,
      debitAccountId: fixed.id, // spread では無視され台帳に固定される
      creditAccountId: bank.id,
      startMonth: '2026-06',
      startDate: '2026-06-27',
    });
    // 6/27・7/27 の 2 起票（今日 = 2026-07-27）。
    expect(await catchUpRecurringRules('2026-07-27')).toBe(2);
    const ledger = await loadLedger();
    const june = ledger.monthlyCostItems.find((m) => m.id === `ccr-${rule.id}-2026-06`)!;
    expect(june.startDate).toBe('2026-06-27');
    expect(june.endDate).toBe('2026-06-30'); // 周期 1 → 当月末（毎月生まれて消える）
    const july = ledger.monthlyCostItems.find((m) => m.id === `ccr-${rule.id}-2026-07`)!;
    expect(july.endDate).toBe('2026-07-31');
    // 支出内訳では「継続コスト」に分類される（6 月ぶんは 6 月内で全額認識）。
    const derived = reportEntriesForAsOf(ledger, '2026-07-31');
    const juneCost = livingCostBreakdownForRange(ledger.accounts, derived, {
      from: '2026-06-01',
      to: '2026-06-30',
    });
    expect(juneCost.monthlyCost).toBe(80000);
    expect(juneCost.normalExpense).toBe(0);
    // 台帳残高は月末で 0（起票日開始・当月末終了 = 同月内で費消しきる）。
    const balance = accountBalance(
      CONTINUOUS_COST_LEDGER_ACCOUNT_ID,
      'asset',
      filterByDateRange(derived, undefined, '2026-07-31'),
    );
    expect(balance).toBe(0);
    // export → schema round-trip。
    expect(ledgerExportPackageSchema.safeParse(buildExportPackage(ledger)).success).toBe(true);
  });

  it('費用以外の行き先は直接フローとして保存する', async () => {
    const bank = await accountByName('預金');
    const salary = await accountByName('給与'); // income-category
    // 行き先 = 給与（収入減）・支払い元 = 銀行。給与は費用科目ではないため直接フロー。
    const rule = await createRecurringRule({
      name: '健康保険',
      amount: 4000,
      dayOfMonth: 1,
      everyMonths: 1,
      debitAccountId: salary.id,
      creditAccountId: bank.id,
      startMonth: '2026-07',
      startDate: '2026-07-01',
    });
    expect(await catchUpRecurringRules('2026-07-23')).toBe(1);
    const ledger = await loadLedger();
    const saved = ledger.recurringRules.find((candidate) => candidate.id === rule.id)!;
    expect(saved.spreadExpenseAccountId).toBeUndefined();
    expect(saved.debitAccountId).toBe(salary.id);
    expect(ledger.monthlyCostItems.find((m) => m.id === `ccr-${rule.id}-2026-07`)).toBeUndefined();
    const derived = reportEntriesForAsOf(ledger, '2026-07-31');
    // 月末断面: 銀行 −4,000・給与（revenue）−4,000。item は作らない。
    expect(accountBalance(bank.id, 'asset', derived)).toBeLessThan(0);
    expect(accountBalance(salary.id, 'revenue', derived)).toBe(-4000);
    expect(ledgerExportPackageSchema.safeParse(buildExportPackage(ledger)).success).toBe(true);
  });

  it('支払い元（貸方）に income-category を指定した月割りルールも起票できる', async () => {
    const salary = await accountByName('給与');
    const fixed = await accountByName('固定費');
    const rule = await createRecurringRule({
      name: '天引きの月割り',
      amount: 3000,
      dayOfMonth: 1,
      everyMonths: 1,
      spreadExpenseAccountId: fixed.id,
      debitAccountId: fixed.id,
      creditAccountId: salary.id, // 支払い元 = 給与（income-category）
      startMonth: '2026-07',
      startDate: '2026-07-01',
    });
    expect(await catchUpRecurringRules('2026-07-23')).toBe(1);
    const ledger = await loadLedger();
    const purchase = ledger.journalEntries.find(
      (e) => e.metadata?.monthlyCostId === `ccr-${rule.id}-2026-07`,
    )!;
    expect(purchase.lines).toEqual([
      { accountId: CONTINUOUS_COST_LEDGER_ACCOUNT_ID, side: 'debit', amount: 3000 },
      { accountId: salary.id, side: 'credit', amount: 3000 },
    ]);
    expect(ledgerExportPackageSchema.safeParse(buildExportPackage(ledger)).success).toBe(true);
  });
});
