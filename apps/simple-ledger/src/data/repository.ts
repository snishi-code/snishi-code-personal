/*
 * リポジトリ: IndexedDB に対するドメイン操作。
 *
 * 不変条件:
 *  - 実行時の正本は IndexedDB。
 *  - 変更のたびに meta.revision を +1 する（端末ローカルの編集追跡）。
 *  - 削除/全消去/復元は fail-closed（呼び出し側で確認 UI を出す）。
 */
import {
  STORE,
  deleteRecord,
  getAll,
  getKv,
  runRead,
  runWrite,
  type StoreName,
} from './db';
import { defaultAccounts, defaultSettings, newMeta } from './seed';
import { newId } from '../domain/ids';
import {
  CONTINUOUS_COST_LEDGER_ACCOUNT_ID,
  CONTINUOUS_COST_LEDGER_ACCOUNT_NAME,
  MAX_LEDGER_REVISION,
  SCHEMA_VERSION,
} from '../domain/constants';
import { isInternalRole, roleAllowsType, type AccountRole } from '../domain/accountRoles';
import { compareAccountOrder } from '../domain/accountOrder';
import { isAccountReferenced, type AccountRefCollections } from '../domain/accountRefs';
import { findAccountNameConflicts, planArchiveRenames } from '../domain/accountNames';
import { LedgerError } from '../domain/errors';
import { isValidIsoDate } from '../domain/calendar';
import {
  cashflowScheduleSchema,
  journalEntrySchema,
  monthlyCostItemSchema,
  recurringRuleSchema,
} from '../domain/schema';
import {
  buildRuleItem,
  isRecurringPostableRole,
  recurringCursorAfter,
  recurringKindOf,
  recurringPostingsDue,
  ruleItemCoverageThrough,
  ruleItemId,
} from '../domain/recurring';
import type {
  Account,
  AccountType,
  CashflowSchedule,
  EntryMetadata,
  InputMode,
  JournalEntry,
  JournalLine,
  Ledger,
  LedgerMeta,
  MonthlyCostItem,
  RecurringRule,
  Settings,
  Snapshot,
  Tag,
} from '../domain/types';
import { addMonths, addMonthsToDate, monthlyAmounts, monthOf } from '../domain/allocation';
import { buildScheduleEntry } from '../domain/cashflow';
import { compareMonthlyCostItems } from '../domain/monthlyCost';
import { buildAdjustmentEntry, counterpartName, counterpartRole } from '../domain/adjustment';
import { accountBalance, filterByDateRange } from '../domain/accounting';
import { reportEntriesForAsOf } from '../domain/reportEntries';
import { isTagReferenced, tagAssignmentError } from '../domain/tags';
import { nowIso, todayLocal } from '../util/time';

async function tagMap(): Promise<Map<string, Tag>> {
  const tags = await getAll<Tag>(STORE.tags);
  return new Map(tags.map((t) => [t.id, t]));
}

const KV_META = 'meta';
const KV_SETTINGS = 'settings';
const OPENING_EQUITY_NAME = '初期残高';

async function getMeta(): Promise<LedgerMeta | undefined> {
  return getKv<LedgerMeta>(KV_META);
}

/**
 * このタブが最後に見た meta.revision（楽観的並行制御・監査 P1-5/P1-8）。
 * loadLedger と書込み成功時に更新し、writeWithRevision が transaction 内で照合する。
 * 各操作の事前読み（check）と書込み（act）の間に別タブが書いていれば revision が
 * 進んでいるため、照合失敗 = 全体 abort で不変条件の破壊を防ぐ。kv store を含む
 * readwrite transaction どうしは直列化されるので、この照合は原子的に効く。
 */
export type LedgerVersion = Pick<LedgerMeta, 'deviceId' | 'revision'>;

let lastSeenVersion: LedgerVersion | undefined;
let activeMutationVersion: LedgerVersion | undefined;
let mutationTail: Promise<void> = Promise.resolve();

function ledgerVersion(meta: LedgerMeta): LedgerVersion {
  return { deviceId: meta.deviceId, revision: meta.revision };
}

function sameLedgerVersion(a: LedgerVersion, b: LedgerVersion): boolean {
  return a.deviceId === b.deviceId && a.revision === b.revision;
}

/**
 * 同一タブの変更操作を、事前読込から保存完了まで直列化する。
 *
 * IndexedDB の write transaction だけを直列化しても、A/B が並行して事前検証し、A の保存後に
 * B が新しい共有 tracker を拾うと B の古い検証結果が通る。operation を lock 取得後に開始し、
 * その時点の台帳世代を activeMutationVersion に固定して writeWithRevision へ渡す。
 */
function serializeMutation<Args extends unknown[], Result>(
  operation: (...args: Args) => Promise<Result>,
): (...args: Args) => Promise<Result> {
  return async (...args) => {
    let release!: () => void;
    const previous = mutationTail;
    mutationTail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      const current = lastSeenVersion ? undefined : await getMeta();
      activeMutationVersion = lastSeenVersion ?? (current ? ledgerVersion(current) : undefined);
      return await operation(...args);
    } finally {
      activeMutationVersion = undefined;
      release();
    }
  };
}

/** テスト用: revision トラッカと起動時フラグを初期状態へ戻す。 */
export function _resetRepositoryStateForTests(): void {
  lastSeenVersion = undefined;
  activeMutationVersion = undefined;
  mutationTail = Promise.resolve();
  snapshotsPruned = false;
}

/**
 * 旧版 DB（meta.schemaVersion 不一致）を現行データとして読み書きしない（fail-closed・監査 P1-4）。
 * 後方互換をコードで持たない（作者決定）ため、ここで検出して復旧面（JSON 読み込み /
 * DB 初期化）へ送る。catch-up・通常の書込み・export より前に必ず通ること——旧レコードを
 * 現行型として解釈して書き換えたり、現行版を名乗る復元不能 JSON を作ったりしない。
 */
function assertSchemaVersionCurrent(meta: LedgerMeta | undefined): void {
  if (meta !== undefined && meta.schemaVersion !== SCHEMA_VERSION) {
    throw new LedgerError('error.db.schemaVersionMismatch', {
      found: meta.schemaVersion,
      expected: SCHEMA_VERSION,
    });
  }
}

/** 初回だけ既定データを投入する。 */
export async function ensureInitialized(): Promise<void> {
  const meta = await getMeta();
  if (meta) {
    // 後方互換をコードで持たない（作者決定）ため、起動時の schemaVersion 追従
    // （恒等移行等）はここには無い。版不一致は fail-closed に止めて復旧面へ送る。
    assertSchemaVersionCurrent(meta);
    // 初期残高科目は role を正本に同じ transaction で現行名へ揃える。
    await normalizeOpeningEquityName();
    return;
  }
  const accounts = defaultAccounts();
  const settings = defaultSettings();
  const meta0 = newMeta();
  await runWrite([STORE.kv, STORE.accounts], (t) => {
    // 並行初期化（StrictMode の二重 effect・複数タブの同時初回起動）で seed が二重投入されない
    // よう、同一トランザクション内で meta を再確認してから書く（IDB の同 store トランザクションは
    // 直列化されるため、負けた側はここで何もしない）。
    const kv = t.objectStore(STORE.kv);
    const probe = kv.get(KV_META);
    probe.onsuccess = () => {
      if (probe.result) return;
      kv.put(meta0, KV_META);
      kv.put(settings, KV_SETTINGS);
      const store = t.objectStore(STORE.accounts);
      for (const a of accounts) store.put(a);
    };
  });
}

/**
 * hidden な equity 科目の名称を role 基準で一度だけ現行表記へ揃える。
 *
 * 改名が安全でないとき（equity が複数 / 改名先を別の科目が使用中）は **何もせず起動を続ける**。
 * ここは loadLedger の冒頭なので、throw すると「初期残高」という名前の費用カテゴリを 1 つ作った
 * だけでアプリが二度と開かなくなる。表示名の現行化は起動をブロックしてよい種類の不変条件ではない。
 */
async function normalizeOpeningEquityName(): Promise<void> {
  await runWrite([STORE.accounts, STORE.kv], (t) => {
    const accounts = t.objectStore(STORE.accounts);
    const probe = accounts.getAll();
    probe.onsuccess = () => {
      const all = probe.result as Account[];
      const equities = all.filter((account) => account.role === 'equity' && !account.archived);
      // 改名対象を一意に決められないので触らない。
      if (equities.length !== 1) return;
      const equity = equities[0];
      if (!equity || equity.name === OPENING_EQUITY_NAME) return;
      const nameConflict = all.some(
        (account) =>
          account.id !== equity.id &&
          !account.archived &&
          account.name.trim() === OPENING_EQUITY_NAME,
      );
      // 改名すると重複名を作ってしまうので触らない（起動は続ける）。
      if (nameConflict) return;
      const ts = nowIso();
      const kv = t.objectStore(STORE.kv);
      const metaProbe = kv.get(KV_META);
      metaProbe.onsuccess = () => {
        const current = metaProbe.result as LedgerMeta | undefined;
        // 表示名の正規化は補助処理。revision を安全に進められないなら本体も変更しない。
        if (!current || current.revision >= MAX_LEDGER_REVISION) return;
        accounts.put({ ...equity, name: OPENING_EQUITY_NAME, updatedAt: ts });
        kv.put({ ...current, revision: current.revision + 1, updatedAt: ts }, KV_META);
      };
    };
  });
}

/**
 * 現行スキーマで復元できないスナップショットを削除する（版上げ時の剪定・§復旧面）。
 * migration チェーンは空（後方互換を持たない）ため、schemaVersion 不一致のスナップショットは
 * 「使えるように見えて復元不能」なまま並び続ける。起動時に 1 回だけ掃除する。
 */
export async function pruneIncompatibleSnapshots(): Promise<number> {
  const all = await getAll<Snapshot>(STORE.snapshots);
  const stale = all.filter((s) => s.data?.schemaVersion !== SCHEMA_VERSION);
  for (const s of stale) await deleteRecord(STORE.snapshots, s.id);
  return stale.length;
}

let snapshotsPruned = false;

export async function loadLedger(): Promise<Ledger> {
  await ensureInitialized();
  if (!snapshotsPruned) {
    snapshotsPruned = true;
    // 剪定の失敗で起動を止めない（fail-soft）。
    await pruneIncompatibleSnapshots().catch(() => undefined);
  }
  const requestResult = <T>(request: IDBRequest<T>): Promise<T> =>
    new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error ?? new Error('IndexedDB request failed'));
    });
  // meta と各本体 store は同一 readonly transaction で読む。別タブの複数 store 書込みと
  // 読取りが交差して、存在しない中間状態を export / snapshot に残さない。
  const [
    meta,
    settings,
    accounts,
    journalEntries,
    cashflowSchedules,
    tags,
    monthlyCostItems,
    recurringRules,
  ] = await runRead(
    [
      STORE.kv,
      STORE.accounts,
      STORE.journalEntries,
      STORE.cashflowSchedules,
      STORE.tags,
      STORE.monthlyCostItems,
      STORE.recurringRules,
    ],
    (t) => {
      const kv = t.objectStore(STORE.kv);
      return Promise.all([
        requestResult(kv.get(KV_META) as IDBRequest<LedgerMeta | undefined>),
        requestResult(kv.get(KV_SETTINGS) as IDBRequest<Settings | undefined>),
        requestResult(t.objectStore(STORE.accounts).getAll() as IDBRequest<Account[]>),
        requestResult(t.objectStore(STORE.journalEntries).getAll() as IDBRequest<JournalEntry[]>),
        requestResult(
          t.objectStore(STORE.cashflowSchedules).getAll() as IDBRequest<CashflowSchedule[]>,
        ),
        requestResult(t.objectStore(STORE.tags).getAll() as IDBRequest<Tag[]>),
        requestResult(
          t.objectStore(STORE.monthlyCostItems).getAll() as IDBRequest<MonthlyCostItem[]>,
        ),
        requestResult(t.objectStore(STORE.recurringRules).getAll() as IDBRequest<RecurringRule[]>),
      ]);
    },
  );
  if (!meta || !settings) throw new Error('台帳の初期化に失敗しました');
  lastSeenVersion = ledgerVersion(meta);
  accounts.sort(compareAccountOrder);
  // 一覧の安定した既定順: 仕訳は日付降順 → 作成降順。
  journalEntries.sort((a, b) =>
    a.date === b.date ? cmp(b.createdAt, a.createdAt) : cmp(b.date, a.date),
  );
  // 予定 CF は期日昇順。
  cashflowSchedules.sort((a, b) => cmp(a.dueDate, b.dueDate));
  tags.sort((a, b) => a.name.localeCompare(b.name, 'ja'));
  // 継続コスト資産は「終了が近い順」（endDate 昇順・未設定は最後・同着は名前）。
  monthlyCostItems.sort(compareMonthlyCostItems);
  recurringRules.sort((a, b) => cmp(a.createdAt, b.createdAt));
  // 導出専用 entries は持たない。集計は各画面が reportEntriesForAsOf で
  // 基準日ごとに必要範囲だけ仮想展開する（単一正本 = reportBasis + reportEntriesForAsOf）。
  return {
    meta,
    settings,
    accounts,
    journalEntries,
    cashflowSchedules,
    tags,
    monthlyCostItems,
    recurringRules,
  };
}

function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * 本体の変更と meta.revision の更新を **同一トランザクション** で行う。
 * 後段だけ失敗して「データは変わったが revision は進まない」状態を防ぐ。
 * revision は JSON import の競合判定に使うため、本体と必ず歩調を合わせる。
 * さらに transaction 内で操作開始時の revision と照合し、事前読みからの並行変更を検出したら
 * 何も書かずに abort する（stale な検証結果で保存しない）。expectedVersion を明示した操作は、
 * 途中で同一タブの lastSeenVersion が変わっても開始時の値を保持する。
 */
