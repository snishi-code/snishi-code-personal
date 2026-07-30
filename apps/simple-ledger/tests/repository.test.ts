import { describe, expect, it, vi } from 'vitest';
import './setup';
import {
  createAdjustment,
  updateAdjustment,
  deleteAdjustment,
  createOpening,
  createOpenings,
  updateOpening,
  deleteOpening,
  archiveAccount,
  archiveMonthlyCost,
  createContinuousCost,
  createRepaymentEntries,
  createReserve,
  deleteAccount,
  deleteEntry,
  deleteMonthlyCost,
  deleteTag,
  listSnapshots,
  loadLedger,
  makeSnapshotId,
  postSchedule,
  resetAll,
  saveSnapshot,
  updateSettings,
  upsertAccount,
  upsertEntry,
  upsertMonthlyCost,
  upsertSchedule,
  upsertTag,
} from '../src/data/repository';
import { buildSimpleEntry } from '../src/domain/entry';
import { LedgerError } from '../src/domain/errors';
import {
  CONTINUOUS_COST_LEDGER_ACCOUNT_ID,
  CONTINUOUS_COST_LEDGER_ACCOUNT_NAME,
  RESERVE_LEDGER_ACCOUNT_ID,
} from '../src/domain/constants';
import { accountBalance } from '../src/domain/accounting';
import { reportEntriesForAsOf } from '../src/domain/reportEntries';
import { buildExportPackage, exportToJsonText, importFromJsonText } from '../src/data/exportImport';
import { ledgerExportPackageSchema } from '../src/domain/schema';
import { getAll, getKv, putKv, putRecord, STORE } from '../src/data/db';
import { SCHEMA_VERSION } from '../src/domain/constants';
import { newId } from '../src/domain/ids';
import { todayLocal } from '../src/util/time';
import type { CashflowSchedule, JournalEntry, LedgerMeta, Tag } from '../src/domain/types';

async function addEntryRef(foodId: string, cashId: string) {
  await upsertEntry(
    buildSimpleEntry({
      date: '2026-06-01',
      description: 'x',
      debitAccountId: foodId,
      creditAccountId: cashId,
      amount: 500,
    }),
  );
}

describe('repository 初期化', () => {
  it('初回 loadLedger で既定科目を投入し、revision は 0', async () => {
    const ledger = await loadLedger();
    expect(ledger.accounts.length).toBeGreaterThan(0);
    expect(ledger.meta.revision).toBe(0);
    expect(ledger.settings.currency).toBe('JPY');
  });
});

describe('revision bump', () => {
  it('仕訳の保存・削除で revision が増える', async () => {
    const ledger = await loadLedger();
    const cash = ledger.accounts.find((a) => a.name === '現金')!;
    const food = ledger.accounts.find((a) => a.name === '変動費')!;
    const entry = buildSimpleEntry({
      date: '2026-06-01',
      description: 'x',
      debitAccountId: food.id,
      creditAccountId: cash.id,
      amount: 500,
    });
    await upsertEntry(entry);
    const r1 = await loadLedger();
    expect(r1.meta.revision).toBe(1);
    expect(r1.journalEntries).toHaveLength(1);

    await deleteEntry(entry.id);
    const r2 = await loadLedger();
    expect(r2.meta.revision).toBe(2);
    expect(r2.journalEntries).toHaveLength(0);
  });
});

describe('科目削除の fail-closed', () => {
  it('仕訳で参照中の科目は削除できない', async () => {
    const ledger = await loadLedger();
    const cash = ledger.accounts.find((a) => a.name === '現金')!;
    const food = ledger.accounts.find((a) => a.name === '変動費')!;
    await upsertEntry(
      buildSimpleEntry({
        date: '2026-06-01',
        description: 'x',
        debitAccountId: food.id,
        creditAccountId: cash.id,
        amount: 500,
      }),
    );
    await expect(deleteAccount(food.id)).rejects.toThrow();
  });
});

describe('revision と本体の原子的更新', () => {
  it('updateSettings は revision を進め、設定も保存する', async () => {
    const before = await loadLedger();
    await updateSettings({ ...before.settings, ledgerName: '家計' });
    const after = await loadLedger();
    expect(after.settings.ledgerName).toBe('家計');
    expect(after.meta.revision).toBe(before.meta.revision + 1);
  });

  it('複数の変更で revision が変更回数ぶん進む（各操作で本体と meta が一緒に進む）', async () => {
    const ledger = await loadLedger();
    expect(ledger.meta.revision).toBe(0);
    const cash = ledger.accounts.find((a) => a.name === '現金')!;
    const food = ledger.accounts.find((a) => a.name === '変動費')!;
    const other = ledger.accounts.find((a) => a.name === 'その他収入')!;

    await addEntryRef(food.id, cash.id); // +1
    await updateSettings({ ...ledger.settings, currency: 'USD' }); // +1
    await upsertAccount({ ...other, name: '雑収入', updatedAt: 'y' }); // +1

    const after = await loadLedger();
    expect(after.meta.revision).toBe(3);
    expect(after.settings.currency).toBe('USD');
    expect(after.journalEntries).toHaveLength(1);
    expect(after.accounts.find((a) => a.id === other.id)?.name).toBe('雑収入');
  });
});

describe('科目区分(type)の変更ルール', () => {
  it('未使用の科目は区分を変更できる', async () => {
    const ledger = await loadLedger();
    const acct = ledger.accounts.find((a) => a.name === 'その他収入')!; // 未使用(revenue)
    // type を変えるときは role も整合させる（income-category → expense-category）。
    await upsertAccount({ ...acct, type: 'expense', role: 'expense-category', updatedAt: 'y' });
    const after = await loadLedger();
    expect(after.accounts.find((a) => a.id === acct.id)?.type).toBe('expense');
  });

  it('使用中の科目は区分を変更できない（fail-closed）', async () => {
    const ledger = await loadLedger();
    const cash = ledger.accounts.find((a) => a.name === '現金')!;
    const food = ledger.accounts.find((a) => a.name === '変動費')!;
    await addEntryRef(food.id, cash.id);
    await expect(
      upsertAccount({ ...food, type: 'asset', role: 'daily-asset', updatedAt: 'y' }),
    ).rejects.toThrow();
  });

  it('使用中でも名前変更は許可する', async () => {
    const ledger = await loadLedger();
    const cash = ledger.accounts.find((a) => a.name === '現金')!;
    const food = ledger.accounts.find((a) => a.name === '変動費')!;
    await addEntryRef(food.id, cash.id);
    await upsertAccount({ ...food, name: '外食費', updatedAt: 'y' });
    const after = await loadLedger();
    expect(after.accounts.find((a) => a.id === food.id)?.name).toBe('外食費');
  });

  it('role が type と矛盾する保存は拒否する', async () => {
    const ledger = await loadLedger();
    const cash = ledger.accounts.find((a) => a.name === '現金')!; // asset
    // asset に expense-category を付ける → 不整合で拒否
    await expect(
      upsertAccount({ ...cash, role: 'expense-category', updatedAt: 'y' }),
    ).rejects.toThrow();
  });

  it('使用中の role 変更は拒否する（大きな箱の移動に相当・fail-closed）', async () => {
    const ledger = await loadLedger();
    const cash = ledger.accounts.find((a) => a.name === '現金')!;
    const food = ledger.accounts.find((a) => a.name === '変動費')!;
    await addEntryRef(food.id, cash.id);
    // 現金(daily-asset) を investment-asset へ（type は asset のまま）→ 使用中なので拒否。
    await expect(
      upsertAccount({ ...cash, role: 'investment-asset', updatedAt: 'y' }),
    ).rejects.toMatchObject({ code: 'error.account.roleLocked' });
    const after = await loadLedger();
    expect(after.accounts.find((a) => a.id === cash.id)?.role).toBe('daily-asset');
  });

  it('未使用なら role 変更できる', async () => {
    const ledger = await loadLedger();
    const charge = ledger.accounts.find((a) => a.name === 'チャージ残高')!;
    await upsertAccount({ ...charge, role: 'investment-asset', updatedAt: 'y' });
    const after = await loadLedger();
    expect(after.accounts.find((a) => a.id === charge.id)?.role).toBe('investment-asset');
  });
});

describe('resetAll', () => {
  it('全消去後に既定状態へ戻る', async () => {
    const ledger = await loadLedger();
    const cash = ledger.accounts.find((a) => a.name === '現金')!;
    const food = ledger.accounts.find((a) => a.name === '変動費')!;
    await upsertEntry(
      buildSimpleEntry({
        date: '2026-06-01',
        description: 'x',
        debitAccountId: food.id,
        creditAccountId: cash.id,
        amount: 500,
      }),
    );
    // スナップショットも作っておき、全ストアが一括で消えることを確認する
    await saveSnapshot({
      id: makeSnapshotId(),
      createdAt: '2026-06-01T00:00:00.000Z',
      reason: 'test',
      data: buildExportPackage(ledger),
    });
    expect((await listSnapshots()).length).toBeGreaterThan(0);

    // 継続コスト資産も作っておき、消えることを確認する。
    await createContinuousCost({
      name: '年払いクラウド',
      amount: 12000,
      startDate: '2026-06-15',
      endDate: '2027-05-31',
      expenseAccountId: food.id,
      creditAccountId: cash.id,
    });
    expect((await loadLedger()).monthlyCostItems).toHaveLength(1);

    await resetAll();
    const after = await loadLedger();
    expect(after.journalEntries).toHaveLength(0);
    expect(after.accounts.length).toBeGreaterThan(0);
    expect(after.meta.revision).toBe(0); // 新しい meta で作り直されている
    expect(await listSnapshots()).toHaveLength(0); // snapshots も消える
    expect(after.monthlyCostItems).toHaveLength(0); // 月額化コストも消える
  });
});

describe('予定キャッシュフロー / 目的別資金', () => {
  it('予定の実績化で仕訳が作られ posted になる（単一トランザクション）', async () => {
    const ledger = await loadLedger();
    const cash = ledger.accounts.find((a) => a.name === '現金')!;
    const card = ledger.accounts.find((a) => a.type === 'liability')!;
    const schedule: CashflowSchedule = {
      id: newId(),
      title: 'カード返済',
      dueDate: '2026-07-10',
      amount: 30000,
      direction: 'outflow',
      accountId: cash.id,
      counterAccountId: card.id,
      source: 'credit-card',
      status: 'planned',
      createdAt: 'x',
      updatedAt: 'x',
    };
    await upsertSchedule(schedule);
    const entry = await postSchedule(schedule.id);
    // outflow: 借方 counter(負債) / 貸方 account(資産)
    expect(entry.lines.find((l) => l.side === 'debit')?.accountId).toBe(card.id);
    expect(entry.lines.find((l) => l.side === 'credit')?.accountId).toBe(cash.id);

    const after = await loadLedger();
    const s = after.cashflowSchedules.find((x) => x.id === schedule.id)!;
    expect(s.status).toBe('posted');
    expect(s.linkedEntryId).toBe(entry.id);
    expect(after.journalEntries.some((e) => e.id === entry.id)).toBe(true);
  });

  it('実績化済みの予定は再実績化できない', async () => {
    const ledger = await loadLedger();
    const cash = ledger.accounts.find((a) => a.name === '現金')!;
    const card = ledger.accounts.find((a) => a.type === 'liability')!;
    const schedule: CashflowSchedule = {
      id: newId(),
      title: 'x',
      dueDate: '2026-07-10',
      amount: 100,
      direction: 'outflow',
      accountId: cash.id,
      counterAccountId: card.id,
      source: 'manual',
      status: 'planned',
      createdAt: 'x',
      updatedAt: 'x',
    };
    await upsertSchedule(schedule);
    await postSchedule(schedule.id);
    await expect(postSchedule(schedule.id)).rejects.toThrow();
  });

  it('目的別資金の作成で枠ができ、残高は集約口座に寄せる（目的名は枠側）', async () => {
    await loadLedger();
    const r = await createReserve({ name: '結婚資金' });
    const after = await loadLedger();
    expect(after.reserves.some((x) => x.id === r.id)).toBe(true);
    expect(after.reserves.find((x) => x.id === r.id)?.name).toBe('結婚資金');
    // 残高科目は目的名でなく単一の集約口座『取り置き資金』。
    const acc = after.accounts.find((a) => a.id === r.reserveAccountId)!;
    expect(acc.id).toBe(RESERVE_LEDGER_ACCOUNT_ID);
    expect(acc.type).toBe('asset');
    expect(acc.role).toBe('reserve-asset');
  });

  it('取り置きは短期の封筒分け（A）: 目標額・目標日のフィールドを持たない', async () => {
    await loadLedger();
    const r = await createReserve({ name: '飲み会用' });
    const after = await loadLedger();
    const saved = after.reserves.find((x) => x.id === r.id)! as unknown as Record<string, unknown>;
    expect('targetAmount' in saved).toBe(false);
    expect('targetDate' in saved).toBe(false);
  });
});

