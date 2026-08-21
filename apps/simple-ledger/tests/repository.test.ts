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
  deleteAccount,
  deleteEntry,
  deleteMonthlyCost,
  listSnapshots,
  loadLedger,
  makeSnapshotId,
  resetAll,
  saveSnapshot,
  updateSettings,
  upsertAccount,
  upsertEntry,
  upsertMonthlyCost,
} from '../src/data/repository';
import { buildSimpleEntry } from '../src/domain/entry';
import { LedgerError } from '../src/domain/errors';
import {
  CONTINUOUS_COST_LEDGER_ACCOUNT_ID,
  CONTINUOUS_COST_LEDGER_ACCOUNT_NAME,
} from '../src/domain/constants';
import { accountBalance } from '../src/domain/accounting';
import { reportEntriesForAsOf } from '../src/domain/reportEntries';
import { buildExportPackage, exportToJsonText, importFromJsonText } from '../src/data/exportImport';
import { ledgerExportPackageSchema } from '../src/domain/schema';
import { getAll, getKv, putKv, putRecord, STORE } from '../src/data/db';
import { SCHEMA_VERSION } from '../src/domain/constants';
import { newId } from '../src/domain/ids';
import { todayLocal } from '../src/util/time';
import type { JournalEntry, LedgerMeta } from '../src/domain/types';

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
    expect(ledger.settings.currency).toBe('円');
    expect(ledger.settings.displayFractionDigits).toBe(0);
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
    const card = ledger.accounts.find((a) => a.name === 'クレジットカード')!;
    const food = ledger.accounts.find((a) => a.name === '変動費')!;
    await addEntryRef(food.id, card.id);
    // カード(payment-liability) を other-liability へ（type は liability のまま）→ 使用中なので拒否。
    await expect(
      upsertAccount({ ...card, role: 'other-liability', updatedAt: 'y' }),
    ).rejects.toMatchObject({ code: 'error.account.roleLocked' });
    const after = await loadLedger();
    expect(after.accounts.find((a) => a.id === card.id)?.role).toBe('payment-liability');
  });

  it('未使用なら role 変更できる', async () => {
    const ledger = await loadLedger();
    const card = ledger.accounts.find((a) => a.name === 'クレジットカード')!;
    await upsertAccount({ ...card, role: 'other-liability', updatedAt: 'y' });
    const after = await loadLedger();
    expect(after.accounts.find((a) => a.id === card.id)?.role).toBe('other-liability');
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
    const snapshotSource = await loadLedger();
    // スナップショットも作っておき、全ストアが一括で消えることを確認する
    await saveSnapshot(
      {
        id: makeSnapshotId(),
        createdAt: '2026-06-01T00:00:00.000Z',
        reason: 'import',
        data: buildExportPackage(snapshotSource),
      },
      {
        deviceId: snapshotSource.meta.deviceId,
        revision: snapshotSource.meta.revision,
      },
    );
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

  it('全初期化後に旧世代のスナップショットを保存せず、削除状態を維持する', async () => {
    const before = await loadLedger();
    const snapshot = {
      id: makeSnapshotId(),
      createdAt: '2026-06-01T00:00:00.000Z',
      reason: 'import' as const,
      data: buildExportPackage(before),
    };

    await resetAll();

    await expect(
      saveSnapshot(snapshot, {
        deviceId: before.meta.deviceId,
        revision: before.meta.revision,
      }),
    ).rejects.toMatchObject({ code: 'error.common.staleData' });
    expect(await listSnapshots()).toHaveLength(0);
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

  it('equity 科目の名前は起動時に書き換えない（同定は role が正本・指示書v3 §B-4 で強制改名を廃止）', async () => {
    const initial = await loadLedger();
    const equity = initial.accounts.find((account) => account.role === 'equity')!;
    await putRecord(STORE.accounts, { ...equity, name: '旧表記', updatedAt: 'old' });
    await putKv<LedgerMeta>('meta', { ...initial.meta, revision: 7 });

    // 名前は表示データ。起動が黙って書き換えない（revision も進まない）。
    const reloaded = await loadLedger();
    const kept = reloaded.accounts.find((account) => account.role === 'equity')!;
    expect(kept.id).toBe(equity.id);
    expect(kept.name).toBe('旧表記');
    expect(reloaded.meta.revision).toBe(7);
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
    // 支払い元も role を問わない（費用カテゴリも可）。存在しない科目IDは拒否。
    const food = ledger.accounts.find((a) => a.name === '変動費')!;
    const ok = await createContinuousCost({
      ...base,
      name: 'expense-credit',
      expenseAccountId: food.id,
      creditAccountId: food.id,
    });
    expect(ok.name).toBe('expense-credit');
    await expect(
      createContinuousCost({
        ...base,
        name: 'unknown-credit',
        expenseAccountId: food.id,
        creditAccountId: 'no-such-account',
      }),
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
    await expect(upsertEntry({ ...edited, date: '2027-06-01' })).rejects.toMatchObject({
      code: 'error.monthlyCost.purchaseAfterEnd',
    });
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
      date: '2026-06-15',
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
      recoveries: [{ destinationAccountId: cash.id, amount: 3000 }],
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
    // 完済で負債残高は 0。
    expect(accountBalance(card.id, 'liability', after.journalEntries)).toBe(0);
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

    const error = await caught(createRepaymentEntries({ ...base, firstDate: '2026-02-31' }));
    expect(error.code).toBe('error.monthlyCost.dateRequired');
    expect((await loadLedger()).journalEntries).toHaveLength(0);

    const created = await createRepaymentEntries({ ...base, firstDate: '2024-02-29' });
    expect(created).toHaveLength(1);
    expect(created[0]?.date).toBe('2024-02-29');
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

describe('残高補正の全科目化: 費用・収入（作者決定 2026-08-15）', () => {
  /** 固定費へ 2 本（3,000 / 2,000）。理論値は「その日までの累計」になる。 */
  async function seedFixedCost() {
    const ledger = await loadLedger();
    const cash = ledger.accounts.find((a) => a.name === '現金')!;
    const fixed = ledger.accounts.find((a) => a.name === '固定費')!;
    for (const [date, amount] of [
      ['2026-06-01', 3000],
      ['2026-06-10', 2000],
    ] as const) {
      await upsertEntry(
        buildSimpleEntry({
          date,
          description: '固定費の支払い',
          debitAccountId: fixed.id,
          creditAccountId: cash.id,
          amount,
        }),
      );
    }
    return fixed;
  }

  it('費用 実累計12000・理論5000 → 借方 固定費 / 貸方 残高調整収入 7000', async () => {
    const fixed = await seedFixedCost();
    // 2026-06-30 までの累計 = 3,000 + 2,000 = 5,000。実際は 12,000 → delta = +7,000。
    const entry = await createAdjustment({
      accountId: fixed.id,
      date: '2026-06-30',
      actualBalance: 12000,
    });
    expect(entry!.metadata?.adjustment?.expectedBalance).toBe(5000);
    expect(entry!.metadata?.adjustment?.delta).toBe(7000);
    const rev = (await loadLedger()).accounts.find(
      (a) => a.role === 'system-adjustment' && a.type === 'revenue',
    )!;
    expect(rev.name).toBe('残高調整収入');
    expect(entry!.lines.find((l) => l.side === 'debit')).toMatchObject({
      accountId: fixed.id,
      amount: 7000,
    });
    expect(entry!.lines.find((l) => l.side === 'credit')).toMatchObject({
      accountId: rev.id,
      amount: 7000,
    });
  });

  it('費用 実累計4000・理論5000 → 借方 残高調整費 / 貸方 固定費 1000', async () => {
    const fixed = await seedFixedCost();
    // 5,000 の理論に対し実際は 4,000 → delta = −1,000（費用を減らす = 貸方 費用）。
    const entry = await createAdjustment({
      accountId: fixed.id,
      date: '2026-06-30',
      actualBalance: 4000,
    });
    expect(entry!.metadata?.adjustment?.delta).toBe(-1000);
    const exp = (await loadLedger()).accounts.find(
      (a) => a.role === 'system-adjustment' && a.type === 'expense',
    )!;
    expect(entry!.lines.find((l) => l.side === 'debit')).toMatchObject({
      accountId: exp.id,
      amount: 1000,
    });
    expect(entry!.lines.find((l) => l.side === 'credit')).toMatchObject({
      accountId: fixed.id,
      amount: 1000,
    });
  });

  it('理論値はその日までの累計（後日の仕訳を含めない）', async () => {
    const fixed = await seedFixedCost();
    // 2026-06-05 時点の累計は 1 本目の 3,000 だけ（2 本目 2026-06-10 は含まない）。
    const entry = await createAdjustment({
      accountId: fixed.id,
      date: '2026-06-05',
      actualBalance: 3500,
    });
    expect(entry!.metadata?.adjustment?.expectedBalance).toBe(3000);
    expect(entry!.metadata?.adjustment?.delta).toBe(500);
  });

  it('収入は負債と同向: 実累計が多いと 貸方 給与 / 借方 残高調整費', async () => {
    const ledger = await loadLedger();
    const cash = ledger.accounts.find((a) => a.name === '現金')!;
    const salary = ledger.accounts.find((a) => a.name === '給与')!;
    await upsertEntry(
      buildSimpleEntry({
        date: '2026-06-01',
        description: '給与',
        debitAccountId: cash.id,
        creditAccountId: salary.id,
        amount: 200000,
      }),
    );
    // 理論 200,000 に対し実際は 250,000 → delta = +50,000（収入を増やす = 貸方 収入）。
    const entry = await createAdjustment({
      accountId: salary.id,
      date: '2026-06-30',
      actualBalance: 250000,
    });
    expect(entry!.metadata?.adjustment?.expectedBalance).toBe(200000);
    const exp = (await loadLedger()).accounts.find(
      (a) => a.role === 'system-adjustment' && a.type === 'expense',
    )!;
    expect(entry!.lines.find((l) => l.side === 'debit')).toMatchObject({
      accountId: exp.id,
      amount: 50000,
    });
    expect(entry!.lines.find((l) => l.side === 'credit')).toMatchObject({
      accountId: salary.id,
      amount: 50000,
    });
  });

  it('残高調整科目そのものは補正できない（type 制限では弾けない経路・fail-closed）', async () => {
    const ledger = await loadLedger();
    const cash = ledger.accounts.find((a) => a.name === '現金')!;
    // 1 回の補正で 残高調整費（type=expense）を生成する。
    await createAdjustment({ accountId: cash.id, date: '2026-06-01', actualBalance: -1000 });
    const adjustmentAccount = (await loadLedger()).accounts.find(
      (a) => a.role === 'system-adjustment',
    )!;

    await expect(
      createAdjustment({
        accountId: adjustmentAccount.id,
        date: '2026-06-30',
        actualBalance: 999,
      }),
    ).rejects.toMatchObject({ code: 'error.adjust.internalRole' });
    // 補正仕訳は 1 本目だけのまま（自己参照の補正を作らない）。
    expect((await loadLedger()).journalEntries.filter((e) => e.metadata?.adjustment)).toHaveLength(
      1,
    );
  });

  it('equity（初期残高）は従来どおり補正できない', async () => {
    const ledger = await loadLedger();
    const capital = ledger.accounts.find((a) => a.name === '初期残高')!;
    await expect(
      createAdjustment({ accountId: capital.id, date: '2026-06-30', actualBalance: 100 }),
    ).rejects.toMatchObject({ code: 'error.adjust.assetLiabilityOnly' });
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

/*
 * 按分（v13.4 ①）の保存側の波及。集計が「pin → スライス」に変わっても、理論残高の
 * 算定ロジック（自身除外・その日までの累計）はそのまま効き続けることを固定する。
 */
describe('残高補正の按分と保存側の理論残高', () => {
  async function seedCash(amount: number) {
    const ledger = await loadLedger();
    const cash = ledger.accounts.find((a) => a.name === '現金')!;
    await createOpenings([{ accountId: cash.id, amount, date: '2026-01-10' }]);
    return cash;
  }

  async function derivedBalance(accountId: string, asOf: string) {
    const ledger = await loadLedger();
    return accountBalance(accountId, 'asset', reportEntriesForAsOf(ledger, asOf));
  }

  it('補正日の集計残高は実額・手前は按分ぶんだけ動く（補正月に跳ねない）', async () => {
    const cash = await seedCash(10_000);
    await createAdjustment({ accountId: cash.id, date: '2026-07-10', actualBalance: 8_800 });
    // 実効開始 2026-01-10 → 6 刻み × 200。
    expect(await derivedBalance(cash.id, '2026-01-10')).toBe(10_000);
    expect(await derivedBalance(cash.id, '2026-04-10')).toBe(9_400);
    expect(await derivedBalance(cash.id, '2026-07-10')).toBe(8_800);
    // 補正日以降は按分前と完全一致（不変条件）。
    expect(await derivedBalance(cash.id, '2027-01-01')).toBe(8_800);
  });

  it('2 本目の理論残高は 1 本目の宣言を織り込む（差額の二重計上をしない）', async () => {
    const cash = await seedCash(10_000);
    await createAdjustment({ accountId: cash.id, date: '2026-04-10', actualBalance: 9_700 });
    const second = await createAdjustment({
      accountId: cash.id,
      date: '2026-07-10',
      actualBalance: 9_400,
    });
    expect(second!.metadata?.adjustment?.expectedBalance).toBe(9_700);
    expect(await derivedBalance(cash.id, '2026-04-10')).toBe(9_700);
    expect(await derivedBalance(cash.id, '2026-07-10')).toBe(9_400);
  });

  it('編集の理論残高は「その pin が居る世界」で測る（後ろの pin の按分を先取りしない・C-3）', async () => {
    const cash = await seedCash(10_000);
    const first = await createAdjustment({
      accountId: cash.id,
      date: '2026-04-10',
      actualBalance: 9_700,
    });
    await createAdjustment({ accountId: cash.id, date: '2026-07-10', actualBalance: 9_400 });
    // 編集後の世界では 1 本目の区間は (2026-01-10, 2026-04-10]。そこに後ろの pin の
    // スライスは 1 本も入らないので、理論残高は非補正フローそのもの = 10,000。
    // 旧: 自分を除いた世界（2 本目の区間が 01-10 まで伸びる）で測って 9,700 だったが、
    // その差分（−100）は実際に按分されるスライス合計（−400）と食い違っていた。
    const updated = await updateAdjustment({
      id: first!.id,
      accountId: cash.id,
      date: '2026-04-10',
      actualBalance: 9_600,
    });
    expect(updated!.metadata?.adjustment?.expectedBalance).toBe(10_000);
    expect(updated!.metadata?.adjustment?.delta).toBe(-400);
    // 保存後は両方の宣言が生き、それぞれの日で実額に着地する。
    expect(await derivedBalance(cash.id, '2026-04-10')).toBe(9_600);
    expect(await derivedBalance(cash.id, '2026-07-10')).toBe(9_400);
  });

  it('宣言を削除すると区間が結合され、残る宣言の按分が計算し直される', async () => {
    const cash = await seedCash(10_000);
    const first = await createAdjustment({
      accountId: cash.id,
      date: '2026-04-10',
      actualBalance: 9_700,
    });
    await createAdjustment({ accountId: cash.id, date: '2026-07-10', actualBalance: 9_400 });
    await deleteAdjustment(first!.id);
    // 残るのは 1 本。2026-07-10 は実額のまま、4/10 は按分の途中になる。
    expect(await derivedBalance(cash.id, '2026-07-10')).toBe(9_400);
    expect(await derivedBalance(cash.id, '2026-04-10')).toBe(9_700);
    await deleteAdjustment(
      (await loadLedger()).journalEntries.find((e) => e.metadata?.adjustment)!.id,
    );
    expect(await derivedBalance(cash.id, '2026-07-10')).toBe(10_000);
  });

  /** 補正済みの現金から `amount` を引き出す（終了残高 0 検証の材料）。 */
  async function seedAdjustedThenWithdraw(amount: number) {
    const cash = await seedCash(10_000);
    await createAdjustment({ accountId: cash.id, date: '2026-07-10', actualBalance: 8_800 });
    const equity = (await loadLedger()).accounts.find((a) => a.name === '初期残高')!;
    await upsertEntry(
      buildSimpleEntry({
        date: '2026-08-01',
        description: '引き出し',
        debitAccountId: equity.id,
        creditAccountId: cash.id,
        amount,
      }),
    );
    return (await loadLedger()).accounts.find((a) => a.id === cash.id)!;
  }

  it('終了残高 0 検証は按分後の残高で判定する（スライスは区間内に収まる）', async () => {
    const target = await seedAdjustedThenWithdraw(8_800);
    await upsertAccount({ ...target, archived: true, endDate: '2026-08-31' });
    expect((await loadLedger()).accounts.find((a) => a.id === target.id)?.endDate).toBe(
      '2026-08-31',
    );
  });

  it('按分ぶんを無視した額しか引き出していなければ終了点を置けない（fail-closed）', async () => {
    const target = await seedAdjustedThenWithdraw(10_000);
    await expect(
      upsertAccount({ ...target, archived: true, endDate: '2026-08-31' }),
    ).rejects.toMatchObject({ code: 'error.account.archiveBalance' });
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
      (e) => e.metadata?.continuousCostId === id && e.metadata?.ccKind === 'monthly-allocation',
    );

  it('金額を後編集すると過去の費用行が再計算され、購入の仕訳の金額もミラーされる', async () => {
    const { item, fun } = await setupContinuous();
    const before = await loadLedger();
    const asOf = '2026-06-30';
    const recogBefore = recogOf(reportEntriesForAsOf(before, asOf), item.id).reduce(
      (s, e) => s + (e.lines.find((l) => l.side === 'debit')?.amount ?? 0),
      0,
    );
    // 同日刻み: 2026-01-01 起点の刻み日は 2026-02-01〜2026-12-01 の 11 本
    //（12 本目 2027-01-01 は終了日 2026-12-31 を超える）。12,000 / 11 = 1,090 余り 10 なので
    // 先頭 10 本が 1,091。asOf までに立つのは 2〜6 月の 5 本 = 1,091 × 5。
    expect(recogBefore).toBe(5455);
    const expenseBefore = accountBalance(fun.id, 'expense', reportEntriesForAsOf(before, asOf));

    await upsertMonthlyCost({ ...item, amount: 24000, updatedAt: 'y2' });

    const after = await loadLedger();
    const recogAfter = recogOf(reportEntriesForAsOf(after, asOf), item.id).reduce(
      (s, e) => s + (e.lines.find((l) => l.side === 'debit')?.amount ?? 0),
      0,
    );
    // 24,000 / 11 = 2,181 余り 9 → 先頭 9 本が 2,182。同じ 5 本で 10,910 = 5,455 の倍。
    expect(recogAfter).toBe(10910); // 月あたりが倍増（過去に遡って再計算）
    expect(accountBalance(fun.id, 'expense', reportEntriesForAsOf(after, asOf))).toBe(
      expenseBefore + 5455,
    );
    // 購入の仕訳の金額もミラーされ、台帳残高 >= 0。
    const purchase = after.journalEntries.find((e) => e.metadata?.monthlyCostId === item.id)!;
    expect(purchase.lines.every((l) => l.amount === 24000)).toBe(true);
    expect(
      accountBalance(CONTINUOUS_COST_LEDGER_ACCOUNT_ID, 'asset', reportEntriesForAsOf(after, asOf)),
    ).toBeGreaterThanOrEqual(0);
  });

  it('費用の行き先の変更は購入の仕訳を壊さない（借方は台帳のまま・§13-6）', async () => {
    const { item, fun } = await setupContinuous();
    const ledger = await loadLedger();
    const other = ledger.accounts.find((a) => a.role === 'expense-category' && a.id !== fun.id)!;
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
    // 終了日 2026-06-30 までの同日通過は 2026-02-01〜2026-06-01 の 5 本
    //（6 本目 2026-07-01 は終了日超）。12,000 / 5 = 2,400 ちょうど。
    expect(recogOf(reportEntriesForAsOf(after, '2027-12-31'), item.id)).toHaveLength(5);
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
        (e) =>
          e.lines.find((l) => l.side === 'debit')?.accountId === CONTINUOUS_COST_LEDGER_ACCOUNT_ID,
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
    expect(
      after.accounts.filter((account) => account.role === 'equity' && !account.archived),
    ).toHaveLength(1);
    expect(after.meta.revision).toBe(before.meta.revision + 1);
  });

  it('一括登録の 2 件目で transaction が abort すると 1 件も残らない', async () => {
    const before = await loadLedger();
    const cash = before.accounts.find((account) => account.name === '現金')!;
    const card = before.accounts.find((account) => account.role === 'payment-liability')!;
    const equityCountBefore = before.accounts.filter((account) => account.role === 'equity').length;
    const originalPut = IDBObjectStore.prototype.put;
    let journalPuts = 0;
    const putSpy = vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(function (
      this: IDBObjectStore,
      value: unknown,
    ) {
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
      { ccKind: 'monthly-allocation' },
      { adjustmentSliceOf: 'pin-1' },
      { investmentProjectionOf: 'invest-1' },
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
      expect((await loadLedger()).journalEntries.some((saved) => saved.id === entry.id)).toBe(
        false,
      );
    }
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
    const other = before.accounts.find((a) => a.role === 'expense-category' && a.id !== food.id)!;
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
    const purchaseAfter = after.journalEntries.find((e) => e.metadata?.monthlyCostId === item.id)!;
    expect(purchaseAfter).toEqual(purchaseBefore);
  });

  it('金額の編集は購入の仕訳の両側金額へミラーされる（回収の振替は触らない）', async () => {
    const { item, cash } = await setup();
    // 回収の振替を作っておく。
    await archiveMonthlyCost({
      id: item.id,
      endDate: '2026-12-31',
      recoveries: [{ destinationAccountId: cash.id, amount: 3000 }],
    });
    await upsertMonthlyCost({ ...item, amount: 24000, updatedAt: 'y2' });
    const after = await loadLedger();
    const purchase = after.journalEntries.find(
      (e) => e.metadata?.monthlyCostId === item.id && e.metadata.monthlyCostRecovery !== true,
    )!;
    expect(purchase.lines.every((l) => l.amount === 24000)).toBe(true);
    const recovery = after.journalEntries.find((e) => e.metadata?.monthlyCostRecovery === true)!;
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
    await expect(upsertMonthlyCost({ ...item, endDate: '2026-01-14' })).rejects.toMatchObject({
      code: 'error.monthlyCost.endBeforeStart',
    });
    await expect(upsertMonthlyCost({ ...item, id: 'no-such-item' })).rejects.toMatchObject({
      code: 'error.monthlyCost.notFound',
    });
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
      recoveries: [{ destinationAccountId: bank.id, amount: 30000 }],
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
    // 会計（§6-1 の検算）: 2024-06-01 起点の同日通過は 2024-07-01〜2026-06-01 の 24 本
    //（25 本目 2026-07-01 は終了日 2026-06-15 を超える）。割り振る総額 240,000 − 30,000 =
    // 210,000 を 24 等分 = 8,750 ちょうど。費用 210,000・台帳は 0 で閉じる。
    const derived = reportEntriesForAsOf(after, '2026-12-31');
    const recogs = derived.filter(
      (e) =>
        e.metadata?.continuousCostId === item.id && e.metadata?.ccKind === 'monthly-allocation',
    );
    expect(recogs).toHaveLength(24);
    expect(recogs[0]?.lines[0]?.amount).toBe(8750);
    expect(accountBalance(food.id, 'expense', derived)).toBe(210000);
    expect(accountBalance(CONTINUOUS_COST_LEDGER_ACCOUNT_ID, 'asset', derived)).toBe(0);
  });

  it('回収額に上限なし（残存価値・購入額を超えてもエラーにしない・作者決定）', async () => {
    const { item, bank } = await setup();
    await archiveMonthlyCost({
      id: item.id,
      endDate: '2026-06-15',
      recoveries: [{ destinationAccountId: bank.id, amount: 300000 }],
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

  it('検証: 開始日より前の終了日・存在しない振替先は fail-closed', async () => {
    const { item, food } = await setup();
    await expect(archiveMonthlyCost({ id: item.id, endDate: '2024-05-31' })).rejects.toMatchObject({
      code: 'error.monthlyCost.endBeforeStart',
    });
    await expect(
      archiveMonthlyCost({
        id: item.id,
        endDate: '2026-06-15',
        recoveries: [{ destinationAccountId: 'no-such-account', amount: 100 }],
      }),
    ).rejects.toMatchObject({ code: 'error.monthlyCost.recoveryDestination' });
    // 費用カテゴリのうち **item の費用の行き先** だけは振替先にできる
    //（= 「終了日に全額費用にする」の第 2 振替）。
    await archiveMonthlyCost({
      id: item.id,
      endDate: '2026-06-15',
      recoveries: [{ destinationAccountId: food.id, amount: 100 }],
    });
    const recovery = (await loadLedger()).journalEntries.find(
      (entry) => entry.metadata?.monthlyCostRecovery === true,
    );
    expect(recovery?.lines.find((line) => line.side === 'debit')?.accountId).toBe(food.id);
    await expect(
      archiveMonthlyCost({ id: 'no-such-item', endDate: '2026-06-15' }),
    ).rejects.toMatchObject({ code: 'error.monthlyCost.notFound' });
  });

  /** 同日刻みがちょうど割り切れる item（1,200,000 を 12 刻み = 各 100,000）。 */
  async function setupEven() {
    const ledger = await loadLedger();
    const bank = ledger.accounts.find((a) => a.name === '預金')!;
    const food = ledger.accounts.find((a) => a.name === '変動費')!;
    const item = await createContinuousCost({
      name: '割り切れる項目',
      amount: 1200000,
      startDate: '2026-01-01',
      endDate: '2027-01-01',
      expenseAccountId: food.id,
      creditAccountId: bank.id,
    });
    return { item, bank, food };
  }

  /** その item の計算で生まれた月割り行（刻み）。 */
  function cutsOf(derived: JournalEntry[], itemId: string) {
    return derived.filter(
      (e) => e.metadata?.continuousCostId === itemId && e.metadata?.ccKind === 'monthly-allocation',
    );
  }

  it('「終了日に全額費用にする」= 費用の行き先への第 2 の回収の振替（過去の刻みは元の額のまま）', async () => {
    const { item, food } = await setupEven();
    // 2026-07-01 で終了 = 同日刻み 2026-02-01〜07-01 の 6 本（各 100,000）が消費済み。
    // 残り 600,000 を終了日に 1 本で費用にする（= 割り振る総額が消費済み額へ落ちる）。
    await archiveMonthlyCost({
      id: item.id,
      endDate: '2026-07-01',
      recoveries: [{ destinationAccountId: food.id, amount: 600000 }],
    });
    const after = await loadLedger();
    const second = after.journalEntries.find((e) => e.metadata?.monthlyCostRecovery === true)!;
    expect(second.date).toBe('2026-07-01');
    expect(second.lines).toEqual([
      { accountId: food.id, side: 'debit', amount: 600000 },
      { accountId: CONTINUOUS_COST_LEDGER_ACCOUNT_ID, side: 'credit', amount: 600000 },
    ]);
    const derived = reportEntriesForAsOf(after, '2027-12-31');
    const cuts = cutsOf(derived, item.id);
    // 過去の刻みは本数も額も変わらない（新しい数学は入れていない）。
    expect(cuts).toHaveLength(6);
    expect(cuts.map((e) => e.lines[0]?.amount)).toEqual(Array(6).fill(100000));
    // 費用の総額は購入額のまま・台帳は 0 で閉じる。
    expect(accountBalance(food.id, 'expense', derived)).toBe(1200000);
    expect(accountBalance(CONTINUOUS_COST_LEDGER_ACCOUNT_ID, 'asset', derived)).toBe(0);
  });

  it('部分回収 + 「終了日に全額」: 資産へ R・費用へ（残存 − R）・過去の刻みは不変', async () => {
    const { item, bank, food } = await setupEven();
    await archiveMonthlyCost({
      id: item.id,
      endDate: '2026-07-01',
      recoveries: [
        { destinationAccountId: bank.id, amount: 200000 },
        { destinationAccountId: food.id, amount: 400000 },
      ],
    });
    const after = await loadLedger();
    const recoveries = after.journalEntries.filter((e) => e.metadata?.monthlyCostRecovery === true);
    expect(recoveries).toHaveLength(2);
    expect(
      recoveries
        .map((e) => `${e.lines.find((l) => l.side === 'debit')!.accountId}:${e.lines[0]!.amount}`)
        .sort(),
    ).toEqual([`${bank.id}:200000`, `${food.id}:400000`].sort());
    const derived = reportEntriesForAsOf(after, '2027-12-31');
    expect(cutsOf(derived, item.id).map((e) => e.lines[0]?.amount)).toEqual(Array(6).fill(100000));
    // 費用 = 導出 600,000 + 第 2 振替 400,000。回収した 200,000 は預金へ戻る。台帳は 0。
    expect(accountBalance(food.id, 'expense', derived)).toBe(1000000);
    expect(accountBalance(CONTINUOUS_COST_LEDGER_ACCOUNT_ID, 'asset', derived)).toBe(0);
  });

  it('回収先は item の費用の行き先**以外**の費用科目を拒否する（保存境界の fail-closed）', async () => {
    const { item, food } = await setupEven();
    const other = (await loadLedger()).accounts.find(
      (a) => a.role === 'expense-category' && a.id !== food.id,
    )!;
    await expect(
      archiveMonthlyCost({
        id: item.id,
        endDate: '2026-07-01',
        recoveries: [{ destinationAccountId: other.id, amount: 100 }],
      }),
    ).rejects.toMatchObject({ code: 'error.monthlyCost.recoveryDestination' });
    // 終了日も回収も一切書かれていない（多段でも atomic）。
    const after = await loadLedger();
    expect(after.monthlyCostItems.find((m) => m.id === item.id)?.endDate).toBe('2027-01-01');
    expect(after.journalEntries.some((e) => e.metadata?.monthlyCostRecovery === true)).toBe(false);
  });

  it('回収の振替は普通の振替として編集・削除できる', async () => {
    const { item, bank } = await setup();
    await archiveMonthlyCost({
      id: item.id,
      endDate: '2026-06-15',
      recoveries: [{ destinationAccountId: bank.id, amount: 30000 }],
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
  it('開始日未設定なら createdAt より前の終了点も適法（過去へ開いた線分・§A 案1）', async () => {
    // 旧仕様（createdAt を暗黙開始点として endDate < createdAt を periodInvalid で拒否）は
    // 2026-08-11 に廃止。下限の検証は明示 startDate のみに一本化した。
    await loadLedger();
    const id = newId();
    await upsertAccount({
      id,
      name: '過去へ開いた線分',
      type: 'expense',
      role: 'expense-category',
      archived: true,
      endDate: '2098-12-31',
      createdAt: '2099-01-01T00:00:00.000Z',
      updatedAt: '2099-01-01T00:00:00.000Z',
    });
    const saved = (await loadLedger()).accounts.find((account) => account.id === id)!;
    expect(saved.startDate).toBeUndefined();
    expect(saved.endDate).toBe('2098-12-31');
    // 明示 startDate > endDate は従来どおり fail-closed（schema の superRefine）。
    await expect(
      upsertAccount({ ...saved, startDate: '2099-01-01', updatedAt: '2099-01-02T00:00:00.000Z' }),
    ).rejects.toMatchObject({ code: 'error.account.periodInvalid' });
  });

  it('残高 0 の資産は即アーカイブできる・残高ありは archiveBalance で拒否', async () => {
    const ledger = await loadLedger();
    const cash = ledger.accounts.find((a) => a.name === '現金')!;
    const food = ledger.accounts.find((a) => a.name === '変動費')!;
    // 残高 0 のまま → 即アーカイブ。
    await archiveAccount(cash.id);
    expect((await loadLedger()).accounts.find((a) => a.id === cash.id)?.archived).toBe(true);
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
    await expect(upsertAccount({ ...cash, archived: true, updatedAt: 'y2' })).rejects.toMatchObject(
      { code: 'error.account.archiveBalance' },
    );
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
    ).rejects.toMatchObject({ code: 'error.account.archiveCounterpartType' });
    const unchanged = await loadLedger();
    expect(unchanged.journalEntries.length).toBe(before.journalEntries.length);
    expect(unchanged.accounts.find((a) => a.id === bank.id)?.archived).toBe(false);
  });

  it('費用・収入は累計を残したままアーカイブでき、過去の集計額も変わらない', async () => {
    const ledger = await loadLedger();
    const cash = ledger.accounts.find((a) => a.name === '現金')!;
    const food = ledger.accounts.find((a) => a.name === '変動費')!;
    const income = ledger.accounts.find((a) => a.name === '給与')!;
    await upsertEntry(
      buildSimpleEntry({
        date: '2026-06-01',
        description: '支出',
        debitAccountId: food.id,
        creditAccountId: cash.id,
        amount: 500,
      }),
    );
    await upsertEntry(
      buildSimpleEntry({
        date: '2026-06-15',
        description: '収入',
        debitAccountId: cash.id,
        creditAccountId: income.id,
        amount: 1_000,
      }),
    );
    const before = await loadLedger();
    const expenseBefore = accountBalance(food.id, food.type, before.journalEntries);
    const incomeBefore = accountBalance(income.id, income.type, before.journalEntries);
    await archiveAccount(food.id);
    await archiveAccount(income.id);
    const after = await loadLedger();
    expect(after.accounts.find((a) => a.id === food.id)?.archived).toBe(true);
    expect(after.accounts.find((a) => a.id === income.id)?.archived).toBe(true);
    expect(accountBalance(food.id, food.type, after.journalEntries)).toBe(expenseBefore);
    expect(accountBalance(income.id, income.type, after.journalEntries)).toBe(incomeBefore);
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

  it('終了済みとの同名は未承認なら拒否し、承認すれば（アーカイブ）へ退避して保存する', async () => {
    await loadLedger();
    const ended = {
      id: newId(),
      name: '期間終了科目',
      type: 'asset' as const,
      role: 'daily-asset' as const,
      archived: true,
      startDate: '2019-01-01',
      endDate: '2020-01-01',
      createdAt: '2019-01-01T00:00:00.000Z',
      updatedAt: '2020-01-01T00:00:00.000Z',
    };
    await upsertAccount(ended);
    const newAcc = {
      id: newId(),
      name: ended.name,
      type: 'asset' as const,
      role: 'daily-asset' as const,
      archived: false,
      createdAt: 'x',
      updatedAt: 'x',
    };
    const e = await caught(upsertAccount(newAcc));
    expect(e.code).toBe('error.account.nameConflictArchived');
    // 承認つきで保存 → 終了済み側が退避される。
    await upsertAccount(newAcc, { renameArchivedConflicts: true });
    const after = await loadLedger();
    expect(after.accounts.find((a) => a.id === ended.id)?.name).toBe('期間終了科目（アーカイブ）');
    expect(after.accounts.find((a) => a.id === newAcc.id)?.name).toBe('期間終了科目');
    // 退避名も衝突したら（アーカイブ2）になる。
    await upsertAccount({
      ...newAcc,
      archived: true,
      startDate: '2019-01-01',
      endDate: '2020-01-01',
      updatedAt: 'z',
    });
    const newAcc2 = { ...newAcc, id: newId() };
    await upsertAccount(newAcc2, { renameArchivedConflicts: true });
    const last = await loadLedger();
    expect(last.accounts.find((a) => a.id === newAcc.id)?.name).toBe('期間終了科目（アーカイブ2）');
    expect(last.accounts.find((a) => a.id === newAcc2.id)?.name).toBe('期間終了科目');
  });

  it('未来に終了する同名科目は今日まだ有効なので退避許可つきでも拒否する', async () => {
    const ledger = await loadLedger();
    const cash = ledger.accounts.find((a) => a.name === '現金')!;
    await upsertAccount({
      ...cash,
      archived: true,
      startDate: '2020-01-01',
      endDate: '2099-12-31',
    });
    const duplicate = {
      id: newId(),
      name: cash.name,
      type: 'expense' as const,
      role: 'expense-category' as const,
      archived: false,
      createdAt: 'x',
      updatedAt: 'x',
    };

    await expect(upsertAccount(duplicate, { renameArchivedConflicts: true })).rejects.toMatchObject(
      { code: 'error.account.nameConflict' },
    );
    expect((await loadLedger()).accounts.find((a) => a.id === cash.id)?.name).toBe('現金');
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

  it('未来に終了する科目はexport日時点で有効なので同名importを拒否する', async () => {
    await loadLedger();
    const pkg = JSON.parse(exportToJsonText(await loadLedger()));
    const cash = pkg.accounts.find((a: { name: string }) => a.name === '現金');
    cash.name = '預金';
    cash.archived = true;
    cash.startDate = '2020-01-01';
    cash.endDate = '2099-12-31';

    const outcome = await importFromJsonText(JSON.stringify(pkg));
    expect(outcome.kind).toBe('validation-error');
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
    expect(
      (await loadLedger()).journalEntries.find((entry) => entry.id === adjustment!.id),
    ).toEqual(adjustment);
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
    expect(basisEntries.some((entry) => entry.metadata?.monthlyCostId === monthlyCost.id)).toBe(
      true,
    );
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
    const expectedVersion = {
      deviceId: ledger.meta.deviceId,
      revision: ledger.meta.revision,
    };
    await saveSnapshot(
      {
        id: makeSnapshotId(),
        createdAt: '2026-06-01T00:00:00.000Z',
        reason: 'restore',
        data: current,
      },
      expectedVersion,
    );
    await saveSnapshot(
      {
        id: makeSnapshotId(),
        createdAt: '2026-05-01T00:00:00.000Z',
        reason: 'import',
        data: { ...current, schemaVersion: (SCHEMA_VERSION - 1) as typeof SCHEMA_VERSION },
      },
      expectedVersion,
    );
    const pruned = await pruneIncompatibleSnapshots();
    expect(pruned).toBe(1);
    const remaining = await listSnapshots();
    expect(remaining).toHaveLength(1);
    expect(remaining[0]?.reason).toBe('restore');
  });
});

describe('「自由に動かせる」フラグ（Account.movable）の保存境界正規化', () => {
  it('movable: true は undefined へ正規化して保存する（既定 ON・レコード最小）', async () => {
    const ledger = await loadLedger();
    const cash = ledger.accounts.find((a) => a.name === '現金')!;
    await upsertAccount({ ...cash, movable: true, updatedAt: 'y' });
    const after = await loadLedger();
    const saved = after.accounts.find((a) => a.id === cash.id)! as unknown as Record<
      string,
      unknown
    >;
    expect('movable' in saved).toBe(false);
  });

  it('movable: false（daily-asset）は保存され、export → schema 検証も通る', async () => {
    const ledger = await loadLedger();
    const cash = ledger.accounts.find((a) => a.name === 'チャージ残高')!;
    await upsertAccount({ ...cash, movable: false, updatedAt: 'y' });
    const after = await loadLedger();
    expect(after.accounts.find((a) => a.id === cash.id)?.movable).toBe(false);
    const parsed = ledgerExportPackageSchema.safeParse(buildExportPackage(after));
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.accounts.find((a) => a.id === cash.id)?.movable).toBe(false);
    }
  });

  it('daily-asset 以外に付いた movable は保存境界で剥がす（fail-soft）', async () => {
    const ledger = await loadLedger();
    const card = ledger.accounts.find((a) => a.name === 'クレジットカード')!;
    await upsertAccount({ ...card, movable: false, updatedAt: 'y' });
    const after = await loadLedger();
    const saved = after.accounts.find((a) => a.id === card.id)! as unknown as Record<
      string,
      unknown
    >;
    expect('movable' in saved).toBe(false);
  });
});

describe('継続コスト購入の支払い元の緩和（RECURRING_POSTABLE_ROLES 全 role）', () => {
  it('支払い元 = 給与（income-category）で登録できる（健康保険 = 銀行→給与 型）', async () => {
    const ledger = await loadLedger();
    const salary = ledger.accounts.find((a) => a.name === '給与')!;
    const fixed = ledger.accounts.find((a) => a.name === '固定費')!;
    await createContinuousCost({
      name: '健康保険（単発）',
      amount: 48000,
      startDate: '2026-07-01',
      endDate: '2027-06-30',
      expenseAccountId: fixed.id,
      creditAccountId: salary.id,
    });
    const after = await loadLedger();
    const item = after.monthlyCostItems.find((m) => m.name === '健康保険（単発）')!;
    const purchase = after.journalEntries.find((e) => e.metadata?.monthlyCostId === item.id)!;
    expect(purchase.lines).toEqual([
      { accountId: CONTINUOUS_COST_LEDGER_ACCOUNT_ID, side: 'debit', amount: 48000 },
      { accountId: salary.id, side: 'credit', amount: 48000 },
    ]);
    expect(purchase.kind).toBe('normal'); // equity ではないので持ち込みにならない
    expect(ledgerExportPackageSchema.safeParse(buildExportPackage(after)).success).toBe(true);
  });

  it('支払い元 = 残高調整科目（system-adjustment）は fail-closed に拒否する', async () => {
    const ledger = await loadLedger();
    const fixed = ledger.accounts.find((a) => a.name === '固定費')!;
    const adjId = newId();
    await upsertAccount({
      id: adjId,
      name: '残高調整費',
      type: 'expense',
      role: 'system-adjustment',
      archived: false,
      createdAt: 'x',
      updatedAt: 'x',
    });
    await expect(
      createContinuousCost({
        name: '不正な支払い元',
        amount: 1000,
        startDate: '2026-07-01',
        expenseAccountId: fixed.id,
        creditAccountId: adjId,
      }),
    ).rejects.toMatchObject({ code: 'error.monthlyCost.paymentSource' });
  });

  it('購入の仕訳の編集でも貸方 = income-category を許す（ミラー検証の緩和）', async () => {
    const ledger = await loadLedger();
    const cash = ledger.accounts.find((a) => a.name === '現金')!;
    const salary = ledger.accounts.find((a) => a.name === '給与')!;
    const fixed = ledger.accounts.find((a) => a.name === '固定費')!;
    await createContinuousCost({
      name: '編集テスト',
      amount: 12000,
      startDate: '2026-07-01',
      endDate: '2027-06-30',
      expenseAccountId: fixed.id,
      creditAccountId: cash.id,
    });
    const mid = await loadLedger();
    const item = mid.monthlyCostItems.find((m) => m.name === '編集テスト')!;
    const purchase = mid.journalEntries.find((e) => e.metadata?.monthlyCostId === item.id)!;
    // 貸方を 給与 に付け替えて編集（借方 = 台帳は不変）。
    await upsertEntry({
      ...purchase,
      lines: [
        { accountId: CONTINUOUS_COST_LEDGER_ACCOUNT_ID, side: 'debit', amount: 12000 },
        { accountId: salary.id, side: 'credit', amount: 12000 },
      ],
      updatedAt: 'y',
    });
    const after = await loadLedger();
    const edited = after.journalEntries.find((e) => e.id === purchase.id)!;
    expect(edited.lines.find((l) => l.side === 'credit')?.accountId).toBe(salary.id);
    // item とのミラー（金額・日付）は維持される。
    const itemAfter = after.monthlyCostItems.find((m) => m.id === item.id)!;
    expect(itemAfter.amount).toBe(12000);
    expect(itemAfter.startDate).toBe(edited.date);
    expect(ledgerExportPackageSchema.safeParse(buildExportPackage(after)).success).toBe(true);
  });
});

describe('設定の保存境界（Codex 指摘・schema と保存の不整合）', () => {
  it('9 文字以上の通貨は保存境界で拒否する（保存できるのに export だけ後で失敗する状態を作らない）', async () => {
    const { updateSettings } = await import('../src/data/repository');
    const ledger = await loadLedger();
    await expect(
      updateSettings({ ...ledger.settings, currency: '123456789' }),
    ).rejects.toMatchObject({ code: 'error.settings.invalid' });
    // 8 文字ちょうどは通る（境界）。
    await updateSettings({ ...ledger.settings, currency: '12345678' });
    expect((await loadLedger()).settings.currency).toBe('12345678');
  });

  it('空または空白だけの台帳名・単位を保存境界で拒否する', async () => {
    const { updateSettings } = await import('../src/data/repository');
    const ledger = await loadLedger();
    await expect(updateSettings({ ...ledger.settings, currency: '' })).rejects.toMatchObject({
      code: 'error.settings.invalid',
    });
    await expect(updateSettings({ ...ledger.settings, ledgerName: '' })).rejects.toMatchObject({
      code: 'error.settings.invalid',
    });
    await expect(updateSettings({ ...ledger.settings, currency: '   ' })).rejects.toMatchObject({
      code: 'error.settings.invalid',
    });
    await expect(updateSettings({ ...ledger.settings, ledgerName: '   ' })).rejects.toMatchObject({
      code: 'error.settings.invalid',
    });
  });

  it('不正な表示桁数も保存境界で拒否する', async () => {
    const { updateSettings } = await import('../src/data/repository');
    const ledger = await loadLedger();
    await expect(
      updateSettings({
        ...ledger.settings,
        displayFractionDigits: 3 as unknown as 0 | 1 | 2,
      }),
    ).rejects.toMatchObject({ code: 'error.settings.invalid' });
  });

  it('保存境界を通した設定は export の schema 検証も必ず通る', async () => {
    const { updateSettings } = await import('../src/data/repository');
    const { exportToJsonText } = await import('../src/data/exportImport');
    const before = await loadLedger();
    await updateSettings({ ...before.settings, currency: 'USD', displayFractionDigits: 2 });
    const after = await loadLedger();
    expect(after.settings.currency).toBe('USD');
    expect(after.settings.displayFractionDigits).toBe(2);
    // export は現行 schema を通す（保存できたのに書き出せない、が起きない）。
    expect(() => exportToJsonText(after)).not.toThrow();
  });
});

describe('スナップショット reason の実行時境界', () => {
  it('未知の理由コードは保存と読み出しの両方で fail-closed', async () => {
    const { buildExportPackage } = await import('../src/data/exportImport');
    const { listSnapshots, makeSnapshotId, saveSnapshot } = await import('../src/data/repository');
    const ledger = await loadLedger();
    const invalid = {
      id: makeSnapshotId(),
      createdAt: '2026-08-13T00:00:00.000Z',
      reason: 'import前',
      data: buildExportPackage(ledger),
    };

    await expect(
      saveSnapshot(invalid as never, {
        deviceId: ledger.meta.deviceId,
        revision: ledger.meta.revision,
      }),
    ).rejects.toMatchObject({ code: 'error.snapshot.invalid' });

    // IDB 直接編集の壊れたレコードは**一覧を落とさない**（落とすと正常な復元ポイントも
    // 壊れた 1 件を消す削除ボタンも消え、残る出口が全消しだけになる）。
    // 表示は snapshotReasonLabel が生文字列のまま出す（fail-visible）。
    await putRecord(STORE.snapshots, invalid);
    const listed = await listSnapshots();
    expect(listed.some((s) => (s.reason as string) === 'import前')).toBe(true);
    expect(await getKv('meta')).toBeDefined();
  });
});
