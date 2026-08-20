/*
 * 2026-07-30 監査（simple-ledger-codex-audit-response-20260730）対応の回帰テスト。
 * 番号は監査報告書の指摘番号（P1-1 など）に対応する。
 */
import { describe, expect, it } from 'vitest';
import './setup';
import {
  _resetRepositoryStateForTests,
  archiveAccount,
  archiveMonthlyCost,
  createContinuousCost,
  createRecurringRule,
  deleteAccount,
  ensureInitialized,
  loadLedger,
  replaceLedger,
  resetAll,
  upsertAccount,
  upsertEntry,
  upsertMonthlyCost,
  upsertRecurringRule,
} from '../src/data/repository';
import { buildExportPackage, exportToJsonText, importFromJsonText } from '../src/data/exportImport';
import { getAll, getKv, putKv, wipeDatabase, STORE } from '../src/data/db';
import { DB_NAME, MAX_LEDGER_REVISION } from '../src/data/constants';
import { buildSimpleEntry } from '../src/domain/entry';
import { ledgerExportPackageSchema, recurringRuleSchema } from '../src/domain/schema';
import { deriveRecurringOutputs } from '../src/domain/recurring';
import { addMonths } from '../src/domain/allocation';
import { CONTINUOUS_COST_LEDGER_ACCOUNT_ID } from '../src/domain/constants';
import { reportEntriesForAsOf } from '../src/domain/reportEntries';
import { todayLocal } from '../src/util/time';
import type { Account, LedgerMeta, LedgerExportPackage } from '../src/domain/types';

async function accountByName(name: string): Promise<Account> {
  const ledger = await loadLedger();
  const a = ledger.accounts.find((x) => x.name === name);
  if (!a) throw new Error(`seed に ${name} がない`);
  return a;
}

function makeAccount(over: Partial<Account> & { id: string; name: string }): Account {
  return {
    type: 'asset',
    role: 'daily-asset',
    archived: false,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...over,
  } as Account;
}

function clonePkg(pkg: LedgerExportPackage): LedgerExportPackage {
  return JSON.parse(JSON.stringify(pkg)) as LedgerExportPackage;
}

describe('P1-1: 回収の振替の形（借方 ≠ 台帳・振替先 role・日付 >= 開始日）', () => {
  async function seededRecoveryPkg(): Promise<LedgerExportPackage> {
    const bank = await accountByName('預金');
    const expense = await accountByName('変動費');
    const item = await createContinuousCost({
      name: '洗濯機',
      amount: 12000,
      startDate: '2026-01-10',
      expenseAccountId: expense.id,
      creditAccountId: bank.id,
    });
    await archiveMonthlyCost({
      id: item.id,
      endDate: '2026-06-30',
      recoveries: [{ destinationAccountId: bank.id, amount: 3000 }],
    });
    return buildExportPackage(await loadLedger());
  }

  it('正常な回収を含む package は valid（baseline）', async () => {
    const pkg = await seededRecoveryPkg();
    expect(ledgerExportPackageSchema.safeParse(pkg).success).toBe(true);
  });

  it('借方 = 台帳の自己振替回収は import で拒否する', async () => {
    const pkg = clonePkg(await seededRecoveryPkg());
    const recovery = pkg.journalEntries.find((e) => e.metadata?.monthlyCostRecovery === true)!;
    recovery.lines.find((l) => l.side === 'debit')!.accountId = CONTINUOUS_COST_LEDGER_ACCOUNT_ID;
    expect(ledgerExportPackageSchema.safeParse(pkg).success).toBe(false);
  });

  it('振替先が費用カテゴリの回収も import で受理する', async () => {
    const pkg = clonePkg(await seededRecoveryPkg());
    const expense = pkg.accounts.find((a) => a.name === '変動費')!;
    const recovery = pkg.journalEntries.find((e) => e.metadata?.monthlyCostRecovery === true)!;
    recovery.lines.find((l) => l.side === 'debit')!.accountId = expense.id;
    expect(ledgerExportPackageSchema.safeParse(pkg).success).toBe(true);
  });

  it('開始日（購入の仕訳の日付）より前の回収は import で拒否する', async () => {
    const pkg = clonePkg(await seededRecoveryPkg());
    const recovery = pkg.journalEntries.find((e) => e.metadata?.monthlyCostRecovery === true)!;
    recovery.date = '2026-01-09'; // startDate = 2026-01-10 より前
    expect(ledgerExportPackageSchema.safeParse(pkg).success).toBe(false);
  });

  it('保存境界: 回収の日付を開始日より前へ編集できない', async () => {
    await seededRecoveryPkg();
    const ledger = await loadLedger();
    const recovery = ledger.journalEntries.find((e) => e.metadata?.monthlyCostRecovery === true)!;
    await expect(upsertEntry({ ...recovery, date: '2026-01-09' })).rejects.toMatchObject({
      code: 'error.monthlyCost.recoveryBeforeStart',
    });
  });

  it('保存境界: 購入日を回収の振替より後ろへ動かせない', async () => {
    await seededRecoveryPkg();
    const ledger = await loadLedger();
    const purchase = ledger.journalEntries.find(
      (e) => e.metadata?.monthlyCostId && e.metadata.monthlyCostRecovery !== true,
    )!;
    // 回収は 2026-06-30。購入日をその後ろへ。
    await expect(upsertEntry({ ...purchase, date: '2026-07-01' })).rejects.toMatchObject({
      code: 'error.monthlyCost.recoveryBeforeStart',
    });
  });
});

