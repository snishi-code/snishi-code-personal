import { describe, expect, it } from 'vitest';
import './setup';
import { DB_NAME, DB_VERSION, SCHEMA_VERSION } from '../src/data/constants';
import { _resetConnectionForTests, getKv, putKv } from '../src/data/db';
import { loadLedger } from '../src/data/repository';
import { LedgerError } from '../src/domain/errors';
import type { LedgerMeta } from '../src/domain/types';

function deleteDatabase(): Promise<void> {
  return new Promise((resolve) => {
    const request = indexedDB.deleteDatabase(DB_NAME);
    request.onsuccess = () => resolve();
    request.onerror = () => resolve();
    request.onblocked = () => resolve();
  });
}

function createVersion3WithLegacyStore(
  storeName: string,
  record?: Record<string, unknown>,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 3);
    request.onupgradeneeded = () => {
      const store = request.result.createObjectStore(storeName, { keyPath: 'id' });
      if (record) store.put(record);
    };
    request.onerror = () => reject(request.error ?? new Error('v3 DB の作成に失敗しました'));
    request.onsuccess = () => {
      request.result.close();
      resolve();
    };
  });
}

function inspectDatabase(): Promise<{ version: number; stores: string[] }> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME);
    request.onerror = () => reject(request.error ?? new Error('DB の確認に失敗しました'));
    request.onsuccess = () => {
      const database = request.result;
      const result = {
        version: database.version,
        stores: Array.from(database.objectStoreNames),
      };
      database.close();
      resolve(result);
    };
  });
}

function readLegacyRecord(storeName: string, key: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME);
    request.onerror = () => reject(request.error ?? new Error('DB の確認に失敗しました'));
    request.onsuccess = () => {
      const database = request.result;
      const tx = database.transaction(storeName, 'readonly');
      const get = tx.objectStore(storeName).get(key);
      get.onsuccess = () => {
        database.close();
        resolve(get.result);
      };
      get.onerror = () => {
        database.close();
        reject(get.error ?? new Error('レガシーストアの読み取りに失敗しました'));
      };
    };
  });
}

describe('IndexedDB upgrade は未知の store を温存する（黙って消さない・監査 P1-1）', () => {
  it('旧 cashflowSchedules ストアとその中身が upgrade 後も残る', async () => {
    // 旧版（予定 CF ストアあり）の DB を現行版で開いても、store は消えない。
    // 旧版データは復旧面の「DB 初期化」（wipeDatabase = deleteDatabase）でのみ消える＝
    // 復旧面に着く前に upgrade がデータを失わせない。
    const legacyStoreName = ['cashflow', 'Schedules'].join('');
    const legacyRecord = { id: 'cf-1', amount: 1000 };
    _resetConnectionForTests();
    await deleteDatabase();
    await createVersion3WithLegacyStore(legacyStoreName, legacyRecord);

    await loadLedger();
    _resetConnectionForTests();
    const inspected = await inspectDatabase();

    expect(inspected.version).toBe(DB_VERSION);
    expect(inspected.stores).toContain(legacyStoreName);
    expect(inspected.stores).toContain('journalEntries');
    expect(inspected.stores).toContain('accounts');
    await expect(readLegacyRecord(legacyStoreName, 'cf-1')).resolves.toEqual(legacyRecord);
  });

  it('現行 STORE に無い旧ストアも同様に温存し、不足ストアだけを作る', async () => {
    const legacyStoreName = ['alloc', 'ations'].join('');
    _resetConnectionForTests();
    await deleteDatabase();
    await createVersion3WithLegacyStore(legacyStoreName);

    await loadLedger();
    _resetConnectionForTests();
    const inspected = await inspectDatabase();

    expect(inspected.version).toBe(DB_VERSION);
    expect(inspected.stores).toContain(legacyStoreName);
    expect(inspected.stores).toContain('accounts');
  });
});

