/*
 * リポジトリ: IndexedDB に対するドメイン操作。
 *
 * 不変条件:
 *  - 実行時の正本は IndexedDB。
 *  - 変更のたびに meta.revision を +1 する（端末ローカルの編集追跡）。
 *  - 削除/全消去/復元は fail-closed（呼び出し側で確認 UI を出す）。
 */
import { STORE, deleteRecord, getAll, getKv, putRecord, runWrite, type StoreName } from './db';
import { defaultAccounts, defaultSettings, newMeta } from './seed';
import { newId } from '../domain/ids';
import type {
  Account,
  JournalEntry,
  Ledger,
  LedgerMeta,
  Settings,
  Snapshot,
} from '../domain/types';
import { nowIso } from '../util/time';

const KV_META = 'meta';
const KV_SETTINGS = 'settings';

async function getMeta(): Promise<LedgerMeta | undefined> {
  return getKv<LedgerMeta>(KV_META);
}

async function getSettings(): Promise<Settings | undefined> {
  return getKv<Settings>(KV_SETTINGS);
}

/** 初回だけ既定データを投入する。 */
export async function ensureInitialized(): Promise<void> {
  const meta = await getMeta();
  if (meta) return;
  const accounts = defaultAccounts();
  const settings = defaultSettings();
  const meta0 = newMeta();
  await runWrite([STORE.kv, STORE.accounts], (t) => {
    t.objectStore(STORE.kv).put(meta0, KV_META);
    t.objectStore(STORE.kv).put(settings, KV_SETTINGS);
    const store = t.objectStore(STORE.accounts);
    for (const a of accounts) store.put(a);
  });
}

export async function loadLedger(): Promise<Ledger> {
  await ensureInitialized();
  const [meta, settings, accounts, journalEntries] = await Promise.all([
    getMeta(),
    getSettings(),
    getAll<Account>(STORE.accounts),
    getAll<JournalEntry>(STORE.journalEntries),
  ]);
  if (!meta || !settings) throw new Error('台帳の初期化に失敗しました');
  // 一覧の安定した既定順: 仕訳は日付降順 → 作成降順。
  journalEntries.sort((a, b) =>
    a.date === b.date ? cmp(b.createdAt, a.createdAt) : cmp(b.date, a.date),
  );
  return { meta, settings, accounts, journalEntries };
}

function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * 本体の変更と meta.revision の更新を **同一トランザクション** で行う。
 * 後段だけ失敗して「データは変わったが revision は進まない」状態を防ぐ。
 * revision は JSON import の競合判定に使うため、本体と必ず歩調を合わせる。
 */
async function writeWithRevision(
  stores: StoreName[],
  apply: (t: IDBTransaction) => void,
): Promise<void> {
  const all = stores.includes(STORE.kv) ? stores : [...stores, STORE.kv];
  await runWrite(all, (t) => {
    apply(t);
    const kv = t.objectStore(STORE.kv);
    const req = kv.get(KV_META);
    req.onsuccess = () => {
      const m = req.result as LedgerMeta | undefined;
      if (m) kv.put({ ...m, revision: m.revision + 1, updatedAt: nowIso() }, KV_META);
    };
  });
}

/* ── 勘定科目 ── */

export async function upsertAccount(account: Account): Promise<void> {
  // 使用中（仕訳から参照中）の科目は区分(type)を変更できない。fail-closed。
  const [accounts, entries] = await Promise.all([
    getAll<Account>(STORE.accounts),
    getAll<JournalEntry>(STORE.journalEntries),
  ]);
  const prev = accounts.find((a) => a.id === account.id);
  if (prev && prev.type !== account.type) {
    const referenced = entries.some((e) => e.lines.some((l) => l.accountId === account.id));
    if (referenced) {
      throw new Error('使用中の科目は区分を変更できません。');
    }
  }
  await writeWithRevision([STORE.accounts], (t) => {
    t.objectStore(STORE.accounts).put(account);
  });
}