describe('P1-2: 科目アーカイブの残高判定は導出仕訳（計算で生まれる費用行）を含む', () => {
  it('保存仕訳が無くても、月割りの行き先で残高が生まれた資産科目はアーカイブできない', async () => {
    const bank = await accountByName('預金');
    const target = makeAccount({ id: 'audit-b', name: '前払い箱' });
    await upsertAccount(target);
    // 費用の行き先 = 資産科目 target。導出の費用行が target を借方に積む。
    const start = addMonths(todayLocal().slice(0, 7), -3);
    await createContinuousCost({
      name: '年払い',
      amount: 12000,
      startDate: `${start}-01`,
      endDate: todayLocal(),
      expenseAccountId: target.id,
      creditAccountId: bank.id,
    });
    await expect(
      upsertAccount({ ...target, archived: true, updatedAt: '2026-07-30T00:00:00.000Z' }),
    ).rejects.toMatchObject({ code: 'error.account.archiveBalance' });
    await expect(archiveAccount(target.id)).rejects.toMatchObject({
      code: 'error.account.archiveBalance',
    });
  });
});

describe('P1-3: 終了点は未来仕訳も包含する', () => {
  it('今日残高 0 でも未来仕訳がある科目は今日で終了できず、現在状態のexportは有効', async () => {
    const bank = await accountByName('預金');
    const target = makeAccount({ id: 'audit-c', name: '積立予定口座' });
    await upsertAccount(target);
    // 未来日付の振替（今日残高には効かない・最終残高は +100）。
    await upsertEntry(
      buildSimpleEntry({
        date: '2027-01-15',
        description: '未来の積立',
        debitAccountId: target.id,
        creditAccountId: bank.id,
        amount: 100,
      }),
    );
    await expect(archiveAccount(target.id)).rejects.toMatchObject({
      code: 'error.account.referenceOutsidePeriod',
    });
    const pkg = buildExportPackage(await loadLedger());
    const parsed = ledgerExportPackageSchema.safeParse(pkg);
    expect(parsed.success).toBe(true);
  });
});

describe('P1-4: 旧版 DB（meta.schemaVersion 不一致）の fail-closed', () => {
  it('読み取りの入口（ensureInitialized / loadLedger）が版不一致で拒否する', async () => {
    await loadLedger();
    const meta = (await getKv<LedgerMeta>('meta'))!;
    await putKv('meta', { ...meta, schemaVersion: meta.schemaVersion - 1 });
    await expect(loadLedger()).rejects.toMatchObject({
      code: 'error.db.schemaVersionMismatch',
    });
    // v13: 起動時の一括起票が無くなったので、入口は loadLedger が必ず通る
    // ensureInitialized だけ。ゲート本体も同じ code で fail-closed に止まること。
    await expect(ensureInitialized()).rejects.toMatchObject({
      code: 'error.db.schemaVersionMismatch',
    });
  });
});

