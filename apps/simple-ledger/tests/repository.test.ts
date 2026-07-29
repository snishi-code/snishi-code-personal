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
  createContinuousCost,
  createContinuousCostFromOpening,
  createAllocation,
  createMonthlyCost,
  createRepaymentEntries,
  createReserve,
  createSubscriptionMigration,
  deleteAccount,
  deleteEntry,
  createFixedAssetPurchaseMonthly,
  deleteMonthlyCost,
  deleteTag,
  disposeContinuousCost,
  disposeFixedAsset,
  listSnapshots,
  loadLedger,
  makeSnapshotId,
  postSchedule,
  resetAll,
  saveEntryWithFixedAssetMonthly,
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
import { monthlyCostForMonth } from '../src/domain/monthlyCost';
import { accountBalance } from '../src/domain/accounting';
import { reportEntriesForAsOf } from '../src/domain/reportEntries';
import { buildExportPackage, exportToJsonText, importFromJsonText } from '../src/data/exportImport';
import { ledgerExportPackageSchema } from '../src/domain/schema';
import { getKv, putKv, STORE } from '../src/data/db';
import { SCHEMA_VERSION } from '../src/domain/constants';
import { newId } from '../src/domain/ids';
import { todayLocal } from '../src/util/time';
import type { CashflowSchedule, JournalEntry, LedgerMeta, Tag } from '../src/domain/types';

/** 「今日」基準の導出仕訳（旧 Ledger.derivedEntries 相当。集計は reportEntriesForAsOf が単一正本）。 */
function derivedOf(ledger: Awaited<ReturnType<typeof loadLedger>>): JournalEntry[] {
  return reportEntriesForAsOf(ledger, todayLocal());
}

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