async function writeWithRevision(
  stores: StoreName[],
  apply: (t: IDBTransaction) => void,
  expectedVersion: LedgerVersion | undefined = activeMutationVersion ?? lastSeenVersion,
): Promise<void> {
  const all = stores.includes(STORE.kv) ? stores : [...stores, STORE.kv];
  let staleRace = false;
  let revisionExhausted = false;
  let nextRevision: number | undefined;
  let nextDeviceId: string | undefined;
  try {
    await runWrite(all, (t) => {
      const kv = t.objectStore(STORE.kv);
      const req = kv.get(KV_META);
      req.onsuccess = () => {
        const m = req.result as LedgerMeta | undefined;
        if (
          expectedVersion !== undefined &&
          (!m || !sameLedgerVersion(ledgerVersion(m), expectedVersion))
        ) {
          staleRace = true;
          t.abort();
          return;
        }
        if (m && m.revision >= MAX_LEDGER_REVISION) {
          revisionExhausted = true;
          t.abort();
          return;
        }
        apply(t);
        if (m) {
          nextRevision = m.revision + 1;
          nextDeviceId = m.deviceId;
          kv.put({ ...m, revision: nextRevision, updatedAt: nowIso() }, KV_META);
        }
      };
    });
  } catch (error) {
    if (staleRace) throw new LedgerError('error.common.staleData');
    if (revisionExhausted) throw new LedgerError('error.common.revisionExhausted');
    throw error;
  }
  // 成功が確定してからトラッカを進める（abort 時に進めない）。
  if (nextRevision !== undefined && nextDeviceId !== undefined) {
    lastSeenVersion = { deviceId: nextDeviceId, revision: nextRevision };
  }
}

/* ── 保存境界の共通バリデータ（import / schema と同じ不変条件をアプリ内保存でも守る） ── */

function accountsById(accounts: Account[]): Map<string, Account> {
  return new Map(accounts.map((a) => [a.id, a]));
}

/** 保存境界の検証に必要な参照集合（科目）。 */
interface SaveContext {
  byId: Map<string, Account>;
}

async function loadSaveContext(): Promise<SaveContext> {
  const accounts = await getAll<Account>(STORE.accounts);
  return { byId: accountsById(accounts) };
}

/**
 * 仕訳を IndexedDB へ保存する前の構造・参照検証（fail-closed）。
 *  - journalEntrySchema（2 行・借方1/貸方1・同額・正の整数金額・ISO 日付）を満たすこと。
 *  - 各明細の accountId が既存 Account を参照し、role と type が整合していること。
 * UI で検証済みでも、repository を最後の保存境界として必ず通す。
 *
 * **戻り値を保存値に使うこと**（assertMonthlyCostItemSavable と同じ契約）。zod が未知キーを
 * 落とした結果を返すので、撤去済みフィールドの残骸を持つ既存仕訳が編集のたびに自己修復する。
 */
function assertEntrySavable(entry: JournalEntry, ctx: SaveContext): JournalEntry {
  if (
    entry.metadata?.virtual !== undefined ||
    entry.metadata?.ccKind !== undefined ||
    entry.metadata?.continuousCostId !== undefined
  ) {
    throw new LedgerError('error.entry.virtual');
  }
  const parsed = journalEntrySchema.safeParse(entry);
  if (!parsed.success) {
    throw new LedgerError('error.entry.invalidStructure');
  }
  for (const line of entry.lines) {
    const account = ctx.byId.get(line.accountId);
    if (!account) throw new LedgerError('error.entry.unknownAccount');
    if (!roleAllowsType(account.role, account.type)) {
      throw new LedgerError('error.entry.accountRoleMismatch');
    }
  }
  // 継続コスト台帳の不変条件（import schema の⑧⑨と同値をアプリ内保存でも守る）:
  //  - 台帳を借方/貸方に持つ保存仕訳は必ず monthlyCostId を持つ
  //    （借方に台帳 = 購入の仕訳 / 貸方に台帳 = 回収の振替。この 2 種類しかない）。
  //  - 購入の仕訳は 借方 = 台帳・貸方（支払い元）は起票可能な全 role
  //    （RECURRING_POSTABLE_ROLES = 内部集約・残高調整以外。equity=初期残高・給与等の
  //    income-category も可 = 例: 健康保険を 銀行→給与 として台帳経由で登録できる）。
  //  - 回収の振替は 貸方 = 台帳。回収額の上限は設けない（作者決定 2026-07-29）。
  const debitLine = parsed.data.lines.find((l) => l.side === 'debit');
  const creditLine = parsed.data.lines.find((l) => l.side === 'credit');
  const debitLedger = debitLine?.accountId === CONTINUOUS_COST_LEDGER_ACCOUNT_ID;
  const creditLedger = creditLine?.accountId === CONTINUOUS_COST_LEDGER_ACCOUNT_ID;
  const mcId = parsed.data.metadata?.monthlyCostId;
  const recovery = parsed.data.metadata?.monthlyCostRecovery === true;
  if ((debitLedger || creditLedger) && mcId === undefined) {
    throw new LedgerError('error.entry.ledgerAccount');
  }
  if (recovery && (mcId === undefined || !creditLedger)) {
    throw new LedgerError('error.entry.ledgerAccount');
  }
  if (recovery) {
    // 回収の振替の借方 = 振替先。台帳自身は禁止（自己振替は回収集計だけを動かし
    // 「台帳残高 = 残存価値」を壊す）。振替先は簿記編集と同じく、内部集約・
    // 残高調整以外の全 role を許可する（作者決定 2026-07-30）。
    if (debitLedger) throw new LedgerError('error.entry.ledgerAccount');
    const debitRole = debitLine ? ctx.byId.get(debitLine.accountId)?.role : undefined;
    if (!isRecurringPostableRole(debitRole)) {
      throw new LedgerError('error.monthlyCost.recoveryDestination');
    }
  }
  if (mcId !== undefined && !recovery) {
    if (!debitLedger) throw new LedgerError('error.entry.ledgerAccount');
    const creditRole = creditLine ? ctx.byId.get(creditLine.accountId)?.role : undefined;
    if (!isRecurringPostableRole(creditRole)) {
      throw new LedgerError('error.monthlyCost.paymentSource');
    }
  }
  return parsed.data;
}

/**
 * 予定 CF を保存する前の構造・参照検証（fail-closed）。
 *  - cashflowScheduleSchema（正の整数金額・ISO 期日・direction/source/status の enum 等）を満たすこと。
 *  - accountId・counterAccountId（あれば）が既存 Account を参照していること。
 */
function assertSchedulesSavable(schedules: CashflowSchedule[], ctx: SaveContext): void {
  for (const s of schedules) {
    if (!cashflowScheduleSchema.safeParse(s).success) {
      throw new LedgerError('error.schedule.invalidStructure');
    }
    if (!ctx.byId.has(s.accountId)) throw new LedgerError('error.schedule.unknownAccount');
    if (s.counterAccountId !== undefined && !ctx.byId.has(s.counterAccountId)) {
      throw new LedgerError('error.schedule.unknownAccount');
    }
  }
}

/**
 * 月額化項目を保存する全経路で import schema と同じ構造・期間不変条件を守る。
 *
 * **戻り値を保存値に使うこと**。zod が未知キーを落とした結果を返すので、撤去済みフィールドの
 * 残骸を持つ既存レコード（IndexedDB の生レコードを spread した保存値）が編集のたびに
 * 自己修復的に掃除される。
 */
function assertMonthlyCostItemSavable(item: MonthlyCostItem): MonthlyCostItem {
  const parsed = monthlyCostItemSchema.safeParse(item);
  if (!parsed.success) {
    throw new LedgerError('error.monthlyCost.invalidStructure');
  }
  return parsed.data;
}

/** throw できない箇所（tx コールバック内）向けの best-effort strip。失敗時は入力をそのまま返す。 */
function stripMonthlyCostItem(item: MonthlyCostItem): MonthlyCostItem {
  const parsed = monthlyCostItemSchema.safeParse(item);
  return parsed.success ? parsed.data : item;
}

/* ── 勘定科目 ── */

async function loadReferencingCollections(): Promise<AccountRefCollections> {
  const [entries, schedules, monthlyCostItems, recurringRules] = await Promise.all([
    getAll<JournalEntry>(STORE.journalEntries),
    getAll<CashflowSchedule>(STORE.cashflowSchedules),
    getAll<MonthlyCostItem>(STORE.monthlyCostItems),
    getAll<RecurringRule>(STORE.recurringRules),
  ]);
  return { entries, schedules, monthlyCostItems, recurringRules };
}

export interface AccountSaveOptions {
  /**
   * 同名のアーカイブ済み科目があるとき、`（アーカイブ）` / `（アーカイブ2）` … を末尾に付けて
   * 退避してから保存する（ユーザー承認済みの場合だけ true にする）。
   */
  renameArchivedConflicts?: boolean;
}

/**
 * 名前の重複を保存境界で検証する（内訳名は箱をまたいでも重複不可）。
 * 有効な同名 → nameConflict。アーカイブ済みの同名 → 承認済みなら退避リネーム計画を返し、
 * 未承認なら nameConflictArchived（UI が確認ダイアログを出して再試行する）。
 */
function resolveAccountNameConflicts(
  accounts: Account[],
  name: string,
  excludeId: string,
  opts?: AccountSaveOptions,
): Account[] {
  const conflicts = findAccountNameConflicts(accounts, name, excludeId);
  if (conflicts.active) throw new LedgerError('error.account.nameConflict');
  if (conflicts.archived.length === 0) return [];
  if (!opts?.renameArchivedConflicts) {
    throw new LedgerError('error.account.nameConflictArchived');
  }
  const ts = nowIso();
  return planArchiveRenames(accounts, name, excludeId).map((p) => ({
    ...p.account,
    name: p.newName,
    updatedAt: ts,
  }));
}

async function upsertAccountUnlocked(input: Account, opts?: AccountSaveOptions): Promise<void> {
  // 「自由に動かせる」フラグの正規化（保存境界・fail-soft）:
  //  - true は undefined へ（既定 ON なのでレコードを最小に保つ）。
  //  - daily-asset 以外に付いていたら剥がす（拒否せず自己修復）。
  // false かつ daily-asset のときだけ保存される（= 自由に動かせない印）。
  const account: Account = { ...input };
  if (!(account.movable === false && account.role === 'daily-asset')) {
    delete account.movable;
  }
  if (account.name.trim() === '') throw new LedgerError('error.common.nameRequired');
  // role は type と整合する必要がある（import 検証と同じ不変条件を保存時にも守る）。
  if (!roleAllowsType(account.role, account.type)) {
    throw new LedgerError('error.account.roleTypeMismatch');
  }
  // 使用中（仕訳/予定CF/継続コストから参照中）の科目は区分(type)も役割(role)も変更できない。
  // role 変更は表示上の「大きな箱の移動」に相当するため fail-closed（新しい内訳を作って
  // アーカイブする運用に寄せる）。
  const [accounts, refs] = await Promise.all([
    getAll<Account>(STORE.accounts),
    loadReferencingCollections(),
  ]);
  const prev = accounts.find((a) => a.id === account.id);
  if (prev && prev.type !== account.type) {
    if (isAccountReferenced(account.id, refs)) {
      throw new LedgerError('error.account.typeLocked');
    }
  }
  if (prev && prev.role !== account.role) {
    if (isAccountReferenced(account.id, refs)) {
      throw new LedgerError('error.account.roleLocked');
    }
  }
  // 返済設定は負債（カード・未払 / ローン）のみ。返済口座は存在する日常資産、返済日は 1〜31。
  const isLiabilityRole =
    account.role === 'payment-liability' || account.role === 'other-liability';
  if (account.repaymentAccountId !== undefined) {
    if (!isLiabilityRole) throw new LedgerError('error.account.repaymentOnlyLiability');
    const repay = accounts.find((a) => a.id === account.repaymentAccountId);
    if (!repay || repay.role !== 'daily-asset')
      throw new LedgerError('error.monthlyCost.repaymentAccount');
  }
  if (account.repaymentDay !== undefined) {
    if (!isLiabilityRole) throw new LedgerError('error.account.repaymentOnlyLiability');
    if (
      !Number.isInteger(account.repaymentDay) ||
      account.repaymentDay < 1 ||
      account.repaymentDay > 31
    )
      throw new LedgerError('error.account.repaymentDayInvalid');
  }
  // 不変条件: アーカイブ済み = 今日時点の残高 0（資産・負債のみ）。UI を通らない経路も塞ぐ。
  // 残高は画面と同じ導出仕訳（継続コストの費用行・定期ルールの投影込み）で判定する
  // （保存仕訳だけで判定すると、月割りの行き先科目など「画面では残高がある」科目を
  // アーカイブできてしまう・監査 P1-2）。残高があるなら先に振替（archiveAccount の振替導線）。
  // アーカイブ解除はチェック不要。
  if (
    account.archived &&
    !prev?.archived &&
    (account.type === 'asset' || account.type === 'liability')
  ) {
    const today = todayLocal();
    const derived = reportEntriesForAsOf(
      {
        accounts,
        journalEntries: refs.entries,
        monthlyCostItems: refs.monthlyCostItems,
        recurringRules: refs.recurringRules,
      },
      today,
    );
    const balance = accountBalance(
      account.id,
      account.type,
      filterByDateRange(derived, undefined, today),
    );
    if (balance !== 0) throw new LedgerError('error.account.archiveBalance');
  }
  // 内訳名は箱をまたいでも重複不可。アーカイブ済みとの衝突は承認済みなら退避してから保存する。
  const renamedArchived = resolveAccountNameConflicts(accounts, account.name, account.id, opts);
  await writeWithRevision([STORE.accounts], (t) => {
    const store = t.objectStore(STORE.accounts);
    for (const renamed of renamedArchived) store.put(renamed);
    store.put(account);
  });
}

