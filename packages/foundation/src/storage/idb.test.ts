import { afterEach, describe, expect, it } from 'vitest';
import { createDatabase, type DatabaseHandle } from './idb';

let seq = 0;
const handles: Array<{ name: string; handle: DatabaseHandle }> = [];

function makeHandle(version = 1): { name: string; handle: DatabaseHandle } {
  const name = `idb-test-${++seq}`;
  const handle = createDatabase({
    name,
    version,
    upgrade: (db) => {
      if (!db.objectStoreNames.contains('items')) {
        db.createObjectStore('items', { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains('extras')) {
        db.createObjectStore('extras', { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains('kv')) {
        db.createObjectStore('kv');
      }
    },
  });
  const entry = { name, handle };
  handles.push(entry);
  return entry;
}

function deleteDb(name: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.deleteDatabase(name);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

afterEach(async () => {
  for (const { name, handle } of handles.splice(0)) {
    handle._resetForTests();
    await deleteDb(name);
  }
});

describe('storage/idb', () => {
  it('put/get/getAll/deleteRecord と kv の roundtrip ができる', async () => {
    const { handle } = makeHandle();
    await handle.put('items', { id: 'a', value: 1 });
    await handle.put('items', { id: 'b', value: 2 });
    expect(await handle.get('items', 'a')).toEqual({ id: 'a', value: 1 });
    expect(await handle.get('items', 'none')).toBeUndefined();
    expect(await handle.getAll('items')).toHaveLength(2);

    await handle.deleteRecord('items', 'a');
    expect(await handle.getAll('items')).toEqual([{ id: 'b', value: 2 }]);

    await handle.putKv('kv', 'meta', { revision: 7 });
    expect(await handle.getKv('kv', 'meta')).toEqual({ revision: 7 });
    expect(await handle.getKv('kv', 'none')).toBeUndefined();
  });

  it('runWrite は複数ストアを原子的に書く(成功時)', async () => {
    const { handle } = makeHandle();
    await handle.runWrite(['items', 'extras'], (tx) => {
      tx.objectStore('items').put({ id: 'i1' });
      tx.objectStore('extras').put({ id: 'e1' });
    });
    expect(await handle.getAll('items')).toHaveLength(1);
    expect(await handle.getAll('extras')).toHaveLength(1);
  });

  it('runWrite の途中 throw で両ストアとも未反映になる', async () => {
    const { handle } = makeHandle();
    await expect(
      handle.runWrite(['items', 'extras'], (tx) => {
        tx.objectStore('items').put({ id: 'i1' });
        tx.objectStore('extras').put({ id: 'e1' });
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    expect(await handle.getAll('items')).toEqual([]);
    expect(await handle.getAll('extras')).toEqual([]);
  });

  it('runWrite はリクエストエラー(add 重複)でも両ストアとも未反映になる', async () => {
    const { handle } = makeHandle();
    await handle.put('items', { id: 'dup' });
    await expect(
      handle.runWrite(['items', 'extras'], (tx) => {
        tx.objectStore('extras').put({ id: 'e1' });
        tx.objectStore('items').add({ id: 'dup' });
      }),
    ).rejects.toThrow();
    expect(await handle.getAll('extras')).toEqual([]);
    expect(await handle.getAll('items')).toEqual([{ id: 'dup' }]);
  });

  it('onversionchange で自接続を閉じ deleteDatabase をブロックせず、その後の再 open ができる', async () => {
    const { name, handle } = makeHandle();
    await handle.put('items', { id: 'a' });
    // 接続を開いたまま deleteDatabase: onversionchange の自動 close が無いと永久に blocked。
    await deleteDb(name);
    // 接続キャッシュが破棄されているので、次の操作は新規 open(upgrade から)になる。
    expect(await handle.getAll('items')).toEqual([]);
    await handle.put('items', { id: 'b' });
    expect(await handle.getAll('items')).toEqual([{ id: 'b' }]);
  });
});
