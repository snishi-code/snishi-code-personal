// 移植元: snishi-code-medical/hospital-rounds/src/features/eventlog.js (EVENT 種別定義と起動配線をアプリ側へ移し汎用化)

const DB_VERSION = 1;
const STORE = 'events';
const EXPORT_SCHEMA = 1;
const DEFAULT_RETENTION_DAYS = 365;
const DAY_MS = 24 * 60 * 60 * 1000;

export interface EventLogConfig {
  /** 専用 IndexedDB 名 (例 'hospital-rounds-v2-eventlog')。アプリデータの DB とは分ける */
  dbName: string;
  /** 生イベントの保持日数 (既定 365)。超過分は init() で間引く */
  retentionDays?: number;
  /** イベントに載せる端末内 userId (乱数 ID 等の非 PII)。null は u を省略 */
  getUserId?: () => string | null;
  /** テスト用の時刻注入 (既定 Date.now) */
  now?: () => number;
}

export interface EventLogExport {
  format: string;
  schema: number;
  exportedAt: string;
  events: unknown[];
}

export interface EventLog {
  /** 起動時に呼ぶ: 保持期間を超えた古いイベントを間引く */
  init(): Promise<void>;
  /** 1 イベント追記。fire-and-forget・例外を投げない (ログ取りで本処理を壊さない) */
  log(kind: string, extra?: Record<string, unknown>): void;
  /** 全イベントを JSON 用オブジェクトで返す (ユーザー操作で呼ぶ前提) */
  exportAll(): Promise<EventLogExport>;
  /** 全消去 */
  clear(): Promise<void>;
}

function txDone(tx: IDBTransaction): Promise<void> {
  return new Promise((res, rej) => {
    tx.oncomplete = () => res();
    tx.onerror = () => rej(tx.error);
    tx.onabort = () => rej(tx.error);
  });
}

function reqDone<T>(r: IDBRequest<T>): Promise<T> {
  return new Promise((res, rej) => {
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}

/**
 * 端末内に閉じた独立 IndexedDB のイベントログを作る。
 *
 * - **外部送信ゼロ**: fetch 等は一切しない。exportAll はユーザーの書出操作で呼ぶ。
 * - 1 イベント = `{ t: 時刻ms, u?: userId, k: 種別, ...extra }`。
 * - **extra / kind に PII (患者名・実名等) を載せないのは呼び出し側 (アプリ) の責務**。
 *   基盤は中身を検査しない。
 * - 保持は retentionDays のローリング (生データの長期保持はしない)。
 */
export function createEventLog(cfg: EventLogConfig): EventLog {
  const retentionDays = cfg.retentionDays ?? DEFAULT_RETENTION_DAYS;
  const now = cfg.now ?? Date.now;

  let dbPromise: Promise<IDBDatabase | null> | null = null;

  function openDb(): Promise<IDBDatabase | null> {
    if (dbPromise) return dbPromise;
    if (typeof indexedDB === 'undefined' || indexedDB === null) {
      dbPromise = Promise.resolve(null);
      return dbPromise;
    }
    // IDB 不可は null に倒す: ログは補助機能なので本処理を巻き込んで失敗させない。
    dbPromise = new Promise((resolve) => {
      let req: IDBOpenDBRequest;
      try {
        req = indexedDB.open(cfg.dbName, DB_VERSION);
      } catch {
        resolve(null);
        return;
      }
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE)) {
          const store = db.createObjectStore(STORE, { autoIncrement: true });
          store.createIndex('t', 't', { unique: false });
        }
      };
      req.onsuccess = () => {
        const db = req.result;
        // delete/version 変更要求時に自接続を閉じて解放 (他所の fail-closed 削除が
        // 自分の接続の onblocked で永久に完了しないのを防ぐ)。
        db.onversionchange = () => {
          try {
            db.close();
          } catch {
            /* 既に閉じている */
          }
          dbPromise = null;
        };
        resolve(db);
      };
      req.onerror = () => {
        console.warn('eventlog open failed:', req.error);
        resolve(null);
      };
      req.onblocked = () => resolve(null);
    });
    return dbPromise;
  }

  // 保持期間を超えた古いイベントを削除する。
  async function pruneOld(): Promise<void> {
    const db = await openDb();
    if (!db) return;
    const cutoff = now() - retentionDays * DAY_MS;
    try {
      const tx = db.transaction(STORE, 'readwrite');
      const idx = tx.objectStore(STORE).index('t');
      await new Promise<void>((res, rej) => {
        const cur = idx.openCursor(IDBKeyRange.upperBound(cutoff, true));
        cur.onsuccess = () => {
          const c = cur.result;
          if (c) {
            c.delete();
            c.continue();
          } else {
            res();
          }
        };
        cur.onerror = () => rej(cur.error);
      });
      await txDone(tx);
    } catch (e) {
      console.warn('eventlog prune failed:', e);
    }
  }

  return {
    async init(): Promise<void> {
      await pruneOld();
    },

    log(kind: string, extra?: Record<string, unknown>): void {
      try {
        // t/u/k はここで確定し、extra は後勝ちで任意フィールドを許す (将来余地)。
        const ev: Record<string, unknown> = { t: now(), k: String(kind ?? '') };
        const uid = cfg.getUserId ? cfg.getUserId() : null;
        if (uid != null) ev.u = uid;
        if (extra && typeof extra === 'object') {
          for (const key of Object.keys(extra)) ev[key] = extra[key];
        }
        void (async () => {
          const db = await openDb();
          if (!db) return;
          try {
            const tx = db.transaction(STORE, 'readwrite');
            tx.objectStore(STORE).add(ev);
            await txDone(tx);
          } catch (e) {
            console.warn('eventlog append failed:', e);
          }
        })();
      } catch (e) {
        // fire-and-forget: ログ取りの失敗で呼び出し側の本処理を壊さない。
        console.warn('eventlog log failed:', e);
      }
    },

    async exportAll(): Promise<EventLogExport> {
      const db = await openDb();
      let events: unknown[] = [];
      if (db) {
        try {
          const tx = db.transaction(STORE, 'readonly');
          const res = await reqDone(tx.objectStore(STORE).getAll());
          if (Array.isArray(res)) events = res;
        } catch (e) {
          console.warn('eventlog export failed:', e);
        }
      }
      return {
        format: cfg.dbName,
        schema: EXPORT_SCHEMA,
        exportedAt: new Date().toISOString(),
        events,
      };
    },

    async clear(): Promise<void> {
      const db = await openDb();
      if (!db) return;
      try {
        const tx = db.transaction(STORE, 'readwrite');
        tx.objectStore(STORE).clear();
        await txDone(tx);
      } catch (e) {
        console.warn('eventlog clear failed:', e);
      }
    },
  };
}