describe('起動時 schemaVersion（v2: レガシー migration なし）', () => {
  it('既存DBは再読み込みでも schemaVersion=1 のまま・revision を変えない', async () => {
    // まず既定データを投入（settings/accounts/meta を作る）。
    const init = await loadLedger();
    expect(init.meta.schemaVersion).toBe(SCHEMA_VERSION);
    // 編集追跡が進んだ既存 DB を模す（v2 に旧版ローカル DB は存在しない・仕様§16）。
    const meta: LedgerMeta = { ...init.meta, revision: 7 };
    await putKv('meta', meta);

    // 再起動相当の loadLedger でも追従処理は走らず、版・revision は不変。
    const ledger = await loadLedger();
    expect(ledger.meta.schemaVersion).toBe(SCHEMA_VERSION);
    expect(ledger.meta.revision).toBe(7);

    const persisted = await getKv<LedgerMeta>('meta');
    expect(persisted?.schemaVersion).toBe(SCHEMA_VERSION);
    expect(persisted?.revision).toBe(7);
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

  it('負債払いは支払い仕訳（借方 費用 / 貸方 負債）を登録日に作り、返済実仕訳は初回引落日から', async () => {
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
    // 予定 CF は作らない。返済は未来日付の振替実仕訳 12 本（同一トランザクション）。
    expect(after.cashflowSchedules).toHaveLength(0);
    const repays = after.journalEntries
      .filter((e) => e.description.startsWith('洗濯機 返済'))
      .sort((a, b) => a.date.localeCompare(b.date));
    expect(repays).toHaveLength(12);
    expect(
      repays.reduce((s, e) => s + (e.lines.find((l) => l.side === 'debit')?.amount ?? 0), 0),
    ).toBe(210000);
    // 返済は 借方 カード(負債) / 貸方 現金、初回引落日（購入日と別）から毎月同日。
    expect(
      repays.every(
        (e) =>
          e.lines.find((l) => l.side === 'debit')?.accountId === card.id &&
          e.lines.find((l) => l.side === 'credit')?.accountId === cash.id,
      ),
    ).toBe(true);
    expect(repays[0]?.date).toBe('2026-07-27');
    expect(repays[1]?.date).toBe('2026-08-27');
    expect(repays[11]?.date).toBe('2027-06-27');
    expect(repays[0]?.description).toBe('洗濯機 返済 1/12');
    expect(repays.every((e) => e.metadata?.inputMode === 'transfer')).toBe(true);
    // 返済仕訳は実予定＝monthlyCostId を持たず、ユーザーが編集/削除できる。
    expect(repays.every((e) => e.metadata?.monthlyCostId === undefined)).toBe(true);
    // 支払い仕訳: 借方 変動費(費用) / 貸方 カード(負債)、登録日に負債が立つ。
    expect(after.journalEntries.length).toBe(beforeEntries + 1 + 12);
    const pay = after.journalEntries.find((e) => e.metadata?.monthlyCostId === item.id)!;
    expect(pay.date).toBe('2026-06-15');
    expect(pay.lines.find((l) => l.side === 'debit')?.accountId).toBe(food.id);
    expect(pay.lines.find((l) => l.side === 'credit')?.accountId).toBe(card.id);
  });

  it('認識先は科目の role を問わず指定でき、存在しない科目IDは拒否する', async () => {
    const ledger = await loadLedger();
    const cash = ledger.accounts.find((a) => a.name === '現金')!;
    const base = {
      name: 'x',
      kind: 'subscription' as const,
      amount: 100,
      costMonths: 1,
      startMonth: '2026-06',
      date: '2026-06-15',
      paymentAccountId: cash.id,
    };
    const item = await createMonthlyCost({ ...base, expenseAccountId: cash.id });
    expect(item.expenseAccountId).toBe(cash.id);

    await expect(
      createMonthlyCost({ ...base, name: 'unknown', expenseAccountId: 'no-such-account' }),
    ).rejects.toMatchObject({ code: 'error.monthlyCost.expenseCategory' });
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

  it('削除で購入仕訳は消えるが、返済実仕訳は残る（実予定＝ユーザー管理）', async () => {
    const { item } = await makeLiabilityMonthlyCost();
    await deleteMonthlyCost(item.id);
    const after = await loadLedger();
    expect(after.monthlyCostItems.some((m) => m.id === item.id)).toBe(false);
    expect(after.journalEntries.some((e) => e.metadata?.monthlyCostId === item.id)).toBe(false);
    // 返済仕訳（monthlyCostId なしの振替）は item 削除でも残り、通常仕訳として削除できる。
    const repays = after.journalEntries.filter((e) => e.description.startsWith('洗濯機 返済'));
    expect(repays).toHaveLength(12);
    await deleteEntry(repays[0]!.id); // fail-closed でない＝自由に編集/削除できる
    expect((await loadLedger()).journalEntries.some((e) => e.id === repays[0]!.id)).toBe(false);
  });

  it('レガシー: 関連返済CFが実績化済みなら削除できない（終了を使う）', async () => {
    // 旧バージョンが作った monthlyCostId 付き予定 CF が残っているデータの互換動作。
    const { item, cash, card } = await makeLiabilityMonthlyCost();
    const sched: CashflowSchedule = {
      id: newId(),
      title: '洗濯機 返済(旧)',
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
    // 本体・購入仕訳は残っている。
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
    // 投資資産を作る（既定科目『投資』と重複しない名前にする）
    await upsertAccount({
      id: 'inv',
      name: '証券口座',
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

describe('残高補正の編集・削除（updateAdjustment / deleteAdjustment）', () => {
  async function setBalance(accountName: string, amount: number) {
    const ledger = await loadLedger();
    const acc = ledger.accounts.find((a) => a.name === accountName)!;
    const capital = ledger.accounts.find((a) => a.name === '開始残高')!;
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
      kind: 'unknown-balance',
      accountId: cash.id,
      date: '2026-06-30',
      actualBalance: 8000,
    });
    expect(created!.metadata?.adjustment?.expectedBalance).toBe(10000);

    // 実残高 9000 に修正。理論残高は補正自身を除く 10000 のまま（8000 にならない）。
    const updated = await updateAdjustment({
      id: created!.id,
      kind: 'unknown-balance',
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
      kind: 'unknown-balance',
      accountId: cash.id,
      date: '2026-06-30',
      actualBalance: 8000,
    });
    const updated = await updateAdjustment({
      id: created!.id,
      kind: 'unknown-balance',
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
      kind: 'unknown-balance',
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
        kind: 'unknown-balance',
        accountId: cash.id,
        date: '2026-06-30',
        actualBalance: 9000,
      }),
    ).rejects.toThrow();
  });

  it('残高補正の仕訳は通常 Journal 経路（upsertEntry/deleteEntry）で壊せない', async () => {
    const cash = await setBalance('現金', 10000);
    const created = await createAdjustment({
      kind: 'unknown-balance',
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

describe('継続コストの後編集で過去集計が再計算される（資産経由モデル）', () => {
  async function setupContinuous() {
    const ledger = await loadLedger();
    const fun = ledger.accounts.find((a) => a.role === 'expense-category')!;
    const cash = ledger.accounts.find((a) => a.role === 'daily-asset')!;
    const item = await createContinuousCost({
      name: 'サブスク',
      kind: 'prepaid-service',
      amount: 12000,
      costMonths: 12,
      startMonth: '2026-01',
      expenseAccountId: fun.id,
      paymentSourceAccountId: cash.id,
    });
    return { item, fun, cash };
  }

  it('総額を後編集すると、過去の認識額・対象資産（未認識）残高が再計算される', async () => {
    const { item, fun } = await setupContinuous();

    const before = await loadLedger();
    const assetId = item.recognitionCreditAccountId!;
    // 認識（費用）合計（仮想）と対象資産残高は amount=12000 を基準に展開される。
    const recogBefore = derivedOf(before)
      .filter(
        (e) => e.metadata?.continuousCostId === item.id && e.metadata?.ccKind === 'recognition',
      )
      .reduce((s, e) => s + (e.lines.find((l) => l.side === 'debit')?.amount ?? 0), 0);
    expect(recogBefore).toBeGreaterThan(0);
    const expenseBefore = accountBalance(fun.id, 'expense', derivedOf(before));

    // 総額を 12000 → 24000 に後編集（過去サイクルからやり直す）。
    await upsertMonthlyCost({ ...item, amount: 24000, updatedAt: 'y2' });

    const after = await loadLedger();
    const recogAfter = derivedOf(after)
      .filter(
        (e) => e.metadata?.continuousCostId === item.id && e.metadata?.ccKind === 'recognition',
      )
      .reduce((s, e) => s + (e.lines.find((l) => l.side === 'debit')?.amount ?? 0), 0);
    const expenseAfter = accountBalance(fun.id, 'expense', derivedOf(after));
    // 月あたり認識が倍増 → 過去含めた認識費用合計が増える。
    expect(recogAfter).toBeGreaterThan(recogBefore);
    expect(expenseAfter).toBeGreaterThan(expenseBefore);
    // funding(24000) は recognition 済み分を上回るので対象資産（未認識）残高 >= 0。
    expect(accountBalance(assetId, 'asset', derivedOf(after))).toBeGreaterThanOrEqual(0);
  });

  it('開始月・認識月数の後編集で対象期間が変わる', async () => {
    const { item } = await setupContinuous();
    await upsertMonthlyCost({ ...item, startMonth: '2026-03', costMonths: 6, updatedAt: 'y2' });
    const after = await loadLedger();
    const recog = derivedOf(after)
      .filter(
        (e) => e.metadata?.continuousCostId === item.id && e.metadata?.ccKind === 'recognition',
      )
      .map((e) => e.date)
      .sort();
    // 新しい開始月より前の認識は存在しない。
    expect(recog.every((d) => d >= '2026-03-01')).toBe(true);
  });

  it('未来日付の返済を追加しても継続コストの導出件数は今日より先へ延びない', async () => {
    const ledger = await loadLedger();
    const expense = ledger.accounts.find((a) => a.role === 'expense-category')!;
    const cash = ledger.accounts.find((a) => a.role === 'daily-asset')!;
    const liability = ledger.accounts.find((a) => a.role === 'payment-liability')!;
    const today = todayLocal();
    const item = await createContinuousCost({
      name: '月次更新',
      kind: 'subscription',
      amount: 12000,
      costMonths: 1,
      repeatEveryMonths: 1,
      startMonth: today.slice(0, 7),
      expenseAccountId: expense.id,
      paymentSourceAccountId: cash.id,
    });
    const virtualForItem = (entries: JournalEntry[]) =>
      entries.filter((entry) => entry.metadata?.continuousCostId === item.id);
    const before = virtualForItem(derivedOf(await loadLedger()));

    await createRepaymentEntries({
      liabilityAccountId: liability.id,
      fromAccountId: cash.id,
      firstDate: '2090-01-27',
      total: 960000,
      count: 48,
      title: '長期返済',
    });

    const after = virtualForItem(derivedOf(await loadLedger()));
    expect(after.filter((entry) => entry.metadata?.ccKind === 'funding')).toHaveLength(
      before.filter((entry) => entry.metadata?.ccKind === 'funding').length,
    );
    expect(after.filter((entry) => entry.metadata?.ccKind === 'recognition')).toHaveLength(
      before.filter((entry) => entry.metadata?.ccKind === 'recognition').length,
    );
    expect(after.every((entry) => entry.date <= today)).toBe(true);
  });
});

describe('勘定科目の聖域化（継続コストは集約台帳口座へ寄せる）', () => {
  async function createCC(name: string) {
    const ledger = await loadLedger();
    const fun = ledger.accounts.find((a) => a.role === 'expense-category')!;
    const cash = ledger.accounts.find((a) => a.role === 'daily-asset')!;
    return createContinuousCost({
      name,
      kind: 'durable-asset',
      amount: 240000,
      costMonths: 84,
      startMonth: '2026-01',
      expenseAccountId: fun.id,
      paymentSourceAccountId: cash.id,
    });
  }

  it('対象名の勘定科目を自動作成せず、品目名は台帳項目に残る', async () => {
    const item = await createCC('洗濯機');
    const after = await loadLedger();
    // 対象名の continuing-cost-asset 科目は作られない。
    expect(
      after.accounts.some((a) => a.name === '洗濯機' && a.role === 'continuing-cost-asset'),
    ).toBe(false);
    // 品目名は台帳項目に残る。
    expect(item.name).toBe('洗濯機');
    expect(after.monthlyCostItems.find((m) => m.id === item.id)?.name).toBe('洗濯機');
    // 認識の貸方は集約台帳口座。
    expect(item.recognitionCreditAccountId).toBe(CONTINUOUS_COST_LEDGER_ACCOUNT_ID);
    const ledgerAcc = after.accounts.find((a) => a.id === CONTINUOUS_COST_LEDGER_ACCOUNT_ID)!;
    expect(ledgerAcc.name).toBe(CONTINUOUS_COST_LEDGER_ACCOUNT_NAME);
    expect(ledgerAcc.role).toBe('continuing-cost-asset');
  });

  it('複数登録しても集約台帳口座は 1 件だけ', async () => {
    await createCC('洗濯機');
    await createCC('YouTube');
    const after = await loadLedger();
    const ccAccounts = after.accounts.filter((a) => a.role === 'continuing-cost-asset');
    expect(ccAccounts).toHaveLength(1);
    expect(ccAccounts[0]?.id).toBe(CONTINUOUS_COST_LEDGER_ACCOUNT_ID);
    // 2 件の台帳項目はどちらも集約口座を指す。
    const items = after.monthlyCostItems;
    expect(items).toHaveLength(2);
    expect(
      items.every((m) => m.recognitionCreditAccountId === CONTINUOUS_COST_LEDGER_ACCOUNT_ID),
    ).toBe(true);
  });

  it('funding=支払い元→継続コスト台帳、recognition=継続コスト台帳→費用カテゴリ', async () => {
    const item = await createCC('洗濯機');
    const after = await loadLedger();
    const funding = derivedOf(after).find(
      (e) => e.metadata?.continuousCostId === item.id && e.metadata?.ccKind === 'funding',
    )!;
    expect(funding.lines.find((l) => l.side === 'debit')?.accountId).toBe(
      CONTINUOUS_COST_LEDGER_ACCOUNT_ID,
    );
    const recognition = derivedOf(after).find(
      (e) => e.metadata?.continuousCostId === item.id && e.metadata?.ccKind === 'recognition',
    )!;
    expect(recognition.lines.find((l) => l.side === 'credit')?.accountId).toBe(
      CONTINUOUS_COST_LEDGER_ACCOUNT_ID,
    );
  });
});

describe('継続コストの支払い元に other-liability（ローン）を許可する', () => {
  it('自動車ローンで資産化 → funding は ローン貸方、返済は 借方 ローン / 貸方 預金 の実仕訳', async () => {
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
      kind: 'durable-asset',
      amount: 2400000,
      costMonths: 60,
      startMonth: '2026-01',
      expenseAccountId: fun.id,
      paymentSourceAccountId: 'loan',
      repaymentAccountId: bank.id,
      repaymentCount: 60,
      repaymentStartDate: '2026-02-01',
    });
    const after = await loadLedger();
    // 予定 CF は作らない。返済は未来日付の振替実仕訳（借方 ローン / 貸方 預金）60 本。
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
    expect(repays[0]?.date).toBe('2026-02-01');
    expect(repays[1]?.date).toBe('2026-03-01');
    expect(repays.every((e) => e.metadata?.monthlyCostId === undefined)).toBe(true);
    // funding 仮想仕訳: 借方 自動車(対象資産) / 貸方 自動車ローン。
    const funding = derivedOf(after).find(
      (e) => e.metadata?.continuousCostId === item.id && e.metadata?.ccKind === 'funding',
    )!;
    expect(funding.lines.find((l) => l.side === 'credit')?.accountId).toBe('loan');
    expect(funding.lines.find((l) => l.side === 'debit')?.accountId).toBe(
      item.recognitionCreditAccountId,
    );
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

  it('新規資産科目の初期残高（借方 科目 / 貸方 開始残高）', async () => {
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

  it('負債の初期残高は逆向き（借方 開始残高 / 貸方 科目）', async () => {
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

  it('負債払い + 返済情報があれば、購入仕訳の貸方負債を取り崩す返済実仕訳を作る', async () => {
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
    expect(item).toBeTruthy();
    // 予定 CF は作らない。返済は未来日付の振替実仕訳（購入仕訳と同一トランザクション）。
    expect(after.cashflowSchedules).toHaveLength(0);
    const repays = after.journalEntries
      .filter((e) => e.description.startsWith('自動車2 返済'))
      .sort((a, b) => a.date.localeCompare(b.date));
    expect(repays).toHaveLength(12);
    // 返済合計は元本に一致（元本のみ・利息は含めない）。
    expect(
      repays.reduce((s, e) => s + (e.lines.find((l) => l.side === 'debit')?.amount ?? 0), 0),
    ).toBe(1_200_000);
    // 借方=カード負債（購入仕訳の貸方）/ 貸方=現金（daily-asset）。
    expect(
      repays.every(
        (e) =>
          e.lines.find((l) => l.side === 'debit')?.accountId === card.id &&
          e.lines.find((l) => l.side === 'credit')?.accountId === cash.id,
      ),
    ).toBe(true);
    expect(repays[0]?.date).toBe('2031-08-10');
    expect(repays[1]?.date).toBe('2031-09-10');
    expect(repays.every((e) => e.metadata?.monthlyCostId === undefined)).toBe(true);
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

  it('総額の編集は生成支払い仕訳を更新し、登録済みの返済実仕訳は変更しない（ユーザー管理）', async () => {
    const { item } = await makeLiabilityMonthlyCost(120000);
    await upsertMonthlyCost({ ...item, amount: 240000 });
    const after = await loadLedger();
    const pay = after.journalEntries.find((e) => e.metadata?.monthlyCostId === item.id)!;
    expect(pay.lines.every((l) => l.amount === 240000)).toBe(true);
    // 返済仕訳は item と切り離された実予定なので、再配分されず元の合計のまま残る。
    const repays = after.journalEntries.filter((e) => e.description.startsWith('洗濯機 返済'));
    expect(repays).toHaveLength(12);
    expect(
      repays.reduce((s, e) => s + (e.lines.find((l) => l.side === 'debit')?.amount ?? 0), 0),
    ).toBe(120000);
  });

  /** 旧バージョンが作った monthlyCostId 付き予定 CF を模す（レガシーデータ互換の検証用）。 */
  function legacySchedule(
    item: { id: string },
    cash: { id: string },
    card: { id: string },
    over: Partial<CashflowSchedule> = {},
  ): CashflowSchedule {
    return {
      id: newId(),
      title: '洗濯機 返済(旧)',
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
      ...over,
    };
  }

  it('レガシー: 未実績の返済CFが残っていれば総額の編集で再配分される', async () => {
    const { item, cash, card } = await makeLiabilityMonthlyCost(120000);
    const s1 = legacySchedule(item, cash, card, { dueDate: '2026-07-27', amount: 60000 });
    const s2 = legacySchedule(item, cash, card, { dueDate: '2026-08-27', amount: 60000 });
    await upsertSchedule(s1);
    await upsertSchedule(s2);
    await upsertMonthlyCost({ ...item, amount: 240000 });
    const after = await loadLedger();
    const schedules = after.cashflowSchedules.filter((s) => s.monthlyCostId === item.id);
    expect(schedules).toHaveLength(2);
    expect(schedules.reduce((s, x) => s + x.amount, 0)).toBe(240000);
  });

  it('レガシー: 返済CFが1件でも実績化済みなら総額を変更できない', async () => {
    const { item, cash, card } = await makeLiabilityMonthlyCost(120000);
    const sched = legacySchedule(item, cash, card);
    await upsertSchedule(sched);
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

  it('認識先は科目の role を問わず変更でき、存在しない科目IDには変更できない', async () => {
    const { item, cash } = await makeDailyMonthlyCost();
    await upsertMonthlyCost({ ...item, expenseAccountId: cash.id });
    const after = await loadLedger();
    expect(after.monthlyCostItems.find((candidate) => candidate.id === item.id)?.expenseAccountId).toBe(
      cash.id,
    );
    expect(
      after.journalEntries
        .find((entry) => entry.metadata?.monthlyCostId === item.id)
        ?.lines.find((line) => line.side === 'debit')?.accountId,
    ).toBe(cash.id);

    const e = await caught(
      upsertMonthlyCost({ ...item, expenseAccountId: 'no-such-account' }),
    );
    expect(e).toBeInstanceOf(LedgerError);
    expect(e.code).toBe('error.monthlyCost.expenseCategory');
  });

  it('costMonths<1 は保存しない / endMonth<startMonth は保存しない / 存在しない item は notFound', async () => {
    const { item } = await makeDailyMonthlyCost();
    const e1 = await caught(upsertMonthlyCost({ ...item, costMonths: 0 }));
    expect(e1.code).toBe('error.monthlyCost.invalidStructure');
    // endMonth は「startMonth の前月」（使用0ヶ月の処分エンコード）まで許容し、それより前は拒否。
    const e2 = await caught(
      upsertMonthlyCost({ ...item, startMonth: '2026-06', endMonth: '2026-04' }),
    );
    expect(e2.code).toBe('error.monthlyCost.endBeforeStart');
    const e3 = await caught(upsertMonthlyCost({ ...item, id: 'no-such-id' }));
    expect(e3.code).toBe('error.monthlyCost.notFound');
  });

  it('状態変更（一時停止）は終了月つきなら保存でき、支払い仕訳は不変', async () => {
    const { item } = await makeDailyMonthlyCost();
    const before = await loadLedger();
    const payBefore = before.journalEntries.find((e) => e.metadata?.monthlyCostId === item.id)!;
    await upsertMonthlyCost({ ...item, status: 'paused', endMonth: item.startMonth });
    const after = await loadLedger();
    expect(after.monthlyCostItems.find((m) => m.id === item.id)?.status).toBe('paused');
    const payAfter = after.journalEntries.find((e) => e.metadata?.monthlyCostId === item.id)!;
    expect(payAfter.lines).toEqual(payBefore.lines);
  });

  it('停止中・終了済みを終了月なしでは保存しない', async () => {
    const { item } = await makeDailyMonthlyCost();
    for (const status of ['paused', 'ended'] as const) {
      const error = await caught(upsertMonthlyCost({ ...item, status }));
      expect(error.code).toBe('error.monthlyCost.endMonthRequired');
    }
  });

  it('通常項目の active→paused→active は仮想仕訳と台帳残高が元に戻る', async () => {
    const ledger = await loadLedger();
    const cash = ledger.accounts.find((account) => account.role === 'daily-asset')!;
    const expense = ledger.accounts.find((account) => account.role === 'expense-category')!;
    const item = await createContinuousCost({
      name: '一時停止テスト',
      kind: 'subscription',
      amount: 12000,
      costMonths: 1,
      repeatEveryMonths: 1,
      startMonth: '2026-06',
      expenseAccountId: expense.id,
      paymentSourceAccountId: cash.id,
    });
    const virtualShape = (ledger: Awaited<ReturnType<typeof loadLedger>>) =>
      derivedOf(ledger)
        .filter((entry) => entry.metadata?.continuousCostId === item.id)
        .map((entry) => ({ id: entry.id, date: entry.date, lines: entry.lines }))
        .sort((a, b) => a.id.localeCompare(b.id));
    const before = await loadLedger();
    const beforeShape = virtualShape(before);
    const assetId = item.recognitionCreditAccountId!;
    const beforeBalance = accountBalance(assetId, 'asset', derivedOf(before));

    await upsertMonthlyCost({ ...item, status: 'paused', endMonth: item.startMonth });
    const paused = (await loadLedger()).monthlyCostItems.find((candidate) => candidate.id === item.id)!;
    const resumed = { ...paused, status: 'active' as const };
    delete resumed.endMonth;
    await upsertMonthlyCost(resumed);

    const after = await loadLedger();
    expect(virtualShape(after)).toEqual(beforeShape);
    expect(accountBalance(assetId, 'asset', derivedOf(after))).toBe(beforeBalance);
  });
});

describe('固定資産の売却・故障処分（disposeFixedAsset）', () => {
  async function caught(p: Promise<unknown>): Promise<LedgerError> {
    try {
      await p;
    } catch (e) {
      return e as LedgerError;
    }
    throw new Error('例外が送出されませんでした');
  }

  /** 固定資産購入 + 月額化（300,000 / 120 か月・開始 2026-01・現金払い）を作る。 */
  async function makeFixedAssetMonthly(
    opts: { amount?: number; costMonths?: number; startMonth?: string; name?: string } = {},
  ) {
    const amount = opts.amount ?? 300000;
    const costMonths = opts.costMonths ?? 120;
    const startMonth = opts.startMonth ?? '2026-01';
    const name = opts.name ?? '車'; // 同一テスト内で 2 台目を作るときは別名を渡す（同名は重複不可）
    const ledger = await loadLedger();
    const cash = ledger.accounts.find((a) => a.name === '現金')!;
    const food = ledger.accounts.find((a) => a.name === '変動費')!;
    const faId = newId();
    await upsertAccount({
      id: faId,
      name,
      type: 'asset',
      role: 'fixed-asset',
      archived: false,
      createdAt: 'x',
      updatedAt: 'x',
    });
    const entry = buildSimpleEntry({
      date: `${startMonth}-01`,
      description: `${name}購入`,
      debitAccountId: faId,
      creditAccountId: cash.id,
      amount,
    });
    const item = await saveEntryWithFixedAssetMonthly(entry, {
      name: '車の月額化',
      kind: 'durable-asset',
      amount,
      costMonths,
      startMonth,
      expenseAccountId: food.id,
      recognitionCreditAccountId: faId,
    });
    return { item, faId, cash, food };
  }

  it('購入と同じ月の処分（使用0ヶ月・endMonth=前月）が保存でき、export が schema 検証を通る', async () => {
    const { item } = await makeFixedAssetMonthly({ name: '車同月処分' });
    const disposal = await disposeFixedAsset({
      monthlyCostId: item.id,
      disposalDate: '2026-01-20',
      proceedsAmount: 0,
    });
    expect(disposal.recognizedAmount).toBe(0);
    const after = await loadLedger();
    const saved = after.monthlyCostItems.find((m) => m.id === item.id)!;
    expect(saved.status).toBe('ended');
    expect(saved.endMonth).toBe('2025-12'); // startMonth の前月 = 使用0ヶ月のエンコード
    // 保存境界と schema の対称性: 書けたデータは必ず書き出し→復元できる。
    const pkg = buildExportPackage(after);
    expect(ledgerExportPackageSchema.safeParse(pkg).success).toBe(true);
  });

  it('開始月より前の処分日は拒否される', async () => {
    const { item } = await makeFixedAssetMonthly({ name: '車開始前処分' });
    const err = await caught(
      disposeFixedAsset({ monthlyCostId: item.id, disposalDate: '2025-12-15', proceedsAmount: 0 }),
    );
    expect(err.code).toBe('error.disposal.beforeStart');
  });

  it('0円故障で売却損が立ち、固定資産残高が 0、処分月以降の月額化が止まる', async () => {
    const { item, faId } = await makeFixedAssetMonthly(); // 300000 / 120, start 2026-01
    // 60 か月後（2026-01 → 2031-01）に 0 円故障。
    const disposal = await disposeFixedAsset({
      monthlyCostId: item.id,
      disposalDate: '2031-01-15',
      proceedsAmount: 0,
    });
    expect(disposal.recognizedAmount).toBe(150000);
    expect(disposal.remainingAmount).toBe(150000);

    const after = await loadLedger();
    // 固定資産 BS 残高は 0。
    expect(accountBalance(faId, 'asset', after.journalEntries)).toBe(0);
    // 月額化コストは終了し、endMonth は処分月の前月。
    const m = after.monthlyCostItems.find((x) => x.id === item.id)!;
    expect(m.status).toBe('ended');
    expect(m.endMonth).toBe('2030-12');
    expect(monthlyCostForMonth(m, '2031-01')).toBe(0);
    // 売却損 150,000 が「その他支出」に計上される。
    const food = after.accounts.find((a) => a.name === '変動費'); // sanity（未使用回避）
    expect(food).toBeTruthy();
    const lossAcc = after.accounts.find((a) => a.name === 'その他支出')!;
    const lossEntry = after.journalEntries.find(
      (e) =>
        e.metadata?.assetDisposalId === disposal.id &&
        e.lines.some((l) => l.side === 'debit' && l.accountId === lossAcc.id),
    )!;
    expect(lossEntry.lines.find((l) => l.side === 'debit')?.amount).toBe(150000);
  });

  it('200,000 円売却で売却益 50,000 が立ち、固定資産残高が 0、入金先に入る', async () => {
    const { item, faId, cash } = await makeFixedAssetMonthly();
    const disposal = await disposeFixedAsset({
      monthlyCostId: item.id,
      disposalDate: '2031-01-15',
      proceedsAmount: 200000,
      destinationAccountId: cash.id,
    });
    expect(disposal.remainingAmount).toBe(150000);

    const after = await loadLedger();
    expect(accountBalance(faId, 'asset', after.journalEntries)).toBe(0);
    // 売却益 50,000 が「その他収入」に計上される。
    const gainAcc = after.accounts.find((a) => a.name === 'その他収入')!;
    const gainEntry = after.journalEntries.find(
      (e) =>
        e.metadata?.assetDisposalId === disposal.id &&
        e.lines.some((l) => l.side === 'credit' && l.accountId === gainAcc.id),
    )!;
    expect(gainEntry.lines.find((l) => l.side === 'credit')?.amount).toBe(50000);
    // 入金先（現金）には売却額 200,000 が入る（処分による現金増分）。
    const disposalEntries = after.journalEntries.filter(
      (e) => e.metadata?.assetDisposalId === disposal.id,
    );
    const cashIn = disposalEntries
      .flatMap((e) => e.lines)
      .filter((l) => l.side === 'debit' && l.accountId === cash.id)
      .reduce((s, l) => s + l.amount, 0);
    expect(cashIn).toBe(200000);
  });

  it('処分で生成された仕訳は直接編集・削除できない（fail-closed）', async () => {
    const { item } = await makeFixedAssetMonthly();
    const disposal = await disposeFixedAsset({
      monthlyCostId: item.id,
      disposalDate: '2031-01-15',
      proceedsAmount: 0,
    });
    const after = await loadLedger();
    const gen = after.journalEntries.find((e) => e.metadata?.assetDisposalId === disposal.id)!;
    await expect(deleteEntry(gen.id)).rejects.toThrow();
    await expect(upsertEntry({ ...gen, description: '改ざん' })).rejects.toThrow();
  });

  it('終了済み（二重処分）・売却なのに入金先なし・非固定資産は拒否する', async () => {
    const { item } = await makeFixedAssetMonthly();
    await disposeFixedAsset({
      monthlyCostId: item.id,
      disposalDate: '2031-01-15',
      proceedsAmount: 0,
    });
    // 2 回目は終了済みのため拒否。
    const e1 = await caught(
      disposeFixedAsset({ monthlyCostId: item.id, disposalDate: '2031-02-15', proceedsAmount: 0 }),
    );
    expect(e1.code).toBe('error.disposal.alreadyEnded');

    // 売却額があるのに入金先がない。
    const { item: item2 } = await makeFixedAssetMonthly({ name: '車2' });
    const e2 = await caught(
      disposeFixedAsset({
        monthlyCostId: item2.id,
        disposalDate: '2031-01-15',
        proceedsAmount: 1000,
      }),
    );
    expect(e2.code).toBe('error.disposal.destinationRequired');

    // 非固定資産の月額化（現金払いサブスク）は処分できない。
    const ledger = await loadLedger();
    const cash = ledger.accounts.find((a) => a.name === '現金')!;
    const food = ledger.accounts.find((a) => a.name === '変動費')!;
    const sub = await createMonthlyCost({
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
    const e3 = await caught(
      disposeFixedAsset({ monthlyCostId: sub.id, disposalDate: '2026-07-15', proceedsAmount: 0 }),
    );
    expect(e3.code).toBe('error.disposal.notFixedAsset');
  });

  it('export/import 後も処分履歴と生成仕訳が保持される', async () => {
    const { item } = await makeFixedAssetMonthly();
    const disposal = await disposeFixedAsset({
      monthlyCostId: item.id,
      disposalDate: '2031-01-15',
      proceedsAmount: 0,
    });
    const text = exportToJsonText(await loadLedger());
    const outcome = await importFromJsonText(text, { force: true });
    expect(outcome.kind).toBe('ok');
    const after = await loadLedger();
    expect(after.assetDisposals.some((d) => d.id === disposal.id)).toBe(true);
    expect(after.journalEntries.some((e) => e.metadata?.assetDisposalId === disposal.id)).toBe(
      true,
    );
  });

  it('固定資産由来の月額化コストは削除できない（処分で履歴を残す）', async () => {
    const { item } = await makeFixedAssetMonthly();
    const e = await caught(deleteMonthlyCost(item.id));
    expect(e).toBeInstanceOf(LedgerError);
    expect(e.code).toBe('error.monthlyCost.deleteFixedAsset');
  });

  it('処分済みの月額化コストも削除できない（AssetDisposal の孤立を防ぐ）', async () => {
    const { item } = await makeFixedAssetMonthly();
    await disposeFixedAsset({
      monthlyCostId: item.id,
      disposalDate: '2031-01-15',
      proceedsAmount: 0,
    });
    const e = await caught(deleteMonthlyCost(item.id));
    expect(e).toBeInstanceOf(LedgerError);
    expect(e.code).toBe('error.monthlyCost.deleteFixedAsset');
  });
});

describe('耐久財・固定資産として月額化（createFixedAssetPurchaseMonthly）', () => {
  it('固定資産科目を自動作成し、購入仕訳・月額化・返済実仕訳を作る（洗濯機 240,000/カード/84か月/固定費/2回）', async () => {
    const ledger = await loadLedger();
    const cash = ledger.accounts.find((a) => a.name === '現金')!;
    const card = ledger.accounts.find((a) => a.role === 'payment-liability')!;
    const fixedCat = ledger.accounts.find((a) => a.name === '固定費')!;
    const item = await createFixedAssetPurchaseMonthly({
      name: '洗濯機',
      kind: 'durable-asset',
      amount: 240000,
      costMonths: 84,
      startMonth: '2026-06',
      date: '2026-06-15',
      expenseAccountId: fixedCat.id,
      paymentAccountId: card.id,
      repaymentAccountId: cash.id,
      repaymentCount: 2,
      repaymentStartDate: '2026-07-27',
    });
    const after = await loadLedger();
    // 固定資産科目「洗濯機」が自動作成される。
    const fixed = after.accounts.find((a) => a.name === '洗濯機' && a.role === 'fixed-asset')!;
    expect(fixed).toBeTruthy();
    // 月額化コストは固定資産由来（sourceEntryId + recognitionCreditAccountId=洗濯機）。
    expect(item.recognitionCreditAccountId).toBe(fixed.id);
    expect(item.sourceEntryId).toBeTruthy();
    expect(item.expenseAccountId).toBe(fixedCat.id);
    // 購入仕訳: 借方 洗濯機(固定資産) / 貸方 カード。
    const purchase = after.journalEntries.find((e) => e.id === item.sourceEntryId)!;
    expect(purchase.lines.find((l) => l.side === 'debit')?.accountId).toBe(fixed.id);
    expect(purchase.lines.find((l) => l.side === 'credit')?.accountId).toBe(card.id);
    expect(purchase.lines.find((l) => l.side === 'debit')?.amount).toBe(240000);
    // 予定 CF は作らない。返済実仕訳（借方 カード / 貸方 現金）は 2 本、合計 240,000。
    expect(after.cashflowSchedules).toHaveLength(0);
    const repays = after.journalEntries
      .filter((e) => e.description.startsWith('洗濯機 返済'))
      .sort((a, b) => a.date.localeCompare(b.date));
    expect(repays).toHaveLength(2);
    expect(
      repays.reduce((s, e) => s + (e.lines.find((l) => l.side === 'debit')?.amount ?? 0), 0),
    ).toBe(240000);
    expect(repays[0]?.lines.find((l) => l.side === 'debit')?.accountId).toBe(card.id);
    expect(repays[0]?.lines.find((l) => l.side === 'credit')?.accountId).toBe(cash.id);
    expect(repays[0]?.date).toBe('2026-07-27');
    expect(repays[1]?.date).toBe('2026-08-27');
    // 以降は売却/故障で処分できる（固定資産由来）。
    const disposal = await disposeFixedAsset({
      monthlyCostId: item.id,
      disposalDate: '2026-06-20',
      proceedsAmount: 0,
    });
    expect(disposal.remainingAmount).toBe(240000); // 当月処分=未認識
  });

  it('耐久財の認識先は科目の role を問わず指定でき、存在しない科目IDは拒否する', async () => {
    const ledger = await loadLedger();
    const cash = ledger.accounts.find((a) => a.name === '現金')!;
    const base = {
      kind: 'durable-asset' as const,
      amount: 1000,
      costMonths: 12,
      startMonth: '2026-06',
      date: '2026-06-15',
      paymentAccountId: cash.id,
    };
    const item = await createFixedAssetPurchaseMonthly({
      ...base,
      name: '資産分類',
      expenseAccountId: cash.id,
    });
    expect(item.expenseAccountId).toBe(cash.id);

    await expect(
      createFixedAssetPurchaseMonthly({
        ...base,
        name: '未知分類',
        expenseAccountId: 'no-such-account',
      }),
    ).rejects.toMatchObject({ code: 'error.fixedAsset.expenseCategory' });
  });
});

/* ── 内訳名の重複ルール（箱をまたいでも重複不可・アーカイブ退避） ── */
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
describe('継続コストの売却・解約（disposeContinuousCost）', () => {
  async function caught(p: Promise<unknown>): Promise<LedgerError> {
    try {
      await p;
    } catch (e) {
      return e as LedgerError;
    }
    throw new Error('expected rejection');
  }

  async function makeYearlySub(name: string) {
    const ledger = await loadLedger();
    const cash = ledger.accounts.find((a) => a.name === '現金')!;
    const fixed = ledger.accounts.find((a) => a.name === '固定費')!;
    // 年払いサブスク: 12000 円 / 12 か月、2026-01 開始（資産経由モデル）。
    const item = await createContinuousCost({
      name,
      kind: 'prepaid-service',
      amount: 12000,
      costMonths: 12,
      repeatEveryMonths: 12,
      startMonth: '2026-01',
      expenseAccountId: fixed.id,
      paymentSourceAccountId: cash.id,
    });
    return { item, cash, fixed };
  }

  function successfulRequest<T>(result: T): IDBRequest<T> {
    const request = {
      result,
      error: null,
      onsuccess: null,
      onerror: null,
    } as unknown as IDBRequest<T>;
    queueMicrotask(() => request.onsuccess?.call(request, new Event('success')));
    return request;
  }

  it('開始月より前の処分日は拒否される（endMonth < startMonth を作らせない）', async () => {
    const { item } = await makeYearlySub('クラウド開始前処分');
    const err = await caught(
      disposeContinuousCost({
        monthlyCostId: item.id,
        disposalDate: '2025-12-15',
        proceedsAmount: 0,
      }),
    );
    expect(err.code).toBe('error.disposal.beforeStart');
  });

  it('継続コストの認識先に内部集約口座は選べない（保存境界 fail-closed）', async () => {
    const ledger = await loadLedger();
    const cash = ledger.accounts.find((a) => a.name === '現金')!;
    await expect(
      createContinuousCost({
        name: '不正な認識先',
        kind: 'prepaid-service',
        amount: 1200,
        costMonths: 12,
        startMonth: '2026-01',
        expenseAccountId: CONTINUOUS_COST_LEDGER_ACCOUNT_ID,
        paymentSourceAccountId: cash.id,
      }),
    ).rejects.toMatchObject({ code: 'error.fixedAsset.expenseCategory' });
  });

  it('返金なし解約は損益を一括計上せず、実使用月数へ遡及再配分され台帳残高が消える', async () => {
    const { item } = await makeYearlySub('クラウドA');
    // 2026-07 に解約 → endMonth=2026-07（処分月まで使用）。12000 を 7 か月へ遡及再配分。
    const disposal = await disposeContinuousCost({
      monthlyCostId: item.id,
      disposalDate: '2026-07-15',
      proceedsAmount: 0,
    });
    // 実績動的償却: 未消化は残らない（全額が実使用期間の費用へ吸収される）。
    expect(disposal.remainingAmount).toBe(0);
    expect(disposal.recognizedAmount).toBe(12000);
    expect(disposal.fixedAccountId).toBe(CONTINUOUS_COST_LEDGER_ACCOUNT_ID);
    const after = await loadLedger();
    const updated = after.monthlyCostItems.find((m) => m.id === item.id)!;
    expect(updated.status).toBe('ended');
    expect(updated.endMonth).toBe('2026-07');
    // 損益の実仕訳は生成されない（0 件）。
    const generated = after.journalEntries.filter(
      (e) => e.metadata?.assetDisposalId === disposal.id,
    );
    expect(generated).toHaveLength(0);
    // 台帳口座のこの項目ぶんの残高は 0（funding 12000 − 遡及認識 12000）。
    const bal = accountBalance(CONTINUOUS_COST_LEDGER_ACCOUNT_ID, 'asset', derivedOf(after));
    expect(bal).toBe(0);
    // 認識合計 = 総額（7 か月へ再配分。1714〜1715 円/月）。
    const recogs = derivedOf(after).filter(
      (e) => e.metadata?.continuousCostId === item.id && e.metadata.ccKind === 'recognition',
    );
    expect(recogs).toHaveLength(7);
    expect(recogs.reduce((s, e) => s + (e.lines[0]?.amount ?? 0), 0)).toBe(12000);
  });

  it('処分済み項目は導出フィールドを凍結し、名称だけ変更できる', async () => {
    const { item } = await makeYearlySub('処分ロック');
    await disposeContinuousCost({
      monthlyCostId: item.id,
      disposalDate: '2026-07-15',
      proceedsAmount: 0,
    });
    const ended = (await loadLedger()).monthlyCostItems.find(
      (candidate) => candidate.id === item.id,
    )!;

    const resumed = { ...ended, status: 'active' as const };
    delete resumed.endMonth;
    const withoutEnd = { ...ended };
    delete withoutEnd.endMonth;
    const withoutRepeat = { ...ended };
    delete withoutRepeat.repeatEveryMonths;
    const candidates = [
      resumed,
      withoutEnd,
      withoutRepeat,
      { ...ended, endMonth: '2026-08' },
      { ...ended, startMonth: '2025-12' },
      { ...ended, costMonths: 6 },
      { ...ended, amount: 24000 },
      { ...ended, expenseAccountId: 'attempted-expense' },
      { ...ended, paymentSourceAccountId: 'attempted-payment-source' },
      { ...ended, recognitionCreditAccountId: 'attempted-recognition-credit' },
    ];
    for (const candidate of candidates) {
      const error = await caught(upsertMonthlyCost(candidate));
      expect(error.code).toBe('error.monthlyCost.disposedLocked');
    }

    await upsertMonthlyCost({ ...ended, name: '処分ロック（名称変更）' });
    const renamed = (await loadLedger()).monthlyCostItems.find(
      (candidate) => candidate.id === item.id,
    )!;
    expect(renamed.name).toBe('処分ロック（名称変更）');
    expect(renamed.startMonth).toBe(ended.startMonth);
    expect(renamed.costMonths).toBe(ended.costMonths);
    expect(renamed.amount).toBe(ended.amount);
  });

  it('処分と編集が競合しても、処分記録・実仕訳を残したまま active へ巻き戻さない', async () => {
    const { item, cash } = await makeYearlySub('競合テスト');
    const disposal = await disposeContinuousCost({
      monthlyCostId: item.id,
      disposalDate: '2026-07-15',
      proceedsAmount: 8000,
      destinationAccountId: cash.id,
    });
    const beforeRace = await loadLedger();
    const beforeItem = beforeRace.monthlyCostItems.find((candidate) => candidate.id === item.id)!;
    const beforeGenerated = beforeRace.journalEntries.filter(
      (entry) => entry.metadata?.assetDisposalId === disposal.id,
    );
    expect(beforeItem.status).toBe('ended');
    expect(beforeGenerated).toHaveLength(1);

    // upsert の外側読み取りだけを「処分直前」の結果にする。最終 readwrite transaction
    // 内の再確認は実 DB を読むため、実行順に依存せず競合窓を再現できる。
    const originalGetAll = IDBObjectStore.prototype.getAll;
    let servedStaleItems = false;
    let servedStaleDisposals = false;
    const getAllSpy = vi
      .spyOn(IDBObjectStore.prototype, 'getAll')
      .mockImplementation(function (this: IDBObjectStore) {
        if (this.name === STORE.monthlyCostItems && !servedStaleItems) {
          servedStaleItems = true;
          return successfulRequest([item]);
        }
        if (this.name === STORE.assetDisposals && !servedStaleDisposals) {
          servedStaleDisposals = true;
          return successfulRequest([]);
        }
        return originalGetAll.call(this);
      });

    try {
      const error = await caught(upsertMonthlyCost({ ...item, name: '競合した編集' }));
      expect(error.code).toBe('error.monthlyCost.disposedLocked');
    } finally {
      getAllSpy.mockRestore();
    }

    const afterRace = await loadLedger();
    const afterItem = afterRace.monthlyCostItems.find((candidate) => candidate.id === item.id)!;
    expect(afterItem.status).toBe('ended');
    expect(afterItem.endMonth).toBe(beforeItem.endMonth);
    expect(afterItem.name).toBe(beforeItem.name);
    expect(afterRace.assetDisposals).toContainEqual(disposal);
    expect(
      afterRace.journalEntries.filter(
        (entry) => entry.metadata?.assetDisposalId === disposal.id,
      ),
    ).toEqual(beforeGenerated);
    expect(afterRace.meta.revision).toBe(beforeRace.meta.revision);
  });

  it('outer item=処分前・outer disposal=処分後の混在でも active へ巻き戻さない', async () => {
    const { item, cash } = await makeYearlySub('混在スナップショット');
    const disposal = await disposeContinuousCost({
      monthlyCostId: item.id,
      disposalDate: '2026-07-15',
      proceedsAmount: 8000,
      destinationAccountId: cash.id,
    });
    const beforeRace = await loadLedger();
    const beforeItem = beforeRace.monthlyCostItems.find((candidate) => candidate.id === item.id)!;
    const beforeGenerated = beforeRace.journalEntries.filter(
      (entry) => entry.metadata?.assetDisposalId === disposal.id,
    );

    // item の外側読取だけを処分前へ戻し、disposal の外側読取は実DB（処分後）のままにする。
    // 最終 transaction が outer disposed=true を信用すると active が上書きされる競合窓。
    const originalGetAll = IDBObjectStore.prototype.getAll;
    let servedStaleItems = false;
    const getAllSpy = vi
      .spyOn(IDBObjectStore.prototype, 'getAll')
      .mockImplementation(function (this: IDBObjectStore) {
        if (this.name === STORE.monthlyCostItems && !servedStaleItems) {
          servedStaleItems = true;
          return successfulRequest([item]);
        }
        return originalGetAll.call(this);
      });

    try {
      const error = await caught(upsertMonthlyCost({ ...item, name: '混在した編集' }));
      expect(error.code).toBe('error.monthlyCost.disposedLocked');
    } finally {
      getAllSpy.mockRestore();
    }

    const afterRace = await loadLedger();
    const afterItem = afterRace.monthlyCostItems.find((candidate) => candidate.id === item.id)!;
    expect(afterItem).toEqual(beforeItem);
    expect(afterRace.assetDisposals).toContainEqual(disposal);
    expect(
      afterRace.journalEntries.filter(
        (entry) => entry.metadata?.assetDisposalId === disposal.id,
      ),
    ).toEqual(beforeGenerated);
    expect(afterRace.meta.revision).toBe(beforeRace.meta.revision);
  });

  it('売却額ありは配分総額から控除され、入金の資産移動だけが実仕訳になる', async () => {
    const { item, cash } = await makeYearlySub('クラウドB');
    // 2026-07 売却 8000 → 費用配分 = 12000 − 8000 = 4000 を 7 か月へ。入金 8000 は台帳→現金。
    const disposal = await disposeContinuousCost({
      monthlyCostId: item.id,
      disposalDate: '2026-07-15',
      proceedsAmount: 8000,
      destinationAccountId: cash.id,
    });
    expect(disposal.remainingAmount).toBe(0);
    expect(disposal.recognizedAmount).toBe(4000);
    const after = await loadLedger();
    const generated = after.journalEntries.filter(
      (e) => e.metadata?.assetDisposalId === disposal.id,
    );
    // 入金の資産移動 1 本のみ（借方 現金 / 貸方 台帳・8000）。売却益はサイクル額超過時だけ。
    expect(generated).toHaveLength(1);
    expect(generated[0]!.lines).toEqual([
      { accountId: cash.id, side: 'debit', amount: 8000 },
      { accountId: CONTINUOUS_COST_LEDGER_ACCOUNT_ID, side: 'credit', amount: 8000 },
    ]);
    const bal = accountBalance(CONTINUOUS_COST_LEDGER_ACCOUNT_ID, 'asset', derivedOf(after));
    expect(bal).toBe(0);
    // 生成仕訳は通常編集・削除できない（fail-closed）。
    const e0 = await caught(deleteEntry(generated[0]!.id));
    expect(e0.code).toBe('error.entry.assetDisposal');
    // 売却額ありで入金先なしは拒否（別項目で確認）。
    const { item: item2 } = await makeYearlySub('クラウドC');
    const e = await caught(
      disposeContinuousCost({
        monthlyCostId: item2.id,
        disposalDate: '2026-07-15',
        proceedsAmount: 1000,
      }),
    );
    expect(e.code).toBe('error.disposal.destinationRequired');
  });

  it('月課金サブスク（costMonths=1）の解約は未消化 0 で仕訳なしの終了になる', async () => {
    const ledger = await loadLedger();
    const cash = ledger.accounts.find((a) => a.name === '現金')!;
    const fixed = ledger.accounts.find((a) => a.name === '固定費')!;
    const item = await createContinuousCost({
      name: '動画配信',
      kind: 'subscription',
      amount: 1500,
      costMonths: 1,
      repeatEveryMonths: 1,
      startMonth: '2026-01',
      expenseAccountId: fixed.id,
      paymentSourceAccountId: cash.id,
    });
    const invalidDate = await caught(
      disposeContinuousCost({
        monthlyCostId: item.id,
        disposalDate: '2026-02-31',
        proceedsAmount: 0,
      }),
    );
    expect(invalidDate.code).toBe('error.disposal.dateRequired');
    const beforeValidDisposal = await loadLedger();
    expect(beforeValidDisposal.monthlyCostItems.find((m) => m.id === item.id)?.status).toBe(
      'active',
    );
    expect(beforeValidDisposal.assetDisposals).toHaveLength(0);

    const disposal = await disposeContinuousCost({
      monthlyCostId: item.id,
      disposalDate: '2026-07-15',
      proceedsAmount: 0,
    });
    expect(disposal.remainingAmount).toBe(0);
    expect(disposal.generatedEntryIds).toHaveLength(0);
    const after = await loadLedger();
    expect(after.monthlyCostItems.find((m) => m.id === item.id)?.status).toBe('ended');
    // 二重処分は拒否。
    const e = await caught(
      disposeContinuousCost({
        monthlyCostId: item.id,
        disposalDate: '2026-08-15',
        proceedsAmount: 0,
      }),
    );
    expect(e.code).toBe('error.disposal.alreadyEnded');
  });

  it('資産経由モデルでない月額化（旧モデル）は売却できない', async () => {
    const ledger = await loadLedger();
    const cash = ledger.accounts.find((a) => a.name === '現金')!;
    const food = ledger.accounts.find((a) => a.name === '変動費')!;
    const sub = await createMonthlyCost({
      name: '旧モデル',
      kind: 'subscription',
      amount: 1500,
      costMonths: 1,
      repeatEveryMonths: 1,
      startMonth: '2026-06',
      date: '2026-06-15',
      expenseAccountId: food.id,
      paymentAccountId: cash.id,
    });
    const e = await caught(
      disposeContinuousCost({ monthlyCostId: sub.id, disposalDate: '2026-07-15', proceedsAmount: 0 }),
    );
    expect(e.code).toBe('error.disposal.notContinuousCost');
  });

  it('export/import 後も継続コストの処分記録が保持される', async () => {
    const { item } = await makeYearlySub('クラウドD');
    const disposal = await disposeContinuousCost({
      monthlyCostId: item.id,
      disposalDate: '2026-07-15',
      proceedsAmount: 0,
    });
    const text = exportToJsonText(await loadLedger());
    const outcome = await importFromJsonText(text);
    expect(outcome.kind).toBe('ok');
    const after = await loadLedger();
    expect(after.assetDisposals.some((d) => d.id === disposal.id)).toBe(true);
  });
});

/* ── 年払いサブスクの途中持ち込み（移行分 + 更新分の 2 段登録） ── */
describe('createSubscriptionMigration', () => {
  async function caught(p: Promise<unknown>): Promise<LedgerError> {
    try {
      await p;
    } catch (e) {
      return e as LedgerError;
    }
    throw new Error('expected rejection');
  }

  it('移行分（開始残高・残り月数で終了固定）と更新分（自動継続）を 1 tx で作る', async () => {
    const ledger = await loadLedger();
    const cash = ledger.accounts.find((a) => a.name === '現金')!;
    const fixed = ledger.accounts.find((a) => a.name === '固定費')!;
    // 3/15 更新の年払いを 7 月に持ち込み: 残り 8 か月 8,000 円 + 更新 12 か月ごと 12,000 円。
    const { migration, renewal } = await createSubscriptionMigration({
      name: 'クラウド写真',
      remainingAmount: 8000,
      remainingMonths: 8,
      renewalAmount: 12000,
      renewalEveryMonths: 12,
      paymentSourceAccountId: cash.id,
      expenseAccountId: fixed.id,
      startMonth: '2026-07',
    });
    const after = await loadLedger();
    const mig = after.monthlyCostItems.find((m) => m.id === migration.id)!;
    const ren = after.monthlyCostItems.find((m) => m.id === renewal.id)!;
    // 移行分: 名前サフィックス・equity funding・endMonth 固定（2026-07 + 7 = 2027-02）。
    expect(mig.name).toBe('クラウド写真（移行分）');
    expect(mig.endMonth).toBe('2027-02');
    expect(mig.repeatEveryMonths).toBeUndefined();
    const migSource = after.accounts.find((a) => a.id === mig.paymentSourceAccountId)!;
    expect(migSource.type).toBe('equity');
    // 更新分: 次回更新月（2027-03）から更新周期で自動継続・支払い元は指定どおり。
    expect(ren.name).toBe('クラウド写真');
    expect(ren.startMonth).toBe('2027-03');
    expect(ren.repeatEveryMonths).toBe(12);
    expect(ren.paymentSourceAccountId).toBe(cash.id);
    // 月あたり: 移行分は 8,000/8 = 1,000（残り月数の間だけ）、更新分は 12,000/12 = 1,000（以後）。
    expect(monthlyCostForMonth(mig, '2026-07')).toBe(1000);
    expect(monthlyCostForMonth(mig, '2027-02')).toBe(1000);
    expect(monthlyCostForMonth(mig, '2027-03')).toBe(0);
    expect(monthlyCostForMonth(ren, '2027-02')).toBe(0);
    expect(monthlyCostForMonth(ren, '2027-03')).toBe(1000);
    // 会計的な検証: 移行分 funding は 開始残高 貸方 8000（収入・支出にならない）。
    const fundings = derivedOf(after).filter(
      (e) => e.metadata?.continuousCostId === mig.id && e.metadata.ccKind === 'funding',
    );
    expect(fundings).toHaveLength(1);
    expect(fundings[0]!.lines.find((l) => l.side === 'credit')?.accountId).toBe(migSource.id);
    expect(fundings[0]!.lines[0]?.amount).toBe(8000);
  });

  it('移行分と更新分は処分前なら導出フィールドを編集できる', async () => {
    const ledger = await loadLedger();
    const cash = ledger.accounts.find((a) => a.name === '現金')!;
    const fixed = ledger.accounts.find((a) => a.name === '固定費')!;
    const { migration, renewal } = await createSubscriptionMigration({
      name: '編集可能な契約',
      remainingAmount: 8000,
      remainingMonths: 8,
      renewalAmount: 12000,
      renewalEveryMonths: 12,
      paymentSourceAccountId: cash.id,
      expenseAccountId: fixed.id,
      startMonth: '2026-07',
    });

    await upsertMonthlyCost({ ...migration, costMonths: 7 });
    await upsertMonthlyCost({ ...renewal, amount: 13000 });
    const after = await loadLedger();
    expect(after.monthlyCostItems.find((m) => m.id === migration.id)?.costMonths).toBe(7);
    expect(after.monthlyCostItems.find((m) => m.id === renewal.id)?.amount).toBe(13000);
  });

  it('入力検証: 空名・0 金額・残り月数 0・更新周期 0 は拒否', async () => {
    const ledger = await loadLedger();
    const cash = ledger.accounts.find((a) => a.name === '現金')!;
    const fixed = ledger.accounts.find((a) => a.name === '固定費')!;
    const base = {
      name: '契約X',
      remainingAmount: 8000,
      remainingMonths: 8,
      renewalAmount: 12000,
      renewalEveryMonths: 12,
      paymentSourceAccountId: cash.id,
      expenseAccountId: fixed.id,
      startMonth: '2026-07',
    };
    expect((await caught(createSubscriptionMigration({ ...base, name: ' ' }))).code).toBe(
      'error.common.nameRequired',
    );
    expect(
      (await caught(createSubscriptionMigration({ ...base, remainingAmount: 0 }))).code,
    ).toBe('error.common.amountInvalid');
    expect(
      (await caught(createSubscriptionMigration({ ...base, remainingMonths: 0 }))).code,
    ).toBe('error.monthlyCost.monthsInvalid');
    expect(
      (await caught(createSubscriptionMigration({ ...base, renewalEveryMonths: 0 }))).code,
    ).toBe('error.monthlyCost.repeatInvalid');
    // 支払い元に費用カテゴリは不可。
    expect(
      (await caught(createSubscriptionMigration({ ...base, paymentSourceAccountId: fixed.id })))
        .code,
    ).toBe('error.monthlyCost.paymentSource');
  });

  it('解約は更新分の 0 円売却 1 操作で、最終サイクルが実使用月数へ切り詰められる', async () => {
    const ledger = await loadLedger();
    const cash = ledger.accounts.find((a) => a.name === '現金')!;
    const fixed = ledger.accounts.find((a) => a.name === '固定費')!;
    const { renewal } = await createSubscriptionMigration({
      name: 'クラウド動画',
      remainingAmount: 8000,
      remainingMonths: 8,
      renewalAmount: 12000,
      renewalEveryMonths: 12,
      paymentSourceAccountId: cash.id,
      expenseAccountId: fixed.id,
      startMonth: '2025-07',
    });
    // 更新分は 2026-03 開始。2026-07 に解約（0 円売却）→ 5 か月使用で切り詰め。
    const disposal = await disposeContinuousCost({
      monthlyCostId: renewal.id,
      disposalDate: '2026-07-15',
      proceedsAmount: 0,
    });
    expect(disposal.remainingAmount).toBe(0);
    const after = await loadLedger();
    const ended = after.monthlyCostItems.find((m) => m.id === renewal.id)!;
    expect(ended.status).toBe('ended');
    expect(ended.endMonth).toBe('2026-07');
    // 12,000 が 5 か月（2026-03〜07）へ遡及再配分される（過去に遡って増額）。
    expect(monthlyCostForMonth(ended, '2026-03')).toBe(2400);
    expect(monthlyCostForMonth(ended, '2026-08')).toBe(0);
  });
});

/* ── 初期化の冪等性（並行初期化で seed を二重投入しない） ── */
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
        kind: 'unknown-balance',
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
      kind: 'subscription',
      amount: 1000,
      costMonths: 1,
      repeatEveryMonths: 1,
      startMonth: '2026-01',
      expenseAccountId: fixed.id,
      paymentSourceAccountId: cash.id,
    });
    const e = await caught(
      createAdjustment({
        kind: 'unknown-balance',
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
      allocations: ledger.allocations,
      cashflowSchedules: ledger.cashflowSchedules,
      reserves: ledger.reserves,
      tags: ledger.tags,
      monthlyCostItems: ledger.monthlyCostItems,
      assetDisposals: ledger.assetDisposals,
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
            kind: 'unknown-balance',
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
          kind: 'unknown-balance',
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
      kind: 'unknown-balance',
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
            kind: 'unknown-balance',
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
      kind: 'unknown-balance',
      accountId: cash.id,
      date: '2026-01-31',
      actualBalance: 800,
    });
    expect(adjustment).not.toBeNull();

    await expectRejectedWithoutDurableMutation(
      () =>
        updateAdjustment({
          id: adjustment!.id,
          kind: 'unknown-balance',
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
      kind: 'prepaid-service',
      amount: 12000,
      costMonths: 12,
      startMonth: '2026-01',
      expenseAccountId: expense.id,
      paymentSourceAccountId: cash.id,
    });

    const beforeAdjustment = await loadLedger();
    const basisEntries = reportEntriesForAsOf(beforeAdjustment, date);
    expect(
      basisEntries.some(
        (entry) =>
          entry.metadata?.continuousCostId === monthlyCost.id &&
          entry.metadata.ccKind === 'funding',
      ),
    ).toBe(true);
    expect(accountBalance(cash.id, 'asset', basisEntries)).toBe(-12000);

    const created = await createAdjustment({
      kind: 'unknown-balance',
      accountId: cash.id,
      date,
      actualBalance: -10000,
    });
    expect(created?.metadata?.adjustment?.expectedBalance).toBe(-12000);
    let after = await loadLedger();
    expect(accountBalance(cash.id, 'asset', reportEntriesForAsOf(after, date))).toBe(-10000);

    const updated = await updateAdjustment({
      id: created!.id,
      kind: 'unknown-balance',
      accountId: cash.id,
      date,
      actualBalance: -9000,
    });
    expect(updated?.metadata?.adjustment?.expectedBalance).toBe(-12000);
    after = await loadLedger();
    expect(accountBalance(cash.id, 'asset', reportEntriesForAsOf(after, date))).toBe(-9000);
  });

  it('MonthlyCostItem を作る全6経路は121文字名を原子的に拒否する', async () => {
    const ledger = await loadLedger();
    const cash = ledger.accounts.find((account) => account.name === '現金')!;
    const expense = ledger.accounts.find((account) => account.name === '固定費')!;
    const fixedAccountId = newId();
    await upsertAccount({
      id: fixedAccountId,
      name: '長名検証用固定資産',
      type: 'asset',
      role: 'fixed-asset',
      archived: false,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    });
    const purchaseEntry = buildSimpleEntry({
      date: '2026-01-15',
      description: '長名検証用購入',
      debitAccountId: fixedAccountId,
      creditAccountId: cash.id,
      amount: 12000,
      metadata: { inputMode: 'expense' },
    });
    const longName = 'x'.repeat(121);
    const cases: { path: string; operation: () => Promise<unknown> }[] = [
      {
        path: 'createMonthlyCost',
        operation: () =>
          createMonthlyCost({
            name: longName,
            kind: 'prepaid-service',
            amount: 12000,
            costMonths: 12,
            startMonth: '2026-01',
            date: '2026-01-15',
            expenseAccountId: expense.id,
            paymentAccountId: cash.id,
          }),
      },
      {
        path: 'saveEntryWithFixedAssetMonthly',
        operation: () =>
          saveEntryWithFixedAssetMonthly(purchaseEntry, {
            name: longName,
            kind: 'durable-asset',
            amount: 12000,
            costMonths: 12,
            startMonth: '2026-01',
            expenseAccountId: expense.id,
            recognitionCreditAccountId: fixedAccountId,
          }),
      },
      {
        path: 'createFixedAssetPurchaseMonthly',
        operation: () =>
          createFixedAssetPurchaseMonthly({
            name: longName,
            kind: 'durable-asset',
            amount: 12000,
            costMonths: 12,
            startMonth: '2026-01',
            date: '2026-01-15',
            expenseAccountId: expense.id,
            paymentAccountId: cash.id,
          }),
      },
      {
        path: 'createContinuousCost',
        operation: () =>
          createContinuousCost({
            name: longName,
            kind: 'prepaid-service',
            amount: 12000,
            costMonths: 12,
            startMonth: '2026-01',
            expenseAccountId: expense.id,
            paymentSourceAccountId: cash.id,
          }),
      },
      {
        path: 'createContinuousCostFromOpening',
        operation: () =>
          createContinuousCostFromOpening({
            name: longName,
            amount: 12000,
            costMonths: 12,
            startMonth: '2026-01',
            expenseAccountId: expense.id,
          }),
      },
      {
        path: 'createSubscriptionMigration',
        operation: () =>
          createSubscriptionMigration({
            name: longName,
            remainingAmount: 6000,
            remainingMonths: 6,
            renewalAmount: 12000,
            renewalEveryMonths: 12,
            paymentSourceAccountId: cash.id,
            expenseAccountId: expense.id,
            startMonth: '2026-01',
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

    // 入力名自体は120文字以内でも「（移行分）」付与後だけ121文字になる境界を守る。
    await expectRejectedWithoutDurableMutation(
      () =>
        createSubscriptionMigration({
          name: 'x'.repeat(116),
          remainingAmount: 6000,
          remainingMonths: 6,
          renewalAmount: 12000,
          renewalEveryMonths: 12,
          paymentSourceAccountId: cash.id,
          expenseAccountId: expense.id,
          startMonth: '2026-01',
        }),
      'error.monthlyCost.invalidStructure',
      'createSubscriptionMigration generated migration name',
    );
  });
});

describe('取り置きの枠削除（後片付け）', () => {
  it('枠の削除は同一トランザクションで仕訳の reserveId を剥がし、export が復元可能なまま残る', async () => {
    const { deleteReserve, createReserve } = await import('../src/data/repository');
    const ledger = await loadLedger();
    const capital = ledger.accounts.find((a) => a.name === '開始残高')!;
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