/** 仕訳から参照されている科目は削除できない（アーカイブを使う）。fail-closed。 */
export async function deleteAccount(id: string): Promise<void> {
  const entries = await getAll<JournalEntry>(STORE.journalEntries);
  const referenced = entries.some((e) => e.lines.some((l) => l.accountId === id));
  if (referenced) {
    throw new Error('この科目は仕訳で使われているため削除できません。アーカイブしてください。');
  }
  await writeWithRevision([STORE.accounts], (t) => {
    t.objectStore(STORE.accounts).delete(id);
  });
}

/* ── 仕訳 ── */

export async function upsertEntry(entry: JournalEntry): Promise<void> {
  await writeWithRevision([STORE.journalEntries], (t) => {
    t.objectStore(STORE.journalEntries).put(entry);
  });
}

export async function deleteEntry(id: string): Promise<void> {
  await writeWithRevision([STORE.journalEntries], (t) => {
    t.objectStore(STORE.journalEntries).delete(id);
  });
}

/* ── 設定 ── */

export async function updateSettings(settings: Settings): Promise<void> {
  await writeWithRevision([STORE.kv], (t) => {
    t.objectStore(STORE.kv).put(settings, KV_SETTINGS);
  });
}

/* ── スナップショット ── */

export async function listSnapshots(): Promise<Snapshot[]> {
  const all = await getAll<Snapshot>(STORE.snapshots);
  all.sort((a, b) => cmp(b.createdAt, a.createdAt));
  return all;
}

export async function saveSnapshot(snapshot: Snapshot): Promise<void> {
  await putRecord(STORE.snapshots, snapshot);
}

export async function deleteSnapshot(id: string): Promise<void> {
  await deleteRecord(STORE.snapshots, id);
}

/* ── 一括置換（import / restore で使う原子的操作） ── */

export interface ReplacePayload {
  meta: LedgerMeta;
  settings: Settings;
  accounts: Account[];
  journalEntries: JournalEntry[];
}

/**
 * 台帳本体（meta/settings/accounts/journalEntries）を 1 トランザクションで置換する。
 * snapshots は保持する（復元元を消さない）。成功するまで既存は壊さない。
 */
export async function replaceLedger(payload: ReplacePayload): Promise<void> {
  await runWrite([STORE.kv, STORE.accounts, STORE.journalEntries], (t) => {
    const accounts = t.objectStore(STORE.accounts);
    const entries = t.objectStore(STORE.journalEntries);
    accounts.clear();
    entries.clear();
    for (const a of payload.accounts) accounts.put(a);
    for (const e of payload.journalEntries) entries.put(e);
    t.objectStore(STORE.kv).put(payload.meta, KV_META);
    t.objectStore(STORE.kv).put(payload.settings, KV_SETTINGS);
  });
}

/**
 * 全データ削除（snapshots も含む）→ 既定データで作り直す。fail-closed の確認は UI 側。
 *
 * 破壊操作なので「全 clear + 初期 seed」を **単一トランザクション** で行う。
 * 途中失敗時はトランザクションが abort し、一部だけ消えた半壊状態にはならない。
 */
export async function resetAll(): Promise<void> {
  const accounts = defaultAccounts();
  const settings = defaultSettings();
  const meta = newMeta();
  await runWrite([STORE.kv, STORE.accounts, STORE.journalEntries, STORE.snapshots], (t) => {
    t.objectStore(STORE.kv).clear();
    t.objectStore(STORE.accounts).clear();
    t.objectStore(STORE.journalEntries).clear();
    t.objectStore(STORE.snapshots).clear();
    t.objectStore(STORE.kv).put(meta, KV_META);
    t.objectStore(STORE.kv).put(settings, KV_SETTINGS);
    const store = t.objectStore(STORE.accounts);
    for (const a of accounts) store.put(a);
  });
}

/** 新規スナップショットの ID/時刻を採番する補助。 */
export function makeSnapshotId(): string {
  return newId();
}
