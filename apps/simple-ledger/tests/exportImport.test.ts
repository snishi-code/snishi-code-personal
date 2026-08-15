/*
 * import/export の統合テスト（fake-indexeddb 上）。
 * fail-closed・スナップショット・revision 競合の不変条件を検証する。
 */
import { describe, expect, it } from 'vitest';
import './setup';
import {
  createContinuousCost,
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
import { APP_ID, SCHEMA_VERSION } from '../src/domain/constants';

const removedLegacyMonthlyCostKey = ['monthly', 'Cost', 'Recognition'].join('');

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
    expect(snaps[0]?.reason).toBe('import'); // v11: reason は理由コード
  });

  it('廃止済みの分類印を未知キーとして strip し、旧 JSON の取り込みは受理する', async () => {
    const ledger = await seedWithEntry();
    const exported = JSON.parse(exportToJsonText(ledger)) as {
      journalEntries: Array<{ metadata?: Record<string, unknown> }>;
    };
    const first = exported.journalEntries[0]!;
    first.metadata = { ...first.metadata, [removedLegacyMonthlyCostKey]: true };

    const outcome = await importFromJsonText(JSON.stringify(exported));
    expect(outcome.kind).toBe('ok');
    expect((await loadLedger()).journalEntries[0]?.metadata).not.toHaveProperty(
      removedLegacyMonthlyCostKey,
    );
  });

  /*
   * 諸口 groupId（v12 で予約のみ）は保存・export・import の各境界を素通しする。
   * UI は未実装だが、境界のどこかが未知キーとして落とすと将来の実装時に
   * 「保存はできるのに export で消える」型の欠陥を静かに持ち込む。
   */
  it('groupId（v12 予約フィールド）は保存 → export → import で保持される', async () => {
    const ledger = await seedWithEntry();
    const cash = ledger.accounts.find((a) => a.name === '現金')!;
    const food = ledger.accounts.find((a) => a.name === '変動費')!;
    await upsertEntry({
      ...buildSimpleEntry({
        date: '2026-06-02',
        description: '諸口の 1 行目',
        debitAccountId: food.id,
        creditAccountId: cash.id,
        amount: 2500,
      }),
      id: 'grouped-entry',
      groupId: 'grp-2026-06-02',
    });

    // 1) 保存境界（schema 経由の parse）で剥がれない。
    const saved = (await loadLedger()).journalEntries.find((e) => e.id === 'grouped-entry');
    expect(saved?.groupId).toBe('grp-2026-06-02');

    // 2) export JSON に載る。
    const text = exportToJsonText(await loadLedger());
    expect(JSON.parse(text)).toMatchObject({
      journalEntries: expect.arrayContaining([
        expect.objectContaining({ id: 'grouped-entry', groupId: 'grp-2026-06-02' }),
      ]) as unknown,
    });

    // 3) import で戻ってくる（相互参照検証はしない = 1 行だけのグループも ok）。
    const outcome = await importFromJsonText(text, { force: true });
    expect(outcome.kind).toBe('ok');
    const imported = (await loadLedger()).journalEntries.find((e) => e.id === 'grouped-entry');
    expect(imported?.groupId).toBe('grp-2026-06-02');
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

  it('直前版 v11 のパッケージも unsupported-version で拒否される（単発変換が必須）', async () => {
    // v11 → v12 は allocationStartDate 撤去と ccr endDate の意味変更を伴うため、
    // 「1 つ前の版だから読めるだろう」を fail-closed で断つ。実データは
    // _workspace-management/scripts/convert-ledger-v11-to-v12.mjs で単発変換する。
    const before = await seedWithEntry();
    const pkg = buildExportPackage(before);
    const outcome = await importFromJsonText(
      JSON.stringify({ ...pkg, schemaVersion: SCHEMA_VERSION - 1 }),
    );
    expect(outcome.kind).toBe('unsupported-version');
    const after = await loadLedger();
    expect(after.journalEntries.length).toBe(before.journalEntries.length);
  });

  it('v7 パッケージ（schemaVersion 7）は unsupported-version で拒否される（後方互換なし）', async () => {
    const before = await seedWithEntry();
    const pkg = buildExportPackage(before);
    const outcome = await importFromJsonText(JSON.stringify({ ...pkg, schemaVersion: 7 }));
    expect(outcome.kind).toBe('unsupported-version');
    // 既存データは変更されない。
    const after = await loadLedger();
    expect(after.journalEntries.length).toBe(before.journalEntries.length);
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

describe('継続コスト資産の export/import', () => {
  it('継続コスト資産（購入の仕訳つき）を含む台帳を round-trip できる', async () => {
    const ledger = await loadLedger();
    const cash = ledger.accounts.find((a) => a.name === '現金')!;
    const food = ledger.accounts.find((a) => a.name === '変動費')!;
    await createContinuousCost({
      name: '年払いクラウド',
      amount: 12000,
      startDate: '2026-06-15',
      endDate: '2027-05-31',
      expenseAccountId: food.id,
      creditAccountId: cash.id,
    });
    const seeded = await loadLedger();
    expect(seeded.monthlyCostItems).toHaveLength(1);
    const text = exportToJsonText(seeded);
    const outcome = await importFromJsonText(text);
    expect(outcome.kind).toBe('ok');
    const reloaded = await loadLedger();
    expect(reloaded.monthlyCostItems).toHaveLength(1);
    expect(reloaded.monthlyCostItems[0]).toMatchObject({ name: '年払いクラウド', amount: 12000 });
    // 購入の仕訳（monthlyCostId）も round-trip される。
    expect(
      reloaded.journalEntries.some(
        (e) => e.metadata?.monthlyCostId === reloaded.monthlyCostItems[0]!.id,
      ),
    ).toBe(true);
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

  /*
   * 版上げのたびに旧版スナップショットは復元不能になる（migration チェーンが空）。
   * これは起動時剪定（pruneIncompatibleSnapshots）の前提なので、版に依存しない形で
   * 「1 つ前の版は前進できない」を固定する。
   */
  it('旧版（現行 - 1）のスナップショットは現行版へ前進できず復元しない', async () => {
    const before = await seedWithEntry();
    const stale = { ...buildExportPackage(before), schemaVersion: SCHEMA_VERSION - 1 };
    await expect(restoreFromSnapshot(stale)).rejects.toThrow();
    const after = await loadLedger();
    expect(after.journalEntries.length).toBe(before.journalEntries.length);
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

  it('schemaVersion 12 で、廃止済みフィールドを含まない', async () => {
    const ledger = await seedWithEntry();
    const pkg = buildExportPackage(ledger);
    expect(pkg.schemaVersion).toBe(SCHEMA_VERSION);
    expect(pkg.schemaVersion).toBe(12);
    expect(pkg).not.toHaveProperty('cashflowSchedules');
    // v10 で撤去した CSV 取込の 3 配列も含まない。
    expect(pkg).not.toHaveProperty('importProfiles');
    expect(pkg).not.toHaveProperty('profileBindings');
    expect(pkg).not.toHaveProperty('importDecisions');
    // 文字列化した export JSON にも痕跡が残らない。
    const parsed = JSON.parse(exportToJsonText(ledger)) as Record<string, unknown>;
    expect(Object.keys(parsed)).not.toContain('cashflowSchedules');
    expect(Object.keys(parsed)).not.toContain('importProfiles');
    expect(Object.keys(parsed)).not.toContain('profileBindings');
    expect(Object.keys(parsed)).not.toContain('importDecisions');
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
    expect(after.tags.length).toBeGreaterThanOrEqual(1);
    // 再読込しても永続化されている。
    const reloaded = await loadLedger();
    expect(reloaded.journalEntries.length).toBe(after.journalEntries.length);
  });
});