describe('予定CF・目的別資金が参照する科目の保護', () => {
  function plannedSchedule(accountId: string, counterAccountId?: string): CashflowSchedule {
    return {
      id: newId(),
      title: 'x',
      dueDate: '2026-07-10',
      amount: 1000,
      direction: 'outflow',
      accountId,
      ...(counterAccountId ? { counterAccountId } : {}),
      source: 'manual',
      status: 'planned',
      createdAt: 'x',
      updatedAt: 'x',
    };
  }

  it('予定CF が参照する科目は削除できない', async () => {
    const ledger = await loadLedger();
    const cash = ledger.accounts.find((a) => a.name === '現金')!;
    await upsertSchedule(plannedSchedule(cash.id));
    await expect(deleteAccount(cash.id)).rejects.toThrow();
  });

  it('予定CF が参照する科目は区分変更できない', async () => {
    const ledger = await loadLedger();
    const cash = ledger.accounts.find((a) => a.name === '現金')!;
    await upsertSchedule(plannedSchedule(cash.id));
    await expect(upsertAccount({ ...cash, type: 'expense', updatedAt: 'y' })).rejects.toThrow();
  });

  it('目的別資金が参照する科目は削除できない', async () => {
    await loadLedger();
    const r = await createReserve({ name: '結婚資金' });
    await expect(deleteAccount(r.reserveAccountId)).rejects.toThrow();
  });

  it('実績化済み予定に紐づく仕訳は通常削除・上書きできない', async () => {
    const ledger = await loadLedger();
    const cash = ledger.accounts.find((a) => a.name === '現金')!;
    const card = ledger.accounts.find((a) => a.type === 'liability')!;
    const s = plannedSchedule(cash.id, card.id);
    await upsertSchedule(s);
    const entry = await postSchedule(s.id);
    await expect(deleteEntry(entry.id)).rejects.toThrow();
    await expect(upsertEntry({ ...entry, description: '改ざん' })).rejects.toThrow();
  });
});

describe('タグ', () => {
  function tag(): Tag {
    return {
      id: newId(),
      name: '2026 北海道旅行',
      scope: 'entry',
      archived: false,
      createdAt: 'x',
      updatedAt: 'x',
    };
  }

  it('未使用のタグは削除でき、使用中は削除できない', async () => {
    const ledger = await loadLedger();
    const cash = ledger.accounts.find((a) => a.name === '現金')!;
    const food = ledger.accounts.find((a) => a.name === '変動費')!;
    const tg = tag();
    await upsertTag(tg);

    // 未使用 → 別タグを作って削除できることを確認
    const unused = { ...tag(), id: newId(), name: '一時' };
    await upsertTag(unused);
    await deleteTag(unused.id);
    expect((await loadLedger()).tags.some((x) => x.id === unused.id)).toBe(false);

    // tg を仕訳に付ける → 使用中で削除不可
    await upsertEntry(
      buildSimpleEntry({
        date: '2026-06-01',
        description: '旅行費',
        debitAccountId: food.id,
        creditAccountId: cash.id,
        amount: 1000,
        tagIds: [tg.id],
      }),
    );
    await expect(deleteTag(tg.id)).rejects.toThrow();
  });

  it('仕訳全体タグを付けて保存できる', async () => {
    const ledger = await loadLedger();
    const cash = ledger.accounts.find((a) => a.name === '現金')!;
    const food = ledger.accounts.find((a) => a.name === '変動費')!;
    const tripTag = { ...tag(), id: newId(), name: '帰省' };
    await upsertTag(tripTag);
    await upsertEntry(
      buildSimpleEntry({
        date: '2026-06-01',
        description: '帰省の食事',
        debitAccountId: food.id,
        creditAccountId: cash.id,
        amount: 2000,
        tagIds: [tripTag.id],
      }),
    );
    const after = await loadLedger();
    const e = after.journalEntries.find((x) => x.description === '帰省の食事')!;
    expect(e.tagIds).toEqual([tripTag.id]);
  });
});

describe('タグ不変条件（保存時）', () => {
  const mkTag = (over: Partial<Tag> = {}): Tag => ({
    id: newId(),
    name: '旅行',
    scope: 'entry',
    archived: false,
    createdAt: 'x',
    updatedAt: 'x',
    ...over,
  });

  it('active な同名タグは作れない', async () => {
    await loadLedger();
    await upsertTag(mkTag());
    await expect(upsertTag(mkTag())).rejects.toThrow();
  });

  it('タグは常に仕訳全体（entry）scope で保存される', async () => {
    await loadLedger();
    const tg = mkTag();
    await upsertTag(tg);
    expect((await loadLedger()).tags.find((x) => x.id === tg.id)?.scope).toBe('entry');
  });
});

describe('起動時の現行化', () => {
  it('現行データは再読み込みでも schemaVersion・revision を変えない', async () => {
    // まず既定データを投入（settings/accounts/meta を作る）。
    const init = await loadLedger();
    expect(init.meta.schemaVersion).toBe(SCHEMA_VERSION);
    // 編集追跡が進んだ既存 DB を模す（v2 に旧版ローカル DB は存在しない・仕様§16）。
    const meta: LedgerMeta = { ...init.meta, revision: 7 };
    await putKv('meta', meta);

    // 再起動相当の loadLedger でも不要な追従処理は走らず、版・revision は不変。
    const ledger = await loadLedger();
    expect(ledger.meta.schemaVersion).toBe(SCHEMA_VERSION);
    expect(ledger.meta.revision).toBe(7);

    const persisted = await getKv<LedgerMeta>('meta');
    expect(persisted?.schemaVersion).toBe(SCHEMA_VERSION);
    expect(persisted?.revision).toBe(7);
  });

  it('equity 科目を role と id で引き当て、同じ起動時処理で「初期残高」へ改名する', async () => {
    const initial = await loadLedger();
    const equity = initial.accounts.find((account) => account.role === 'equity')!;
    await putRecord(STORE.accounts, { ...equity, name: '旧表記', updatedAt: 'old' });
    await putKv<LedgerMeta>('meta', { ...initial.meta, revision: 7 });

    const reloaded = await loadLedger();
    const renamed = reloaded.accounts.find((account) => account.role === 'equity')!;
    expect(renamed.id).toBe(equity.id);
    expect(renamed.name).toBe('初期残高');
    expect(reloaded.meta.revision).toBe(8);
  });

  it('改名先を通常科目が使用中なら重複名を作らず、改名せずに起動は成功する', async () => {
    const initial = await loadLedger();
    const equity = initial.accounts.find((account) => account.role === 'equity')!;
    const expense = initial.accounts.find((account) => account.role === 'expense-category')!;
    await putRecord(STORE.accounts, { ...equity, name: '旧表記', updatedAt: 'old' });
    await putRecord(STORE.accounts, { ...expense, name: '初期残高', updatedAt: 'old' });

    // 起動をブロックしない（ユーザーが「初期残高」という名前の費用カテゴリを作っただけで
    // アプリが開かなくなる状態を作らない）。
    const reloaded = await loadLedger();
    expect(reloaded.accounts.find((account) => account.id === equity.id)?.name).toBe('旧表記');
    const storedEquity = (await getAll<typeof equity>(STORE.accounts)).find(
      (account) => account.id === equity.id,
    );
    expect(storedEquity?.name).toBe('旧表記');
  });

  it('非アーカイブ equity が 2 件あっても改名せずに起動は成功する', async () => {
    const initial = await loadLedger();
    const equity = initial.accounts.find((account) => account.role === 'equity')!;
    await putRecord(STORE.accounts, { ...equity, name: '旧表記', updatedAt: 'old' });
    await putRecord(STORE.accounts, {
      ...equity,
      id: `${equity.id}-2`,
      name: '旧表記2',
      updatedAt: 'old',
    });

    const reloaded = await loadLedger();
    expect(reloaded.accounts.find((account) => account.id === equity.id)?.name).toBe('旧表記');
  });
});

describe('継続コスト資産 createContinuousCost（購入の仕訳 + item を 1 tx で）', () => {
  it('現金払い: 購入の仕訳（借方 台帳 / 貸方 現金・日付 = startDate・monthlyCostId 付き）を作る', async () => {
    const ledger = await loadLedger();
    const cash = ledger.accounts.find((a) => a.name === '現金')!;
    const food = ledger.accounts.find((a) => a.name === '変動費')!;
    const beforeEntries = ledger.journalEntries.length;
    const item = await createContinuousCost({
      name: '年払いクラウド',
      amount: 12000,
      startDate: '2026-06-15',
      endDate: '2027-05-31',
      expenseAccountId: food.id,
      creditAccountId: cash.id,
    });
    const after = await loadLedger();
    expect(after.monthlyCostItems).toHaveLength(1);
    expect(after.journalEntries.length).toBe(beforeEntries + 1);
    const purchase = after.journalEntries.find((e) => e.metadata?.monthlyCostId === item.id)!;
    expect(purchase.date).toBe('2026-06-15');
    expect(purchase.kind).toBe('normal');
    expect(purchase.lines).toEqual([
      { accountId: CONTINUOUS_COST_LEDGER_ACCOUNT_ID, side: 'debit', amount: 12000 },
      { accountId: cash.id, side: 'credit', amount: 12000 },
    ]);
    // 費用の行はデータに残らない（導出のみ）。
    expect(after.journalEntries.some((e) => e.metadata?.virtual)).toBe(false);
  });

  it('カード払い + 返済情報: 返済は未来日付の振替実仕訳 12 本（monthlyCostId なし・★6）', async () => {
    const ledger = await loadLedger();
    const cash = ledger.accounts.find((a) => a.name === '現金')!;
    const card = ledger.accounts.find((a) => a.role === 'payment-liability')!;
    const food = ledger.accounts.find((a) => a.name === '変動費')!;
    const item = await createContinuousCost({
      name: '洗濯機',
      amount: 210000,
      startDate: '2026-06-15',
      endDate: '2033-05-31',
      expenseAccountId: food.id,
      creditAccountId: card.id,
      repaymentAccountId: cash.id,
      repaymentCount: 12,
      repaymentStartDate: '2026-07-27',
    });
    const after = await loadLedger();
    expect(after.cashflowSchedules).toHaveLength(0);
    const repays = after.journalEntries
      .filter((e) => e.description.startsWith('洗濯機 返済'))
      .sort((a, b) => a.date.localeCompare(b.date));
    expect(repays).toHaveLength(12);
    expect(
      repays.reduce((s, e) => s + (e.lines.find((l) => l.side === 'debit')?.amount ?? 0), 0),
    ).toBe(210000);
    expect(repays[0]?.date).toBe('2026-07-27');
    expect(repays.every((e) => e.metadata?.monthlyCostId === undefined)).toBe(true);
    const purchase = after.journalEntries.find((e) => e.metadata?.monthlyCostId === item.id)!;
    expect(purchase.lines).toEqual([
      { accountId: CONTINUOUS_COST_LEDGER_ACCOUNT_ID, side: 'debit', amount: 210000 },
      { accountId: card.id, side: 'credit', amount: 210000 },
    ]);
  });

  it('費用の行き先は role を問わず（内部集約以外）指定でき、存在しない科目IDは拒否する', async () => {
    const ledger = await loadLedger();
    const cash = ledger.accounts.find((a) => a.name === '現金')!;
    const base = {
      name: 'x',
      amount: 100,
      startDate: '2026-06-15',
      creditAccountId: cash.id,
    };
    const item = await createContinuousCost({ ...base, expenseAccountId: cash.id });
    expect(item.expenseAccountId).toBe(cash.id);
    await expect(
      createContinuousCost({ ...base, name: 'unknown', expenseAccountId: 'no-such-account' }),
    ).rejects.toMatchObject({ code: 'error.monthlyCost.expenseCategory' });
    // 支払い元が費用カテゴリなどは不可。
    const food = ledger.accounts.find((a) => a.name === '変動費')!;
    await expect(
      createContinuousCost({ ...base, name: 'bad-credit', expenseAccountId: food.id, creditAccountId: food.id }),
    ).rejects.toMatchObject({ code: 'error.monthlyCost.paymentSource' });
  });
});

