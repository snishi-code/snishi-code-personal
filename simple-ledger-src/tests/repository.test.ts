import { describe, expect, it } from 'vitest';
import {
  createAccountInstrument,
  createAdjustment,
  createAllocation,
  createFundingGoal,
  createManagementScope,
  createMonthlyCost,
  createReserve,
  deleteAccount,
  deleteEntry,
  deleteFundingGoal,
  deleteManagementScope,
  deleteMonthlyCost,
  deleteTag,
  listSnapshots,
  loadLedger,
  makeSnapshotId,
  postSchedule,
  resetAll,
  saveEntryWithFixedAssetMonthly,
  saveSnapshot,
  updateSettings,
  upsertAccount,
  upsertAccountInstrument,
  upsertEntry,
  upsertMonthlyCost,
  upsertSchedule,
  upsertTag,
} from '../src/data/repository';
import { buildSimpleEntry } from '../src/domain/entry';
import { LedgerError } from '../src/domain/errors';
import { DEFAULT_MANAGEMENT_SCOPE_ID } from '../src/domain/constants';
import { monthlyCostForMonth } from '../src/domain/monthlyCost';
import { buildExportPackage } from '../src/data/exportImport';
import { getKv, putKv, runWrite, STORE } from '../src/data/db';
import { SCHEMA_VERSION } from '../src/domain/constants';
import { newId } from '../src/domain/ids';
import type { CashflowSchedule, LedgerMeta, Tag } from '../src/domain/types';

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

  it('使用中でも role 変更は許可する（会計残高は変わらない）', async () => {
    const ledger = await loadLedger();
    const cash = ledger.accounts.find((a) => a.name === '現金')!;
    const food = ledger.accounts.find((a) => a.name === '変動費')!;
    await addEntryRef(food.id, cash.id);
    // 現金(daily-asset) を investment-asset へ（type は asset のまま）
    await upsertAccount({ ...cash, role: 'investment-asset', updatedAt: 'y' });
    const after = await loadLedger();
    expect(after.accounts.find((a) => a.id === cash.id)?.role).toBe('investment-asset');
  });
});