/**
 * 科目の表示順を保存する（並び替えモードの確定）。ids の配列順を sortIndex 0..n として
 * 該当科目へ書き込む（1 トランザクション）。ids に無い科目の sortIndex は変更しない。
 */
async function reorderAccountsUnlocked(ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  const accounts = await getAll<Account>(STORE.accounts);
  const byId = new Map(accounts.map((a) => [a.id, a] as const));
  const ts = nowIso();
  const updated: Account[] = [];
  ids.forEach((id, i) => {
    const account = byId.get(id);
    if (!account) throw new LedgerError('error.adjust.targetNotFound');
    updated.push({ ...account, sortIndex: i, updatedAt: ts });
  });
  await writeWithRevision([STORE.accounts], (t) => {
    const store = t.objectStore(STORE.accounts);
    for (const a of updated) store.put(a);
  });
}

/** 使用中（仕訳/予定CF/継続コストから参照中）の科目は削除できない（アーカイブを使う）。fail-closed。 */
async function deleteAccountUnlocked(id: string): Promise<void> {
  const refs = await loadReferencingCollections();
  if (isAccountReferenced(id, refs)) {
    throw new LedgerError('error.account.deleteInUse');
  }
  // この科目を返済口座として設定している負債から、設定ポインタを同一トランザクションで剥がす
  // （設定は予定 CF の既定値にすぎないため、削除を塞がず fail-soft に外す）。
  const accounts = await getAll<Account>(STORE.accounts);
  // 継続コスト台帳は定数参照（item が recognitionCreditAccountId を持たない）ため参照カウントに
  // 乗らない。role で削除を fail-closed に拒否する（消すと費用行の導出先が消える）。
  if (accounts.find((a) => a.id === id)?.role === 'continuing-cost-asset') {
    throw new LedgerError('error.account.deleteInUse');
  }
  const ts = nowIso();
  const cleared = accounts
    .filter((a) => a.repaymentAccountId === id)
    .map((a) => {
      const next: Account = { ...a, updatedAt: ts };
      delete next.repaymentAccountId;
      return next;
    });
  await writeWithRevision([STORE.accounts], (t) => {
    const store = t.objectStore(STORE.accounts);
    for (const a of cleared) store.put(a);
    store.delete(id);
  });
}

/**
 * 勘定科目をアーカイブする。残高が残っている資産・負債は、振替仕訳（UI = ホームの振替と
 * 同じシート）を同一トランザクションで保存して残高を 0 にしてからアーカイブする。
 * 不変条件「アーカイブ済み = 今日時点の残高 0」を保存境界で fail-closed に守る
 * （振替後も 0 にならない金額・日付なら全体を拒否 = 残高が宙に浮く状態を作らない）。
 * 残高 0（または収入/支出/純資産/調整の科目）は transferEntry なしで即アーカイブできる。
 */
async function archiveAccountUnlocked(id: string, transferEntry?: JournalEntry): Promise<void> {
  const [accounts, entries, monthlyCostItems, recurringRules] = await Promise.all([
    getAll<Account>(STORE.accounts),
    getAll<JournalEntry>(STORE.journalEntries),
    getAll<MonthlyCostItem>(STORE.monthlyCostItems),
    getAll<RecurringRule>(STORE.recurringRules),
  ]);
  const target = accounts.find((a) => a.id === id);
  if (!target) throw new LedgerError('error.adjust.targetNotFound');
  const ctx: SaveContext = { byId: accountsById(accounts) };
  let savable: JournalEntry | undefined;
  if (transferEntry) {
    if (transferEntry.metadata?.monthlyCostId) throw new LedgerError('error.entry.monthlyCost');
    savable = assertEntrySavable(transferEntry, ctx);
    if (!savable.lines.some((l) => l.accountId === id)) {
      throw new LedgerError('error.entry.unknownAccount');
    }
    await assertEntryTagsValid(savable);
  }
  if (target.type === 'asset' || target.type === 'liability') {
    // 残高は画面と同じ導出仕訳（継続コストの費用行・定期ルールの投影込み）で判定する（監査 P1-2）。
    const withTransfer = savable
      ? [...entries.filter((e) => e.id !== savable!.id), savable]
      : entries;
    const today = todayLocal();
    const derived = reportEntriesForAsOf(
      { accounts, journalEntries: withTransfer, monthlyCostItems, recurringRules },
      today,
    );
    const balance = accountBalance(id, target.type, filterByDateRange(derived, undefined, today));
    if (balance !== 0) throw new LedgerError('error.account.archiveBalance');
  }
  const ts = nowIso();
  await writeWithRevision([STORE.accounts, STORE.journalEntries], (t) => {
    if (savable) t.objectStore(STORE.journalEntries).put(savable);
    t.objectStore(STORE.accounts).put({ ...target, archived: true, updatedAt: ts });
  });
}

/* ── 仕訳 ── */

/**
 * 通常経路で上書き・削除してはいけない保存仕訳の保護（fail-closed）:
 *  - 購入の仕訳（monthlyCostId あり・monthlyCostRecovery なし）: **削除不可**（item 削除で cascade）。
 *    編集は upsertEntry の専用経路（日付・金額を item へミラー）だけが扱う。
 *  - 回収の振替（monthlyCostId + monthlyCostRecovery）: 普通のユーザー入力の振替として編集・削除可。
 *  - 残高補正（adjustment）: 専用画面（updateAdjustment / deleteAdjustment）でだけ管理する。
 */
function assertEntryDeletable(target: JournalEntry | undefined): void {
  if (target?.metadata?.monthlyCostId && target.metadata.monthlyCostRecovery !== true) {
    throw new LedgerError('error.entry.monthlyCost');
  }
  if (target?.metadata?.adjustment) throw new LedgerError('error.entry.adjustment');
}

/** 実績化済み予定の linkedEntry は通常の編集・削除では壊せない。fail-closed。 */
async function assertNotScheduleLinked(id: string): Promise<void> {
  const schedules = await getAll<CashflowSchedule>(STORE.cashflowSchedules);
  if (schedules.some((s) => s.linkedEntryId === id)) {
    throw new LedgerError('error.entry.scheduleLinked');
  }
}

/** 仕訳のタグ代入を import 検証と同じ不変条件で確認する（保存時 fail-closed）。タグは仕訳全体のみ。 */
async function assertEntryTagsValid(entry: JournalEntry): Promise<void> {
  const tags = await tagMap();
  const e1 = tagAssignmentError(entry.tagIds, tags);
  if (e1) throw new LedgerError(e1);
}

async function upsertEntryUnlocked(entry: JournalEntry): Promise<void> {
  const entries = await getAll<JournalEntry>(STORE.journalEntries);
  const existing = entries.find((e) => e.id === entry.id);
  await assertNotScheduleLinked(entry.id);
  // 補正仕訳は専用画面でだけ管理する（現実アンカーを保つ）。ユーザー入力からも作れない。
  if (existing?.metadata?.adjustment || entry.metadata?.adjustment) {
    throw new LedgerError('error.entry.adjustment');
  }

  const existingMcId = existing?.metadata?.monthlyCostId;
  if (existingMcId === undefined) {
    // 通常仕訳: ユーザー入力から継続コストの印（monthlyCostId / 回収フラグ）を持ち込めない。
    if (entry.metadata?.monthlyCostId !== undefined || entry.metadata?.monthlyCostRecovery) {
      throw new LedgerError('error.entry.monthlyCost');
    }
    const ctx = await loadSaveContext();
    const savable = assertEntrySavable(entry, ctx);
    await assertEntryTagsValid(savable);
    await writeWithRevision([STORE.journalEntries], (t) => {
      t.objectStore(STORE.journalEntries).put(savable);
    });
    return;
  }

  // 継続コスト資産に紐づく仕訳の編集: 印は保存境界で固定する（UI が落としても剥がれない）。
  const existingRecovery = existing?.metadata?.monthlyCostRecovery === true;
  const metadata: EntryMetadata = {
    ...entry.metadata,
    monthlyCostId: existingMcId,
    ...(existingRecovery ? { monthlyCostRecovery: true as const } : {}),
  };
  if (!existingRecovery) delete metadata.monthlyCostRecovery;
  const ctx = await loadSaveContext();
  const nextCreditRole = ctx.byId.get(
    entry.lines.find((l) => l.side === 'credit')?.accountId ?? '',
  )?.role;
  const candidate: JournalEntry = {
    ...entry,
    // 購入の仕訳の kind は貸方 role から導出する（equity = 持ち込み(opening) / それ以外 = normal。
    // 支払い元を初期残高⇄通常科目で付け替えたとき kind が実態とずれない・監査 P3-1）。
    kind: existingRecovery
      ? (existing?.kind ?? entry.kind)
      : nextCreditRole === 'equity'
        ? 'opening'
        : 'normal',
    metadata,
  };
  // 借方=台帳の固定・貸方 role・回収の形は assertEntrySavable が検証する。
  const savable = assertEntrySavable(candidate, ctx);
  await assertEntryTagsValid(savable);

  if (existingRecovery) {
    // 回収の振替: 日付は開始日（購入の仕訳の日付）以降のみ。購入前の期間に台帳が
    // 負になる断面を作らない（監査 P1-1。import schema と同じ不変条件）。
    const items = await getAll<MonthlyCostItem>(STORE.monthlyCostItems);
    const recoveryItem = items.find((m) => m.id === existingMcId);
    if (recoveryItem && savable.date < recoveryItem.startDate) {
      throw new LedgerError('error.monthlyCost.recoveryBeforeStart');
    }
    // 普通の振替として保存（割り振る総額は導出側が再計算する）。
    await writeWithRevision([STORE.journalEntries], (t) => {
      t.objectStore(STORE.journalEntries).put(savable);
    });
    return;
  }

  // 負債（カード・ローン）で買った購入の仕訳は、支払い元・金額・日付を変更できない
  // （fail-closed・監査 P1-6 + 再監査対応）: 自動作成した返済の実仕訳には意図的に
  // monthlyCostId が無く追跡できないため、貸方の付け替え・金額変更で借入だけが消えて返済が残り、
  // 日付の後ろ倒しでは返済が購入より先に立って負債が途中でマイナスになる。
  // 摘要・メモ・タグは変更できる。終了は項目のアーカイブで行う。
  const prevCreditLine = existing?.lines.find((l) => l.side === 'credit');
  const prevCreditRole = prevCreditLine ? ctx.byId.get(prevCreditLine.accountId)?.role : undefined;
  if (prevCreditRole === 'payment-liability' || prevCreditRole === 'other-liability') {
    const nextCredit = savable.lines.find((l) => l.side === 'credit');
    if (
      nextCredit?.accountId !== prevCreditLine?.accountId ||
      nextCredit?.amount !== prevCreditLine?.amount ||
      savable.date !== existing?.date
    ) {
      throw new LedgerError('error.monthlyCost.editLiability');
    }
  }

  // 購入日を回収の振替より後ろへ動かさない（回収が購入前になる状態を作らない・監査 P1-1）。
  const recoveries = entries.filter(
    (e) => e.metadata?.monthlyCostId === existingMcId && e.metadata.monthlyCostRecovery === true,
  );
  if (recoveries.some((r) => r.date < savable.date)) {
    throw new LedgerError('error.monthlyCost.recoveryBeforeStart');
  }

  // 購入の仕訳: 日付・金額を item へ同一トランザクションでミラーする（開始日の正本は仕訳の日付）。
  const debitAmount = savable.lines.find((l) => l.side === 'debit')?.amount ?? 0;
  let missingRace = false;
  let afterEndRace = false;
  try {
    await writeWithRevision([STORE.journalEntries, STORE.monthlyCostItems], (t) => {
      const iStore = t.objectStore(STORE.monthlyCostItems);
      const probe = iStore.get(existingMcId);
      probe.onsuccess = () => {
        const item = probe.result as MonthlyCostItem | undefined;
        if (!item) {
          missingRace = true;
          t.abort();
          return;
        }
        // 日付を終了日より後ろへ動かすのは拒否（不変条件: endDate >= startDate）。
        if (item.endDate !== undefined && savable.date > item.endDate) {
          afterEndRace = true;
          t.abort();
          return;
        }
        t.objectStore(STORE.journalEntries).put(savable);
        iStore.put(
          stripMonthlyCostItem({
            ...item,
            amount: debitAmount,
            startDate: savable.date,
            updatedAt: savable.updatedAt,
          }),
        );
      };
    });
  } catch (error) {
    if (missingRace) throw new LedgerError('error.monthlyCost.notFound');
    if (afterEndRace) throw new LedgerError('error.monthlyCost.purchaseAfterEnd');
    throw error;
  }
}

