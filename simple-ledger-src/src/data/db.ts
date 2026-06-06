/*
 * IndexedDB の薄いラッパ（外部依存なし・外部送信なし）。
 *
 * 実行時の正本は IndexedDB。ここはストアの開閉と基本 CRUD だけを提供し、
 * ドメインの意味づけは repository.ts に置く。
 */

export const DB_NAME = 'simple-ledger';
export const DB_VERSION = 2; // v2: allocations ストアを追加

export const STORE = {
  kv: 'kv', // meta / settings の単一レコード置き場（out-of-line key）
  accounts: 'accounts',
  journalEntries: 'journalEntries',
  allocations: 'allocations',
  snapshots: 'snapshots',
} as const;

export type StoreName = (typeof STORE)[keyof typeof STORE];

function promisify<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('IndexedDB request failed'));
  });
}

let dbPromise: Promise<IDBDatabase> | null = null;
let dbInstance: IDBDatabase | null = null;

export function openDB(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE.kv)) db.createObjectStore(STORE.kv);
      if (!db.objectStoreNames.contains(STORE.accounts)) {
        db.createObjectStore(STORE.accounts, { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains(STORE.journalEntries)) {
        const s = db.createObjectStore(STORE.journalEntries, { keyPath: 'id' });
        s.createIndex('date', 'date', { unique: false });
      }
      // v2 で追加。既存 DB の upgrade でも作られる。
      if (!db.objectStoreNames.contains(STORE.allocations)) {
        db.createObjectStore(STORE.allocations, { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains(STORE.snapshots)) {
        db.createObjectStore(STORE.snapshots, { keyPath: 'id' });
      }
    };
    req.onsuccess = () => {
      dbInstance = req.result;
      resolve(req.result);
    };
    req.onerror = () => reject(req.error ?? new Error('IndexedDB open failed'));
  });
  return dbPromise;
}

/** テスト用: 接続を閉じてキャッシュを破棄する（deleteDatabase が blocked にならないように）。 */
export function _resetConnectionForTests(): void {
  dbInstance?.close();
  dbInstance = null;
  dbPromise = null;
}

async function tx(stores: StoreName[], mode: IDBTransactionMode): Promise<IDBTransaction> {
  const db = await openDB();
  return db.transaction(stores, mode);
}

export async function getAll<T>(store: StoreName): Promise<T[]> {
  const t = await tx([store], 'readonly');
  return promisify(t.objectStore(store).getAll() as IDBRequest<T[]>);
}

export async function getKv<T>(key: string): Promise<T | undefined> {
  const t = await tx([STORE.kv], 'readonly');
  return promisify(t.objectStore(STORE.kv).get(key) as IDBRequest<T | undefined>);
}

export async function putKv<T>(key: string, value: T): Promise<void> {
  const t = await tx([STORE.kv], 'readwrite');
  t.objectStore(STORE.kv).put(value, key);
  await txDone(t);
}

export async function putRecord<T>(store: StoreName, value: T): Promise<void> {
  const t = await tx([store], 'readwrite');
  t.objectStore(store).put(value);
  await txDone(t);
}

export async function deleteRecord(store: StoreName, id: string): Promise<void> {
  const t = await tx([store], 'readwrite');
  t.objectStore(store).delete(id);
  await txDone(t);
}

export async function clearStore(store: StoreName): Promise<void> {
  const t = await tx([store], 'readwrite');
  t.objectStore(store).clear();
  await txDone(t);
}

/** 複数ストアをまたいだ書き込みを 1 トランザクションで行う（import の原子性に使う）。 */
export async function runWrite(
  stores: StoreName[],
  fn: (t: IDBTransaction) => void,
): Promise<void> {
  const t = await tx(stores, 'readwrite');
  fn(t);
  await txDone(t);
}

export function txDone(t: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    t.oncomplete = () => resolve();
    t.onerror = () => reject(t.error ?? new Error('IndexedDB transaction failed'));
    t.onabort = () => reject(t.error ?? new Error('IndexedDB transaction aborted'));
  });
}
