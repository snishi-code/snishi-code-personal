// 移植元: simple-ledger src/data/db.ts の汎用化(DB 名/version/upgrade をアプリ注入に変更)

export interface DbConfig {
  name: string;
  version: number;
  /** version-change トランザクション内で呼ばれる。store 作成/削除はここだけで行う。 */
  upgrade: (db: IDBDatabase, oldVersion: number, tx: IDBTransaction) => void;
}

export interface DatabaseHandle {
  open(): Promise<IDBDatabase>;
  getAll<T>(store: string): Promise<T[]>;
  get<T>(store: string, key: IDBValidKey): Promise<T | undefined>;
  put<T>(store: string, value: T): Promise<void>;
  deleteRecord(store: string, key: IDBValidKey): Promise<void>;
  /** out-of-line key の store(kv 用)から読む。 */
  getKv<T>(store: string, key: string): Promise<T | undefined>;
  /** out-of-line key の store(kv 用)へ書く。 */
  putKv<T>(store: string, key: string, value: T): Promise<void>;
  /** 複数ストアを 1 トランザクションで書く(import 置換などの原子性に使う)。 */
  runWrite(stores: string[], fn: (tx: IDBTransaction) => void): Promise<void>;
  close(): void;
  _resetForTests(): void;
}

// エラーは必ず reject に変換する(握りつぶすと呼び出し側が成功と誤認する = fail-open)。
function promisify<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('IndexedDB request failed'));
  });
}

// onabort も reject する(途中失敗のトランザクションを完了扱いにしない)。
export function txDone(t: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    t.oncomplete = () => resolve();
    t.onerror = () => reject(t.error ?? new Error('IndexedDB transaction failed'));
    t.onabort = () => reject(t.error ?? new Error('IndexedDB transaction aborted'));
  });
}

export function createDatabase(config: DbConfig): DatabaseHandle {
  // 接続は singleton promise(同時 open の競合を防ぐ)。
  let dbPromise: Promise<IDBDatabase> | null = null;
  let dbInstance: IDBDatabase | null = null;

  function open(): Promise<IDBDatabase> {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
      const req = indexedDB.open(config.name, config.version);
      req.onupgradeneeded = (ev) => {
        const vtx = req.transaction;
        if (vtx) config.upgrade(req.result, ev.oldVersion, vtx);
      };
      req.onsuccess = () => {
        const db = req.result;
        // 別タブ/別接続の version 変更・deleteDatabase 要求時に自接続を閉じて解放する。
        // 閉じないと相手が onblocked で永久に進まない。promise も捨てて次回 open で再接続。
        db.onversionchange = () => {
          try {
            db.close();
          } catch {
            /* 既に閉じていれば無視してよい */
          }
          if (dbInstance === db) {
            dbInstance = null;
            dbPromise = null;
          }
        };
        dbInstance = db;
        resolve(db);
      };
      req.onerror = () => {
        // 失敗した promise をキャッシュに固定化しない(次回呼び出しで再試行できる)。
        dbPromise = null;
        reject(req.error ?? new Error(`IndexedDB open failed: ${config.name}`));
      };
    });
    return dbPromise;
  }

  async function tx(stores: string[], mode: IDBTransactionMode): Promise<IDBTransaction> {
    const db = await open();
    return db.transaction(stores, mode);
  }

  function close(): void {
    dbInstance?.close();
    dbInstance = null;
    dbPromise = null;
  }

  return {
    open,
    async getAll<T>(store: string): Promise<T[]> {
      const t = await tx([store], 'readonly');
      return promisify(t.objectStore(store).getAll() as IDBRequest<T[]>);
    },
    async get<T>(store: string, key: IDBValidKey): Promise<T | undefined> {
      const t = await tx([store], 'readonly');
      return promisify(t.objectStore(store).get(key) as IDBRequest<T | undefined>);
    },
    async put<T>(store: string, value: T): Promise<void> {
      const t = await tx([store], 'readwrite');
      t.objectStore(store).put(value);
      await txDone(t);
    },
    async deleteRecord(store: string, key: IDBValidKey): Promise<void> {
      const t = await tx([store], 'readwrite');
      t.objectStore(store).delete(key);
      await txDone(t);
    },
    async getKv<T>(store: string, key: string): Promise<T | undefined> {
      const t = await tx([store], 'readonly');
      return promisify(t.objectStore(store).get(key) as IDBRequest<T | undefined>);
    },
    async putKv<T>(store: string, key: string, value: T): Promise<void> {
      const t = await tx([store], 'readwrite');
      t.objectStore(store).put(value, key);
      await txDone(t);
    },
    async runWrite(stores: string[], fn: (t: IDBTransaction) => void): Promise<void> {
      const t = await tx(stores, 'readwrite');
      try {
        fn(t);
      } catch (e) {
        // fn の途中 throw は明示 abort(発行済みリクエストを auto-commit させない = 原子性)。
        try {
          t.abort();
        } catch {
          /* 既に abort 済みなら無視してよい */
        }
        throw e;
      }
      await txDone(t);
    },
    close,
    // deleteDatabase が blocked にならないよう接続とキャッシュを破棄する。
    _resetForTests(): void {
      close();
    },
  };
}