describe('P1-5: revision CAS（別タブの並行変更を検出して abort する）', () => {
  it('事前読みの後に revision が進んでいたら保存を拒否する', async () => {
    await loadLedger();
    // 別タブの書込みを模す: repository を通さず revision だけ進める。
    const meta = (await getKv<LedgerMeta>('meta'))!;
    await putKv('meta', { ...meta, revision: meta.revision + 1 });
    await expect(
      upsertAccount(makeAccount({ id: 'acc-cas', name: '競合テスト' })),
    ).rejects.toMatchObject({ code: 'error.common.staleData' });
    // 再読み込み（loadLedger）でトラッカが追従すれば保存できる。
    await loadLedger();
    await expect(
      upsertAccount(makeAccount({ id: 'acc-cas', name: '競合テスト' })),
    ).resolves.toBeUndefined();
  });
});

describe('P1-6: 負債（カード・ローン）で買った購入の仕訳は支払い元・金額を変更できない', () => {
  async function liabilityPurchase() {
    const card = await accountByName('クレジットカード');
    const expense = await accountByName('変動費');
    const item = await createContinuousCost({
      name: 'カード購入',
      amount: 24000,
      startDate: '2026-06-10',
      expenseAccountId: expense.id,
      creditAccountId: card.id,
    });
    const ledger = await loadLedger();
    const purchase = ledger.journalEntries.find(
      (e) => e.metadata?.monthlyCostId === item.id && e.metadata.monthlyCostRecovery !== true,
    )!;
    return { item, purchase };
  }

  it('貸方の付け替えを拒否する', async () => {
    const { purchase } = await liabilityPurchase();
    const bank = await accountByName('預金');
    const lines = purchase.lines.map((l) =>
      l.side === 'credit' ? { ...l, accountId: bank.id } : l,
    );
    await expect(upsertEntry({ ...purchase, lines })).rejects.toMatchObject({
      code: 'error.monthlyCost.editLiability',
    });
  });

  it('金額の変更を拒否する（仕訳側・item 側の両方）', async () => {
    const { item, purchase } = await liabilityPurchase();
    const lines = purchase.lines.map((l) => ({ ...l, amount: 30000 }));
    await expect(upsertEntry({ ...purchase, lines })).rejects.toMatchObject({
      code: 'error.monthlyCost.editLiability',
    });
    await expect(upsertMonthlyCost({ ...item, amount: 30000 })).rejects.toMatchObject({
      code: 'error.monthlyCost.editLiability',
    });
  });

  it('摘要の変更はできるが、日付の変更は拒否する（返済が購入より先に立たない・再監査対応）', async () => {
    const { purchase } = await liabilityPurchase();
    await expect(
      upsertEntry({ ...purchase, description: 'カード購入（修正）' }),
    ).resolves.toBeUndefined();
    await expect(upsertEntry({ ...purchase, date: '2026-06-12' })).rejects.toMatchObject({
      code: 'error.monthlyCost.editLiability',
    });
  });
});

describe('P1-7: 定期ルールの科目参照の保護', () => {
  it('まだ 1 件も導出していない定期ルールだけが参照する科目は削除できない', async () => {
    const bank = await accountByName('預金');
    const target = makeAccount({
      id: 'audit-rule-exp',
      name: 'サブスク費',
      type: 'expense',
      role: 'expense-category',
    });
    await upsertAccount(target);
    await createRecurringRule({
      name: '来月からのサブスク',
      amount: 980,
      dayOfMonth: 1,
      debitAccountId: target.id,
      creditAccountId: bank.id,
      startMonth: addMonths(todayLocal().slice(0, 7), 2), // まだ 1 件も起票されない
    });
    await expect(deleteAccount(target.id)).rejects.toMatchObject({
      code: 'error.account.deleteInUse',
    });
  });

  it('開区間のルールが参照する科目は終了できない', async () => {
    const bank = await accountByName('預金');
    const target = makeAccount({
      id: 'audit-rule-archived',
      name: '旧カテゴリ',
      type: 'expense',
      role: 'expense-category',
    });
    await upsertAccount(target);
    await createRecurringRule({
      name: '旧カテゴリの支払い',
      amount: 500,
      dayOfMonth: 1,
      debitAccountId: target.id,
      creditAccountId: bank.id,
      startMonth: addMonths(todayLocal().slice(0, 7), -2),
    });
    await expect(archiveAccount(target.id)).rejects.toMatchObject({
      code: 'error.account.referenceOutsidePeriod',
    });
  });
});