describe('継続コスト資産の整合性（購入の仕訳・削除・不変条件⑧）', () => {
  async function makeCashItem() {
    const ledger = await loadLedger();
    const cash = ledger.accounts.find((a) => a.name === '現金')!;
    const food = ledger.accounts.find((a) => a.name === '変動費')!;
    const item = await createContinuousCost({
      name: '年払いクラウド',
      amount: 12000,
      startDate: '2026-06-15',
      endDate: '2027-05-31',
      expenseAccountId: food.id,
      creditAccountId: cash.id,
    });
    return { item, cash, food };
  }
  async function makeCardItem() {
    const ledger = await loadLedger();
    const cash = ledger.accounts.find((a) => a.name === '現金')!;
    const card = ledger.accounts.find((a) => a.role === 'payment-liability')!;
    const food = ledger.accounts.find((a) => a.name === '変動費')!;
    const item = await createContinuousCost({
      name: '洗濯機',
      amount: 120000,
      startDate: '2026-06-15',
      endDate: '2033-05-31',
      expenseAccountId: food.id,
      creditAccountId: card.id,
      repaymentAccountId: cash.id,
      repaymentCount: 12,
      repaymentStartDate: '2026-07-27',
    });
    return { item, cash, card, food };
  }

  it('購入の仕訳は削除できない（item 削除で cascade・fail-closed）', async () => {
    await makeCashItem();
    const after = await loadLedger();
    const purchase = after.journalEntries.find((e) => e.metadata?.monthlyCostId)!;
    await expect(deleteEntry(purchase.id)).rejects.toMatchObject({
      code: 'error.entry.monthlyCost',
    });
  });

  it('購入の仕訳の編集は可: 日付・金額が item へミラーされる（§13-7）', async () => {
    const { item } = await makeCashItem();
    const before = await loadLedger();
    const purchase = before.journalEntries.find((e) => e.metadata?.monthlyCostId === item.id)!;
    const edited = {
      ...purchase,
      date: '2026-06-20',
      lines: purchase.lines.map((l) => ({ ...l, amount: 15000 })),
      updatedAt: 'edit',
    };
    await upsertEntry(edited);
    const after = await loadLedger();
    const savedItem = after.monthlyCostItems.find((m) => m.id === item.id)!;
    expect(savedItem.startDate).toBe('2026-06-20');
    expect(savedItem.amount).toBe(15000);
    // 日付を終了日より後ろへ動かすのは拒否。
    await expect(
      upsertEntry({ ...edited, date: '2027-06-01' }),
    ).rejects.toMatchObject({ code: 'error.monthlyCost.purchaseAfterEnd' });
    // 借方（台帳）は差し替えられない。
    await expect(
      upsertEntry({
        ...edited,
        lines: [
          { accountId: savedItem.expenseAccountId, side: 'debit', amount: 15000 },
          { accountId: purchase.lines[1]!.accountId, side: 'credit', amount: 15000 },
        ],
      }),
    ).rejects.toMatchObject({ code: 'error.entry.ledgerAccount' });
  });

  it('ユーザー入力に monthlyCostId が付いた新規仕訳は保存できない', async () => {
    const ledger = await loadLedger();
    const cash = ledger.accounts.find((a) => a.name === '現金')!;
    const food = ledger.accounts.find((a) => a.name === '変動費')!;
    const entry = buildSimpleEntry({
      date: '2026-06-01',
      description: 'x',
      debitAccountId: food.id,
      creditAccountId: cash.id,
      amount: 100,
    });
    await expect(
      upsertEntry({ ...entry, metadata: { inputMode: 'manual', monthlyCostId: 'mc-x' } }),
    ).rejects.toThrow();
  });

  it('⑧ 台帳を借方/貸方に使う保存仕訳は monthlyCostId が必須（§13-14）', async () => {
    await makeCashItem(); // 台帳口座を作らせる
    const ledger = await loadLedger();
    const cash = ledger.accounts.find((a) => a.name === '現金')!;
    const entry = buildSimpleEntry({
      date: '2026-06-01',
      description: '台帳へ直接',
      debitAccountId: CONTINUOUS_COST_LEDGER_ACCOUNT_ID,
      creditAccountId: cash.id,
      amount: 100,
    });
    await expect(upsertEntry(entry)).rejects.toMatchObject({
      code: 'error.entry.ledgerAccount',
    });
  });

  it('現金払い item の削除は購入の仕訳・回収の振替を cascade 削除する', async () => {
    const { item, cash } = await makeCashItem();
    await archiveMonthlyCost({
      id: item.id,
      endDate: '2026-09-30',
      recovery: { destinationAccountId: cash.id, amount: 3000 },
    });
    await deleteMonthlyCost(item.id);
    const after = await loadLedger();
    expect(after.monthlyCostItems.some((m) => m.id === item.id)).toBe(false);
    expect(after.journalEntries.some((e) => e.metadata?.monthlyCostId === item.id)).toBe(false);
  });

  it('負債で買った item は削除できない（★6・アーカイブを使う）。返済実仕訳は残る', async () => {
    const { item } = await makeCardItem();
    await expect(deleteMonthlyCost(item.id)).rejects.toMatchObject({
      code: 'error.monthlyCost.deleteLiability',
    });
    // アーカイブ（終了日の設定）は可能。
    await archiveMonthlyCost({ id: item.id, endDate: '2026-12-31' });
    const after = await loadLedger();
    expect(after.monthlyCostItems.find((m) => m.id === item.id)?.endDate).toBe('2026-12-31');
    const repays = after.journalEntries.filter((e) => e.description.startsWith('洗濯機 返済'));
    expect(repays).toHaveLength(12);
    await deleteEntry(repays[0]!.id); // 返済は通常仕訳＝自由に編集/削除できる
    expect((await loadLedger()).journalEntries.some((e) => e.id === repays[0]!.id)).toBe(false);
  });

  it('レガシー: 関連返済CFが実績化済みなら削除できない（アーカイブを使う）', async () => {
    // 旧バージョンが作った monthlyCostId 付き予定 CF が残っているデータの互換動作。
    const { item, cash } = await makeCashItem();
    const ledger = await loadLedger();
    const card = ledger.accounts.find((a) => a.role === 'payment-liability')!;
    const sched: CashflowSchedule = {
      id: newId(),
      title: '返済(旧)',
      dueDate: '2026-07-27',
      amount: 10000,
      direction: 'outflow',
      accountId: cash.id,
      counterAccountId: card.id,
      source: 'installment',
      status: 'planned',
      monthlyCostId: item.id,
      createdAt: 'x',
      updatedAt: 'x',
    };
    await upsertSchedule(sched);
    await postSchedule(sched.id);
    await expect(deleteMonthlyCost(item.id)).rejects.toThrow();
    const after = await loadLedger();
    expect(after.monthlyCostItems.some((m) => m.id === item.id)).toBe(true);
  });
});

describe('返済計画の一括登録（createRepaymentEntries）', () => {
  async function caught(p: Promise<unknown>): Promise<LedgerError> {
    try {
      await p;
    } catch (e) {
      return e as LedgerError;
    }
    throw new Error('expected rejection');
  }

  it('12回で未来の振替仕訳12本（1トランザクション）・配分合計一致・完済で負債残高0', async () => {
    const ledger = await loadLedger();
    const cash = ledger.accounts.find((a) => a.name === '現金')!;
    const card = ledger.accounts.find((a) => a.role === 'payment-liability')!;
    const food = ledger.accounts.find((a) => a.name === '変動費')!;
    // 負債を立てる: 借方 変動費 / 貸方 カード 100,000。
    await upsertEntry(
      buildSimpleEntry({
        date: '2026-06-15',
        description: '買い物',
        debitAccountId: food.id,
        creditAccountId: card.id,
        amount: 100000,
      }),
    );
    const created = await createRepaymentEntries({
      liabilityAccountId: card.id,
      fromAccountId: cash.id,
      firstDate: '2026-07-27',
      total: 100000,
      count: 12,
      title: 'カードの返済',
    });
    expect(created).toHaveLength(12);
    const after = await loadLedger();
    const saved = after.journalEntries
      .filter((e) => created.some((x) => x.id === e.id))
      .sort((a, b) => a.date.localeCompare(b.date));
    expect(saved).toHaveLength(12);
    // 借方 負債 / 貸方 返済元、毎月同日、合計は総額に一致。
    expect(
      saved.every(
        (e) =>
          e.lines.find((l) => l.side === 'debit')?.accountId === card.id &&
          e.lines.find((l) => l.side === 'credit')?.accountId === cash.id &&
          e.metadata?.inputMode === 'transfer',
      ),
    ).toBe(true);
    expect(
      saved.reduce((s, e) => s + (e.lines.find((l) => l.side === 'debit')?.amount ?? 0), 0),
    ).toBe(100000);
    expect(saved[0]?.date).toBe('2026-07-27');
    expect(saved[1]?.date).toBe('2026-08-27');
    expect(saved[11]?.date).toBe('2027-06-27');
    expect(saved[0]?.description).toBe('カードの返済 1/12');
    // 完済で負債残高は 0（予定 CF を経由しない）。
    expect(accountBalance(card.id, 'liability', after.journalEntries)).toBe(0);
    expect(after.cashflowSchedules).toHaveLength(0);
  });

  it('回数1は摘要に番号を付けない単発', async () => {
    const ledger = await loadLedger();
    const cash = ledger.accounts.find((a) => a.name === '現金')!;
    const card = ledger.accounts.find((a) => a.role === 'payment-liability')!;
    const created = await createRepaymentEntries({
      liabilityAccountId: card.id,
      fromAccountId: cash.id,
      firstDate: '2026-07-27',
      total: 5000,
      count: 1,
      title: 'カードの返済',
    });
    expect(created).toHaveLength(1);
    expect(created[0]?.description).toBe('カードの返済');
  });

  it('fail-closed: 返済先が負債以外・返済元が日常資産以外・回数0 は拒否', async () => {
    const ledger = await loadLedger();
    const cash = ledger.accounts.find((a) => a.name === '現金')!;
    const card = ledger.accounts.find((a) => a.role === 'payment-liability')!;
    const base = {
      liabilityAccountId: card.id,
      fromAccountId: cash.id,
      firstDate: '2026-07-27',
      total: 5000,
      count: 1,
      title: 'x',
    };
    const e1 = await caught(createRepaymentEntries({ ...base, liabilityAccountId: cash.id }));
    expect(e1.code).toBe('error.repay.liabilityRequired');
    const e2 = await caught(createRepaymentEntries({ ...base, fromAccountId: card.id }));
    expect(e2.code).toBe('error.monthlyCost.repaymentAccount');
    const e3 = await caught(createRepaymentEntries({ ...base, count: 0 }));
    expect(e3.code).toBe('error.repay.countInvalid');
  });

  it('保存境界で存在しない日を拒否し、閏日は受理する', async () => {
    const ledger = await loadLedger();
    const cash = ledger.accounts.find((a) => a.name === '現金')!;
    const card = ledger.accounts.find((a) => a.role === 'payment-liability')!;
    const base = {
      liabilityAccountId: card.id,
      fromAccountId: cash.id,
      total: 5000,
      count: 1,
      title: '暦検証',
    };

    const error = await caught(
      createRepaymentEntries({ ...base, firstDate: '2026-02-31' }),
    );
    expect(error.code).toBe('error.monthlyCost.dateRequired');
    expect((await loadLedger()).journalEntries).toHaveLength(0);

    const created = await createRepaymentEntries({ ...base, firstDate: '2024-02-29' });
    expect(created).toHaveLength(1);
    expect(created[0]?.date).toBe('2024-02-29');
  });
});

describe('タグ実行時検証（保存前）', () => {
  it('upsertEntry: 存在しないタグ参照は拒否', async () => {
    const ledger = await loadLedger();
    const cash = ledger.accounts.find((a) => a.name === '現金')!;
    const food = ledger.accounts.find((a) => a.name === '変動費')!;
    await expect(
      upsertEntry(
        buildSimpleEntry({
          date: '2026-06-01',
          description: 'x',
          debitAccountId: food.id,
          creditAccountId: cash.id,
          amount: 100,
          tagIds: ['no-such-tag'],
        }),
      ),
    ).rejects.toThrow();
  });

  it('upsertSchedules: 存在しないタグ参照は拒否', async () => {
    const ledger = await loadLedger();
    const cash = ledger.accounts.find((a) => a.name === '現金')!;
    const card = ledger.accounts.find((a) => a.type === 'liability')!;
    const schedule: CashflowSchedule = {
      id: newId(),
      title: 'x',
      dueDate: '2026-07-10',
      amount: 100,
      direction: 'outflow',
      accountId: cash.id,
      counterAccountId: card.id,
      source: 'manual',
      status: 'planned',
      entryTagIds: ['no-such-tag'],
      createdAt: 'x',
      updatedAt: 'x',
    };
    await expect(upsertSchedule(schedule)).rejects.toThrow();
  });
});

