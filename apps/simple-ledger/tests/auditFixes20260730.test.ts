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
  catchUpRecurringRules,
  createContinuousCost,
  createRecurringRule,
  deleteAccount,
  loadLedger,
  upsertAccount,
  upsertEntry,
  upsertMonthlyCost,
  upsertRecurringRule,
  upsertTag,
} from '../src/data/repository';
import {
  buildExportPackage,
  exportToJsonText,
  importFromJsonText,
} from '../src/data/exportImport';
import { getAll, getKv, putKv, putRecord, wipeDatabase, STORE } from '../src/data/db';
import { DB_NAME } from '../src/data/constants';
import { buildSimpleEntry } from '../src/domain/entry';
import { ledgerExportPackageSchema, recurringRuleSchema } from '../src/domain/schema';
import {
  CATCH_UP_HARD_CAP_MONTHS,
  recurringCursorAfter,
  recurringPostingsDue,
  ruleItemCoverageThrough,
} from '../src/domain/recurring';
import { addMonths } from '../src/domain/allocation';
import { CONTINUOUS_COST_LEDGER_ACCOUNT_ID } from '../src/domain/constants';
import { todayLocal } from '../src/util/time';
import type {
  Account,
  JournalEntry,
  LedgerMeta,
  LedgerExportPackage,
  MonthlyCostItem,
  RecurringRule,
} from '../src/domain/types';

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
      recovery: { destinationAccountId: bank.id, amount: 3000 },
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

  it('振替先が許可 role 以外（費用カテゴリ）の回収は import で拒否する', async () => {
    const pkg = clonePkg(await seededRecoveryPkg());
    const expense = pkg.accounts.find((a) => a.name === '変動費')!;
    const recovery = pkg.journalEntries.find((e) => e.metadata?.monthlyCostRecovery === true)!;
    recovery.lines.find((l) => l.side === 'debit')!.accountId = expense.id;
    expect(ledgerExportPackageSchema.safeParse(pkg).success).toBe(false);
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
    const recovery = ledger.journalEntries.find(
      (e) => e.metadata?.monthlyCostRecovery === true,
    )!;
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
      endDate: `${addMonths(start, 11)}-28`,
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

describe('P1-3: アーカイブ + 未来仕訳の round-trip（保存できた状態は書き出して復元できる）', () => {
  it('今日残高 0・未来仕訳ありの科目をアーカイブでき、export が現行 schema を通る', async () => {
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
    await archiveAccount(target.id); // 今日残高 0 なので成功する
    const pkg = buildExportPackage(await loadLedger());
    const parsed = ledgerExportPackageSchema.safeParse(pkg);
    expect(parsed.success).toBe(true);
  });
});

describe('P1-4: 旧版 DB（meta.schemaVersion 不一致）の fail-closed', () => {
  it('loadLedger も catchUpRecurringRules も版不一致で拒否する', async () => {
    await loadLedger();
    const meta = (await getKv<LedgerMeta>('meta'))!;
    await putKv('meta', { ...meta, schemaVersion: meta.schemaVersion - 1 });
    await expect(loadLedger()).rejects.toMatchObject({
      code: 'error.db.schemaVersionMismatch',
    });
    await expect(catchUpRecurringRules(todayLocal())).rejects.toMatchObject({
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
      upsertTag({
        id: 'tag-cas',
        name: '競合テスト',
        scope: 'entry',
        archived: false,
        createdAt: 'x',
        updatedAt: 'x',
      }),
    ).rejects.toMatchObject({ code: 'error.common.staleData' });
    // 再読み込み（loadLedger）でトラッカが追従すれば保存できる。
    await loadLedger();
    await expect(
      upsertTag({
        id: 'tag-cas',
        name: '競合テスト',
        scope: 'entry',
        archived: false,
        createdAt: 'x',
        updatedAt: 'x',
      }),
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
  it('未起票の定期ルールだけが参照する科目は削除できない', async () => {
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

  it('アーカイブ済み科目を参照するルールは起票しない（残高 0 の不変条件を守る）', async () => {
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
    await archiveAccount(target.id); // 費用科目は残高チェック対象外なので成功する
    expect(await catchUpRecurringRules(todayLocal())).toBe(0);
  });
});

describe('P1-8: catch-up は既存の生成物（決定的 ID）を上書きしない', () => {
  it('カーソル未設定でも、編集済みの仕訳・item をルール既定値で潰さない', async () => {
    const bank = await accountByName('預金');
    const expense = await accountByName('変動費');
    const startMonth = addMonths(todayLocal().slice(0, 7), -1);
    const rule = await createRecurringRule({
      name: '編集済み月',
      amount: 100,
      dayOfMonth: 1,
      spreadExpenseAccountId: expense.id,
      debitAccountId: expense.id,
      creditAccountId: bank.id,
      startMonth,
    });
    await catchUpRecurringRules(todayLocal());
    const entryId = `rec-${rule.id}-${startMonth}`;
    const itemId = `ccr-${rule.id}-${startMonth}`;
    const entries = await getAll<JournalEntry>(STORE.journalEntries);
    const items = await getAll<MonthlyCostItem>(STORE.monthlyCostItems);
    const postedEntry = entries.find((e) => e.id === entryId)!;
    const postedItem = items.find((m) => m.id === itemId)!;

    // 「ユーザーが 100 → 120 に編集し、カーソルだけ未設定」の有効 import 相当を直接作る。
    await putRecord(STORE.journalEntries, {
      ...postedEntry,
      lines: postedEntry.lines.map((l) => ({ ...l, amount: 120 })),
    });
    await putRecord(STORE.monthlyCostItems, { ...postedItem, amount: 120 });
    const rules = await getAll<RecurringRule>(STORE.recurringRules);
    const stored = rules.find((r) => r.id === rule.id)!;
    const noCursor = { ...stored };
    delete noCursor.postedThroughMonth;
    await putRecord(STORE.recurringRules, noCursor);

    await catchUpRecurringRules(todayLocal());
    const after = await getAll<JournalEntry>(STORE.journalEntries);
    const afterItems = await getAll<MonthlyCostItem>(STORE.monthlyCostItems);
    expect(after.find((e) => e.id === entryId)!.lines[0]!.amount).toBe(120);
    expect(afterItems.find((m) => m.id === itemId)!.amount).toBe(120);
  });
});

describe('P1-9: catch-up の走査窓とカーソル（上限超過の月を飛ばさない）', () => {
  const rule: RecurringRule = {
    id: 'r-old',
    name: '超長期',
    amount: 100,
    dayOfMonth: 1,
    everyMonths: 1,
    debitAccountId: 'a',
    creditAccountId: 'b',
    startMonth: '1900-01',
    createdAt: 'x',
    updatedAt: 'x',
  };
  const today = '2026-07-15';

  it('1 回の走査は上限までで、カーソルは走査した最後の月まで', () => {
    const due = recurringPostingsDue(rule, today);
    expect(due).toHaveLength(CATCH_UP_HARD_CAP_MONTHS);
    const cursor = recurringCursorAfter(rule, today);
    expect(cursor).toBe(addMonths('1900-01', CATCH_UP_HARD_CAP_MONTHS - 1)); // 1999-12
  });

  it('次回の走査はカーソルの続きから始まり、最終的に今日へ収束する', () => {
    const second: RecurringRule = { ...rule, postedThroughMonth: '1999-12' };
    const due = recurringPostingsDue(second, today);
    expect(due[0]?.month).toBe('2000-01');
    expect(due).toHaveLength(319); // 2000-01〜2026-07 = 319 か月（<= 上限）
    expect(recurringCursorAfter(second, today)).toBe('2026-07');
  });
});

describe('P1-10: 周期短縮後、既存のルール由来 item が覆う月へ item を重ねない', () => {
  it('年次 → 毎月へ変更しても、既存 item の期間内は起票せず、期間後から起票する', async () => {
    const bank = await accountByName('預金');
    const expense = await accountByName('固定費');
    const rule = await createRecurringRule({
      name: '年払い→月払い',
      amount: 12000,
      dayOfMonth: 1,
      everyMonths: 12,
      spreadExpenseAccountId: expense.id,
      debitAccountId: expense.id,
      creditAccountId: bank.id,
      startMonth: '2026-01',
    });
    expect(await catchUpRecurringRules('2026-01-15')).toBe(1); // 2026-01 起票（〜2026-12 を覆う）

    const ledger = await loadLedger();
    const stored = ledger.recurringRules.find((r) => r.id === rule.id)!;
    await upsertRecurringRule({ ...stored, everyMonths: 1 });

    // 既存 item が 2026-12 まで覆う → 2026 年内は 1 件も足さない。
    expect(await catchUpRecurringRules('2026-07-15')).toBe(0);
    expect(await catchUpRecurringRules('2026-12-15')).toBe(0);
    // 覆いが切れた翌月から新周期で起票する。
    expect(await catchUpRecurringRules('2027-01-05')).toBe(1);

    const after = await loadLedger();
    const ruleItems = after.monthlyCostItems.filter((m) => m.id.startsWith(`ccr-${rule.id}-`));
    expect(ruleItems.map((m) => m.id).sort()).toEqual([
      `ccr-${rule.id}-2026-01`,
      `ccr-${rule.id}-2027-01`,
    ]);
    expect(ruleItemCoverageThrough(rule.id, after.monthlyCostItems)).toBe('2027-01');
    // 生成物一式が import schema（期間重複の不変条件⑤）を通ること。
    expect(ledgerExportPackageSchema.safeParse(buildExportPackage(after)).success).toBe(true);
  });
});

describe('P2-3: 定期ルールの everyMonths 上限（配分上限と同じ 1,200）', () => {
  const base = {
    id: 'r',
    name: 'x',
    amount: 100,
    dayOfMonth: 1,
    debitAccountId: 'a',
    creditAccountId: 'b',
    startMonth: '2026-01',
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
        spreadExpenseAccountId: expense.id,
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
  it('置換後 revision = max(現行, 封筒) + 1。同じ封筒の再取込は conflict になり force で通る', async () => {
    await loadLedger();
    await upsertTag({
      id: 'tag-rev',
      name: '再監査',
      scope: 'entry',
      archived: false,
      createdAt: 'x',
      updatedAt: 'x',
    });
    const ledger = await loadLedger();
    const before = ledger.meta.revision;
    const text = exportToJsonText(ledger);
    const outcome = await importFromJsonText(text);
    expect(outcome.kind).toBe('ok');
    // revision が進む = 別タブの CAS（import 前の revision を基準に持つ）が必ず失火する。
    expect((await loadLedger()).meta.revision).toBe(before + 1);
    // 進んだ結果、同じ封筒はもう古い（事実どおり conflict → force で明示上書き）。
    const second = await importFromJsonText(text);
    expect(second.kind).toBe('revision-conflict');
    const forced = await importFromJsonText(text, { force: true });
    expect(forced.kind).toBe('ok');
  });
});

describe('再監査対応: 起動時 catch-up（loadLedger 前）でも CAS の基準を確定する', () => {
  it('catch-up が基準 revision を設定し、以後の別タブ変更を検出できる', async () => {
    await loadLedger();
    _resetRepositoryStateForTests(); // タブ起動直後（トラッカ未設定）を再現
    await catchUpRecurringRules(todayLocal()); // ルール 0 件・書込みなしでも基準を確定する
    const meta = (await getKv<LedgerMeta>('meta'))!;
    await putKv('meta', { ...meta, revision: meta.revision + 1 }); // 別タブの書込みを模す
    await expect(
      upsertTag({
        id: 'tag-boot-cas',
        name: '起動競合',
        scope: 'entry',
        archived: false,
        createdAt: 'x',
        updatedAt: 'x',
      }),
    ).rejects.toMatchObject({ code: 'error.common.staleData' });
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
