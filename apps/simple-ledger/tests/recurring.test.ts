/*
 * 定期ルール（毎月の支出・収入・振替 = 実仕訳の自動起票）。
 *  - キャッチアップ起票: 経過月ぶんを実仕訳として起票・idempotent・月末クランプ。
 *  - カーソル: 起票済み仕訳を削除しても再起票しない（スキップの尊重）。
 *  - 停止/再開: 停止中は起票しない。再開（startMonth 更新）で過去を遡らない。
 *  - 削除: ルールを消しても起票済み仕訳は通常仕訳として残る（メタデータを剥がす）。
 *  - export → schema round-trip / 旧バックアップ（recurringRules キー欠落）の受け入れ。
 */
import { describe, expect, it } from 'vitest';
import './setup';
import {
  catchUpRecurringRules,
  createRecurringRule,
  deleteEntry,
  deleteRecurringRule,
  loadLedger,
  upsertRecurringRule,
} from '../src/data/repository';
import { clampDayToMonth, recurringPostingsDue } from '../src/domain/recurring';
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

  it('不正な組み合わせ（費用→収入など）は fail-closed に弾く', async () => {
    const expense = await accountByName('固定費');
    const income = await accountByName('給与');
    await expect(
      createRecurringRule({
        name: 'x',
        amount: 100,
        dayOfMonth: 1,
        debitAccountId: income.id,
        creditAccountId: expense.id,
        startMonth: '2026-07',
      }),
    ).rejects.toThrow(LedgerError);
  });

  it('export round-trip と旧バックアップ（キー欠落）の受け入れ', async () => {
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
    // 旧バックアップ相当: recurringRules キーが無い → default [] で受け入れる。
    const legacy: Record<string, unknown> = { ...pkg };
    delete legacy.recurringRules;
    const parsed = ledgerExportPackageSchema.safeParse(legacy);
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.recurringRules).toEqual([]);
  });
});

describe('clampDayToMonth / recurringPostingsDue', () => {
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
      managementScopeId: 's',
      createdAt: 't',
      updatedAt: 't',
    };
    expect(recurringPostingsDue(rule, '2026-07-23')).toEqual([]);
  });
});