describe('全期間編集・切り替えの導出（既存の起票に縛られない）', () => {
  it('全期間編集で年次 → 毎月へ変えると、全期間が毎月位相で引き直される', async () => {
    const bank = await accountByName('預金');
    const expense = await accountByName('固定費');
    const rule = await createRecurringRule({
      name: '年払い→月払い',
      amount: 12000,
      dayOfMonth: 1,
      everyMonths: 12,
      debitAccountId: expense.id,
      creditAccountId: bank.id,
      startMonth: '2026-01',
      startDate: '2026-01-01',
    });
    let ledger = await loadLedger();
    // 年払いのまま: 2026-01 の 1 本だけ（〜2026-12 を覆う item）。
    expect(
      deriveRecurringOutputs(ledger.recurringRules, ledger.accounts, '2026-01-15').entries,
    ).toHaveLength(1);

    const stored = ledger.recurringRules.find((r) => r.id === rule.id)!;
    await upsertRecurringRule(
      { ...stored, amount: 3000, everyMonths: 1 },
      { amountChangeMode: 'retroactive' },
    );

    ledger = await loadLedger();
    const derivedAt = (asOf: string) =>
      deriveRecurringOutputs(ledger.recurringRules, ledger.accounts, asOf);
    // 引き直し後は毎月位相。断面ごとの本数は「その日まで」の累計になる
    // （起票済みという状態を持たないので、同じ断面は何度読んでも同じ姿）。
    expect(derivedAt('2026-07-15').entries).toHaveLength(7);
    expect(derivedAt('2026-12-15').entries).toHaveLength(12);
    const final = derivedAt('2027-01-05');
    expect(final.entries).toHaveLength(13);
    expect(final.items.map((m) => m.id).sort()).toEqual(
      Array.from({ length: 13 }, (_, index) => `ccr-${rule.id}-${addMonths('2026-01', index)}`),
    );
    expect(final.items.every((item) => item.amount === 3000)).toBe(true);
    // 保存側に残るのはルールだけ（導出は export に載らない）。現在状態の export は有効。
    expect(ledgerExportPackageSchema.safeParse(buildExportPackage(ledger)).success).toBe(true);
  });

  it('全期間編集と切り替えは、既存の起票に関係なく同じ2月位相の item を導出する', async () => {
    const bank = await accountByName('預金');
    const expense = await accountByName('固定費');
    const normallyEditedRule = await createRecurringRule({
      name: '通常編集する年払い',
      amount: 12000,
      dayOfMonth: 20,
      everyMonths: 12,
      debitAccountId: expense.id,
      creditAccountId: bank.id,
      startMonth: '2026-01',
      startDate: '2026-01-01',
    });
    const rule = await createRecurringRule({
      name: '年払いから月払いへ分割',
      amount: 12000,
      dayOfMonth: 20,
      everyMonths: 12,
      debitAccountId: expense.id,
      creditAccountId: bank.id,
      startMonth: '2026-01',
      startDate: '2026-01-01',
    });
    const beforeEdit = await loadLedger();
    // 年払い 2 本 = 2026-01-20 に 1 本ずつ。
    expect(
      deriveRecurringOutputs(beforeEdit.recurringRules, beforeEdit.accounts, '2026-01-20').entries,
    ).toHaveLength(2);
    const normallyEditedStored = beforeEdit.recurringRules.find(
      (candidate) => candidate.id === normallyEditedRule.id,
    )!;
    const stored = beforeEdit.recurringRules.find((candidate) => candidate.id === rule.id)!;
    await upsertRecurringRule(
      { ...normallyEditedStored, amount: 3000, everyMonths: 1 },
      { amountChangeMode: 'retroactive' },
    );
    await upsertRecurringRule(
      { ...stored, amount: 3000, everyMonths: 1 },
      { amountChangeMode: 'split', effectiveDate: '2026-02-10' },
    );

    const after = await loadLedger();
    const successor = after.recurringRules.find(
      (candidate) => candidate.id !== rule.id && candidate.id !== normallyEditedRule.id,
    )!;
    const derived = deriveRecurringOutputs(after.recurringRules, after.accounts, '2026-02-28');
    // 2/28 断面の起票: 全期間編集は 1 月・2 月、切り替えは旧線分が 1 月・後継が 2 月
    // （境界日 2026-02-10 は半開区間なので 2 月分は後継だけが持つ）。
    expect(derived.entries.map((entry) => entry.id).sort()).toEqual(
      [
        `rec-${normallyEditedRule.id}-2026-01`,
        `rec-${normallyEditedRule.id}-2026-02`,
        `rec-${rule.id}-2026-01`,
        `rec-${successor.id}-2026-02`,
      ].sort(),
    );
    const itemById = new Map(derived.items.map((item) => [item.id, item] as const));
    // 2 月ぶんは編集後のルール（everyMonths 1・dayOfMonth 20）で作られる:
    // 起票月 2026-02 + 1 か月 = 2026-03 の 20 日 = 次回起票日と同日。
    expect(itemById.get(`ccr-${normallyEditedRule.id}-2026-02`)).toMatchObject({
      amount: 3000,
      endDate: '2026-03-20',
    });
    expect(itemById.get(`ccr-${successor.id}-2026-02`)).toMatchObject({
      amount: 3000,
      endDate: '2026-03-20',
    });
    // 切り替えの旧線分は編集前の姿のまま（everyMonths 12）: 2026-01 + 12 か月 = 2027-01-20。
    expect(itemById.get(`ccr-${rule.id}-2026-01`)).toMatchObject({
      amount: 12000,
      endDate: '2027-01-20',
    });
    // 全期間編集は過去の回も現在のルール値で引き直す（金額だけでなく周期・item 期間も）。
    // 1 月ぶんは everyMonths 1 として [1/20, 2/20] になる。
    expect(itemById.get(`ccr-${normallyEditedRule.id}-2026-01`)).toMatchObject({
      amount: 3000,
      endDate: '2026-02-20',
    });

    const februaryAllocations = reportEntriesForAsOf(after, '2026-02-28')
      .filter((entry) => entry.date >= '2026-02-01' && entry.date <= '2026-02-28')
      .filter((entry) => entry.metadata?.ccKind === 'monthly-allocation');
    const expenseForItems = (itemIds: Set<string>): number =>
      februaryAllocations
        .filter((entry) => itemIds.has(entry.metadata?.continuousCostId ?? ''))
        .flatMap((entry) => entry.lines)
        .filter((line) => line.accountId === expense.id && line.side === 'debit')
        .reduce((sum, line) => sum + line.amount, 0);
    // 2 月に立つ刻みは 1 月起票ぶんの 2/20（12,000 / 12 刻み = 1,000）だけ。2 月起票ぶんの
    // 刻みは 3/20（購入当日の費用 0）なので 2 月には 1 円も入らない。
    expect(
      expenseForItems(new Set([`ccr-${rule.id}-2026-01`, `ccr-${successor.id}-2026-02`])),
    ).toBe(1000);
    // v13: 全期間編集は過去の item も現在のルール値（金額・周期）で引き直す。
    // 1 月起票ぶんは everyMonths 1 で [1/20, 2/20] の 1 刻みになり、2/20 に 3,000 が立つ
    // （v12 の「金額だけ訂正・生成時の期間は凍結」は保存実体とともに廃止）。
    expect(
      expenseForItems(
        new Set([`ccr-${normallyEditedRule.id}-2026-01`, `ccr-${normallyEditedRule.id}-2026-02`]),
      ),
    ).toBe(3000);
    expect(ledgerExportPackageSchema.safeParse(buildExportPackage(after)).success).toBe(true);
  });
});

