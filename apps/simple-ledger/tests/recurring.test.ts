/*
 * 定期ルール（毎月の支出・収入・振替 = 実仕訳の自動起票）。
 *  - キャッチアップ起票: 経過月ぶんを実仕訳として起票・idempotent・月末クランプ。
 *  - カーソル: 起票済み仕訳を削除しても再起票しない（スキップの尊重）。
 *  - 存在期間: 停止は持たず、終了と独立した新しい線分で表す。
 *  - everyMonths: startMonth 基点の位相で間引く（周期起票）。
 *  - 月割りするルール（spreadExpenseAccountId）: 起票 = 購入の仕訳 + item の 2 レコード 1 tx・
 *    未来投影は購入行 + 費用行の両方（台帳が積み上がらない = §13-1）。
 *  - 読み取り専用: 起票された仕訳（rec-）・item（ccr-）は保存境界で直接編集・削除できない。
 *  - 削除: ルール削除はカスケード（ルール + 起票済み仕訳 + item + 購入の仕訳）。
 *    反対仕訳・回収の振替は利用者自身の実仕訳なので残り、宙に浮く参照だけ剥がれる。
 *  - export → schema round-trip / 必須キー欠落の拒否。
 *
 * 個別編集済みの月を作る検証では、保存境界が塞がれているため putRecord で DB へ直接置く
 * （旧データ・別経路で生まれた個別編集を、ルール側の遡及・分割がどう扱うかの検証は残す）。
 */