async function deleteEntryUnlocked(id: string): Promise<void> {
  const entries = await getAll<JournalEntry>(STORE.journalEntries);
  assertEntryDeletable(entries.find((e) => e.id === id));
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
async function saveEntryWithSchedulesUnlocked(
  entry: JournalEntry,
  schedules: CashflowSchedule[],
): Promise<void> {
  const entries = await getAll<JournalEntry>(STORE.journalEntries);
  assertEntryDeletable(entries.find((e) => e.id === entry.id));
  await assertNotScheduleLinked(entry.id);
  if (entry.metadata?.monthlyCostId) throw new LedgerError('error.entry.monthlyCost');
  const ctx = await loadSaveContext();
  const savable = assertEntrySavable(entry, ctx);
  assertSchedulesSavable(schedules, ctx);
  await assertEntryTagsValid(savable);
  await assertScheduleTagsValid(schedules);
  await writeWithRevision([STORE.journalEntries, STORE.cashflowSchedules], (t) => {
    t.objectStore(STORE.journalEntries).put(savable);
    const sStore = t.objectStore(STORE.cashflowSchedules);
    for (const s of schedules) sStore.put(s);
  });
}

export interface RepaymentPlanInput {
  /** 返す負債（payment-liability | other-liability）。 */
  liabilityAccountId: string;
  /** 返済元（daily-asset）。 */
  fromAccountId: string;
  /** 初回返済日 'YYYY-MM-DD'。2 回目以降は毎月同日（月末クランプは addMonthsToDate に従う）。 */
  firstDate: string;
  /** 返済総額。count で月割り配分し、合計は必ずこれに一致する。 */
  total: number;
  /** 返済回数（>=1）。1 ならカードの次回引落など単発。 */
  count: number;
  /** 仕訳の摘要ベース。count>1 のとき「{title} i/count」になる。 */
  title: string;
}

/**
 * 負債の返済計画を「未来日付の振替実仕訳 N 本」として一括登録する（1 トランザクション）。
 * 予定→実績化の 2 段は経由しない。返済は金額・回数が最初から確定しているため、
 * ルール（毎月のもの）ではなくただの未来仕訳で表す＝完済でぴったり終わる。
 * 各仕訳は 借方 負債 / 貸方 返済元。仕訳一覧・資金繰りの投影にそのまま乗る。
 */
async function createRepaymentEntriesUnlocked(input: RepaymentPlanInput): Promise<JournalEntry[]> {
  if (input.title.trim() === '') throw new LedgerError('error.common.nameRequired');
  const ctx = await loadSaveContext();
  const entries = buildRepaymentEntries(ctx, {
    liabilityAccountId: input.liabilityAccountId,
    fromAccountId: input.fromAccountId,
    firstDate: input.firstDate,
    total: input.total,
    count: input.count,
    title: input.title.trim(),
    ts: nowIso(),
  });
  await writeWithRevision([STORE.journalEntries], (t) => {
    const store = t.objectStore(STORE.journalEntries);
    for (const e of entries) store.put(e);
  });
  return entries;
}

/**
 * 負債払いの分割返済を「未来日付の振替実仕訳 N 本」として組み立てる（予定 CF は作らない）。
 * createRepaymentEntries と同じ形: 借方 負債 / 貸方 返済元(daily-asset)。金額は monthlyAmounts で
 * 配分し合計は必ず total に一致、日付は初回引落日(firstDate)から毎月同日。呼び出し側の
 * 1 トランザクションに同梱して保存する（購入だけ成功して返済が残らない中途半端を作らない）。
 * 返済は実予定（確定した資金移動の計画）なので metadata に monthlyCostId は付けない＝
 * 継続コスト item を削除しても仕訳として残す・ユーザーが自由に編集/削除できる。
 */
function buildRepaymentEntries(
  ctx: SaveContext,
  params: {
    /** 返す負債（payment-liability | other-liability）。 */
    liabilityAccountId: string;
    /** 返済元（daily-asset）。 */
    fromAccountId: string;
    /** 初回引落日 'YYYY-MM-DD'。2 回目以降は毎月同日（月末クランプは addMonthsToDate に従う）。 */
    firstDate: string;
    /** 返済総額。count で月割り配分し、合計は必ずこれに一致する。 */
    total: number;
    /** 返済回数（>=1 整数）。 */
    count: number;
    /** 摘要ベース。count>1 のとき「{title} i/count」になる。 */
    title: string;
    ts: string;
  },
): JournalEntry[] {
  if (!Number.isInteger(params.total) || params.total < 1)
    throw new LedgerError('error.common.amountInvalid');
  if (!Number.isInteger(params.count) || params.count < 1)
    throw new LedgerError('error.repay.countInvalid');
  if (!isValidIsoDate(params.firstDate)) throw new LedgerError('error.monthlyCost.dateRequired');
  const liability = ctx.byId.get(params.liabilityAccountId);
  if (
    !liability ||
    (liability.role !== 'payment-liability' && liability.role !== 'other-liability')
  )
    throw new LedgerError('error.repay.liabilityRequired');
  const from = ctx.byId.get(params.fromAccountId);
  if (!from || from.role !== 'daily-asset')
    throw new LedgerError('error.monthlyCost.repaymentAccount');

  const parts = monthlyAmounts(params.total, params.count);
  const entries: JournalEntry[] = parts.map((amount, i) => ({
    id: newId(),
    date: addMonthsToDate(params.firstDate, i),
    description: params.count === 1 ? params.title : `${params.title} ${i + 1}/${params.count}`,
    kind: 'normal',
    lines: [
      { accountId: params.liabilityAccountId, side: 'debit', amount },
      { accountId: params.fromAccountId, side: 'credit', amount },
    ],
    metadata: { inputMode: 'transfer' },
    createdAt: params.ts,
    updatedAt: params.ts,
  }));
  return entries.map((e) => assertEntrySavable(e, ctx));
}

/* ── 設定 ── */

async function updateSettingsUnlocked(settings: Settings): Promise<void> {
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

/**
 * 読み取った台帳のスナップショットを、その台帳世代がまだ現行のときだけ保存する。
 *
 * 全初期化は deviceId を入れ替えて snapshots も消すため、初期化と競合した古い
 * スナップショットを初期化後へ復活させてはならない。kv の版照合と put を同一
 * transaction に置き、revision 更新を伴わない保存にも generation CAS を効かせる。
 */
export async function saveSnapshot(
  snapshot: Snapshot,
  expectedVersion: LedgerVersion,
): Promise<void> {
  let stale = false;
  try {
    await runWrite([STORE.snapshots, STORE.kv], (t) => {
      const metaRequest = t.objectStore(STORE.kv).get(KV_META);
      metaRequest.onsuccess = () => {
        const meta = metaRequest.result as LedgerMeta | undefined;
        if (!meta || !sameLedgerVersion(ledgerVersion(meta), expectedVersion)) {
          stale = true;
          t.abort();
          return;
        }
        t.objectStore(STORE.snapshots).put(snapshot);
      };
    });
  } catch (error) {
    if (stale) throw new LedgerError('error.common.staleData');
    throw error;
  }
}

export async function deleteSnapshot(id: string): Promise<void> {
  await deleteRecord(STORE.snapshots, id);
}

/* ── 予定キャッシュフロー ── */

/** 予定 CF のタグ代入を import 検証と同じ不変条件で確認する。タグは仕訳全体のみ。 */
async function assertScheduleTagsValid(schedules: CashflowSchedule[]): Promise<void> {
  const tags = await tagMap();
  for (const s of schedules) {
    const e1 = tagAssignmentError(s.entryTagIds, tags);
    if (e1) throw new LedgerError(e1);
  }
}

async function upsertScheduleUnlocked(schedule: CashflowSchedule): Promise<void> {
  await upsertSchedulesUnlocked([schedule]);
}

/** 複数の予定（分割払い等）を 1 トランザクションで保存する。 */
async function upsertSchedulesUnlocked(schedules: CashflowSchedule[]): Promise<void> {
  const ctx = await loadSaveContext();
  assertSchedulesSavable(schedules, ctx);
  await assertScheduleTagsValid(schedules);
  await writeWithRevision([STORE.cashflowSchedules], (t) => {
    const store = t.objectStore(STORE.cashflowSchedules);
    for (const s of schedules) store.put(s);
  });
}

async function deleteScheduleUnlocked(id: string): Promise<void> {
  await writeWithRevision([STORE.cashflowSchedules], (t) => {
    t.objectStore(STORE.cashflowSchedules).delete(id);
  });
}

/** 予定を実績化: 仕訳を作り、schedule を posted にする（単一トランザクション）。 */
async function postScheduleUnlocked(id: string): Promise<JournalEntry> {
  const schedules = await getAll<CashflowSchedule>(STORE.cashflowSchedules);
  const schedule = schedules.find((s) => s.id === id);
  if (!schedule) throw new LedgerError('error.schedule.notFound');
  if (schedule.status !== 'planned') throw new LedgerError('error.schedule.alreadyProcessed');
  const entry = buildScheduleEntry(schedule); // counter 未設定なら LedgerError
  // 生成した実績仕訳も通常仕訳と同じ保存境界を通す（fail-closed）。
  const ctx = await loadSaveContext();
  const savable = assertEntrySavable(entry, ctx);
  const updated: CashflowSchedule = {
    ...schedule,
    status: 'posted',
    linkedEntryId: savable.id,
    updatedAt: nowIso(),
  };
  await writeWithRevision([STORE.journalEntries, STORE.cashflowSchedules], (t) => {
    t.objectStore(STORE.journalEntries).put(savable);
    t.objectStore(STORE.cashflowSchedules).put(updated);
  });
  return savable;
}

/* ── 定期ルール（くり返し記帳 = 実仕訳の自動起票） ── */

export interface RecurringRuleInput {
  name: string;
  amount: number;
  dayOfMonth: number;
  /** 何か月ごとに起票するか。未指定は 1（毎月）。 */
  everyMonths?: number;
  /**
   * 費用の行き先（あれば月割りするルール = 継続コスト化）。指定時は debitAccountId を無視して
   * 借方を継続コスト台帳に固定する（ユーザーは台帳という科目を一度も見ない）。
   */
  spreadExpenseAccountId?: string;
  debitAccountId: string;
  creditAccountId: string;
  /** 起票開始月。未指定は今日の月。 */
  startMonth?: string;
}

/** 保存境界の検証（作成・編集で共通・fail-closed）。 */
function assertRecurringRuleSavable(rule: RecurringRule, ctx: SaveContext): void {
  if (!recurringRuleSchema.safeParse(rule).success)
    throw new LedgerError('error.recurring.invalidStructure');
  if (rule.name.trim() === '') throw new LedgerError('error.common.nameRequired');
  const debit = ctx.byId.get(rule.debitAccountId);
  const credit = ctx.byId.get(rule.creditAccountId);
  if (!debit || !credit || rule.debitAccountId === rule.creditAccountId)
    throw new LedgerError('error.recurring.flowInvalid');
  if (rule.spreadExpenseAccountId !== undefined) {
    // 月割りするルール: 借方 = 継続コスト台帳（schema が id を固定。everyMonths >= 1 で周期に
    // かかわらず常に台帳経由）。費用の行き先・源泉（支払い元 = 購入の仕訳の貸方）はどちらも
    // 種別によらず起票可能な全 role（内部集約・残高調整のみ除外。起票時の assertEntrySavable と
    // 同じ制約を前倒しで守る）。
    const spreadAccount = ctx.byId.get(rule.spreadExpenseAccountId);
    if (!spreadAccount || !isRecurringPostableRole(spreadAccount.role))
      throw new LedgerError('error.monthlyCost.expenseCategory');
    if (!isRecurringPostableRole(credit.role)) throw new LedgerError('error.recurring.flowInvalid');
    return;
  }
  // 支出/収入/振替の定型に加え、簿記編集（任意の科目ペア）を許容する。ただし内部集約・
  // 調整科目は自動起票の対象外（RECURRING_POSTABLE_ROLES が正本・fail-closed）。
  if (!isRecurringPostableRole(debit.role) || !isRecurringPostableRole(credit.role))
    throw new LedgerError('error.recurring.flowInvalid');
}

async function createRecurringRuleUnlocked(input: RecurringRuleInput): Promise<RecurringRule> {
  const ctx = await loadSaveContext();
  const ts = nowIso();
  const spread = input.spreadExpenseAccountId !== undefined;
  // 月割りするルールの借方は継続コスト台帳（無ければこの tx で作る）。
  const { account: ledgerAccount, created: ledgerCreated } = spread
    ? findOrCreateContinuousCostLedgerAccount(ctx, ts)
    : { account: undefined, created: false };
  const rule: RecurringRule = {
    id: newId(),
    name: input.name.trim(),
    amount: input.amount,
    dayOfMonth: input.dayOfMonth,
    everyMonths: input.everyMonths ?? 1,
    ...(spread ? { spreadExpenseAccountId: input.spreadExpenseAccountId } : {}),
    debitAccountId: spread ? CONTINUOUS_COST_LEDGER_ACCOUNT_ID : input.debitAccountId,
    creditAccountId: input.creditAccountId,
    startMonth: input.startMonth ?? monthOf(todayLocal()),
    createdAt: ts,
    updatedAt: ts,
  };
  const validationCtx: SaveContext = { byId: new Map(ctx.byId) };
  if (ledgerAccount) validationCtx.byId.set(ledgerAccount.id, ledgerAccount);
  assertRecurringRuleSavable(rule, validationCtx);
  await writeWithRevision([STORE.recurringRules, STORE.accounts], (t) => {
    if (ledgerCreated && ledgerAccount) t.objectStore(STORE.accounts).put(ledgerAccount);
    t.objectStore(STORE.recurringRules).put(rule);
  });
  return rule;
}

/**
 * 編集。id / createdAt / postedThroughMonth は既存を保持する（カーソルは起票側が管理）。
 * 金額・周期・費用の行き先の変更は**過去の生成物（item・保存済み仕訳）に遡及しない**
 * （次回起票から新値。ルールは起票の道具・正本は生成物、という既存ドクトリン）。
 * 停止/再開は setRecurringRulePaused を使う（再開時の位相保持のため）。
 */
async function upsertRecurringRuleUnlocked(rule: RecurringRule): Promise<void> {
  const [ctx, rules] = await Promise.all([
    loadSaveContext(),
    getAll<RecurringRule>(STORE.recurringRules),
  ]);
  const existing = rules.find((r) => r.id === rule.id);
  if (!existing) throw new LedgerError('error.recurring.notFound');
  const spread = rule.spreadExpenseAccountId !== undefined;
  const ts = nowIso();
  const { account: ledgerAccount, created: ledgerCreated } = spread
    ? findOrCreateContinuousCostLedgerAccount(ctx, ts)
    : { account: undefined, created: false };
  const saved: RecurringRule = {
    ...rule,
    id: existing.id,
    // 月割りするルールの借方は台帳に固定（UI が誤った値を送っても保存境界で固定する）。
    ...(spread ? { debitAccountId: CONTINUOUS_COST_LEDGER_ACCOUNT_ID } : {}),
    createdAt: existing.createdAt,
    ...(existing.postedThroughMonth !== undefined
      ? { postedThroughMonth: existing.postedThroughMonth }
      : {}),
    updatedAt: ts,
  };
  if (existing.postedThroughMonth === undefined) delete saved.postedThroughMonth;
  const validationCtx: SaveContext = { byId: new Map(ctx.byId) };
  if (ledgerAccount) validationCtx.byId.set(ledgerAccount.id, ledgerAccount);
  assertRecurringRuleSavable(saved, validationCtx);
  // 事前読みは別トランザクション。書き込みトランザクション内で現在値を再読し、
  // (a) 削除済みルールを put で復活させない (b) 並行 catchUp が進めたカーソルを
  // 古い値で巻き戻さない（巻き戻すと同じ月が二重起票される）。
  let missingRace = false;
  try {
    await writeWithRevision([STORE.recurringRules, STORE.accounts], (t) => {
      if (ledgerCreated && ledgerAccount) t.objectStore(STORE.accounts).put(ledgerAccount);
      const store = t.objectStore(STORE.recurringRules);
      const probe = store.get(saved.id);
      probe.onsuccess = () => {
        const current = probe.result as RecurringRule | undefined;
        if (!current) {
          missingRace = true;
          t.abort();
          return;
        }
        const next: RecurringRule = { ...saved };
        if (current.postedThroughMonth !== undefined)
          next.postedThroughMonth = current.postedThroughMonth;
        else delete next.postedThroughMonth;
        store.put(next);
      };
    });
  } catch (error) {
    if (missingRace) throw new LedgerError('error.recurring.notFound');
    throw error;
  }
}

/**
 * 定期ルールの停止/再開。再開時は startMonth を書き換えず（everyMonths の位相を保つ）、
 * カーソルを前月まで進めて停止中の月を遡って起票しない（既にカーソルが先なら維持する）。
 * ※ 旧実装（startMonth を現在月へ書き換え）は everyMonths > 1 で周期の位相を飛ばすため廃止。
 */
async function setRecurringRulePausedUnlocked(
  id: string,
  paused: boolean,
  today: string = todayLocal(),
): Promise<void> {
  const ts = nowIso();
  let missingRace = false;
  try {
    await writeWithRevision([STORE.recurringRules], (t) => {
      const store = t.objectStore(STORE.recurringRules);
      const probe = store.get(id);
      probe.onsuccess = () => {
        const current = probe.result as RecurringRule | undefined;
        if (!current) {
          missingRace = true;
          t.abort();
          return;
        }
        const next: RecurringRule = { ...current, paused, updatedAt: ts };
        if (!paused) {
          const resumeCursor = addMonths(monthOf(today), -1);
          if (
            current.postedThroughMonth === undefined ||
            current.postedThroughMonth < resumeCursor
          ) {
            next.postedThroughMonth = resumeCursor;
          }
        }
        store.put(next);
      };
    });
  } catch (error) {
    if (missingRace) throw new LedgerError('error.recurring.notFound');
    throw error;
  }
}

/**
 * 定期ルールを削除する。起票済みの仕訳は事実として残し、由来メタデータ
 * （recurringRuleId / recurringMonth）を剥がして通常の仕訳へ戻す（同一トランザクション）。
 */
async function deleteRecurringRuleUnlocked(id: string): Promise<void> {
  // 仕訳の読みも同一トランザクション内で行う（別読みだと、読みと書きの間に
  // catchUp が起票した仕訳のメタデータが剥がれず、削除済みルールを参照して残る）。
  const ts = nowIso();
  await writeWithRevision([STORE.recurringRules, STORE.journalEntries], (t) => {
    const eStore = t.objectStore(STORE.journalEntries);
    const probe = eStore.getAll();
    probe.onsuccess = () => {
      for (const e of probe.result as JournalEntry[]) {
        if (e.metadata?.recurringRuleId !== id) continue;
        const metadata = { ...e.metadata };
        delete metadata.recurringRuleId;
        delete metadata.recurringMonth;
        const next: JournalEntry = { ...e, updatedAt: ts };
        if (Object.keys(metadata).length > 0) next.metadata = metadata;
        else delete next.metadata;
        eStore.put(next);
      }
      t.objectStore(STORE.recurringRules).delete(id);
    };
  });
}

/**
 * 経過月ぶんの定期仕訳をキャッチアップ起票する（アプリ起動時・ルール変更後に呼ぶ）。
 *  - idempotent: 三重の防御 = ①ルールのカーソル（postedThroughMonth） ②決定的 ID
 *    （仕訳 `rec-{ruleId}-{month}` / item `ccr-{ruleId}-{month}`） ③item は tx 内で
 *    get → undefined のときだけ put（ユーザー編集を上書きしない）。
 *    起票済み仕訳をユーザーが削除しても再起票しない（「今月はスキップ」の尊重）。
 *  - 月割りするルール（spreadExpenseAccountId あり）は 1 起票 = 2 レコード・1 トランザクション:
 *    保存される仕訳（借方 台帳 / 貸方 源泉・monthlyCostId 付き）+ item（endDate = 周期末）。
 *  - 起票された仕訳は通常の実仕訳（metadata に由来のみ）。金額が違う月は起票後に編集する。
 * 戻り値 = 起票した仕訳の件数。
 */
async function catchUpRecurringRulesUnlocked(today: string): Promise<number> {
  // 旧版 DB へ起票（書込み）しない。正規の全体検証（loadLedger）より先に呼ばれるため、
  // ここでも版を fail-closed に確認する（監査 P1-4）。
  const meta = await getMeta();
  assertSchemaVersionCurrent(meta);
  // 起動時は loadLedger より先に走る唯一の書込み。CAS の基準 revision をここで確定する
  // （再監査 P1-2 対応: これが無いとトラッカ未設定で照合を素通りし、事前読みと書込みの間の
  // 別タブの変更を検出できない）。
  if (meta) lastSeenVersion = ledgerVersion(meta);
  const [ctx, rules, existingItems] = await Promise.all([
    loadSaveContext(),
    getAll<RecurringRule>(STORE.recurringRules),
    getAll<MonthlyCostItem>(STORE.monthlyCostItems),
  ]);
  interface PostingPlan {
    month: string;
    entry: JournalEntry;
    item: MonthlyCostItem | null;
  }
  interface RulePlan {
    ruleId: string;
    postings: PostingPlan[];
    cursor: string | undefined;
  }
  const plans: RulePlan[] = [];
  const ts = nowIso();
  for (const rule of rules) {
    let postings = recurringPostingsDue(rule, today);
    const spread = rule.spreadExpenseAccountId !== undefined;
    const debit = ctx.byId.get(rule.debitAccountId);
    const credit = ctx.byId.get(rule.creditAccountId);
    // 参照が壊れている/アーカイブ済み/自動起票の対象外の科目のルールは起票しない
    // （fail-soft: 起動を止めない。アーカイブ済み科目へ起票すると「アーカイブ済み = 残高 0」
    // が壊れる・監査 P1-7。一覧 UI が参照切れの警告を出す）。
    if (!debit || !credit || credit.archived) continue;
    if (spread) {
      if (rule.debitAccountId !== CONTINUOUS_COST_LEDGER_ACCOUNT_ID) continue;
      if (!isRecurringPostableRole(credit.role)) continue;
      const spreadAccount = rule.spreadExpenseAccountId
        ? ctx.byId.get(rule.spreadExpenseAccountId)
        : undefined;
      if (!spreadAccount || spreadAccount.archived || !isRecurringPostableRole(spreadAccount.role))
        continue;
      // 既存のルール由来 item が覆う月は起票しない（周期短縮後の重複 = 二重費用を防ぐ・監査 P1-10）。
      const coveredThrough = ruleItemCoverageThrough(rule.id, existingItems);
      if (coveredThrough !== undefined) {
        postings = postings.filter((p) => p.month > coveredThrough);
      }
    } else if (
      debit.archived ||
      !isRecurringPostableRole(debit.role) ||
      !isRecurringPostableRole(credit.role)
    ) {
      continue;
    }
    // 定型（支出/収入/振替）は導出した種別を、非定型（簿記編集）は 'manual' を記録する。
    // 月割りルールは recurringKindOf(台帳, …) が null を返すため 'expense' 直指定。
    const inputMode: InputMode = spread
      ? 'expense'
      : (recurringKindOf(debit.role, credit.role) ?? 'manual');
    const rulePostings: PostingPlan[] = postings.map((p) => ({
      month: p.month,
      entry: {
        id: `rec-${rule.id}-${p.month}`,
        date: p.date,
        description: rule.name,
        kind: 'normal' as const,
        lines: [
          { accountId: rule.debitAccountId, side: 'debit' as const, amount: rule.amount },
          { accountId: rule.creditAccountId, side: 'credit' as const, amount: rule.amount },
        ],
        metadata: {
          inputMode,
          recurringRuleId: rule.id,
          recurringMonth: p.month,
          // 月割りルールの起票 = 購入の仕訳。item と同じ tx で対にする。
          ...(spread ? { monthlyCostId: ruleItemId(rule.id, p.month) } : {}),
        },
        createdAt: ts,
        updatedAt: ts,
      },
      item: buildRuleItem(rule, p, { createdAt: ts, updatedAt: ts }),
    }));
    const cursor = recurringCursorAfter(rule, today);
    if (rulePostings.length > 0 || cursor !== rule.postedThroughMonth) {
      plans.push({ ruleId: rule.id, postings: rulePostings, cursor });
    }
  }
  if (plans.length === 0) return 0;
  for (const plan of plans) {
    for (const p of plan.postings) {
      p.entry = assertEntrySavable(p.entry, ctx);
      if (p.item) p.item = assertMonthlyCostItemSavable(p.item);
    }
  }
  // 事前読みは別トランザクション。書き込みトランザクション内でルールごとに現在値を
  // 再読し、(a) 削除済みルールぶんを起票しない（削除済みルール参照の仕訳を作らない）
  // (b) 停止されたルールを起票しない (c) 並行 catchUp が進めたカーソルを巻き戻さず、
  // 起票済み月（ユーザーが消した月を含む）を再起票しない。
  let posted = 0;
  await writeWithRevision(
    [STORE.journalEntries, STORE.recurringRules, STORE.monthlyCostItems],
    (t) => {
      const eStore = t.objectStore(STORE.journalEntries);
      const rStore = t.objectStore(STORE.recurringRules);
      const iStore = t.objectStore(STORE.monthlyCostItems);
      for (const plan of plans) {
        const probe = rStore.get(plan.ruleId);
        probe.onsuccess = () => {
          const current = probe.result as RecurringRule | undefined;
          if (!current || current.paused) return;
          const postedThrough = current.postedThroughMonth ?? '';
          for (const p of plan.postings) {
            if (p.month <= postedThrough) continue;
            // 仕訳・item とも get → undefined のときだけ put。決定的 ID の生成物が既にあれば
            // 上書きしない（import 直後などカーソル未設定でも、事実として保存された過去の
            // 生成物・ユーザー編集をルール既定値で潰さない・監査 P1-8）。
            const entry = p.entry;
            const item = p.item;
            const entryProbe = eStore.get(entry.id);
            entryProbe.onsuccess = () => {
              if (entryProbe.result !== undefined) return;
              eStore.put(entry);
              posted += 1;
              if (item) {
                const itemProbe = iStore.get(item.id);
                itemProbe.onsuccess = () => {
                  if (itemProbe.result === undefined) iStore.put(item);
                };
              }
            };
          }
          const cursor =
            plan.cursor !== undefined && plan.cursor > postedThrough
              ? plan.cursor
              : current.postedThroughMonth;
          if (cursor !== current.postedThroughMonth) {
            rStore.put({ ...current, postedThroughMonth: cursor, updatedAt: ts });
          }
        };
      }
    },
    meta ? ledgerVersion(meta) : undefined,
  );
  return posted;
}

/* ── タグ ── */

async function upsertTagUnlocked(tag: Tag): Promise<void> {
  const tags = await getAll<Tag>(STORE.tags);

  // active な同名タグ重複は禁止（import 検証と同じ不変条件をアプリ内でも守る）。
  if (!tag.archived && tags.some((x) => x.id !== tag.id && !x.archived && x.name === tag.name)) {
    throw new LedgerError('error.tag.duplicateName');
  }

  // タグは仕訳全体のみ。scope は常に 'entry' に固定する。
  const normalized: Tag = { ...tag, scope: 'entry' };
  await writeWithRevision([STORE.tags], (t) => {
    t.objectStore(STORE.tags).put(normalized);
  });
}

/** 使用中のタグは物理削除できない（アーカイブを使う）。fail-closed。 */
async function deleteTagUnlocked(id: string): Promise<void> {
  const [entries, schedules] = await Promise.all([
    getAll<JournalEntry>(STORE.journalEntries),
    getAll<CashflowSchedule>(STORE.cashflowSchedules),
  ]);
  if (isTagReferenced(id, entries, schedules)) {
    throw new LedgerError('error.tag.deleteInUse');
  }
  await writeWithRevision([STORE.tags], (t) => {
    t.objectStore(STORE.tags).delete(id);
  });
}

/* ── 残高補正 ── */

/**
 * 実残高との差分を補正する 2 行仕訳を作る（「締め」は作らない）。
 * 相手科目（残高調整費/収入）が無ければ同じトランザクションで作る。
 * delta=0 なら何も作らず null を返す。
 */
interface AdjustmentSaveInput {
  accountId: string;
  date: string;
  actualBalance: number;
  description?: string;
}

/**
 * 補正の理論残高・相手科目・補正仕訳を組み立てる共通処理（新規 createAdjustment / 編集 updateAdjustment で共有）。
 * `entries` は理論残高の母集合。**編集時は補正自身を除外して渡す**（補正の二重掛けを避ける＝最重要）。
 * delta=0 のときは仕訳を作らず `{ entry: null }` を返す。
 */
function buildAdjustmentForSave(args: {
  input: AdjustmentSaveInput;
  accounts: Account[];
  entries: JournalEntry[];
  existing?: { id: string; createdAt: string };
}): { entry: JournalEntry | null; newCounter: Account | null } {
  const { input, accounts, entries, existing } = args;
  const target = accounts.find((a) => a.id === input.accountId);
  if (!target) throw new LedgerError('error.adjust.targetNotFound');
  if (target.type !== 'asset' && target.type !== 'liability') {
    throw new LedgerError('error.adjust.assetLiabilityOnly');
  }
  // 内部集約口座（継続コスト台帳）は補正対象外。直接補正すると残存価値の導出と
  // 矛盾するため、保存境界で fail-closed に弾く（UI 候補からも除外している）。
  if (isInternalRole(target.role)) {
    throw new LedgerError('error.adjust.internalRole');
  }

  const expected = accountBalance(
    input.accountId,
    target.type,
    filterByDateRange(entries, undefined, input.date),
  );
  const delta = input.actualBalance - expected;
  if (delta === 0) return { entry: null, newCounter: null };

  const role = counterpartRole(target.type, delta);
  const ctype: 'expense' | 'revenue' = role;
  const name = counterpartName(role);
  const named = accounts.find((account) => account.name.trim() === name && !account.archived);
  if (
    named &&
    (named.name !== name || named.type !== ctype || named.role !== 'system-adjustment')
  ) {
    throw new LedgerError('error.account.nameConflict');
  }
  let counter = named;
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
    accountId: input.accountId,
    accountType: target.type,
    date: input.date,
    description: input.description ?? `残高補正: ${target.name}`,
    expectedBalance: expected,
    actualBalance: input.actualBalance,
    counterpartAccountId: counter.id,
    ...(existing ? { existing } : {}),
  });
  return { entry, newCounter };
}