describe('P2-3: 定期ルールの everyMonths 上限（配分上限と同じ 1,200）', () => {
  const base = {
    id: 'r',
    name: 'x',
    amount: 100,
    dayOfMonth: 1,
    debitAccountId: CONTINUOUS_COST_LEDGER_ACCOUNT_ID,
    spreadExpenseAccountId: 'a',
    creditAccountId: 'b',
    startMonth: '2026-01',
    startDate: '2026-01-01',
    createdAt: 'x',
    updatedAt: 'x',
  };
  it('1200 は valid・1201 は invalid', () => {
    expect(recurringRuleSchema.safeParse({ ...base, everyMonths: 1200 }).success).toBe(true);
    expect(recurringRuleSchema.safeParse({ ...base, everyMonths: 1201 }).success).toBe(false);
  });
  it('保存境界でも拒否する（ルールだけが残らない）', async () => {
    const bank = await accountByName('預金');
    const expense = await accountByName('固定費');
    await expect(
      createRecurringRule({
        name: '超長周期',
        amount: 100,
        dayOfMonth: 1,
        everyMonths: 1201,
        debitAccountId: expense.id,
        creditAccountId: bank.id,
      }),
    ).rejects.toMatchObject({ code: 'error.recurring.invalidStructure' });
    expect((await loadLedger()).recurringRules).toHaveLength(0);
  });
});