import { describe, expect, it } from 'vitest';
import './setup';
import {
  archiveMonthlyCost,
  catchUpRecurringRules,
  createRecurringRule,
  deleteEntry,
  deleteMonthlyCost,
  deleteRecurringRule,
  loadLedger,
  upsertEntry,
  upsertMonthlyCost,
  upsertRecurringRule,
} from '../src/data/repository';
import {
  clampDayToMonth,
  projectedRuleItems,
  recurringProjectionEntries,
} from '../src/domain/recurring';
import { earliestRecurringRuleEndDate } from '../src/domain/accountLifetime';
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

  it('1本の破損ルールを警告して飛ばし、他のルールは起票する', async () => {
    const bank = await accountByName('預金');
    const invest = await accountByName('投資');
    const broken = await createRecurringRule({
      name: '破損ルール',
      amount: 1000,
      dayOfMonth: 1,
      debitAccountId: invest.id,
      creditAccountId: bank.id,
      startMonth: '2026-07',
      startDate: '2026-07-01',
    });
    const healthy = await createRecurringRule({
      name: '正常ルール',
      amount: 2000,
      dayOfMonth: 1,
      debitAccountId: invest.id,
      creditAccountId: bank.id,
      startMonth: '2026-07',
      startDate: '2026-07-01',
    });
    await putRecord(STORE.recurringRules, { ...broken, debitAccountId: 'missing-account' });

    const failures: string[] = [];
    expect(await catchUpRecurringRules('2026-07-01', ({ ruleId }) => failures.push(ruleId))).toBe(
      1,
    );
    expect(failures).toEqual([broken.id]);

    const ledger = await loadLedger();
    expect(ledger.journalEntries.some((entry) => entry.id === `rec-${healthy.id}-2026-07`)).toBe(
      true,
    );
    expect(ledger.journalEntries.some((entry) => entry.id === `rec-${broken.id}-2026-07`)).toBe(
      false,
    );
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

  it('起票済み仕訳は個別に削除できない（読み取り専用・ルール側で調整する）', async () => {
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
    await expect(deleteEntry(posted.id)).rejects.toMatchObject({
      code: 'error.recurring.generatedReadOnly',
    });
    expect((await loadLedger()).journalEntries.some((e) => e.id === posted.id)).toBe(true);
    expect(await catchUpRecurringRules('2026-07-23')).toBe(0);
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

  it('ルール削除は起票済み仕訳を道連れにし、反対仕訳だけ参照を剥がして残す（カスケード）', async () => {
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
    await deleteRecurringRule(rule.id);

    const ledger = await loadLedger();
    expect(ledger.recurringRules.length).toBe(0);
    // 積み木の下（ルール）が消えれば上（起票）も消える。
    expect(ledger.journalEntries.some((e) => e.id === generated.id)).toBe(false);
    expect(ledger.journalEntries.some((e) => e.description === '積立')).toBe(false);
    // 利用者自身が切った反対仕訳は最下層の積み木なので残り、宙に浮く参照だけ剥がれる。
    const reversal = ledger.journalEntries.find((e) => e.id === 'rule-delete-reversal')!;
    expect(reversal).toBeDefined();
    expect(reversal.metadata?.reversalOfEntryId).toBeUndefined();
    // カスケード後も export → schema 検証が通る（strict な存在チェックと両立）。
    const parsed = ledgerExportPackageSchema.safeParse(buildExportPackage(ledger));
    expect(parsed.success).toBe(true);
  });

  it('費用ルールを削除すると継続コスト資産も購入の仕訳も一緒に消える（カスケード）', async () => {
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
    expect(ledger.recurringRules).toHaveLength(0);
    // item も購入の仕訳も残らない（通常 ID へ付け替えて残す旧仕様は撤去・作者決定 2026-08-15）。
    expect(ledger.monthlyCostItems).toHaveLength(0);
    expect(ledger.journalEntries.some((entry) => entry.metadata?.monthlyCostId !== undefined)).toBe(
      false,
    );
    expect(ledger.journalEntries.some((entry) => entry.description === '削除後も残る年払い')).toBe(
      false,
    );
    expect(ledgerExportPackageSchema.safeParse(buildExportPackage(ledger)).success).toBe(true);
  });

  it('ccr- item の回収の振替も道連れ（貸方 = 台帳なので item と対でしか成立しない）', async () => {
    const bank = await accountByName('預金');
    const fixed = await accountByName('固定費');
    const rule = await createRecurringRule({
      name: '回収つき年払い',
      amount: 12000,
      dayOfMonth: 1,
      everyMonths: 12,
      debitAccountId: fixed.id,
      creditAccountId: bank.id,
      startMonth: '2026-07',
      startDate: '2026-07-01',
    });
    await catchUpRecurringRules('2026-07-01');
    const itemId = `ccr-${rule.id}-2026-07`;
    // 回収の振替（借方 預金 / 貸方 継続コスト台帳）は利用者が自分で切った実仕訳。
    // ルール由来 item はアーカイブできないので、既存データ相当を DB へ直接置く。
    await putRecord(STORE.journalEntries, {
      id: 'cascade-recovery',
      date: '2026-08-01',
      description: '途中解約の返金',
      kind: 'normal',
      lines: [
        { accountId: bank.id, side: 'debit', amount: 3000 },
        { accountId: CONTINUOUS_COST_LEDGER_ACCOUNT_ID, side: 'credit', amount: 3000 },
      ],
      metadata: { inputMode: 'transfer', monthlyCostId: itemId, monthlyCostRecovery: true },
      createdAt: '2026-08-01T00:00:00.000Z',
      updatedAt: '2026-08-01T00:00:00.000Z',
    });

    await deleteRecurringRule(rule.id);

    const ledger = await loadLedger();
    expect(ledger.monthlyCostItems.some((item) => item.id === itemId)).toBe(false);
    // 台帳にふれる仕訳は monthlyCostId 必須（不変条件⑧）・購入の借方が消えれば台帳残高も
    // 負に落ちるため、振替だけ残すことはできない。継続コスト item 単体の削除と同じ規則。
    expect(ledger.journalEntries.some((entry) => entry.id === 'cascade-recovery')).toBe(false);
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

  it('簿記編集: 健康保険（銀行 → 給与の差引形）は spread 正規形へ正規化して台帳経由で起票する', async () => {
    const bank = await accountByName('預金');
    const income = await accountByName('給与'); // income-category
    // 旧形の入力（借方 = 収入カテゴリ直）でも、保存境界が費用ルールと同じ spread 正規形へ
    // 正規化する（§2: 給与から差し引く形も継続コスト台帳を経由する）。
    const rule = await createRecurringRule({
      name: '健康保険',
      amount: 4000,
      dayOfMonth: 5,
      debitAccountId: income.id,
      creditAccountId: bank.id,
      startMonth: '2026-07',
      startDate: '2026-07-05',
    });
    expect(rule.debitAccountId).toBe(CONTINUOUS_COST_LEDGER_ACCOUNT_ID);
    expect(rule.spreadExpenseAccountId).toBe(income.id);
    expect(await catchUpRecurringRules('2026-07-23')).toBe(1);
    const ledger = await loadLedger();
    const posted = ledger.journalEntries.find((e) => e.metadata?.recurringRuleId)!;
    // 起票形は費用ルールと同一（借方 台帳 / 貸方 源泉・inputMode も同じ）。
    expect(posted.metadata?.inputMode).toBe('expense');
    expect(posted.lines).toEqual([
      { accountId: CONTINUOUS_COST_LEDGER_ACCOUNT_ID, side: 'debit', amount: 4000 },
      { accountId: bank.id, side: 'credit', amount: 4000 },
    ]);
    expect(
      ledger.monthlyCostItems.find((m) => m.id === `ccr-${rule.id}-2026-07`)?.expenseAccountId,
    ).toBe(income.id);
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

  it('未来基準日まで全期間をひとつの導出で出す（保存済みかどうかで行は変わらない）', async () => {
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
    // v13: 月割り行は item（ccr-）帰属で recurringRuleId を持たない。ルールの寄与 =
    // 購入行（recurringRuleId）+ 導出 item の月割り行（continuousCostId の ccr- 接頭辞）。
    const allForRule = entries.filter(
      (entry) =>
        entry.metadata?.recurringRuleId === rule.id ||
        (entry.metadata?.continuousCostId ?? '').startsWith(`ccr-${rule.id}-`),
    );
    const forRule = allForRule
      .filter((entry) => entry.metadata?.ccKind !== 'monthly-allocation')
      .sort((a, b) => a.date.localeCompare(b.date));
    expect(forRule.map((entry) => entry.metadata?.recurringMonth)).toEqual([
      '2026-07',
      '2026-08',
      '2026-09',
      '2026-10',
    ]);
    // v13: ルール由来はすべて導出行（virtual）。起票済み・未起票の区別は存在しない。
    expect(forRule.map((entry) => entry.metadata?.virtual ?? false)).toEqual([
      true,
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

describe('clampDayToMonth / recurringProjectionEntries', () => {
  it('31 日は月末へクランプされる', () => {
    expect(clampDayToMonth('2026-02', 31)).toBe('2026-02-28');
    expect(clampDayToMonth('2024-02', 31)).toBe('2024-02-29');
    expect(clampDayToMonth('2026-04', 31)).toBe('2026-04-30');
  });

  it('projectedRuleItems は未起票周期の表示専用 item を投影と同じ規則で出す', () => {
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
    // 月割りトグル ON の保存済み正規形（借方 = 継続コスト台帳・spread = 計上先）。
    const rule = {
      id: 'rule',
      name: '家賃',
      amount: 80000,
      dayOfMonth: 27,
      debitAccountId: CONTINUOUS_COST_LEDGER_ACCOUNT_ID,
      spreadExpenseAccountId: 'expense',
      creditAccountId: 'cash',
      everyMonths: 1,
      startMonth: '2026-07',
      startDate: '2026-07-01',
      postedThroughMonth: '2026-07',
      createdAt: 't',
      updatedAt: 't',
    };
    const projectedItems = projectedRuleItems([rule], accounts, '2026-10-31');
    // カーソル（2026-07）より後・asOf までの起票 = 8/27・9/27・10/27 の 3 件。
    // item は [起票日, 次回起票日]（同日刻み・endDate = 次回起票日）。
    expect(projectedItems.map((p) => [p.item.id, p.item.startDate, p.item.endDate])).toEqual([
      ['rule-2026-08', '2026-08-27', '2026-09-27'],
      ['rule-2026-09', '2026-09-27', '2026-10-27'],
      ['rule-2026-10', '2026-10-27', '2026-11-27'],
    ]);
    // 投影の購入行（continuousCostId）と同じ ephemeral ID = 由来の対応が 1:1（単一正本）。
    const projected = recurringProjectionEntries([rule], accounts, '2026-10-31');
    expect(
      projected
        .filter((entry) => entry.id.startsWith('rec-proj-'))
        .map((entry) => entry.metadata?.continuousCostId),
    ).toEqual(projectedItems.map((p) => p.item.id));
    // 直接起票（月割りトグル OFF）のルールからは 1 件も出ない。
    const direct = { ...rule, id: 'direct', debitAccountId: 'cash2' };
    delete (direct as { spreadExpenseAccountId?: string }).spreadExpenseAccountId;
    const cash2: Account = {
      id: 'cash2',
      name: '第二口座',
      type: 'asset',
      role: 'daily-asset',
      archived: false,
      createdAt: 't',
      updatedAt: 't',
    };
    expect(projectedRuleItems([direct], [...accounts, cash2], '2026-10-31')).toEqual([]);
  });

  it('未来投影は決定的IDで存在期間内だけを含む', () => {
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
    // 月割りトグル ON の保存済み正規形（借方 = 継続コスト台帳・spread = 計上先）。
    const base = {
      id: 'rule',
      name: '家賃',
      amount: 80000,
      dayOfMonth: 27,
      debitAccountId: CONTINUOUS_COST_LEDGER_ACCOUNT_ID,
      spreadExpenseAccountId: 'expense',
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
    // 月割り行の刻み日 = 起票日の翌月同日（購入当日の費用 0・item は [起票日, 次回起票日]）:
    //  - 8/27 起票 → item [8/27, 9/27]・刻み 9/27（ID の月は刻み日の月 = 2026-09）
    //  - 9/27 起票 → item [9/27, 10/27]・刻み 10/27
    //  - 10/27 起票 → 刻み 11/27 は asOf(2026-10-31) を越えるので 1 本も出ない
    expect(
      projected
        .filter((entry) => entry.id.startsWith('cc-allocp-'))
        .map((entry) => [entry.id, entry.date]),
    ).toEqual([
      ['cc-allocp-rule-2026-08-2026-09', '2026-09-27'],
      ['cc-allocp-rule-2026-09-2026-10', '2026-10-27'],
    ]);
    expect(projected).toHaveLength(5); // 購入 3 + 月割り 2
    expect(projected.every((entry) => entry.metadata?.continuousCostId !== undefined)).toBe(true);
    expect(recurringProjectionEntries([base], accounts, '2026-10-31')).toEqual(projected);
    expect(
      recurringProjectionEntries([{ ...base, endDate: '2026-09-01' }], accounts, '2026-10-31')
        .filter((entry) => entry.id.startsWith('rec-proj-'))
        .map((entry) => entry.id),
    ).toEqual(['rec-proj-rule-2026-08']);
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
      // 8/27 起票ぶんの刻み日は翌月同日 = 9/27。費用行が現れる 9 月末まで断面を取る
      // （8 月末で切ると購入当日の費用 0 の仕様どおり月割り行が 1 本も無い）。
      '2026-09-30',
    );

    const purchase = projected.find((entry) => entry.id === 'rec-proj-spread-rule-2026-08');
    expect(purchase?.metadata?.continuousCostId).toBe('spread-rule-2026-08');
    const allocation = projected.find((entry) => entry.metadata?.ccKind === 'monthly-allocation');
    expect(allocation?.metadata?.continuousCostId).toBe('spread-rule-2026-08');
    // ID の月・日付は刻み日基準（2026-09-27）。購入行の ephemeral item ID と対応する。
    expect([allocation?.id, allocation?.date]).toEqual([
      'cc-allocp-spread-rule-2026-08-2026-09',
      '2026-09-27',
    ]);
  });

  it('カーソル後の次月から独立して投影する', () => {
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
    expect(
      recurringProjectionEntries([rule], accounts, '2027-02-28').map((entry) => entry.date),
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

  it('全期間の金額変更は複数月と個別編集済みの月をすべて新金額へ揃える', async () => {
    const bank = await accountByName('預金');
    const fixed = await accountByName('固定費');
    const rule = await createRecurringRule({
      name: '複数月の価格訂正',
      amount: 1000,
      dayOfMonth: 20,
      everyMonths: 1,
      debitAccountId: fixed.id,
      creditAccountId: bank.id,
      startMonth: '2026-04',
      startDate: '2026-04-01',
    });
    expect(await catchUpRecurringRules('2026-06-20')).toBe(3);

    let ledger = await loadLedger();
    const mayItem = ledger.monthlyCostItems.find((item) => item.id === `ccr-${rule.id}-2026-05`)!;
    // ルール由来 item は保存境界から編集できないので、個別編集済みの状態は DB へ直接置く。
    await putRecord(STORE.monthlyCostItems, {
      ...mayItem,
      name: '手編集済み5月分',
      endDate: '2026-06-30',
    });

    ledger = await loadLedger();
    await upsertRecurringRule(
      { ...ledger.recurringRules.find((candidate) => candidate.id === rule.id)!, amount: 2000 },
      { amountChangeMode: 'retroactive' },
    );

    ledger = await loadLedger();
    const items = ledger.monthlyCostItems.filter((item) => item.id.startsWith(`ccr-${rule.id}-`));
    expect(items).toHaveLength(3);
    expect(items.every((item) => item.amount === 2000)).toBe(true);
    expect(items.find((item) => item.id === mayItem.id)).toMatchObject({
      name: '手編集済み5月分',
      endDate: '2026-06-30',
    });
    expect(
      ledger.journalEntries
        .filter((entry) => entry.metadata?.recurringRuleId === rule.id)
        .every((entry) => entry.lines.every((line) => line.amount === 2000)),
    ).toBe(true);
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
      upsertRecurringRule({ ...rule, amount: 1500 }, { amountChangeMode: 'retroactive' }),
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

  it('分割月の旧起票日が境界前なら、後継の起票日を後ろへ変えても同月を二重起票しない', async () => {
    const bank = await accountByName('預金');
    const invest = await accountByName('投資');
    const rule = await createRecurringRule({
      name: '当月の所有segment',
      amount: 1000,
      dayOfMonth: 20,
      debitAccountId: invest.id,
      creditAccountId: bank.id,
      startMonth: '2026-04',
      startDate: '2026-04-12',
    });

    await upsertRecurringRule(
      { ...rule, amount: 1500, dayOfMonth: 25 },
      { amountChangeMode: 'split', effectiveDate: '2026-04-22' },
    );
    expect(await catchUpRecurringRules('2026-04-25')).toBe(1);

    const ledger = await loadLedger();
    const successor = ledger.recurringRules.find((candidate) => candidate.id !== rule.id)!;
    expect(successor.postedThroughMonth).toBe('2026-04');
    expect(
      ledger.journalEntries.filter((entry) => entry.metadata?.recurringMonth === '2026-04'),
    ).toEqual([expect.objectContaining({ id: `rec-${rule.id}-2026-04`, date: '2026-04-20' })]);
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
    const finite = (await loadLedger()).recurringRules.find(
      (candidate) => candidate.id === rule.id,
    )!;
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

  it('分割系譜の期間重複は拒否し、隙間と位相の編集は許す', async () => {
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
    await upsertRecurringRule({ ...predecessor, startMonth: '2026-03' });
    await upsertRecurringRule({ ...successor, startMonth: '2026-05', startDate: '2026-04-23' });
    ledger = await loadLedger();
    expect(
      ledger.recurringRules.find((candidate) => candidate.id === predecessor.id)?.startMonth,
    ).toBe('2026-03');
    expect(ledger.recurringRules.find((candidate) => candidate.id === successor.id)).toMatchObject({
      startMonth: '2026-05',
      startDate: '2026-04-23',
    });
    expect(ledgerExportPackageSchema.safeParse(buildExportPackage(ledger)).success).toBe(true);

    // 片方の segment を物理削除した後は、残った線分の連鎖参照も剥がす。
    await deleteRecurringRule(predecessor.id);
    ledger = await loadLedger();
    expect(ledger.recurringRules).toHaveLength(1);
    expect(ledger.recurringRules[0]?.splitFromRuleId).toBeUndefined();
    expect(ledgerExportPackageSchema.safeParse(buildExportPackage(ledger)).success).toBe(true);
  });

  it('分割連鎖の中間segmentを削除しても系譜はつながったままで、旧segmentを開き直せない', async () => {
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
    const last = ledger.recurringRules.find((rule) => rule.splitFromRuleId === middle.id)!;
    expect(last).toBeDefined();
    await deleteRecurringRule(middle.id);

    ledger = await loadLedger();
    expect(ledger.recurringRules.map((rule) => rule.id).sort()).toEqual([first.id, last.id].sort());
    // 参照を捨てず祖父へ付け替える。捨てると系譜が割れ、first の終了日を外して
    // 同じ月を first と last の両方から起票できてしまう（監査 P2-2）。
    const survivor = ledger.recurringRules.find((rule) => rule.id === last.id)!;
    expect(survivor.splitFromRuleId).toBe(first.id);
    expect(ledgerExportPackageSchema.safeParse(buildExportPackage(ledger)).success).toBe(true);

    // 系譜がつながっているので、first を無期限へ開き直す編集は拒否される。
    const reopened = { ...ledger.recurringRules.find((rule) => rule.id === first.id)! };
    delete reopened.endDate;
    await expect(upsertRecurringRule(reopened)).rejects.toThrow();
  });

  it('分割後継の削除は起票を道連れにし、旧segmentを開き直しても継承カーソルで再起票しない', async () => {
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
    // 後継が走査した月は親のカーソルへ継承する（復旧は親の再オープンではなく登録し直し）。
    expect(remaining).toMatchObject({ endDate: '2026-04-22', postedThroughMonth: '2026-05' });
    // 後継が起票した 5 月分はカスケードで消える。
    expect(
      ledger.journalEntries.filter(
        (entry) => entry.date === '2026-05-20' && entry.description === '後継削除後の境界',
      ),
    ).toHaveLength(0);
    const reopened = { ...remaining };
    delete reopened.endDate;
    await upsertRecurringRule(reopened);
    expect(await catchUpRecurringRules('2026-05-20')).toBe(0);
    expect(
      (await loadLedger()).journalEntries.filter(
        (entry) => entry.date === '2026-05-20' && entry.description === '後継削除後の境界',
      ),
    ).toHaveLength(0);
  });

  it('カーソルが遅れている状態で起票日を後ろへ動かして分割しても、同じ月を二重起票しない', async () => {
    // 分割後継のカーソルは「旧segmentが境界前に起票し得る最後の位相」と継承値の遅い方を採る。
    // 継承値だけを使うと、旧が 7/20 に起票する月を後継も 7/31 に起票して 2 件になる（監査 P3-1）。
    const bank = await accountByName('預金');
    const invest = await accountByName('投資');
    const rule = await createRecurringRule({
      name: 'カーソル遅れの分割',
      amount: 1000,
      dayOfMonth: 20,
      debitAccountId: invest.id,
      creditAccountId: bank.id,
      startMonth: '2026-06',
      startDate: '2026-06-01',
    });
    await catchUpRecurringRules('2026-07-15');
    expect((await loadLedger()).recurringRules[0]?.postedThroughMonth).toBe('2026-06');

    await upsertRecurringRule(
      { ...(await loadLedger()).recurringRules[0]!, amount: 1500, dayOfMonth: 31 },
      { amountChangeMode: 'split', effectiveDate: '2026-07-31' },
    );
    let ledger = await loadLedger();
    const successor = ledger.recurringRules.find((r) => r.id !== rule.id)!;
    expect(successor.postedThroughMonth).toBe('2026-07');

    await catchUpRecurringRules('2026-07-31');
    ledger = await loadLedger();
    const july = ledger.journalEntries
      .filter((e) => e.description === 'カーソル遅れの分割' && e.date.startsWith('2026-07'))
      .map((e) => `${e.date} ${e.lines.find((l) => l.side === 'debit')?.amount}`)
      .sort();
    expect(july).toEqual(['2026-07-20 1000']);

    await catchUpRecurringRules('2026-08-31');
    expect(
      (await loadLedger()).journalEntries
        .filter((e) => e.description === 'カーソル遅れの分割' && e.date.startsWith('2026-08'))
        .map((e) => `${e.date} ${e.lines.find((l) => l.side === 'debit')?.amount}`),
    ).toEqual(['2026-08-31 1500']);
  });

  it('当日すでに起票済みのルールも「終了」できる（終了点は翌日）', async () => {
    // 「終了」= 今日以降は生まない。今日の事実は存在期間の中にあるので終了点は翌日になる（監査 P2-1）。
    const bank = await accountByName('預金');
    const invest = await accountByName('投資');
    await createRecurringRule({
      name: '当日終了',
      amount: 1000,
      dayOfMonth: 20,
      debitAccountId: invest.id,
      creditAccountId: bank.id,
      startMonth: '2026-04',
      startDate: '2026-04-12',
    });
    await catchUpRecurringRules('2026-04-20');
    const ledger = await loadLedger();
    const rule = ledger.recurringRules[0]!;
    // 当日を終了点にすると、当日の起票が半開区間の外に出て保存境界が拒否する。
    await expect(upsertRecurringRule({ ...rule, endDate: '2026-04-20' })).rejects.toThrow();
    // UI が使う最小終了点は翌日。
    expect(earliestRecurringRuleEndDate(rule, ledger.journalEntries, '2026-04-20')).toBe(
      '2026-04-21',
    );
    await upsertRecurringRule({
      ...rule,
      endDate: earliestRecurringRuleEndDate(rule, ledger.journalEntries, '2026-04-20'),
    });
    expect((await loadLedger()).recurringRules[0]?.endDate).toBe('2026-04-21');
    // 起票が無い日に終了するなら今日のまま。
    expect(earliestRecurringRuleEndDate(rule, ledger.journalEntries, '2026-05-01')).toBe(
      '2026-05-01',
    );
  });

  it('終了点を縮めてもカーソルは後退しない（同じ月を二重起票しない）', async () => {
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
    const stored = ledger.recurringRules.find((candidate) => candidate.id === rule.id)!;
    // 起票済み（7/1）の翌日で終了 = 起票された事実は存在期間の中に残る最小の終了点。
    await upsertRecurringRule({ ...stored, endDate: '2026-07-02' });

    ledger = await loadLedger();
    expect(ledger.recurringRules[0]).toMatchObject({
      endDate: '2026-07-02',
      postedThroughMonth: '2026-07',
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
    // ルール由来 item は保存境界から編集できないので、個別編集済みの状態は DB へ直接置く。
    await putRecord(STORE.monthlyCostItems, {
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
      ledger.journalEntries
        .find((entry) => entry.metadata?.recurringRuleId === successor.id)
        ?.lines.every((line) => line.amount === 1500),
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

  it('月初の分岐ではカーソルを後退させず、起票済み当月分を後継へ渡す', async () => {
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
    expect(predecessor.postedThroughMonth).toBe('2026-08');
    expect(successor.postedThroughMonth).toBe('2026-08');
    expect(
      ledger.journalEntries.find((entry) => entry.metadata?.recurringRuleId === successor.id),
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

    // UI と同じく、行き先（論理）と月割りトグル ON（spread = 計上先）を明示して渡す。
    await upsertRecurringRule(
      { ...stored, amount: 1500, debitAccountId: fixed.id, spreadExpenseAccountId: fixed.id },
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
      ledger.monthlyCostItems.find((candidate) => candidate.id === `ccr-${successor.id}-2026-05`),
    ).toMatchObject({ amount: 1500, expenseAccountId: fixed.id });
    // 境界当日の直接フロー（itemなし）と翌月の費用フロー（itemあり）が混在しても、
    // 後継ルールの通常編集は依存関係破損と誤判定しない。
    const currentSuccessor = ledger.recurringRules.find(
      (candidate) => candidate.id === successor.id,
    )!;
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
    await upsertRecurringRule(changed, { amountChangeMode: 'split', effectiveDate: '2026-04-20' });

    let ledger = await loadLedger();
    const successor = ledger.recurringRules.find((r) => r.id !== rule.id)!;
    const detached = ledger.monthlyCostItems[0]!;
    expect(detached.id.startsWith(`ccr-${successor.id}-`)).toBe(false);
    // 生成時のルール（everyMonths 12・dayOfMonth 20）で決まった endDate を保つ:
    // 起票月 2026-04 + 12 か月 = 2027-04 の 20 日（次回起票日と同日）。
    expect(detached).toMatchObject({ amount: 1500, endDate: '2027-04-20' });
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
      {
        ...ledger.recurringRules.find((candidate) => candidate.id === successor.id)!,
        amount: 1800,
      },
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
    const stored = (await loadLedger()).recurringRules.find(
      (candidate) => candidate.id === rule.id,
    )!;
    const changed = { ...stored, everyMonths: 1, debitAccountId: invest.id };
    delete changed.spreadExpenseAccountId;
    await upsertRecurringRule(changed);

    const beforeCatchUp = await loadLedger();
    expect(
      recurringProjectionEntries(
        beforeCatchUp.recurringRules,
        beforeCatchUp.accounts,
        '2026-05-20',
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
    const stored = (await loadLedger()).recurringRules.find(
      (candidate) => candidate.id === rule.id,
    )!;
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

    await upsertRecurringRule({
      ...successor,
      debitAccountId: fixed.id,
      spreadExpenseAccountId: fixed.id,
    });

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
    // 既存itemは生成時の事実として残り、新しい周期は次月から独立して起票する。
    expect(await catchUpRecurringRules('2026-05-20')).toBe(1);
    expect(
      ledgerExportPackageSchema.safeParse(buildExportPackage(await loadLedger())).success,
    ).toBe(true);
  });

  it('ルール由来仕訳は保存境界で編集できない（読み取り専用・調整はルール側）', async () => {
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

    // 由来月をまたぐ日付はもちろん、同じ月の中の摘要変更ですら通さない（fail-closed）。
    await expect(upsertEntry({ ...posted, date: '2026-05-01' })).rejects.toMatchObject({
      code: 'error.recurring.generatedReadOnly',
    });
    await expect(upsertEntry({ ...posted, description: '手で書き換え' })).rejects.toMatchObject({
      code: 'error.recurring.generatedReadOnly',
    });
    // 由来メタを落として通常仕訳のふりをしても、決定的 ID（rec-）で塞がれる。
    const stripped = { ...posted, metadata: { inputMode: 'manual' as const } };
    await expect(upsertEntry(stripped)).rejects.toMatchObject({
      code: 'error.recurring.generatedReadOnly',
    });
    const after = (await loadLedger()).journalEntries.find((entry) => entry.id === posted.id)!;
    expect(after).toMatchObject({ date: posted.date, description: posted.description });
    expect(after.metadata?.recurringRuleId).toBe(rule.id);
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
    await upsertRecurringRule({ ...stale, amount: 12000 }, { amountChangeMode: 'retroactive' });
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

  it('1 起票 = 2 レコード: 購入の仕訳（借方 台帳・monthlyCostId 付き）+ item（endDate = 次回起票日と同日）', async () => {
    const { rule, bank, fixed } = await createSpreadRule();
    expect(await catchUpRecurringRules('2026-07-23')).toBe(1);
    const ledger = await loadLedger();
    const item = ledger.monthlyCostItems.find((m) => m.id === `ccr-${rule.id}-2026-04`);
    expect(item).toBeDefined();
    expect(item!.name).toBe('火災保険');
    expect(item!.amount).toBe(60000);
    expect(item!.startDate).toBe('2026-04-25');
    // 起票月 2026-04 + everyMonths 12 = 2027-04 を dayOfMonth 25 でクランプ = 次回起票日と同日。
    expect(item!.endDate).toBe('2027-04-25');
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
    // 既存データや別経路で個別に変わっていた item を catchUp が上書きしないこと（tx 内の
    // get → undefined のときだけ put）。保存境界は塞がれているので DB へ直接置く。
    await putRecord(STORE.monthlyCostItems, { ...item, endDate: '2026-09-30' });
    expect(await catchUpRecurringRules('2026-07-23')).toBe(0);
    const after = await loadLedger();
    expect(after.monthlyCostItems.filter((m) => m.id === itemId)).toHaveLength(1);
    expect(after.monthlyCostItems.find((m) => m.id === itemId)?.endDate).toBe('2026-09-30');
  });

  it('ルール由来 item（ccr-）は編集も削除もアーカイブもできない（読み取り専用）', async () => {
    const { rule } = await createSpreadRule();
    await catchUpRecurringRules('2026-07-23');
    const itemId = `ccr-${rule.id}-2026-04`;
    const item = (await loadLedger()).monthlyCostItems.find((m) => m.id === itemId)!;

    await expect(deleteMonthlyCost(itemId)).rejects.toMatchObject({
      code: 'error.recurring.generatedReadOnly',
    });
    await expect(upsertMonthlyCost({ ...item, name: '手で書き換え' })).rejects.toMatchObject({
      code: 'error.recurring.generatedReadOnly',
    });
    await expect(archiveMonthlyCost({ id: itemId, endDate: '2026-08-01' })).rejects.toMatchObject({
      code: 'error.recurring.generatedReadOnly',
    });

    const after = await loadLedger();
    expect(after.monthlyCostItems.find((m) => m.id === itemId)).toMatchObject({
      name: item.name,
      endDate: item.endDate,
    });
    expect(after.journalEntries.some((e) => e.metadata?.monthlyCostId === itemId)).toBe(true);
  });

  it('未来断面で台帳が積み上がらない（§13-1: 5年後の asOf で残高 = まだ費用にしていないぶんのみ）', async () => {
    const { rule } = await createSpreadRule();
    await catchUpRecurringRules('2026-07-23');
    const ledger = await loadLedger();
    const derived = reportEntriesForAsOf(ledger, '2031-12-31');
    // 導出 item が実 item と同じ engine で月割り行（cc-alloc）を出す。
    expect(derived.some((e) => e.id.startsWith(`cc-alloc-ccr-${rule.id}-`))).toBe(true);
    // 購入 6 回（2026-04〜2031-04 の毎年 4/25）= 360,000。各 item は [4/25, 翌 4/25] で
    // 刻み 12 本（翌月 25 日〜翌年 4/25・5,000 ずつ）。2031-12-31 断面までに費消済みなのは
    // 2026〜2030 サイクルの 60 本 + 2031-04 サイクルの 2031-05-25〜12-25 の 8 本 = 340,000。
    // 台帳残高 = 2031-04 サイクルの未費消 4 刻み（2032-01-25〜04-25）= 20,000。
    const balance = accountBalance(
      CONTINUOUS_COST_LEDGER_ACCOUNT_ID,
      'asset',
      filterByDateRange(derived, undefined, '2031-12-31'),
    );
    expect(balance).toBe(20000);
    // PL: 2031 年の費用は 0 ではない（2030 サイクルの 1〜4 月 4 本 + 2031 サイクルの 5〜12 月
    // 8 本 = 12 本 × 5,000）。
    const pl = deriveProfitAndLoss(ledger.accounts, derived, {
      from: '2031-01-01',
      to: '2031-12-31',
    });
    expect(pl.totalExpense).toBe(60000);
  });

  it('everyMonths = 1 でも月割りできる（毎月の家賃も台帳経由: item は起票日開始・次回起票日終了）', async () => {
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
    expect(june.endDate).toBe('2026-07-27'); // 周期 1 → 次回起票日と同日（毎月生まれて消える）
    const july = ledger.monthlyCostItems.find((m) => m.id === `ccr-${rule.id}-2026-07`)!;
    expect(july.endDate).toBe('2026-08-27');
    // 支出内訳では「継続コスト」に分類される。刻みは 1 本だけ（[6/27, 7/27] に同日通過は
    // 7/27 の 1 回）で、購入当日の費用は 0 なので 6 月ぶん 80,000 は 7/27 に全額立つ。
    const derived = reportEntriesForAsOf(ledger, '2026-07-31');
    const juneCost = livingCostBreakdownForRange(ledger.accounts, derived, {
      from: '2026-06-01',
      to: '2026-06-30',
    });
    expect(juneCost.monthlyCost).toBe(0);
    expect(juneCost.normalExpense).toBe(0);
    const julyCost = livingCostBreakdownForRange(ledger.accounts, derived, {
      from: '2026-07-01',
      to: '2026-07-31',
    });
    expect(julyCost.monthlyCost).toBe(80000);
    expect(julyCost.normalExpense).toBe(0);
    // 台帳残高 = 購入 2 本（160,000）− 費消 1 本（7/27 の 80,000）= 7/27 起票ぶんの未費消 80,000。
    // 7 月ぶんの刻みは 8/27 なので、断面 7/31 ではまだ費用になっていない。
    const balance = accountBalance(
      CONTINUOUS_COST_LEDGER_ACCOUNT_ID,
      'asset',
      filterByDateRange(derived, undefined, '2026-07-31'),
    );
    expect(balance).toBe(80000);
    // export → schema round-trip。
    expect(ledgerExportPackageSchema.safeParse(buildExportPackage(ledger)).success).toBe(true);
  });

  it('月末クランプの縁: 31 日指定の item と刻み（2 月起点は endDate より 3 日早く残高 0）', async () => {
    const bank = await accountByName('預金');
    const fixed = await accountByName('固定費');
    const rule = await createRecurringRule({
      name: '月末サブスク',
      amount: 3000,
      dayOfMonth: 31,
      everyMonths: 1,
      spreadExpenseAccountId: fixed.id,
      debitAccountId: fixed.id,
      creditAccountId: bank.id,
      startMonth: '2026-01',
      startDate: '2026-01-31',
    });
    // 起票日は clampDayToMonth: 1/31 と 2/28（クランプ産）の 2 回。
    expect(await catchUpRecurringRules('2026-02-28')).toBe(2);
    const ledger = await loadLedger();

    // ① 1/31 起票。endDate = clampDayToMonth('2026-02', 31) = 2/28（次回起票日と同日）。
    //    刻みは addMonthsToDate('2026-01-31', 1) = 2/28 の 1 本 = endDate ちょうど。
    const january = ledger.monthlyCostItems.find((m) => m.id === `ccr-${rule.id}-2026-01`)!;
    expect([january.startDate, january.endDate]).toEqual(['2026-01-31', '2026-02-28']);
    // ② 2/28 起票（クランプ産）。endDate = clampDayToMonth('2026-03', 31) = 3/31。
    //    刻みは起点日を保つので addMonthsToDate('2026-02-28', 1) = 3/28 の 1 本
    //    ＝ endDate（3/31）より 3 日早く残高 0 になる。これが同日刻みの仕様。
    const february = ledger.monthlyCostItems.find((m) => m.id === `ccr-${rule.id}-2026-02`)!;
    expect([february.startDate, february.endDate]).toEqual(['2026-02-28', '2026-03-31']);

    // 導出行の ID の月は刻み日の月（起票月ではない）。額は 1 刻みなので全額。
    const derived = reportEntriesForAsOf(ledger, '2026-03-28');
    expect(
      derived
        .filter((entry) => entry.metadata?.ccKind === 'monthly-allocation')
        .map((entry) => [
          entry.id,
          entry.date,
          entry.lines.find((line) => line.side === 'debit')?.amount,
        ]),
    ).toEqual([
      [`cc-alloc-ccr-${rule.id}-2026-01-2026-02`, '2026-02-28', 3000],
      [`cc-alloc-ccr-${rule.id}-2026-02-2026-03`, '2026-03-28', 3000],
    ]);
    // 3/27 断面は 2 月ぶんの購入が未費消（3,000）。3/28 の刻みで 0 になる（endDate 3/31 より前）。
    const ledgerBalanceAt = (asOf: string): number =>
      accountBalance(
        CONTINUOUS_COST_LEDGER_ACCOUNT_ID,
        'asset',
        filterByDateRange(reportEntriesForAsOf(ledger, asOf), undefined, asOf),
      );
    expect(ledgerBalanceAt('2026-03-27')).toBe(3000);
    expect(ledgerBalanceAt('2026-03-28')).toBe(0);
    expect(ledgerExportPackageSchema.safeParse(buildExportPackage(ledger)).success).toBe(true);
  });

  it('費用・収入以外の行き先（資産・負債など）は直接フローとして保存する', async () => {
    const bank = await accountByName('預金');
    const invest = await accountByName('投資'); // investment-asset
    // 行き先 = 投資（積立）・支払い元 = 銀行。費用/収入カテゴリではないため直接フロー。
    const rule = await createRecurringRule({
      name: '投信積立',
      amount: 4000,
      dayOfMonth: 1,
      everyMonths: 1,
      debitAccountId: invest.id,
      creditAccountId: bank.id,
      startMonth: '2026-07',
      startDate: '2026-07-01',
    });
    expect(await catchUpRecurringRules('2026-07-23')).toBe(1);
    const ledger = await loadLedger();
    const saved = ledger.recurringRules.find((candidate) => candidate.id === rule.id)!;
    expect(saved.spreadExpenseAccountId).toBeUndefined();
    expect(saved.debitAccountId).toBe(invest.id);
    expect(ledger.monthlyCostItems.find((m) => m.id === `ccr-${rule.id}-2026-07`)).toBeUndefined();
    const derived = reportEntriesForAsOf(ledger, '2026-07-31');
    // 月末断面: 銀行 −4,000・投資 +4,000。item は作らない。
    expect(accountBalance(bank.id, 'asset', derived)).toBeLessThan(0);
    expect(accountBalance(invest.id, 'asset', derived)).toBe(4000);
    expect(ledgerExportPackageSchema.safeParse(buildExportPackage(ledger)).success).toBe(true);
  });

  it('差引形（行き先=給与・源泉=銀行）: 台帳借方 + item 生成 + 月割りが収入のマイナスになる', async () => {
    const bank = await accountByName('預金');
    const salary = await accountByName('給与'); // income-category
    const rule = await createRecurringRule({
      name: '医師賠償責任保険',
      amount: 60000,
      dayOfMonth: 25,
      everyMonths: 12,
      debitAccountId: salary.id, // 行き先 = 収入カテゴリ（差引形）
      creditAccountId: bank.id,
      startMonth: '2026-04',
      startDate: '2026-04-25',
    });
    // 保存正規形: 借方 = 台帳・spread = 元の収入科目（§2）。
    expect(rule.debitAccountId).toBe(CONTINUOUS_COST_LEDGER_ACCOUNT_ID);
    expect(rule.spreadExpenseAccountId).toBe(salary.id);
    expect(await catchUpRecurringRules('2026-07-23')).toBe(1);
    const ledger = await loadLedger();
    const item = ledger.monthlyCostItems.find((m) => m.id === `ccr-${rule.id}-2026-04`)!;
    expect(item).toMatchObject({
      name: '医師賠償責任保険',
      amount: 60000,
      startDate: '2026-04-25',
      endDate: '2027-04-25', // 次回起票日と同日（2026-04 + 12 か月の 25 日・費用ルールと同一）
      expenseAccountId: salary.id,
    });
    const purchase = ledger.journalEntries.find((e) => e.metadata?.monthlyCostId === item.id)!;
    expect(purchase.lines).toEqual([
      { accountId: CONTINUOUS_COST_LEDGER_ACCOUNT_ID, side: 'debit', amount: 60000 },
      { accountId: bank.id, side: 'credit', amount: 60000 },
    ]);
    // 月割り 5,000/刻み（[4/25, 翌 4/25] の 12 刻み）。断面 2026-07-31 までに通過するのは
    // 5/25・6/25・7/25 の 3 刻み = 15,000 が収入のマイナスとして出る（購入当日 4/25 は 0）。
    const derived = reportEntriesForAsOf(ledger, '2026-07-31');
    expect(
      accountBalance(salary.id, 'revenue', filterByDateRange(derived, undefined, '2026-07-31')),
    ).toBe(-15000);
    // 未来断面も費用ルールと同様に購入行 + 月割り行（cc-alloc）の両方を導出する。
    const projected = reportEntriesForAsOf(ledger, '2027-12-31');
    expect(projected.some((e) => e.id === `rec-${rule.id}-2027-04`)).toBe(true);
    expect(projected.some((e) => e.id.startsWith(`cc-alloc-ccr-${rule.id}-`))).toBe(true);
    // export → schema round-trip（spread = income-category の v7 パッケージが受理される）。
    expect(ledgerExportPackageSchema.safeParse(buildExportPackage(ledger)).success).toBe(true);
  });

  it('編集で行き先を費用から給与へ変えても保存境界が spread 正規形へ正規化する', async () => {
    const { rule } = await createSpreadRule();
    const salary = await accountByName('給与');
    const stored = (await loadLedger()).recurringRules.find(
      (candidate) => candidate.id === rule.id,
    )!;
    // UI と同じく、利用者が選んだ行き先を借方と spread（月割りトグル ON）の両方に置く。
    const changed = { ...stored, debitAccountId: salary.id, spreadExpenseAccountId: salary.id };
    await upsertRecurringRule(changed);
    const saved = (await loadLedger()).recurringRules.find(
      (candidate) => candidate.id === rule.id,
    )!;
    expect(saved.debitAccountId).toBe(CONTINUOUS_COST_LEDGER_ACCOUNT_ID);
    expect(saved.spreadExpenseAccountId).toBe(salary.id);
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

describe('継続コスト台帳の経由は明示トグル（勘定科目で動作を変えない）', () => {
  it('費用行きでも spreadViaLedger: false なら直接形で保存し、item を作らない', async () => {
    const bank = await accountByName('預金');
    const fixed = await accountByName('固定費');
    const rule = await createRecurringRule({
      name: '直接記帳の家賃',
      amount: 80000,
      dayOfMonth: 25,
      debitAccountId: fixed.id,
      creditAccountId: bank.id,
      spreadViaLedger: false,
      startMonth: '2026-04',
      startDate: '2026-04-01',
    });
    // 保存形 = 直接形（借方が費用科目のまま・spread なし）。
    expect(rule.spreadExpenseAccountId).toBeUndefined();
    expect(rule.debitAccountId).toBe(fixed.id);

    expect(await catchUpRecurringRules('2026-04-25')).toBe(1);
    const ledger = await loadLedger();
    // 台帳を経由しない = item は 1 件も生まれない。
    expect(ledger.monthlyCostItems).toHaveLength(0);
    const posted = ledger.journalEntries.find((e) => e.metadata?.recurringRuleId === rule.id);
    expect(posted?.lines).toEqual([
      { accountId: fixed.id, side: 'debit', amount: 80000 },
      { accountId: bank.id, side: 'credit', amount: 80000 },
    ]);
    expect(posted?.metadata?.monthlyCostId).toBeUndefined();
    // 未来断面も直接形のまま = item を導出しないので月割り行（cc-alloc）が 1 本も出ない。
    const projected = reportEntriesForAsOf(ledger, '2026-12-31');
    expect(projected.some((e) => e.id === `rec-${rule.id}-2026-05`)).toBe(true);
    expect(projected.some((e) => e.id.startsWith(`cc-alloc-ccr-${rule.id}-`))).toBe(false);
    expect(ledgerExportPackageSchema.safeParse(buildExportPackage(ledger)).success).toBe(true);
  });

  it('資産行き（積立）でも spreadViaLedger: true なら台帳経由 + 計上先が資産の item になる', async () => {
    const bank = await accountByName('預金');
    const invest = await accountByName('投資');
    const rule = await createRecurringRule({
      name: 'クレカ積立',
      amount: 60000,
      dayOfMonth: 25,
      everyMonths: 12,
      debitAccountId: invest.id,
      creditAccountId: bank.id,
      spreadViaLedger: true,
      startMonth: '2026-04',
      startDate: '2026-04-25',
    });
    // 保存形 = 月割りの正規形（借方 = 台帳・spread = 利用者が選んだ行き先）。
    expect(rule.debitAccountId).toBe(CONTINUOUS_COST_LEDGER_ACCOUNT_ID);
    expect(rule.spreadExpenseAccountId).toBe(invest.id);

    expect(await catchUpRecurringRules('2026-04-25')).toBe(1);
    const ledger = await loadLedger();
    const itemId = `ccr-${rule.id}-2026-04`;
    expect(ledger.monthlyCostItems.find((m) => m.id === itemId)).toMatchObject({
      amount: 60000,
      expenseAccountId: invest.id,
      startDate: '2026-04-25',
      endDate: '2027-04-25',
    });
    expect(ledger.journalEntries.find((e) => e.metadata?.monthlyCostId === itemId)?.lines).toEqual([
      { accountId: CONTINUOUS_COST_LEDGER_ACCOUNT_ID, side: 'debit', amount: 60000 },
      { accountId: bank.id, side: 'credit', amount: 60000 },
    ]);
    // 月割り行は資産（投資）へ立つ: 5,000/刻み・4/25 購入の 5/25・6/25・7/25 の 3 刻み。
    const allocations = reportEntriesForAsOf(ledger, '2026-07-31').filter(
      (e) => e.metadata?.ccKind === 'monthly-allocation' && e.metadata.continuousCostId === itemId,
    );
    expect(allocations.map((e) => e.date)).toEqual(['2026-05-25', '2026-06-25', '2026-07-25']);
    expect(allocations.map((e) => e.lines[0])).toEqual([
      { accountId: invest.id, side: 'debit', amount: 5000 },
      { accountId: invest.id, side: 'debit', amount: 5000 },
      { accountId: invest.id, side: 'debit', amount: 5000 },
    ]);
    expect(ledgerExportPackageSchema.safeParse(buildExportPackage(ledger)).success).toBe(true);
  });

  it('費用行きの直接形は、金額以外を編集保存しても直接形のまま（role 再導出が復活していない）', async () => {
    const bank = await accountByName('預金');
    const fixed = await accountByName('固定費');
    const rule = await createRecurringRule({
      name: '直接記帳の家賃',
      amount: 80000,
      dayOfMonth: 25,
      debitAccountId: fixed.id,
      creditAccountId: bank.id,
      spreadViaLedger: false,
      startMonth: '2026-04',
      startDate: '2026-04-01',
    });
    await catchUpRecurringRules('2026-04-25');
    const stored = (await loadLedger()).recurringRules.find((r) => r.id === rule.id)!;
    await upsertRecurringRule({ ...stored, name: '直接記帳の家賃（変更後）', dayOfMonth: 26 });

    const ledger = await loadLedger();
    const saved = ledger.recurringRules.find((r) => r.id === rule.id)!;
    expect(saved.name).toBe('直接記帳の家賃（変更後）');
    expect(saved.spreadExpenseAccountId).toBeUndefined();
    expect(saved.debitAccountId).toBe(fixed.id);
    expect(ledger.monthlyCostItems).toHaveLength(0);
    expect(ledgerExportPackageSchema.safeParse(buildExportPackage(ledger)).success).toBe(true);
  });
});

describe('§2 対象外の保全: 収入・振替ルールの起票と投影は従来と完全一致（スナップショット）', () => {
  it('収入ルール（貸方=給与・借方=銀行）: 保存形・起票仕訳・投影とも直接フローのまま', async () => {
    const bank = await accountByName('預金');
    const salary = await accountByName('給与');
    const rule = await createRecurringRule({
      name: '給与振込',
      amount: 300000,
      dayOfMonth: 5,
      debitAccountId: bank.id,
      creditAccountId: salary.id,
      startMonth: '2026-07',
      startDate: '2026-07-05',
    });
    expect(await catchUpRecurringRules('2026-07-23')).toBe(1);
    const ledger = await loadLedger();
    const saved = ledger.recurringRules.find((candidate) => candidate.id === rule.id)!;
    expect(saved.spreadExpenseAccountId).toBeUndefined();
    expect(saved.debitAccountId).toBe(bank.id);
    // 起票結果の全フィールドを固定する（item なし・台帳なし・metadata に monthlyCostId 無し）。
    const posted = ledger.journalEntries.filter((e) => e.metadata?.recurringRuleId === rule.id);
    expect(posted).toEqual([
      {
        id: `rec-${rule.id}-2026-07`,
        date: '2026-07-05',
        description: '給与振込',
        kind: 'normal',
        lines: [
          { accountId: bank.id, side: 'debit', amount: 300000 },
          { accountId: salary.id, side: 'credit', amount: 300000 },
        ],
        metadata: { inputMode: 'income', recurringRuleId: rule.id, recurringMonth: '2026-07' },
        createdAt: expect.any(String),
        updatedAt: expect.any(String),
      },
    ]);
    expect(ledger.monthlyCostItems).toHaveLength(0);
    // 台帳（内部集約科目）が作られない = 継続コスト化の副作用が一切入らない。
    expect(ledger.accounts.some((a) => a.role === 'continuing-cost-asset')).toBe(false);
    // 投影も購入行のみ（月割り行 cc-allocp・continuousCostId 印なし）。
    const projected = recurringProjectionEntries([saved], ledger.accounts, '2026-09-30');
    expect(projected).toEqual([
      {
        id: `rec-proj-${rule.id}-2026-08`,
        date: '2026-08-05',
        description: '給与振込',
        kind: 'normal',
        lines: [
          { accountId: bank.id, side: 'debit', amount: 300000 },
          { accountId: salary.id, side: 'credit', amount: 300000 },
        ],
        metadata: {
          virtual: true,
          inputMode: 'income',
          recurringRuleId: rule.id,
          recurringMonth: '2026-08',
        },
        createdAt: saved.createdAt,
        updatedAt: saved.updatedAt,
      },
      {
        id: `rec-proj-${rule.id}-2026-09`,
        date: '2026-09-05',
        description: '給与振込',
        kind: 'normal',
        lines: [
          { accountId: bank.id, side: 'debit', amount: 300000 },
          { accountId: salary.id, side: 'credit', amount: 300000 },
        ],
        metadata: {
          virtual: true,
          inputMode: 'income',
          recurringRuleId: rule.id,
          recurringMonth: '2026-09',
        },
        createdAt: saved.createdAt,
        updatedAt: saved.updatedAt,
      },
    ]);
    expect(ledgerExportPackageSchema.safeParse(buildExportPackage(ledger)).success).toBe(true);
  });

  it('振替ルール（貸方=銀行・借方=投資）: 保存形・起票仕訳・投影とも直接フローのまま', async () => {
    const bank = await accountByName('預金');
    const invest = await accountByName('投資');
    const rule = await createRecurringRule({
      name: 'NISA積立',
      amount: 33333,
      dayOfMonth: 1,
      debitAccountId: invest.id,
      creditAccountId: bank.id,
      startMonth: '2026-07',
      startDate: '2026-07-01',
    });
    expect(await catchUpRecurringRules('2026-07-23')).toBe(1);
    const ledger = await loadLedger();
    const saved = ledger.recurringRules.find((candidate) => candidate.id === rule.id)!;
    expect(saved.spreadExpenseAccountId).toBeUndefined();
    expect(saved.debitAccountId).toBe(invest.id);
    const posted = ledger.journalEntries.filter((e) => e.metadata?.recurringRuleId === rule.id);
    expect(posted).toEqual([
      {
        id: `rec-${rule.id}-2026-07`,
        date: '2026-07-01',
        description: 'NISA積立',
        kind: 'normal',
        lines: [
          { accountId: invest.id, side: 'debit', amount: 33333 },
          { accountId: bank.id, side: 'credit', amount: 33333 },
        ],
        metadata: { inputMode: 'transfer', recurringRuleId: rule.id, recurringMonth: '2026-07' },
        createdAt: expect.any(String),
        updatedAt: expect.any(String),
      },
    ]);
    expect(ledger.monthlyCostItems).toHaveLength(0);
    expect(ledger.accounts.some((a) => a.role === 'continuing-cost-asset')).toBe(false);
    const projected = recurringProjectionEntries([saved], ledger.accounts, '2026-08-31');
    expect(projected).toEqual([
      {
        id: `rec-proj-${rule.id}-2026-08`,
        date: '2026-08-01',
        description: 'NISA積立',
        kind: 'normal',
        lines: [
          { accountId: invest.id, side: 'debit', amount: 33333 },
          { accountId: bank.id, side: 'credit', amount: 33333 },
        ],
        metadata: {
          virtual: true,
          inputMode: 'transfer',
          recurringRuleId: rule.id,
          recurringMonth: '2026-08',
        },
        createdAt: saved.createdAt,
        updatedAt: saved.updatedAt,
      },
    ]);
    expect(ledgerExportPackageSchema.safeParse(buildExportPackage(ledger)).success).toBe(true);
  });
});