describe('旧 schemaVersion の DB は復旧導線へ送る（fail-closed）', () => {
  it('meta.schemaVersion=6 の DB で起動すると schemaVersionMismatch の LedgerError になる', async () => {
    // 現行版で初期化してから meta の版だけを v6 相当へ戻す（後方互換をコードで持たない＝
    // 読み替えず assertSchemaVersionCurrent が止めて、復旧画面の専用導線へ送る）。
    await loadLedger();
    const meta = (await getKv<LedgerMeta>('meta'))!;
    expect(meta.schemaVersion).toBe(SCHEMA_VERSION);
    await putKv('meta', { ...meta, schemaVersion: 6 });

    let caught: unknown;
    try {
      await loadLedger();
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(LedgerError);
    expect((caught as LedgerError).code).toBe('error.db.schemaVersionMismatch');
  });
});

describe('v10 物理 DB からの v11 移行（指示書v3 §A-5・Codex 指摘の一気通し）', () => {
  it('実レコード込みの v10 DB を v11 で開いてもデータは温存され、loadLedger は復旧面へ送る。wipe → 変換済み v11 import で復帰する', async () => {
    const { STORE } = await import('../src/data/db');
    const { importFromJsonText } = await import('../src/data/exportImport');
    const { APP_ID } = await import('../src/data/constants');

    // 1) v10 の物理 DB を実レコード込みで作る（meta.schemaVersion=10）。
    await deleteDatabase();
    _resetConnectionForTests();
    await new Promise<void>((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, 10);
      request.onupgradeneeded = () => {
        const database = request.result;
        for (const name of Object.values(STORE)) {
          if (!database.objectStoreNames.contains(name)) {
            database.createObjectStore(name);
          }
        }
      };
      request.onerror = () => reject(request.error ?? new Error('v10 DB の作成に失敗'));
      request.onsuccess = () => {
        const database = request.result;
        const tx = database.transaction(
          [STORE.kv, STORE.accounts, STORE.journalEntries],
          'readwrite',
        );
        tx.objectStore(STORE.kv).put(
          {
            id: 'ledger',
            schemaVersion: 10,
            revision: 3,
            deviceId: 'dev-v10',
            createdAt: '2026-01-01T00:00:00.000Z',
            updatedAt: '2026-01-01T00:00:00.000Z',
          },
          'meta',
        );
        tx.objectStore(STORE.accounts).put(
          {
            id: 'acc-v10',
            name: '旧現金',
            type: 'asset',
            role: 'daily-asset',
            archived: false,
            createdAt: 'x',
            updatedAt: 'x',
          },
          'acc-v10',
        );
        tx.objectStore(STORE.journalEntries).put(
          {
            id: 'e-v10',
            date: '2026-01-05',
            description: '旧仕訳',
            kind: 'normal',
            lines: [
              { accountId: 'acc-v10', side: 'debit', amount: 100 },
              { accountId: 'acc-v10', side: 'credit', amount: 100 },
            ],
            createdAt: 'x',
            updatedAt: 'x',
          },
          'e-v10',
        );
        tx.oncomplete = () => {
          database.close();
          resolve();
        };
        tx.onerror = () => reject(tx.error ?? new Error('v10 レコード投入に失敗'));
      };
    });

    // 2) v11（DB_VERSION 11）で開く: store とレコードは温存される（黙って消さない）。
    _resetConnectionForTests();
    await expect(loadLedger()).rejects.toMatchObject({
      code: 'error.db.schemaVersionMismatch',
    });
    const inspected = await inspectDatabase();
    expect(inspected.version).toBe(DB_VERSION);
    expect(inspected.stores).toContain(STORE.journalEntries);
    // 温存の実確認（meta が旧版のまま残っている = データに触っていない）。
    const meta = await getKv<LedgerMeta>('meta');
    expect(meta?.schemaVersion).toBe(10);

    // 3) 復旧面の手順 = DB 初期化（wipe）→ 変換済み v11 JSON を import。
    await deleteDatabase();
    _resetConnectionForTests();
    const converted = {
      appId: APP_ID,
      schemaVersion: SCHEMA_VERSION,
      ledgerId: 'ledger',
      exportedAt: '2026-08-13T00:00:00.000Z',
      deviceId: 'dev-v10',
      revision: 3,
      accounts: [
        {
          id: 'acc-v10',
          name: '旧現金',
          type: 'asset',
          role: 'daily-asset',
          archived: false,
          createdAt: 'x',
          updatedAt: 'x',
        },
      ],
      journalEntries: [
        {
          id: 'e-v10',
          date: '2026-01-05',
          description: '旧仕訳',
          kind: 'normal',
          lines: [
            { accountId: 'acc-v10', side: 'debit', amount: 10000 },
            { accountId: 'acc-v10', side: 'credit', amount: 10000 },
          ],
          createdAt: 'x',
          updatedAt: 'x',
        },
      ],
      tags: [],
      monthlyCostItems: [],
      recurringRules: [],
      settings: { ledgerName: '家計簿', currency: '円', displayFractionDigits: 0 as const },
    };
    const outcome = await importFromJsonText(JSON.stringify(converted), { force: true });
    expect(outcome.kind).toBe('ok');
    const ledger = await loadLedger();
    expect(ledger.journalEntries.find((e) => e.id === 'e-v10')?.lines[0]?.amount).toBe(10000);
  });
});
