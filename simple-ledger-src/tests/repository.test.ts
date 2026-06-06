import { describe, expect, it } from 'vitest';
import {
  deleteAccount,
  deleteEntry,
  listSnapshots,
  loadLedger,
  makeSnapshotId,
  resetAll,
  saveSnapshot,
  upsertEntry,
} from '../src/data/repository';
import { buildSimpleEntry } from '../src/domain/entry';
import { buildExportPackage } from '../src/data/exportImport';

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

    await resetAll();
    const after = await loadLedger();
    expect(after.journalEntries).toHaveLength(0);
    expect(after.accounts.length).toBeGreaterThan(0);
    expect(after.meta.revision).toBe(0); // 新しい meta で作り直されている
    expect(await listSnapshots()).toHaveLength(0); // snapshots も消える
  });
});