async function createAdjustmentUnlocked(input: AdjustmentSaveInput): Promise<JournalEntry | null> {
  if (!isValidIsoDate(input.date)) throw new LedgerError('error.entry.invalidStructure');
  const [ctx, entries, monthlyCostItems, recurringRules] = await Promise.all([
    loadSaveContext(),
    getAll<JournalEntry>(STORE.journalEntries),
    getAll<MonthlyCostItem>(STORE.monthlyCostItems),
    getAll<RecurringRule>(STORE.recurringRules),
  ]);
  const accounts = [...ctx.byId.values()];
  const derivedEntries = reportEntriesForAsOf(
    { accounts, journalEntries: entries, monthlyCostItems, recurringRules },
    input.date,
  );
  const { entry, newCounter } = buildAdjustmentForSave({
    input,
    accounts,
    entries: derivedEntries,
  });
  if (!entry) return null;

  const validationCtx: SaveContext = {
    ...ctx,
    byId: new Map(ctx.byId),
  };
  if (newCounter) validationCtx.byId.set(newCounter.id, newCounter);
  const savable = assertEntrySavable(entry, validationCtx);
  await writeWithRevision([STORE.accounts, STORE.journalEntries], (t) => {
    if (newCounter) t.objectStore(STORE.accounts).put(newCounter);
    t.objectStore(STORE.journalEntries).put(savable);
  });
  return savable;
}

