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
  AllocationItem,
  CashflowSchedule,
  JournalEntry,
  Ledger,
  LedgerMeta,
  ReserveItem,
  Settings,
  Snapshot,
  Tag,
} from '../domain/types';
import { buildAllocation, type AllocationInput } from '../domain/allocation';
import { buildScheduleEntry } from '../domain/cashflow';
import { nowIso } from '../util/time';

/** 按分中資産（繰延）科目の既定名。初回利用時に asset 科目として作る/再利用する。 */
const DEFERRED_ACCOUNT_NAME = '按分中資産';

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
  const [meta, settings, accounts, journalEntries, allocations, cashflowSchedules, reserves, tags] =
    await Promise.all([
      getMeta(),
      getSettings(),
      getAll<Account>(STORE.accounts),
      getAll<JournalEntry>(STORE.journalEntries),
      getAll<AllocationItem>(STORE.allocations),
      getAll<CashflowSchedule>(STORE.cashflowSchedules),
      getAll<ReserveItem>(STORE.reserves),
      getAll<Tag>(STORE.tags),
    ]);
  if (!meta || !settings) throw new Error('台帳の初期化に失敗しました');
  // 一覧の安定した既定順: 仕訳は日付降順 → 作成降順。
  journalEntries.sort((a, b) =>
    a.date === b.date ? cmp(b.createdAt, a.createdAt) : cmp(b.date, a.date),
  );
  allocations.sort((a, b) => cmp(b.createdAt, a.createdAt));
  // 予定 CF は期日昇順。
  cashflowSchedules.sort((a, b) => cmp(a.dueDate, b.dueDate));
  reserves.sort((a, b) => cmp(a.createdAt, b.createdAt));
  tags.sort((a, b) => a.name.localeCompare(b.name, 'ja'));
  return {
    meta,
    settings,
    accounts,
    journalEntries,
    allocations,
    cashflowSchedules,
    reserves,
    tags,
  };
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

/** 科目が「使用中」か（仕訳明細・予定CF・目的別資金のいずれかから参照されている）。 */
function isAccountReferenced(
  id: string,
  entries: JournalEntry[],
  schedules: CashflowSchedule[],
  reserves: ReserveItem[],
): boolean {
  return (
    entries.some((e) => e.lines.some((l) => l.accountId === id)) ||
    schedules.some((s) => s.accountId === id || s.counterAccountId === id) ||
    reserves.some((r) => r.reserveAccountId === id)
  );
}

async function loadReferencingCollections(): Promise<{
  entries: JournalEntry[];
  schedules: CashflowSchedule[];
  reserves: ReserveItem[];
}> {
  const [entries, schedules, reserves] = await Promise.all([
    getAll<JournalEntry>(STORE.journalEntries),
    getAll<CashflowSchedule>(STORE.cashflowSchedules),
    getAll<ReserveItem>(STORE.reserves),
  ]);
  return { entries, schedules, reserves };
}

export async function upsertAccount(account: Account): Promise<void> {
  // 使用中（仕訳/予定CF/目的別資金から参照中）の科目は区分(type)を変更できない。fail-closed。
  const [accounts, refs] = await Promise.all([
    getAll<Account>(STORE.accounts),
    loadReferencingCollections(),
  ]);
  const prev = accounts.find((a) => a.id === account.id);
  if (prev && prev.type !== account.type) {
    if (isAccountReferenced(account.id, refs.entries, refs.schedules, refs.reserves)) {
      throw new Error('使用中の科目は区分を変更できません。');
    }
  }
  await writeWithRevision([STORE.accounts], (t) => {
    t.objectStore(STORE.accounts).put(account);
  });
}

/** 使用中（仕訳/予定CF/目的別資金から参照中）の科目は削除できない（アーカイブを使う）。fail-closed。 */
export async function deleteAccount(id: string): Promise<void> {
  const { entries, schedules, reserves } = await loadReferencingCollections();
  if (isAccountReferenced(id, entries, schedules, reserves)) {
    throw new Error('この科目は使用中のため削除できません。アーカイブしてください。');
  }
  await writeWithRevision([STORE.accounts], (t) => {
    t.objectStore(STORE.accounts).delete(id);
  });
}

/* ── 仕訳 ── */

const GENERATED_ENTRY_MSG =
  '按分から生成された仕訳は編集・削除できません。按分台帳で管理してください。';

const LINKED_ENTRY_MSG =
  '実績化済みの予定に紐づく仕訳は編集・削除できません。資金繰りの予定から操作してください。';

/** 按分生成仕訳（allocationId 付き）は通常の編集・削除では壊せない。fail-closed。 */
async function assertNotAllocationEntry(id: string): Promise<void> {
  const entries = await getAll<JournalEntry>(STORE.journalEntries);
  const target = entries.find((e) => e.id === id);
  if (target?.metadata?.allocationId) {
    throw new Error(GENERATED_ENTRY_MSG);
  }
}