describe('残高補正 createAdjustment', () => {
  async function setBalance(accountName: string, amount: number) {
    const ledger = await loadLedger();
    const acc = ledger.accounts.find((a) => a.name === accountName)!;
    const capital = ledger.accounts.find((a) => a.name === '初期残高')!;
    // 資産を増やす: 借方 資産 / 貸方 初期残高
    await upsertEntry(
      buildSimpleEntry({
        date: '2026-06-01',
        description: '初期',
        debitAccountId: acc.id,
        creditAccountId: capital.id,
        amount,
      }),
    );
    return acc;
  }

  it('現金 理論10000・実8000 → 借方 残高調整費 / 貸方 現金 2000', async () => {
    const cash = await setBalance('現金', 10000);
    const entry = await createAdjustment({
      accountId: cash.id,
      date: '2026-06-30',
      actualBalance: 8000,
    });
    expect(entry).not.toBeNull();
    const after = await loadLedger();
    const adj = after.accounts.find((a) => a.name === '残高調整費' && a.type === 'expense')!;
    expect(adj).toBeTruthy();
    expect(entry!.lines.find((l) => l.side === 'debit')).toMatchObject({
      accountId: adj.id,
      amount: 2000,
    });
    expect(entry!.lines.find((l) => l.side === 'credit')).toMatchObject({
      accountId: cash.id,
      amount: 2000,
    });
    expect(entry!.metadata?.adjustment?.delta).toBe(-2000);
  });

  it('預金 理論10000・実12000 → 借方 預金 / 貸方 残高調整収入 2000', async () => {
    const bank = await setBalance('預金', 10000);
    const entry = await createAdjustment({
      accountId: bank.id,
      date: '2026-06-30',
      actualBalance: 12000,
    });
    const after = await loadLedger();
    const rev = after.accounts.find((a) => a.name === '残高調整収入' && a.type === 'revenue')!;
    expect(entry!.lines.find((l) => l.side === 'debit')).toMatchObject({
      accountId: bank.id,
      amount: 2000,
    });
    expect(entry!.lines.find((l) => l.side === 'credit')).toMatchObject({
      accountId: rev.id,
      amount: 2000,
    });
  });

  it('差額が無ければ仕訳を作らず null', async () => {
    const cash = await setBalance('現金', 5000);
    const entry = await createAdjustment({
      accountId: cash.id,
      date: '2026-06-30',
      actualBalance: 5000,
    });
    expect(entry).toBeNull();
  });

  it('過去日付の補正もできる', async () => {
    const cash = await setBalance('現金', 10000);
    const entry = await createAdjustment({
      accountId: cash.id,
      date: '2026-06-15',
      actualBalance: 9000,
    });
    expect(entry?.date).toBe('2026-06-15');
  });

  it('相手科目名を通常カテゴリが使用中なら流用・重複作成せず拒否する', async () => {
    const initial = await loadLedger();
    const ordinary = initial.accounts.find((account) => account.role === 'expense-category')!;
    await upsertAccount({ ...ordinary, name: '残高調整費', updatedAt: 'renamed' });
    const cash = await setBalance('現金', 10000);

    await expect(
      createAdjustment({
        accountId: cash.id,
        date: '2026-06-30',
        actualBalance: 8000,
      }),
    ).rejects.toMatchObject({ code: 'error.account.nameConflict' });

    const after = await loadLedger();
    expect(after.accounts.filter((account) => account.name === '残高調整費')).toHaveLength(1);
    expect(after.accounts.find((account) => account.name === '残高調整費')?.role).toBe(
      'expense-category',
    );
  });
});

describe('残高補正の編集・削除（updateAdjustment / deleteAdjustment）', () => {
  async function setBalance(accountName: string, amount: number) {
    const ledger = await loadLedger();
    const acc = ledger.accounts.find((a) => a.name === accountName)!;
    const capital = ledger.accounts.find((a) => a.name === '初期残高')!;
    await upsertEntry(
      buildSimpleEntry({
        date: '2026-06-01',
        description: '初期',
        debitAccountId: acc.id,
        creditAccountId: capital.id,
        amount,
      }),
    );
    return acc;
  }

  it('編集の理論残高は補正自身を除いて計算する（二重掛けしない）', async () => {
    const cash = await setBalance('現金', 10000);
    const created = await createAdjustment({
      accountId: cash.id,
      date: '2026-06-30',
      actualBalance: 8000,
    });
    expect(created!.metadata?.adjustment?.expectedBalance).toBe(10000);

    // 実残高 9000 に修正。理論残高は補正自身を除く 10000 のまま（8000 にならない）。
    const updated = await updateAdjustment({
      id: created!.id,
      accountId: cash.id,
      date: '2026-06-30',
      actualBalance: 9000,
    });
    expect(updated!.id).toBe(created!.id);
    expect(updated!.metadata?.adjustment?.expectedBalance).toBe(10000);
    expect(updated!.metadata?.adjustment?.delta).toBe(-1000);
    // 借方 残高調整費 1000 / 貸方 現金 1000。
    expect(updated!.lines.find((l) => l.side === 'credit')).toMatchObject({
      accountId: cash.id,
      amount: 1000,
    });
    const after = await loadLedger();
    expect(after.journalEntries.filter((e) => e.metadata?.adjustment)).toHaveLength(1);
    expect(accountBalance(cash.id, 'asset', after.journalEntries)).toBe(9000);
  });

  it('編集で差額が 0 になると補正は削除される', async () => {
    const cash = await setBalance('現金', 10000);
    const created = await createAdjustment({
      accountId: cash.id,
      date: '2026-06-30',
      actualBalance: 8000,
    });
    const updated = await updateAdjustment({
      id: created!.id,
      accountId: cash.id,
      date: '2026-06-30',
      actualBalance: 10000, // 理論残高（自身除外）= 10000 → delta 0
    });
    expect(updated).toBeNull();
    const after = await loadLedger();
    expect(after.journalEntries.some((e) => e.id === created!.id)).toBe(false);
    expect(after.journalEntries.filter((e) => e.metadata?.adjustment)).toHaveLength(0);
  });

  it('削除で対象日以降の理論残高が補正前に戻る', async () => {
    const cash = await setBalance('現金', 10000);
    const created = await createAdjustment({
      accountId: cash.id,
      date: '2026-06-30',
      actualBalance: 8000,
    });
    expect(accountBalance(cash.id, 'asset', (await loadLedger()).journalEntries)).toBe(8000);
    await deleteAdjustment(created!.id);
    const after = await loadLedger();
    expect(after.journalEntries.some((e) => e.id === created!.id)).toBe(false);
    expect(accountBalance(cash.id, 'asset', after.journalEntries)).toBe(10000);
  });

  it('補正でない仕訳 / 存在しない id は編集・削除できない（fail-closed）', async () => {
    const cash = await setBalance('現金', 10000);
    await expect(deleteAdjustment('no-such-id')).rejects.toThrow();
    await expect(
      updateAdjustment({
        id: 'no-such-id',
        accountId: cash.id,
        date: '2026-06-30',
        actualBalance: 9000,
      }),
    ).rejects.toThrow();
  });

  it('残高補正の仕訳は通常 Journal 経路（upsertEntry/deleteEntry）で壊せない', async () => {
    const cash = await setBalance('現金', 10000);
    const created = await createAdjustment({
      accountId: cash.id,
      date: '2026-06-30',
      actualBalance: 8000,
    });
    let delCode = '';
    try {
      await deleteEntry(created!.id);
    } catch (e) {
      delCode = (e as LedgerError).code;
    }
    expect(delCode).toBe('error.entry.adjustment');
    await expect(upsertEntry({ ...created!, description: '改ざん' })).rejects.toThrow();
  });
});

describe('継続コスト資産の後編集で過去集計が再計算される（導出＝遡及処理なし）', () => {
  async function setupContinuous() {
    const ledger = await loadLedger();
    const fun = ledger.accounts.find((a) => a.role === 'expense-category')!;
    const cash = ledger.accounts.find((a) => a.role === 'daily-asset')!;
    const item = await createContinuousCost({
      name: 'サブスク',
      amount: 12000,
      startDate: '2026-01-01',
      endDate: '2026-12-31',
      expenseAccountId: fun.id,
      creditAccountId: cash.id,
    });
    return { item, fun, cash };
  }
  const recogOf = (entries: JournalEntry[], id: string) =>
    entries.filter(
      (e) => e.metadata?.continuousCostId === id && e.metadata?.ccKind === 'recognition',
    );

  it('金額を後編集すると過去の費用行が再計算され、購入の仕訳の金額もミラーされる', async () => {
    const { item, fun } = await setupContinuous();
    const before = await loadLedger();
    const asOf = '2026-06-30';
    const recogBefore = recogOf(reportEntriesForAsOf(before, asOf), item.id).reduce(
      (s, e) => s + (e.lines.find((l) => l.side === 'debit')?.amount ?? 0),
      0,
    );
    expect(recogBefore).toBe(6000);
    const expenseBefore = accountBalance(fun.id, 'expense', reportEntriesForAsOf(before, asOf));

    await upsertMonthlyCost({ ...item, amount: 24000, updatedAt: 'y2' });

    const after = await loadLedger();
    const recogAfter = recogOf(reportEntriesForAsOf(after, asOf), item.id).reduce(
      (s, e) => s + (e.lines.find((l) => l.side === 'debit')?.amount ?? 0),
      0,
    );
    expect(recogAfter).toBe(12000); // 月あたりが倍増（過去に遡って再計算）
    expect(accountBalance(fun.id, 'expense', reportEntriesForAsOf(after, asOf))).toBe(
      expenseBefore + 6000,
    );
    // 購入の仕訳の金額もミラーされ、台帳残高 >= 0。
    const purchase = after.journalEntries.find((e) => e.metadata?.monthlyCostId === item.id)!;
    expect(purchase.lines.every((l) => l.amount === 24000)).toBe(true);
    expect(
      accountBalance(
        CONTINUOUS_COST_LEDGER_ACCOUNT_ID,
        'asset',
        reportEntriesForAsOf(after, asOf),
      ),
    ).toBeGreaterThanOrEqual(0);
  });

  it('費用の行き先の変更は購入の仕訳を壊さない（借方は台帳のまま・§13-6）', async () => {
    const { item, fun } = await setupContinuous();
    const ledger = await loadLedger();
    const other = ledger.accounts.find(
      (a) => a.role === 'expense-category' && a.id !== fun.id,
    )!;
    await upsertMonthlyCost({ ...item, expenseAccountId: other.id, updatedAt: 'y2' });
    const after = await loadLedger();
    const purchase = after.journalEntries.find((e) => e.metadata?.monthlyCostId === item.id)!;
    expect(purchase.lines.find((l) => l.side === 'debit')?.accountId).toBe(
      CONTINUOUS_COST_LEDGER_ACCOUNT_ID,
    );
    // 台帳残高は変わらない（終了日以降 0）。費用行の行き先だけが変わる。
    const derived = reportEntriesForAsOf(after, '2027-01-31');
    expect(accountBalance(CONTINUOUS_COST_LEDGER_ACCOUNT_ID, 'asset', derived)).toBe(0);
    expect(recogOf(derived, item.id).every((e) => e.lines[0]?.accountId === other.id)).toBe(true);
  });

  it('終了日の後編集で対象期間が変わる（終了日を消すと費用行が消える）', async () => {
    const { item } = await setupContinuous();
    await upsertMonthlyCost({ ...item, endDate: '2026-06-30', updatedAt: 'y2' });
    let after = await loadLedger();
    expect(recogOf(reportEntriesForAsOf(after, '2027-12-31'), item.id)).toHaveLength(6);
    // 終了日を消す = 費用の割り振りが止まる（残存価値 = 全額）。
    const cleared = { ...after.monthlyCostItems.find((m) => m.id === item.id)! };
    delete cleared.endDate;
    await upsertMonthlyCost(cleared);
    after = await loadLedger();
    expect(recogOf(reportEntriesForAsOf(after, '2027-12-31'), item.id)).toHaveLength(0);
  });
});