/**
 * 既存の残高補正を編集する（現実アンカーの再ピン留め）。`id` で対象を特定し、id / createdAt を保つ。
 * 理論残高は **編集中の補正自身を除いて** 再計算する（除外しないと補正が二重に効く）。
 * 再計算後の delta=0 なら、その補正は意味を失うので削除する（戻り値 null）。
 */
async function updateAdjustmentUnlocked(
  input: AdjustmentSaveInput & { id: string },
): Promise<JournalEntry | null> {
  if (!isValidIsoDate(input.date)) throw new LedgerError('error.entry.invalidStructure');
  const [ctx, entries, monthlyCostItems, recurringRules] = await Promise.all([
    loadSaveContext(),
    getAll<JournalEntry>(STORE.journalEntries),
    getAll<MonthlyCostItem>(STORE.monthlyCostItems),
    getAll<RecurringRule>(STORE.recurringRules),
  ]);
  const existing = entries.find((e) => e.id === input.id);
  if (!existing) throw new LedgerError('error.adjust.notFound');
  if (!existing.metadata?.adjustment) throw new LedgerError('error.adjust.notAdjustment');

  const others = entries.filter((e) => e.id !== input.id);
  const accounts = [...ctx.byId.values()];
  const derivedEntries = reportEntriesForAsOf(
    { accounts, journalEntries: others, monthlyCostItems, recurringRules },
    input.date,
  );
  const { entry, newCounter } = buildAdjustmentForSave({
    input: { ...input, description: input.description ?? existing.description },
    accounts,
    entries: derivedEntries,
    existing: { id: existing.id, createdAt: existing.createdAt },
  });

  if (!entry) {
    await writeWithRevision([STORE.journalEntries], (t) => {
      t.objectStore(STORE.journalEntries).delete(input.id);
    });
    return null;
  }

  const validationCtx: SaveContext = {
    ...ctx,
    byId: new Map(ctx.byId),
  };
  if (newCounter) validationCtx.byId.set(newCounter.id, newCounter);
  const savable = assertEntrySavable(entry, validationCtx);
  await writeWithRevision([STORE.accounts, STORE.journalEntries], (t) => {
    if (newCounter) t.objectStore(STORE.accounts).put(newCounter);
    t.objectStore(STORE.journalEntries).put(savable);
  });
  return savable;
}

/** 残高補正を削除する（対象日以降の理論残高が補正前に戻る）。専用画面からのみ呼ぶ。 */
async function deleteAdjustmentUnlocked(id: string): Promise<void> {
  const entries = await getAll<JournalEntry>(STORE.journalEntries);
  const target = entries.find((e) => e.id === id);
  if (!target) throw new LedgerError('error.adjust.notFound');
  if (!target.metadata?.adjustment) throw new LedgerError('error.adjust.notAdjustment');
  await writeWithRevision([STORE.journalEntries], (t) => {
    t.objectStore(STORE.journalEntries).delete(id);
  });
}

/* ── 初期残高（opening） ── */

/**
 * 初期残高(equity) 科目を find-or-create する。無ければ well-known 名で新規生成して返す
 * （呼び出し側が created のときだけ put する）。opening 仕訳と継続コストの移行登録が共用する。
 */
function findOrCreateOpeningEquityAccount(
  accounts: Iterable<Account>,
  ts: string,
): { account: Account; created: boolean } {
  for (const a of accounts) {
    if (a.role === 'equity' && !a.archived) return { account: a, created: false };
  }
  return {
    account: {
      id: newId(),
      name: OPENING_EQUITY_NAME,
      type: 'equity',
      role: 'equity',
      archived: false,
      createdAt: ts,
      updatedAt: ts,
    },
    created: true,
  };
}

export interface OpeningInput {
  /** 既存 BS 科目に初期残高をつける場合の科目 id（指定時はこちら優先）。 */
  accountId?: string;
  /** 新規 BS 科目を作って初期残高をつける場合（資産/負債）。 */
  newAccount?: {
    name: string;
    type: AccountType;
    role: AccountRole;
    note?: string;
    /** 「自由に動かせる」チェック OFF の現預金だけ false（upsertAccount と同じ正規化）。 */
    movable?: boolean;
  };
  amount: number;
  date: string;
  /** 同名のアーカイブ済み科目を退避してから作成する（ユーザー承認済みの場合だけ true）。 */
  renameArchivedConflicts?: boolean;
}

/**
 * 複数の初期残高を、全件検証してから 1 トランザクションで登録する。
 * 資産: `借方 科目 / 貸方 初期残高(equity)`。負債: `借方 初期残高 / 貸方 科目`。
 * **マイナスの初期残高**は貸借を反転して登録する（明細金額は常に正）。0 は不可。
 */
async function createOpeningsUnlocked(inputs: OpeningInput[]): Promise<JournalEntry[]> {
  if (inputs.length === 0) return [];
  const ctx = await loadSaveContext();
  let workingAccounts = [...ctx.byId.values()];
  const accountsToPut = new Map<string, Account>();
  const planned: { input: OpeningInput; target: Account }[] = [];
  const ts = nowIso();

  // 対象科目を作業用配列へ順に反映する。途中で失敗しても、この時点では DB を変更しない。
  for (const input of inputs) {
    if (!Number.isInteger(input.amount) || input.amount === 0)
      throw new LedgerError('error.common.amountInvalid');
    let target: Account | null;
    if (input.accountId) {
      target = workingAccounts.find((account) => account.id === input.accountId) ?? null;
      if (!target) throw new LedgerError('error.adjust.targetNotFound');
    } else if (input.newAccount) {
      const { name, type, role, note } = input.newAccount;
      if (name.trim() === '') throw new LedgerError('error.common.nameRequired');
      if (!roleAllowsType(role, type)) throw new LedgerError('error.account.roleTypeMismatch');
      const renamedArchived = resolveAccountNameConflicts(workingAccounts, name, '', {
        ...(input.renameArchivedConflicts !== undefined
          ? { renameArchivedConflicts: input.renameArchivedConflicts }
          : {}),
      });
      if (renamedArchived.length > 0) {
        const renamedById = new Map(renamedArchived.map((account) => [account.id, account]));
        workingAccounts = workingAccounts.map((account) => renamedById.get(account.id) ?? account);
        for (const renamed of renamedArchived) accountsToPut.set(renamed.id, renamed);
      }
      target = {
        id: newId(),
        name: name.trim(),
        type,
        role,
        archived: false,
        ...(note !== undefined && note.trim() !== '' ? { note: note.trim() } : {}),
        // 「自由に動かせない」印は daily-asset の false だけ保存する（upsertAccount と同じ規則）。
        ...(input.newAccount.movable === false && role === 'daily-asset' ? { movable: false } : {}),
        createdAt: ts,
        updatedAt: ts,
      };
      workingAccounts.push(target);
      accountsToPut.set(target.id, target);
    } else {
      throw new LedgerError('error.adjust.targetNotFound');
    }
    if (target.type !== 'asset' && target.type !== 'liability')
      throw new LedgerError('error.opening.assetLiabilityOnly');
    planned.push({ input, target });
  }

  // 初期残高(equity) はバッチ全体で 1 科目だけ確保する。
  const equityResult = findOrCreateOpeningEquityAccount(workingAccounts, ts);
  const equity = equityResult.account;
  if (equityResult.created) {
    workingAccounts.push(equity);
    accountsToPut.set(equity.id, equity);
  }

  const entries = planned.map(({ input, target }): JournalEntry => {
    const magnitude = Math.abs(input.amount);
    const accountOnDebit = input.amount > 0 ? target.type === 'asset' : target.type !== 'asset';
    const lines: JournalLine[] = accountOnDebit
      ? [
          { accountId: target.id, side: 'debit', amount: magnitude },
          { accountId: equity.id, side: 'credit', amount: magnitude },
        ]
      : [
          { accountId: equity.id, side: 'debit', amount: magnitude },
          { accountId: target.id, side: 'credit', amount: magnitude },
        ];
    return {
      id: newId(),
      date: input.date,
      description: `${OPENING_EQUITY_NAME}（${target.name}）`,
      kind: 'opening',
      lines,
      metadata: { inputMode: 'manual' },
      createdAt: ts,
      updatedAt: ts,
    };
  });

  const validationCtx: SaveContext = {
    ...ctx,
    byId: accountsById(workingAccounts),
  };
  const savable = entries.map((entry) => assertEntrySavable(entry, validationCtx));

  await writeWithRevision([STORE.accounts, STORE.journalEntries], (t) => {
    const aStore = t.objectStore(STORE.accounts);
    for (const account of accountsToPut.values()) aStore.put(account);
    const eStore = t.objectStore(STORE.journalEntries);
    for (const entry of savable) eStore.put(entry);
  });
  return savable;
}

/**
 * 開始時点の残高を `kind='opening'` の仕訳で登録する（初回設定にも使える・あとから編集/削除できる）。
 * 既存 BS 科目への付与と、新規 BS 科目の作成 + 付与の両方に対応する。
 */
async function createOpeningUnlocked(input: OpeningInput): Promise<JournalEntry> {
  const entries = await createOpeningsUnlocked([input]);
  return entries[0]!;
}

/** 初期残高の金額・日付を編集する（対象科目・向き・id は保持）。 */
async function updateOpeningUnlocked(input: {
  id: string;
  /** 符号付き。正=自然向き（資産は借方/負債は貸方）・負=反転（マイナス残高）。0 は不可。 */
  amount: number;
  date: string;
}): Promise<JournalEntry> {
  if (!Number.isInteger(input.amount) || input.amount === 0)
    throw new LedgerError('error.common.amountInvalid');
  const [entries, ctx] = await Promise.all([
    getAll<JournalEntry>(STORE.journalEntries),
    loadSaveContext(),
  ]);
  const existing = entries.find((e) => e.id === input.id);
  if (!existing) throw new LedgerError('error.adjust.notFound');
  if (existing.kind !== 'opening') throw new LedgerError('error.opening.notOpening');
  // 持ち込み登録の購入の仕訳（kind='opening' + monthlyCostId）は初期残高の編集経路では触らせない
  // （item への日付・金額ミラーを迂回してしまう）。編集は仕訳一覧の購入の仕訳経路から。
  if (existing.metadata?.monthlyCostId) throw new LedgerError('error.entry.monthlyCost');
  const byId = ctx.byId;
  const targetLine = existing.lines.find((l) => byId.get(l.accountId)?.role !== 'equity');
  const equityLine = existing.lines.find((l) => byId.get(l.accountId)?.role === 'equity');
  const target = targetLine ? byId.get(targetLine.accountId) : undefined;
  if (!targetLine || !equityLine || !target) throw new LedgerError('error.opening.notOpening');
  const magnitude = Math.abs(input.amount);
  // 符号で貸借の向きを組み直す（createOpening と同じ規則）。
  const accountOnDebit = input.amount > 0 ? target.type === 'asset' : target.type !== 'asset';
  const lines: JournalLine[] = accountOnDebit
    ? [
        { accountId: target.id, side: 'debit', amount: magnitude },
        { accountId: equityLine.accountId, side: 'credit', amount: magnitude },
      ]
    : [
        { accountId: equityLine.accountId, side: 'debit', amount: magnitude },
        { accountId: target.id, side: 'credit', amount: magnitude },
      ];
  const entry: JournalEntry = {
    ...existing,
    date: input.date,
    lines,
    updatedAt: nowIso(),
  };
  const savable = assertEntrySavable(entry, ctx);
  await writeWithRevision([STORE.journalEntries], (t) => {
    t.objectStore(STORE.journalEntries).put(savable);
  });
  return savable;
}