describe('P2-5: DB 全消去は onsuccess だけを成功扱いにする', () => {
  it('別接続が DB を開いたままなら wipeDatabase は失敗する（reload しない）', async () => {
    await loadLedger();
    const held = await new Promise<IDBDatabase>((resolve, reject) => {
      const req = indexedDB.open(DB_NAME);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error ?? new Error('open failed'));
    });
    try {
      await expect(wipeDatabase()).rejects.toThrow();
    } finally {
      held.close();
    }
  });
});

describe('再監査対応: import は全置換後に revision を必ず進める', () => {
  it('置換後 revision = max(現行, 封筒) + 1。再取込のたびに単調に進む', async () => {
    await loadLedger();
    await upsertAccount(makeAccount({ id: 'acc-rev', name: '再監査' }));
    const ledger = await loadLedger();
    const before = ledger.meta.revision;
    const text = exportToJsonText(ledger);
    // 科目だけの変更は「空の台帳」（取引データなし・v13.9 項目 1）なので取り込める。
    const outcome = await importFromJsonText(text);
    expect(outcome.kind).toBe('ok');
    // revision が進む = 別タブの CAS（import 前の revision を基準に持つ）が必ず失火する。
    expect((await loadLedger()).meta.revision).toBe(before + 1);
    // v13.9: 世代比較（revision-conflict → force）は撤去。再取込も同じ規則で単調に進むだけ。
    const second = await importFromJsonText(text);
    expect(second.kind).toBe('ok');
    expect((await loadLedger()).meta.revision).toBe(before + 2);
  });

  it('事前snapshot後に別操作が保存されたら、全置換をCASで拒否して更新を残す', async () => {
    const snapshot = await loadLedger();
    await upsertAccount(makeAccount({ id: 'acc-after-snapshot', name: 'snapshot後の更新' }));

    await expect(
      replaceLedger(
        {
          meta: snapshot.meta,
          settings: snapshot.settings,
          accounts: snapshot.accounts,
          journalEntries: snapshot.journalEntries,
          monthlyCostItems: snapshot.monthlyCostItems,
          recurringRules: snapshot.recurringRules,
        },
        { deviceId: snapshot.meta.deviceId, revision: snapshot.meta.revision },
      ),
    ).rejects.toMatchObject({ code: 'error.common.staleData' });

    expect(
      (await loadLedger()).accounts.some((account) => account.id === 'acc-after-snapshot'),
    ).toBe(true);
  });

  it('全初期化で revision が同値へ戻っても、deviceId の世代差で古い全置換を拒否する', async () => {
    const beforeReset = await loadLedger();
    await resetAll();
    const afterReset = await loadLedger();
    expect(afterReset.meta.deviceId).not.toBe(beforeReset.meta.deviceId);

    await expect(
      replaceLedger(
        {
          meta: beforeReset.meta,
          settings: beforeReset.settings,
          accounts: beforeReset.accounts,
          journalEntries: beforeReset.journalEntries,
          monthlyCostItems: beforeReset.monthlyCostItems,
          recurringRules: beforeReset.recurringRules,
        },
        { deviceId: beforeReset.meta.deviceId, revision: beforeReset.meta.revision },
      ),
    ).rejects.toMatchObject({ code: 'error.common.staleData' });

    expect((await loadLedger()).meta.deviceId).toBe(afterReset.meta.deviceId);
  });

  it('revision 上限では unsafe integer を保存せず fail-closed に止める', async () => {
    const ledger = await loadLedger();
    await putKv('meta', { ...ledger.meta, revision: MAX_LEDGER_REVISION });
    _resetRepositoryStateForTests();
    await loadLedger();

    await expect(
      upsertAccount(makeAccount({ id: 'acc-overflow', name: '上限' })),
    ).rejects.toMatchObject({ code: 'error.common.revisionExhausted' });
    expect((await getAll<Account>(STORE.accounts)).some((a) => a.id === 'acc-overflow')).toBe(
      false,
    );
  });

  it('safe integer を超える封筒 revision は schema で拒否する', async () => {
    const pkg = buildExportPackage(await loadLedger());
    expect(
      ledgerExportPackageSchema.safeParse({
        ...pkg,
        revision: MAX_LEDGER_REVISION + 1,
      }).success,
    ).toBe(false);
  });
});

