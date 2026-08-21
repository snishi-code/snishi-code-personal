/*
 * 定期ルール（毎月の支出・収入・振替）の**完全導出**（v13）。
 *  - 保存するのはルール本体だけ。ルール由来の仕訳（rec-）と item（ccr-）は保存せず、
 *    存在期間 [startDate, endDate) と startMonth 基点の位相から毎回導出する。
 *  - 読み取りの正本 = deriveRecurringOutputs / reportEntriesForAsOf（実仕訳 + 導出 item の
 *    月割り行 + 導出購入行）。過去も未来も同じ規則で並ぶ（今日は挙動境界ではない）。
 *  - 編集 = 全期間の引き直し（金額も周期も行き先も過去へ遡って効く）。
 *  - 切り替え（split）: 旧線分 endDate = 境界日・後継 startDate = 境界日（半開・当日は後継）・
 *    startMonth 位相を継承・splitFromRuleId で系譜を連結する。
 *  - 保存境界: rec- / ccr- の namespace は書けず、由来メタの持ち込みも拒否する。
 *  - 削除: ルールを消せば導出が消える。回収の振替は道連れ・反対仕訳は参照だけ剥がして残す。
 *  - export → schema round-trip / 必須キー欠落の拒否。
 *
 * 版上げ前に実体化された保存 rec- / ccr-（過渡データ）を作る検証では、保存境界が塞がれて
 * いるため putRecord で DB へ直接置く（読み飛ばし・カスケード削除の対象になることを確かめる）。
 */
import { describe, expect, it } from 'vitest';
import './setup';
import {
  archiveMonthlyCost,
  createRecurringRule,
  deleteEntry,
  deleteMonthlyCost,
  deleteRecurringRule,
  loadLedger,
  switchRecurringRule,
  upsertEntry,
  upsertMonthlyCost,
  upsertRecurringRule,
} from '../src/data/repository';
import {
  clampDayToMonth,
  deriveRecurringOutputs,
  ruleEntryId,
  ruleItemId,
} from '../src/domain/recurring';
import { earliestRecurringRuleEndDate } from '../src/domain/accountLifetime';
import {
  accountBalance,
  deriveBalanceSheet,
  deriveProfitAndLoss,
  filterByDateRange,
} from '../src/domain/accounting';
import { livingCostBreakdownForRange } from '../src/domain/livingCost';
import { reportEntriesForAsOf, reportMonthlyCostItems } from '../src/domain/reportEntries';
import { reportBasis } from '../src/domain/reportPeriod';
import { CONTINUOUS_COST_LEDGER_ACCOUNT_ID } from '../src/domain/constants';
import { buildExportPackage } from '../src/data/exportImport';
import { putRecord, STORE } from '../src/data/db';
import { ledgerExportPackageSchema } from '../src/domain/schema';
import { LedgerError } from '../src/domain/errors';
import type {
  Account,
  JournalEntry,
  Ledger,
  MonthlyCostItem,
  RecurringRule,
} from '../src/domain/types';

async function accountByName(name: string): Promise<Account> {
  const ledger = await loadLedger();
  const a = ledger.accounts.find((x) => x.name === name);
  if (!a) throw new Error(`seed に ${name} がない`);
  return a;
}

interface DerivedSnapshot {
  ledger: Ledger;
  entries: JournalEntry[];
  items: MonthlyCostItem[];
}

/** 保存された姿（ルール本体）から asOf 断面の導出を作る = v13 の読み取り正本。 */
async function derivedFor(asOf: string): Promise<DerivedSnapshot> {
  const ledger = await loadLedger();
  return { ledger, ...deriveRecurringOutputs(ledger.recurringRules, ledger.accounts, asOf) };
}

/** 導出行を「日付・借方科目・金額」へ落とす（読みやすい比較のため）。 */
function shapeOf(entry: JournalEntry): [string, string, number] {
  const debit = entry.lines.find((line) => line.side === 'debit')!;
  return [entry.date, debit.accountId, debit.amount];
}

function purchasesOf(entries: JournalEntry[], ruleId: string): JournalEntry[] {
  return entries
    .filter((entry) => entry.metadata?.recurringRuleId === ruleId)
    .sort((a, b) => a.date.localeCompare(b.date));
}

