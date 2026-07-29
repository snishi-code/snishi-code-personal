import { describe, expect, it } from 'vitest';
import './setup';
import { DB_NAME, DB_VERSION } from '../src/data/constants';
import { _resetConnectionForTests } from '../src/data/db';
import { loadLedger } from '../src/data/repository';

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
