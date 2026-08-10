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

function createVersion3WithLegacyStore(storeName: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 3);
    request.onupgradeneeded = () => {
      request.result.createObjectStore(storeName, { keyPath: 'id' });
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

describe('IndexedDB version 4 upgrade', () => {
  it('現行 STORE に無い旧ストアを upgrade transaction で削除する', async () => {
    const legacyStoreName = ['alloc', 'ations'].join('');
    _resetConnectionForTests();
    await deleteDatabase();
    await createVersion3WithLegacyStore(legacyStoreName);

    await loadLedger();
    _resetConnectionForTests();
    const inspected = await inspectDatabase();

    expect(inspected.version).toBe(DB_VERSION);
    expect(inspected.stores).not.toContain(legacyStoreName);
    expect(inspected.stores).toContain('accounts');
  });
});

describe('IndexedDB version 7 upgrade（予定キャッシュフローの全廃）', () => {
  it('旧 cashflowSchedules ストアを差分削除 upgrade で消す', async () => {
    // 旧版（予定 CF ストアあり）の DB を作り、現行版で開くと store ごと消える。
    const legacyStoreName = ['cashflow', 'Schedules'].join('');
    _resetConnectionForTests();
    await deleteDatabase();
    await createVersion3WithLegacyStore(legacyStoreName);

    await loadLedger();
    _resetConnectionForTests();
    const inspected = await inspectDatabase();

    expect(inspected.version).toBe(DB_VERSION);
    expect(inspected.stores).not.toContain(legacyStoreName);
    expect(inspected.stores).toContain('journalEntries');
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
