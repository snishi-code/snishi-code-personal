/*
 * リポジトリ: IndexedDB に対するドメイン操作。
 *
 * 不変条件:
 *  - 実行時の正本は IndexedDB。
 *  - 変更のたびに meta.revision を +1 する（端末ローカルの編集追跡）。
 *  - 削除/全消去/復元は fail-closed（呼び出し側で確認 UI を出す）。
 */
import { STORE, deleteRecord, getAll, getKv, runRead, runWrite, type StoreName } from './db';
import { defaultAccounts, defaultSettings, newMeta } from './seed';
import { newId } from '../domain/ids';
import {
  CONTINUOUS_COST_LEDGER_ACCOUNT_ID,
  CONTINUOUS_COST_LEDGER_ACCOUNT_NAME,
  MAX_LEDGER_REVISION,
  SCHEMA_VERSION,
} from '../domain/constants';
import { ADJUSTABLE_ACCOUNT_ROLES, roleAllowsType, type AccountRole } from '../domain/accountRoles';
import { compareAccountOrder } from '../domain/accountOrder';
import { isAccountReferenced, type AccountRefCollections } from '../domain/accountRefs';
import {
  accountExistsAt,
  accountLifetimeViolation,
  accountReferenceIntervals,
  effectiveRecurringRuleStartDate,
  recurringLineageViolations,
  recurringRuleReferenceEndDate,
  recurringRuleReferenceStartDate,
  type AccountReferenceInterval,
} from '../domain/accountLifetime';
import { accountEndingBalanceViolations } from '../domain/accountEnding';
import { findAccountNameConflicts, planArchiveRenames } from '../domain/accountNames';
import { LedgerError } from '../domain/errors';
import { isValidIsoDate } from '../domain/calendar';
import {
  accountSchema,
  journalEntrySchema,
  monthlyCostItemSchema,
  recurringRuleSchema,
  settingsSchema,
} from '../domain/schema';
import {
  clampDayToMonth,
  isRecurringPostableRole,
  isRecurringSpreadDestinationRole,
  generatedEntryRuleId,
  generatedItemRuleId,
  parseRuleEntryId,
  parseRuleItemId,
  recurringDestinationAccountId,
  recurringExpenseAccountId,
} from '../domain/recurring';
import type {
  Account,
  AccountType,
  EntryMetadata,
  JournalEntry,
  JournalLine,
  Ledger,
  LedgerMeta,
  MonthlyCostItem,
  RecurringRule,
  Settings,
  Snapshot,
} from '../domain/types';
import {
  addMonthsToDate,
  MONTHLY_AMOUNTS_HARD_CAP,
  monthlyAmounts,
  monthOf,
} from '../domain/allocation';
import { compareMonthlyCostItems } from '../domain/monthlyCost';
import {
  buildAdjustmentEntry,
  counterpartName,
  counterpartRole,
  isAdjustableAccountType,
} from '../domain/adjustment';
import { accountBalance, filterByDateRange } from '../domain/accounting';
import { ANNUAL_RETURN_BP_MAX, ANNUAL_RETURN_BP_MIN } from '../domain/investmentProjection';
import { reportEntriesForAsOf } from '../domain/reportEntries';
import { nowIso, todayLocal } from '../util/time';

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
    // 初期残高科目の同定は role（equity）が正本で、名前は表示データにすぎない
    // （指示書v3 §B-4）。旧実装の「毎起動の現行名への強制改名」は、ユーザーが付けた名前や
    // 将来の言語別 seed 名を黙って上書きするため廃止した。
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
  const [meta, settings, accounts, journalEntries, monthlyCostItems, recurringRules] =
    await runRead(
      [
        STORE.kv,
        STORE.accounts,
        STORE.journalEntries,
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
            t.objectStore(STORE.monthlyCostItems).getAll() as IDBRequest<MonthlyCostItem[]>,
          ),
          requestResult(
            t.objectStore(STORE.recurringRules).getAll() as IDBRequest<RecurringRule[]>,
          ),
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
  // 継続コスト資産は「終了が近い順」（endDate 昇順・未設定は最後・同着は名前）。
  monthlyCostItems.sort(compareMonthlyCostItems);
  recurringRules.sort((a, b) => cmp(a.createdAt, b.createdAt));
  // 導出専用 entries は持たない。集計は各画面が displayEntriesForAsOf で
  // 基準日ごとに必要範囲だけ仮想展開する（単一正本 = reportBasis + displayEntriesForAsOf）。
  // repository 内の保存不変条件だけは reportEntriesForAsOf（投影を混ぜない）を使う。
  return {
    meta,
    settings,
    accounts,
    journalEntries,
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
    if (!accountExistsAt(account, parsed.data.date)) {
      throw new LedgerError('error.account.referenceOutsidePeriod');
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

function assertEndedAssetLiabilityBalances(
  source: {
    accounts: Account[];
    journalEntries: JournalEntry[];
    monthlyCostItems: MonthlyCostItem[];
    recurringRules: RecurringRule[];
  },
  accountIds?: ReadonlySet<string>,
): void {
  if (accountEndingBalanceViolations(source, accountIds).length > 0) {
    throw new LedgerError('error.account.archiveBalance');
  }
}

async function assertEndedBalancesAfterEntryChange(
  ctx: SaveContext,
  currentEntries: JournalEntry[],
  options: {
    replacement?: JournalEntry;
    removeId?: string;
    affectedAccountIds: Set<string>;
    monthlyCostItems?: MonthlyCostItem[];
    recurringRules?: RecurringRule[];
  },
): Promise<void> {
  const [storedMonthlyCostItems, storedRecurringRules] = await Promise.all([
    getAll<MonthlyCostItem>(STORE.monthlyCostItems),
    getAll<RecurringRule>(STORE.recurringRules),
  ]);
  const monthlyCostItems = options.monthlyCostItems ?? storedMonthlyCostItems;
  const recurringRules = options.recurringRules ?? storedRecurringRules;
  const removedId = options.removeId ?? options.replacement?.id;
  const journalEntries = currentEntries.filter((entry) => entry.id !== removedId);
  if (options.replacement) journalEntries.push(options.replacement);
  assertEndedAssetLiabilityBalances(
    {
      accounts: [...ctx.byId.values()],
      journalEntries,
      monthlyCostItems,
      recurringRules,
    },
    options.affectedAccountIds,
  );
}

/**
 * 月額化項目を保存する全経路で import schema と同じ構造・期間不変条件を守る。
 *
 * **戻り値を保存値に使うこと**。zod が未知キーを落とした結果を返すので、撤去済みフィールドの
 * 残骸を持つ既存レコード（IndexedDB の生レコードを spread した保存値）が編集のたびに
 * 自己修復的に掃除される。
 */
function assertReferenceInsideAccount(
  account: Account | undefined,
  reference: AccountReferenceInterval,
): void {
  if (!account) throw new LedgerError('error.entry.unknownAccount');
  if (accountLifetimeViolation(account, [reference])) {
    throw new LedgerError('error.account.referenceOutsidePeriod');
  }
}

/**
 * 利用者が直接管理しない内部科目（system 科目）は、必要な最古日まで開始点を常に延ばせる。
 * startDate 未設定は過去へ開いた線分（§A 案1）なので延長不要 = 何も書かない
 * （旧仕様の「createdAt を暗黙開始日として明示化する」延長は廃止済み）。
 */
function extendSystemAccountStart(account: Account, date: string, ts: string): Account {
  return account.startDate !== undefined && date < account.startDate
    ? { ...account, startDate: date, updatedAt: ts }
    : account;
}

/**
 * 参照が system 科目（内部集約・残高調整・初期残高）に触れるとき、その参照日まで線分を
 * 無条件に延ばす。参照と科目更新は呼び出し側の同一 transaction で保存する。
 *
 * 通常科目には何もしない（§A 案1: startDate 未設定 = 過去へ開いた線分なので延長という
 * 概念が消えた。明示 startDate はユーザーが決めた境界なので変更せず、後続の保存境界検証が
 * 期間外参照を fail-closed に拒否する）。
 */
function extendSystemStartsForReferences(
  ctx: SaveContext,
  references: Iterable<{ accountId: string; date: string }>,
  ts: string,
): Map<string, Account> {
  const updates = new Map<string, Account>();
  for (const reference of references) {
    const current = ctx.byId.get(reference.accountId);
    if (!current) continue;
    const systemOwned =
      current.role === 'continuing-cost-asset' ||
      current.role === 'system-adjustment' ||
      current.role === 'equity';
    if (!systemOwned) continue;
    const extended = extendSystemAccountStart(current, reference.date, ts);
    if (extended === current) continue;
    ctx.byId.set(extended.id, extended);
    updates.set(extended.id, extended);
  }
  return updates;
}

function entryAccountReferences(entry: JournalEntry): { accountId: string; date: string }[] {
  return entry.lines.map((line) => ({ accountId: line.accountId, date: entry.date }));
}

function assertMonthlyCostItemSavable(item: MonthlyCostItem, ctx?: SaveContext): MonthlyCostItem {
  const parsed = monthlyCostItemSchema.safeParse(item);
  if (!parsed.success) {
    throw new LedgerError('error.monthlyCost.invalidStructure');
  }
  if (ctx) {
    const reference: AccountReferenceInterval = {
      kind: 'monthlyCost',
      from: parsed.data.startDate,
      ...(parsed.data.endDate !== undefined ? { to: parsed.data.endDate } : {}),
    };
    assertReferenceInsideAccount(ctx.byId.get(parsed.data.expenseAccountId), reference);
    assertReferenceInsideAccount(ctx.byId.get(CONTINUOUS_COST_LEDGER_ACCOUNT_ID), reference);
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
  const [entries, monthlyCostItems, recurringRules] = await Promise.all([
    getAll<JournalEntry>(STORE.journalEntries),
    getAll<MonthlyCostItem>(STORE.monthlyCostItems),
    getAll<RecurringRule>(STORE.recurringRules),
  ]);
  return { entries, monthlyCostItems, recurringRules };
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
  const [accounts, refs] = await Promise.all([
    getAll<Account>(STORE.accounts),
    loadReferencingCollections(),
  ]);
  const prev = accounts.find((candidate) => candidate.id === input.id);
  const account: Account = { ...input };
  // 別操作が開始点を書いた後でも、更新前に読んだオブジェクトによる名称変更等がその端点を
  // 消さない。端点の明示解除（空欄へ戻す = startDate 削除・§A の導線）は
  // `property: undefined` を渡して区別する。
  if (prev?.startDate !== undefined && !Object.prototype.hasOwnProperty.call(input, 'startDate')) {
    account.startDate = prev.startDate;
  }
  // 明示解除は保存レコードからキーごと消す（undefined 値のキーを IndexedDB に残さない）。
  if (account.startDate === undefined) delete account.startDate;
  if (
    prev?.endDate !== undefined &&
    input.archived === prev.archived &&
    !Object.prototype.hasOwnProperty.call(input, 'endDate')
  ) {
    account.endDate = prev.endDate;
  }
  // 終了点と archived は同じ状態を表す。解除では終了点を消し、終了点を保存する操作は
  // アーカイブとして扱う。旧 archived レコードの編集では終了点を今日として補う。
  if (account.endDate !== undefined) {
    account.archived = true;
  } else if (account.archived) {
    account.endDate = todayLocal();
  } else {
    delete account.endDate;
  }
  if (!(account.movable === false && account.role === 'daily-asset')) {
    delete account.movable;
  }
  if (account.name.trim() === '') throw new LedgerError('error.common.nameRequired');
  // role は type と整合する必要がある（import 検証と同じ不変条件を保存時にも守る）。
  if (!roleAllowsType(account.role, account.type)) {
    throw new LedgerError('error.account.roleTypeMismatch');
  }
  if (
    (account.role === 'continuing-cost-asset' &&
      account.id !== CONTINUOUS_COST_LEDGER_ACCOUNT_ID) ||
    (account.id === CONTINUOUS_COST_LEDGER_ACCOUNT_ID &&
      (account.role !== 'continuing-cost-asset' || account.type !== 'asset'))
  ) {
    throw new LedgerError('error.account.roleTypeMismatch');
  }
  // 投資の利回り投影（想定利回り + 計上先・§D）の保存境界（fail-closed）:
  //  - investment-asset 以外には保存しない。片方だけの設定は拒否（セットで意味を持つ）。
  //  - 計上先は自分自身不可。参照は soft reference（accountRefs の使用中判定に入れない）
  //    なので、**値を設定/変更するときだけ**存在と role（income-category）を検証する。
  //    参照先が後から消えても既存科目の編集（改名等）は保存できる（投影エンジンが
  //    fail-closed に生成を止める＝§A の「暗黙値で編集不能」を繰り返さない）。
  if ((account.annualReturnBp !== undefined) !== (account.projectionAccountId !== undefined)) {
    throw new LedgerError('error.account.projectionPair');
  }
  if (account.annualReturnBp !== undefined) {
    if (account.role !== 'investment-asset') {
      throw new LedgerError('error.account.returnOnlyInvestment');
    }
    if (
      !Number.isInteger(account.annualReturnBp) ||
      account.annualReturnBp < ANNUAL_RETURN_BP_MIN ||
      account.annualReturnBp > ANNUAL_RETURN_BP_MAX
    ) {
      throw new LedgerError('error.account.returnInvalid');
    }
  }
  if (account.projectionAccountId !== undefined) {
    if (account.projectionAccountId === account.id) {
      throw new LedgerError('error.account.projectionAccountInvalid');
    }
    if (account.projectionAccountId !== prev?.projectionAccountId) {
      const target = accounts.find((a) => a.id === account.projectionAccountId);
      if (!target || target.role !== 'income-category') {
        throw new LedgerError('error.account.projectionAccountInvalid');
      }
    }
  }
  // 端点の整合（明示 startDate > endDate の拒否）は accountSchema の superRefine が担う。
  // startDate 未設定は過去へ開いた線分なので、endDate 単独でも常に適法（§A 案1）。
  const parsedAccount = accountSchema.safeParse(account);
  if (!parsedAccount.success) throw new LedgerError('error.account.periodInvalid');
  Object.assign(account, parsedAccount.data);
  // 使用中（仕訳/継続コスト/定期ルールから参照中）の科目は区分(type)も役割(role)も変更できない。
  // role 変更は表示上の「大きな箱の移動」に相当するため fail-closed（新しい内訳を作って
  // アーカイブする運用に寄せる）。
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
  const references = accountReferenceIntervals(account.id, refs);
  if (accountLifetimeViolation(account, references)) {
    throw new LedgerError('error.account.referenceOutsidePeriod');
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
  // 不変条件: 資産・負債だけは終了点の残高 0。UI を通らない経路も塞ぐ。
  // 残高は画面と同じ導出仕訳（継続コストの費用行・定期ルールの投影込み）で判定する
  // （保存仕訳だけで判定すると、月割りの行き先科目など「画面では残高がある」科目を
  // アーカイブできてしまう・監査 P1-2）。残高があるなら先に振替（archiveAccount の振替導線）。
  // アーカイブ解除はチェック不要。
  if (
    account.archived &&
    (!prev?.archived || prev.endDate !== account.endDate) &&
    (account.type === 'asset' || account.type === 'liability')
  ) {
    const asOf = account.endDate ?? todayLocal();
    const derived = reportEntriesForAsOf(
      {
        accounts,
        journalEntries: refs.entries,
        monthlyCostItems: refs.monthlyCostItems,
        recurringRules: refs.recurringRules,
      },
      asOf,
    );
    const balance = accountBalance(
      account.id,
      account.type,
      filterByDateRange(derived, undefined, asOf),
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

/** 使用中（仕訳/継続コスト/定期ルールから参照中）の科目は削除できない（アーカイブを使う）。fail-closed。 */
async function deleteAccountUnlocked(id: string): Promise<void> {
  const refs = await loadReferencingCollections();
  if (isAccountReferenced(id, refs)) {
    throw new LedgerError('error.account.deleteInUse');
  }
  // この科目を返済口座として設定している負債から、設定ポインタを同一トランザクションで剥がす
  // （設定は返済計画シートの既定値にすぎないため、削除を塞がず fail-soft に外す）。
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
 * 資産・負債の不変条件「終了点の残高 = 0」を保存境界で fail-closed に守る
 * （振替後も 0 にならない金額・日付なら全体を拒否 = 残高が宙に浮く状態を作らない）。
 * 資産・負債の残高 0 と、累計を保持できる費用・収入は transferEntry なしで終了できる。
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
  const endDate = todayLocal();
  if (!accountExistsAt(target, endDate)) {
    throw new LedgerError('error.account.periodInvalid');
  }
  let savable: JournalEntry | undefined;
  if (transferEntry) {
    if (transferEntry.metadata?.monthlyCostId) throw new LedgerError('error.entry.monthlyCost');
    savable = assertEntrySavable(transferEntry, ctx);
    if (!savable.lines.some((l) => l.accountId === id)) {
      throw new LedgerError('error.entry.unknownAccount');
    }
    if (savable.date !== endDate) throw new LedgerError('error.account.archiveDate');
    const counterpartLine = savable.lines.find((line) => line.accountId !== id);
    const counterpart = counterpartLine ? ctx.byId.get(counterpartLine.accountId) : undefined;
    if (!counterpart || counterpart.type !== target.type) {
      throw new LedgerError('error.account.archiveCounterpartType');
    }
  }
  const withTransfer = savable
    ? [...entries.filter((e) => e.id !== savable!.id), savable]
    : entries;
  const candidate: Account = { ...target, archived: true, endDate, updatedAt: nowIso() };
  // 明示 startDate > endDate は schema の superRefine が拒否する（未設定は過去へ開いた線分）。
  if (!accountSchema.safeParse(candidate).success) {
    throw new LedgerError('error.account.periodInvalid');
  }
  const references = accountReferenceIntervals(id, {
    entries: withTransfer,
    monthlyCostItems,
    recurringRules,
  });
  if (accountLifetimeViolation(candidate, references)) {
    throw new LedgerError('error.account.referenceOutsidePeriod');
  }
  // 残高は画面と同じ導出仕訳（継続コストの費用行・定期ルールの投影込み）で判定する。
  const derived = reportEntriesForAsOf(
    { accounts, journalEntries: withTransfer, monthlyCostItems, recurringRules },
    endDate,
  );
  const balance = accountBalance(id, target.type, filterByDateRange(derived, undefined, endDate));
  if ((target.type === 'asset' || target.type === 'liability') && balance !== 0) {
    throw new LedgerError('error.account.archiveBalance');
  }
  assertEndedAssetLiabilityBalances(
    {
      accounts: accounts.map((account) => (account.id === candidate.id ? candidate : account)),
      journalEntries: withTransfer,
      monthlyCostItems,
      recurringRules,
    },
    new Set([candidate.id, ...(savable?.lines.map((line) => line.accountId) ?? [])]),
  );
  await writeWithRevision([STORE.accounts, STORE.journalEntries], (t) => {
    if (savable) t.objectStore(STORE.journalEntries).put(savable);
    t.objectStore(STORE.accounts).put(candidate);
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
  // ルール由来の仕訳はそもそも個別に消せない（ルール削除のカスケードでだけ消える）。
  if (target !== undefined && generatedEntryRuleId(target) !== undefined) {
    throw new LedgerError('error.recurring.generatedReadOnly');
  }
  if (target?.metadata?.monthlyCostId && target.metadata.monthlyCostRecovery !== true) {
    throw new LedgerError('error.entry.monthlyCost');
  }
  if (target?.metadata?.adjustment) throw new LedgerError('error.entry.adjustment');
}

async function upsertEntryUnlocked(entry: JournalEntry): Promise<void> {
  const entries = await getAll<JournalEntry>(STORE.journalEntries);
  const existing = entries.find((e) => e.id === entry.id);

  // くり返し記帳から生まれた仕訳は**通常経路では一切書き換えられない**（作者決定 2026-08-15）。
  // ルールは定期起票するだけの軽い道具で、生まれたものへの個別操作は持たない＝調整はルール側の
  // 編集・終了・再開で行う。ルール自身の内部処理（遡及の金額変更・分割・catch-up・カスケード
  // 削除）はこの保存境界を通らず writeWithRevision へ直接書くため、ここで塞いでよい。
  if (
    (existing !== undefined && generatedEntryRuleId(existing) !== undefined) ||
    parseRuleEntryId(entry.id) !== undefined
  ) {
    throw new LedgerError('error.recurring.generatedReadOnly');
  }
  // 由来を名乗らない ID の仕訳が、ユーザー入力からルール由来メタを持ち込むことも許さない。
  if (
    entry.metadata?.recurringRuleId !== undefined ||
    entry.metadata?.recurringMonth !== undefined
  ) {
    throw new LedgerError('error.recurring.invalidStructure');
  }
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
    const accountUpdates = extendSystemStartsForReferences(
      ctx,
      entryAccountReferences(entry),
      nowIso(),
    );
    const savable = assertEntrySavable(entry, ctx);
    await assertEndedBalancesAfterEntryChange(ctx, entries, {
      replacement: savable,
      affectedAccountIds: new Set(
        [...(existing?.lines ?? []), ...savable.lines].map((line) => line.accountId),
      ),
    });
    await writeWithRevision([STORE.accounts, STORE.journalEntries], (t) => {
      const accountStore = t.objectStore(STORE.accounts);
      for (const account of accountUpdates.values()) accountStore.put(account);
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
  const items = await getAll<MonthlyCostItem>(STORE.monthlyCostItems);
  const linkedItem = items.find((item) => item.id === existingMcId);
  if (existingRecovery) {
    // 専用不変条件を科目の存在期間より先に判定し、購入前回収のエラー契約を保つ。
    if (linkedItem && candidate.date < linkedItem.startDate) {
      throw new LedgerError('error.monthlyCost.recoveryBeforeStart');
    }
  }
  const accountUpdates = extendSystemStartsForReferences(
    ctx,
    entryAccountReferences(candidate),
    nowIso(),
  );
  let mirroredItem: MonthlyCostItem | undefined;
  if (linkedItem && !existingRecovery) {
    for (const [accountId, account] of extendSystemStartsForReferences(
      ctx,
      [{ accountId: linkedItem.expenseAccountId, date: candidate.date }],
      nowIso(),
    )) {
      accountUpdates.set(accountId, account);
    }
  }
  // 借方=台帳の固定・貸方 role・回収の形は assertEntrySavable が検証する。
  const savable = assertEntrySavable(candidate, ctx);
  if (linkedItem && !existingRecovery) {
    if (
      entries.some(
        (entry) =>
          entry.metadata?.monthlyCostId === existingMcId &&
          entry.metadata.monthlyCostRecovery === true &&
          entry.date < savable.date,
      )
    ) {
      throw new LedgerError('error.monthlyCost.recoveryBeforeStart');
    }
    if (linkedItem.endDate !== undefined && savable.date > linkedItem.endDate) {
      throw new LedgerError('error.monthlyCost.purchaseAfterEnd');
    }
    mirroredItem = assertMonthlyCostItemSavable(
      {
        ...linkedItem,
        amount: savable.lines.find((line) => line.side === 'debit')?.amount ?? linkedItem.amount,
        startDate: savable.date,
        updatedAt: savable.updatedAt,
      },
      ctx,
    );
  }
  await assertEndedBalancesAfterEntryChange(ctx, entries, {
    replacement: savable,
    // 回収額・購入額・購入日は item の月割り額を全期間へ遡及させるため、明細上の
    // 科目だけでなく終了点を持つ全資産・負債を再検証する。
    affectedAccountIds: new Set(ctx.byId.keys()),
    ...(mirroredItem
      ? {
          monthlyCostItems: items.map((item) =>
            item.id === mirroredItem!.id ? mirroredItem! : item,
          ),
        }
      : {}),
  });

  if (existingRecovery) {
    // 普通の振替として保存（割り振る総額は導出側が再計算する）。
    await writeWithRevision([STORE.accounts, STORE.journalEntries], (t) => {
      const accountStore = t.objectStore(STORE.accounts);
      for (const account of accountUpdates.values()) accountStore.put(account);
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
    await writeWithRevision([STORE.accounts, STORE.journalEntries, STORE.monthlyCostItems], (t) => {
      const accountStore = t.objectStore(STORE.accounts);
      for (const account of accountUpdates.values()) accountStore.put(account);
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
  const target = entries.find((entry) => entry.id === id);
  assertEntryDeletable(target);
  if (target) {
    const ctx = await loadSaveContext();
    await assertEndedBalancesAfterEntryChange(ctx, entries, {
      removeId: id,
      affectedAccountIds:
        target.metadata?.monthlyCostRecovery === true
          ? new Set(ctx.byId.keys())
          : new Set(target.lines.map((line) => line.accountId)),
    });
  }
  await writeWithRevision([STORE.journalEntries], (t) => {
    t.objectStore(STORE.journalEntries).delete(id);
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
  const ts = nowIso();
  const lastDate = addMonthsToDate(input.firstDate, Math.max(0, input.count - 1));
  const accountUpdates = extendSystemStartsForReferences(
    ctx,
    [
      { accountId: input.liabilityAccountId, date: input.firstDate },
      { accountId: input.fromAccountId, date: input.firstDate },
      { accountId: input.liabilityAccountId, date: lastDate },
      { accountId: input.fromAccountId, date: lastDate },
    ],
    ts,
  );
  const entries = buildRepaymentEntries(ctx, {
    liabilityAccountId: input.liabilityAccountId,
    fromAccountId: input.fromAccountId,
    firstDate: input.firstDate,
    total: input.total,
    count: input.count,
    title: input.title.trim(),
    ts,
  });
  const [currentEntries, monthlyCostItems, recurringRules] = await Promise.all([
    getAll<JournalEntry>(STORE.journalEntries),
    getAll<MonthlyCostItem>(STORE.monthlyCostItems),
    getAll<RecurringRule>(STORE.recurringRules),
  ]);
  assertEndedAssetLiabilityBalances(
    {
      accounts: [...ctx.byId.values()],
      journalEntries: [...currentEntries, ...entries],
      monthlyCostItems,
      recurringRules,
    },
    new Set(entries.flatMap((entry) => entry.lines.map((line) => line.accountId))),
  );
  await writeWithRevision([STORE.accounts, STORE.journalEntries], (t) => {
    const accountStore = t.objectStore(STORE.accounts);
    for (const account of accountUpdates.values()) accountStore.put(account);
    const store = t.objectStore(STORE.journalEntries);
    for (const e of entries) store.put(e);
  });
  return entries;
}

/**
 * 負債払いの分割返済を「未来日付の振替実仕訳 N 本」として組み立てる。
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
  if (
    !Number.isInteger(params.count) ||
    params.count < 1 ||
    params.count > MONTHLY_AMOUNTS_HARD_CAP
  )
    throw new LedgerError('error.repay.countInvalid', { max: MONTHLY_AMOUNTS_HARD_CAP });
  // 分割の全要素 > 0 を保証する。total < count だと monthlyAmounts が 0 の回を作り、
  // 0 金額は amountSchema（.positive）が拒否して保存全体が失敗する（v10 からの既存不具合）。
  // 「0 の回を省く」案は採らない: 摘要の i/count が回数を約束しているため本数を黙って減らせない。
  if (params.total < params.count) throw new LedgerError('error.repay.totalTooSmall');
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
  // 保存境界で schema を通す（UI だけの制限では、他経路や将来の呼び出しで
  // 「保存はできるが export だけ後で失敗する」状態を作ってしまう）。
  // 前後空白は他の name フィールドと同じく保存境界で落とす（' 円 ' を焼き付けない）。
  const validated = settingsSchema.safeParse({
    ...settings,
    ledgerName: settings.ledgerName.trim(),
    currency: settings.currency.trim(),
  });
  if (!validated.success) throw new LedgerError('error.settings.invalid');
  await writeWithRevision([STORE.kv], (t) => {
    t.objectStore(STORE.kv).put(validated.data, KV_SETTINGS);
  });
}

/* ── スナップショット ── */

export async function listSnapshots(): Promise<Snapshot[]> {
  // reason の検査は**書き込み側だけ**（saveSnapshot）。読み出しで throw すると、
  // IDB 直接編集などで壊れた 1 件が一覧全体を落とし、正常な復元ポイントも
  // 壊れた 1 件を消す削除ボタンも画面から消える（残る出口が「すべてのデータを削除」
  // だけになる）。未知の reason は snapshotReasonLabel が生文字列のまま出す
  // （fail-visible）。復元の安全は reason ではなく schemaVersion の剪定と
  // import パイプラインの検証が担う。
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
  if (snapshot.reason !== 'import' && snapshot.reason !== 'restore') {
    throw new LedgerError('error.snapshot.invalid');
  }
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

/* ── 定期ルール（くり返し記帳 = 実仕訳の自動起票） ── */

export interface RecurringRuleInput {
  name: string;
  amount: number;
  dayOfMonth: number;
  /** 何か月ごとに起票するか。未指定は 1（毎月）。 */
  everyMonths?: number;
  /**
   * 正規化済みの計上先。呼び出し側は通常 debitAccountId に利用者が選んだ行き先を渡し、
   * 継続コスト台帳を経由するかは spreadViaLedger で明示する。
   */
  spreadExpenseAccountId?: string;
  /**
   * 「継続コスト台帳を経由して月割りする」トグル（作者哲学: 勘定科目で動作を変えない）。
   * 未指定のときだけ行き先 role から既定を提案する（費用・収入行きは ON・他は OFF）。
   */
  spreadViaLedger?: boolean;
  debitAccountId: string;
  creditAccountId: string;
  /** 起票開始月。未指定は今日の月。 */
  startMonth?: string;
  /** ルール自体が存在し始める日。未指定は周期上の最初の起票日。起票周期の基準日とは独立。 */
  startDate?: string;
  /** この日からルールは存在しない（排他的終了点）。 */
  endDate?: string;
}

export type RecurringRuleAmountChangeMode = 'retroactive' | 'split';

export interface RecurringRuleSaveOptions {
  /** 金額変更時は必須。変更しない保存では指定しない。 */
  amountChangeMode?: RecurringRuleAmountChangeMode;
  /** split の境界日。旧ルールはこの日より前、新ルールはこの日以降を担当する。 */
  effectiveDate?: string;
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
  const spreadsExpense = rule.spreadExpenseAccountId !== undefined;
  const referenceStart = recurringRuleReferenceStartDate(rule);
  if (referenceStart !== undefined) {
    const referenceEnd = recurringRuleReferenceEndDate(rule, spreadsExpense);
    const reference: AccountReferenceInterval = {
      kind: 'recurringRule',
      from: referenceStart,
      ...(referenceEnd !== undefined ? { to: referenceEnd } : {}),
    };
    for (const accountId of new Set([
      rule.debitAccountId,
      rule.creditAccountId,
      ...(rule.spreadExpenseAccountId !== undefined ? [rule.spreadExpenseAccountId] : []),
    ])) {
      assertReferenceInsideAccount(ctx.byId.get(accountId), reference);
    }
  }
  if (rule.spreadExpenseAccountId !== undefined) {
    // 月割りトグル ON の保存形: 借方 = 継続コスト台帳、spread = 計上先。
    // 計上先は自動起票できる全 role を許す（クレカ積立・税金なども同じ仕組みに乗せる）。
    const spreadAccount = ctx.byId.get(rule.spreadExpenseAccountId);
    if (
      !spreadAccount ||
      !isRecurringPostableRole(spreadAccount.role) ||
      spreadAccount.id === credit.id
    )
      throw new LedgerError('error.monthlyCost.expenseCategory');
    if (!isRecurringPostableRole(credit.role)) throw new LedgerError('error.recurring.flowInvalid');
    return;
  }
  // 支出/収入/振替の定型に加え、簿記編集（任意の科目ペア）を許容する。ただし内部集約・
  // 調整科目は自動起票の対象外（RECURRING_POSTABLE_ROLES が正本・fail-closed）。
  // 月割りトグル OFF なら費用・収入行きも直接起票が正規形（role で動作を変えない）。
  if (!isRecurringPostableRole(debit.role) || !isRecurringPostableRole(credit.role))
    throw new LedgerError('error.recurring.flowInvalid');
}

/** 保存後候補の全ルールに、import と同じ系譜内非重複を適用する。 */
function assertRecurringLineagesSavable(rules: readonly RecurringRule[]): void {
  if (recurringLineageViolations(rules).length > 0) {
    throw new LedgerError('error.recurring.periodInvalid');
  }
}

async function createRecurringRuleUnlocked(input: RecurringRuleInput): Promise<RecurringRule> {
  const [ctx, journalEntries, monthlyCostItems, recurringRules] = await Promise.all([
    loadSaveContext(),
    getAll<JournalEntry>(STORE.journalEntries),
    getAll<MonthlyCostItem>(STORE.monthlyCostItems),
    getAll<RecurringRule>(STORE.recurringRules),
  ]);
  const ts = nowIso();
  const destinationAccountId = recurringDestinationAccountId(input);
  // 台帳経由（月割り）は呼び出し側の明示トグルが正本。未指定のときだけ行き先 role から
  // 既定を提案する（費用・収入行き = ON）。role は既定の提案にだけ使い、動作は決めない。
  const spreadsExpense =
    input.spreadViaLedger ??
    isRecurringSpreadDestinationRole(ctx.byId.get(destinationAccountId)?.role);
  const expenseAccountId = spreadsExpense ? destinationAccountId : undefined;
  const startMonth = input.startMonth ?? monthOf(todayLocal());
  // UI は登録日を明示して渡す。内部 API で省略された場合も保存データには必ず開始点を持たせ、
  // 呼び出し側が指定した周期 anchor 上の最初の起票日を安全な既定にする。
  const startDate = input.startDate ?? clampDayToMonth(startMonth, input.dayOfMonth);
  const rule: RecurringRule = {
    id: newId(),
    name: input.name.trim(),
    amount: input.amount,
    dayOfMonth: input.dayOfMonth,
    everyMonths: input.everyMonths ?? 1,
    ...(expenseAccountId !== undefined ? { spreadExpenseAccountId: expenseAccountId } : {}),
    debitAccountId: spreadsExpense ? CONTINUOUS_COST_LEDGER_ACCOUNT_ID : destinationAccountId,
    creditAccountId: input.creditAccountId,
    startMonth,
    startDate,
    ...(input.endDate !== undefined ? { endDate: input.endDate } : {}),
    createdAt: ts,
    updatedAt: ts,
  };
  const referenceStart = recurringRuleReferenceStartDate(rule);
  // 月割りルール（費用/差引形）の借方は継続コスト台帳（無ければこの tx で作る）。
  const { account: ledgerAccount, writeNeeded: ledgerWriteNeeded } = spreadsExpense
    ? findOrCreateContinuousCostLedgerAccount(ctx, ts, referenceStart)
    : { account: undefined, writeNeeded: false };
  // 参照科目の延長は不要（§A 案1: startDate 未設定 = 過去へ開いた線分。明示 startDate は
  // 後続の assertRecurringRuleSavable が期間外参照として fail-closed に拒否する）。
  // 台帳（system 科目）だけは findOrCreateContinuousCostLedgerAccount が無条件延長する。
  const validationCtx: SaveContext = { byId: new Map(ctx.byId) };
  if (ledgerAccount) validationCtx.byId.set(ledgerAccount.id, ledgerAccount);
  const accountsToPut = new Map<string, Account>();
  if (ledgerWriteNeeded && ledgerAccount) accountsToPut.set(ledgerAccount.id, ledgerAccount);
  assertRecurringRuleSavable(rule, validationCtx);
  assertRecurringLineagesSavable([...recurringRules, rule]);
  assertEndedAssetLiabilityBalances({
    accounts: [...validationCtx.byId.values()],
    journalEntries,
    monthlyCostItems,
    recurringRules: [...recurringRules, rule],
  });
  await writeWithRevision([STORE.recurringRules, STORE.accounts], (t) => {
    const accountStore = t.objectStore(STORE.accounts);
    for (const account of accountsToPut.values()) accountStore.put(account);
    t.objectStore(STORE.recurringRules).put(rule);
  });
  return rule;
}

function prepareRecurringRuleAccountsForSave(
  rule: RecurringRule,
  ctx: SaveContext,
  ts: string,
): { validationCtx: SaveContext; accountsToPut: Map<string, Account> } {
  const spreadsExpense = rule.spreadExpenseAccountId !== undefined;
  const referenceStart = recurringRuleReferenceStartDate(rule);
  const { account: ledgerAccount, writeNeeded: ledgerWriteNeeded } = spreadsExpense
    ? findOrCreateContinuousCostLedgerAccount(ctx, ts, referenceStart)
    : { account: undefined, writeNeeded: false };
  // 参照科目の延長は不要（§A 案1: startDate 未設定 = 過去へ開いた線分。明示 startDate は
  // 呼び出し側の保存境界検証が期間外参照として fail-closed に拒否する）。
  const validationCtx: SaveContext = { byId: new Map(ctx.byId) };
  if (ledgerAccount) validationCtx.byId.set(ledgerAccount.id, ledgerAccount);
  const accountsToPut = new Map<string, Account>();
  if (ledgerWriteNeeded && ledgerAccount) accountsToPut.set(ledgerAccount.id, ledgerAccount);
  return { validationCtx, accountsToPut };
}

async function splitRecurringRuleAtDate(args: {
  existing: RecurringRule;
  proposed: RecurringRule;
  effectiveDate: string;
  ctx: SaveContext;
  rules: RecurringRule[];
  entries: JournalEntry[];
  items: MonthlyCostItem[];
  ts: string;
}): Promise<void> {
  const { existing, proposed, effectiveDate, ctx, rules, entries, items, ts } = args;
  const predecessor: RecurringRule = {
    ...existing,
    endDate: effectiveDate,
    updatedAt: ts,
  };
  const successor: RecurringRule = {
    ...proposed,
    id: newId(),
    // 入力欄の「起票周期の基準日」を同時に変えていても、分割は元線分の
    // 位相 anchor を継承する。day/every の新設定は次の該当回からこの anchor 上で効く。
    startMonth: existing.startMonth,
    startDate: effectiveDate,
    splitFromRuleId: existing.id,
    createdAt: ts,
    updatedAt: ts,
  };
  if (successor.endDate !== undefined && successor.endDate <= effectiveDate) {
    throw new LedgerError('error.recurring.periodInvalid');
  }
  const { validationCtx, accountsToPut } = prepareRecurringRuleAccountsForSave(successor, ctx, ts);
  // v13: 仕訳・item は保存されないため付け替えは存在しない。境界の帰属は導出が
  // 半開区間 [startDate, endDate) から決める（effectiveDate 当日の起票は後継）。
  // 終了点残高は分割後の系譜（candidateRules）で導出し直した姿で検証する。
  const candidateRules = [
    ...rules.filter((rule) => rule.id !== existing.id),
    predecessor,
    successor,
  ];
  assertRecurringRuleSavable(predecessor, validationCtx);
  assertRecurringRuleSavable(successor, validationCtx);
  assertRecurringLineagesSavable(candidateRules);
  assertEndedAssetLiabilityBalances({
    accounts: [...validationCtx.byId.values()],
    journalEntries: entries,
    monthlyCostItems: items,
    recurringRules: candidateRules,
  });

  let missingRace = false;
  try {
    await writeWithRevision([STORE.recurringRules, STORE.accounts], (t) => {
      const ruleStore = t.objectStore(STORE.recurringRules);
      const probe = ruleStore.get(existing.id);
      probe.onsuccess = () => {
        if (!probe.result) {
          missingRace = true;
          t.abort();
          return;
        }
        ruleStore.put(predecessor);
        ruleStore.put(successor);
        const accountStore = t.objectStore(STORE.accounts);
        for (const account of accountsToPut.values()) accountStore.put(account);
      };
    });
  } catch (error) {
    if (missingRace) throw new LedgerError('error.recurring.notFound');
    throw error;
  }
}

/**
 * 編集。金額が変わる場合は、呼び出し側が影響範囲を必ず選ぶ。
 *  - retroactive: 同じ線分の自動生成仕訳・item の金額をすべて同一 tx で変更する。
 *  - split: effectiveDate を排他的な旧終了点/新開始点として後継ルールを作る。
 * 金額以外の通常編集は従来どおり同じルールへ保存し、起票済み事実には遡及しない。
 */
async function upsertRecurringRuleUnlocked(
  rule: RecurringRule,
  options: RecurringRuleSaveOptions = {},
): Promise<void> {
  const [ctx, rules, existingItems, entries] = await Promise.all([
    loadSaveContext(),
    getAll<RecurringRule>(STORE.recurringRules),
    getAll<MonthlyCostItem>(STORE.monthlyCostItems),
    getAll<JournalEntry>(STORE.journalEntries),
  ]);
  const existing = rules.find((r) => r.id === rule.id);
  if (!existing) throw new LedgerError('error.recurring.notFound');
  const destinationAccountId = recurringDestinationAccountId(rule);
  // 月割りの有無は渡された保存形（spread の有無）が正本。role から再導出しない
  // ＝シートが渡したトグルの意図も、内部呼び出しが渡す保存済み正規形も同じ規則で通る。
  const expenseAccountId = recurringExpenseAccountId(rule);
  const spreadsExpense = expenseAccountId !== undefined;
  const ts = nowIso();
  const saved: RecurringRule = {
    ...rule,
    id: existing.id,
    // 月割り ON は台帳 + spread（計上先 = 論理的な行き先）、OFF は行き先へ直接。
    debitAccountId: spreadsExpense ? CONTINUOUS_COST_LEDGER_ACCOUNT_ID : destinationAccountId,
    ...(expenseAccountId !== undefined ? { spreadExpenseAccountId: expenseAccountId } : {}),
    createdAt: existing.createdAt,
    updatedAt: ts,
  };
  if (existing.splitFromRuleId !== undefined) saved.splitFromRuleId = existing.splitFromRuleId;
  else delete saved.splitFromRuleId;
  if (saved.endDate === undefined) delete saved.endDate;
  if (!spreadsExpense) delete saved.spreadExpenseAccountId;

  const amountChanged = saved.amount !== existing.amount;
  if (
    amountChanged &&
    options.amountChangeMode !== 'retroactive' &&
    options.amountChangeMode !== 'split'
  ) {
    throw new LedgerError('error.recurring.amountChangeModeRequired');
  }
  if (amountChanged && options.amountChangeMode === 'split') {
    const effectiveDate = options.effectiveDate ?? todayLocal();
    if (!isValidIsoDate(effectiveDate)) throw new LedgerError('error.recurring.periodInvalid');
    const existingStart = effectiveRecurringRuleStartDate(existing);
    if (existing.endDate !== undefined && effectiveDate >= existing.endDate) {
      throw new LedgerError('error.recurring.periodInvalid');
    }
    // まだ旧線分が一日も存在していない境界を split として黙って遡及変更へ
    // 読み替えない。UI はこの選択を隠すが、保存境界も同じ規則で fail-closed にする。
    if (effectiveDate <= existingStart) {
      throw new LedgerError('error.recurring.periodInvalid');
    }
    await splitRecurringRuleAtDate({
      existing,
      proposed: saved,
      effectiveDate,
      ctx,
      rules,
      entries,
      items: existingItems,
      ts,
    });
    return;
  }

  const { validationCtx, accountsToPut } = prepareRecurringRuleAccountsForSave(saved, ctx, ts);
  assertRecurringRuleSavable(saved, validationCtx);
  const candidateRules = rules.map((candidate) => (candidate.id === saved.id ? saved : candidate));
  assertRecurringLineagesSavable(candidateRules);
  // v13: 金額・周期の変更で保存行は書き換えない。導出が全期間を現在のルール値で
  // 引き直す（全期間編集 = 過去も変わる・作者確定 2026-08-16）。終了点残高は
  // 引き直したあとの姿（candidateRules）で検証する。
  assertEndedAssetLiabilityBalances({
    accounts: [...validationCtx.byId.values()],
    journalEntries: entries,
    monthlyCostItems: existingItems,
    recurringRules: candidateRules,
  });
  // 事前読みは別トランザクション。書き込みトランザクション内で現在値を再読し、
  // 削除済みルールを put で復活させない。
  let missingRace = false;
  try {
    await writeWithRevision([STORE.recurringRules, STORE.accounts], (t) => {
      const accountStore = t.objectStore(STORE.accounts);
      for (const account of accountsToPut.values()) accountStore.put(account);
      const store = t.objectStore(STORE.recurringRules);
      const probe = store.get(saved.id);
      probe.onsuccess = () => {
        if (!probe.result) {
          missingRace = true;
          t.abort();
          return;
        }
        store.put(saved);
      };
    });
  } catch (error) {
    if (missingRace) throw new LedgerError('error.recurring.notFound');
    throw error;
  }
}

/**
 * ルール削除で道連れになる集合（検証と実書込みで同じ規則を使う単一正本）。
 *  - item: `ccr-{ruleId}-{month}`
 *  - 仕訳: そのルールが起票したもの（由来メタ / `rec-` ID）と、道連れ item に紐づく仕訳
 *
 * 回収の振替（`monthlyCostRecovery`）も、その item に紐づく限りは道連れにする。
 * 「利用者の実仕訳は残す」の例外なのは、回収の振替が**貸方 = 継続コスト台帳**だからで、
 * item を消して振替だけ残すと (a) 台帳にふれる仕訳は monthlyCostId 必須（不変条件⑧）を破り、
 * (b) 購入の借方が消えて台帳残高が負に落ちる。継続コスト item 単体の削除
 * （deleteMonthlyCostUnlocked）でも回収の振替は一緒に消しており、規則はそちらと同じ。
 */
function planRecurringCascade(
  ruleId: string,
  entries: readonly JournalEntry[],
  items: readonly MonthlyCostItem[],
): { entryIds: Set<string>; itemIds: Set<string> } {
  const itemIds = new Set(
    items.filter((item) => generatedItemRuleId(item) === ruleId).map((item) => item.id),
  );
  const entryIds = new Set<string>();
  for (const entry of entries) {
    const generated = generatedEntryRuleId(entry) === ruleId;
    // v13: 回収の振替は保存されない導出 item（ccr-）を指す。保存 item 集合だけでは
    // 捕まらないため、参照 ID の由来（parseRuleItemId）でも判定する。
    const linkedItemId = entry.metadata?.monthlyCostId;
    const linkedToRuleItem =
      linkedItemId !== undefined &&
      (itemIds.has(linkedItemId) || parseRuleItemId(linkedItemId)?.ruleId === ruleId);
    if (generated || linkedToRuleItem) entryIds.add(entry.id);
  }
  return { entryIds, itemIds };
}

/**
 * 定期ルールを削除する = **カスケード**（作者決定 2026-08-15）。
 *
 * 積み木モデル: ルールが下でその起票が上。下を抜けば上も落ちる。ルール本体・そのルールが
 * 起票した `rec-{ruleId}-{month}` の仕訳・`ccr-{ruleId}-{month}` の item・item の購入仕訳を
 * 同一トランザクションで消す。ルールから生まれたものへの個別操作を持たない以上、
 * 「ルールだけ消して起票を残す」= 誰も触れない孤児を作ることになるため、まとめて消す。
 * 復旧は同じ内容でルールを登録し直すだけなので、確認は注意文（起票回数つき）だけにする。
 *
 * ただし**利用者が自分で作った実仕訳は最下層の積み木**なので消さない:
 *  - 反対仕訳が消える仕訳を指していたら、反対仕訳は残して `reversalOfEntryId` だけ剥がす
 *    （通常科目どうしの独立した事実として存続する）。
 *  - 例外は回収の振替: 貸方が継続コスト台帳（内部集約）で item と対でしか成立しないため、
 *    道連れにする（理由は planRecurringCascade のコメント）。
 */
async function deleteRecurringRuleUnlocked(id: string): Promise<void> {
  const ts = nowIso();
  const [ctx, entries, items, rules] = await Promise.all([
    loadSaveContext(),
    getAll<JournalEntry>(STORE.journalEntries),
    getAll<MonthlyCostItem>(STORE.monthlyCostItems),
    getAll<RecurringRule>(STORE.recurringRules),
  ]);
  const existing = rules.find((rule) => rule.id === id);
  if (!existing) {
    throw new LedgerError('error.recurring.notFound');
  }
  const ruleUpdates = new Map<string, RecurringRule>();
  const remainingRules = rules
    .filter((rule) => rule.id !== id)
    .map((rule) => {
      let next = rule;
      if (rule.splitFromRuleId === id) {
        next = { ...next, updatedAt: ts };
        // 参照を捨てるのではなく祖父へ付け替える。捨てると系譜が 2 つの連結成分へ割れ、
        // 「同一系譜は存在期間が重ならない」不変条件が前後の segment の間で効かなくなる
        // ＝前 segment の終了日を外して同じ月を二重起票できてしまう（監査 P2-2）。
        // 削除対象が系譜の根のときだけ、付け替え先が無いので切る。
        if (existing.splitFromRuleId !== undefined) {
          next.splitFromRuleId = existing.splitFromRuleId;
        } else {
          delete next.splitFromRuleId;
        }
      }
      if (next !== rule) ruleUpdates.set(next.id, next);
      return next;
    });
  assertRecurringLineagesSavable(remainingRules);
  // カスケードで仕訳・item も消えるため、終了点残高は「消したあとの姿」で検証する
  // （残す前提のままだと、終了済み科目の残高を崩す削除を素通しする）。
  const cascade = planRecurringCascade(existing.id, entries, items);
  assertEndedAssetLiabilityBalances({
    accounts: [...ctx.byId.values()],
    journalEntries: entries.filter((entry) => !cascade.entryIds.has(entry.id)),
    monthlyCostItems: items.filter((item) => !cascade.itemIds.has(item.id)),
    recurringRules: remainingRules,
  });
  let missingRace = false;
  try {
    await writeWithRevision(
      [STORE.recurringRules, STORE.journalEntries, STORE.monthlyCostItems],
      (t) => {
        const ruleStore = t.objectStore(STORE.recurringRules);
        const eStore = t.objectStore(STORE.journalEntries);
        const itemStore = t.objectStore(STORE.monthlyCostItems);
        const ruleProbe = ruleStore.get(id);
        const entryProbe = eStore.getAll();
        const itemProbe = itemStore.getAll();
        let completed = 0;

        const applyWhenReady = () => {
          completed += 1;
          if (completed !== 3) return;
          if (!ruleProbe.result) {
            missingRace = true;
            t.abort();
            return;
          }

          // 対象集合は tx 内で読み直した現在値から作る。
          const storedItems = itemProbe.result as MonthlyCostItem[];
          const storedEntries = entryProbe.result as JournalEntry[];
          const removed = planRecurringCascade(id, storedEntries, storedItems);
          for (const itemId of removed.itemIds) itemStore.delete(itemId);
          for (const entryId of removed.entryIds) eStore.delete(entryId);

          // 消えた仕訳を指していた**利用者自身の実仕訳**（反対仕訳）は残し、
          // 宙に浮いた由来リンクだけを剥がす（通常科目どうしの独立した事実として存続）。
          // v13: 参照先は保存されない導出仕訳（rec-）でもあり得るため、ID の由来でも判定する。
          for (const entry of storedEntries) {
            if (removed.entryIds.has(entry.id)) continue;
            const reversalRef = entry.metadata?.reversalOfEntryId;
            if (reversalRef === undefined) continue;
            if (!removed.entryIds.has(reversalRef) && parseRuleEntryId(reversalRef)?.ruleId !== id)
              continue;
            const metadata = { ...entry.metadata };
            delete metadata.reversalOfEntryId;
            const next: JournalEntry = { ...entry, updatedAt: ts };
            if (Object.keys(metadata).length > 0) next.metadata = metadata;
            else delete next.metadata;
            eStore.put(next);
          }

          for (const rule of ruleUpdates.values()) ruleStore.put(rule);
          ruleStore.delete(id);
        };
        ruleProbe.onsuccess = applyWhenReady;
        entryProbe.onsuccess = applyWhenReady;
        itemProbe.onsuccess = applyWhenReady;
      },
    );
  } catch (error) {
    if (missingRace) throw new LedgerError('error.recurring.notFound');
    throw error;
  }
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
  // equity（初期残高）だけは補正の対象外。開始時点の残高は opening の編集で直す。
  if (!isAdjustableAccountType(target.type)) {
    throw new LedgerError('error.adjust.assetLiabilityOnly');
  }
  // 内部集約口座（継続コスト台帳）と残高調整科目自身は補正対象外。前者は直接補正すると
  // 残存価値の導出と矛盾し、後者は補正の相手側（type が expense / revenue なので上の
  // type 制限では弾けない）。保存境界で fail-closed に弾く（UI 候補からも除外している）。
  if (!ADJUSTABLE_ACCOUNT_ROLES.includes(target.role)) {
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
  // 同定は role + type（name 非依存・指示書v3 §B-4）。名前は生成時の表示データにすぎず、
  // 「非アーカイブの system-adjustment は type ごとに最大 1 件」は schema の不変条件が守る。
  let counter = accounts.find(
    (account) =>
      account.role === 'system-adjustment' && account.type === ctype && !account.archived,
  );
  let newCounter: Account | null = null;
  if (!counter) {
    const name = counterpartName(role);
    // 新規作成時のみ: 既存の別科目と同名になる場合は拒否（重複名を作らない既存不変条件）。
    if (accounts.some((account) => !account.archived && account.name.trim() === name)) {
      throw new LedgerError('error.account.nameConflict');
    }
    const ts = nowIso();
    newCounter = {
      id: newId(),
      name,
      type: ctype,
      role: 'system-adjustment',
      archived: false,
      startDate: input.date,
      createdAt: ts,
      updatedAt: ts,
    };
    counter = newCounter;
  } else {
    const extended = extendSystemAccountStart(counter, input.date, nowIso());
    if (extended !== counter) {
      newCounter = extended;
      counter = newCounter;
    }
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
  const accountsToPut = new Map<string, Account>();
  if (newCounter) accountsToPut.set(newCounter.id, newCounter);
  for (const [accountId, account] of extendSystemStartsForReferences(
    validationCtx,
    entryAccountReferences(entry),
    nowIso(),
  )) {
    accountsToPut.set(accountId, account);
  }
  const savable = assertEntrySavable(entry, validationCtx);
  await assertEndedBalancesAfterEntryChange(validationCtx, entries, {
    replacement: savable,
    affectedAccountIds: new Set(savable.lines.map((line) => line.accountId)),
  });
  await writeWithRevision([STORE.accounts, STORE.journalEntries], (t) => {
    const accountStore = t.objectStore(STORE.accounts);
    for (const account of accountsToPut.values()) accountStore.put(account);
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
    await assertEndedBalancesAfterEntryChange(ctx, entries, {
      removeId: input.id,
      affectedAccountIds: new Set(existing.lines.map((line) => line.accountId)),
    });
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
  const accountsToPut = new Map<string, Account>();
  if (newCounter) accountsToPut.set(newCounter.id, newCounter);
  for (const [accountId, account] of extendSystemStartsForReferences(
    validationCtx,
    entryAccountReferences(entry),
    nowIso(),
  )) {
    accountsToPut.set(accountId, account);
  }
  const savable = assertEntrySavable(entry, validationCtx);
  await assertEndedBalancesAfterEntryChange(validationCtx, entries, {
    replacement: savable,
    affectedAccountIds: new Set(
      [...existing.lines, ...savable.lines].map((line) => line.accountId),
    ),
  });
  await writeWithRevision([STORE.accounts, STORE.journalEntries], (t) => {
    const accountStore = t.objectStore(STORE.accounts);
    for (const account of accountsToPut.values()) accountStore.put(account);
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
  const ctx = await loadSaveContext();
  await assertEndedBalancesAfterEntryChange(ctx, entries, {
    removeId: id,
    affectedAccountIds: new Set(target.lines.map((line) => line.accountId)),
  });
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
  requiredStart?: string,
): { account: Account; created: boolean; writeNeeded: boolean } {
  for (const a of accounts) {
    if (a.role !== 'equity') continue;
    if (requiredStart !== undefined && a.endDate !== undefined && a.endDate < requiredStart) {
      continue;
    }
    if (a.archived && a.endDate === undefined) continue;
    if (requiredStart !== undefined) {
      const extended = extendSystemAccountStart(a, requiredStart, ts);
      if (extended !== a) {
        return {
          account: extended,
          created: false,
          writeNeeded: true,
        };
      }
    }
    return { account: a, created: false, writeNeeded: false };
  }
  return {
    account: {
      id: newId(),
      name: OPENING_EQUITY_NAME,
      type: 'equity',
      role: 'equity',
      archived: false,
      ...(requiredStart !== undefined ? { startDate: requiredStart } : {}),
      createdAt: ts,
      updatedAt: ts,
    },
    created: true,
    writeNeeded: true,
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
      // 過去日の初期残高でも科目の開始点は動かさない（§A 案1: startDate 未設定 = 過去へ
      // 開いた線分。明示 startDate との衝突は assertEntrySavable が期間外参照として拒否する）。
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
      // 初期残高の日付は「起票された事実」であって、科目の線分の端点（性質の宣言）ではない。
      // 開始日は既定で空欄 = 過去へ開いた線分のまま作る（§A 案1・作者決定3）。この導線には
      // 開始日の入力欄が無い＝作者が宣言していない端点をアプリが作らない。
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
  const earliestOpeningDate = inputs.reduce(
    (earliest, input) => (input.date < earliest ? input.date : earliest),
    inputs[0]!.date,
  );
  const equityResult = findOrCreateOpeningEquityAccount(workingAccounts, ts, earliestOpeningDate);
  const equity = equityResult.account;
  if (equityResult.created) {
    workingAccounts.push(equity);
  } else if (equityResult.writeNeeded) {
    workingAccounts = workingAccounts.map((account) =>
      account.id === equity.id ? equity : account,
    );
  }
  if (equityResult.writeNeeded) accountsToPut.set(equity.id, equity);

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
  const [currentEntries, monthlyCostItems, recurringRules] = await Promise.all([
    getAll<JournalEntry>(STORE.journalEntries),
    getAll<MonthlyCostItem>(STORE.monthlyCostItems),
    getAll<RecurringRule>(STORE.recurringRules),
  ]);
  assertEndedAssetLiabilityBalances(
    {
      accounts: workingAccounts,
      journalEntries: [...currentEntries, ...savable],
      monthlyCostItems,
      recurringRules,
    },
    new Set(savable.flatMap((entry) => entry.lines.map((line) => line.accountId))),
  );

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
  await assertEndedBalancesAfterEntryChange(ctx, entries, {
    replacement: savable,
    affectedAccountIds: new Set(
      [...existing.lines, ...savable.lines].map((line) => line.accountId),
    ),
  });
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
  const ctx = await loadSaveContext();
  await assertEndedBalancesAfterEntryChange(ctx, entries, {
    removeId: id,
    affectedAccountIds: new Set(target.lines.map((line) => line.accountId)),
  });
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
  requiredStart?: string,
): { account: Account; created: boolean; writeNeeded: boolean } {
  const existing = ctx.byId.get(CONTINUOUS_COST_LEDGER_ACCOUNT_ID);
  if (existing) {
    if (existing.role !== 'continuing-cost-asset' || existing.type !== 'asset') {
      throw new LedgerError('error.monthlyCost.invalidStructure');
    }
    if (requiredStart !== undefined) {
      const extended = extendSystemAccountStart(existing, requiredStart, ts);
      if (extended !== existing) {
        return {
          account: extended,
          created: false,
          writeNeeded: true,
        };
      }
    }
    return { account: existing, created: false, writeNeeded: false };
  }
  return {
    account: {
      id: CONTINUOUS_COST_LEDGER_ACCOUNT_ID,
      name: CONTINUOUS_COST_LEDGER_ACCOUNT_NAME,
      type: 'asset',
      role: 'continuing-cost-asset',
      archived: false,
      ...(requiredStart !== undefined ? { startDate: requiredStart } : {}),
      createdAt: ts,
      updatedAt: ts,
    },
    created: true,
    writeNeeded: true,
  };
}

/**
 * 継続コスト資産を登録する。1 トランザクションで 2 レコード:
 *  1. **購入の仕訳（保存される仕訳）**: `借方 継続コスト台帳 / 貸方 支払い元`・日付 = startDate・
 *     `metadata.monthlyCostId` 付き。支払い元未指定なら貸方 = 初期残高(equity)・`kind:'opening'`
 *     （持ち込み登録。PL を通らない）。
 *  2. **item**: 項目名・金額・開始日・終了日（任意）・費用の行き先。
 * 月割りの行（monthly-allocation）は保存しない——`continuousCost.ts` が必要範囲だけ計算で展開する。
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
  // 費用科目の延長は不要（§A 案1: startDate 未設定 = 過去へ開いた線分。明示 startDate は
  // 後続の assertMonthlyCostItemSavable が期間外参照として拒否する）。
  const expense = ctx.byId.get(input.expenseAccountId);
  if (!expense || !isRecurringPostableRole(expense.role))
    throw new LedgerError('error.monthlyCost.expenseCategory');

  const ts = nowIso();
  const accountsToPut = new Map<string, Account>();
  // 残存価値は品目別ではなく単一の集約台帳口座へ寄せる（勘定科目を品目数ぶん増やさない）。
  const { account: ledgerAccount, writeNeeded: ledgerWriteNeeded } =
    findOrCreateContinuousCostLedgerAccount(ctx, ts, input.startDate);
  if (ledgerWriteNeeded) accountsToPut.set(ledgerAccount.id, ledgerAccount);

  // 購入の仕訳の貸方 = 支払い元。起票可能な全 role を許可（内部集約・残高調整のみ除外。
  // ローンで買う = 貸方が負債、健康保険 = 貸方が給与(income-category) など、種別の制限はしない）。
  // 未指定は持ち込み = 初期残高(equity)。
  let credit: Account;
  if (input.creditAccountId !== undefined) {
    const payment = ctx.byId.get(input.creditAccountId);
    if (!payment || !isRecurringPostableRole(payment.role)) {
      throw new LedgerError('error.monthlyCost.paymentSource');
    }
    credit = payment;
  } else {
    const equityResult = findOrCreateOpeningEquityAccount(ctx.byId.values(), ts, input.startDate);
    credit = equityResult.account;
    if (equityResult.writeNeeded) accountsToPut.set(credit.id, credit);
  }
  const opening = credit.role === 'equity';

  const candidateItem: MonthlyCostItem = {
    id: newId(),
    name: input.name.trim(),
    amount: input.amount,
    startDate: input.startDate,
    ...(input.endDate !== undefined ? { endDate: input.endDate } : {}),
    expenseAccountId: input.expenseAccountId,
    createdAt: ts,
    updatedAt: ts,
  };
  // 生成予定の内部科目を加えた文脈で item の参照期間も検証する。
  const validationCtx: SaveContext = { byId: new Map(ctx.byId) };
  validationCtx.byId.set(expense.id, expense);
  validationCtx.byId.set(ledgerAccount.id, ledgerAccount);
  validationCtx.byId.set(credit.id, credit);
  const item = assertMonthlyCostItemSavable(candidateItem, validationCtx);

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
    // 返済関連科目の延長も不要（§A 案1）。期間外の明示 startDate は buildRepaymentEntries 内の
    // 保存境界検証（assertEntrySavable）が拒否する。
    repaymentEntries = buildRepaymentEntries(validationCtx, {
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
  const savablePurchase = assertEntrySavable(purchaseEntry, validationCtx);
  const [currentEntries, currentItems, recurringRules] = await Promise.all([
    getAll<JournalEntry>(STORE.journalEntries),
    getAll<MonthlyCostItem>(STORE.monthlyCostItems),
    getAll<RecurringRule>(STORE.recurringRules),
  ]);
  assertEndedAssetLiabilityBalances({
    accounts: [...validationCtx.byId.values()],
    journalEntries: [...currentEntries, savablePurchase, ...repaymentEntries],
    monthlyCostItems: [...currentItems, item],
    recurringRules,
  });

  await writeWithRevision([STORE.accounts, STORE.monthlyCostItems, STORE.journalEntries], (t) => {
    // 集約台帳口座・初期残高は新規作成された時だけ put。
    const aStore = t.objectStore(STORE.accounts);
    for (const account of accountsToPut.values()) aStore.put(account);
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
 *  - 編集できるのは 項目名・金額・終了日（設定/解除/変更）・費用化の開始日（設定/解除/変更）・
 *    費用の行き先。**開始日は購入の仕訳の日付のミラー**なのでここでは変更できない（仕訳側で
 *    変える = upsertEntry の購入の仕訳経路が item.startDate へ書き戻す）。
 *  - **金額の変更**は購入の仕訳（monthlyCostId・回収フラグなし）の両側金額へミラーする。
 *    回収の振替はミラー対象にしない（書き換えるとアーカイブ時の会計が壊れる）。
 *  - **費用の行き先の変更は仕訳に一切触れない**（購入の仕訳の借方は台帳固定。
 *    旧実装の「借方を月割り先へ書き換える」は新モデルでは資産化を破壊するため撤去済み）。
 *  - 終了日の変更は保存されるデータをこれ以上動かさない——費用の行は導出なので、
 *    次の描画で全期間が新しい月数で再計算される（遡及処理は存在しない）。
 */
async function upsertMonthlyCostUnlocked(item: MonthlyCostItem): Promise<void> {
  // ルールから生まれた持ち物（ccr-）は読み取り専用（作者決定 2026-08-15）。
  if (generatedItemRuleId(item) !== undefined) {
    throw new LedgerError('error.recurring.generatedReadOnly');
  }
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
  // 費用の行き先は内部集約・残高調整以外の勘定科目であること（定期ルールと同じ正本）。
  const ctx = await loadSaveContext();
  const expense = ctx.byId.get(merged.expenseAccountId);
  if (!expense || !isRecurringPostableRole(expense.role))
    throw new LedgerError('error.monthlyCost.expenseCategory');
  const accountUpdates = new Map<string, Account>();
  // 費用科目の延長は不要（§A 案1）。明示 startDate との衝突は下の
  // assertMonthlyCostItemSavable が期間外参照として拒否する。
  // 保存値は strip 済みを使う＝編集のたびに撤去済みフィールドの残骸が落ちて自己修復する。
  const saved: MonthlyCostItem = assertMonthlyCostItemSavable(merged, ctx);

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

  const updatedEntryById = new Map(updatedEntries.map((entry) => [entry.id, entry]));
  const recurringRules = await getAll<RecurringRule>(STORE.recurringRules);
  const candidateItems = items.map((candidate) => (candidate.id === saved.id ? saved : candidate));
  assertEndedAssetLiabilityBalances({
    accounts: [...ctx.byId.values()],
    journalEntries: entries.map((entry) => updatedEntryById.get(entry.id) ?? entry),
    monthlyCostItems: candidateItems,
    recurringRules,
  });

  // 最終 readwrite transaction 内で item を再読し、削除済みを put で復活させない。
  // startDate は tx 内の現在値を正とする（並行して購入の仕訳の日付が動いた場合に巻き戻さない）。
  let missingRace = false;
  try {
    await writeWithRevision([STORE.accounts, STORE.monthlyCostItems, STORE.journalEntries], (t) => {
      const accountStore = t.objectStore(STORE.accounts);
      for (const account of accountUpdates.values()) accountStore.put(account);
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
   * 残存価値の回収の振替（0 本以上・すべて同一トランザクション）: 1 本ごとに
   * `借方 振替先 / 貸方 継続コスト台帳`・日付 = 終了日。
   *
   * アーカイブシートは最大 2 本を作る（作者決定 2026-08-15）:
   *  1. **回収**（売却・返金など）= 利用者が選んだ回収先へ R。
   *  2. **「終了日に全額費用にする」の第 2 振替** = item の費用の行き先へ（残存価値 − R）。
   *     これで割り振る総額が「終了日までに消費済みの額」に落ち、過去の刻みは元の額のまま
   *     残りが終了日に 1 本だけ立つ（新しい数学もフィールドも増やさない）。
   *
   * 金額に上限は設けない（残存価値・購入額を超えてよい。割り振る総額 = amount − 回収額 が
   * 負になったら過去にわたって費用減 = マイナス表示。作者決定 2026-07-29）。
   */
  recoveries?: readonly { destinationAccountId: string; amount: number }[];
}

/**
 * 継続コスト資産をアーカイブする（終了日の設定 + 回収の振替を 1 トランザクションで）。
 * 「回収 0 でアーカイブ」= recoveries なし＝残存価値は終了日までの期間へ割り振られる。
 */
async function archiveMonthlyCostUnlocked(input: MonthlyCostArchiveInput): Promise<void> {
  // ルール由来の持ち物は個別にアーカイブできない（終わらせたいならルール側を終了する）。
  if (parseRuleItemId(input.id) !== undefined) {
    throw new LedgerError('error.recurring.generatedReadOnly');
  }
  if (!isValidIsoDate(input.endDate)) throw new LedgerError('error.monthlyCost.endBeforeStart');
  const items = await getAll<MonthlyCostItem>(STORE.monthlyCostItems);
  const existing = items.find((m) => m.id === input.id);
  if (!existing) throw new LedgerError('error.monthlyCost.notFound');
  if (input.endDate < existing.startDate) throw new LedgerError('error.monthlyCost.endBeforeStart');

  const ts = nowIso();
  const ctx = await loadSaveContext();
  const saved = assertMonthlyCostItemSavable(
    {
      ...existing,
      endDate: input.endDate,
      updatedAt: ts,
    },
    ctx,
  );

  /*
   * 回収の振替（0〜2 本）。第 2 振替も「回収の一種」なので、台帳にふれる保存仕訳が
   * 「購入と回収の 2 種だけ」という不変条件（schema ⑧⑨）は変わらない。
   *
   * 振替先の受理は簿記入力と同じ RECURRING_POSTABLE_ROLES（v12 内・版は上げない）だが、
   * **費用カテゴリだけは item の費用の行き先に限る**（fail-closed）。任意の費用科目への回収を
   * 許すと、どの費用を打ち消したのかが台帳から追えないまま「支出のマイナス」が立つ。
   * 費用の行き先が費用カテゴリ以外（v12 で配分先は全 postable 科目へ広がった）なら、
   * その科目は元々ここを通る。schema/import はこの絞りをかけない（既存データの受理は
   * 変えない・保存境界だけを狭める）。
   */
  const recoveryEntries: JournalEntry[] = [];
  for (const recovery of input.recoveries ?? []) {
    if (!Number.isInteger(recovery.amount) || recovery.amount <= 0)
      throw new LedgerError('error.common.amountInvalid');
    const destination = ctx.byId.get(recovery.destinationAccountId);
    if (!destination || !isRecurringPostableRole(destination.role)) {
      throw new LedgerError('error.monthlyCost.recoveryDestination');
    }
    if (destination.role === 'expense-category' && destination.id !== existing.expenseAccountId) {
      throw new LedgerError('error.monthlyCost.recoveryDestination');
    }
    recoveryEntries.push(
      assertEntrySavable(
        {
          id: newId(),
          date: input.endDate,
          description: existing.name,
          kind: 'normal',
          lines: [
            { accountId: destination.id, side: 'debit', amount: recovery.amount },
            {
              accountId: CONTINUOUS_COST_LEDGER_ACCOUNT_ID,
              side: 'credit',
              amount: recovery.amount,
            },
          ],
          metadata: {
            inputMode: 'transfer',
            monthlyCostId: existing.id,
            monthlyCostRecovery: true,
          },
          createdAt: ts,
          updatedAt: ts,
        },
        ctx,
      ),
    );
  }

  const [entries, recurringRules] = await Promise.all([
    getAll<JournalEntry>(STORE.journalEntries),
    getAll<RecurringRule>(STORE.recurringRules),
  ]);
  const candidateItems = items.map((item) => (item.id === saved.id ? saved : item));
  assertEndedAssetLiabilityBalances({
    accounts: [...ctx.byId.values()],
    journalEntries: recoveryEntries.length > 0 ? [...entries, ...recoveryEntries] : entries,
    monthlyCostItems: candidateItems,
    recurringRules,
  });

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
        const eStore = t.objectStore(STORE.journalEntries);
        for (const recoveryEntry of recoveryEntries) eStore.put(recoveryEntry);
      };
    });
  } catch (error) {
    if (missingRace) throw new LedgerError('error.monthlyCost.notFound');
    throw error;
  }
}

/**
 * 継続コスト資産を削除する。購入の仕訳・回収の振替を同一トランザクションで cascade 削除する
 * （台帳残高 = 残存価値の不変条件を守る）。
 *  - **ルール由来の item（`ccr-`）は削除禁止**（作者決定 2026-08-15）: ルールから生まれたものへの
 *    個別操作は持たない。消したいならルールごと削除する（そのカスケードで一緒に消える）。
 *  - **負債（カード・ローン）で買った item は削除禁止**（★6・fail-closed）: 返済仕訳には意図的に
 *    monthlyCostId を付けないため、item を消すと購入の仕訳だけ消えて返済が残り、負債残高が
 *    マイナスになる。アーカイブ（終了日の設定）で終わらせる。
 */
async function deleteMonthlyCostUnlocked(id: string): Promise<void> {
  if (parseRuleItemId(id) !== undefined) {
    throw new LedgerError('error.recurring.generatedReadOnly');
  }
  const [entries, accounts, monthlyCostItems, recurringRules] = await Promise.all([
    getAll<JournalEntry>(STORE.journalEntries),
    getAll<Account>(STORE.accounts),
    getAll<MonthlyCostItem>(STORE.monthlyCostItems),
    getAll<RecurringRule>(STORE.recurringRules),
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
  const relatedEntryIds = new Set(relatedEntries.map((entry) => entry.id));
  const candidateEntries = entries.filter((entry) => !relatedEntryIds.has(entry.id));
  const candidateItems = monthlyCostItems.filter((item) => item.id !== id);
  assertEndedAssetLiabilityBalances({
    accounts,
    journalEntries: candidateEntries,
    monthlyCostItems: candidateItems,
    recurringRules,
  });
  await writeWithRevision([STORE.monthlyCostItems, STORE.journalEntries], (t) => {
    t.objectStore(STORE.monthlyCostItems).delete(id);
    const eStore = t.objectStore(STORE.journalEntries);
    for (const e of relatedEntries) eStore.delete(e.id);
  });
}

/* ── 一括置換（import / restore で使う原子的操作） ── */

export interface ReplacePayload {
  meta: LedgerMeta;
  settings: Settings;
  accounts: Account[];
  journalEntries: JournalEntry[];
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
          const monthlyCosts = t.objectStore(STORE.monthlyCostItems);
          const rules = t.objectStore(STORE.recurringRules);
          accounts.clear();
          entries.clear();
          monthlyCosts.clear();
          rules.clear();
          for (const a of payload.accounts) accounts.put(a);
          for (const e of payload.journalEntries) entries.put(e);
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
      STORE.monthlyCostItems,
      STORE.recurringRules,
      STORE.snapshots,
    ],
    (t) => {
      t.objectStore(STORE.kv).clear();
      t.objectStore(STORE.accounts).clear();
      t.objectStore(STORE.journalEntries).clear();
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
export const createRepaymentEntries = serializeMutation(createRepaymentEntriesUnlocked);
export const updateSettings = serializeMutation(updateSettingsUnlocked);
export const createRecurringRule = serializeMutation(createRecurringRuleUnlocked);
export const upsertRecurringRule = serializeMutation(upsertRecurringRuleUnlocked);
export const deleteRecurringRule = serializeMutation(deleteRecurringRuleUnlocked);
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