describe('勘定科目の聖域化（継続コストは集約台帳口座へ寄せる）', () => {
  async function createCC(name: string) {
    const ledger = await loadLedger();
    const fun = ledger.accounts.find((a) => a.role === 'expense-category')!;
    const cash = ledger.accounts.find((a) => a.role === 'daily-asset')!;
    return createContinuousCost({
      name,
      amount: 240000,
      startDate: '2026-01-01',
      endDate: '2032-12-31',
      expenseAccountId: fun.id,
      creditAccountId: cash.id,
    });
  }

  it('対象名の勘定科目を自動作成せず、品目名は item に残る', async () => {
    const item = await createCC('洗濯機');
    const after = await loadLedger();
    expect(
      after.accounts.some((a) => a.name === '洗濯機' && a.role === 'continuing-cost-asset'),
    ).toBe(false);
    expect(after.monthlyCostItems.find((m) => m.id === item.id)?.name).toBe('洗濯機');
    const ledgerAcc = after.accounts.find((a) => a.id === CONTINUOUS_COST_LEDGER_ACCOUNT_ID)!;
    expect(ledgerAcc.name).toBe(CONTINUOUS_COST_LEDGER_ACCOUNT_NAME);
    expect(ledgerAcc.role).toBe('continuing-cost-asset');
  });

  it('複数登録しても集約台帳口座は 1 件だけ・購入の仕訳は全て台帳借方', async () => {
    await createCC('洗濯機');
    await createCC('YouTube');
    const after = await loadLedger();
    const ccAccounts = after.accounts.filter((a) => a.role === 'continuing-cost-asset');
    expect(ccAccounts).toHaveLength(1);
    expect(ccAccounts[0]?.id).toBe(CONTINUOUS_COST_LEDGER_ACCOUNT_ID);
    const purchases = after.journalEntries.filter((e) => e.metadata?.monthlyCostId);
    expect(purchases).toHaveLength(2);
    expect(
      purchases.every(
        (e) => e.lines.find((l) => l.side === 'debit')?.accountId === CONTINUOUS_COST_LEDGER_ACCOUNT_ID,
      ),
    ).toBe(true);
  });

  it('台帳口座は削除できない（role ガード・fail-closed）', async () => {
    await createCC('洗濯機');
    await expect(deleteAccount(CONTINUOUS_COST_LEDGER_ACCOUNT_ID)).rejects.toMatchObject({
      code: 'error.account.deleteInUse',
    });
  });
});

describe('継続コストの支払い元に other-liability（ローン）を許可する', () => {
  it('自動車ローンで購入 → 購入の仕訳は 借方 台帳 / 貸方 ローン、返済は 借方 ローン / 貸方 預金 の実仕訳', async () => {
    const ledger = await loadLedger();
    const fun = ledger.accounts.find((a) => a.role === 'expense-category')!;
    const bank = ledger.accounts.find((a) => a.name === '預金')!;
    await upsertAccount({
      id: 'loan',
      name: '自動車ローン',
      type: 'liability',
      role: 'other-liability',
      archived: false,
      createdAt: 'x',
      updatedAt: 'x',
    });
    const item = await createContinuousCost({
      name: '自動車',
      amount: 2400000,
      startDate: '2026-01-15',
      endDate: '2030-12-31',
      expenseAccountId: fun.id,
      creditAccountId: 'loan',
      repaymentAccountId: bank.id,
      repaymentCount: 60,
      repaymentStartDate: '2026-02-01',
    });
    const after = await loadLedger();
    expect(after.cashflowSchedules).toHaveLength(0);
    const repays = after.journalEntries
      .filter((e) => e.description.startsWith('自動車 返済'))
      .sort((a, b) => a.date.localeCompare(b.date));
    expect(repays).toHaveLength(60);
    expect(
      repays.reduce((s, e) => s + (e.lines.find((l) => l.side === 'debit')?.amount ?? 0), 0),
    ).toBe(2400000);
    expect(repays[0]?.lines.find((l) => l.side === 'debit')?.accountId).toBe('loan');
    expect(repays[0]?.lines.find((l) => l.side === 'credit')?.accountId).toBe(bank.id);
    expect(repays.every((e) => e.metadata?.monthlyCostId === undefined)).toBe(true);
    // 購入の仕訳（保存される仕訳）: 借方 台帳 / 貸方 ローン（作者②の例そのもの）。
    const purchase = after.journalEntries.find((e) => e.metadata?.monthlyCostId === item.id)!;
    expect(purchase.lines).toEqual([
      { accountId: CONTINUOUS_COST_LEDGER_ACCOUNT_ID, side: 'debit', amount: 2400000 },
      { accountId: 'loan', side: 'credit', amount: 2400000 },
    ]);
  });
});

describe('初期残高（createOpening / updateOpening / deleteOpening）', () => {
  it('複数の初期残高を 1 回の revision 更新で一括登録する', async () => {
    const before = await loadLedger();
    const cash = before.accounts.find((account) => account.name === '現金')!;
    const card = before.accounts.find((account) => account.role === 'payment-liability')!;
    const created = await createOpenings([
      { accountId: cash.id, amount: 50000, date: '2026-01-01' },
      { accountId: card.id, amount: 30000, date: '2026-01-01' },
    ]);

    const after = await loadLedger();
    expect(created).toHaveLength(2);
    expect(after.journalEntries.filter((entry) => entry.kind === 'opening')).toHaveLength(2);
    expect(after.accounts.filter((account) => account.role === 'equity' && !account.archived)).toHaveLength(
      1,
    );
    expect(after.meta.revision).toBe(before.meta.revision + 1);
  });

  it('一括登録の 2 件目で transaction が abort すると 1 件も残らない', async () => {
    const before = await loadLedger();
    const cash = before.accounts.find((account) => account.name === '現金')!;
    const card = before.accounts.find((account) => account.role === 'payment-liability')!;
    const equityCountBefore = before.accounts.filter((account) => account.role === 'equity').length;
    const originalPut = IDBObjectStore.prototype.put;
    let journalPuts = 0;
    const putSpy = vi
      .spyOn(IDBObjectStore.prototype, 'put')
      .mockImplementation(function (this: IDBObjectStore, value: unknown) {
        const request = originalPut.call(this, value);
        if (this.name === STORE.journalEntries && ++journalPuts === 2) {
          this.transaction.abort();
        }
        return request;
      });

    try {
      await expect(
        createOpenings([
          { accountId: cash.id, amount: 50000, date: '2026-01-01' },
          { accountId: card.id, amount: 30000, date: '2026-01-01' },
        ]),
      ).rejects.toThrow();
    } finally {
      putSpy.mockRestore();
    }

    const after = await loadLedger();
    expect(after.journalEntries.filter((entry) => entry.kind === 'opening')).toHaveLength(0);
    expect(after.accounts.filter((account) => account.role === 'equity')).toHaveLength(
      equityCountBefore,
    );
    expect(after.meta.revision).toBe(before.meta.revision);
  });

  it('新規資産科目の初期残高（借方 科目 / 貸方 初期残高）', async () => {
    await loadLedger();
    const entry = await createOpening({
      newAccount: { name: 'タンス預金', type: 'asset', role: 'daily-asset' },
      amount: 50000,
      date: '2026-01-01',
    });
    expect(entry.kind).toBe('opening');
    const after = await loadLedger();
    const acc = after.accounts.find((a) => a.name === 'タンス預金')!;
    expect(acc.role).toBe('daily-asset');
    expect(accountBalance(acc.id, 'asset', after.journalEntries)).toBe(50000);
  });

  it('負債の初期残高は逆向き（借方 初期残高 / 貸方 科目）', async () => {
    await loadLedger();
    const entry = await createOpening({
      newAccount: { name: 'ローン', type: 'liability', role: 'other-liability' },
      amount: 30000,
      date: '2026-01-01',
    });
    const after = await loadLedger();
    const acc = after.accounts.find((a) => a.name === 'ローン')!;
    expect(accountBalance(acc.id, 'liability', after.journalEntries)).toBe(30000);
    const equity = after.accounts.find((a) => a.role === 'equity')!;
    expect(entry.lines.find((l) => l.side === 'debit')?.accountId).toBe(equity.id);
  });

  it('編集で金額が変わり、削除で無くなる', async () => {
    await loadLedger();
    const entry = await createOpening({
      newAccount: { name: 'タンス預金', type: 'asset', role: 'daily-asset' },
      amount: 50000,
      date: '2026-01-01',
    });
    await updateOpening({ id: entry.id, amount: 60000, date: '2026-01-01' });
    let after = await loadLedger();
    const acc = after.accounts.find((a) => a.name === 'タンス預金')!;
    expect(accountBalance(acc.id, 'asset', after.journalEntries)).toBe(60000);
    await deleteOpening(entry.id);
    after = await loadLedger();
    expect(after.journalEntries.some((e) => e.id === entry.id)).toBe(false);
  });

  it('既存 BS 科目にも付けられる / 資産・負債以外は弾く', async () => {
    const ledger = await loadLedger();
    const cash = ledger.accounts.find((a) => a.name === '現金')!;
    const entry = await createOpening({ accountId: cash.id, amount: 12345, date: '2026-01-01' });
    expect(entry.kind).toBe('opening');
    const fun = ledger.accounts.find((a) => a.role === 'expense-category')!;
    await expect(
      createOpening({ accountId: fun.id, amount: 100, date: '2026-01-01' }),
    ).rejects.toThrow();
  });
});

describe('目的別資金(reserve-asset)の残高不足ガード', () => {
  it('残高内は成功・超過は保存拒否', async () => {
    const ledger = await loadLedger();
    const capital = ledger.accounts.find((a) => a.name === '初期残高')!;
    const cash = ledger.accounts.find((a) => a.name === '現金')!;
    const resId = newId();
    await upsertAccount({
      id: resId,
      name: '自動車購入資金',
      type: 'asset',
      role: 'reserve-asset',
      archived: false,
      createdAt: 'x',
      updatedAt: 'x',
    });
    // 100,000 を積み立てる（借方 資金 / 貸方 初期残高）。
    await upsertEntry(
      buildSimpleEntry({
        date: '2026-01-10',
        description: '積立',
        debitAccountId: resId,
        creditAccountId: capital.id,
        amount: 100000,
      }),
    );
    // 80,000 を資金 → 現金（残高内・成功）。
    await upsertEntry(
      buildSimpleEntry({
        date: '2026-02-01',
        description: '引出',
        debitAccountId: cash.id,
        creditAccountId: resId,
        amount: 80000,
      }),
    );
    // さらに 80,000（残高 20,000 しかない）→ 拒否。
    await expect(
      upsertEntry(
        buildSimpleEntry({
          date: '2026-02-02',
          description: '引出2',
          debitAccountId: cash.id,
          creditAccountId: resId,
          amount: 80000,
        }),
      ),
    ).rejects.toThrow();
  });
});