/** 初期残高を削除する。 */
async function deleteOpeningUnlocked(id: string): Promise<void> {
  const entries = await getAll<JournalEntry>(STORE.journalEntries);
  const target = entries.find((e) => e.id === id);
  if (!target) throw new LedgerError('error.adjust.notFound');
  if (target.kind !== 'opening') throw new LedgerError('error.opening.notOpening');
  // 持ち込み登録の購入の仕訳は削除不可（item 削除で cascade）。
  if (target.metadata?.monthlyCostId) throw new LedgerError('error.entry.monthlyCost');
  await writeWithRevision([STORE.journalEntries], (t) => {
    t.objectStore(STORE.journalEntries).delete(id);
  });
}

/* ── 継続コスト資産 ── */

export interface ContinuousCostInput {
  /** 項目名（例: YouTube / 洗濯機）。 */
  name: string;
  /** 金額（購入額。正の整数）。 */
  amount: number;
  /** 開始日 'YYYY-MM-DD' = 購入の仕訳の日付（完全一致・双方向ミラー）。 */
  startDate: string;
  /** 終了日（任意）。未設定 = まだ費用にしない（資産として持っているだけ）。 */
  endDate?: string;
  /** 費用の行き先（費用カテゴリ等）。 */
  expenseAccountId: string;
  /**
   * 購入の仕訳の貸方 = 支払い元。起票可能な全 role（RECURRING_POSTABLE_ROLES =
   * 内部集約・残高調整以外。給与等の income-category も可 = 例: 健康保険を 銀行→給与 として
   * 台帳経由で登録できる）。
   * **未指定 = 持ち込み登録**: 貸方を初期残高(equity)にして `kind:'opening'` で立てる
   * （収入にも支出にもならない・資金も動かない。過去日で普通に登録できる＝制約なし）。
   */
  creditAccountId?: string;
  /** 負債資金で分割返済を作る場合の返済口座（daily-asset）。 */
  repaymentAccountId?: string;
  repaymentCount?: number;
  repaymentStartDate?: string;
}

/**
 * 継続コスト用の集約台帳口座（role=continuing-cost-asset・『継続コスト台帳』）を find-or-create する。
 * 全継続コストの残存価値を 1 口座に寄せる（品目ごとに資産科目を増やさない＝勘定科目の聖域化）。
 * 既存があれば再利用し、無ければ well-known id で新規生成して返す（呼び出し側が新規時だけ put する）。
 */
function findOrCreateContinuousCostLedgerAccount(
  ctx: SaveContext,
  ts: string,
): { account: Account; created: boolean } {
  const existing = ctx.byId.get(CONTINUOUS_COST_LEDGER_ACCOUNT_ID);
  if (existing) return { account: existing, created: false };
  return {
    account: {
      id: CONTINUOUS_COST_LEDGER_ACCOUNT_ID,
      name: CONTINUOUS_COST_LEDGER_ACCOUNT_NAME,
      type: 'asset',
      role: 'continuing-cost-asset',
      archived: false,
      createdAt: ts,
      updatedAt: ts,
    },
    created: true,
  };
}

/**
 * 継続コスト資産を登録する。1 トランザクションで 2 レコード:
 *  1. **購入の仕訳（保存される仕訳）**: `借方 継続コスト台帳 / 貸方 支払い元`・日付 = startDate・
 *     `metadata.monthlyCostId` 付き。支払い元未指定なら貸方 = 初期残高(equity)・`kind:'opening'`
 *     （持ち込み登録。PL を通らない）。
 *  2. **item**: 項目名・金額・開始日・終了日（任意）・費用の行き先。
 * 費用の行（recognition）は保存しない——`continuousCost.ts` が必要範囲だけ計算で展開する。
 * 負債資金 + 返済情報があれば、返済実仕訳（未来日付の振替 N 本）も同じ tx で作る（★6）。
 * 返済は実予定なので monthlyCostId は付けない＝item 削除でも残す・編集/削除自由。
 */
async function createContinuousCostUnlocked(input: ContinuousCostInput): Promise<MonthlyCostItem> {
  if (input.name.trim() === '') throw new LedgerError('error.common.nameRequired');
  if (!Number.isInteger(input.amount) || input.amount <= 0)
    throw new LedgerError('error.common.amountInvalid');
  if (!isValidIsoDate(input.startDate)) throw new LedgerError('error.monthlyCost.dateRequired');
  if (input.endDate !== undefined && input.endDate < input.startDate)
    throw new LedgerError('error.monthlyCost.endBeforeStart');

  const ctx = await loadSaveContext();
  const expense = ctx.byId.get(input.expenseAccountId);
  if (!expense || !isRecurringPostableRole(expense.role))
    throw new LedgerError('error.monthlyCost.expenseCategory');

  const ts = nowIso();
  // 残存価値は品目別ではなく単一の集約台帳口座へ寄せる（勘定科目を品目数ぶん増やさない）。
  const { account: ledgerAccount, created: ledgerCreated } =
    findOrCreateContinuousCostLedgerAccount(ctx, ts);

  // 購入の仕訳の貸方 = 支払い元。起票可能な全 role を許可（内部集約・残高調整のみ除外。
  // ローンで買う = 貸方が負債、健康保険 = 貸方が給与(income-category) など、種別の制限はしない）。
  // 未指定は持ち込み = 初期残高(equity)。
  let credit: Account;
  let creditCreated = false;
  if (input.creditAccountId !== undefined) {
    const payment = ctx.byId.get(input.creditAccountId);
    if (!payment || !isRecurringPostableRole(payment.role)) {
      throw new LedgerError('error.monthlyCost.paymentSource');
    }
    credit = payment;
  } else {
    const equityResult = findOrCreateOpeningEquityAccount(ctx.byId.values(), ts);
    credit = equityResult.account;
    creditCreated = equityResult.created;
  }
  const opening = credit.role === 'equity';

  const item: MonthlyCostItem = assertMonthlyCostItemSavable({
    id: newId(),
    name: input.name.trim(),
    amount: input.amount,
    startDate: input.startDate,
    ...(input.endDate !== undefined ? { endDate: input.endDate } : {}),
    expenseAccountId: input.expenseAccountId,
    createdAt: ts,
    updatedAt: ts,
  });

  // 購入の仕訳（保存される仕訳）。日付 = item.startDate（日レベル完全一致の不変条件）。
  const purchaseEntry: JournalEntry = {
    id: newId(),
    date: item.startDate,
    description: item.name,
    kind: opening ? 'opening' : 'normal',
    lines: [
      { accountId: ledgerAccount.id, side: 'debit', amount: item.amount },
      { accountId: credit.id, side: 'credit', amount: item.amount },
    ],
    metadata: { inputMode: opening ? 'manual' : 'expense', monthlyCostId: item.id },
    createdAt: ts,
    updatedAt: ts,
  };

  // 負債資金（カード=payment-liability / ローン=other-liability）+ 返済情報があれば、
  // 返済実仕訳（借方 支払い元負債 / 貸方 返済口座）を作る。`預金 → 自動車ローン` の分割返済など。
  let repaymentEntries: JournalEntry[] = [];
  if (
    (credit.role === 'payment-liability' || credit.role === 'other-liability') &&
    input.repaymentAccountId !== undefined &&
    input.repaymentCount !== undefined &&
    input.repaymentCount >= 1 &&
    input.repaymentStartDate
  ) {
    repaymentEntries = buildRepaymentEntries(ctx, {
      liabilityAccountId: credit.id,
      fromAccountId: input.repaymentAccountId,
      firstDate: input.repaymentStartDate,
      total: input.amount,
      count: input.repaymentCount,
      title: `${item.name} 返済`,
      ts,
    });
  }

  // 生成した購入の仕訳も保存境界の検証を通す（fail-closed。台帳・equity は作成予定を ctx に足す）。
  const validationCtx: SaveContext = { byId: new Map(ctx.byId) };
  validationCtx.byId.set(ledgerAccount.id, ledgerAccount);
  validationCtx.byId.set(credit.id, credit);
  const savablePurchase = assertEntrySavable(purchaseEntry, validationCtx);

  await writeWithRevision([STORE.accounts, STORE.monthlyCostItems, STORE.journalEntries], (t) => {
    // 集約台帳口座・初期残高は新規作成された時だけ put。
    const aStore = t.objectStore(STORE.accounts);
    if (ledgerCreated) aStore.put(ledgerAccount);
    if (creditCreated) aStore.put(credit);
    t.objectStore(STORE.monthlyCostItems).put(item);
    const eStore = t.objectStore(STORE.journalEntries);
    eStore.put(savablePurchase);
    for (const e of repaymentEntries) eStore.put(e);
  });
  return item;
}

/**
 * 継続コスト資産の更新（後編集）。保存境界で fail-closed に検証し、購入の仕訳を
 * 同じトランザクションで整合させる。
 *
 * 設計上の不変条件:
 *  - 編集できるのは 項目名・金額・終了日（設定/解除/変更）・費用の行き先。
 *    **開始日は購入の仕訳の日付のミラー**なのでここでは変更できない（仕訳側で変える =
 *    upsertEntry の購入の仕訳経路が item.startDate へ書き戻す）。
 *  - **金額の変更**は購入の仕訳（monthlyCostId・回収フラグなし）の両側金額へミラーする。
 *    回収の振替はミラー対象にしない（書き換えるとアーカイブ時の会計が壊れる）。
 *  - **費用の行き先の変更は仕訳に一切触れない**（購入の仕訳の借方は台帳固定。
 *    旧実装の「借方を認識先へ書き換える」は新モデルでは資産化を破壊するため撤去済み）。
 *  - 終了日の変更は保存されるデータをこれ以上動かさない——費用の行は導出なので、
 *    次の描画で全期間が新しい月数で再計算される（遡及処理は存在しない）。
 */
async function upsertMonthlyCostUnlocked(item: MonthlyCostItem): Promise<void> {
  const [items, entries] = await Promise.all([
    getAll<MonthlyCostItem>(STORE.monthlyCostItems),
    getAll<JournalEntry>(STORE.journalEntries),
  ]);
  const existing = items.find((m) => m.id === item.id);
  if (!existing) throw new LedgerError('error.monthlyCost.notFound');

  // 変更不可フィールドは既存値を保持（UI が誤った値を送っても保存境界で固定する）。
  // 既存レコード由来の残骸は後段の assertMonthlyCostItemSavable が落とす。
  const merged: MonthlyCostItem = {
    ...item,
    id: existing.id,
    startDate: existing.startDate,
    createdAt: existing.createdAt,
    updatedAt: nowIso(),
  };
  if (merged.endDate === undefined) delete merged.endDate;

  // 専用エラー契約を保つため、期間不変条件は構造 schema より先に判定する。
  if (merged.endDate !== undefined && merged.endDate < merged.startDate)
    throw new LedgerError('error.monthlyCost.endBeforeStart');
  // 保存値は strip 済みを使う＝編集のたびに撤去済みフィールドの残骸が落ちて自己修復する。
  const saved: MonthlyCostItem = assertMonthlyCostItemSavable(merged);

  // 費用の行き先は内部集約・残高調整以外の勘定科目であること（定期ルールと同じ正本）。
  const ctx = await loadSaveContext();
  const expense = ctx.byId.get(saved.expenseAccountId);
  if (!expense || !isRecurringPostableRole(expense.role))
    throw new LedgerError('error.monthlyCost.expenseCategory');

  // 金額のミラー: 購入の仕訳（回収フラグなし）だけ。日付は仕訳側が正本なので触らない。
  const updatedEntries: JournalEntry[] = [];
  if (saved.amount !== existing.amount) {
    for (const e of entries) {
      if (e.metadata?.monthlyCostId !== saved.id) continue;
      if (e.metadata.monthlyCostRecovery === true) continue;
      // 負債（カード・ローン）で買った item は金額を変更できない（upsertEntry の購入経路と
      // 同じ fail-closed・監査 P1-6。返済の実仕訳が追跡できず、総額とずれるため）。
      const creditLine = e.lines.find((l) => l.side === 'credit');
      const creditRole = creditLine ? ctx.byId.get(creditLine.accountId)?.role : undefined;
      if (creditRole === 'payment-liability' || creditRole === 'other-liability') {
        throw new LedgerError('error.monthlyCost.editLiability');
      }
      const lines = e.lines.map((l) => ({ ...l, amount: saved.amount }));
      updatedEntries.push(assertEntrySavable({ ...e, lines, updatedAt: saved.updatedAt }, ctx));
    }
    // 終了日を過去に縮めても購入日以降であることは上の endBeforeStart が保証する。
  }

  // 最終 readwrite transaction 内で item を再読し、削除済みを put で復活させない。
  // startDate は tx 内の現在値を正とする（並行して購入の仕訳の日付が動いた場合に巻き戻さない）。
  let missingRace = false;
  try {
    await writeWithRevision([STORE.monthlyCostItems, STORE.journalEntries], (t) => {
      const iStore = t.objectStore(STORE.monthlyCostItems);
      const probe = iStore.get(saved.id);
      probe.onsuccess = () => {
        const current = probe.result as MonthlyCostItem | undefined;
        if (!current) {
          missingRace = true;
          t.abort();
          return;
        }
        iStore.put(stripMonthlyCostItem({ ...saved, startDate: current.startDate }));
        const eStore = t.objectStore(STORE.journalEntries);
        for (const e of updatedEntries) eStore.put(e);
      };
    });
  } catch (error) {
    if (missingRace) throw new LedgerError('error.monthlyCost.notFound');
    throw error;
  }
}

