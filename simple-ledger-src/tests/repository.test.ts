import { describe, expect, it } from 'vitest';
import {
  createAdjustment,
  createAllocation,
  createFundingGoal,
  createMonthlyCost,
  createReserve,
  deleteAccount,
  deleteEntry,
  deleteFundingGoal,
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
  upsertSchedule,
  upsertTag,
} from '../src/data/repository';
import { buildSimpleEntry } from '../src/domain/entry';
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
    const food = ledger.accounts.find((a) => a.name === '食費')!;
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
    const food = ledger.accounts.find((a) => a.name === '食費')!;
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
    const food = ledger.accounts.find((a) => a.name === '食費')!;
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
    const food = ledger.accounts.find((a) => a.name === '食費')!;
    await addEntryRef(food.id, cash.id);
    await expect(
      upsertAccount({ ...food, type: 'asset', role: 'daily-asset', updatedAt: 'y' }),
    ).rejects.toThrow();
  });

  it('使用中でも名前変更は許可する', async () => {
    const ledger = await loadLedger();
    const cash = ledger.accounts.find((a) => a.name === '現金')!;
    const food = ledger.accounts.find((a) => a.name === '食費')!;
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
    const food = ledger.accounts.find((a) => a.name === '食費')!;
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
    const food = ledger.accounts.find((a) => a.name === '食費')!;
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
    const food = ledger.accounts.find((a) => a.name === '食費')!;
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

  it('目的別資金の作成で asset 科目と枠ができる', async () => {
    await loadLedger();
    const r = await createReserve({ name: '結婚資金', targetAmount: 700000 });
    const after = await loadLedger();
    expect(after.reserves.some((x) => x.id === r.id)).toBe(true);
    const acc = after.accounts.find((a) => a.id === r.reserveAccountId)!;
    expect(acc.type).toBe('asset');
    expect(acc.name).toBe('結婚資金');
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
      scope: 'both',
      archived: false,
      createdAt: 'x',
      updatedAt: 'x',
    };
  }

  it('未使用のタグは削除でき、使用中は削除できない', async () => {
    const ledger = await loadLedger();
    const cash = ledger.accounts.find((a) => a.name === '現金')!;
    const food = ledger.accounts.find((a) => a.name === '食費')!;
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

  it('明細タグを借方/貸方に付けて保存できる', async () => {
    const ledger = await loadLedger();
    const cash = ledger.accounts.find((a) => a.name === '現金')!;
    const food = ledger.accounts.find((a) => a.name === '食費')!;
    const cardTag = { ...tag(), id: newId(), name: '楽天カード', scope: 'line' as const };
    await upsertTag(cardTag);
    await upsertEntry(
      buildSimpleEntry({
        date: '2026-06-01',
        description: 'カード払い',
        debitAccountId: food.id,
        creditAccountId: cash.id,
        amount: 2000,
        creditTagIds: [cardTag.id],
      }),
    );
    const after = await loadLedger();
    const e = after.journalEntries.find((x) => x.description === 'カード払い')!;
    expect(e.lines.find((l) => l.side === 'credit')?.tagIds).toEqual([cardTag.id]);
  });
});

describe('タグ不変条件（保存時）', () => {
  const mkTag = (over: Partial<Tag> = {}): Tag => ({
    id: newId(),
    name: '旅行',
    scope: 'both',
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

  it('使用中タグの対象(scope)を矛盾する方向へ変更できない', async () => {
    const ledger = await loadLedger();
    const cash = ledger.accounts.find((a) => a.name === '現金')!;
    const food = ledger.accounts.find((a) => a.name === '食費')!;
    const tg = mkTag({ scope: 'both' });
    await upsertTag(tg);
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
    // 全体タグとして使用中 → scope 'line' へは不可
    await expect(upsertTag({ ...tg, scope: 'line', updatedAt: 'y' })).rejects.toThrow();
    // entry を許容する 'entry' への変更は可
    await upsertTag({ ...tg, scope: 'entry', updatedAt: 'y' });
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
    const food = ledger.accounts.find((a) => a.name === '食費')!;
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
  it('サブスクは登録のみ（仕訳・予定CFを作らない）', async () => {
    const ledger = await loadLedger();
    const cash = ledger.accounts.find((a) => a.name === '現金')!;
    const food = ledger.accounts.find((a) => a.name === '食費')!;
    const beforeEntries = ledger.journalEntries.length;
    await createMonthlyCost({
      name: 'Netflix',
      kind: 'subscription',
      amount: 1500,
      costMonths: 1,
      repeatEveryMonths: 1,
      startMonth: '2026-06',
      expenseAccountId: food.id,
      paymentAccountId: cash.id,
    });
    const after = await loadLedger();
    expect(after.monthlyCostItems).toHaveLength(1);
    expect(after.monthlyCostItems[0]).toMatchObject({ name: 'Netflix', amount: 1500 });
    // 仕訳は増えない（登録簿）。
    expect(after.journalEntries.length).toBe(beforeEntries);
    expect(after.cashflowSchedules).toHaveLength(0);
  });

  it('負債払いは購入仕訳（負債計上）と返済予定(CF)を回数分作る', async () => {
    const ledger = await loadLedger();
    const cash = ledger.accounts.find((a) => a.name === '現金')!;
    const card = ledger.accounts.find((a) => a.role === 'payment-liability')!;
    const food = ledger.accounts.find((a) => a.name === '食費')!;
    const beforeEntries = ledger.journalEntries.length;
    await createMonthlyCost({
      name: '洗濯機',
      kind: 'durable-asset',
      amount: 210000,
      costMonths: 84,
      startMonth: '2026-06',
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
    // 合計は総額に一致（端数調整）。
    expect(schedules.reduce((s, x) => s + x.amount, 0)).toBe(210000);
    // 返済は現金から出て、相手は負債（カード）。
    expect(schedules.every((s) => s.accountId === cash.id && s.counterAccountId === card.id)).toBe(
      true,
    );
    // 購入仕訳が 1 件: 借方 按分中資産(deferred) / 貸方 カード(負債)、費用にはしない。
    expect(after.journalEntries.length).toBe(beforeEntries + 1);
    const purchase = after.journalEntries.find((e) => e.metadata?.monthlyCostId !== undefined)!;
    expect(purchase).toBeTruthy();
    const debit = purchase.lines.find((l) => l.side === 'debit')!;
    const credit = purchase.lines.find((l) => l.side === 'credit')!;
    expect(credit.accountId).toBe(card.id);
    expect(credit.amount).toBe(210000);
    const deferred = after.accounts.find((a) => a.id === debit.accountId)!;
    expect(deferred.role).toBe('deferred-asset');
    // 費用カテゴリには計上していない（生活コストは formula 側で見る）。
    expect(after.journalEntries.some((e) => e.lines.some((l) => l.accountId === food.id))).toBe(
      false,
    );
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
        expenseAccountId: cash.id, // asset を費用に → 拒否
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
    const food = ledger.accounts.find((a) => a.name === '食費')!;
    const item = await createMonthlyCost({
      name: '洗濯機',
      kind: 'durable-asset',
      amount: 120000,
      costMonths: 84,
      startMonth: '2026-06',
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
    const food = ledger.accounts.find((a) => a.name === '食費')!;
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
  const mkTag = (over: Partial<Tag> = {}): Tag => ({
    id: newId(),
    name: '楽天カード',
    scope: 'line',
    archived: false,
    createdAt: 'x',
    updatedAt: 'x',
    ...over,
  });

  it('upsertEntry: 存在しないタグ参照は拒否', async () => {
    const ledger = await loadLedger();
    const cash = ledger.accounts.find((a) => a.name === '現金')!;
    const food = ledger.accounts.find((a) => a.name === '食費')!;
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

  it('upsertEntry: scope 不整合（line タグを全体タグ欄）は拒否', async () => {
    const ledger = await loadLedger();
    const cash = ledger.accounts.find((a) => a.name === '現金')!;
    const food = ledger.accounts.find((a) => a.name === '食費')!;
    const lineOnly = mkTag({ scope: 'line' });
    await upsertTag(lineOnly);
    await expect(
      upsertEntry(
        buildSimpleEntry({
          date: '2026-06-01',
          description: 'x',
          debitAccountId: food.id,
          creditAccountId: cash.id,
          amount: 100,
          tagIds: [lineOnly.id], // 全体タグ欄に line スコープは不可
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
    const capital = ledger.accounts.find((a) => a.name === '元入金')!;
    // 資産を増やす: 借方 資産 / 貸方 元入金
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

  it('普通預金 理論10000・実12000 → 借方 普通預金 / 貸方 残高調整収入 2000', async () => {
    const bank = await setBalance('普通預金', 10000);
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
    const capital = ledger.accounts.find((a) => a.name === '元入金')!;
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