describe('保存境界の fail-closed（構造・参照検証 + i18n エラーコード）', () => {
  /** 例外を捕捉して LedgerError として返す（throw しなければ失敗）。 */
  async function caught(p: Promise<unknown>): Promise<LedgerError> {
    try {
      await p;
    } catch (e) {
      return e as LedgerError;
    }
    throw new Error('例外が送出されませんでした');
  }

  it('upsertEntry は存在しない勘定科目を参照する仕訳を保存しない', async () => {
    const ledger = await loadLedger();
    const cash = ledger.accounts.find((a) => a.name === '現金')!;
    const e = await caught(
      upsertEntry(
        buildSimpleEntry({
          date: '2026-06-01',
          description: '不正参照',
          debitAccountId: 'no-such-account',
          creditAccountId: cash.id,
          amount: 500,
        }),
      ),
    );
    expect(e).toBeInstanceOf(LedgerError);
    expect(e.code).toBe('error.entry.unknownAccount');
  });

  it('upsertEntry は構造が不正な仕訳（金額 0）を保存しない', async () => {
    const ledger = await loadLedger();
    const cash = ledger.accounts.find((a) => a.name === '現金')!;
    const food = ledger.accounts.find((a) => a.name === '変動費')!;
    const e = await caught(
      upsertEntry(
        buildSimpleEntry({
          date: '2026-06-01',
          description: 'ゼロ円',
          debitAccountId: food.id,
          creditAccountId: cash.id,
          amount: 0,
        }),
      ),
    );
    expect(e).toBeInstanceOf(LedgerError);
    expect(e.code).toBe('error.entry.invalidStructure');
  });

  it('upsertEntry は仮想仕訳用メタデータを各フィールド単独でも保存しない', async () => {
    const ledger = await loadLedger();
    const cash = ledger.accounts.find((a) => a.name === '現金')!;
    const food = ledger.accounts.find((a) => a.name === '変動費')!;
    const forbidden: NonNullable<JournalEntry['metadata']>[] = [
      { virtual: true },
      { continuousCostId: 'cc-1' },
      { ccKind: 'recognition' },
    ];
    for (const [index, metadata] of forbidden.entries()) {
      const entry = buildSimpleEntry({
        date: '2026-06-01',
        description: `仮想仕訳${index}`,
        debitAccountId: food.id,
        creditAccountId: cash.id,
        amount: 500,
      });
      entry.metadata = { ...entry.metadata, ...metadata };
      const error = await caught(upsertEntry(entry));
      expect(error.code).toBe('error.entry.virtual');
      expect((await loadLedger()).journalEntries.some((saved) => saved.id === entry.id)).toBe(false);
    }
  });

  it('upsertSchedule は存在しない口座を参照する予定を保存しない', async () => {
    await loadLedger();
    const schedule: CashflowSchedule = {
      id: newId(),
      title: '不正口座',
      dueDate: '2026-07-10',
      amount: 1000,
      direction: 'outflow',
      accountId: 'no-such-account',
      source: 'manual',
      status: 'planned',
      createdAt: 'x',
      updatedAt: 'x',
    };
    const e = await caught(upsertSchedule(schedule));
    expect(e).toBeInstanceOf(LedgerError);
    expect(e.code).toBe('error.schedule.unknownAccount');
  });

  it('upsertSchedule は構造が不正な予定（金額 0）を保存しない', async () => {
    const ledger = await loadLedger();
    const cash = ledger.accounts.find((a) => a.name === '現金')!;
    const schedule: CashflowSchedule = {
      id: newId(),
      title: 'ゼロ円予定',
      dueDate: '2026-07-10',
      amount: 0,
      direction: 'outflow',
      accountId: cash.id,
      source: 'manual',
      status: 'planned',
      createdAt: 'x',
      updatedAt: 'x',
    };
    const e = await caught(upsertSchedule(schedule));
    expect(e).toBeInstanceOf(LedgerError);
    expect(e.code).toBe('error.schedule.invalidStructure');
  });

  it('createReserve は目的別の勘定科目を作らず、集約口座へ寄せる（聖域化）', async () => {
    await loadLedger();
    const reserve = await createReserve({ name: '旅行資金' });
    const after = await loadLedger();
    // 目的名の専用科目は作られない。reserveAccountId は単一の集約口座。
    expect(reserve.reserveAccountId).toBe(RESERVE_LEDGER_ACCOUNT_ID);
    expect(after.accounts.some((a) => a.name === '旅行資金')).toBe(false);
    const ledgerAcc = after.accounts.find((a) => a.id === RESERVE_LEDGER_ACCOUNT_ID)!;
    expect(ledgerAcc.role).toBe('reserve-asset');
  });

  it('createReserve を複数回呼んでも reserve-asset 科目は集約口座 1 件だけ', async () => {
    await loadLedger();
    await createReserve({ name: '旅行資金' });
    await createReserve({ name: '車の頭金' });
    const after = await loadLedger();
    const reserveAccts = after.accounts.filter((a) => a.role === 'reserve-asset');
    expect(reserveAccts).toHaveLength(1);
    expect(reserveAccts[0]?.id).toBe(RESERVE_LEDGER_ACCOUNT_ID);
    expect(after.reserves).toHaveLength(2);
    expect(after.reserves.every((r) => r.reserveAccountId === RESERVE_LEDGER_ACCOUNT_ID)).toBe(
      true,
    );
  });

  it('createContinuousCost は startDate が YYYY-MM-DD でないと保存しない', async () => {
    const ledger = await loadLedger();
    const cash = ledger.accounts.find((a) => a.name === '現金')!;
    const food = ledger.accounts.find((a) => a.name === '変動費')!;
    const e = await caught(
      createContinuousCost({
        name: 'サブスク',
        amount: 1000,
        startDate: '2026/06/01', // 不正な形式
        expenseAccountId: food.id,
        creditAccountId: cash.id,
      }),
    );
    expect(e).toBeInstanceOf(LedgerError);
    expect(e.code).toBe('error.monthlyCost.dateRequired');
  });

  it('LedgerError は i18n 表示できる（code が ja.ts に存在し errorText で文言化される）', async () => {
    const ledger = await loadLedger();
    const cash = ledger.accounts.find((a) => a.name === '現金')!;
    const e = await caught(
      upsertEntry(
        buildSimpleEntry({
          date: '2026-06-01',
          description: '不正参照',
          debitAccountId: 'no-such-account',
          creditAccountId: cash.id,
          amount: 500,
        }),
      ),
    );
    const { errorText } = await import('../src/i18n');
    const text = errorText(e);
    expect(text).toBe('仕訳が存在しない勘定科目を参照しています。');
    // code そのものではなく、翻訳済みの文言が返ること。
    expect(text).not.toBe(e.code);
  });

});

describe('継続コスト資産の後編集（upsertMonthlyCost 保存境界）', () => {
  async function setup() {
    const ledger = await loadLedger();
    const cash = ledger.accounts.find((a) => a.name === '現金')!;
    const food = ledger.accounts.find((a) => a.name === '変動費')!;
    const item = await createContinuousCost({
      name: '年払いクラウド',
      amount: 12000,
      startDate: '2026-01-15',
      endDate: '2026-12-31',
      expenseAccountId: food.id,
      creditAccountId: cash.id,
    });
    return { item, cash, food };
  }

  it('名称・終了日・費用の行き先の編集が保存される（購入の仕訳は不変）', async () => {
    const { item, food } = await setup();
    const before = await loadLedger();
    const purchaseBefore = before.journalEntries.find(
      (e) => e.metadata?.monthlyCostId === item.id,
    )!;
    const other = before.accounts.find(
      (a) => a.role === 'expense-category' && a.id !== food.id,
    )!;
    await upsertMonthlyCost({
      ...item,
      name: '新名称',
      endDate: '2027-06-30',
      expenseAccountId: other.id,
      updatedAt: 'y2',
    });
    const after = await loadLedger();
    const saved = after.monthlyCostItems.find((m) => m.id === item.id)!;
    expect(saved.name).toBe('新名称');
    expect(saved.endDate).toBe('2027-06-30');
    expect(saved.expenseAccountId).toBe(other.id);
    // 金額を変えていないので購入の仕訳は 1 バイトも変わらない。
    const purchaseAfter = after.journalEntries.find(
      (e) => e.metadata?.monthlyCostId === item.id,
    )!;
    expect(purchaseAfter).toEqual(purchaseBefore);
  });

  it('金額の編集は購入の仕訳の両側金額へミラーされる（回収の振替は触らない）', async () => {
    const { item, cash } = await setup();
    // 回収の振替を作っておく。
    await archiveMonthlyCost({
      id: item.id,
      endDate: '2026-12-31',
      recovery: { destinationAccountId: cash.id, amount: 3000 },
    });
    await upsertMonthlyCost({ ...item, amount: 24000, updatedAt: 'y2' });
    const after = await loadLedger();
    const purchase = after.journalEntries.find(
      (e) => e.metadata?.monthlyCostId === item.id && e.metadata.monthlyCostRecovery !== true,
    )!;
    expect(purchase.lines.every((l) => l.amount === 24000)).toBe(true);
    const recovery = after.journalEntries.find(
      (e) => e.metadata?.monthlyCostRecovery === true,
    )!;
    expect(recovery.lines.every((l) => l.amount === 3000)).toBe(true); // 不変
  });

  it('開始日は変更できない（購入の仕訳の日付のミラー）・id/createdAt も固定', async () => {
    const { item } = await setup();
    await upsertMonthlyCost({ ...item, startDate: '2020-01-01', createdAt: 'fake' });
    const after = await loadLedger();
    const saved = after.monthlyCostItems.find((m) => m.id === item.id)!;
    expect(saved.startDate).toBe('2026-01-15');
    expect(saved.createdAt).toBe(item.createdAt);
  });

  it('endDate < startDate は保存しない / 存在しない item は notFound', async () => {
    const { item } = await setup();
    await expect(
      upsertMonthlyCost({ ...item, endDate: '2026-01-14' }),
    ).rejects.toMatchObject({ code: 'error.monthlyCost.endBeforeStart' });
    await expect(
      upsertMonthlyCost({ ...item, id: 'no-such-item' }),
    ).rejects.toMatchObject({ code: 'error.monthlyCost.notFound' });
  });

  it('費用の行き先に内部集約・存在しない科目は保存しない', async () => {
    const { item } = await setup();
    await expect(
      upsertMonthlyCost({ ...item, expenseAccountId: CONTINUOUS_COST_LEDGER_ACCOUNT_ID }),
    ).rejects.toMatchObject({ code: 'error.monthlyCost.expenseCategory' });
    await expect(
      upsertMonthlyCost({ ...item, expenseAccountId: 'no-such-account' }),
    ).rejects.toMatchObject({ code: 'error.monthlyCost.expenseCategory' });
  });

  it('撤去済みフィールドの残骸を持つ item でも編集でき、保存後に残骸が消える（自己修復）', async () => {
    const { item } = await setup();
    // 旧モデルの残骸（8 フィールド以外の未知キー）を IndexedDB に直接混ぜる。
    await putRecord(STORE.monthlyCostItems, {
      ...item,
      startMonth: '2026-01',
      endMonth: '2026-12',
      status: 'active',
      recognitionCreditAccountId: 'ghost',
    } as unknown as Record<string, unknown>);
    await upsertMonthlyCost({ ...item, name: '掃除後' });
    const after = await loadLedger();
    const saved = after.monthlyCostItems.find((m) => m.id === item.id) as unknown as Record<
      string,
      unknown
    >;
    expect(saved.name).toBe('掃除後');
    expect(saved.startMonth).toBeUndefined();
    expect(saved.endMonth).toBeUndefined();
    expect(saved.status).toBeUndefined();
    expect(saved.recognitionCreditAccountId).toBeUndefined();
  });
});

