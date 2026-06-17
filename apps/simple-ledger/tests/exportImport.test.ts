/*
 * import/export の統合テスト（fake-indexeddb 上）。
 * fail-closed・スナップショット・revision 競合の不変条件を検証する。
 */
import { describe, expect, it } from 'vitest';
import './setup';
import {
  createAllocation,
  createMonthlyCost,
  loadLedger,
  upsertEntry,
  listSnapshots,
} from '../src/data/repository';
import {
  buildExportPackage,
  exportToJsonText,
  importFromJsonText,
  loadSampleFixture,
  restoreFromSnapshot,
} from '../src/data/exportImport';
import { buildSimpleEntry } from '../src/domain/entry';
import { APP_ID } from '../src/domain/constants';

async function seedWithEntry() {
  const ledger = await loadLedger(); // 既定科目を投入
  const cash = ledger.accounts.find((a) => a.name === '現金')!;
  const food = ledger.accounts.find((a) => a.name === '変動費')!;
  await upsertEntry(
    buildSimpleEntry({
      date: '2026-06-01',
      description: 'ランチ',
      debitAccountId: food.id,
      creditAccountId: cash.id,
      amount: 1000,
    }),
  );
  return loadLedger();
}

describe('export/import round trip', () => {
  it('有効な JSON を取り込める（ok）', async () => {
    const ledger = await seedWithEntry();
    const text = exportToJsonText(ledger);
    const outcome = await importFromJsonText(text);
    expect(outcome.kind).toBe('ok');
    if (outcome.kind === 'ok') {
      expect(outcome.counts.entries).toBe(1);
    }
  });

  it('取り込み成功時に import 前スナップショットが作られる', async () => {
    const ledger = await seedWithEntry();
    const text = exportToJsonText(ledger);
    await importFromJsonText(text);
    const snaps = await listSnapshots();
    expect(snaps.length).toBeGreaterThan(0);
    expect(snaps[0]?.reason).toBe('import前');
  });
});

describe('fail-closed', () => {
  it('壊れた JSON は取り込まれず、既存データを保持する', async () => {
    const before = await seedWithEntry();
    const outcome = await importFromJsonText('{ this is not json');
    expect(outcome.kind).toBe('parse-error');
    const after = await loadLedger();
    expect(after.journalEntries.length).toBe(before.journalEntries.length);
  });

  it('別アプリのファイルは not-our-file', async () => {
    await seedWithEntry();
    const outcome = await importFromJsonText(JSON.stringify({ appId: 'other', schemaVersion: 1 }));
    expect(outcome.kind).toBe('not-our-file');
  });

  it('スキーマ違反（借方≠貸方）は validation-error、既存データ保持', async () => {
    const ledger = await seedWithEntry();
    const pkg = buildExportPackage(ledger);
    pkg.journalEntries.push({
      id: 'bad',
      date: '2026-06-02',
      description: 'broken',
      kind: 'normal',
      managementScopeId: 'scope-personal',
      lines: [
        { accountId: 'a', side: 'debit', amount: 100 },
        { accountId: 'b', side: 'credit', amount: 90 },
      ],
      createdAt: 'x',
      updatedAt: 'x',
    });
    const outcome = await importFromJsonText(JSON.stringify(pkg));
    expect(outcome.kind).toBe('validation-error');
    const after = await loadLedger();
    expect(after.journalEntries.some((e) => e.id === 'bad')).toBe(false);
  });

  it('未対応の新しいスキーマ版は unsupported-version（too-new）', async () => {
    const ledger = await seedWithEntry();
    const pkg = buildExportPackage(ledger);
    const outcome = await importFromJsonText(
      JSON.stringify({ ...pkg, schemaVersion: pkg.schemaVersion + 1 }),
    );
    expect(outcome.kind).toBe('unsupported-version');
  });

  it('v1 アプリのファイル（appId=snishi-code.simple-ledger）は not-our-file（識別子分離・仕様§7）', async () => {
    await seedWithEntry();
    // v1 の最終版 (schemaVersion 16) でも appId 不一致で fail-closed に拒否される
    // （v2 はレガシー migration を持たない＝v1 ファイルを変換して取り込むこともしない）。
    const outcome = await importFromJsonText(
      JSON.stringify({ appId: 'snishi-code.simple-ledger', schemaVersion: 16 }),
    );
    expect(outcome.kind).toBe('not-our-file');
  });
});

describe('revision 競合', () => {
  it('封筒 revision が現在と異なると revision-conflict、force で上書き', async () => {
    const ledger = await seedWithEntry();
    const text = exportToJsonText(ledger); // 封筒 revision = 現在の rev

    // ローカルをさらに編集して rev を進める
    const cash = ledger.accounts.find((a) => a.name === '現金')!;
    const salary = ledger.accounts.find((a) => a.name === '給与')!;
    await upsertEntry(
      buildSimpleEntry({
        date: '2026-06-05',
        description: '給料',
        debitAccountId: cash.id,
        creditAccountId: salary.id,
        amount: 300000,
      }),
    );

    const conflict = await importFromJsonText(text);
    expect(conflict.kind).toBe('revision-conflict');

    const forced = await importFromJsonText(text, { force: true });
    expect(forced.kind).toBe('ok');
    // 古い版で上書きされ、給料の仕訳は消えている（自動マージしない）
    const after = await loadLedger();
    expect(after.journalEntries.some((e) => e.description === '給料')).toBe(false);
    expect(after.journalEntries.some((e) => e.description === 'ランチ')).toBe(true);
  });
});

