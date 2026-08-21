/*
 * ルール×ローン併用（v13.15 §2.4）: RecurringRule.loan ブロックの活性化。
 *
 *  - 保存形: 源泉 = 負債（周期をまたいで 1 つを再利用する収集器）・loan =
 *    { repaymentSourceAccountId, repaymentMonths }（相対月数）。
 *  - 導出: 起票ごとに 購入行（rec-・借方 台帳 / 貸方 負債）+ 持ち物 item（ccr-）+
 *    **ローン item（ccl-）** を導出し、返済行は v13.13 のエンジン（loan-pay-）へそのまま流す。
 *  - 清算の統一意味論: RuleSettlement { month, endDate } のまま拡張なし。endDate 上書きは
 *    持ち物・ローンの両 item に一様に効き、金銭の事実は loanSettlement 実仕訳（ccl- 参照）で
 *    spreadTotal から控除する。
 *  - fail-closed: loan ⇒ 源泉負債（wire + 保存境界）・ルール由来ローンの個別操作拒否・
 *    導出 ccl- を参照できる保存仕訳は一括返済だけ。
 */
import { describe, expect, it } from 'vitest';
import './setup';
import {
  archiveMonthlyCost,
  createRecurringRule,
  upsertRecurringRule,
  deleteMonthlyCost,
  deleteRecurringRule,
  loadLedger,
  settleLoan,
  switchRecurringRule,
  upsertMonthlyCost,
} from '../src/data/repository';
import { deriveRecurringOutputs, ruleItemId, ruleLoanItemId } from '../src/domain/recurring';
import { reportEntriesForAsOf, reportMonthlyCostItems } from '../src/domain/reportEntries';
import { accountBalance, filterByDateRange } from '../src/domain/accounting';
import { buildExportPackage } from '../src/data/exportImport';
import { ledgerExportPackageSchema } from '../src/domain/schema';
import type { Account, Ledger } from '../src/domain/types';

async function accountByName(name: string): Promise<Account> {
  const ledger = await loadLedger();
  const a = ledger.accounts.find((x) => x.name === name);
  if (!a) throw new Error(`seed に ${name} がない`);
  return a;
}

/** 断面 asOf までの導出行で負債科目の残高を出す（表示・保存境界と同じ入口）。 */
async function balanceAt(accountId: string, asOf: string): Promise<number> {
  const ledger = await loadLedger();
  const rows = filterByDateRange(reportEntriesForAsOf(ledger, asOf), undefined, asOf);
  return accountBalance(accountId, 'liability', rows);
}

/** 作者の車ユース: 120 か月ごとに 300 万の車をローン購入 + 月割り。 */
async function createCarRule(): Promise<{ ledger: Ledger; ruleId: string; liabilityId: string }> {
  const bank = await accountByName('預金');
  const fixed = await accountByName('固定費');
  const rule = await createRecurringRule({
    name: '自動車',
    amount: 3_000_000,
    dayOfMonth: 1,
    everyMonths: 120,
    debitAccountId: fixed.id,
    creditAccountId: '',
    newLoanAccount: { name: '自動車ローン' },
    loan: { repaymentSourceAccountId: bank.id, repaymentMonths: 120 },
    startMonth: '2020-04',
    startDate: '2020-04-01',
  });
  const ledger = await loadLedger();
  return { ledger, ruleId: rule.id, liabilityId: rule.creditAccountId };
}