describe('継続コスト資産のアーカイブ（archiveMonthlyCost = 終了日の設定 + 回収の振替）', () => {
  async function setup() {
    const ledger = await loadLedger();
    const bank = ledger.accounts.find((a) => a.name === '預金')!;
    const food = ledger.accounts.find((a) => a.name === '変動費')!;
    const item = await createContinuousCost({
      name: '洗濯機',
      amount: 240000,
      startDate: '2024-06-01',
      endDate: '2029-05-31',
      expenseAccountId: food.id,
      creditAccountId: bank.id,
    });
    return { item, bank, food };
  }

  it('回収の振替つきアーカイブ: 終了日 + 振替（借方 振替先 / 貸方 台帳）を 1 tx で保存する（§13-8）', async () => {
    const { item, bank, food } = await setup();
    await archiveMonthlyCost({
      id: item.id,
      endDate: '2026-06-15',
      recovery: { destinationAccountId: bank.id, amount: 30000 },
    });
    const after = await loadLedger();
    expect(after.monthlyCostItems.find((m) => m.id === item.id)?.endDate).toBe('2026-06-15');
    const recovery = after.journalEntries.find((e) => e.metadata?.monthlyCostRecovery === true)!;
    expect(recovery.date).toBe('2026-06-15');
    expect(recovery.metadata?.monthlyCostId).toBe(item.id);
    expect(recovery.lines).toEqual([
      { accountId: bank.id, side: 'debit', amount: 30000 },
      { accountId: CONTINUOUS_COST_LEDGER_ACCOUNT_ID, side: 'credit', amount: 30000 },
    ]);
    // 会計（§6-1 の検算）: 2024-06〜2026-06 = 25ヶ月・月あたり 8,400・台帳は 0 で閉じる。
    const derived = reportEntriesForAsOf(after, '2026-12-31');
    const recogs = derived.filter(
      (e) => e.metadata?.continuousCostId === item.id && e.metadata?.ccKind === 'recognition',
    );
    expect(recogs).toHaveLength(25);
    expect(recogs[0]?.lines[0]?.amount).toBe(8400);
    expect(accountBalance(food.id, 'expense', derived)).toBe(210000);
    expect(accountBalance(CONTINUOUS_COST_LEDGER_ACCOUNT_ID, 'asset', derived)).toBe(0);
  });

  it('回収額に上限なし（残存価値・購入額を超えてもエラーにしない・作者決定）', async () => {
    const { item, bank } = await setup();
    await archiveMonthlyCost({
      id: item.id,
      endDate: '2026-06-15',
      recovery: { destinationAccountId: bank.id, amount: 300000 },
    });
    const after = await loadLedger();
    const derived = reportEntriesForAsOf(after, '2026-12-31');
    // 割り振る総額 = 240,000 − 300,000 = −60,000（費用のマイナス）・台帳は 0 で閉じる。
    expect(accountBalance(CONTINUOUS_COST_LEDGER_ACCOUNT_ID, 'asset', derived)).toBe(0);
  });

  it('回収なしアーカイブは終了日だけ更新（残存価値は全額費用へ）・復元は終了日を先へ動かすだけ', async () => {
    const { item } = await setup();
    await archiveMonthlyCost({ id: item.id, endDate: '2026-06-15' });
    let after = await loadLedger();
    expect(after.journalEntries.some((e) => e.metadata?.monthlyCostRecovery === true)).toBe(false);
    expect(after.monthlyCostItems.find((m) => m.id === item.id)?.endDate).toBe('2026-06-15');
    // 復元 = 終了日を未来へ（同じ 1 操作）。
    await archiveMonthlyCost({ id: item.id, endDate: '2030-05-31' });
    after = await loadLedger();
    expect(after.monthlyCostItems.find((m) => m.id === item.id)?.endDate).toBe('2030-05-31');
  });

  it('検証: 開始日より前の終了日・不正な振替先は fail-closed', async () => {
    const { item } = await setup();
    const food = (await loadLedger()).accounts.find((a) => a.name === '変動費')!;
    await expect(
      archiveMonthlyCost({ id: item.id, endDate: '2024-05-31' }),
    ).rejects.toMatchObject({ code: 'error.monthlyCost.endBeforeStart' });
    await expect(
      archiveMonthlyCost({
        id: item.id,
        endDate: '2026-06-15',
        recovery: { destinationAccountId: food.id, amount: 100 },
      }),
    ).rejects.toMatchObject({ code: 'error.monthlyCost.recoveryDestination' });
    await expect(
      archiveMonthlyCost({ id: 'no-such-item', endDate: '2026-06-15' }),
    ).rejects.toMatchObject({ code: 'error.monthlyCost.notFound' });
  });

  it('回収の振替は普通の振替として編集・削除できる', async () => {
    const { item, bank } = await setup();
    await archiveMonthlyCost({
      id: item.id,
      endDate: '2026-06-15',
      recovery: { destinationAccountId: bank.id, amount: 30000 },
    });
    const ledger = await loadLedger();
    const recovery = ledger.journalEntries.find((e) => e.metadata?.monthlyCostRecovery === true)!;
    // 金額の編集（回収額の変更）→ 導出の spreadTotal が変わるだけ。
    await upsertEntry({
      ...recovery,
      lines: recovery.lines.map((l) => ({ ...l, amount: 20000 })),
    });
    const edited = (await loadLedger()).journalEntries.find((e) => e.id === recovery.id)!;
    expect(edited.lines.every((l) => l.amount === 20000)).toBe(true);
    expect(edited.metadata?.monthlyCostRecovery).toBe(true); // 印は保存境界が固定する
    // 削除も可能。
    await deleteEntry(recovery.id);
    expect((await loadLedger()).journalEntries.some((e) => e.id === recovery.id)).toBe(false);
  });
});

describe('勘定科目のアーカイブ（archiveAccount = 残高 0 不変条件 + 振替導線）', () => {
  it('残高 0 の資産は即アーカイブできる・残高ありは archiveBalance で拒否', async () => {
    const ledger = await loadLedger();
    const cash = ledger.accounts.find((a) => a.name === '現金')!;
    const food = ledger.accounts.find((a) => a.name === '変動費')!;
    // 残高 0 のまま → 即アーカイブ。
    await archiveAccount(cash.id);
    expect(
      (await loadLedger()).accounts.find((a) => a.id === cash.id)?.archived,
    ).toBe(true);
    // アーカイブ解除（チェック不要）。
    await upsertAccount({ ...cash, archived: false, updatedAt: 'y' });
    // 残高をつける → 残高ありのアーカイブは拒否（upsertAccount 経由も archiveAccount 経由も）。
    await upsertEntry(
      buildSimpleEntry({
        date: '2026-06-01',
        description: '入金',
        debitAccountId: cash.id,
        creditAccountId: food.id,
        amount: 1000,
      }),
    );
    await expect(
      upsertAccount({ ...cash, archived: true, updatedAt: 'y2' }),
    ).rejects.toMatchObject({ code: 'error.account.archiveBalance' });
    await expect(archiveAccount(cash.id)).rejects.toMatchObject({
      code: 'error.account.archiveBalance',
    });
  });

  it('残高ありは振替仕訳を同一 tx で保存してからアーカイブする（§13-16）', async () => {
    const ledger = await loadLedger();
    const cash = ledger.accounts.find((a) => a.name === '現金')!;
    const bank = ledger.accounts.find((a) => a.name === '預金')!;
    const food = ledger.accounts.find((a) => a.name === '変動費')!;
    await upsertEntry(
      buildSimpleEntry({
        date: '2026-06-01',
        description: '入金',
        debitAccountId: cash.id,
        creditAccountId: food.id,
        amount: 1000,
      }),
    );
    // 振替（現金 → 預金 1000）を添えてアーカイブ。
    await archiveAccount(
      cash.id,
      buildSimpleEntry({
        date: todayLocal(),
        description: '現金 残高移動',
        debitAccountId: bank.id,
        creditAccountId: cash.id,
        amount: 1000,
        metadata: { inputMode: 'transfer' },
      }),
    );
    const after = await loadLedger();
    expect(after.accounts.find((a) => a.id === cash.id)?.archived).toBe(true);
    expect(after.journalEntries.some((e) => e.description === '現金 残高移動')).toBe(true);
    // 残高 0 にならない振替額なら全体を拒否（アーカイブも振替も保存されない）。
    const before = await loadLedger();
    await expect(
      archiveAccount(
        bank.id,
        buildSimpleEntry({
          date: todayLocal(),
          description: '中途半端な振替',
          debitAccountId: food.id,
          creditAccountId: bank.id,
          amount: 1,
        }),
      ),
    ).rejects.toMatchObject({ code: 'error.account.archiveBalance' });
    const unchanged = await loadLedger();
    expect(unchanged.journalEntries.length).toBe(before.journalEntries.length);
    expect(unchanged.accounts.find((a) => a.id === bank.id)?.archived).toBe(false);
  });

  it('費用カテゴリなど非 BS 科目は残高チェックなしでアーカイブできる', async () => {
    const ledger = await loadLedger();
    const cash = ledger.accounts.find((a) => a.name === '現金')!;
    const food = ledger.accounts.find((a) => a.name === '変動費')!;
    await upsertEntry(
      buildSimpleEntry({
        date: '2026-06-01',
        description: '支出',
        debitAccountId: food.id,
        creditAccountId: cash.id,
        amount: 500,
      }),
    );
    await archiveAccount(food.id);
    expect((await loadLedger()).accounts.find((a) => a.id === food.id)?.archived).toBe(true);
  });
});

describe('内訳名の重複ルール', () => {
  async function caught(p: Promise<unknown>): Promise<LedgerError> {
    try {
      await p;
    } catch (e) {
      return e as LedgerError;
    }
    throw new Error('expected rejection');
  }

  it('有効な同名科目があると保存できない（箱をまたいでも不可）', async () => {
    await loadLedger();
    // 既定科目『預金』(asset) と同名の支出カテゴリは作れない。
    const e = await caught(
      upsertAccount({
        id: newId(),
        name: '預金',
        type: 'expense',
        role: 'expense-category',
        archived: false,
        createdAt: 'x',
        updatedAt: 'x',
      }),
    );
    expect(e.code).toBe('error.account.nameConflict');
  });

  it('自分自身の更新（名前据え置き）は重複扱いしない', async () => {
    const ledger = await loadLedger();
    const cash = ledger.accounts.find((a) => a.name === '現金')!;
    await upsertAccount({ ...cash, note: 'メモ', updatedAt: 'y' });
    const after = await loadLedger();
    expect(after.accounts.find((a) => a.id === cash.id)?.note).toBe('メモ');
  });

  it('アーカイブ済みとの同名は未承認なら拒否し、承認すれば（アーカイブ）へ退避して保存する', async () => {
    const ledger = await loadLedger();
    const cash = ledger.accounts.find((a) => a.name === '現金')!;
    // 『現金』をアーカイブして、同名の新規内訳を作る。
    await upsertAccount({ ...cash, archived: true, updatedAt: 'y' });
    const newAcc = {
      id: newId(),
      name: '現金',
      type: 'asset' as const,
      role: 'daily-asset' as const,
      archived: false,
      createdAt: 'x',
      updatedAt: 'x',
    };
    const e = await caught(upsertAccount(newAcc));
    expect(e.code).toBe('error.account.nameConflictArchived');
    // 承認つきで保存 → アーカイブ側が『現金（アーカイブ）』へ退避される。
    await upsertAccount(newAcc, { renameArchivedConflicts: true });
    const after = await loadLedger();
    expect(after.accounts.find((a) => a.id === cash.id)?.name).toBe('現金（アーカイブ）');
    expect(after.accounts.find((a) => a.id === newAcc.id)?.name).toBe('現金');
    // 退避名も衝突したら（アーカイブ2）になる。
    await upsertAccount({ ...newAcc, archived: true, updatedAt: 'z' });
    const newAcc2 = { ...newAcc, id: newId() };
    await upsertAccount(newAcc2, { renameArchivedConflicts: true });
    const last = await loadLedger();
    expect(last.accounts.find((a) => a.id === newAcc.id)?.name).toBe('現金（アーカイブ2）');
    expect(last.accounts.find((a) => a.id === newAcc2.id)?.name).toBe('現金');
  });

  it('createOpening の新規科目も同じ重複ルールに従う（note も保存される）', async () => {
    await loadLedger();
    const e = await caught(
      createOpening({
        newAccount: { name: '預金', type: 'asset', role: 'daily-asset' },
        amount: 1000,
        date: '2026-06-01',
      }),
    );
    expect(e.code).toBe('error.account.nameConflict');
    const entry = await createOpening({
      newAccount: { name: '住宅ローン', type: 'liability', role: 'other-liability', note: '35年' },
      amount: 30000000,
      date: '2026-06-01',
    });
    const after = await loadLedger();
    const loan = after.accounts.find((a) => a.name === '住宅ローン')!;
    expect(loan.role).toBe('other-liability');
    expect(loan.note).toBe('35年');
    expect(entry.kind).toBe('opening');
    expect(accountBalance(loan.id, 'liability', after.journalEntries)).toBe(30000000);
  });
});

/* ── 継続コストの売却・解約終了（0円売却 = 解約） ── */
describe('ensureInitialized の並行実行', () => {
  it('同時に 2 回初期化しても既定科目は 1 セットだけ投入される', async () => {
    // resetAll 後の空 DB に対し、StrictMode の二重 effect / 複数タブ初回起動を模して並行実行する。
    await resetAll();
    const { ensureInitialized } = await import('../src/data/repository');
    await Promise.all([ensureInitialized(), ensureInitialized()]);
    const ledger = await loadLedger();
    const names = ledger.accounts.map((a) => a.name).sort();
    const unique = [...new Set(names)];
    expect(names).toEqual(unique);
    expect(ledger.accounts.filter((a) => a.name === '現金')).toHaveLength(1);
  });
});

/* ── 監査対応: 補正対象の聖域化と import の名前一意性 ── */
describe('補正対象の聖域化（内部集約口座は補正不可）', () => {
  async function caught(p: Promise<unknown>): Promise<LedgerError> {
    try {
      await p;
    } catch (e) {
      return e as LedgerError;
    }
    throw new Error('expected rejection');
  }

  it('取り置き資金の集約口座は補正できない', async () => {
    await loadLedger();
    await createReserve({ name: '旅行積立' }); // 集約口座(reserve-ledger)を作る
    const e = await caught(
      createAdjustment({
        accountId: RESERVE_LEDGER_ACCOUNT_ID,
        date: '2026-06-15',
        actualBalance: 100,
      }),
    );
    expect(e.code).toBe('error.adjust.internalRole');
  });

  it('継続コスト台帳の集約口座は補正できない', async () => {
    const ledger = await loadLedger();
    const cash = ledger.accounts.find((a) => a.name === '現金')!;
    const fixed = ledger.accounts.find((a) => a.name === '固定費')!;
    await createContinuousCost({
      name: 'サブスクX',
      amount: 1000,
      startDate: '2026-01-01',
      endDate: '2026-01-31',
      expenseAccountId: fixed.id,
      creditAccountId: cash.id,
    });
    const e = await caught(
      createAdjustment({
        accountId: CONTINUOUS_COST_LEDGER_ACCOUNT_ID,
        date: '2026-06-15',
        actualBalance: 100,
      }),
    );
    expect(e.code).toBe('error.adjust.internalRole');
  });
});