describe('月額化コストの export/import', () => {
  it('月額化コストを含む台帳を round-trip できる', async () => {
    const ledger = await loadLedger();
    const cash = ledger.accounts.find((a) => a.name === '現金')!;
    const food = ledger.accounts.find((a) => a.name === '変動費')!;
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
    const seeded = await loadLedger();
    expect(seeded.monthlyCostItems).toHaveLength(1);
    const text = exportToJsonText(seeded);
    const outcome = await importFromJsonText(text);
    expect(outcome.kind).toBe('ok');
    const reloaded = await loadLedger();
    expect(reloaded.monthlyCostItems).toHaveLength(1);
    expect(reloaded.monthlyCostItems[0]).toMatchObject({ name: 'Netflix', amount: 1500 });
  });
});

describe('restoreFromSnapshot（fail-closed）', () => {
  it('有効なスナップショットを復元できる', async () => {
    const ledger = await seedWithEntry();
    const snap = buildExportPackage(ledger);
    // いったん別の編集をしてから復元する。
    const cash = ledger.accounts.find((a) => a.name === '現金')!;
    const salary = ledger.accounts.find((a) => a.name === '給与')!;
    await upsertEntry(
      buildSimpleEntry({
        date: '2026-06-05',
        description: '給料',
        debitAccountId: cash.id,
        creditAccountId: salary.id,
        amount: 300000,
      }),
    );
    const restored = await restoreFromSnapshot(snap);
    expect(restored.journalEntries.some((e) => e.description === 'ランチ')).toBe(true);
    expect(restored.journalEntries.some((e) => e.description === '給料')).toBe(false);
  });

  it('壊れたスナップショットは復元せず既存データを保持する（throw）', async () => {
    const before = await seedWithEntry();
    const beforeCount = before.journalEntries.length;
    const broken = buildExportPackage(before);
    // 借方≠貸方の不正仕訳を混ぜる。
    broken.journalEntries.push({
      id: 'bad',
      date: '2026-06-02',
      description: 'broken',
      kind: 'normal',
      managementScopeId: 'scope-personal',
      lines: [
        { accountId: 'a', side: 'debit', amount: 100 },
        { accountId: 'b', side: 'credit', amount: 90 },
      ],
      createdAt: 'x',
      updatedAt: 'x',
    });
    await expect(restoreFromSnapshot(broken)).rejects.toThrow();
    const after = await loadLedger();
    expect(after.journalEntries.some((e) => e.id === 'bad')).toBe(false);
    expect(after.journalEntries.length).toBe(beforeCount);
  });
});

describe('export package 形状', () => {
  it('必須フィールドを含む', async () => {
    const ledger = await seedWithEntry();
    const pkg = buildExportPackage(ledger);
    expect(pkg.appId).toBe(APP_ID);
    expect(pkg).toHaveProperty('schemaVersion');
    expect(pkg).toHaveProperty('ledgerId');
    expect(pkg).toHaveProperty('exportedAt');
    expect(pkg).toHaveProperty('deviceId');
    expect(pkg).toHaveProperty('revision');
    expect(pkg).toHaveProperty('settings');
  });
});

describe('按分支出の export/import', () => {
  async function seedWithAllocation() {
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
    return loadLedger();
  }

  it('按分支出を含む台帳を round-trip できる（allocations と関連仕訳を保持）', async () => {
    const ledger = await seedWithAllocation();
    expect(ledger.allocations).toHaveLength(1);
    const text = exportToJsonText(ledger);
    const outcome = await importFromJsonText(text);
    expect(outcome.kind).toBe('ok');
    const reloaded = await loadLedger();
    expect(reloaded.allocations).toHaveLength(1);
    // 1 source + 3 recognition
    expect(reloaded.journalEntries).toHaveLength(4);
  });

  it('壊れた按分参照（存在しない費用科目）は validation-error', async () => {
    const ledger = await seedWithAllocation();
    const pkg = buildExportPackage(ledger);
    pkg.allocations[0]!.expenseAccountId = 'nope';
    const outcome = await importFromJsonText(JSON.stringify(pkg));
    expect(outcome.kind).toBe('validation-error');
  });
});

describe('テスト用フィクスチャ（loadSampleFixture）', () => {
  it('空DBに sample.json を投入し、通常の台帳として読める', async () => {
    const before = await loadLedger(); // 既定科目のみ（空）
    expect(before.journalEntries).toHaveLength(0);

    const after = await loadSampleFixture();
    // sample.json の中身が IndexedDB 正本として入る。
    expect(after.journalEntries.length).toBeGreaterThanOrEqual(15);
    expect(after.monthlyCostItems.length).toBeGreaterThanOrEqual(1);
    expect(after.reserves.length).toBeGreaterThanOrEqual(1);
    expect(after.tags.length).toBeGreaterThanOrEqual(1);
    // 集約モデル: reserve-asset 科目は単一の集約口座『取り置き資金』。目的名（旅行資金）は ReserveItem 側。
    expect(
      after.accounts.some((a) => a.name === '取り置き資金' && a.role === 'reserve-asset'),
    ).toBe(true);
    expect(after.reserves.some((r) => r.name === '旅行資金')).toBe(true);
    // 再読込しても永続化されている。
    const reloaded = await loadLedger();
    expect(reloaded.journalEntries.length).toBe(after.journalEntries.length);
  });
});