describe('ルール×ローン併用（v13.15 §2.4）', () => {
  it('車ユース端到端: 各周期に 購入導出 + 月割り導出 + 返済導出が揃い、負債残高が積減する', async () => {
    const { ledger, ruleId, liabilityId } = await createCarRule();
    // 「新しいローン」で作った負債科目が源泉として保存されている。
    const liability = ledger.accounts.find((a) => a.id === liabilityId)!;
    expect(liability.name).toBe('自動車ローン');
    expect(liability.role).toBe('other-liability');
    const saved = ledger.recurringRules.find((r) => r.id === ruleId)!;
    expect(saved.loan).toEqual({
      repaymentSourceAccountId: (await accountByName('預金')).id,
      repaymentMonths: 120,
    });

    // 2 周期目（2030-04-01）まで導出: 各周期に rec- 購入行 + ccr- 持ち物 + ccl- ローン。
    const derived = deriveRecurringOutputs(ledger.recurringRules, ledger.accounts, '2030-04-01');
    expect(derived.entries.map((e) => e.date)).toEqual(['2020-04-01', '2030-04-01']);
    const itemIds = derived.items.map((m) => m.id).sort();
    expect(itemIds).toEqual(
      [
        ruleItemId(ruleId, '2020-04'),
        ruleItemId(ruleId, '2030-04'),
        ruleLoanItemId(ruleId, '2020-04'),
        ruleLoanItemId(ruleId, '2030-04'),
      ].sort(),
    );
    const loanItem = derived.items.find((m) => m.id === ruleLoanItemId(ruleId, '2020-04'))!;
    expect(loanItem.expenseAccountId).toBe(liabilityId);
    expect(loanItem.repaymentSourceAccountId).toBe((await accountByName('預金')).id);
    // 完済日 = 起票日 + repaymentMonths か月（相対 — 周期ごとにずれる）。
    expect(loanItem.startDate).toBe('2020-04-01');
    expect(loanItem.endDate).toBe('2030-04-01');
    expect(derived.items.find((m) => m.id === ruleLoanItemId(ruleId, '2030-04'))!.endDate).toBe(
      '2040-04-01',
    );

    // 返済行: 借方 負債 / 貸方 預金 × 25,000（300 万 ÷ 120・割り切れる例）。
    const bank = await accountByName('預金');
    const rows = reportEntriesForAsOf(ledger, '2020-06-30');
    const repayments = rows.filter(
      (e) => e.metadata?.continuousCostId === ruleLoanItemId(ruleId, '2020-04'),
    );
    expect(repayments.map((e) => e.date)).toEqual(['2020-05-01', '2020-06-01']);
    expect(repayments[0]!.lines).toEqual([
      { accountId: liabilityId, side: 'debit', amount: 25_000 },
      { accountId: bank.id, side: 'credit', amount: 25_000 },
    ]);

    // 負債残高の積減: 借入 300 万 → 60 回返済後 150 万 → 完済と同日の 2 周期目で再び 300 万。
    expect(await balanceAt(liabilityId, '2020-04-30')).toBe(3_000_000);
    expect(await balanceAt(liabilityId, '2025-04-01')).toBe(1_500_000);
    // 2030-04-01 = 1 本目の最終返済 + 2 本目の借入が同日 → ちょうど 300 万に戻る。
    expect(await balanceAt(liabilityId, '2030-04-01')).toBe(3_000_000);
  });

  it('mutation: ローン item の導出を外すと返済が消え、負債が積み上がるだけになる', async () => {
    // ミューテーションの手動確認手順のドキュメント代わり: 返済導出の存在そのものを
    // 残高で固定する（deriveRecurringOutputs から ccl- push を外すとこの行が落ちる）。
    const { liabilityId } = await createCarRule();
    const afterFive = await balanceAt(liabilityId, '2020-09-01');
    expect(afterFive).toBe(3_000_000 - 5 * 25_000);
  });

  it('fail-closed: loan ブロックあり ⇒ 源泉負債（保存境界・逆向きは課さない）', async () => {
    const bank = await accountByName('預金');
    const cash = await accountByName('現金');
    const fixed = await accountByName('固定費');
    // 源泉 = 資金（負債でない）+ loan → 拒否。
    await expect(
      createRecurringRule({
        name: '誤ったローン',
        amount: 100_000,
        dayOfMonth: 1,
        debitAccountId: fixed.id,
        creditAccountId: cash.id,
        loan: { repaymentSourceAccountId: bank.id, repaymentMonths: 12 },
        startMonth: '2026-07',
        startDate: '2026-07-01',
      }),
    ).rejects.toMatchObject({ code: 'error.recurring.flowInvalid' });
    // 返済元 = 源泉と同一科目 → 拒否。
    const card = await accountByName('クレジットカード');
    await expect(
      createRecurringRule({
        name: '返済元が源泉',
        amount: 100_000,
        dayOfMonth: 1,
        debitAccountId: fixed.id,
        creditAccountId: card.id,
        loan: { repaymentSourceAccountId: card.id, repaymentMonths: 12 },
        startMonth: '2026-07',
        startDate: '2026-07-01',
      }),
    ).rejects.toMatchObject({ code: 'error.loan.repaymentSource' });
    expect((await loadLedger()).recurringRules).toHaveLength(0);
  });

  it('fail-closed: ルール由来ローン（ccl-）への個別操作は全動詞で拒否される', async () => {
    const { ledger, ruleId } = await createCarRule();
    const cclId = ruleLoanItemId(ruleId, '2020-04');
    const derivedLoan = reportMonthlyCostItems(
      ledger,
      deriveRecurringOutputs(ledger.recurringRules, ledger.accounts, '2020-04-01').items,
    ).find((m) => m.id === cclId)!;
    await expect(upsertMonthlyCost({ ...derivedLoan, name: '改名' })).rejects.toMatchObject({
      code: 'error.recurring.generatedReadOnly',
    });
    await expect(deleteMonthlyCost(cclId)).rejects.toMatchObject({
      code: 'error.recurring.generatedReadOnly',
    });
    await expect(
      settleLoan({ id: cclId, endDate: '2021-04-01', settlement: undefined }),
    ).rejects.toMatchObject({ code: 'error.recurring.generatedReadOnly' });
    await expect(archiveMonthlyCost({ id: cclId, endDate: '2021-04-01' })).rejects.toMatchObject({
      code: 'error.recurring.generatedReadOnly',
    });
  });

  it('清算の統一意味論: 終了 + loanRepayment で両 item が D で締まり、返済実仕訳が控除される', async () => {
    const { ruleId, liabilityId } = await createCarRule();
    const bank = await accountByName('預金');
    // 5 年後（2025-04-01）に理論残債 150 万を一括返済してルールを終了する。
    await switchRecurringRule({
      ruleId,
      effectiveDate: '2025-04-01',
      successor: null,
      settlements: [
        {
          ruleId,
          month: '2020-04',
          loanRepayment: { sourceAccountId: bank.id, amount: 1_500_000 },
        },
      ],
    });
    const ledger = await loadLedger();
    const saved = ledger.recurringRules.find((r) => r.id === ruleId)!;
    // 保存形は month + endDate のまま（拡張なし）。
    expect(saved.settlements).toEqual([{ month: '2020-04', endDate: '2025-04-01' }]);
    expect(saved.endDate).toBe('2025-04-01');
    // 一括返済の実仕訳が導出 ccl- の決定的 ID を参照して保存されている。
    const settlementEntry = ledger.journalEntries.find((e) => e.metadata?.loanSettlement === true)!;
    expect(settlementEntry.metadata?.loanItemId).toBe(ruleLoanItemId(ruleId, '2020-04'));
    expect(settlementEntry.lines).toEqual([
      { accountId: liabilityId, side: 'debit', amount: 1_500_000 },
      { accountId: bank.id, side: 'credit', amount: 1_500_000 },
    ]);
    // 清算はその月の持ち物 item・ローン item の両方に一様に効く（endDate = D）。
    const derived = deriveRecurringOutputs(ledger.recurringRules, ledger.accounts, '2030-01-01');
    expect(derived.items.find((m) => m.id === ruleItemId(ruleId, '2020-04'))!.endDate).toBe(
      '2025-04-01',
    );
    expect(derived.items.find((m) => m.id === ruleLoanItemId(ruleId, '2020-04'))!.endDate).toBe(
      '2025-04-01',
    );
    // spreadTotal = 300 万 − 150 万 が [2020-04-01, 2025-04-01] へ按分し直され、
    // 一括返済と合わせて完済 = D 以降の負債残高は 0。
    expect(await balanceAt(liabilityId, '2025-04-01')).toBe(0);
    expect(await balanceAt(liabilityId, '2029-12-31')).toBe(0);
    // export round-trip: 清算実仕訳（ccl- 参照）ごと wire を通る。
    const pkg = buildExportPackage(await loadLedger());
    expect(ledgerExportPackageSchema.safeParse(pkg).success).toBe(true);
  });

  it('清算 D の上限はローン終端（v13.19 #3）: 周期末 < D < 完済日の早期完済が受理される', async () => {
    // 周期 6 か月・返済 24 か月の loan ルール（everyMonths ≠ repaymentMonths の分岐）。
    const bank = await accountByName('預金');
    const fixed = await accountByName('固定費');
    const rule = await createRecurringRule({
      name: '設備入替',
      amount: 240_000,
      dayOfMonth: 1,
      everyMonths: 6,
      debitAccountId: fixed.id,
      creditAccountId: '',
      newLoanAccount: { name: '設備ローン' },
      loan: { repaymentSourceAccountId: bank.id, repaymentMonths: 24 },
      startMonth: '2020-04',
      startDate: '2020-04-01',
    });
    // D = 2021-04-01（周期末 2020-10-01 より先・ローン終端 2022-04-01 より手前）。
    await switchRecurringRule({
      ruleId: rule.id,
      effectiveDate: '2021-04-01',
      successor: null,
      settlements: [
        {
          ruleId: rule.id,
          month: '2020-04',
          loanRepayment: { sourceAccountId: bank.id, amount: 120_000 },
        },
      ],
    });
    const ledger = await loadLedger();
    const saved = ledger.recurringRules.find((r) => r.id === rule.id)!;
    expect(saved.settlements).toEqual([{ month: '2020-04', endDate: '2021-04-01' }]);
    // 導出: ローン item は D で締まり、持ち物 item は自分の終端（周期末）を超えない。
    const derived = deriveRecurringOutputs(ledger.recurringRules, ledger.accounts, '2022-12-31');
    expect(derived.items.find((m) => m.id === ruleLoanItemId(rule.id, '2020-04'))!.endDate).toBe(
      '2021-04-01',
    );
    expect(derived.items.find((m) => m.id === ruleItemId(rule.id, '2020-04'))!.endDate).toBe(
      '2020-10-01',
    );
    // 一括返済と合わせて D 以降の負債残高は 0。
    expect(await balanceAt(saved.creditAccountId, '2022-12-31')).toBe(0);
    // wire も同じ cap（D はローン終端の内側 = 受理・終端超えは拒否）。
    const pkg = buildExportPackage(await loadLedger());
    expect(ledgerExportPackageSchema.safeParse(pkg).success).toBe(true);
    const beyond = {
      ...pkg,
      recurringRules: pkg.recurringRules.map((r) =>
        r.id === rule.id ? { ...r, settlements: [{ month: '2020-04', endDate: '2022-05-01' }] } : r,
      ),
    };
    expect(ledgerExportPackageSchema.safeParse(beyond).success).toBe(false);
  });

  it('通常ルール（loan なし）の清算上限は従来どおり周期終端のまま', async () => {
    const bank = await accountByName('預金');
    const fixed = await accountByName('固定費');
    const rule = await createRecurringRule({
      name: '通常半年払い',
      amount: 60_000,
      dayOfMonth: 1,
      everyMonths: 6,
      debitAccountId: fixed.id,
      creditAccountId: bank.id,
      startMonth: '2020-04',
      startDate: '2020-04-01',
    });
    // D = 周期終端（2020-10-01）より後 → 従来どおり拒否。
    await expect(
      switchRecurringRule({
        ruleId: rule.id,
        effectiveDate: '2021-04-01',
        successor: null,
        settlements: [{ ruleId: rule.id, month: '2020-04' }],
      }),
    ).rejects.toMatchObject({ code: 'error.recurring.settlementInvalid' });
  });

  it('実仕訳を伴わない清算も合法（= D までに全額返済された宣言）', async () => {
    const { ruleId, liabilityId } = await createCarRule();
    await switchRecurringRule({
      ruleId,
      effectiveDate: '2025-04-01',
      successor: null,
      settlements: [{ ruleId, month: '2020-04' }],
    });
    // 300 万全額が [2020-04-01, 2025-04-01]（60 刻み）へ按分し直される = 月 5 万。
    const ledger = await loadLedger();
    expect(ledger.journalEntries.filter((e) => e.metadata?.loanSettlement === true)).toHaveLength(
      0,
    );
    expect(await balanceAt(liabilityId, '2025-04-01')).toBe(0);
    expect(await balanceAt(liabilityId, '2020-05-01')).toBe(3_000_000 - 50_000);
  });

  it('retroactive 変更は既存 ccl 一括返済を新条件で再検証する（v13.19 #4）', async () => {
    const { ruleId } = await createCarRule();
    const bank = await accountByName('預金');
    // 5 年後に理論残債 150 万を一括返済してルールを終了（loanSettlement 実仕訳が残る）。
    await switchRecurringRule({
      ruleId,
      effectiveDate: '2025-04-01',
      successor: null,
      settlements: [
        {
          ruleId,
          month: '2020-04',
          loanRepayment: { sourceAccountId: bank.id, amount: 1_500_000 },
        },
      ],
    });
    const saved = (await loadLedger()).recurringRules.find((r) => r.id === ruleId)!;
    // ① 金額を一括返済合計未満へ減額する retroactive 編集は過返済になるので拒否。
    await expect(
      upsertRecurringRule({ ...saved, amount: 1_000_000 }, { amountChangeMode: 'retroactive' }),
    ).rejects.toMatchObject({ code: 'error.loan.overSettled' });
    // ② 過返済にならない減額（>= 150 万）は通る。
    await upsertRecurringRule({ ...saved, amount: 2_000_000 }, { amountChangeMode: 'retroactive' });
    expect((await loadLedger()).recurringRules.find((r) => r.id === ruleId)!.amount).toBe(
      2_000_000,
    );
    // ③ 位相の変更で ccl 参照月（2020-04）が導出されなくなる編集は宙参照になるので拒否。
    const after = (await loadLedger()).recurringRules.find((r) => r.id === ruleId)!;
    await expect(upsertRecurringRule({ ...after, startMonth: '2020-05' })).rejects.toMatchObject({
      code: 'error.recurring.settlementInvalid',
    });
  });

  it('ルール削除は loanSettlement 実仕訳（ccl- 参照）を道連れにする', async () => {
    const { ruleId } = await createCarRule();
    const bank = await accountByName('預金');
    await switchRecurringRule({
      ruleId,
      effectiveDate: '2025-04-01',
      successor: null,
      settlements: [
        {
          ruleId,
          month: '2020-04',
          loanRepayment: { sourceAccountId: bank.id, amount: 1_500_000 },
        },
      ],
    });
    expect(
      (await loadLedger()).journalEntries.some((e) => e.metadata?.loanSettlement === true),
    ).toBe(true);
    await deleteRecurringRule(ruleId);
    const after = await loadLedger();
    expect(after.recurringRules).toHaveLength(0);
    // 参照先（導出 ccl-）が消える以上、宙に浮く一括返済も残さない（export が拒否するため）。
    expect(after.journalEntries.some((e) => e.metadata?.loanSettlement === true)).toBe(false);
    const pkg = buildExportPackage(await loadLedger());
    expect(ledgerExportPackageSchema.safeParse(pkg).success).toBe(true);
  });

  it('wire: 返済元の 存在・postable・源泉非同一 も拒否する（保存境界と単一正本・v13.19 #2）', async () => {
    const { ruleId, liabilityId } = await createCarRule();
    const pkg = buildExportPackage(await loadLedger());
    const mutate = (loan: { repaymentSourceAccountId: string; repaymentMonths: number }) => ({
      ...pkg,
      recurringRules: pkg.recurringRules.map((r) => (r.id === ruleId ? { ...r, loan } : r)),
    });
    // ① 返済元が存在しない。
    expect(
      ledgerExportPackageSchema.safeParse(
        mutate({ repaymentSourceAccountId: 'no-such-account', repaymentMonths: 120 }),
      ).success,
    ).toBe(false);
    // ② 返済元が postable でない（内部台帳）。
    const ledgerAccount = pkg.accounts.find((a) => a.role === 'continuing-cost-asset')!;
    expect(
      ledgerExportPackageSchema.safeParse(
        mutate({ repaymentSourceAccountId: ledgerAccount.id, repaymentMonths: 120 }),
      ).success,
    ).toBe(false);
    // ③ 返済元 = 源泉（負債）と同一。
    expect(
      ledgerExportPackageSchema.safeParse(
        mutate({ repaymentSourceAccountId: liabilityId, repaymentMonths: 120 }),
      ).success,
    ).toBe(false);
    // 正しい loan はそのまま通る（対照）。
    expect(ledgerExportPackageSchema.safeParse(pkg).success).toBe(true);
  });

  it('wire: loan ブロックあり ⇒ 源泉負債・借入仕訳は導出 ccl- を参照できない', async () => {
    const { ruleId, liabilityId } = await createCarRule();
    const pkg = buildExportPackage(await loadLedger());
    expect(ledgerExportPackageSchema.safeParse(pkg).success).toBe(true);
    // 源泉を資金へすり替えた JSON は拒否（loan ⇒ 源泉負債）。
    const bank = await accountByName('預金');
    const broken = {
      ...pkg,
      recurringRules: pkg.recurringRules.map((r) =>
        r.id === ruleId ? { ...r, creditAccountId: bank.id } : r,
      ),
    };
    expect(ledgerExportPackageSchema.safeParse(broken).success).toBe(false);
    // 借入の仕訳（loanSettlement なし）が導出 ccl- を参照する JSON は拒否（二重計上）。
    const withBorrow = {
      ...pkg,
      journalEntries: [
        ...pkg.journalEntries,
        {
          id: 'manual-borrow-1',
          date: '2020-04-01',
          description: '不正な借入',
          kind: 'normal',
          lines: [
            { accountId: (await accountByName('固定費')).id, side: 'debit', amount: 1000 },
            { accountId: liabilityId, side: 'credit', amount: 1000 },
          ],
          metadata: { loanItemId: ruleLoanItemId(ruleId, '2020-04') },
          createdAt: '2020-04-01T00:00:00.000Z',
          updatedAt: '2020-04-01T00:00:00.000Z',
        },
      ],
    };
    expect(ledgerExportPackageSchema.safeParse(withBorrow).success).toBe(false);
  });
});