describe('import の勘定科目名一意性（有効な同名重複を拒否）', () => {
  it('有効な同名科目を含むパッケージは validation-error になる', async () => {
    await loadLedger();
    const text = exportToJsonText(await loadLedger());
    const pkg = JSON.parse(text);
    // 「現金」を「預金」と同名に書き換える（両方 active）→ 重複として拒否。
    const cash = pkg.accounts.find((a: { name: string }) => a.name === '現金');
    cash.name = '預金';
    const outcome = await importFromJsonText(JSON.stringify(pkg));
    expect(outcome.kind).toBe('validation-error');
  });

  it('アーカイブ済みとの同名は import では許容される（解除時に保存境界で弾く）', async () => {
    await loadLedger();
    const text = exportToJsonText(await loadLedger());
    const pkg = JSON.parse(text);
    const cash = pkg.accounts.find((a: { name: string }) => a.name === '現金');
    cash.name = '預金';
    cash.archived = true;
    const outcome = await importFromJsonText(JSON.stringify(pkg));
    expect(outcome.kind).toBe('ok');
  });

  it('空白違いの有効な同名（「預金」と「預金 」）も重複として拒否する', async () => {
    await loadLedger();
    const text = exportToJsonText(await loadLedger());
    const pkg = JSON.parse(text);
    // 「現金」を「預金 」（末尾空白）に書き換える → trim 後は「預金」と同名なので拒否。
    const cash = pkg.accounts.find((a: { name: string }) => a.name === '現金');
    cash.name = '預金 ';
    const outcome = await importFromJsonText(JSON.stringify(pkg));
    expect(outcome.kind).toBe('validation-error');
  });

  it('空白のみの科目名は拒否する', async () => {
    await loadLedger();
    const text = exportToJsonText(await loadLedger());
    const pkg = JSON.parse(text);
    const cash = pkg.accounts.find((a: { name: string }) => a.name === '現金');
    cash.name = '   ';
    const outcome = await importFromJsonText(JSON.stringify(pkg));
    expect(outcome.kind).toBe('validation-error');
  });

  it('保存値に空白が混じっても、後続の内訳作成は trim 後の同名を重複として弾く', async () => {
    // 直接 upsert で末尾空白名を保存（import 由来の非正規化値を模す）。
    await loadLedger();
    await upsertAccount({
      id: newId(),
      name: '財布 ',
      type: 'asset',
      role: 'daily-asset',
      archived: false,
      createdAt: 'x',
      updatedAt: 'x',
    });
    // trim 後の同名「財布」は重複として拒否される。
    let err: unknown;
    try {
      await upsertAccount({
        id: newId(),
        name: '財布',
        type: 'asset',
        role: 'daily-asset',
        archived: false,
        createdAt: 'x',
        updatedAt: 'x',
      });
    } catch (e) {
      err = e;
    }
    expect((err as LedgerError).code).toBe('error.account.nameConflict');
  });
});

describe('M2 保存境界の回帰（不正日付・導出残高・MonthlyCostItem schema）', () => {
  type LoadedLedger = Awaited<ReturnType<typeof loadLedger>>;

  /** IndexedDB に永続化される台帳本体。 */
  function durableState(ledger: LoadedLedger) {
    return {
      meta: ledger.meta,
      settings: ledger.settings,
      accounts: ledger.accounts,
      journalEntries: ledger.journalEntries,
      cashflowSchedules: ledger.cashflowSchedules,
      reserves: ledger.reserves,
      tags: ledger.tags,
      monthlyCostItems: ledger.monthlyCostItems,
      recurringRules: ledger.recurringRules,
    };
  }

  async function expectRejectedWithoutDurableMutation(
    operation: () => Promise<unknown>,
    code: string,
    context?: string,
  ) {
    const before = await loadLedger();
    await expect(operation(), context).rejects.toMatchObject({ code });
    const after = await loadLedger();
    expect(durableState(after)).toEqual(durableState(before));
  }

  it.each(['', '2026-02-31'])(
    'createAdjustment は不正日付 %j を拒否し、台帳本体と revision を変えない',
    async (date) => {
      const ledger = await loadLedger();
      const cash = ledger.accounts.find((account) => account.name === '現金')!;
      await expectRejectedWithoutDurableMutation(
        () =>
          createAdjustment({
            accountId: cash.id,
            date,
            actualBalance: 1000,
          }),
        'error.entry.invalidStructure',
      );
    },
  );

  it('createAdjustment は有効日付でも保存不能な仕訳構造を拒否し、相手科目も残さない', async () => {
    const ledger = await loadLedger();
    const cash = ledger.accounts.find((account) => account.name === '現金')!;
    await expectRejectedWithoutDurableMutation(
      () =>
        createAdjustment({
          accountId: cash.id,
          date: '2026-01-31',
          actualBalance: 1000,
          description: 'x'.repeat(201),
        }),
      'error.entry.invalidStructure',
    );
  });

  it('updateAdjustment は不正日付が delta=0 相当でも既存補正を削除しない', async () => {
    const ledger = await loadLedger();
    const cash = ledger.accounts.find((account) => account.name === '現金')!;
    await createOpening({ accountId: cash.id, amount: 1000, date: '2026-01-01' });
    const adjustment = await createAdjustment({
      accountId: cash.id,
      date: '2026-01-31',
      actualBalance: 800,
    });
    expect(adjustment).not.toBeNull();

    const cases = [
      { date: '', actualBalance: 0 },
      { date: '2026-02-31', actualBalance: 1000 },
    ];
    for (const input of cases) {
      await expectRejectedWithoutDurableMutation(
        () =>
          updateAdjustment({
            id: adjustment!.id,
            accountId: cash.id,
            ...input,
          }),
        'error.entry.invalidStructure',
      );
      expect(
        (await loadLedger()).journalEntries.find((entry) => entry.id === adjustment!.id),
      ).toEqual(adjustment);
    }
  });

  it('updateAdjustment は有効日付でも保存不能な仕訳構造を拒否し、既存補正を保持する', async () => {
    const ledger = await loadLedger();
    const cash = ledger.accounts.find((account) => account.name === '現金')!;
    await createOpening({ accountId: cash.id, amount: 1000, date: '2026-01-01' });
    const adjustment = await createAdjustment({
      accountId: cash.id,
      date: '2026-01-31',
      actualBalance: 800,
    });
    expect(adjustment).not.toBeNull();

    await expectRejectedWithoutDurableMutation(
      () =>
        updateAdjustment({
          id: adjustment!.id,
          accountId: cash.id,
          date: '2026-01-31',
          actualBalance: 900,
          description: 'x'.repeat(201),
        }),
      'error.entry.invalidStructure',
    );
    expect((await loadLedger()).journalEntries.find((entry) => entry.id === adjustment!.id)).toEqual(
      adjustment,
    );
  });

  it.each(['', '2026-02-31'])(
    'updateOpening は不正日付 %j を拒否し、既存仕訳と revision を変えない',
    async (date) => {
      const ledger = await loadLedger();
      const cash = ledger.accounts.find((account) => account.name === '現金')!;
      const opening = await createOpening({
        accountId: cash.id,
        amount: 1000,
        date: '2026-01-01',
      });

      await expectRejectedWithoutDurableMutation(
        () => updateOpening({ id: opening.id, amount: 2000, date }),
        'error.entry.invalidStructure',
      );
      expect((await loadLedger()).journalEntries.find((entry) => entry.id === opening.id)).toEqual(
        opening,
      );
    },
  );

  it('補正は継続コストの仮想 funding を含む基準残高を使い、作成・更新後の同日残高を実残高へ合わせる', async () => {
    const ledger = await loadLedger();
    const cash = ledger.accounts.find((account) => account.name === '現金')!;
    const expense = ledger.accounts.find((account) => account.name === '固定費')!;
    const date = '2026-01-15';
    const monthlyCost = await createContinuousCost({
      name: '年払いサービス',
      amount: 12000,
      startDate: '2026-01-01',
      endDate: '2026-12-31',
      expenseAccountId: expense.id,
      creditAccountId: cash.id,
    });

    const beforeAdjustment = await loadLedger();
    const basisEntries = reportEntriesForAsOf(beforeAdjustment, date);
    // 購入の仕訳（保存される仕訳）が基準残高に含まれる。
    expect(
      basisEntries.some((entry) => entry.metadata?.monthlyCostId === monthlyCost.id),
    ).toBe(true);
    expect(accountBalance(cash.id, 'asset', basisEntries)).toBe(-12000);

    const created = await createAdjustment({
      accountId: cash.id,
      date,
      actualBalance: -10000,
    });
    expect(created?.metadata?.adjustment?.expectedBalance).toBe(-12000);
    let after = await loadLedger();
    expect(accountBalance(cash.id, 'asset', reportEntriesForAsOf(after, date))).toBe(-10000);

    const updated = await updateAdjustment({
      id: created!.id,
      accountId: cash.id,
      date,
      actualBalance: -9000,
    });
    expect(updated?.metadata?.adjustment?.expectedBalance).toBe(-12000);
    after = await loadLedger();
    expect(accountBalance(cash.id, 'asset', reportEntriesForAsOf(after, date))).toBe(-9000);
  });

  it('MonthlyCostItem を作る経路は121文字名を原子的に拒否する', async () => {
    const ledger = await loadLedger();
    const cash = ledger.accounts.find((account) => account.name === '現金')!;
    const expense = ledger.accounts.find((account) => account.name === '固定費')!;
    const longName = 'x'.repeat(121);
    const cases: { path: string; operation: () => Promise<unknown> }[] = [
      {
        path: 'createContinuousCost（現金払い）',
        operation: () =>
          createContinuousCost({
            name: longName,
            amount: 12000,
            startDate: '2026-01-15',
            endDate: '2026-12-31',
            expenseAccountId: expense.id,
            creditAccountId: cash.id,
          }),
      },
      {
        path: 'createContinuousCost（持ち込み = 初期残高）',
        operation: () =>
          createContinuousCost({
            name: longName,
            amount: 12000,
            startDate: '2026-01-15',
            expenseAccountId: expense.id,
          }),
      },
    ];

    for (const testCase of cases) {
      await expectRejectedWithoutDurableMutation(
        testCase.operation,
        'error.monthlyCost.invalidStructure',
        testCase.path,
      );
    }
  });
});

describe('スナップショットの剪定（版上げ時・復旧面）', () => {
  it('schemaVersion 不一致のスナップショットを削除し、現行版は残す', async () => {
    const { pruneIncompatibleSnapshots } = await import('../src/data/repository');
    const ledger = await loadLedger();
    const current = buildExportPackage(ledger);
    await saveSnapshot({
      id: makeSnapshotId(),
      createdAt: '2026-06-01T00:00:00.000Z',
      reason: 'current',
      data: current,
    });
    await saveSnapshot({
      id: makeSnapshotId(),
      createdAt: '2026-05-01T00:00:00.000Z',
      reason: 'stale',
      data: { ...current, schemaVersion: (SCHEMA_VERSION - 1) as typeof SCHEMA_VERSION },
    });
    const pruned = await pruneIncompatibleSnapshots();
    expect(pruned).toBe(1);
    const remaining = await listSnapshots();
    expect(remaining).toHaveLength(1);
    expect(remaining[0]?.reason).toBe('current');
  });
});

describe('取り置きの枠削除（後片付け）', () => {
  it('枠の削除は同一トランザクションで仕訳の reserveId を剥がし、export が復元可能なまま残る', async () => {
    const { deleteReserve, createReserve } = await import('../src/data/repository');
    const ledger = await loadLedger();
    const capital = ledger.accounts.find((a) => a.name === '初期残高')!;
    const r = await createReserve({ name: '旅行（削除テスト）' });
    await upsertEntry(
      buildSimpleEntry({
        date: '2026-07-01',
        description: '取り置き',
        debitAccountId: RESERVE_LEDGER_ACCOUNT_ID,
        creditAccountId: capital.id,
        amount: 30000,
        metadata: { inputMode: 'transfer', reserveId: r.id },
      }),
    );
    await deleteReserve(r.id);
    const after = await loadLedger();
    expect(after.reserves.some((x) => x.id === r.id)).toBe(false);
    const entry = after.journalEntries.find((e) => e.description === '取り置き')!;
    expect(entry).toBeDefined();
    expect(entry.metadata?.reserveId).toBeUndefined();
    // 孤児 reserveId が残っていないので export → schema 検証が通る。
    const pkg = buildExportPackage(after);
    expect(ledgerExportPackageSchema.safeParse(pkg).success).toBe(true);
  });
});