describe('再監査対応: 同一タブの変更操作を事前読込から直列化する', () => {
  it('同時に開始した2保存を順に検証・保存し、後続を stale tracker へ乗せ替えない', async () => {
    const before = await loadLedger();
    const results = await Promise.allSettled([
      upsertAccount(makeAccount({ id: 'acc-serial-a', name: '直列A' })),
      upsertAccount(makeAccount({ id: 'acc-serial-b', name: '直列B' })),
    ]);

    expect(results.map((result) => result.status)).toEqual(['fulfilled', 'fulfilled']);
    const after = await loadLedger();
    expect(after.meta.revision).toBe(before.meta.revision + 2);
    expect(
      after.accounts
        .map((account) => account.id)
        .filter((id) => id.startsWith('acc-serial-'))
        .sort(),
    ).toEqual(['acc-serial-a', 'acc-serial-b']);
  });

  it('同名科目の同時作成は先行結果を見て再検証し、後続だけを拒否する', async () => {
    const before = await loadLedger();
    const results = await Promise.allSettled([
      upsertAccount(makeAccount({ id: 'acc-same-name-a', name: '同時作成' })),
      upsertAccount(makeAccount({ id: 'acc-same-name-b', name: '同時作成' })),
    ]);

    expect(results[0]?.status).toBe('fulfilled');
    expect(results[1]).toMatchObject({
      status: 'rejected',
      reason: { code: 'error.account.nameConflict' },
    });
    const after = await loadLedger();
    expect(after.meta.revision).toBe(before.meta.revision + 1);
    expect(after.accounts.filter((account) => account.name === '同時作成')).toHaveLength(1);
  });
});

describe('P3-1: 購入の仕訳の kind は貸方 role から導出する', () => {
  it('持ち込み（equity）→ 預金へ付け替えると normal、逆は opening になる', async () => {
    const expense = await accountByName('変動費');
    const bank = await accountByName('預金');
    const item = await createContinuousCost({
      name: '持ち込み資産',
      amount: 6000,
      startDate: '2026-06-01',
      expenseAccountId: expense.id,
      // creditAccountId 未指定 = 持ち込み（貸方 初期残高・kind: opening）
    });
    const ledger = await loadLedger();
    const purchase = ledger.journalEntries.find(
      (e) => e.metadata?.monthlyCostId === item.id && e.metadata.monthlyCostRecovery !== true,
    )!;
    expect(purchase.kind).toBe('opening');

    const equityLine = purchase.lines.find((l) => l.side === 'credit')!;
    await upsertEntry({
      ...purchase,
      lines: purchase.lines.map((l) => (l.side === 'credit' ? { ...l, accountId: bank.id } : l)),
    });
    let after = (await loadLedger()).journalEntries.find((e) => e.id === purchase.id)!;
    expect(after.kind).toBe('normal');

    await upsertEntry({
      ...after,
      lines: after.lines.map((l) =>
        l.side === 'credit' ? { ...l, accountId: equityLine.accountId } : l,
      ),
    });
    after = (await loadLedger()).journalEntries.find((e) => e.id === purchase.id)!;
    expect(after.kind).toBe('opening');
  });
});