export interface MonthlyCostArchiveInput {
  id: string;
  /**
   * 終了日。アーカイブ = 終了日をその日に設定すること（既定 = 今日）。終了日を過ぎた項目は
   * 一覧から消える（導出 isArchived）。先の日付にすれば一覧へ戻る＝「復元」も同じ 1 操作。
   */
  endDate: string;
  /**
   * 残存価値の回収の振替（任意）: `借方 振替先 / 貸方 継続コスト台帳`・日付 = 終了日。
   * 金額に上限は設けない（残存価値・購入額を超えてよい。割り振る総額 = amount − 回収額 が
   * 負になったら過去にわたって費用減 = マイナス表示。作者決定 2026-07-29）。
   */
  recovery?: { destinationAccountId: string; amount: number };
}

/**
 * 継続コスト資産をアーカイブする（終了日の設定 + 回収の振替を 1 トランザクションで）。
 * 「振替先を選ばずアーカイブ」= recovery なし＝残存価値は全額その月までの費用になる。
 */
async function archiveMonthlyCostUnlocked(input: MonthlyCostArchiveInput): Promise<void> {
  if (!isValidIsoDate(input.endDate)) throw new LedgerError('error.monthlyCost.endBeforeStart');
  const items = await getAll<MonthlyCostItem>(STORE.monthlyCostItems);
  const existing = items.find((m) => m.id === input.id);
  if (!existing) throw new LedgerError('error.monthlyCost.notFound');
  if (input.endDate < existing.startDate) throw new LedgerError('error.monthlyCost.endBeforeStart');

  const ts = nowIso();
  const saved = assertMonthlyCostItemSavable({
    ...existing,
    endDate: input.endDate,
    updatedAt: ts,
  });

  let recoveryEntry: JournalEntry | undefined;
  if (input.recovery) {
    if (!Number.isInteger(input.recovery.amount) || input.recovery.amount <= 0)
      throw new LedgerError('error.common.amountInvalid');
    const ctx = await loadSaveContext();
    const destination = ctx.byId.get(input.recovery.destinationAccountId);
    if (!destination || !isRecurringPostableRole(destination.role)) {
      throw new LedgerError('error.monthlyCost.recoveryDestination');
    }
    recoveryEntry = assertEntrySavable(
      {
        id: newId(),
        date: input.endDate,
        description: existing.name,
        kind: 'normal',
        lines: [
          { accountId: destination.id, side: 'debit', amount: input.recovery.amount },
          {
            accountId: CONTINUOUS_COST_LEDGER_ACCOUNT_ID,
            side: 'credit',
            amount: input.recovery.amount,
          },
        ],
        metadata: { inputMode: 'transfer', monthlyCostId: existing.id, monthlyCostRecovery: true },
        createdAt: ts,
        updatedAt: ts,
      },
      ctx,
    );
  }

  let missingRace = false;
  try {
    await writeWithRevision([STORE.monthlyCostItems, STORE.journalEntries], (t) => {
      const iStore = t.objectStore(STORE.monthlyCostItems);
      const probe = iStore.get(saved.id);
      probe.onsuccess = () => {
        const current = probe.result as MonthlyCostItem | undefined;
        if (!current) {
          missingRace = true;
          t.abort();
          return;
        }
        iStore.put(stripMonthlyCostItem({ ...current, endDate: saved.endDate, updatedAt: ts }));
        if (recoveryEntry) t.objectStore(STORE.journalEntries).put(recoveryEntry);
      };
    });
  } catch (error) {
    if (missingRace) throw new LedgerError('error.monthlyCost.notFound');
    throw error;
  }
}

/**
 * 継続コスト資産を削除する。購入の仕訳・回収の振替を同一トランザクションで cascade 削除する
 * （台帳残高 = 残存価値の不変条件を守る）。定期ルール由来の item も同じ（「今月はスキップ」＝
 * item を削除。カーソルは戻らないので再生成されない）。
 *  - **負債（カード・ローン）で買った item は削除禁止**（★6・fail-closed）: 返済仕訳には意図的に
 *    monthlyCostId を付けないため、item を消すと購入の仕訳だけ消えて返済が残り、負債残高が
 *    マイナスになる。アーカイブ（終了日の設定）で終わらせる。
 *  - レガシー予定 CF が posted を含む場合も削除禁止（現金/負債が動いている）。未実績の
 *    関連予定 CF は一緒に消す（dangling monthlyCostId を残さない）。
 */
async function deleteMonthlyCostUnlocked(id: string): Promise<void> {
  const [entries, schedules, accounts] = await Promise.all([
    getAll<JournalEntry>(STORE.journalEntries),
    getAll<CashflowSchedule>(STORE.cashflowSchedules),
    getAll<Account>(STORE.accounts),
  ]);
  const relatedEntries = entries.filter((e) => e.metadata?.monthlyCostId === id);
  const purchase = relatedEntries.find((e) => e.metadata?.monthlyCostRecovery !== true);
  if (purchase) {
    const creditId = purchase.lines.find((l) => l.side === 'credit')?.accountId;
    const creditRole = creditId ? accounts.find((a) => a.id === creditId)?.role : undefined;
    if (creditRole === 'payment-liability' || creditRole === 'other-liability') {
      throw new LedgerError('error.monthlyCost.deleteLiability');
    }
  }
  const relatedSchedules = schedules.filter((s) => s.monthlyCostId === id);
  if (relatedSchedules.some((s) => s.status === 'posted')) {
    throw new LedgerError('error.monthlyCost.deletePosted');
  }
  await writeWithRevision(
    [STORE.monthlyCostItems, STORE.journalEntries, STORE.cashflowSchedules],
    (t) => {
      t.objectStore(STORE.monthlyCostItems).delete(id);
      const eStore = t.objectStore(STORE.journalEntries);
      for (const e of relatedEntries) eStore.delete(e.id);
      const sStore = t.objectStore(STORE.cashflowSchedules);
      for (const s of relatedSchedules) sStore.delete(s.id);
    },
  );
}

/* ── 一括置換（import / restore で使う原子的操作） ── */

export interface ReplacePayload {
  meta: LedgerMeta;
  settings: Settings;
  accounts: Account[];
  journalEntries: JournalEntry[];
  cashflowSchedules: CashflowSchedule[];
  tags: Tag[];
  monthlyCostItems: MonthlyCostItem[];
  recurringRules: RecurringRule[];
}

/**
 * 台帳本体を 1 トランザクションで置換する。snapshots は保持する（復元元を消さない）。
 * 操作開始時の expectedVersion（deviceId + revision）を同じ transaction 内で照合し、
 * snapshot 作成後の別タブ更新や reset 後の ABA を上書きしない。新 revision は DB 現在値と
 * payload の revision floor の大きい方 + 1。
 */
async function replaceLedgerUnlocked(
  payload: ReplacePayload,
  expectedVersion: LedgerVersion,
): Promise<void> {
  let staleRace = false;
  let revisionExhausted = false;
  let nextMeta: LedgerMeta | undefined;
  try {
    await runWrite(
      [
        STORE.kv,
        STORE.accounts,
        STORE.journalEntries,
        STORE.cashflowSchedules,
        STORE.tags,
        STORE.monthlyCostItems,
        STORE.recurringRules,
      ],
      (t) => {
        const kv = t.objectStore(STORE.kv);
        const metaProbe = kv.get(KV_META);
        metaProbe.onsuccess = () => {
          const current = metaProbe.result as LedgerMeta | undefined;
          if (!current || !sameLedgerVersion(ledgerVersion(current), expectedVersion)) {
            staleRace = true;
            t.abort();
            return;
          }
          const revisionFloor = Math.max(current.revision, payload.meta.revision);
          if (revisionFloor >= MAX_LEDGER_REVISION) {
            revisionExhausted = true;
            t.abort();
            return;
          }
          const accounts = t.objectStore(STORE.accounts);
          const entries = t.objectStore(STORE.journalEntries);
          const schedules = t.objectStore(STORE.cashflowSchedules);
          const tags = t.objectStore(STORE.tags);
          const monthlyCosts = t.objectStore(STORE.monthlyCostItems);
          const rules = t.objectStore(STORE.recurringRules);
          accounts.clear();
          entries.clear();
          schedules.clear();
          tags.clear();
          monthlyCosts.clear();
          rules.clear();
          for (const a of payload.accounts) accounts.put(a);
          for (const e of payload.journalEntries) entries.put(e);
          for (const s of payload.cashflowSchedules) schedules.put(s);
          for (const tag of payload.tags) tags.put(tag);
          for (const mc of payload.monthlyCostItems) monthlyCosts.put(mc);
          for (const rule of payload.recurringRules) rules.put(rule);
          nextMeta = {
            ...payload.meta,
            revision: revisionFloor + 1,
            updatedAt: nowIso(),
          };
          kv.put(nextMeta, KV_META);
          kv.put(payload.settings, KV_SETTINGS);
        };
      },
    );
  } catch (error) {
    if (staleRace) throw new LedgerError('error.common.staleData');
    if (revisionExhausted) throw new LedgerError('error.common.revisionExhausted');
    throw error;
  }
  // 全置換成功後だけ、楽観的並行制御のトラッカを新しい revision に合わせる。
  if (nextMeta) lastSeenVersion = ledgerVersion(nextMeta);
}

/**
 * 全データ削除（snapshots も含む）→ 既定データで作り直す。fail-closed の確認は UI 側。
 *
 * 破壊操作なので「全 clear + 初期 seed」を **単一トランザクション** で行う。
 * 途中失敗時はトランザクションが abort し、一部だけ消えた半壊状態にはならない。
 */
async function resetAllUnlocked(): Promise<void> {
  const accounts = defaultAccounts();
  const settings = defaultSettings();
  const meta = newMeta();
  await runWrite(
    [
      STORE.kv,
      STORE.accounts,
      STORE.journalEntries,
      STORE.cashflowSchedules,
      STORE.tags,
      STORE.monthlyCostItems,
      STORE.recurringRules,
      STORE.snapshots,
    ],
    (t) => {
      t.objectStore(STORE.kv).clear();
      t.objectStore(STORE.accounts).clear();
      t.objectStore(STORE.journalEntries).clear();
      t.objectStore(STORE.cashflowSchedules).clear();
      t.objectStore(STORE.tags).clear();
      t.objectStore(STORE.monthlyCostItems).clear();
      t.objectStore(STORE.recurringRules).clear();
      t.objectStore(STORE.snapshots).clear();
      t.objectStore(STORE.kv).put(meta, KV_META);
      t.objectStore(STORE.kv).put(settings, KV_SETTINGS);
      const store = t.objectStore(STORE.accounts);
      for (const a of accounts) store.put(a);
    },
  );
  lastSeenVersion = ledgerVersion(meta);
}

/*
 * 変更 API の公開境界。各操作は lock 取得後に事前読込を始めるため、同一タブの二重操作でも
 * stale な検証結果を後勝ちで保存しない。実装同士の内部呼出しは *Unlocked を使い、
 * 同じ lock を再取得してデッドロックしないようにする。
 */
export const upsertAccount = serializeMutation(upsertAccountUnlocked);
export const reorderAccounts = serializeMutation(reorderAccountsUnlocked);
export const deleteAccount = serializeMutation(deleteAccountUnlocked);
export const archiveAccount = serializeMutation(archiveAccountUnlocked);
export const upsertEntry = serializeMutation(upsertEntryUnlocked);
export const deleteEntry = serializeMutation(deleteEntryUnlocked);
export const saveEntryWithSchedules = serializeMutation(saveEntryWithSchedulesUnlocked);
export const createRepaymentEntries = serializeMutation(createRepaymentEntriesUnlocked);
export const updateSettings = serializeMutation(updateSettingsUnlocked);
export const upsertSchedule = serializeMutation(upsertScheduleUnlocked);
export const upsertSchedules = serializeMutation(upsertSchedulesUnlocked);
export const deleteSchedule = serializeMutation(deleteScheduleUnlocked);
export const postSchedule = serializeMutation(postScheduleUnlocked);
export const createRecurringRule = serializeMutation(createRecurringRuleUnlocked);
export const upsertRecurringRule = serializeMutation(upsertRecurringRuleUnlocked);
export const setRecurringRulePaused = serializeMutation(setRecurringRulePausedUnlocked);
export const deleteRecurringRule = serializeMutation(deleteRecurringRuleUnlocked);
export const catchUpRecurringRules = serializeMutation(catchUpRecurringRulesUnlocked);
export const upsertTag = serializeMutation(upsertTagUnlocked);
export const deleteTag = serializeMutation(deleteTagUnlocked);
export const createAdjustment = serializeMutation(createAdjustmentUnlocked);
export const updateAdjustment = serializeMutation(updateAdjustmentUnlocked);
export const deleteAdjustment = serializeMutation(deleteAdjustmentUnlocked);
export const createOpenings = serializeMutation(createOpeningsUnlocked);
export const createOpening = serializeMutation(createOpeningUnlocked);
export const updateOpening = serializeMutation(updateOpeningUnlocked);
export const deleteOpening = serializeMutation(deleteOpeningUnlocked);
export const createContinuousCost = serializeMutation(createContinuousCostUnlocked);
export const upsertMonthlyCost = serializeMutation(upsertMonthlyCostUnlocked);
export const archiveMonthlyCost = serializeMutation(archiveMonthlyCostUnlocked);
export const deleteMonthlyCost = serializeMutation(deleteMonthlyCostUnlocked);
export const replaceLedger = serializeMutation(replaceLedgerUnlocked);
export const resetAll = serializeMutation(resetAllUnlocked);

/** 新規スナップショットの ID/時刻を採番する補助。 */
export function makeSnapshotId(): string {
  return newId();
}
