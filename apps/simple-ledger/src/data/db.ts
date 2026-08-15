/*
 * IndexedDB の薄いラッパ（外部依存なし・外部送信なし）。
 *
 * 実行時の正本は IndexedDB。開閉・基本 CRUD は foundation の createDatabase（handle）に
 * 委譲し、ここではストア定義とアプリ向けの薄い関数だけを提供する。
 * ドメインの意味づけは repository.ts に置く。
 *
 * v2 の DB は v1（'simple-ledger' / version 9）から識別子を完全分離し、v1 の最終形
 * （当時のストア構成）を **version 1 で一括作成**する（レガシー migration は持たない）。
 * 旧 fundingGoals ストアは作らない（v1 schema v16 で撤去済みのレガシー）。
 */
import { createDatabase, txDone } from '@snishi/foundation/storage/idb';
import { DB_NAME, DB_VERSION } from './constants';

export const STORE = {
  kv: 'kv', // meta / settings の単一レコード置き場（out-of-line key）
  accounts: 'accounts',
  journalEntries: 'journalEntries',
  tags: 'tags', // タグ機能は撤去済み（2026-08-15）。受理のみ = 旧ストア温存の方針で残す
  monthlyCostItems: 'monthlyCostItems',
  recurringRules: 'recurringRules', // 定期ルール（v2 で追加）
  snapshots: 'snapshots',
} as const;

export type StoreName = (typeof STORE)[keyof typeof STORE];

/**
 * foundation の DatabaseHandle。upgrade は不足ストアの作成だけを行うので冪等。
 */
export const db = createDatabase({
  name: DB_NAME,
  version: DB_VERSION,
  upgrade: (idb) => {
    // 現行 STORE に無い未知（レガシー）ストアは**温存する**（黙って削除しない）。
    // 後方互換を持たない＝旧版 DB は repository の assertSchemaVersionCurrent が
    // 復旧面へ送り、旧版データは復旧面の「DB 初期化」（wipeDatabase = deleteDatabase）
    // でのみ消える。upgrade が先にストアを消すと、復旧面に着く前にデータが失われる
    // （「黙って削除しない」原則違反・監査 P1-1）。v10 で撤去した CSV 取込の旧 3 ストアも
    // 同じ方針で温存する。
    if (!idb.objectStoreNames.contains(STORE.kv)) idb.createObjectStore(STORE.kv);
    if (!idb.objectStoreNames.contains(STORE.accounts)) {
      idb.createObjectStore(STORE.accounts, { keyPath: 'id' });
    }
    if (!idb.objectStoreNames.contains(STORE.journalEntries)) {
      const s = idb.createObjectStore(STORE.journalEntries, { keyPath: 'id' });
      s.createIndex('date', 'date', { unique: false });
    }
    if (!idb.objectStoreNames.contains(STORE.tags)) {
      idb.createObjectStore(STORE.tags, { keyPath: 'id' });
    }
    if (!idb.objectStoreNames.contains(STORE.monthlyCostItems)) {
      idb.createObjectStore(STORE.monthlyCostItems, { keyPath: 'id' });
    }
    if (!idb.objectStoreNames.contains(STORE.recurringRules)) {
      idb.createObjectStore(STORE.recurringRules, { keyPath: 'id' });
    }
    if (!idb.objectStoreNames.contains(STORE.snapshots)) {
      idb.createObjectStore(STORE.snapshots, { keyPath: 'id' });
    }
  },
});

/** テスト用: 接続を閉じてキャッシュを破棄する（deleteDatabase が blocked にならないように）。 */
export function _resetConnectionForTests(): void {
  db._resetForTests();
}

/**
 * 復旧用: 接続を閉じて DB を丸ごと削除する（VersionError で新旧どちらのビルドも開けなくなった
 * 端末の最終復旧手段。ErrorBoundary の復旧画面から呼ぶ）。
 * 成功扱いは onsuccess のみ（fail-closed・監査 P2-5）: error / blocked（別タブが接続を
 * 保持している等）を成功と見なして reload すると、DB が残ったまま同じ致命状態へ戻るため、
 * reject して呼び出し側が明示・再試行できるようにする。
 */
export async function wipeDatabase(): Promise<void> {
  try {
    db._resetForTests();
  } catch {
    // 接続が開けていない（VersionError 等）場合はそのまま削除へ。
  }
  await new Promise<void>((resolve, reject) => {
    const request = indexedDB.deleteDatabase(DB_NAME);
    request.onsuccess = () => resolve();
    request.onerror = () =>
      reject(request.error ?? new Error('データベースを削除できませんでした'));
    request.onblocked = () =>
      reject(new Error('他のタブ/ウィンドウが DB を開いているため削除できません'));
  });
}

/* ── handle への薄い委譲（repository / テストが使う API は v1 と同形に保つ） ── */

export async function getAll<T>(store: StoreName): Promise<T[]> {
  return db.getAll<T>(store);
}

export async function getKv<T>(key: string): Promise<T | undefined> {
  return db.getKv<T>(STORE.kv, key);
}

export async function putKv<T>(key: string, value: T): Promise<void> {
  await db.putKv(STORE.kv, key, value);
}

export async function putRecord<T>(store: StoreName, value: T): Promise<void> {
  await db.put(store, value);
}

export async function deleteRecord(store: StoreName, id: string): Promise<void> {
  await db.deleteRecord(store, id);
}

/** 複数ストアをまたいだ書き込みを 1 トランザクションで行う（import の原子性に使う）。 */
export async function runWrite(
  stores: StoreName[],
  fn: (t: IDBTransaction) => void,
): Promise<void> {
  await db.runWrite(stores as string[], fn);
}

/**
 * 複数ストアを同一時点の readonly transaction で読む。
 * fn は最初の await より前に必要な request をすべて発行すること。
 */
export async function runRead<T>(
  stores: StoreName[],
  fn: (t: IDBTransaction) => Promise<T>,
): Promise<T> {
  const idb = await db.open();
  const t = idb.transaction(stores as string[], 'readonly');
  const [value] = await Promise.all([fn(t), txDone(t)]);
  return value;
}
