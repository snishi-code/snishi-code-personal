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
import { SCHEMA_VERSION } from '../domain/constants';
import { inferRole, roleAllowsType } from '../domain/accountRoles';
import { isAccountReferenced, type AccountRefCollections } from '../domain/accountRefs';
import type {
  Account,
  AdjustmentKind,
  AllocationItem,
  CashflowSchedule,
  FundingGoal,
  JournalEntry,
  Ledger,
  LedgerMeta,
  MonthlyCostItem,
  MonthlyCostKind,
  ReserveItem,
  Settings,
  Snapshot,
  Tag,
} from '../domain/types';
import { monthlyCostItemsFromAllocations } from '../domain/monthlyCostMigration';
import {
  addMonthsToDate,
  buildAllocation,
  monthlyAmounts,
  type AllocationInput,
} from '../domain/allocation';
import { buildScheduleEntry } from '../domain/cashflow';
import { reserveBalanceShortfall } from '../domain/entry';
import { buildAdjustmentEntry, counterpartName, counterpartRole } from '../domain/adjustment';
import { accountBalance, filterByDateRange } from '../domain/accounting';
import {
  isTagReferenced,
  tagAllowsEntry,
  tagAllowsLine,
  tagAssignmentError,
  tagUsage,
} from '../domain/tags';
import { nowIso } from '../util/time';

async function tagMap(): Promise<Map<string, Tag>> {
  const tags = await getAll<Tag>(STORE.tags);
  return new Map(tags.map((t) => [t.id, t]));
}

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