/** 実績化済み予定の linkedEntry は通常の編集・削除では壊せない。fail-closed。 */
async function assertNotScheduleLinked(id: string): Promise<void> {
  const schedules = await getAll<CashflowSchedule>(STORE.cashflowSchedules);
  if (schedules.some((s) => s.linkedEntryId === id)) {
    throw new Error(LINKED_ENTRY_MSG);
  }
}

export async function upsertEntry(entry: JournalEntry): Promise<void> {
  // 既存が按分生成仕訳/予定リンク仕訳なら上書き禁止。新規入力に allocationId は付かない。
  await assertNotAllocationEntry(entry.id);
  await assertNotScheduleLinked(entry.id);
  if (entry.metadata?.allocationId) throw new Error(GENERATED_ENTRY_MSG);
  await writeWithRevision([STORE.journalEntries], (t) => {
    t.objectStore(STORE.journalEntries).put(entry);
  });
}

export async function deleteEntry(id: string): Promise<void> {
  await assertNotAllocationEntry(id);
  await assertNotScheduleLinked(id);
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

/* ── 按分支出 ── */

export async function listAllocations(): Promise<AllocationItem[]> {
  const all = await getAll<AllocationItem>(STORE.allocations);
  all.sort((a, b) => cmp(b.createdAt, a.createdAt));
  return all;
}

/**
 * 按分支出を作成する。原始仕訳・月次認識仕訳・AllocationItem を **単一トランザクション** で
 * 保存し、revision も同時に進める（途中失敗で半端な仕訳が残らない）。
 * 按分中資産(deferred)科目が無ければ同じトランザクションで作る。
 */
export async function createAllocation(
  input: Omit<AllocationInput, 'deferredAccountId'>,
): Promise<AllocationItem> {
  const accounts = await getAll<Account>(STORE.accounts);
  let deferred = accounts.find((a) => a.type === 'asset' && a.name === DEFERRED_ACCOUNT_NAME);
  const ts = nowIso();
  const newDeferred = deferred
    ? null
    : ({
        id: newId(),
        name: DEFERRED_ACCOUNT_NAME,
        type: 'asset',
        archived: false,
        createdAt: ts,
        updatedAt: ts,
      } satisfies Account);
  if (!deferred) deferred = newDeferred!;

  const { item, sourceEntry, recognitionEntries } = buildAllocation({
    ...input,
    deferredAccountId: deferred.id,
  });

  await writeWithRevision([STORE.accounts, STORE.journalEntries, STORE.allocations], (t) => {
    if (newDeferred) t.objectStore(STORE.accounts).put(newDeferred);
    const entries = t.objectStore(STORE.journalEntries);
    entries.put(sourceEntry);
    for (const e of recognitionEntries) entries.put(e);
    t.objectStore(STORE.allocations).put(item);
  });
  return item;
}

/* ── 予定キャッシュフロー ── */

export async function upsertSchedule(schedule: CashflowSchedule): Promise<void> {
  await writeWithRevision([STORE.cashflowSchedules], (t) => {
    t.objectStore(STORE.cashflowSchedules).put(schedule);
  });
}

/** 複数の予定（分割払い等）を 1 トランザクションで保存する。 */
export async function upsertSchedules(schedules: CashflowSchedule[]): Promise<void> {
  await writeWithRevision([STORE.cashflowSchedules], (t) => {
    const store = t.objectStore(STORE.cashflowSchedules);
    for (const s of schedules) store.put(s);
  });
}

export async function deleteSchedule(id: string): Promise<void> {
  await writeWithRevision([STORE.cashflowSchedules], (t) => {
    t.objectStore(STORE.cashflowSchedules).delete(id);
  });
}

/** 予定を実績化: 仕訳を作り、schedule を posted にする（単一トランザクション）。 */
export async function postSchedule(id: string): Promise<JournalEntry> {
  const schedules = await getAll<CashflowSchedule>(STORE.cashflowSchedules);
  const schedule = schedules.find((s) => s.id === id);
  if (!schedule) throw new Error('予定が見つかりません。');
  if (schedule.status !== 'planned') throw new Error('この予定は既に処理済みです。');
  const entry = buildScheduleEntry(schedule); // counter 未設定なら throw
  const updated: CashflowSchedule = {
    ...schedule,
    status: 'posted',
    linkedEntryId: entry.id,
    updatedAt: nowIso(),
  };
  await writeWithRevision([STORE.journalEntries, STORE.cashflowSchedules], (t) => {
    t.objectStore(STORE.journalEntries).put(entry);
    t.objectStore(STORE.cashflowSchedules).put(updated);
  });
  return entry;
}

/* ── 目的別資金 ── */

export async function deleteReserve(id: string): Promise<void> {
  await writeWithRevision([STORE.reserves], (t) => {
    t.objectStore(STORE.reserves).delete(id);
  });
}

/**
 * 目的別資金を作成する。既存 asset を紐づけるか、無ければ同名の asset 科目を作る。
 * 取り置き自体は通常の振替（普通預金 → 目的別資金）で行う（このメソッドは枠の登録のみ）。
 */
export async function createReserve(input: {
  name: string;
  targetAmount?: number;
  note?: string;
  existingAccountId?: string;
}): Promise<ReserveItem> {
  const ts = nowIso();
  let newAccount: Account | null = null;
  let accountId = input.existingAccountId;
  if (!accountId) {
    newAccount = {
      id: newId(),
      name: input.name,
      type: 'asset',
      archived: false,
      createdAt: ts,
      updatedAt: ts,
    };
    accountId = newAccount.id;
  }
  const reserve: ReserveItem = {
    id: newId(),
    name: input.name,
    reserveAccountId: accountId,
    ...(input.targetAmount !== undefined ? { targetAmount: input.targetAmount } : {}),
    ...(input.note && input.note.trim() !== '' ? { note: input.note.trim() } : {}),
    createdAt: ts,
    updatedAt: ts,
  };
  await writeWithRevision([STORE.accounts, STORE.reserves], (t) => {
    if (newAccount) t.objectStore(STORE.accounts).put(newAccount);
    t.objectStore(STORE.reserves).put(reserve);
  });
  return reserve;
}

/* ── タグ ── */

function isTagReferenced(
  id: string,
  entries: JournalEntry[],
  schedules: CashflowSchedule[],
): boolean {
  return (
    entries.some((e) => e.tagIds?.includes(id) || e.lines.some((l) => l.tagIds?.includes(id))) ||
    schedules.some(
      (s) =>
        s.entryTagIds?.includes(id) ||
        s.accountLineTagIds?.includes(id) ||
        s.counterLineTagIds?.includes(id),
    )
  );
}

export async function upsertTag(tag: Tag): Promise<void> {
  await writeWithRevision([STORE.tags], (t) => {
    t.objectStore(STORE.tags).put(tag);
  });
}

/** 使用中のタグは物理削除できない（アーカイブを使う）。fail-closed。 */
export async function deleteTag(id: string): Promise<void> {
  const [entries, schedules] = await Promise.all([
    getAll<JournalEntry>(STORE.journalEntries),
    getAll<CashflowSchedule>(STORE.cashflowSchedules),
  ]);
  if (isTagReferenced(id, entries, schedules)) {
    throw new Error('このタグは使用中のため削除できません。アーカイブしてください。');
  }
  await writeWithRevision([STORE.tags], (t) => {
    t.objectStore(STORE.tags).delete(id);
  });
}

/* ── 一括置換（import / restore で使う原子的操作） ── */

export interface ReplacePayload {
  meta: LedgerMeta;
  settings: Settings;
  accounts: Account[];
  journalEntries: JournalEntry[];
  allocations: AllocationItem[];
  cashflowSchedules: CashflowSchedule[];
  reserves: ReserveItem[];
  tags: Tag[];
}

/**
 * 台帳本体を 1 トランザクションで置換する。snapshots は保持する（復元元を消さない）。
 * 成功するまで既存は壊さない。
 */
export async function replaceLedger(payload: ReplacePayload): Promise<void> {
  await runWrite(
    [
      STORE.kv,
      STORE.accounts,
      STORE.journalEntries,
      STORE.allocations,
      STORE.cashflowSchedules,
      STORE.reserves,
      STORE.tags,
    ],
    (t) => {
      const accounts = t.objectStore(STORE.accounts);
      const entries = t.objectStore(STORE.journalEntries);
      const allocations = t.objectStore(STORE.allocations);
      const schedules = t.objectStore(STORE.cashflowSchedules);
      const reserves = t.objectStore(STORE.reserves);
      const tags = t.objectStore(STORE.tags);
      accounts.clear();
      entries.clear();
      allocations.clear();
      schedules.clear();
      reserves.clear();
      tags.clear();
      for (const a of payload.accounts) accounts.put(a);
      for (const e of payload.journalEntries) entries.put(e);
      for (const al of payload.allocations) allocations.put(al);
      for (const s of payload.cashflowSchedules) schedules.put(s);
      for (const r of payload.reserves) reserves.put(r);
      for (const tag of payload.tags) tags.put(tag);
      t.objectStore(STORE.kv).put(payload.meta, KV_META);
      t.objectStore(STORE.kv).put(payload.settings, KV_SETTINGS);
    },
  );
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
  await runWrite(
    [
      STORE.kv,
      STORE.accounts,
      STORE.journalEntries,
      STORE.allocations,
      STORE.cashflowSchedules,
      STORE.reserves,
      STORE.tags,
      STORE.snapshots,
    ],
    (t) => {
      t.objectStore(STORE.kv).clear();
      t.objectStore(STORE.accounts).clear();
      t.objectStore(STORE.journalEntries).clear();
      t.objectStore(STORE.allocations).clear();
      t.objectStore(STORE.cashflowSchedules).clear();
      t.objectStore(STORE.reserves).clear();
      t.objectStore(STORE.tags).clear();
      t.objectStore(STORE.snapshots).clear();
      t.objectStore(STORE.kv).put(meta, KV_META);
      t.objectStore(STORE.kv).put(settings, KV_SETTINGS);
      const store = t.objectStore(STORE.accounts);
      for (const a of accounts) store.put(a);
    },
  );
}

/** 新規スナップショットの ID/時刻を採番する補助。 */
export function makeSnapshotId(): string {
  return newId();
}