describe('定期ルールの完全導出', () => {
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

  it('経過月ぶんの購入行を導出し、保存されるのはルール本体だけ', async () => {
    const bank = await accountByName('預金');
    const invest = await accountByName('投資');
    const rule = await createRecurringRule({
      name: 'NISA積立',
      amount: 33333,
      dayOfMonth: 1,
      debitAccountId: invest.id,
      creditAccountId: bank.id,
      startMonth: '2026-05', // 過去開始 → 5,6,7 月ぶんが導出される（基準日 = 2026-07-23）
      startDate: '2026-05-01',
    });

    const { ledger, entries, items } = await derivedFor('2026-07-23');
    const posted = purchasesOf(entries, rule.id);
    expect(posted.map((entry) => entry.date)).toEqual(['2026-05-01', '2026-06-01', '2026-07-01']);
    // v13.1（c 案）: 全ルールが台帳経由。購入行は「借方 台帳 / 貸方 源泉」で、
    // 利用者が選んだ行き先（= 計上先）は導出 item が持つ。
    expect(posted[0]!.lines).toEqual([
      { accountId: CONTINUOUS_COST_LEDGER_ACCOUNT_ID, side: 'debit', amount: 33333 },
      { accountId: bank.id, side: 'credit', amount: 33333 },
    ]);
    expect(items.map((item) => [item.id, item.expenseAccountId])).toEqual([
      [ruleItemId(rule.id, '2026-05'), invest.id],
      [ruleItemId(rule.id, '2026-06'), invest.id],
      [ruleItemId(rule.id, '2026-07'), invest.id],
    ]);
    // 導出行は保存されない計算値（virtual）で、時刻はルール由来。
    expect(posted.every((entry) => entry.metadata?.virtual === true)).toBe(true);
    expect(posted[0]!.createdAt).toBe(rule.createdAt);
    // 保存されるのはルールだけ = 何度読んでも DB は増えない（べき等という概念が要らない）。
    expect(ledger.journalEntries).toEqual([]);
    expect(ledger.monthlyCostItems).toEqual([]);
  });

  it('参照の壊れたルールは fail-soft に落とし、他のルールは導出する', async () => {
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
    await putRecord(STORE.recurringRules, {
      ...broken,
      spreadExpenseAccountId: 'missing-account',
    });

    const { entries } = await derivedFor('2026-07-01');
    expect(entries.map((entry) => entry.id)).toEqual([ruleEntryId(healthy.id, '2026-07')]);
  });

  it('起票日が未到来の月は導出しない（asOf は起票日当日を含む地平）', async () => {
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
    expect((await derivedFor('2026-07-23')).entries).toEqual([]); // 27 日未到来
    expect((await derivedFor('2026-07-27')).entries.map((entry) => entry.date)).toEqual([
      '2026-07-27',
    ]);
  });

  it('版上げ前の保存 rec- は読み飛ばし、個別に削除もできない（二重計上しない）', async () => {
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
    const staleId = ruleEntryId(rule.id, '2026-07');
    await putRecord(STORE.journalEntries, {
      id: staleId,
      date: '2026-07-01',
      description: '積立',
      kind: 'normal',
      lines: [
        { accountId: invest.id, side: 'debit', amount: 1000 },
        { accountId: bank.id, side: 'credit', amount: 1000 },
      ],
      metadata: { inputMode: 'transfer', recurringRuleId: rule.id, recurringMonth: '2026-07' },
      createdAt: '2026-07-01T00:00:00.000Z',
      updatedAt: '2026-07-01T00:00:00.000Z',
    });

    // ルール由来の保存行は通常経路で消せない（消したいならルール側を終了・削除する）。
    await expect(deleteEntry(staleId)).rejects.toMatchObject({
      code: 'error.recurring.generatedReadOnly',
    });
    const ledger = await loadLedger();
    expect(ledger.journalEntries.some((entry) => entry.id === staleId)).toBe(true);
    // 集計は保存 rec- を読み飛ばすので、残っていても導出と二重にならない。
    const report = reportEntriesForAsOf(ledger, '2026-07-31');
    expect(report.filter((entry) => entry.metadata?.recurringRuleId === rule.id)).toHaveLength(1);
    // 台帳経由なので購入行の借方は台帳。二重計上していれば 2,000 になる。
    // （item [7/1, 8/1] の刻みは 8/1 なので、7/31 断面では計上先へまだ振られていない。）
    expect(accountBalance(CONTINUOUS_COST_LEDGER_ACCOUNT_ID, 'asset', report)).toBe(1000);
    expect(accountBalance(invest.id, 'asset', report)).toBe(0);
  });

  it('everyMonths > 1 は startMonth 基点の位相で間引いて導出する', async () => {
    const bank = await accountByName('預金');
    const fixed = await accountByName('固定費');
    const rule = await createRecurringRule({
      name: '年払い保険',
      amount: 60000,
      dayOfMonth: 25,
      everyMonths: 12,
      debitAccountId: fixed.id, // 呼び出し側は行き先を渡し、保存境界が台帳へ正規化する
      creditAccountId: bank.id,
      startMonth: '2024-04',
      startDate: '2024-04-25',
    });
    expect(rule.debitAccountId).toBe(CONTINUOUS_COST_LEDGER_ACCOUNT_ID);
    expect(rule.spreadExpenseAccountId).toBe(fixed.id);
    // 2024-04 / 2025-04 / 2026-04 の 3 回ぶん（2026-07 断面）。
    const { entries } = await derivedFor('2026-07-23');
    expect(purchasesOf(entries, rule.id).map((entry) => entry.date)).toEqual([
      '2024-04-25',
      '2025-04-25',
      '2026-04-25',
    ]);
  });

  it('ルール削除は導出を消し、反対仕訳だけ参照を剥がして残す（カスケード）', async () => {
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
    // 利用者が導出行に対して切った反対仕訳（参照先は保存されない rec- ID）。
    await putRecord(STORE.journalEntries, {
      id: 'rule-delete-reversal',
      date: '2026-07-01',
      description: '反転',
      kind: 'normal',
      lines: [
        { accountId: bank.id, side: 'debit', amount: 1000 },
        { accountId: invest.id, side: 'credit', amount: 1000 },
      ],
      metadata: { reversalOfEntryId: ruleEntryId(rule.id, '2026-07') },
      createdAt: '2026-07-01T00:00:00.000Z',
      updatedAt: '2026-07-01T00:00:00.000Z',
    });
    await deleteRecurringRule(rule.id);

    const { ledger, entries } = await derivedFor('2026-12-31');
    expect(ledger.recurringRules).toHaveLength(0);
    // 積み木の下（ルール）が消えれば上（導出）も消える。
    expect(entries).toEqual([]);
    // 利用者自身が切った反対仕訳は最下層の積み木なので残り、宙に浮く参照だけ剥がれる。
    const reversal = ledger.journalEntries.find((e) => e.id === 'rule-delete-reversal')!;
    expect(reversal).toBeDefined();
    expect(reversal.metadata?.reversalOfEntryId).toBeUndefined();
    // カスケード後も export → schema 検証が通る（strict な存在チェックと両立）。
    const parsed = ledgerExportPackageSchema.safeParse(buildExportPackage(ledger));
    expect(parsed.success).toBe(true);
  });

  it('ルール削除は版上げ前の保存 rec- / ccr- も道連れにする（カスケード）', async () => {
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
    const itemId = ruleItemId(rule.id, '2026-07');
    await putRecord(STORE.monthlyCostItems, {
      id: itemId,
      name: rule.name,
      amount: 12000,
      startDate: '2026-07-01',
      endDate: '2027-07-01',
      expenseAccountId: fixed.id,
      createdAt: rule.createdAt,
      updatedAt: rule.updatedAt,
    });
    await putRecord(STORE.journalEntries, {
      id: ruleEntryId(rule.id, '2026-07'),
      date: '2026-07-01',
      description: rule.name,
      kind: 'normal',
      lines: [
        { accountId: CONTINUOUS_COST_LEDGER_ACCOUNT_ID, side: 'debit', amount: 12000 },
        { accountId: bank.id, side: 'credit', amount: 12000 },
      ],
      metadata: {
        inputMode: 'expense',
        recurringRuleId: rule.id,
        recurringMonth: '2026-07',
        monthlyCostId: itemId,
      },
      createdAt: rule.createdAt,
      updatedAt: rule.updatedAt,
    });

    const seeded = await loadLedger();
    expect(seeded.monthlyCostItems).toHaveLength(1);
    expect(seeded.journalEntries).toHaveLength(1);

    await deleteRecurringRule(rule.id);

    const ledger = await loadLedger();
    expect(ledger.recurringRules).toHaveLength(0);
    // 過渡の実体も残らない（通常 ID へ付け替えて残す旧仕様は撤去・作者決定 2026-08-15）。
    expect(ledger.monthlyCostItems).toHaveLength(0);
    expect(ledger.journalEntries).toHaveLength(0);
    expect(ledgerExportPackageSchema.safeParse(buildExportPackage(ledger)).success).toBe(true);
  });

  it('導出 item（ccr-）の回収の振替も道連れ（貸方 = 台帳なので item と対でしか成立しない）', async () => {
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
    const itemId = ruleItemId(rule.id, '2026-07');
    // 回収の振替（借方 預金 / 貸方 継続コスト台帳）は利用者が自分で切った実仕訳。
    // 参照先の item は導出なので保存されていない（ID の由来で道連れ判定する）。
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

    const { ledger, items } = await derivedFor('2026-12-31');
    expect(items).toEqual([]);
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
    const { ledger, entries } = await derivedFor('2026-07-23');
    const pkg = buildExportPackage(ledger);
    expect(ledgerExportPackageSchema.safeParse(pkg).success).toBe(true);
    // 版上げ前の保存形（virtual を落とした姿）が二重に残っている package は fail-closed。
    const stored: JournalEntry = {
      ...entries[0]!,
      metadata: { inputMode: 'transfer', recurringRuleId: rule.id, recurringMonth: '2026-07' },
    };
    const parsed = ledgerExportPackageSchema.safeParse({
      ...pkg,
      journalEntries: [
        ...pkg.journalEntries,
        stored,
        { ...stored, id: 'duplicate-recurring-entry' },
      ],
    });
    expect(parsed.success).toBe(false);
  });

  it('簿記編集: 健康保険（銀行 → 給与の差引形）は spread 正規形へ正規化して台帳経由で導出する', async () => {
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

    const { entries, items } = await derivedFor('2026-07-23');
    const posted = entries.find((e) => e.metadata?.recurringRuleId === rule.id)!;
    // 導出形は費用ルールと同一（借方 台帳 / 貸方 源泉・inputMode も同じ）。
    expect(posted.metadata?.inputMode).toBe('expense');
    expect(posted.lines).toEqual([
      { accountId: CONTINUOUS_COST_LEDGER_ACCOUNT_ID, side: 'debit', amount: 4000 },
      { accountId: bank.id, side: 'credit', amount: 4000 },
    ]);
    expect(items.find((m) => m.id === ruleItemId(rule.id, '2026-07'))?.expenseAccountId).toBe(
      income.id,
    );
  });

  it('導出仕訳の inputMode はルールの種類から決まる（v13.15 §2.4b・expense 固定の修正）', async () => {
    const bank = await accountByName('預金');
    const invest = await accountByName('投資'); // daily-asset
    const salary = await accountByName('給与'); // income-category
    const fixed = await accountByName('固定費'); // expense-category
    // 振替 × ルール（積立: 資金 → 資金）→ 'transfer'。
    const transferRule = await createRecurringRule({
      name: '積立',
      amount: 10000,
      dayOfMonth: 1,
      debitAccountId: invest.id,
      creditAccountId: bank.id,
      startMonth: '2026-07',
      startDate: '2026-07-01',
    });
    // 収入 × ルール（源泉 = 収入カテゴリ・計上先 = 資金）→ 'income'。
    const incomeRule = await createRecurringRule({
      name: '給料',
      amount: 300000,
      dayOfMonth: 25,
      debitAccountId: bank.id,
      creditAccountId: salary.id,
      startMonth: '2026-07',
      startDate: '2026-07-25',
    });
    // 支出 × ルール（計上先 = 費用）→ 'expense'（従来どおり）。
    const expenseRule = await createRecurringRule({
      name: '家賃',
      amount: 80000,
      dayOfMonth: 27,
      debitAccountId: fixed.id,
      creditAccountId: bank.id,
      startMonth: '2026-07',
      startDate: '2026-07-27',
    });

    const { entries } = await derivedFor('2026-07-31');
    const modeOf = (ruleId: string) =>
      entries.find((e) => e.metadata?.recurringRuleId === ruleId)?.metadata?.inputMode;
    expect(modeOf(transferRule.id)).toBe('transfer');
    expect(modeOf(incomeRule.id)).toBe('income');
    expect(modeOf(expenseRule.id)).toBe('expense');
  });

  it('簿記編集: クレカ積立を「カード → 投資」で毎月導出できる', async () => {
    const card = await accountByName('クレジットカード'); // payment-liability
    const invest = await accountByName('投資'); // daily-asset + movable:false（旧・投資 role は v13.18 撤去）
    const rule = await createRecurringRule({
      name: 'クレカ積立',
      amount: 10000,
      dayOfMonth: 1,
      debitAccountId: invest.id,
      creditAccountId: card.id,
      startMonth: '2026-07',
      startDate: '2026-07-01',
    });
    const { entries, items } = await derivedFor('2026-07-23');
    const posted = entries.find((e) => e.metadata?.recurringRuleId === rule.id)!;
    // 全ルールが台帳経由で導出形（行の形）は費用ルールと同一だが、inputMode は
    // ルールの種類から決まる（v13.15 §2.4b）: 資金 → 資金の積立は 'transfer'。
    expect(posted.metadata?.inputMode).toBe('transfer');
    expect(posted.lines).toEqual([
      { accountId: CONTINUOUS_COST_LEDGER_ACCOUNT_ID, side: 'debit', amount: 10000 },
      { accountId: card.id, side: 'credit', amount: 10000 },
    ]);
    expect(items.find((m) => m.id === ruleItemId(rule.id, '2026-07'))?.expenseAccountId).toBe(
      invest.id,
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
    // 継続コスト台帳（内部集約）は計上先に指定できない（台帳は導出エンジンの持ち物）。
    const fixed = await accountByName('固定費');
    await createRecurringRule({
      name: '台帳を生むための家賃',
      amount: 100000,
      dayOfMonth: 27,
      debitAccountId: fixed.id,
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
    const before = await loadLedger();

    const entries = reportEntriesForAsOf(before, '2026-10-31');
    // 月割り行は item（ccr-）帰属で recurringRuleId を持たない。ルールの寄与 =
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
    // ルール由来はすべて導出行（virtual）。起票済み・未起票の区別は存在しない。
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

    // 読み取りは保存を一切動かさない（導出に副作用が無い）。
    const after = await loadLedger();
    expect(after.journalEntries).toEqual(before.journalEntries);
    expect(after.monthlyCostItems).toEqual(before.monthlyCostItems);
    expect(after.recurringRules).toEqual(before.recurringRules);
  });
});

describe('clampDayToMonth と月割り行の導出', () => {
  it('31 日は月末へクランプされる', () => {
    expect(clampDayToMonth('2026-02', 31)).toBe('2026-02-28');
    expect(clampDayToMonth('2024-02', 31)).toBe('2024-02-29');
    expect(clampDayToMonth('2026-04', 31)).toBe('2026-04-30');
  });

  it('月割りルールは購入行と費用行を同じ ccr- ID で結び、存在期間の外は出さない', () => {
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
    // 月割りトグル ON の保存形（借方 = 継続コスト台帳・spread = 計上先）。
    const rule: RecurringRule = {
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
      createdAt: 't',
      updatedAt: 't',
    };
    const source = {
      accounts,
      journalEntries: [] as JournalEntry[],
      monthlyCostItems: [] as MonthlyCostItem[],
      recurringRules: [rule],
    };

    const entries = reportEntriesForAsOf(source, '2026-10-31');
    const purchases = purchasesOf(entries, 'rule');
    expect(purchases.map((entry) => [entry.id, entry.date, entry.metadata?.monthlyCostId])).toEqual(
      [
        ['rec-rule-2026-07', '2026-07-27', 'ccr-rule-2026-07'],
        ['rec-rule-2026-08', '2026-08-27', 'ccr-rule-2026-08'],
        ['rec-rule-2026-09', '2026-09-27', 'ccr-rule-2026-09'],
        ['rec-rule-2026-10', '2026-10-27', 'ccr-rule-2026-10'],
      ],
    );
    // 費用行は item 帰属（cc-alloc）。購入当日の費用は 0・刻みは翌月同日で、
    // 10/27 起票ぶんの刻み（11/27）は asOf を越えるので 1 本も出ない。
    const allocations = entries.filter((e) => e.metadata?.ccKind === 'monthly-allocation');
    expect(
      allocations.map((entry) => [
        entry.id,
        entry.date,
        entry.lines.find((line) => line.side === 'debit')?.amount,
      ]),
    ).toEqual([
      ['cc-alloc-ccr-rule-2026-07-2026-08', '2026-08-27', 80000],
      ['cc-alloc-ccr-rule-2026-08-2026-09', '2026-09-27', 80000],
      ['cc-alloc-ccr-rule-2026-09-2026-10', '2026-10-27', 80000],
    ]);
    // 由来の対応は 1:1（購入行の monthlyCostId = 費用行の continuousCostId）。
    expect(allocations.map((entry) => entry.metadata?.continuousCostId)).toEqual([
      'ccr-rule-2026-07',
      'ccr-rule-2026-08',
      'ccr-rule-2026-09',
    ]);

    // 終了点（排他的）より後は 1 本も導出しない。
    const ended = reportEntriesForAsOf(
      { ...source, recurringRules: [{ ...rule, endDate: '2026-09-01' }] },
      '2026-10-31',
    );
    expect(purchasesOf(ended, 'rule').map((entry) => entry.id)).toEqual([
      'rec-rule-2026-07',
      'rec-rule-2026-08',
    ]);
  });
});

describe('編集・切り替え・削除の保存境界', () => {
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

  it('全期間の金額変更は過去も含めて引き直し、保存 ccr- の手編集は読み飛ばす', async () => {
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
    // 版上げ前に実体化され、その後手で書き換えられた item（過渡データ）。
    await putRecord(STORE.monthlyCostItems, {
      id: ruleItemId(rule.id, '2026-05'),
      name: '手編集済み5月分',
      amount: 1000,
      startDate: '2026-05-20',
      endDate: '2026-06-30',
      expenseAccountId: fixed.id,
      createdAt: rule.createdAt,
      updatedAt: rule.updatedAt,
    });

    const stored = (await loadLedger()).recurringRules.find((r) => r.id === rule.id)!;
    await upsertRecurringRule({ ...stored, amount: 2000 }, { amountChangeMode: 'retroactive' });

    const { ledger, entries, items } = await derivedFor('2026-06-20');
    expect(items.map((item) => [item.id, item.amount])).toEqual([
      [ruleItemId(rule.id, '2026-04'), 2000],
      [ruleItemId(rule.id, '2026-05'), 2000],
      [ruleItemId(rule.id, '2026-06'), 2000],
    ]);
    expect(
      purchasesOf(entries, rule.id).every((entry) =>
        entry.lines.every((line) => line.amount === 2000),
      ),
    ).toBe(true);
    // 手編集の残骸は保存側に残っていても合成に混ざらない（導出が唯一の正本）。
    expect(ledger.monthlyCostItems.map((item) => item.name)).toEqual(['手編集済み5月分']);
    expect(
      reportMonthlyCostItems(ledger, items).some((item) => item.name === '手編集済み5月分'),
    ).toBe(false);
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

  it('金額と起票基準日を同時に変えて切り替えても、元の startMonth 位相を後継する', async () => {
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

    const { ledger, entries } = await derivedFor('2026-04-25');
    const successor = ledger.recurringRules.find((candidate) => candidate.id !== rule.id)!;
    expect(successor).toMatchObject({
      startMonth: '2026-04',
      dayOfMonth: 25,
      startDate: '2026-04-18',
    });
    // 旧線分 [4/12, 4/18) は起票日（4/20）を含まない = 後継の 4/25 だけが出る。
    // （全ルール台帳経由なので購入行の借方は台帳。行き先 invest は導出 item が持つ。）
    expect(entries.map((entry) => [entry.id, ...shapeOf(entry)])).toEqual([
      [ruleEntryId(successor.id, '2026-04'), '2026-04-25', CONTINUOUS_COST_LEDGER_ACCOUNT_ID, 1500],
    ]);
    expect(successor.spreadExpenseAccountId).toBe(invest.id);
  });

  it('境界の帰属は半開区間: 起票日を後ろへ動かすと同じ月に旧・新が 1 本ずつ並ぶ', async () => {
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

    const { ledger, entries } = await derivedFor('2026-04-25');
    const successor = ledger.recurringRules.find((candidate) => candidate.id !== rule.id)!;
    // 旧線分 [4/12, 4/22) は 4/20・後継 [4/22, …) は 4/25。同じ暦月でも別線分の別の日で、
    // 各線分は自分の存在期間ぶんだけを出す（「起票済み」を覚える機構は無い）。
    expect(
      entries
        .sort((a, b) => a.date.localeCompare(b.date))
        .map((entry) => [entry.id, ...shapeOf(entry)]),
    ).toEqual([
      [ruleEntryId(rule.id, '2026-04'), '2026-04-20', CONTINUOUS_COST_LEDGER_ACCOUNT_ID, 1000],
      [ruleEntryId(successor.id, '2026-04'), '2026-04-25', CONTINUOUS_COST_LEDGER_ACCOUNT_ID, 1500],
    ]);
  });

  it('終了点を空にした編集は有限segmentを将来へ再び開く', async () => {
    const bank = await accountByName('預金');
    const invest = await accountByName('投資');
    // 有限 segment（4/20 だけ起票して 5/01 で閉じる）。起票ゼロの線分は v13.3 の
    // 不変則で作れないため、終了点は初回の起票日より後に置く。
    const rule = await createRecurringRule({
      name: '終了点解除',
      amount: 1000,
      dayOfMonth: 20,
      debitAccountId: invest.id,
      creditAccountId: bank.id,
      startMonth: '2026-04',
      startDate: '2026-04-12',
      endDate: '2026-05-01',
    });
    // 終了点より後の起票日（5/20・6/20）は存在期間外 = 導出しない。
    expect((await derivedFor('2026-06-30')).entries.map((entry) => entry.date)).toEqual([
      '2026-04-20',
    ]);

    const finite = (await loadLedger()).recurringRules.find(
      (candidate) => candidate.id === rule.id,
    )!;
    const reopened = { ...finite };
    delete reopened.endDate;
    await upsertRecurringRule(reopened);

    const { ledger, entries } = await derivedFor('2026-06-30');
    expect(ledger.recurringRules.find((r) => r.id === rule.id)?.endDate).toBeUndefined();
    expect(entries.map((entry) => entry.date)).toEqual(['2026-04-20', '2026-05-20', '2026-06-20']);
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
    // 同じ月を first と last の両方から導出できてしまう（監査 P2-2）。
    const survivor = ledger.recurringRules.find((rule) => rule.id === last.id)!;
    expect(survivor.splitFromRuleId).toBe(first.id);
    expect(ledgerExportPackageSchema.safeParse(buildExportPackage(ledger)).success).toBe(true);

    // 系譜がつながっているので、first を無期限へ開き直す編集は拒否される。
    const reopened = { ...ledger.recurringRules.find((rule) => rule.id === first.id)! };
    delete reopened.endDate;
    await expect(upsertRecurringRule(reopened)).rejects.toThrow();
  });

  it('分割後継の削除は後継の導出を消し、旧segmentの終了点は残る', async () => {
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
    await upsertRecurringRule(
      { ...(await loadLedger()).recurringRules[0]!, amount: 1500 },
      { amountChangeMode: 'split', effectiveDate: '2026-04-22' },
    );
    let ledger = await loadLedger();
    const successor = ledger.recurringRules.find((rule) => rule.id !== predecessor.id)!;
    expect(
      (await derivedFor('2026-05-20')).entries.some(
        (entry) => entry.metadata?.recurringRuleId === successor.id,
      ),
    ).toBe(true);

    await deleteRecurringRule(successor.id);

    ledger = await loadLedger();
    const remaining = ledger.recurringRules.find((rule) => rule.id === predecessor.id)!;
    expect(remaining).toMatchObject({ endDate: '2026-04-22' });
    // 後継が担っていた 5 月分は導出ごと消え、旧線分は境界前だけを出す。
    expect((await derivedFor('2026-05-20')).entries.map((entry) => entry.date)).toEqual([
      '2026-04-20',
    ]);

    // 終了点を外せばその線分が全期間を引き直す（「起票済み」という状態は無い）。
    const reopened = { ...remaining };
    delete reopened.endDate;
    await upsertRecurringRule(reopened);
    expect((await derivedFor('2026-05-20')).entries.map((entry) => shapeOf(entry))).toEqual([
      ['2026-04-20', CONTINUOUS_COST_LEDGER_ACCOUNT_ID, 1000],
      ['2026-05-20', CONTINUOUS_COST_LEDGER_ACCOUNT_ID, 1000],
    ]);
  });

  it('ルールの終了点の既定は最後の導出起票日の翌日（当日の事実は期間の中に残る）', async () => {
    // 「終了」= 今日以降は生まない。今日の起票は存在期間の中にあるので終了点は翌日（監査 P2-1）。
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
    const { ledger, entries } = await derivedFor('2026-04-20');
    const stored = ledger.recurringRules[0]!;
    expect(earliestRecurringRuleEndDate(stored, entries, '2026-04-20')).toBe('2026-04-21');
    // 起票が無い日に終了するなら今日のまま。
    expect(earliestRecurringRuleEndDate(stored, entries, '2026-05-01')).toBe('2026-05-01');

    await upsertRecurringRule({
      ...stored,
      endDate: earliestRecurringRuleEndDate(stored, entries, '2026-04-20'),
    });
    const after = await derivedFor('2026-05-20');
    expect(after.ledger.recurringRules[0]?.endDate).toBe('2026-04-21');
    // 終了しても 4/20 の起票は残り、以降は生まれない。
    expect(after.entries.map((entry) => entry.date)).toEqual(['2026-04-20']);
  });

  it('起票日当日の切り替えは後継だけが所有する（月割りルールも同じ）', async () => {
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
    const stored = (await loadLedger()).recurringRules.find((r) => r.id === rule.id)!;
    await upsertRecurringRule(
      { ...stored, amount: 1500 },
      { amountChangeMode: 'split', effectiveDate: '2026-04-20' },
    );

    const { ledger, entries, items } = await derivedFor('2026-04-30');
    const predecessor = ledger.recurringRules.find((r) => r.id === rule.id)!;
    const successor = ledger.recurringRules.find((r) => r.id !== rule.id)!;
    expect(predecessor).toMatchObject({ amount: 1000, endDate: '2026-04-20' });
    expect(successor).toMatchObject({ amount: 1500, startDate: '2026-04-20' });
    // 半開区間なので 4/20 は後継だけのもの（新旧で二重計上しない）。
    expect(entries.map((entry) => [entry.id, ...shapeOf(entry)])).toEqual([
      [ruleEntryId(successor.id, '2026-04'), '2026-04-20', CONTINUOUS_COST_LEDGER_ACCOUNT_ID, 1500],
    ]);
    expect(items.map((item) => [item.id, item.startDate, item.endDate, item.amount])).toEqual([
      [ruleItemId(successor.id, '2026-04'), '2026-04-20', '2026-05-20', 1500],
    ]);
    expect(ledgerExportPackageSchema.safeParse(buildExportPackage(ledger)).success).toBe(true);
  });

  it('月初の切り替えでも当日は後継が所有し、前月は旧線分のまま', async () => {
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
    const stored = (await loadLedger()).recurringRules.find((r) => r.id === rule.id)!;

    await upsertRecurringRule(
      { ...stored, amount: 1500 },
      { amountChangeMode: 'split', effectiveDate: '2026-08-01' },
    );

    const { ledger, entries } = await derivedFor('2026-08-31');
    const successor = ledger.recurringRules.find((r) => r.id !== rule.id)!;
    expect(
      entries
        .sort((a, b) => a.date.localeCompare(b.date))
        .map((entry) => [entry.id, ...shapeOf(entry)]),
    ).toEqual([
      [ruleEntryId(rule.id, '2026-07'), '2026-07-01', CONTINUOUS_COST_LEDGER_ACCOUNT_ID, 1000],
      [ruleEntryId(successor.id, '2026-08'), '2026-08-01', CONTINUOUS_COST_LEDGER_ACCOUNT_ID, 1500],
    ]);
    expect(successor.spreadExpenseAccountId).toBe(invest.id);
    expect(ledgerExportPackageSchema.safeParse(buildExportPackage(ledger)).success).toBe(true);
  });

  it('切り替えと同時に計上先を変えると、境界以降は新しい計上先の item を導出する', async () => {
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
    const stored = (await loadLedger()).recurringRules.find((r) => r.id === rule.id)!;

    // UI と同じく、行き先（= 計上先）を明示して渡す。保存境界が借方 = 台帳へ正規化する。
    await upsertRecurringRule(
      { ...stored, amount: 1500, debitAccountId: fixed.id, spreadExpenseAccountId: fixed.id },
      { amountChangeMode: 'split', effectiveDate: '2026-04-20' },
    );

    let snapshot = await derivedFor('2026-05-20');
    const successor = snapshot.ledger.recurringRules.find((r) => r.id !== rule.id)!;
    // 旧線分 [4/12, 4/20) は起票日を含まない = 境界当日から後継の形で全期間が並ぶ。
    expect(snapshot.entries.map((entry) => shapeOf(entry))).toEqual([
      ['2026-04-20', CONTINUOUS_COST_LEDGER_ACCOUNT_ID, 1500],
      ['2026-05-20', CONTINUOUS_COST_LEDGER_ACCOUNT_ID, 1500],
    ]);
    expect(snapshot.items.map((item) => [item.id, item.expenseAccountId, item.amount])).toEqual([
      [ruleItemId(successor.id, '2026-04'), fixed.id, 1500],
      [ruleItemId(successor.id, '2026-05'), fixed.id, 1500],
    ]);
    expect(snapshot.ledger.monthlyCostItems).toEqual([]);

    // 計上先の違う線分が系譜内に並んでも、後継の通常編集は通る。
    await upsertRecurringRule({ ...successor, name: '積立から費用へ（変更後）' });
    snapshot = await derivedFor('2026-05-20');
    expect(snapshot.ledger.recurringRules.find((r) => r.id === successor.id)?.name).toBe(
      '積立から費用へ（変更後）',
    );
    expect(ledgerExportPackageSchema.safeParse(buildExportPackage(snapshot.ledger)).success).toBe(
      true,
    );
  });

  it('切り替えで周期と計上先を変えると、境界以降は新しい姿で導出し遡及の金額変更も効く', async () => {
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
    const stored = (await loadLedger()).recurringRules.find((r) => r.id === rule.id)!;

    const changed = {
      ...stored,
      amount: 1500,
      everyMonths: 1,
      debitAccountId: invest.id,
      spreadExpenseAccountId: invest.id,
    };
    await upsertRecurringRule(changed, { amountChangeMode: 'split', effectiveDate: '2026-04-20' });

    const snapshot = await derivedFor('2026-05-20');
    const successor = snapshot.ledger.recurringRules.find((r) => r.id !== rule.id)!;
    expect(successor.spreadExpenseAccountId).toBe(invest.id);
    expect(snapshot.ledger.monthlyCostItems).toEqual([]);
    expect(snapshot.items.map((item) => [item.id, item.expenseAccountId, item.amount])).toEqual([
      [ruleItemId(successor.id, '2026-04'), invest.id, 1500],
      [ruleItemId(successor.id, '2026-05'), invest.id, 1500],
    ]);
    expect(snapshot.entries.map((entry) => shapeOf(entry))).toEqual([
      ['2026-04-20', CONTINUOUS_COST_LEDGER_ACCOUNT_ID, 1500],
      ['2026-05-20', CONTINUOUS_COST_LEDGER_ACCOUNT_ID, 1500],
    ]);

    // 遡及の金額変更は全期間へ効く（生成時の値を凍結しない）。
    await upsertRecurringRule({ ...successor, amount: 1800 }, { amountChangeMode: 'retroactive' });
    const after = await derivedFor('2026-05-20');
    expect(after.entries.every((entry) => entry.lines.every((line) => line.amount === 1800))).toBe(
      true,
    );
    expect(ledgerExportPackageSchema.safeParse(buildExportPackage(after.ledger)).success).toBe(
      true,
    );
  });

  it('金額を変えない編集でも、周期・行き先の変更は全期間へ遡って効く', async () => {
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
    const stored = (await loadLedger()).recurringRules.find(
      (candidate) => candidate.id === rule.id,
    )!;
    const changed = {
      ...stored,
      everyMonths: 1,
      debitAccountId: invest.id,
      spreadExpenseAccountId: invest.id,
    };
    await upsertRecurringRule(changed);

    const { ledger, entries, items } = await derivedFor('2026-05-20');
    // 4 月ぶんも新しい姿（計上先 = 投資・毎月）で引き直される。
    expect(items.map((item) => [item.id, item.expenseAccountId, item.amount])).toEqual([
      [ruleItemId(rule.id, '2026-04'), invest.id, 12000],
      [ruleItemId(rule.id, '2026-05'), invest.id, 12000],
    ]);
    expect(entries.map((entry) => shapeOf(entry))).toEqual([
      ['2026-04-20', CONTINUOUS_COST_LEDGER_ACCOUNT_ID, 12000],
      ['2026-05-20', CONTINUOUS_COST_LEDGER_ACCOUNT_ID, 12000],
    ]);
    expect(ledgerExportPackageSchema.safeParse(buildExportPackage(ledger)).success).toBe(true);
  });

  it('ルール由来の仕訳は保存境界で書けない（決定的 ID と由来メタの両方で塞ぐ）', async () => {
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
    const derived = (await derivedFor('2026-04-20')).entries[0]!;
    expect(derived.id).toBe(ruleEntryId(rule.id, '2026-04'));

    // 導出行をそのまま保存しようとしても rec- namespace で塞がれる。
    await expect(upsertEntry({ ...derived, description: '手で書き換え' })).rejects.toMatchObject({
      code: 'error.recurring.generatedReadOnly',
    });
    // 由来メタを落として通常仕訳のふりをしても、決定的 ID（rec-）で塞がれる。
    await expect(
      upsertEntry({ ...derived, metadata: { inputMode: 'manual' } }),
    ).rejects.toMatchObject({ code: 'error.recurring.generatedReadOnly' });
    // 逆に、由来を名乗らない ID がルール由来メタを持ち込むことも許さない。
    await expect(
      upsertEntry({
        ...derived,
        id: 'hand-written',
        metadata: {
          inputMode: 'manual',
          recurringRuleId: rule.id,
          recurringMonth: '2026-04',
        },
      }),
    ).rejects.toMatchObject({ code: 'error.recurring.invalidStructure' });
    expect((await loadLedger()).journalEntries).toEqual([]);
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
      debitAccountId: fixed.id,
      creditAccountId: bank.id,
      startMonth: '2026-04',
      startDate: '2026-04-25',
    });
    return { rule, bank, fixed };
  }

  it('1 周期 = 購入の仕訳（借方 台帳・monthlyCostId 付き）+ item（endDate = 次回起票日と同日）', async () => {
    const { rule, bank, fixed } = await createSpreadRule();
    const { ledger, entries, items } = await derivedFor('2026-07-23');
    const item = items.find((m) => m.id === ruleItemId(rule.id, '2026-04'));
    expect(item).toBeDefined();
    expect(item!.name).toBe('火災保険');
    expect(item!.amount).toBe(60000);
    expect(item!.startDate).toBe('2026-04-25');
    // 起票月 2026-04 + everyMonths 12 = 2027-04 を dayOfMonth 25 でクランプ = 次回起票日と同日。
    expect(item!.endDate).toBe('2027-04-25');
    expect(item!.expenseAccountId).toBe(fixed.id);
    const purchase = entries.find((e) => e.metadata?.monthlyCostId === item!.id);
    expect(purchase).toBeDefined();
    expect(purchase!.date).toBe('2026-04-25');
    expect(purchase!.metadata?.recurringRuleId).toBe(rule.id);
    expect(purchase!.lines).toEqual([
      { accountId: CONTINUOUS_COST_LEDGER_ACCOUNT_ID, side: 'debit', amount: 60000 },
      { accountId: bank.id, side: 'credit', amount: 60000 },
    ]);
    // 保存されるのはルール本体だけ（購入行も item も保存しない）。
    expect(ledger.journalEntries).toEqual([]);
    expect(ledger.monthlyCostItems).toEqual([]);
    // export → schema round-trip（不変条件⑤⑥⑦を満たす形で保存される）。
    expect(ledgerExportPackageSchema.safeParse(buildExportPackage(ledger)).success).toBe(true);
  });

  it('ルール由来 item（ccr-）は編集も削除もアーカイブもできない（読み取り専用）', async () => {
    const { rule } = await createSpreadRule();
    const before = await derivedFor('2026-07-23');
    const item = before.items.find((m) => m.id === ruleItemId(rule.id, '2026-04'))!;

    await expect(deleteMonthlyCost(item.id)).rejects.toMatchObject({
      code: 'error.recurring.generatedReadOnly',
    });
    await expect(upsertMonthlyCost({ ...item, name: '手で書き換え' })).rejects.toMatchObject({
      code: 'error.recurring.generatedReadOnly',
    });
    await expect(archiveMonthlyCost({ id: item.id, endDate: '2026-08-01' })).rejects.toMatchObject({
      code: 'error.recurring.generatedReadOnly',
    });

    // 拒否された操作は導出にも保存にも影響しない（終わらせたいならルール側を終了する）。
    const after = await derivedFor('2026-07-23');
    expect(after.items).toEqual(before.items);
    expect(after.ledger.monthlyCostItems).toEqual([]);
  });

  it('未来断面で台帳が積み上がらない（§13-1: 5年後の asOf で残高 = まだ費用にしていないぶんのみ）', async () => {
    const { rule } = await createSpreadRule();
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
      debitAccountId: fixed.id,
      creditAccountId: bank.id,
      startMonth: '2026-06',
      startDate: '2026-06-27',
    });
    // 6/27・7/27 の 2 周期（断面 = 2026-07-27）。
    const { ledger, items } = await derivedFor('2026-07-27');
    const june = items.find((m) => m.id === ruleItemId(rule.id, '2026-06'))!;
    expect(june.startDate).toBe('2026-06-27');
    expect(june.endDate).toBe('2026-07-27'); // 周期 1 → 次回起票日と同日（毎月生まれて消える）
    const july = items.find((m) => m.id === ruleItemId(rule.id, '2026-07'))!;
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
      debitAccountId: fixed.id,
      creditAccountId: bank.id,
      startMonth: '2026-01',
      startDate: '2026-01-31',
    });
    // 起票日は clampDayToMonth: 1/31 と 2/28（クランプ産）の 2 周期。
    const { ledger, items } = await derivedFor('2026-03-28');
    expect(items).toHaveLength(2);

    // ① 1/31 起票。endDate = clampDayToMonth('2026-02', 31) = 2/28（次回起票日と同日）。
    //    刻みは addMonthsToDate('2026-01-31', 1) = 2/28 の 1 本 = endDate ちょうど。
    const january = items.find((m) => m.id === ruleItemId(rule.id, '2026-01'))!;
    expect([january.startDate, january.endDate]).toEqual(['2026-01-31', '2026-02-28']);
    // ② 2/28 起票（クランプ産）。endDate = clampDayToMonth('2026-03', 31) = 3/31。
    //    刻みは起点日を保つので addMonthsToDate('2026-02-28', 1) = 3/28 の 1 本
    //    ＝ endDate（3/31）より 3 日早く残高 0 になる。これが同日刻みの仕様。
    const february = items.find((m) => m.id === ruleItemId(rule.id, '2026-02'))!;
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

  it('費用・収入以外の行き先（資産・負債など）も台帳経由で保存する（勘定科目で動作を変えない）', async () => {
    const bank = await accountByName('預金');
    const invest = await accountByName('投資'); // daily-asset + movable:false（旧・投資 role は v13.18 撤去）
    // 行き先 = 投資（積立）・支払い元 = 銀行。費用/収入カテゴリでなくても保存形は一形。
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
    const { ledger, items } = await derivedFor('2026-07-23');
    const saved = ledger.recurringRules.find((candidate) => candidate.id === rule.id)!;
    expect(saved.spreadExpenseAccountId).toBe(invest.id);
    expect(saved.debitAccountId).toBe(CONTINUOUS_COST_LEDGER_ACCOUNT_ID);
    expect(items.map((m) => [m.id, m.expenseAccountId, m.startDate, m.endDate])).toEqual([
      [ruleItemId(rule.id, '2026-07'), invest.id, '2026-07-01', '2026-08-01'],
    ]);
    const derived = reportEntriesForAsOf(ledger, '2026-07-31');
    // 月末断面: 銀行 −4,000・台帳 +4,000（投資への刻みは 8/1 なのでまだ動かない）。
    expect(accountBalance(bank.id, 'asset', derived)).toBeLessThan(0);
    expect(
      accountBalance(
        CONTINUOUS_COST_LEDGER_ACCOUNT_ID,
        'asset',
        filterByDateRange(derived, undefined, '2026-07-31'),
      ),
    ).toBe(4000);
    expect(ledgerExportPackageSchema.safeParse(buildExportPackage(ledger)).success).toBe(true);
  });

  it('差引形（行き先=給与・源泉=銀行）: 台帳借方 + item 導出 + 月割りが収入のマイナスになる', async () => {
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
    const { ledger, entries, items } = await derivedFor('2026-07-23');
    const item = items.find((m) => m.id === ruleItemId(rule.id, '2026-04'))!;
    expect(item).toMatchObject({
      name: '医師賠償責任保険',
      amount: 60000,
      startDate: '2026-04-25',
      endDate: '2027-04-25', // 次回起票日と同日（2026-04 + 12 か月の 25 日・費用ルールと同一）
      expenseAccountId: salary.id,
    });
    const purchase = entries.find((e) => e.metadata?.monthlyCostId === item.id)!;
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
    expect(projected.some((e) => e.id === ruleEntryId(rule.id, '2027-04'))).toBe(true);
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
    // UI と同じく、利用者が選んだ行き先を借方と spread（計上先）の両方に置く。
    const changed = { ...stored, debitAccountId: salary.id, spreadExpenseAccountId: salary.id };
    await upsertRecurringRule(changed);
    const saved = (await loadLedger()).recurringRules.find(
      (candidate) => candidate.id === rule.id,
    )!;
    expect(saved.debitAccountId).toBe(CONTINUOUS_COST_LEDGER_ACCOUNT_ID);
    expect(saved.spreadExpenseAccountId).toBe(salary.id);
  });

  it('支払い元（貸方）に income-category を指定した月割りルールも導出できる', async () => {
    const salary = await accountByName('給与');
    const fixed = await accountByName('固定費');
    const rule = await createRecurringRule({
      name: '天引きの月割り',
      amount: 3000,
      dayOfMonth: 1,
      everyMonths: 1,
      debitAccountId: fixed.id,
      creditAccountId: salary.id, // 支払い元 = 給与（income-category）
      startMonth: '2026-07',
      startDate: '2026-07-01',
    });
    const { ledger, entries } = await derivedFor('2026-07-23');
    const purchase = entries.find(
      (e) => e.metadata?.monthlyCostId === ruleItemId(rule.id, '2026-07'),
    )!;
    expect(purchase.lines).toEqual([
      { accountId: CONTINUOUS_COST_LEDGER_ACCOUNT_ID, side: 'debit', amount: 3000 },
      { accountId: salary.id, side: 'credit', amount: 3000 },
    ]);
    expect(ledgerExportPackageSchema.safeParse(buildExportPackage(ledger)).success).toBe(true);
  });
});

describe('全ルールが台帳経由（v13.1 c 案・勘定科目で動作を変えない）', () => {
  it('資産行き（積立）も台帳経由 + 計上先が資産の item になる', async () => {
    const bank = await accountByName('預金');
    const invest = await accountByName('投資');
    const rule = await createRecurringRule({
      name: 'クレカ積立',
      amount: 60000,
      dayOfMonth: 25,
      everyMonths: 12,
      debitAccountId: invest.id,
      creditAccountId: bank.id,
      startMonth: '2026-04',
      startDate: '2026-04-25',
    });
    // 保存形は一形（借方 = 台帳・spread = 利用者が選んだ行き先）。
    expect(rule.debitAccountId).toBe(CONTINUOUS_COST_LEDGER_ACCOUNT_ID);
    expect(rule.spreadExpenseAccountId).toBe(invest.id);

    const { ledger, entries, items } = await derivedFor('2026-04-25');
    const itemId = ruleItemId(rule.id, '2026-04');
    expect(items.find((m) => m.id === itemId)).toMatchObject({
      amount: 60000,
      expenseAccountId: invest.id,
      startDate: '2026-04-25',
      endDate: '2027-04-25',
    });
    expect(entries.find((e) => e.metadata?.monthlyCostId === itemId)?.lines).toEqual([
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

  it('金額以外を編集保存しても保存形は台帳経由のまま（直接形へ戻る経路が無い）', async () => {
    const bank = await accountByName('預金');
    const fixed = await accountByName('固定費');
    const rule = await createRecurringRule({
      name: '家賃',
      amount: 80000,
      dayOfMonth: 25,
      debitAccountId: fixed.id,
      creditAccountId: bank.id,
      startMonth: '2026-04',
      startDate: '2026-04-01',
    });
    const stored = (await loadLedger()).recurringRules.find((r) => r.id === rule.id)!;
    await upsertRecurringRule({ ...stored, name: '家賃（変更後）', dayOfMonth: 26 });

    const { ledger, items } = await derivedFor('2026-04-26');
    const saved = ledger.recurringRules.find((r) => r.id === rule.id)!;
    expect(saved.name).toBe('家賃（変更後）');
    expect(saved.spreadExpenseAccountId).toBe(fixed.id);
    expect(saved.debitAccountId).toBe(CONTINUOUS_COST_LEDGER_ACCOUNT_ID);
    expect(items.map((m) => [m.id, m.expenseAccountId])).toEqual([
      [ruleItemId(rule.id, '2026-04'), fixed.id],
    ]);
    expect(ledgerExportPackageSchema.safeParse(buildExportPackage(ledger)).success).toBe(true);
  });
});

describe('収入・振替ルールも台帳経由の一形で導出する（スナップショット）', () => {
  it('収入ルール（源泉=給与・計上先=銀行）: 保存形も導出行も台帳経由の一形', async () => {
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
    const { ledger, entries, items } = await derivedFor('2026-09-30');
    const saved = ledger.recurringRules.find((candidate) => candidate.id === rule.id)!;
    // v13.1（c 案）: 収入ルールも保存形は一形（借方 = 台帳・計上先 = 利用者が選んだ行き先）。
    expect(saved.spreadExpenseAccountId).toBe(bank.id);
    expect(saved.debitAccountId).toBe(CONTINUOUS_COST_LEDGER_ACCOUNT_ID);
    // 導出行の全フィールドを固定する（inputMode はルールの種類から: 源泉 = 収入カテゴリ →
    // 'income'〔v13.15 §2.4b〕・monthlyCostId が必ず付く）。
    // 過去も未来も同じ規則で並ぶ = 「起票済み」と「投影」の区別が無い。
    const purchase = (month: string, date: string): JournalEntry => ({
      id: ruleEntryId(rule.id, month),
      date,
      description: '給与振込',
      kind: 'normal',
      lines: [
        { accountId: CONTINUOUS_COST_LEDGER_ACCOUNT_ID, side: 'debit', amount: 300000 },
        { accountId: salary.id, side: 'credit', amount: 300000 },
      ],
      metadata: {
        virtual: true,
        inputMode: 'income',
        recurringRuleId: rule.id,
        recurringMonth: month,
        monthlyCostId: ruleItemId(rule.id, month),
      },
      createdAt: saved.createdAt,
      updatedAt: saved.updatedAt,
    });
    expect(entries).toEqual([
      purchase('2026-07', '2026-07-05'),
      purchase('2026-08', '2026-08-05'),
      purchase('2026-09', '2026-09-05'),
    ]);
    const item = (month: string, startDate: string, endDate: string): MonthlyCostItem => ({
      id: ruleItemId(rule.id, month),
      name: '給与振込',
      amount: 300000,
      startDate,
      endDate,
      expenseAccountId: bank.id,
      createdAt: saved.createdAt,
      updatedAt: saved.updatedAt,
    });
    expect(items).toEqual([
      item('2026-07', '2026-07-05', '2026-08-05'),
      item('2026-08', '2026-08-05', '2026-09-05'),
      item('2026-09', '2026-09-05', '2026-10-05'),
    ]);
    // 保存されるのはルール本体だけ（購入行も item も保存しない）。
    expect(ledger.journalEntries).toEqual([]);
    expect(ledger.monthlyCostItems).toEqual([]);
    expect(ledgerExportPackageSchema.safeParse(buildExportPackage(ledger)).success).toBe(true);
  });

  it('振替ルール（源泉=銀行・計上先=投資）: 保存形も導出行も台帳経由の一形', async () => {
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
    const { ledger, entries, items } = await derivedFor('2026-08-31');
    const saved = ledger.recurringRules.find((candidate) => candidate.id === rule.id)!;
    expect(saved.spreadExpenseAccountId).toBe(invest.id);
    expect(saved.debitAccountId).toBe(CONTINUOUS_COST_LEDGER_ACCOUNT_ID);
    const purchase = (month: string, date: string): JournalEntry => ({
      id: ruleEntryId(rule.id, month),
      date,
      description: 'NISA積立',
      kind: 'normal',
      lines: [
        { accountId: CONTINUOUS_COST_LEDGER_ACCOUNT_ID, side: 'debit', amount: 33333 },
        { accountId: bank.id, side: 'credit', amount: 33333 },
      ],
      metadata: {
        virtual: true,
        // 資金 → 資金の積立ルールは 'transfer'（v13.15 §2.4b）。
        inputMode: 'transfer',
        recurringRuleId: rule.id,
        recurringMonth: month,
        monthlyCostId: ruleItemId(rule.id, month),
      },
      createdAt: saved.createdAt,
      updatedAt: saved.updatedAt,
    });
    expect(entries).toEqual([purchase('2026-07', '2026-07-01'), purchase('2026-08', '2026-08-01')]);
    expect(items.map((m) => [m.id, m.startDate, m.endDate, m.expenseAccountId])).toEqual([
      [ruleItemId(rule.id, '2026-07'), '2026-07-01', '2026-08-01', invest.id],
      [ruleItemId(rule.id, '2026-08'), '2026-08-01', '2026-09-01', invest.id],
    ]);
    expect(ledger.journalEntries).toEqual([]);
    expect(ledgerExportPackageSchema.safeParse(buildExportPackage(ledger)).success).toBe(true);
  });
});

/*
 * 起票ゼロの線分は保存できない（v13.3・不変則）。
 *
 * 実ユーズ指摘（2026-08-16）: 初回の起票日より前へ終了点を打つと、起票を 1 本も持たない
 * ルールが残った（実害は無いが宣言モデルでは「生まれない線」= 意味を持たない）。
 * 期間の短縮そのものは正当（生まれたものを消す）だが、起票がゼロになるなら
 * それは終了ではなく削除。保存境界が拒否し、エラー文で削除の扉を指す。
 */
describe('起票ゼロの線分は保存できない', () => {
  async function baseRule() {
    const bank = await accountByName('預金');
    const invest = await accountByName('投資');
    return { bank, invest };
  }

  it('作成: 初回の起票日が期間の外なら拒否する', async () => {
    const { bank, invest } = await baseRule();
    // 初回の起票 = 2026-12-01（12 か月ごと）。期間 [7/1, 11/1) はそれを含まない。
    await expect(
      createRecurringRule({
        name: '生まれない線',
        amount: 1000,
        dayOfMonth: 1,
        everyMonths: 12,
        debitAccountId: invest.id,
        creditAccountId: bank.id,
        startMonth: '2026-12',
        startDate: '2026-07-01',
        endDate: '2026-11-01',
      }),
    ).rejects.toMatchObject({ code: 'error.recurring.neverPosts' });
    expect((await loadLedger()).recurringRules).toHaveLength(0);
  });

  it('編集: 終了点を初回の起票日より前へ動かすと拒否し、ルールは元のまま', async () => {
    const { bank, invest } = await baseRule();
    const rule = await createRecurringRule({
      name: 'サブスク予定',
      amount: 1000,
      dayOfMonth: 1,
      everyMonths: 12,
      debitAccountId: invest.id,
      creditAccountId: bank.id,
      startMonth: '2026-12',
      startDate: '2026-07-01',
    });
    await expect(upsertRecurringRule({ ...rule, endDate: '2026-11-01' })).rejects.toMatchObject({
      code: 'error.recurring.neverPosts',
    });
    expect(
      (await loadLedger()).recurringRules.find((r) => r.id === rule.id)?.endDate,
    ).toBeUndefined();
  });

  it('終了（後継なし）: 起票が 1 本も残らない終了点は拒否する', async () => {
    const { bank, invest } = await baseRule();
    const rule = await createRecurringRule({
      name: 'サブスク予定',
      amount: 1000,
      dayOfMonth: 1,
      everyMonths: 12,
      debitAccountId: invest.id,
      creditAccountId: bank.id,
      startMonth: '2026-12',
      startDate: '2026-07-01',
    });
    await expect(
      switchRecurringRule({ ruleId: rule.id, effectiveDate: '2026-11-01', successor: null }),
    ).rejects.toMatchObject({ code: 'error.recurring.neverPosts' });
    expect(
      (await loadLedger()).recurringRules.find((r) => r.id === rule.id)?.endDate,
    ).toBeUndefined();
  });

  it('起票が 1 本でも残る終了点は通る（期間短縮そのものは正当）', async () => {
    const { bank, invest } = await baseRule();
    const rule = await createRecurringRule({
      name: '毎月のもの',
      amount: 1000,
      dayOfMonth: 20,
      debitAccountId: invest.id,
      creditAccountId: bank.id,
      startMonth: '2026-04',
      startDate: '2026-04-12',
    });
    // 4/20 の 1 本だけ残して閉じる（5/20 以降は消える）= 終了として正当。
    await upsertRecurringRule({ ...rule, endDate: '2026-05-01' });
    expect((await derivedFor('2026-06-30')).entries.map((e) => e.date)).toEqual(['2026-04-20']);
  });

  it('起票ゼロ線分への切り替えは残骸を作らず、同じルールの編集として保存される（v13.9 項目 4）', async () => {
    const { bank, invest } = await baseRule();
    const rule = await createRecurringRule({
      name: '切り替える線',
      amount: 1000,
      dayOfMonth: 20,
      debitAccountId: invest.id,
      creditAccountId: bank.id,
      startMonth: '2026-04',
      startDate: '2026-04-12',
    });
    // 旧線分 [4/12, 4/18) は 1 本も起票しない = 切り替えではなく編集（全期間引き直し）。
    // 旧仕様は起票ゼロの残余線分 + 後継の 2 本を保存していた（監査 #1 の残骸の発生源）。
    await switchRecurringRule({
      ruleId: rule.id,
      effectiveDate: '2026-04-18',
      successor: { amount: 1500, dayOfMonth: 20, everyMonths: 1 },
    });
    const ledger = await loadLedger();
    expect(ledger.recurringRules).toHaveLength(1);
    const edited = ledger.recurringRules[0]!;
    expect(edited.id).toBe(rule.id);
    expect(edited.startDate).toBe('2026-04-12');
    expect(edited.amount).toBe(1500);
    expect((await derivedFor('2026-04-30')).entries.map((e) => e.date)).toEqual(['2026-04-20']);
  });
});