/** 初回だけ既定データを投入する。既存DBは現行スキーマ版へ追従させる。 */
export async function ensureInitialized(): Promise<void> {
  const meta = await getMeta();
  if (meta) {
    // 既存DBの meta.schemaVersion を現行へ前進させる（恒等移行 + role 補完）。
    // 編集追跡(revision)は変えない＝import の競合判定に影響させない。
    if (meta.schemaVersion < SCHEMA_VERSION) {
      const [accounts, allocations, reserves, monthlyCostItems] = await Promise.all([
        getAll<Account>(STORE.accounts),
        getAll<AllocationItem>(STORE.allocations),
        getAll<ReserveItem>(STORE.reserves),
        getAll<MonthlyCostItem>(STORE.monthlyCostItems),
      ]);
      // v5→v6: role の無い既存科目を type・参照集合から推定して補う。
      const deferredIds = new Set(allocations.map((a) => a.deferredAccountId));
      const reserveIds = new Set(reserves.map((r) => r.reserveAccountId));
      const patched = accounts.filter(
        (a) => typeof (a as Account & { role?: unknown }).role !== 'string',
      );
      // v6→v7: 月額化コストが空なら既存按分から移行生成する。
      const newMonthlyCosts =
        monthlyCostItems.length === 0 ? monthlyCostItemsFromAllocations(allocations) : [];
      const bumped: LedgerMeta = { ...meta, schemaVersion: SCHEMA_VERSION };
      await runWrite([STORE.kv, STORE.accounts, STORE.monthlyCostItems], (t) => {
        t.objectStore(STORE.kv).put(bumped, KV_META);
        const store = t.objectStore(STORE.accounts);
        for (const a of patched) {
          store.put({ ...a, role: inferRole(a, { deferredIds, reserveIds }) });
        }
        const mcStore = t.objectStore(STORE.monthlyCostItems);
        for (const mc of newMonthlyCosts) mcStore.put(mc);
      });
    }
    return;
  }
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
  const [
    meta,
    settings,
    accounts,
    journalEntries,
    allocations,
    cashflowSchedules,
    reserves,
    tags,
    monthlyCostItems,
    fundingGoals,
  ] = await Promise.all([
    getMeta(),
    getSettings(),
    getAll<Account>(STORE.accounts),
    getAll<JournalEntry>(STORE.journalEntries),
    getAll<AllocationItem>(STORE.allocations),
    getAll<CashflowSchedule>(STORE.cashflowSchedules),
    getAll<ReserveItem>(STORE.reserves),
    getAll<Tag>(STORE.tags),
    getAll<MonthlyCostItem>(STORE.monthlyCostItems),
    getAll<FundingGoal>(STORE.fundingGoals),
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
  monthlyCostItems.sort((a, b) => cmp(b.createdAt, a.createdAt));
  fundingGoals.sort((a, b) => cmp(a.targetDate, b.targetDate));
  return {
    meta,
    settings,
    accounts,
    journalEntries,
    allocations,
    cashflowSchedules,
    reserves,
    tags,
    monthlyCostItems,
    fundingGoals,
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

async function loadReferencingCollections(): Promise<AccountRefCollections> {
  const [entries, schedules, reserves, allocations, monthlyCostItems, fundingGoals] =
    await Promise.all([
      getAll<JournalEntry>(STORE.journalEntries),
      getAll<CashflowSchedule>(STORE.cashflowSchedules),
      getAll<ReserveItem>(STORE.reserves),
      getAll<AllocationItem>(STORE.allocations),
      getAll<MonthlyCostItem>(STORE.monthlyCostItems),
      getAll<FundingGoal>(STORE.fundingGoals),
    ]);
  return { entries, schedules, reserves, allocations, monthlyCostItems, fundingGoals };
}

export async function upsertAccount(account: Account): Promise<void> {
  // role は type と整合する必要がある（import 検証と同じ不変条件を保存時にも守る）。
  if (!roleAllowsType(account.role, account.type)) {
    throw new Error('役割が区分と一致しません。');
  }
  // 使用中（仕訳/予定CF/目的別資金から参照中）の科目は区分(type)を変更できない。fail-closed。
  // role 変更は会計残高を変えない（入力候補が変わるだけ）ので使用中でも許可する。
  const [accounts, refs] = await Promise.all([
    getAll<Account>(STORE.accounts),
    loadReferencingCollections(),
  ]);
  const prev = accounts.find((a) => a.id === account.id);
  if (prev && prev.type !== account.type) {
    if (isAccountReferenced(account.id, refs)) {
      throw new Error('使用中の科目は区分を変更できません。');
    }
  }
  await writeWithRevision([STORE.accounts], (t) => {
    t.objectStore(STORE.accounts).put(account);
  });
}

/** 使用中（仕訳/予定CF/目的別資金から参照中）の科目は削除できない（アーカイブを使う）。fail-closed。 */
export async function deleteAccount(id: string): Promise<void> {
  const refs = await loadReferencingCollections();
  if (isAccountReferenced(id, refs)) {
    throw new Error('この科目は使用中のため削除できません。アーカイブしてください。');
  }
  await writeWithRevision([STORE.accounts], (t) => {
    t.objectStore(STORE.accounts).delete(id);
  });
}

/* ── 仕訳 ── */

const GENERATED_ENTRY_MSG =
  '按分から生成された仕訳は編集・削除できません。按分台帳で管理してください。';

const MONTHLY_COST_ENTRY_MSG =
  '月額化コストから生成された仕訳は直接編集・削除できません。月額化コスト画面で管理してください。';

const LINKED_ENTRY_MSG =
  '実績化済みの予定に紐づく仕訳は編集・削除できません。資金繰りの予定から操作してください。';

/** 生成仕訳（按分=allocationId / 月額化=monthlyCostId 付き）は通常の編集・削除では壊せない。fail-closed。 */
async function assertNotGeneratedEntry(id: string): Promise<void> {
  const entries = await getAll<JournalEntry>(STORE.journalEntries);
  const target = entries.find((e) => e.id === id);
  if (target?.metadata?.allocationId) throw new Error(GENERATED_ENTRY_MSG);
  if (target?.metadata?.monthlyCostId) throw new Error(MONTHLY_COST_ENTRY_MSG);
}

/** 実績化済み予定の linkedEntry は通常の編集・削除では壊せない。fail-closed。 */
async function assertNotScheduleLinked(id: string): Promise<void> {
  const schedules = await getAll<CashflowSchedule>(STORE.cashflowSchedules);
  if (schedules.some((s) => s.linkedEntryId === id)) {
    throw new Error(LINKED_ENTRY_MSG);
  }
}

/** 仕訳のタグ代入を import 検証と同じ不変条件で確認する（保存時 fail-closed）。 */
async function assertEntryTagsValid(entry: JournalEntry): Promise<void> {
  const tags = await tagMap();
  const e1 = tagAssignmentError(entry.tagIds, 'entry', tags);
  if (e1) throw new Error(e1);
  for (const line of entry.lines) {
    const e2 = tagAssignmentError(line.tagIds, 'line', tags);
    if (e2) throw new Error(e2);
  }
}

/** 目的別資金(reserve-asset)を貸方で減らす仕訳は、その資金の残高不足を保存前に拒否する。 */
async function assertReserveSufficient(entry: JournalEntry): Promise<void> {
  const accounts = await getAll<Account>(STORE.accounts);
  if (!accounts.some((a) => a.role === 'reserve-asset')) return;
  const all = await getAll<JournalEntry>(STORE.journalEntries);
  const others = all.filter((e) => e.id !== entry.id); // 編集時は自分自身を二重計上しない
  const short = reserveBalanceShortfall(entry, accounts, others);
  if (short) throw new Error(`目的別資金「${short.name}」の残高が不足しています。`);
}

export async function upsertEntry(entry: JournalEntry): Promise<void> {
  // 既存が生成仕訳/予定リンク仕訳なら上書き禁止。
  await assertNotGeneratedEntry(entry.id);
  await assertNotScheduleLinked(entry.id);
  // ユーザー入力から生成メタ（allocationId / monthlyCostId）を持つ仕訳は作れない。
  if (entry.metadata?.allocationId) throw new Error(GENERATED_ENTRY_MSG);
  if (entry.metadata?.monthlyCostId) throw new Error(MONTHLY_COST_ENTRY_MSG);
  await assertEntryTagsValid(entry);
  await assertReserveSufficient(entry);
  await writeWithRevision([STORE.journalEntries], (t) => {
    t.objectStore(STORE.journalEntries).put(entry);
  });
}

export async function deleteEntry(id: string): Promise<void> {
  await assertNotGeneratedEntry(id);
  await assertNotScheduleLinked(id);
  await writeWithRevision([STORE.journalEntries], (t) => {
    t.objectStore(STORE.journalEntries).delete(id);
  });
}

/**
 * 仕訳 + 予定 CF（分割返済など）を 1 トランザクションで保存する。
 * 借入実行の振替（負債→資金）と、その返済予定をまとめて保存する用途。
 * 仕訳だけ成功して予定が残らない中途半端な状態を避ける（fail-closed）。
 */
export async function saveEntryWithSchedules(
  entry: JournalEntry,
  schedules: CashflowSchedule[],
): Promise<void> {
  await assertNotGeneratedEntry(entry.id);
  await assertNotScheduleLinked(entry.id);
  if (entry.metadata?.allocationId) throw new Error(GENERATED_ENTRY_MSG);
  if (entry.metadata?.monthlyCostId) throw new Error(MONTHLY_COST_ENTRY_MSG);
  await assertEntryTagsValid(entry);
  await assertReserveSufficient(entry);
  await assertScheduleTagsValid(schedules);
  await writeWithRevision([STORE.journalEntries, STORE.cashflowSchedules], (t) => {
    t.objectStore(STORE.journalEntries).put(entry);
    const sStore = t.objectStore(STORE.cashflowSchedules);
    for (const s of schedules) sStore.put(s);
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
        role: 'deferred-asset',
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

/** 予定 CF のタグ代入を import 検証と同じ不変条件で確認する。 */
async function assertScheduleTagsValid(schedules: CashflowSchedule[]): Promise<void> {
  const tags = await tagMap();
  for (const s of schedules) {
    const e1 = tagAssignmentError(s.entryTagIds, 'entry', tags);
    if (e1) throw new Error(e1);
    const e2 = tagAssignmentError(s.accountLineTagIds, 'line', tags);
    if (e2) throw new Error(e2);
    const e3 = tagAssignmentError(s.counterLineTagIds, 'line', tags);
    if (e3) throw new Error(e3);
  }
}

export async function upsertSchedule(schedule: CashflowSchedule): Promise<void> {
  await upsertSchedules([schedule]);
}

/** 複数の予定（分割払い等）を 1 トランザクションで保存する。 */
export async function upsertSchedules(schedules: CashflowSchedule[]): Promise<void> {
  await assertScheduleTagsValid(schedules);
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
      role: 'reserve-asset',
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

export async function upsertTag(tag: Tag): Promise<void> {
  const [tags, entries, schedules] = await Promise.all([
    getAll<Tag>(STORE.tags),
    getAll<JournalEntry>(STORE.journalEntries),
    getAll<CashflowSchedule>(STORE.cashflowSchedules),
  ]);

  // active な同名タグ重複は禁止（import 検証と同じ不変条件をアプリ内でも守る）。
  if (!tag.archived && tags.some((x) => x.id !== tag.id && !x.archived && x.name === tag.name)) {
    throw new Error('同じ名前の有効なタグが既にあります。');
  }

  // 使用中タグの scope 変更が、付与済みの用途と矛盾する場合は不可（狭める変更を防ぐ）。
  const prev = tags.find((x) => x.id === tag.id);
  if (prev && prev.scope !== tag.scope) {
    const usage = tagUsage(tag.id, entries, schedules);
    if (
      (usage.usedAsEntry && !tagAllowsEntry(tag.scope)) ||
      (usage.usedAsLine && !tagAllowsLine(tag.scope))
    ) {
      throw new Error('使用中のタグは、付与済みの用途に合わない対象へ変更できません。');
    }
  }

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

/* ── 残高補正 ── */

/**
 * 実残高との差分を補正する 2 行仕訳を作る（「締め」は作らない）。
 * 相手科目（残高調整費/収入 or 投資評価損/益）が無ければ同じトランザクションで作る。
 * delta=0 なら何も作らず null を返す。
 */
export async function createAdjustment(input: {
  kind: AdjustmentKind;
  accountId: string;
  date: string;
  actualBalance: number;
  description?: string;
}): Promise<JournalEntry | null> {
  const [accounts, entries] = await Promise.all([
    getAll<Account>(STORE.accounts),
    getAll<JournalEntry>(STORE.journalEntries),
  ]);
  const target = accounts.find((a) => a.id === input.accountId);
  if (!target) throw new Error('対象科目が見つかりません。');
  if (target.type !== 'asset' && target.type !== 'liability') {
    throw new Error('残高補正できるのは資産・負債の科目です。');
  }

  const expected = accountBalance(
    input.accountId,
    target.type,
    filterByDateRange(entries, undefined, input.date),
  );
  const delta = input.actualBalance - expected;
  if (delta === 0) return null;

  const role = counterpartRole(target.type, delta);
  const ctype: 'expense' | 'revenue' = role;
  const name = counterpartName(input.kind, role);
  let counter = accounts.find((a) => a.type === ctype && a.name === name && !a.archived);
  let newCounter: Account | null = null;
  if (!counter) {
    const ts = nowIso();
    newCounter = {
      id: newId(),
      name,
      type: ctype,
      role: 'system-adjustment',
      archived: false,
      createdAt: ts,
      updatedAt: ts,
    };
    counter = newCounter;
  }

  const entry = buildAdjustmentEntry({
    kind: input.kind,
    accountId: input.accountId,
    accountType: target.type,
    date: input.date,
    description: input.description ?? `残高補正: ${target.name}`,
    expectedBalance: expected,
    actualBalance: input.actualBalance,
    counterpartAccountId: counter.id,
  });
  if (!entry) return null;

  await writeWithRevision([STORE.accounts, STORE.journalEntries], (t) => {
    if (newCounter) t.objectStore(STORE.accounts).put(newCounter);
    t.objectStore(STORE.journalEntries).put(entry);
  });
  return entry;
}

/* ── 月額化コスト ── */

export interface MonthlyCostInput {
  name: string;
  kind: MonthlyCostKind;
  amount: number;
  costMonths: number;
  repeatEveryMonths?: number;
  startMonth: string;
  /** 購入/登録日（実際の支払い仕訳の日付）。 */
  date: string;
  expenseAccountId: string;
  /** 支払い元（daily-asset または payment-liability）。必須。 */
  paymentAccountId: string;
  /** liability 払いのとき: 返済 CF を作る口座（daily-asset）。 */
  repaymentAccountId?: string;
  /** 返済回数（>=1）。 */
  repaymentCount?: number;
  /** 初回引落日 ISO（返済 CF だけに使う。購入仕訳の日付には使わない）。 */
  repaymentStartDate?: string;
}

/**
 * 月額化コストを登録する。
 *
 * 「実際の支払い事実」と「生活コストとしての月割り認識」を分けて扱う:
 *  - **支払い仕訳**: 登録日(date)に `借方 費用カテゴリ / 貸方 支払い元`（daily-asset でも
 *    payment-liability でも作る）。`metadata.monthlyCostId` を持ち、通常編集/削除は不可（fail-closed）。
 *    負債払いなら登録日に負債が立ち、返済 CF で取り崩す。
 *  - **生活コスト認識**: 仕訳の正本ではなく `MonthlyCostItem` の formula から導出する分析レイヤ。
 *    ダッシュボードは支払い仕訳を二重計上しないよう除外し、`monthlyCostForMonth` を足す。
 *  - 負債(payment-liability)払い + 返済情報があれば、返済予定 CF を **初回引落日(repaymentStartDate)**
 *    から回数分作る（購入日とは別）。
 * 1 トランザクションで保存し revision を進める。
 */
export async function createMonthlyCost(input: MonthlyCostInput): Promise<MonthlyCostItem> {
  if (input.name.trim() === '') throw new Error('名称を入力してください。');
  if (!Number.isInteger(input.amount) || input.amount <= 0)
    throw new Error('金額は 1 以上の整数で入力してください。');
  if (!Number.isInteger(input.costMonths) || input.costMonths < 1)
    throw new Error('月数は 1 以上で入力してください。');
  if (
    input.repeatEveryMonths !== undefined &&
    (!Number.isInteger(input.repeatEveryMonths) || input.repeatEveryMonths < input.costMonths)
  )
    throw new Error('更新周期は月数以上である必要があります。');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.date)) throw new Error('購入日を入力してください。');

  const accounts = await getAll<Account>(STORE.accounts);
  const byId = new Map(accounts.map((a) => [a.id, a]));
  const expense = byId.get(input.expenseAccountId);
  if (!expense || expense.role !== 'expense-category')
    throw new Error('費用カテゴリ（支出カテゴリの科目）を選んでください。');

  const payment = byId.get(input.paymentAccountId);
  if (!payment || (payment.role !== 'daily-asset' && payment.role !== 'payment-liability'))
    throw new Error('支払い元は日常資産または支払用負債を選んでください。');

  const ts = nowIso();
  const item: MonthlyCostItem = {
    id: newId(),
    name: input.name.trim(),
    kind: input.kind,
    amount: input.amount,
    costMonths: input.costMonths,
    ...(input.repeatEveryMonths !== undefined
      ? { repeatEveryMonths: input.repeatEveryMonths }
      : {}),
    startMonth: input.startMonth,
    expenseAccountId: input.expenseAccountId,
    paymentAccountId: input.paymentAccountId,
    ...(input.repaymentAccountId !== undefined
      ? { repaymentAccountId: input.repaymentAccountId }
      : {}),
    status: 'active',
    createdAt: ts,
    updatedAt: ts,
  };

  // 実際の支払い仕訳: 借方 費用カテゴリ / 貸方 支払い元（登録日 date で記録）。
  const paymentEntry: JournalEntry = {
    id: newId(),
    date: input.date,
    description: item.name,
    kind: 'normal',
    lines: [
      { accountId: input.expenseAccountId, side: 'debit', amount: input.amount },
      { accountId: input.paymentAccountId, side: 'credit', amount: input.amount },
    ],
    metadata: { inputMode: 'expense', monthlyCostId: item.id },
    createdAt: ts,
    updatedAt: ts,
  };

  // 負債払い + 返済情報があれば、返済予定 CF を初回引落日から回数分作る（購入日とは別）。
  const schedules: CashflowSchedule[] = [];
  if (
    payment.role === 'payment-liability' &&
    input.repaymentAccountId !== undefined &&
    input.repaymentCount !== undefined &&
    input.repaymentCount >= 1 &&
    input.repaymentStartDate
  ) {
    const repay = byId.get(input.repaymentAccountId);
    if (!repay || repay.role !== 'daily-asset')
      throw new Error('返済口座は日常資産を選んでください。');
    const parts = monthlyAmounts(input.amount, input.repaymentCount);
    for (let i = 0; i < input.repaymentCount; i++) {
      schedules.push({
        id: newId(),
        title: `${item.name} 返済 ${i + 1}/${input.repaymentCount}`,
        dueDate: addMonthsToDate(input.repaymentStartDate, i),
        amount: parts[i] ?? 0,
        direction: 'outflow',
        accountId: input.repaymentAccountId,
        counterAccountId: input.paymentAccountId,
        source: 'installment',
        status: 'planned',
        monthlyCostId: item.id,
        createdAt: ts,
        updatedAt: ts,
      });
    }
  }

  await writeWithRevision(
    [STORE.monthlyCostItems, STORE.cashflowSchedules, STORE.journalEntries],
    (t) => {
      t.objectStore(STORE.monthlyCostItems).put(item);
      t.objectStore(STORE.journalEntries).put(paymentEntry);
      const sStore = t.objectStore(STORE.cashflowSchedules);
      for (const s of schedules) sStore.put(s);
    },
  );
  return item;
}

export interface FixedAssetMonthlyInput {
  name: string;
  amount: number;
  costMonths: number;
  repeatEveryMonths?: number;
  startMonth: string;
  kind: MonthlyCostKind;
  /** 月額化先の費用カテゴリ（expense-category）。 */
  expenseAccountId: string;
  /** 仮想認識で貸方に見せる固定資産（fixed-asset）。 */
  recognitionCreditAccountId: string;
}

/**
 * 固定資産の購入仕訳（借方 固定資産 / 貸方 資金）+ その月額化コストを 1 transaction で保存する。
 * 月額化は **支払い仕訳を作らない**（購入仕訳が実体）。MonthlyCostItem.formula で生活コストに月割り反映し、
 * Journal では sourceEntryId / recognitionCreditAccountId を使って「固定資産 → 費用」の仮想行を見せる。
 */
export async function saveEntryWithFixedAssetMonthly(
  entry: JournalEntry,
  input: FixedAssetMonthlyInput,
): Promise<MonthlyCostItem> {
  await assertNotGeneratedEntry(entry.id);
  await assertNotScheduleLinked(entry.id);
  if (entry.metadata?.allocationId) throw new Error(GENERATED_ENTRY_MSG);
  if (entry.metadata?.monthlyCostId) throw new Error(MONTHLY_COST_ENTRY_MSG);
  await assertEntryTagsValid(entry);
  await assertReserveSufficient(entry);

  if (input.name.trim() === '') throw new Error('名称を入力してください。');
  if (!Number.isInteger(input.amount) || input.amount <= 0)
    throw new Error('金額は 1 以上の整数で入力してください。');
  if (!Number.isInteger(input.costMonths) || input.costMonths < 1)
    throw new Error('月数は 1 以上で入力してください。');
  if (
    input.repeatEveryMonths !== undefined &&
    (!Number.isInteger(input.repeatEveryMonths) || input.repeatEveryMonths < input.costMonths)
  )
    throw new Error('更新周期は月数以上である必要があります。');

  const accounts = await getAll<Account>(STORE.accounts);
  const byId = new Map(accounts.map((a) => [a.id, a]));
  const expense = byId.get(input.expenseAccountId);
  if (!expense || expense.role !== 'expense-category')
    throw new Error('月額化先の費用カテゴリを選んでください。');
  const fixed = byId.get(input.recognitionCreditAccountId);
  if (!fixed || fixed.role !== 'fixed-asset') throw new Error('固定資産の科目が不正です。');

  const ts = nowIso();
  const item: MonthlyCostItem = {
    id: newId(),
    name: input.name.trim(),
    kind: input.kind,
    amount: input.amount,
    costMonths: input.costMonths,
    ...(input.repeatEveryMonths !== undefined
      ? { repeatEveryMonths: input.repeatEveryMonths }
      : {}),
    startMonth: input.startMonth,
    expenseAccountId: input.expenseAccountId,
    recognitionCreditAccountId: input.recognitionCreditAccountId,
    sourceEntryId: entry.id,
    status: 'active',
    createdAt: ts,
    updatedAt: ts,
  };

  await writeWithRevision([STORE.journalEntries, STORE.monthlyCostItems], (t) => {
    t.objectStore(STORE.journalEntries).put(entry);
    t.objectStore(STORE.monthlyCostItems).put(item);
  });
  return item;
}

/** 月額化コストの更新（編集・一時停止・終了）。 */
export async function upsertMonthlyCost(item: MonthlyCostItem): Promise<void> {
  await writeWithRevision([STORE.monthlyCostItems], (t) => {
    t.objectStore(STORE.monthlyCostItems).put(item);
  });
}

/**
 * 月額化コストを削除する。関連（実支払い仕訳・返済 CF）も一括で扱う fail-closed。
 *  - 現行設計では「実際の支払い仕訳（借方 費用 / 貸方 支払い元）」と「生活コスト認識の分析レイヤ
 *    （formula）」を分離している。削除では支払い仕訳と返済 CF を扱う。
 *  - 返済 CF が 1 件でも実績化(posted)済みなら、現金/負債が動いているため物理削除は禁止。
 *    `status='ended'` で終了させること（履歴と整合を壊さない）。
 *  - すべて未実績なら、実支払い仕訳・未実績 CF・本体を 1 トランザクションで同時削除する（孤立を残さない）。
 */
export async function deleteMonthlyCost(id: string): Promise<void> {
  const [entries, schedules] = await Promise.all([
    getAll<JournalEntry>(STORE.journalEntries),
    getAll<CashflowSchedule>(STORE.cashflowSchedules),
  ]);
  const relatedSchedules = schedules.filter((s) => s.monthlyCostId === id);
  const relatedEntries = entries.filter((e) => e.metadata?.monthlyCostId === id);
  if (relatedSchedules.some((s) => s.status === 'posted')) {
    throw new Error(
      '返済が実績化済みのため削除できません。月額化コスト画面で「終了」にしてください。',
    );
  }
  await writeWithRevision(
    [STORE.monthlyCostItems, STORE.cashflowSchedules, STORE.journalEntries],
    (t) => {
      t.objectStore(STORE.monthlyCostItems).delete(id);
      const sStore = t.objectStore(STORE.cashflowSchedules);
      for (const s of relatedSchedules) sStore.delete(s.id);
      const eStore = t.objectStore(STORE.journalEntries);
      for (const e of relatedEntries) eStore.delete(e.id);
    },
  );
}

/* ── 資金目標 ── */

export interface FundingGoalInput {
  name: string;
  targetAmount: number;
  targetDate: string;
  currentAmount?: number;
  sourceAccountId?: string;
  note?: string;
}

export async function createFundingGoal(input: FundingGoalInput): Promise<FundingGoal> {
  if (input.name.trim() === '') throw new Error('名称を入力してください。');
  if (!Number.isInteger(input.targetAmount) || input.targetAmount <= 0)
    throw new Error('目標額は 1 以上の整数で入力してください。');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.targetDate))
    throw new Error('目標期限を入力してください。');
  const current = input.currentAmount ?? 0;
  if (!Number.isInteger(current) || current < 0)
    throw new Error('現在額は 0 以上の整数で入力してください。');
  if (input.sourceAccountId !== undefined) {
    const accounts = await getAll<Account>(STORE.accounts);
    const acc = accounts.find((a) => a.id === input.sourceAccountId);
    if (!acc || (acc.role !== 'daily-asset' && acc.role !== 'reserve-asset'))
      throw new Error('積立元は日常資産または目的別資金を選んでください。');
  }
  const ts = nowIso();
  const goal: FundingGoal = {
    id: newId(),
    name: input.name.trim(),
    targetAmount: input.targetAmount,
    targetDate: input.targetDate,
    currentAmount: current,
    ...(input.sourceAccountId !== undefined ? { sourceAccountId: input.sourceAccountId } : {}),
    ...(input.note && input.note.trim() !== '' ? { note: input.note.trim() } : {}),
    status: 'active',
    createdAt: ts,
    updatedAt: ts,
  };
  await writeWithRevision([STORE.fundingGoals], (t) => {
    t.objectStore(STORE.fundingGoals).put(goal);
  });
  return goal;
}

export async function upsertFundingGoal(goal: FundingGoal): Promise<void> {
  await writeWithRevision([STORE.fundingGoals], (t) => {
    t.objectStore(STORE.fundingGoals).put(goal);
  });
}

export async function deleteFundingGoal(id: string): Promise<void> {
  await writeWithRevision([STORE.fundingGoals], (t) => {
    t.objectStore(STORE.fundingGoals).delete(id);
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
  monthlyCostItems: MonthlyCostItem[];
  fundingGoals: FundingGoal[];
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
      STORE.monthlyCostItems,
      STORE.fundingGoals,
    ],
    (t) => {
      const accounts = t.objectStore(STORE.accounts);
      const entries = t.objectStore(STORE.journalEntries);
      const allocations = t.objectStore(STORE.allocations);
      const schedules = t.objectStore(STORE.cashflowSchedules);
      const reserves = t.objectStore(STORE.reserves);
      const tags = t.objectStore(STORE.tags);
      const monthlyCosts = t.objectStore(STORE.monthlyCostItems);
      const fundingGoals = t.objectStore(STORE.fundingGoals);
      accounts.clear();
      entries.clear();
      allocations.clear();
      schedules.clear();
      reserves.clear();
      tags.clear();
      monthlyCosts.clear();
      fundingGoals.clear();
      for (const a of payload.accounts) accounts.put(a);
      for (const e of payload.journalEntries) entries.put(e);
      for (const al of payload.allocations) allocations.put(al);
      for (const s of payload.cashflowSchedules) schedules.put(s);
      for (const r of payload.reserves) reserves.put(r);
      for (const tag of payload.tags) tags.put(tag);
      for (const mc of payload.monthlyCostItems) monthlyCosts.put(mc);
      for (const g of payload.fundingGoals) fundingGoals.put(g);
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
      STORE.monthlyCostItems,
      STORE.fundingGoals,
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
      t.objectStore(STORE.monthlyCostItems).clear();
      t.objectStore(STORE.fundingGoals).clear();
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