describe('按分支出 createAllocation', () => {
  async function makeAlloc(months = 48, total = 240000) {
    const ledger = await loadLedger();
    const cash = ledger.accounts.find((a) => a.name === '現金')!;
    const food = ledger.accounts.find((a) => a.name === '変動費')!;
    await createAllocation({
      date: '2026-06-15',
      description: 'PC',
      totalAmount: total,
      months,
      expenseAccountId: food.id,
      paymentAccountId: cash.id,
    });
    return loadLedger();
  }

  it('原始仕訳 + 月次認識仕訳 + 按分中資産 + AllocationItem を単一操作で作る', async () => {
    const before = await loadLedger();
    const after = await makeAlloc(48);
    expect(after.allocations).toHaveLength(1);
    expect(after.allocations[0]?.months).toBe(48);
    // 1 source + 48 recognition
    expect(after.journalEntries).toHaveLength(49);
    expect(after.accounts.some((a) => a.name === '按分中資産' && a.type === 'asset')).toBe(true);
    // 単一トランザクションなので revision は 1 回だけ進む
    expect(after.meta.revision).toBe(before.meta.revision + 1);
  });

  it('生成された仕訳は削除も上書きもできない（fail-closed）', async () => {
    const after = await makeAlloc(3, 1000);
    const gen = after.journalEntries.find((e) => e.metadata?.allocationId)!;
    await expect(deleteEntry(gen.id)).rejects.toThrow();
    await expect(upsertEntry({ ...gen, description: '改ざん' })).rejects.toThrow();
  });

  it('按分中資産は 2 回目以降に再利用される', async () => {
    await makeAlloc(2, 1000);
    await makeAlloc(2, 1000);
    const after = await loadLedger();
    expect(after.accounts.filter((a) => a.name === '按分中資産')).toHaveLength(1);
    expect(after.allocations).toHaveLength(2);
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

    // 月額化コストも作っておき、消えることを確認する。
    await createMonthlyCost({
      name: 'Netflix',
      kind: 'subscription',
      amount: 1500,
      costMonths: 1,
      repeatEveryMonths: 1,
      startMonth: '2026-06',
      date: '2026-06-15',
      expenseAccountId: food.id,
      paymentAccountId: cash.id,
    });
    expect((await loadLedger()).monthlyCostItems).toHaveLength(1);
    await createFundingGoal({ name: '車', targetAmount: 1000, targetDate: '2030-01-01' });
    expect((await loadLedger()).fundingGoals).toHaveLength(1);

    await resetAll();
    const after = await loadLedger();
    expect(after.journalEntries).toHaveLength(0);
    expect(after.accounts.length).toBeGreaterThan(0);
    expect(after.meta.revision).toBe(0); // 新しい meta で作り直されている
    expect(await listSnapshots()).toHaveLength(0); // snapshots も消える
    expect(after.monthlyCostItems).toHaveLength(0); // 月額化コストも消える
    expect(after.fundingGoals).toHaveLength(0); // 資金目標も消える
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
      managementScopeId: DEFAULT_MANAGEMENT_SCOPE_ID,
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
      managementScopeId: DEFAULT_MANAGEMENT_SCOPE_ID,
      createdAt: 'x',
      updatedAt: 'x',
    };
    await upsertSchedule(schedule);
    await postSchedule(schedule.id);
    await expect(postSchedule(schedule.id)).rejects.toThrow();
  });

  it('目的別資金の作成で asset 科目と枠ができる', async () => {
    await loadLedger();
    const r = await createReserve({ name: '結婚資金', targetAmount: 700000 });
    const after = await loadLedger();
    expect(after.reserves.some((x) => x.id === r.id)).toBe(true);
    const acc = after.accounts.find((a) => a.id === r.reserveAccountId)!;
    expect(acc.type).toBe('asset');
    expect(acc.name).toBe('結婚資金');
  });

  it('目的別資金に任意の目標額・目標日を持たせられる（資金目標を統合）', async () => {
    await loadLedger();
    const r = await createReserve({
      name: '車買い替え',
      targetAmount: 1500000,
      targetDate: '2030-04-30',
    });
    const after = await loadLedger();
    const saved = after.reserves.find((x) => x.id === r.id)!;
    expect(saved.targetAmount).toBe(1500000);
    expect(saved.targetDate).toBe('2030-04-30');
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
      managementScopeId: DEFAULT_MANAGEMENT_SCOPE_ID,
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

describe('起動時 schemaVersion 追従', () => {
  it('既存DBの古い schemaVersion を現行へ前進させ、revision は変えない', async () => {
    // まず既定データを投入（settings/accounts/meta を作る）。
    const init = await loadLedger();
    // 旧版(v4)の meta へ書き換える（既存ユーザの IndexedDB を模す）。
    const oldMeta: LedgerMeta = { ...init.meta, schemaVersion: 4, revision: 7 };
    await putKv('meta', oldMeta);

    // 次回起動で現行版へ追従する（恒等移行のため revision は不変）。
    const ledger = await loadLedger();
    expect(ledger.meta.schemaVersion).toBe(SCHEMA_VERSION);
    expect(ledger.meta.revision).toBe(7);

    const persisted = await getKv<LedgerMeta>('meta');
    expect(persisted?.schemaVersion).toBe(SCHEMA_VERSION);
    expect(persisted?.revision).toBe(7);
  });

  it('v6→v7 追従で既存按分から月額化コストを補完する（revision 不変）', async () => {
    const ledger = await loadLedger();
    const cash = ledger.accounts.find((a) => a.name === '現金')!;
    const food = ledger.accounts.find((a) => a.name === '変動費')!;
    await createAllocation({
      date: '2026-06-15',
      description: 'PC',
      totalAmount: 900,
      months: 3,
      expenseAccountId: food.id,
      paymentAccountId: cash.id,
    });
    const before = await loadLedger();
    // 旧版(v6)へ巻き戻し、月額化コストは未生成の状態を模す。
    await putKv('meta', { ...before.meta, schemaVersion: 6 });
    await runWrite([STORE.monthlyCostItems], (t) => t.objectStore(STORE.monthlyCostItems).clear());

    const after = await loadLedger();
    expect(after.meta.schemaVersion).toBe(SCHEMA_VERSION);
    expect(after.meta.revision).toBe(before.meta.revision); // 追従は revision を変えない
    expect(after.monthlyCostItems).toHaveLength(1);
    expect(after.monthlyCostItems[0]).toMatchObject({ name: 'PC', amount: 900, costMonths: 3 });
  });
});

describe('月額化コスト createMonthlyCost', () => {
  it('日常資産払いは支払い仕訳（借方 費用 / 貸方 資産）を登録日に作る', async () => {
    const ledger = await loadLedger();
    const cash = ledger.accounts.find((a) => a.name === '現金')!;
    const food = ledger.accounts.find((a) => a.name === '変動費')!;
    const beforeEntries = ledger.journalEntries.length;
    const item = await createMonthlyCost({
      name: 'Netflix',
      kind: 'subscription',
      amount: 1500,
      costMonths: 1,
      repeatEveryMonths: 1,
      startMonth: '2026-06',
      date: '2026-06-15',
      expenseAccountId: food.id,
      paymentAccountId: cash.id,
    });
    const after = await loadLedger();
    expect(after.monthlyCostItems).toHaveLength(1);
    // 支払い事実が仕訳に出る: 借方 変動費 / 貸方 現金、登録日、monthlyCostId 付き。
    expect(after.journalEntries.length).toBe(beforeEntries + 1);
    const pay = after.journalEntries.find((e) => e.metadata?.monthlyCostId === item.id)!;
    expect(pay.date).toBe('2026-06-15');
    expect(pay.lines.find((l) => l.side === 'debit')?.accountId).toBe(food.id);
    expect(pay.lines.find((l) => l.side === 'credit')?.accountId).toBe(cash.id);
    expect(after.cashflowSchedules).toHaveLength(0);
  });

  it('負債払いは支払い仕訳（借方 費用 / 貸方 負債）を登録日に作り、返済CFは初回引落日から', async () => {
    const ledger = await loadLedger();
    const cash = ledger.accounts.find((a) => a.name === '現金')!;
    const card = ledger.accounts.find((a) => a.role === 'payment-liability')!;
    const food = ledger.accounts.find((a) => a.name === '変動費')!;
    const beforeEntries = ledger.journalEntries.length;
    const item = await createMonthlyCost({
      name: '洗濯機',
      kind: 'durable-asset',
      amount: 210000,
      costMonths: 84,
      startMonth: '2026-06',
      date: '2026-06-15',
      expenseAccountId: food.id,
      paymentAccountId: card.id,
      repaymentAccountId: cash.id,
      repaymentCount: 12,
      repaymentStartDate: '2026-07-27',
    });
    const after = await loadLedger();
    expect(after.monthlyCostItems).toHaveLength(1);
    const schedules = after.cashflowSchedules;
    expect(schedules).toHaveLength(12);
    expect(schedules.reduce((s, x) => s + x.amount, 0)).toBe(210000);
    // 返済は現金から出て相手は負債、初回引落日（購入日と別）から始まる。
    expect(schedules.every((s) => s.accountId === cash.id && s.counterAccountId === card.id)).toBe(
      true,
    );
    expect(schedules.some((s) => s.dueDate === '2026-07-27')).toBe(true);
    // 支払い仕訳: 借方 変動費(費用) / 貸方 カード(負債)、登録日に負債が立つ。
    expect(after.journalEntries.length).toBe(beforeEntries + 1);
    const pay = after.journalEntries.find((e) => e.metadata?.monthlyCostId === item.id)!;
    expect(pay.date).toBe('2026-06-15');
    expect(pay.lines.find((l) => l.side === 'debit')?.accountId).toBe(food.id);
    expect(pay.lines.find((l) => l.side === 'credit')?.accountId).toBe(card.id);
  });

  it('費用カテゴリでない科目を費用に指定すると拒否', async () => {
    const ledger = await loadLedger();
    const cash = ledger.accounts.find((a) => a.name === '現金')!;
    await expect(
      createMonthlyCost({
        name: 'x',
        kind: 'subscription',
        amount: 100,
        costMonths: 1,
        startMonth: '2026-06',
        date: '2026-06-15',
        expenseAccountId: cash.id, // asset を費用に → 拒否
        paymentAccountId: cash.id,
      }),
    ).rejects.toThrow();
  });
});

describe('資金目標 createFundingGoal', () => {
  it('目標を作成できる', async () => {
    await loadLedger();
    const g = await createFundingGoal({
      name: '車',
      targetAmount: 3000000,
      targetDate: '2031-06-30',
      currentAmount: 500000,
    });
    const after = await loadLedger();
    expect(after.fundingGoals).toHaveLength(1);
    expect(after.fundingGoals[0]).toMatchObject({
      name: '車',
      targetAmount: 3000000,
      status: 'active',
    });
    await deleteFundingGoal(g.id);
    expect((await loadLedger()).fundingGoals).toHaveLength(0);
  });

  it('積立元が日常資産/目的別資金でないと拒否', async () => {
    const ledger = await loadLedger();
    const card = ledger.accounts.find((a) => a.role === 'payment-liability')!;
    await expect(
      createFundingGoal({
        name: 'x',
        targetAmount: 1000,
        targetDate: '2030-01-01',
        sourceAccountId: card.id, // 負債は不可
      }),
    ).rejects.toThrow();
  });
});

describe('月額化コストの整合性（生成仕訳・削除）', () => {
  async function makeLiabilityMonthlyCost() {
    const ledger = await loadLedger();
    const cash = ledger.accounts.find((a) => a.name === '現金')!;
    const card = ledger.accounts.find((a) => a.role === 'payment-liability')!;
    const food = ledger.accounts.find((a) => a.name === '変動費')!;
    const item = await createMonthlyCost({
      name: '洗濯機',
      kind: 'durable-asset',
      amount: 120000,
      costMonths: 84,
      startMonth: '2026-06',
      date: '2026-06-15',
      expenseAccountId: food.id,
      paymentAccountId: card.id,
      repaymentAccountId: cash.id,
      repaymentCount: 12,
      repaymentStartDate: '2026-07-27',
    });
    return { item, cash, card, food };
  }

  it('monthlyCostId 付き購入仕訳は編集・削除できない（fail-closed）', async () => {
    await makeLiabilityMonthlyCost();
    const after = await loadLedger();
    const purchase = after.journalEntries.find((e) => e.metadata?.monthlyCostId)!;
    await expect(deleteEntry(purchase.id)).rejects.toThrow();
    await expect(upsertEntry({ ...purchase, description: '改ざん' })).rejects.toThrow();
  });

  it('ユーザー入力に monthlyCostId が付いた仕訳は保存できない', async () => {
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

  it('未実績なら削除で購入仕訳・返済CFも一括で消える（孤立を残さない）', async () => {
    const { item } = await makeLiabilityMonthlyCost();
    await deleteMonthlyCost(item.id);
    const after = await loadLedger();
    expect(after.monthlyCostItems.some((m) => m.id === item.id)).toBe(false);
    expect(after.journalEntries.some((e) => e.metadata?.monthlyCostId === item.id)).toBe(false);
    expect(after.cashflowSchedules.some((s) => s.monthlyCostId === item.id)).toBe(false);
  });

  it('返済が実績化済みなら削除できない（終了を使う）', async () => {
    const { item } = await makeLiabilityMonthlyCost();
    const before = await loadLedger();
    const sched = before.cashflowSchedules.find((s) => s.monthlyCostId === item.id)!;
    await postSchedule(sched.id);
    await expect(deleteMonthlyCost(item.id)).rejects.toThrow();
    // 本体・購入仕訳は残っている。
    const after = await loadLedger();
    expect(after.monthlyCostItems.some((m) => m.id === item.id)).toBe(true);
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
      managementScopeId: DEFAULT_MANAGEMENT_SCOPE_ID,
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
    const capital = ledger.accounts.find((a) => a.name === '開始残高')!;
    // 資産を増やす: 借方 資産 / 貸方 開始残高
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
      kind: 'unknown-balance',
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
      kind: 'unknown-balance',
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

  it('投資評価は投資評価損/益で処理する', async () => {
    const ledger = await loadLedger();
    const capital = ledger.accounts.find((a) => a.name === '開始残高')!;
    // 投資資産を作る
    await upsertAccount({
      id: 'inv',
      name: '投資',
      type: 'asset',
      role: 'investment-asset',
      archived: false,
      createdAt: 'x',
      updatedAt: 'x',
    });
    await upsertEntry(
      buildSimpleEntry({
        date: '2026-06-01',
        description: '投資',
        debitAccountId: 'inv',
        creditAccountId: capital.id,
        amount: 100000,
      }),
    );
    const entry = await createAdjustment({
      kind: 'investment-valuation',
      accountId: 'inv',
      date: '2026-06-30',
      actualBalance: 90000,
    });
    const after = await loadLedger();
    const loss = after.accounts.find((a) => a.name === '投資評価損' && a.type === 'expense')!;
    expect(loss).toBeTruthy();
    expect(entry!.lines.find((l) => l.side === 'debit')?.accountId).toBe(loss.id);
    expect(entry!.metadata?.adjustment?.kind).toBe('investment-valuation');
  });

  it('差額が無ければ仕訳を作らず null', async () => {
    const cash = await setBalance('現金', 5000);
    const entry = await createAdjustment({
      kind: 'unknown-balance',
      accountId: cash.id,
      date: '2026-06-30',
      actualBalance: 5000,
    });
    expect(entry).toBeNull();
  });

  it('過去日付の補正もできる', async () => {
    const cash = await setBalance('現金', 10000);
    const entry = await createAdjustment({
      kind: 'unknown-balance',
      accountId: cash.id,
      date: '2026-06-15',
      actualBalance: 9000,
    });
    expect(entry?.date).toBe('2026-06-15');
  });
});

describe('固定資産購入 + 月額化（saveEntryWithFixedAssetMonthly）', () => {
  it('購入仕訳のみ保存・支払い仕訳は作らない / 月額化は formula で認識', async () => {
    const ledger = await loadLedger();
    const cash = ledger.accounts.find((a) => a.name === '現金')!;
    const carId = newId();
    const catId = newId();
    await upsertAccount({
      id: carId,
      name: '自動車',
      type: 'asset',
      role: 'fixed-asset',
      archived: false,
      createdAt: 'x',
      updatedAt: 'x',
    });
    await upsertAccount({
      id: catId,
      name: '交通費',
      type: 'expense',
      role: 'expense-category',
      archived: false,
      createdAt: 'x',
      updatedAt: 'x',
    });
    const before = (await loadLedger()).journalEntries.length;
    // 借方 自動車(固定資産) / 貸方 現金 で 3,000,000 を購入。
    const entry = buildSimpleEntry({
      date: '2031-07-15',
      description: '自動車購入',
      debitAccountId: carId,
      creditAccountId: cash.id,
      amount: 3_000_000,
      metadata: { inputMode: 'expense' },
    });
    const item = await saveEntryWithFixedAssetMonthly(entry, {
      name: '自動車',
      kind: 'durable-asset',
      amount: 3_000_000,
      costMonths: 120,
      startMonth: '2031-07',
      expenseAccountId: catId,
      recognitionCreditAccountId: carId,
    });

    const after = await loadLedger();
    // 購入仕訳 1 件だけ増える（支払い仕訳は作らない）。
    expect(after.journalEntries.length).toBe(before + 1);
    expect(after.journalEntries.filter((e) => e.metadata?.monthlyCostId)).toHaveLength(0);
    // 月額化コストが 1 件でき、固定資産・購入仕訳に紐づく。
    const saved = after.monthlyCostItems.find((m) => m.id === item.id)!;
    expect(saved.recognitionCreditAccountId).toBe(carId);
    expect(saved.sourceEntryId).toBe(entry.id);
    expect(saved.paymentAccountId).toBeUndefined();
    // 300万 / 120ヶ月 → 対象月 25,000 / 購入前月は 0。
    expect(monthlyCostForMonth(saved, '2031-07')).toBe(25000);
    expect(monthlyCostForMonth(saved, '2031-06')).toBe(0);
  });

  it('負債払い + 返済情報があれば、購入仕訳の貸方負債を取り崩す返済予定 CF を作る', async () => {
    const ledger = await loadLedger();
    const cash = ledger.accounts.find((a) => a.name === '現金')!;
    const card = ledger.accounts.find((a) => a.role === 'payment-liability')!;
    const carId = newId();
    const catId = newId();
    await upsertAccount({
      id: carId,
      name: '自動車2',
      type: 'asset',
      role: 'fixed-asset',
      archived: false,
      createdAt: 'x',
      updatedAt: 'x',
    });
    await upsertAccount({
      id: catId,
      name: '交通費2',
      type: 'expense',
      role: 'expense-category',
      archived: false,
      createdAt: 'x',
      updatedAt: 'x',
    });
    // 借方 自動車(固定資産) / 貸方 カード負債 で 1,200,000 を購入し、12回返済を登録。
    const entry = buildSimpleEntry({
      date: '2031-07-15',
      description: '自動車ローン購入',
      debitAccountId: carId,
      creditAccountId: card.id,
      amount: 1_200_000,
      metadata: { inputMode: 'expense' },
    });
    const item = await saveEntryWithFixedAssetMonthly(entry, {
      name: '自動車2',
      kind: 'durable-asset',
      amount: 1_200_000,
      costMonths: 120,
      startMonth: '2031-07',
      expenseAccountId: catId,
      recognitionCreditAccountId: carId,
      repaymentAccountId: cash.id,
      repaymentCount: 12,
      repaymentStartDate: '2031-08-10',
    });

    const after = await loadLedger();
    const schedules = after.cashflowSchedules.filter((s) => s.monthlyCostId === item.id);
    expect(schedules).toHaveLength(12);
    // 返済合計は元本に一致（元本のみ・利息は含めない）。
    expect(schedules.reduce((s, x) => s + x.amount, 0)).toBe(1_200_000);
    // 返済元=現金（daily-asset）→ 返済先=カード負債（購入仕訳の貸方）。
    expect(schedules.every((s) => s.accountId === cash.id && s.counterAccountId === card.id)).toBe(
      true,
    );
    expect(schedules.every((s) => s.direction === 'outflow' && s.status === 'planned')).toBe(true);
    expect(schedules[0]?.dueDate).toBe('2031-08-10');
    expect(schedules[1]?.dueDate).toBe('2031-09-10');
  });
});

describe('目的別資金(reserve-asset)の残高不足ガード', () => {
  it('残高内は成功・超過は保存拒否', async () => {
    const ledger = await loadLedger();
    const capital = ledger.accounts.find((a) => a.name === '開始残高')!;
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
    // 100,000 を積み立てる（借方 資金 / 貸方 開始残高）。
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
      managementScopeId: DEFAULT_MANAGEMENT_SCOPE_ID,
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
      managementScopeId: DEFAULT_MANAGEMENT_SCOPE_ID,
      createdAt: 'x',
      updatedAt: 'x',
    };
    const e = await caught(upsertSchedule(schedule));
    expect(e).toBeInstanceOf(LedgerError);
    expect(e.code).toBe('error.schedule.invalidStructure');
  });

  it('createReserve は目的別資金でない既存科目（日常資産）を紐づけない', async () => {
    const ledger = await loadLedger();
    const cash = ledger.accounts.find((a) => a.name === '現金')!; // daily-asset
    const e = await caught(createReserve({ name: '誤接続', existingAccountId: cash.id }));
    expect(e).toBeInstanceOf(LedgerError);
    expect(e.code).toBe('error.reserve.existingAccountInvalid');
  });

  it('createReserve は reserve-asset の既存科目なら紐づけられる', async () => {
    await loadLedger();
    const resId = newId();
    await upsertAccount({
      id: resId,
      name: '既存の取り置き科目',
      type: 'asset',
      role: 'reserve-asset',
      archived: false,
      createdAt: 'x',
      updatedAt: 'x',
    });
    const reserve = await createReserve({ name: '旅行資金', existingAccountId: resId });
    expect(reserve.reserveAccountId).toBe(resId);
  });

  it('createMonthlyCost は startMonth が YYYY-MM でないと保存しない', async () => {
    const ledger = await loadLedger();
    const cash = ledger.accounts.find((a) => a.name === '現金')!;
    const food = ledger.accounts.find((a) => a.name === '変動費')!;
    const e = await caught(
      createMonthlyCost({
        name: 'サブスク',
        kind: 'subscription',
        amount: 1000,
        costMonths: 1,
        startMonth: '2026/06', // 不正な形式
        date: '2026-06-01',
        expenseAccountId: food.id,
        paymentAccountId: cash.id,
      }),
    );
    expect(e).toBeInstanceOf(LedgerError);
    expect(e.code).toBe('error.monthlyCost.startMonthInvalid');
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

  it('createAllocation は費用カテゴリでない科目を按分先にできない（生成仕訳も保存境界を通す）', async () => {
    const ledger = await loadLedger();
    const cash = ledger.accounts.find((a) => a.name === '現金')!; // daily-asset
    const e = await caught(
      createAllocation({
        date: '2026-06-15',
        description: '不正按分',
        totalAmount: 12000,
        months: 12,
        expenseAccountId: cash.id, // 費用カテゴリでない
        paymentAccountId: cash.id,
      }),
    );
    expect(e).toBeInstanceOf(LedgerError);
    expect(e.code).toBe('error.allocation.expenseCategory');
  });
});

describe('管理区分・支払い手段の保存境界', () => {
  /** 例外を捕捉して LedgerError として返す（throw しなければ失敗）。 */
  async function caught(p: Promise<unknown>): Promise<LedgerError> {
    try {
      await p;
    } catch (e) {
      return e as LedgerError;
    }
    throw new Error('例外が送出されませんでした');
  }

  it('既定の管理区分は削除できない（最後の 1 つでなくても拒否）', async () => {
    await loadLedger();
    // 2 つ目を足しても、既定区分そのものは削除不可。
    await createManagementScope('事業用');
    const e = await caught(deleteManagementScope(DEFAULT_MANAGEMENT_SCOPE_ID));
    expect(e).toBeInstanceOf(LedgerError);
    expect(e.code).toBe('error.scope.deleteDefault');
  });

  it('既定でない未使用の管理区分は削除できる', async () => {
    await loadLedger();
    const scope = await createManagementScope('事業用');
    await deleteManagementScope(scope.id);
    const ledger = await loadLedger();
    expect(ledger.managementScopes.some((s) => s.id === scope.id)).toBe(false);
  });

  it('createAccountInstrument は資金口座（daily-asset）を親にできる', async () => {
    const ledger = await loadLedger();
    const cash = ledger.accounts.find((a) => a.name === '現金')!; // daily-asset
    const inst = await createAccountInstrument({
      managementScopeId: DEFAULT_MANAGEMENT_SCOPE_ID,
      accountId: cash.id,
      name: '楽天銀行',
      kind: 'bank',
    });
    expect(inst.accountId).toBe(cash.id);
  });

  it('createAccountInstrument はクレジットカード（payment-liability）を親にできる', async () => {
    const ledger = await loadLedger();
    const card = ledger.accounts.find((a) => a.name === 'クレジットカード')!; // payment-liability
    const inst = await createAccountInstrument({
      managementScopeId: DEFAULT_MANAGEMENT_SCOPE_ID,
      accountId: card.id,
      name: '楽天カード',
      kind: 'card',
    });
    expect(inst.accountId).toBe(card.id);
  });

  it('createAccountInstrument は資金口座/カード以外（投資資産）を親にできない', async () => {
    const ledger = await loadLedger();
    const inv = ledger.accounts.find((a) => a.name === '投資')!; // investment-asset
    const e = await caught(
      createAccountInstrument({
        managementScopeId: DEFAULT_MANAGEMENT_SCOPE_ID,
        accountId: inv.id,
        name: '証券口座',
        kind: 'other',
      }),
    );
    expect(e).toBeInstanceOf(LedgerError);
    expect(e.code).toBe('error.instrument.accountRole');
  });

  it('使用中の支払い手段は親科目を変更できない（名称変更は可）', async () => {
    const ledger = await loadLedger();
    const cash = ledger.accounts.find((a) => a.name === '現金')!;
    const bank = ledger.accounts.find((a) => a.name === '預金')!;
    const food = ledger.accounts.find((a) => a.name === '変動費')!;
    const inst = await createAccountInstrument({
      managementScopeId: DEFAULT_MANAGEMENT_SCOPE_ID,
      accountId: cash.id,
      name: 'Suica',
      kind: 'prepaid',
    });
    // この細目を参照する仕訳を作る → 使用中になる。
    await upsertEntry(
      buildSimpleEntry({
        date: '2026-06-01',
        description: 'コンビニ',
        debitAccountId: food.id,
        creditAccountId: cash.id,
        creditInstrumentId: inst.id,
        amount: 500,
      }),
    );
    // 親科目の変更は拒否。
    const e = await caught(upsertAccountInstrument({ ...inst, accountId: bank.id }));
    expect(e).toBeInstanceOf(LedgerError);
    expect(e.code).toBe('error.instrument.lockedInUse');
    // 名称（親科目・管理区分は据え置き）の変更は許可。
    await upsertAccountInstrument({ ...inst, name: 'Suica（メイン）' });
    const after = await loadLedger();
    expect(after.accountInstruments.find((i) => i.id === inst.id)?.name).toBe('Suica（メイン）');
  });

  it('未使用の支払い手段は親科目を変更できる', async () => {
    const ledger = await loadLedger();
    const cash = ledger.accounts.find((a) => a.name === '現金')!;
    const bank = ledger.accounts.find((a) => a.name === '預金')!;
    const inst = await createAccountInstrument({
      managementScopeId: DEFAULT_MANAGEMENT_SCOPE_ID,
      accountId: cash.id,
      name: '付け替え予定',
      kind: 'other',
    });
    await upsertAccountInstrument({ ...inst, accountId: bank.id });
    const after = await loadLedger();
    expect(after.accountInstruments.find((i) => i.id === inst.id)?.accountId).toBe(bank.id);
  });

  it('通常の月額化コストは選択中の管理区分を本体と生成支払い仕訳に引き継ぐ', async () => {
    const ledger = await loadLedger();
    const cash = ledger.accounts.find((a) => a.name === '現金')!;
    const food = ledger.accounts.find((a) => a.name === '変動費')!;
    const biz = await createManagementScope('事業用'); // 既定でない区分
    const item = await createMonthlyCost({
      name: 'クラウドサブスク',
      managementScopeId: biz.id,
      kind: 'subscription',
      amount: 1200,
      costMonths: 1,
      startMonth: '2026-06',
      date: '2026-06-01',
      expenseAccountId: food.id,
      paymentAccountId: cash.id,
    });
    expect(item.managementScopeId).toBe(biz.id);
    // 生成された支払い仕訳（metadata.monthlyCostId 紐づけ）も同じ区分であること。
    const after = await loadLedger();
    const payEntry = after.journalEntries.find((e) => e.metadata?.monthlyCostId === item.id);
    expect(payEntry).toBeDefined();
    expect(payEntry?.managementScopeId).toBe(biz.id);
  });
});

describe('月額化コストの後編集（upsertMonthlyCost 保存境界）', () => {
  async function caught(p: Promise<unknown>): Promise<LedgerError> {
    try {
      await p;
    } catch (e) {
      return e as LedgerError;
    }
    throw new Error('例外が送出されませんでした');
  }

  /** 日常資産払いの月額化コストを作る（返済 CF なし・生成支払い仕訳あり）。 */
  async function makeDailyMonthlyCost(amount = 1500) {
    const ledger = await loadLedger();
    const cash = ledger.accounts.find((a) => a.name === '現金')!;
    const food = ledger.accounts.find((a) => a.name === '変動費')!;
    const item = await createMonthlyCost({
      name: 'Netflix',
      kind: 'subscription',
      amount,
      costMonths: 1,
      repeatEveryMonths: 1,
      startMonth: '2026-06',
      date: '2026-06-15',
      expenseAccountId: food.id,
      paymentAccountId: cash.id,
    });
    return { item, cash, food, ledger };
  }

  async function makeLiabilityMonthlyCost(amount = 120000) {
    const ledger = await loadLedger();
    const cash = ledger.accounts.find((a) => a.name === '現金')!;
    const card = ledger.accounts.find((a) => a.role === 'payment-liability')!;
    const food = ledger.accounts.find((a) => a.name === '変動費')!;
    const item = await createMonthlyCost({
      name: '洗濯機',
      kind: 'durable-asset',
      amount,
      costMonths: 84,
      startMonth: '2026-06',
      date: '2026-06-15',
      expenseAccountId: food.id,
      paymentAccountId: card.id,
      repaymentAccountId: cash.id,
      repaymentCount: 12,
      repaymentStartDate: '2026-07-27',
    });
    return { item, cash, card, food };
  }

  it('名称・期間の編集が保存され、月割り formula に反映される（支払い仕訳は不変）', async () => {
    const { item } = await makeDailyMonthlyCost();
    const before = await loadLedger();
    const payBefore = before.journalEntries.find((e) => e.metadata?.monthlyCostId === item.id)!;
    // costMonths を 3 にするときは repeatEveryMonths も整合（>= costMonths）させる。
    await upsertMonthlyCost({ ...item, name: 'Netflix(改)', costMonths: 3, repeatEveryMonths: 3 });
    const after = await loadLedger();
    const saved = after.monthlyCostItems.find((m) => m.id === item.id)!;
    expect(saved.name).toBe('Netflix(改)');
    expect(saved.costMonths).toBe(3);
    // 月割り（1500 を 3 か月）= 500。
    expect(monthlyCostForMonth(saved, '2026-06')).toBe(500);
    // 支払い仕訳は金額・費用カテゴリ未変更なので不変。
    const payAfter = after.journalEntries.find((e) => e.metadata?.monthlyCostId === item.id)!;
    expect(payAfter.lines).toEqual(payBefore.lines);
  });

  it('総額の編集（日常払い・返済CFなし）は生成支払い仕訳の借方/貸方金額を更新する', async () => {
    const { item } = await makeDailyMonthlyCost(1500);
    await upsertMonthlyCost({ ...item, amount: 2000 });
    const after = await loadLedger();
    const pay = after.journalEntries.find((e) => e.metadata?.monthlyCostId === item.id)!;
    expect(pay.lines.every((l) => l.amount === 2000)).toBe(true);
    expect(after.monthlyCostItems.find((m) => m.id === item.id)?.amount).toBe(2000);
  });

  it('総額の編集（未実績の返済CFあり）は返済CFを再配分し合計を新総額に合わせる', async () => {
    const { item } = await makeLiabilityMonthlyCost(120000);
    await upsertMonthlyCost({ ...item, amount: 240000 });
    const after = await loadLedger();
    const schedules = after.cashflowSchedules.filter((s) => s.monthlyCostId === item.id);
    expect(schedules).toHaveLength(12);
    expect(schedules.reduce((s, x) => s + x.amount, 0)).toBe(240000);
    const pay = after.journalEntries.find((e) => e.metadata?.monthlyCostId === item.id)!;
    expect(pay.lines.every((l) => l.amount === 240000)).toBe(true);
  });

  it('返済CFが1件でも実績化済みなら総額を変更できない', async () => {
    const { item } = await makeLiabilityMonthlyCost(120000);
    const before = await loadLedger();
    const sched = before.cashflowSchedules.find((s) => s.monthlyCostId === item.id)!;
    await postSchedule(sched.id);
    const e = await caught(upsertMonthlyCost({ ...item, amount: 240000 }));
    expect(e).toBeInstanceOf(LedgerError);
    expect(e.code).toBe('error.monthlyCost.editAmountPosted');
  });

  it('固定資産由来（sourceEntryId）の月額化は総額を変更できない', async () => {
    const ledger = await loadLedger();
    const cash = ledger.accounts.find((a) => a.name === '現金')!;
    const food = ledger.accounts.find((a) => a.name === '変動費')!;
    const faId = newId();
    await upsertAccount({
      id: faId,
      name: '車',
      type: 'asset',
      role: 'fixed-asset',
      archived: false,
      createdAt: 'x',
      updatedAt: 'x',
    });
    const entry = buildSimpleEntry({
      date: '2026-06-01',
      description: '車購入',
      debitAccountId: faId,
      creditAccountId: cash.id,
      amount: 1000000,
    });
    const item = await saveEntryWithFixedAssetMonthly(entry, {
      name: '車の月額化',
      kind: 'durable-asset',
      amount: 1000000,
      costMonths: 60,
      startMonth: '2026-06',
      expenseAccountId: food.id,
      recognitionCreditAccountId: faId,
    });
    const e = await caught(upsertMonthlyCost({ ...item, amount: 2000000 }));
    expect(e).toBeInstanceOf(LedgerError);
    expect(e.code).toBe('error.monthlyCost.editAmountLinked');
  });

  it('費用カテゴリの編集は生成支払い仕訳の借方科目も更新する', async () => {
    const { item } = await makeDailyMonthlyCost();
    const ledger = await loadLedger();
    const fixed = ledger.accounts.find((a) => a.name === '固定費')!; // 別の expense-category
    await upsertMonthlyCost({ ...item, expenseAccountId: fixed.id });
    const after = await loadLedger();
    const pay = after.journalEntries.find((e) => e.metadata?.monthlyCostId === item.id)!;
    expect(pay.lines.find((l) => l.side === 'debit')?.accountId).toBe(fixed.id);
    expect(after.monthlyCostItems.find((m) => m.id === item.id)?.expenseAccountId).toBe(fixed.id);
  });

  it('費用カテゴリでない科目には変更できない', async () => {
    const { item, cash } = await makeDailyMonthlyCost();
    const e = await caught(upsertMonthlyCost({ ...item, expenseAccountId: cash.id }));
    expect(e).toBeInstanceOf(LedgerError);
    expect(e.code).toBe('error.monthlyCost.expenseCategory');
  });

  it('costMonths<1 は保存しない / endMonth<startMonth は保存しない / 存在しない item は notFound', async () => {
    const { item } = await makeDailyMonthlyCost();
    const e1 = await caught(upsertMonthlyCost({ ...item, costMonths: 0 }));
    expect(e1.code).toBe('error.monthlyCost.invalidStructure');
    const e2 = await caught(
      upsertMonthlyCost({ ...item, startMonth: '2026-06', endMonth: '2026-05' }),
    );
    expect(e2.code).toBe('error.monthlyCost.endBeforeStart');
    const e3 = await caught(upsertMonthlyCost({ ...item, id: 'no-such-id' }));
    expect(e3.code).toBe('error.monthlyCost.notFound');
  });

  it('状態変更（一時停止）は連鎖なしで保存でき、支払い仕訳は不変', async () => {
    const { item } = await makeDailyMonthlyCost();
    const before = await loadLedger();
    const payBefore = before.journalEntries.find((e) => e.metadata?.monthlyCostId === item.id)!;
    await upsertMonthlyCost({ ...item, status: 'paused' });
    const after = await loadLedger();
    expect(after.monthlyCostItems.find((m) => m.id === item.id)?.status).toBe('paused');
    const payAfter = after.journalEntries.find((e) => e.metadata?.monthlyCostId === item.id)!;
    expect(payAfter.lines).toEqual(payBefore.lines);
  });
});
