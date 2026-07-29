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
import {
  CONTINUOUS_COST_LEDGER_ACCOUNT_ID,
  CONTINUOUS_COST_LEDGER_ACCOUNT_NAME,
  RESERVE_LEDGER_ACCOUNT_ID,
  RESERVE_LEDGER_ACCOUNT_NAME,
} from '../domain/constants';
import {
  isInternalRole,
  roleAllowsType,
  type AccountRole,
} from '../domain/accountRoles';
import { compareAccountOrder } from '../domain/accountOrder';
import { isAccountReferenced, type AccountRefCollections } from '../domain/accountRefs';
import { findAccountNameConflicts, planArchiveRenames } from '../domain/accountNames';
import { LedgerError } from '../domain/errors';
import { isValidIsoDate, isValidIsoMonth } from '../domain/calendar';
import {
  cashflowScheduleSchema,
  journalEntrySchema,
  monthlyCostItemSchema,
  recurringRuleSchema,
} from '../domain/schema';
import {
  isRecurringPostableRole,
  recurringCursorAfter,
  recurringKindOf,
  recurringPostingsDue,
} from '../domain/recurring';
import type {
  Account,
  AccountType,
  AssetDisposal,
  CashflowSchedule,
  InputMode,
  JournalEntry,
  JournalLine,
  Ledger,
  LedgerMeta,
  MonthlyCostItem,
  MonthlyCostKind,
  RecurringRule,
  ReserveItem,
  Settings,
  Snapshot,
  Tag,
} from '../domain/types';
import {
  addMonths,
  addMonthsToDate,
  monthlyAmounts,
  monthOf,
} from '../domain/allocation';
import { DISPOSAL_GAIN_ACCOUNT_NAME } from '../domain/assetDisposal';
import { buildScheduleEntry } from '../domain/cashflow';
import { inferMonthlyCostKind } from '../domain/monthlyCost';
import { reserveBalanceShortfall } from '../domain/entry';
import { buildAdjustmentEntry, counterpartName, counterpartRole } from '../domain/adjustment';
import { accountBalance, filterByDateRange } from '../domain/accounting';
import {
  continuousCostDisposalEndMonth,
  continuousCostDisposalOutcome,
} from '../domain/continuousCost';
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

async function getSettings(): Promise<Settings | undefined> {
  return getKv<Settings>(KV_SETTINGS);
}

/** 初回だけ既定データを投入する。 */
export async function ensureInitialized(): Promise<void> {
  const meta = await getMeta();
  if (meta) {
    // 後方互換をコードで持たない（作者決定）ため、起動時の schemaVersion 追従
    // （恒等移行等）はここには無い。旧版データが必要になったら単発変換で対応する。
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
      accounts.put({ ...equity, name: OPENING_EQUITY_NAME, updatedAt: ts });
      const kv = t.objectStore(STORE.kv);
      const metaProbe = kv.get(KV_META);
      metaProbe.onsuccess = () => {
        const current = metaProbe.result as LedgerMeta | undefined;
        if (current) {
          kv.put({ ...current, revision: current.revision + 1, updatedAt: ts }, KV_META);
        }
      };
    };
  });
}

export async function loadLedger(): Promise<Ledger> {
  await ensureInitialized();
  const [
    meta,
    settings,
    accounts,
    journalEntries,
    cashflowSchedules,
    reserves,
    tags,
    monthlyCostItems,
    assetDisposals,
    recurringRules,
  ] = await Promise.all([
    getMeta(),
    getSettings(),
    getAll<Account>(STORE.accounts),
    getAll<JournalEntry>(STORE.journalEntries),
    getAll<CashflowSchedule>(STORE.cashflowSchedules),
    getAll<ReserveItem>(STORE.reserves),
    getAll<Tag>(STORE.tags),
    getAll<MonthlyCostItem>(STORE.monthlyCostItems),
    getAll<AssetDisposal>(STORE.assetDisposals),
    getAll<RecurringRule>(STORE.recurringRules),
  ]);
  if (!meta || !settings) throw new Error('台帳の初期化に失敗しました');
  accounts.sort(compareAccountOrder);
  // 一覧の安定した既定順: 仕訳は日付降順 → 作成降順。
  journalEntries.sort((a, b) =>
    a.date === b.date ? cmp(b.createdAt, a.createdAt) : cmp(b.date, a.date),
  );
  // 予定 CF は期日昇順。
  cashflowSchedules.sort((a, b) => cmp(a.dueDate, b.dueDate));
  reserves.sort((a, b) => cmp(a.createdAt, b.createdAt));
  tags.sort((a, b) => a.name.localeCompare(b.name, 'ja'));
  monthlyCostItems.sort((a, b) => cmp(b.createdAt, a.createdAt));
  assetDisposals.sort((a, b) => cmp(b.createdAt, a.createdAt));
  recurringRules.sort((a, b) => cmp(a.createdAt, b.createdAt));
  // 導出専用 entries は持たない。集計は各画面が reportEntriesForAsOf で
  // 基準日ごとに必要範囲だけ仮想展開する（単一正本 = reportBasis + reportEntriesForAsOf）。
  return {
    meta,
    settings,
    accounts,
    journalEntries,
    cashflowSchedules,
    reserves,
    tags,
    monthlyCostItems,
    assetDisposals,
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

/**
 * 処分の確定書き込み。事前チェック（重複・対象の変化）は別 transaction の読みに依存するため、
 * 最終 readwrite transaction 内で item と disposals を再読して再判定し、別タブの編集・
 * 二重処分と直列化する（check-then-act の隙間を残さない。upsertMonthlyCost と同じ idiom）。
 */
async function commitDisposalWrite(params: {
  stores: StoreName[];
  itemBefore: MonthlyCostItem;
  /** 生成仕訳が参照する既存科目（同時削除されていたら abort。tx 内で新規作成する科目は含めない）。 */
  requiredAccountIds: string[];
  write: (t: IDBTransaction) => void;
}): Promise<void> {
  let missingRace = false;
  let duplicateRace = false;
  let conflictRace = false;
  try {
    await writeWithRevision(params.stores, (t) => {
      const itemProbe = t.objectStore(STORE.monthlyCostItems).get(params.itemBefore.id);
      const disposalProbe = t.objectStore(STORE.assetDisposals).getAll();
      const accountProbe = t.objectStore(STORE.accounts).getAll();
      let current: MonthlyCostItem | undefined;
      let currentResolved = false;
      let disposals: AssetDisposal[] = [];
      let disposalsResolved = false;
      let accountIds: Set<string> | undefined;

      const applyAfterProbes = () => {
        if (!currentResolved || !disposalsResolved || !accountIds) return;
        if (!current) {
          missingRace = true;
          t.abort();
          return;
        }
        if (disposals.some((d) => d.monthlyCostId === params.itemBefore.id)) {
          duplicateRace = true;
          t.abort();
          return;
        }
        const ids = accountIds;
        if (
          current.updatedAt !== params.itemBefore.updatedAt ||
          params.requiredAccountIds.some((id) => !ids.has(id))
        ) {
          conflictRace = true;
          t.abort();
          return;
        }
        params.write(t);
      };

      itemProbe.onsuccess = () => {
        current = itemProbe.result as MonthlyCostItem | undefined;
        currentResolved = true;
        applyAfterProbes();
      };
      disposalProbe.onsuccess = () => {
        disposals = disposalProbe.result as AssetDisposal[];
        disposalsResolved = true;
        applyAfterProbes();
      };
      accountProbe.onsuccess = () => {
        accountIds = new Set((accountProbe.result as Account[]).map((a) => a.id));
        applyAfterProbes();
      };
    });
  } catch (error) {
    if (missingRace) throw new LedgerError('error.monthlyCost.notFound');
    if (duplicateRace) throw new LedgerError('error.disposal.duplicate');
    if (conflictRace) throw new LedgerError('error.disposal.conflict');
    throw error;
  }
}

/** updatedAt と表示名以外が同一か。処分済み項目の名称変更を判定する。 */
function isMonthlyCostNameOnlyChange(
  candidate: MonthlyCostItem,
  current: MonthlyCostItem,
): boolean {
  const keys = new Set<keyof MonthlyCostItem>([
    ...(Object.keys(candidate) as (keyof MonthlyCostItem)[]),
    ...(Object.keys(current) as (keyof MonthlyCostItem)[]),
  ]);
  keys.delete('name');
  keys.delete('updatedAt');
  for (const key of keys) {
    if (candidate[key] !== current[key]) return false;
  }
  return true;
}

/* ── 勘定科目 ── */

async function loadReferencingCollections(): Promise<AccountRefCollections> {
  const [entries, schedules, reserves, monthlyCostItems] = await Promise.all([
    getAll<JournalEntry>(STORE.journalEntries),
    getAll<CashflowSchedule>(STORE.cashflowSchedules),
    getAll<ReserveItem>(STORE.reserves),
    getAll<MonthlyCostItem>(STORE.monthlyCostItems),
  ]);
  return { entries, schedules, reserves, monthlyCostItems };
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

export async function upsertAccount(account: Account, opts?: AccountSaveOptions): Promise<void> {
  if (account.name.trim() === '') throw new LedgerError('error.common.nameRequired');
  // role は type と整合する必要がある（import 検証と同じ不変条件を保存時にも守る）。
  if (!roleAllowsType(account.role, account.type)) {
    throw new LedgerError('error.account.roleTypeMismatch');
  }
  // 使用中（仕訳/予定CF/目的別資金から参照中）の科目は区分(type)も役割(role)も変更できない。
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
export async function reorderAccounts(ids: string[]): Promise<void> {
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

/** 使用中（仕訳/予定CF/目的別資金から参照中）の科目は削除できない（アーカイブを使う）。fail-closed。 */
export async function deleteAccount(id: string): Promise<void> {
  const refs = await loadReferencingCollections();
  if (isAccountReferenced(id, refs)) {
    throw new LedgerError('error.account.deleteInUse');
  }
  // この科目を返済口座として設定している負債から、設定ポインタを同一トランザクションで剥がす
  // （設定は予定 CF の既定値にすぎないため、削除を塞がず fail-soft に外す）。
  const accounts = await getAll<Account>(STORE.accounts);
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

/* ── 仕訳 ── */

/**
 * 生成仕訳（月額化=monthlyCostId / 処分=assetDisposalId 付き）と
 * 残高補正仕訳（adjustment 付き）は通常の編集・削除では壊せない。fail-closed。
 * 残高補正は専用画面（updateAdjustment / deleteAdjustment）でだけ管理する（現実アンカーを保つ）。
 */
async function assertNotGeneratedEntry(id: string): Promise<void> {
  const entries = await getAll<JournalEntry>(STORE.journalEntries);
  const target = entries.find((e) => e.id === id);
  if (target?.metadata?.monthlyCostId) throw new LedgerError('error.entry.monthlyCost');
  if (target?.metadata?.assetDisposalId) throw new LedgerError('error.entry.assetDisposal');
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

/** 目的別資金(reserve-asset)を貸方で減らす仕訳は、その資金の残高不足を保存前に拒否する。 */
async function assertReserveSufficient(entry: JournalEntry, accounts: Account[]): Promise<void> {
  if (!accounts.some((a) => a.role === 'reserve-asset')) return;
  const [all, reserves] = await Promise.all([
    getAll<JournalEntry>(STORE.journalEntries),
    getAll<ReserveItem>(STORE.reserves),
  ]);
  const others = all.filter((e) => e.id !== entry.id); // 編集時は自分自身を二重計上しない
  // 集約口座は目的(reserveId)単位で不足判定するため reserves を渡す。
  const short = reserveBalanceShortfall(entry, accounts, others, reserves);
  if (short) throw new LedgerError('error.reserve.shortfall', { name: short.name });
}

export async function upsertEntry(entry: JournalEntry): Promise<void> {
  // 既存が生成仕訳/予定リンク仕訳なら上書き禁止。
  await assertNotGeneratedEntry(entry.id);
  await assertNotScheduleLinked(entry.id);
  // ユーザー入力から生成メタ（monthlyCostId / assetDisposalId）を持つ仕訳は作れない。
  if (entry.metadata?.monthlyCostId) throw new LedgerError('error.entry.monthlyCost');
  if (entry.metadata?.assetDisposalId) throw new LedgerError('error.entry.assetDisposal');
  const ctx = await loadSaveContext();
  const savable = assertEntrySavable(entry, ctx);
  await assertEntryTagsValid(savable);
  await assertReserveSufficient(savable, [...ctx.byId.values()]);
  await writeWithRevision([STORE.journalEntries], (t) => {
    t.objectStore(STORE.journalEntries).put(savable);
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
  if (entry.metadata?.monthlyCostId) throw new LedgerError('error.entry.monthlyCost');
  const ctx = await loadSaveContext();
  const savable = assertEntrySavable(entry, ctx);
  assertSchedulesSavable(schedules, ctx);
  await assertEntryTagsValid(savable);
  await assertReserveSufficient(savable, [...ctx.byId.values()]);
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
export async function createRepaymentEntries(input: RepaymentPlanInput): Promise<JournalEntry[]> {
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
  if (!isValidIsoDate(params.firstDate))
    throw new LedgerError('error.monthlyCost.dateRequired');
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
    description:
      params.count === 1 ? params.title : `${params.title} ${i + 1}/${params.count}`,
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

/* ── 予定キャッシュフロー ── */

/** 予定 CF のタグ代入を import 検証と同じ不変条件で確認する。タグは仕訳全体のみ。 */
async function assertScheduleTagsValid(schedules: CashflowSchedule[]): Promise<void> {
  const tags = await tagMap();
  for (const s of schedules) {
    const e1 = tagAssignmentError(s.entryTagIds, tags);
    if (e1) throw new LedgerError(e1);
  }
}

export async function upsertSchedule(schedule: CashflowSchedule): Promise<void> {
  await upsertSchedules([schedule]);
}

/** 複数の予定（分割払い等）を 1 トランザクションで保存する。 */
export async function upsertSchedules(schedules: CashflowSchedule[]): Promise<void> {
  const ctx = await loadSaveContext();
  assertSchedulesSavable(schedules, ctx);
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

/* ── 定期ルール（毎月の支出・収入・振替 = 実仕訳の自動起票） ── */

export interface RecurringRuleInput {
  name: string;
  amount: number;
  dayOfMonth: number;
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
  // 支出/収入/振替の定型に加え、簿記編集（任意の科目ペア）を許容する。ただし内部集約・
  // 調整科目は自動起票の対象外（RECURRING_POSTABLE_ROLES が正本・fail-closed）。
  if (!isRecurringPostableRole(debit.role) || !isRecurringPostableRole(credit.role))
    throw new LedgerError('error.recurring.flowInvalid');
}

export async function createRecurringRule(input: RecurringRuleInput): Promise<RecurringRule> {
  const ctx = await loadSaveContext();
  const ts = nowIso();
  const rule: RecurringRule = {
    id: newId(),
    name: input.name.trim(),
    amount: input.amount,
    dayOfMonth: input.dayOfMonth,
    debitAccountId: input.debitAccountId,
    creditAccountId: input.creditAccountId,
    startMonth: input.startMonth ?? monthOf(todayLocal()),
    createdAt: ts,
    updatedAt: ts,
  };
  assertRecurringRuleSavable(rule, ctx);
  await writeWithRevision([STORE.recurringRules], (t) => {
    t.objectStore(STORE.recurringRules).put(rule);
  });
  return rule;
}

/** 編集・停止/再開。id / createdAt / postedThroughMonth は既存を保持する（カーソルは起票側が管理）。 */
export async function upsertRecurringRule(rule: RecurringRule): Promise<void> {
  const [ctx, rules] = await Promise.all([
    loadSaveContext(),
    getAll<RecurringRule>(STORE.recurringRules),
  ]);
  const existing = rules.find((r) => r.id === rule.id);
  if (!existing) throw new LedgerError('error.recurring.notFound');
  const saved: RecurringRule = {
    ...rule,
    id: existing.id,
    createdAt: existing.createdAt,
    ...(existing.postedThroughMonth !== undefined
      ? { postedThroughMonth: existing.postedThroughMonth }
      : {}),
    updatedAt: nowIso(),
  };
  if (existing.postedThroughMonth === undefined) delete saved.postedThroughMonth;
  assertRecurringRuleSavable(saved, ctx);
  // 事前読みは別トランザクション。書き込みトランザクション内で現在値を再読し、
  // (a) 削除済みルールを put で復活させない (b) 並行 catchUp が進めたカーソルを
  // 古い値で巻き戻さない（巻き戻すと同じ月が二重起票される）。
  let missingRace = false;
  try {
    await writeWithRevision([STORE.recurringRules], (t) => {
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
 * 定期ルールを削除する。起票済みの仕訳は事実として残し、由来メタデータ
 * （recurringRuleId / recurringMonth）を剥がして通常の仕訳へ戻す（同一トランザクション）。
 */
export async function deleteRecurringRule(id: string): Promise<void> {
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
 *  - idempotent: ルールのカーソル（postedThroughMonth）で管理。起票済み仕訳をユーザーが
 *    削除しても再起票しない（「今月はスキップ」の尊重）。
 *  - 起票された仕訳は通常の実仕訳（metadata に由来のみ）。金額が違う月は起票後に編集する。
 * 戻り値 = 起票した件数。
 */
export async function catchUpRecurringRules(today: string): Promise<number> {
  const [ctx, rules] = await Promise.all([
    loadSaveContext(),
    getAll<RecurringRule>(STORE.recurringRules),
  ]);
  interface RulePlan {
    ruleId: string;
    entries: JournalEntry[];
    cursor: string | undefined;
  }
  const plans: RulePlan[] = [];
  const ts = nowIso();
  for (const rule of rules) {
    const postings = recurringPostingsDue(rule, today);
    const debit = ctx.byId.get(rule.debitAccountId);
    const credit = ctx.byId.get(rule.creditAccountId);
    // 参照が壊れている/自動起票の対象外の科目のルールは起票しない（fail-soft: 起動を止めない）。
    if (!debit || !credit) continue;
    if (!isRecurringPostableRole(debit.role) || !isRecurringPostableRole(credit.role)) continue;
    // 定型（支出/収入/振替）は導出した種別を、非定型（簿記編集）は 'manual' を記録する。
    const inputMode: InputMode = recurringKindOf(debit.role, credit.role) ?? 'manual';
    const entries = postings.map((p) => ({
      id: `rec-${rule.id}-${p.month}`,
      date: p.date,
      description: rule.name,
      kind: 'normal' as const,
      lines: [
        { accountId: rule.debitAccountId, side: 'debit' as const, amount: rule.amount },
        { accountId: rule.creditAccountId, side: 'credit' as const, amount: rule.amount },
      ],
      metadata: { inputMode, recurringRuleId: rule.id, recurringMonth: p.month },
      createdAt: ts,
      updatedAt: ts,
    }));
    const cursor = recurringCursorAfter(rule, today);
    if (entries.length > 0 || cursor !== rule.postedThroughMonth) {
      plans.push({ ruleId: rule.id, entries, cursor });
    }
  }
  if (plans.length === 0) return 0;
  for (const p of plans) p.entries = p.entries.map((e) => assertEntrySavable(e, ctx));
  // 事前読みは別トランザクション。書き込みトランザクション内でルールごとに現在値を
  // 再読し、(a) 削除済みルールぶんを起票しない（削除済みルール参照の仕訳を作らない）
  // (b) 停止されたルールを起票しない (c) 並行 catchUp が進めたカーソルを巻き戻さず、
  // 起票済み月（ユーザーが消した月を含む）を再起票しない。
  let posted = 0;
  await writeWithRevision([STORE.journalEntries, STORE.recurringRules], (t) => {
    const eStore = t.objectStore(STORE.journalEntries);
    const rStore = t.objectStore(STORE.recurringRules);
    for (const plan of plans) {
      const probe = rStore.get(plan.ruleId);
      probe.onsuccess = () => {
        const current = probe.result as RecurringRule | undefined;
        if (!current || current.paused) return;
        const postedThrough = current.postedThroughMonth ?? '';
        for (const e of plan.entries) {
          const month = e.metadata?.recurringMonth;
          if (month !== undefined && month <= postedThrough) continue;
          eStore.put(e);
          posted += 1;
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
  });
  return posted;
}

/* ── 目的別資金 ── */

export async function deleteReserve(id: string): Promise<void> {
  // 仕訳の metadata.reserveId を同一トランザクションで剥がしてから枠を消す
  // （deleteRecurringRule と同型）。剥がさないと孤児 reserveId が残り、
  // その export JSON は自分自身の import 検証（存在しない取り置き参照）で弾かれる。
  const ts = nowIso();
  await writeWithRevision([STORE.reserves, STORE.journalEntries], (t) => {
    const eStore = t.objectStore(STORE.journalEntries);
    const probe = eStore.getAll();
    probe.onsuccess = () => {
      for (const e of probe.result as JournalEntry[]) {
        if (e.metadata?.reserveId !== id) continue;
        const metadata = { ...e.metadata };
        delete metadata.reserveId;
        const next: JournalEntry = { ...e, updatedAt: ts };
        if (Object.keys(metadata).length > 0) next.metadata = metadata;
        else delete next.metadata;
        eStore.put(next);
      }
      t.objectStore(STORE.reserves).delete(id);
    };
  });
}

/**
 * 目的別資金を作成する。既存 asset を紐づけるか、無ければ同名の asset 科目を作る。
 * 取り置き自体は通常の振替（普通預金 → 目的別資金）で行う（このメソッドは枠の登録のみ）。
 */
/**
 * 取り置き残高を寄せる単一の集約口座（『取り置き資金』）を find-or-create する。
 * 目的ごとに勘定科目を作らず、全取り置きをこの 1 口座に通す（聖域化・勘定科目を増やさない）。
 */
function findOrCreateReserveLedgerAccount(
  accounts: Account[],
  ts: string,
): { account: Account; created: boolean } {
  const existing = accounts.find((a) => a.id === RESERVE_LEDGER_ACCOUNT_ID);
  if (existing) return { account: existing, created: false };
  return {
    account: {
      id: RESERVE_LEDGER_ACCOUNT_ID,
      name: RESERVE_LEDGER_ACCOUNT_NAME,
      type: 'asset',
      role: 'reserve-asset',
      archived: false,
      createdAt: ts,
      updatedAt: ts,
    },
    created: true,
  };
}

/**
 * 取り置き枠(ReserveItem)を登録する。取り置きは「短期の封筒分け」（A）: 目標額・目標期限・利回りは持たない。
 * **目的ごとの勘定科目は作らない**——残高は単一の集約口座（reserve-ledger）に寄せ、目的別残高は取り置き仕訳の
 * `metadata.reserveId` 集計で導出する。実際の「取り置く」振替は呼び出し側（EntrySheet）で保存する。
 */
export async function createReserve(input: {
  name: string;
  note?: string;
  /** どの資金口座から取り置いたか（daily-asset）。未指定なら表示順先頭を既定にする。 */
  parentAccountId?: string;
}): Promise<ReserveItem> {
  const ts = nowIso();
  const accounts = await getAll<Account>(STORE.accounts);
  const { account: ledger, created } = findOrCreateReserveLedgerAccount(accounts, ts);
  // 親口座は daily-asset のみ許可。未指定/不正なら表示順先頭を既定にする。
  const dailyAssets = accounts.filter((a) => a.role === 'daily-asset' && !a.archived);
  const validParent =
    input.parentAccountId && dailyAssets.some((a) => a.id === input.parentAccountId)
      ? input.parentAccountId
      : [...dailyAssets].sort(compareAccountOrder)[0]?.id;
  const reserve: ReserveItem = {
    id: newId(),
    name: input.name,
    reserveAccountId: ledger.id,
    ...(validParent !== undefined ? { parentAccountId: validParent } : {}),
    ...(input.note && input.note.trim() !== '' ? { note: input.note.trim() } : {}),
    createdAt: ts,
    updatedAt: ts,
  };
  await writeWithRevision([STORE.accounts, STORE.reserves], (t) => {
    // 集約口座は新規作成時だけ put（目的数ぶん勘定科目を増やさない）。
    if (created) t.objectStore(STORE.accounts).put(ledger);
    t.objectStore(STORE.reserves).put(reserve);
  });
  return reserve;
}

/* ── タグ ── */

export async function upsertTag(tag: Tag): Promise<void> {
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
export async function deleteTag(id: string): Promise<void> {
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
  // 内部集約口座（取り置き資金・継続コスト台帳）は補正対象外。直接補正すると目的別残高・
  // 残存価値の導出と矛盾するため、保存境界で fail-closed に弾く（UI 候補からも除外している）。
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

export async function createAdjustment(input: AdjustmentSaveInput): Promise<JournalEntry | null> {
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
export async function updateAdjustment(
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
export async function deleteAdjustment(id: string): Promise<void> {
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
  newAccount?: { name: string; type: AccountType; role: AccountRole; note?: string };
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
export async function createOpenings(inputs: OpeningInput[]): Promise<JournalEntry[]> {
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
        workingAccounts = workingAccounts.map(
          (account) => renamedById.get(account.id) ?? account,
        );
        for (const renamed of renamedArchived) accountsToPut.set(renamed.id, renamed);
      }
      target = {
        id: newId(),
        name: name.trim(),
        type,
        role,
        archived: false,
        ...(note !== undefined && note.trim() !== '' ? { note: note.trim() } : {}),
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
export async function createOpening(input: OpeningInput): Promise<JournalEntry> {
  const entries = await createOpenings([input]);
  return entries[0]!;
}

/** 初期残高の金額・日付を編集する（対象科目・向き・id は保持）。 */
export async function updateOpening(input: {
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
export async function deleteOpening(id: string): Promise<void> {
  const entries = await getAll<JournalEntry>(STORE.journalEntries);
  const target = entries.find((e) => e.id === id);
  if (!target) throw new LedgerError('error.adjust.notFound');
  if (target.kind !== 'opening') throw new LedgerError('error.opening.notOpening');
  await writeWithRevision([STORE.journalEntries], (t) => {
    t.objectStore(STORE.journalEntries).delete(id);
  });
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
  /** liability 払いのとき: 返済仕訳の返済元口座（daily-asset）。 */
  repaymentAccountId?: string;
  /** 返済回数（>=1）。 */
  repaymentCount?: number;
  /** 初回引落日 ISO（返済仕訳だけに使う。購入仕訳の日付には使わない）。 */
  repaymentStartDate?: string;
}

/**
 * 月額化コストを登録する。
 *
 * 「実際の支払い事実」と「生活コストとしての月割り認識」を分けて扱う:
 *  - **支払い仕訳**: 登録日(date)に `借方 認識先 / 貸方 支払い元`（daily-asset でも
 *    payment-liability でも作る）。`metadata.monthlyCostId` を持ち、通常編集/削除は不可（fail-closed）。
 *    負債払いなら登録日に負債が立ち、返済 CF で取り崩す。
 *  - **生活コスト認識**: 仕訳の正本ではなく `MonthlyCostItem` の formula から導出する分析レイヤ。
 *    ダッシュボードは支払い仕訳を二重計上しないよう除外し、`monthlyCostForMonth` を足す。
 *  - 負債(payment-liability)払い + 返済情報があれば、返済を **未来日付の振替実仕訳** として
 *    初回引落日(repaymentStartDate)から回数分作る（購入日とは別。予定 CF は作らない）。
 * 1 トランザクションで保存し revision を進める。
 */
export async function createMonthlyCost(input: MonthlyCostInput): Promise<MonthlyCostItem> {
  if (input.name.trim() === '') throw new LedgerError('error.common.nameRequired');
  if (!Number.isInteger(input.amount) || input.amount <= 0)
    throw new LedgerError('error.common.amountInvalid');
  if (!Number.isInteger(input.costMonths) || input.costMonths < 1)
    throw new LedgerError('error.monthlyCost.monthsInvalid');
  if (
    input.repeatEveryMonths !== undefined &&
    (!Number.isInteger(input.repeatEveryMonths) || input.repeatEveryMonths < input.costMonths)
  )
    throw new LedgerError('error.monthlyCost.repeatInvalid');
  if (!isValidIsoDate(input.date))
    throw new LedgerError('error.monthlyCost.dateRequired');
  // startMonth は MonthlyCostItem schema と同じく YYYY-MM 形式（分析レイヤの月割り基点）。
  if (!isValidIsoMonth(input.startMonth))
    throw new LedgerError('error.monthlyCost.startMonthInvalid');

  const ctx = await loadSaveContext();
  const expense = ctx.byId.get(input.expenseAccountId);
  if (!expense || !isRecurringPostableRole(expense.role))
    throw new LedgerError('error.monthlyCost.expenseCategory');

  const payment = ctx.byId.get(input.paymentAccountId);
  if (!payment || (payment.role !== 'daily-asset' && payment.role !== 'payment-liability'))
    throw new LedgerError('error.monthlyCost.paymentSource');

  const ts = nowIso();
  const item: MonthlyCostItem = assertMonthlyCostItemSavable({
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
  });

  // 実際の支払い仕訳: 借方 認識先 / 貸方 支払い元（登録日 date で記録）。
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

  // 負債払い + 返済情報があれば、返済を未来日付の振替実仕訳として初回引落日から回数分作る
  // （購入日とは別・予定 CF は作らない）。返済は実予定なので monthlyCostId は付けない＝
  // item 削除でも残す・編集/削除自由。
  let repaymentEntries: JournalEntry[] = [];
  if (
    payment.role === 'payment-liability' &&
    input.repaymentAccountId !== undefined &&
    input.repaymentCount !== undefined &&
    input.repaymentCount >= 1 &&
    input.repaymentStartDate
  ) {
    repaymentEntries = buildRepaymentEntries(ctx, {
      liabilityAccountId: input.paymentAccountId,
      fromAccountId: input.repaymentAccountId,
      firstDate: input.repaymentStartDate,
      total: input.amount,
      count: input.repaymentCount,
      title: `${item.name} 返済`,
      ts,
    });
  }

  // 生成した支払い仕訳も保存境界の検証を通す（fail-closed。返済仕訳は build 内で検証済み）。
  const savablePayment = assertEntrySavable(paymentEntry, ctx);

  await writeWithRevision([STORE.monthlyCostItems, STORE.journalEntries], (t) => {
    t.objectStore(STORE.monthlyCostItems).put(item);
    const eStore = t.objectStore(STORE.journalEntries);
    eStore.put(savablePayment);
    for (const e of repaymentEntries) eStore.put(e);
  });
  return item;
}

export interface ContinuousCostInput {
  /** 継続コスト対象の名前（= 自動作成する資産科目名。例: YouTube / 洗濯機 / 家賃）。 */
  name: string;
  kind: MonthlyCostKind;
  amount: number;
  costMonths: number;
  /** 継続購入（自動更新）なら何か月ごとに再発するか。未指定=償却のみ（1 サイクル）。 */
  repeatEveryMonths?: number;
  /** 初回サイクルの月 'YYYY-MM'。 */
  startMonth: string;
  /** 月ごとの認識先（任意の通常勘定科目）。 */
  expenseAccountId: string;
  /** 支払い元（daily-asset | payment-liability）。funding 仮想仕訳の貸方。 */
  paymentSourceAccountId: string;
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
 * 継続コストを「資産経由モデル」で登録する（v1 の正本フロー）。
 * 残存価値は品目別の資産科目ではなく単一の集約台帳口座（『継続コスト台帳』）に寄せ、台帳ルール
 * (MonthlyCostItem)と（負債資金なら）返済実仕訳（未来日付の振替。予定 CF は作らない）を保存する。
 * **funding/recognition の実仕訳は作らない**——
 * それらは `continuousCost.ts` が必要範囲だけ仮想展開する（辞書展開・永続仕訳を無限生成しない）。
 * 品目名は MonthlyCostItem.name に保持し、勘定科目として自動作成しない。
 */
export async function createContinuousCost(input: ContinuousCostInput): Promise<MonthlyCostItem> {
  if (input.name.trim() === '') throw new LedgerError('error.common.nameRequired');
  if (!Number.isInteger(input.amount) || input.amount <= 0)
    throw new LedgerError('error.common.amountInvalid');
  if (!Number.isInteger(input.costMonths) || input.costMonths < 1)
    throw new LedgerError('error.monthlyCost.monthsInvalid');
  if (
    input.repeatEveryMonths !== undefined &&
    (!Number.isInteger(input.repeatEveryMonths) || input.repeatEveryMonths < input.costMonths)
  )
    throw new LedgerError('error.monthlyCost.repeatInvalid');
  if (!isValidIsoMonth(input.startMonth))
    throw new LedgerError('error.monthlyCost.startMonthInvalid');

  const ctx = await loadSaveContext();
  const expense = ctx.byId.get(input.expenseAccountId);
  if (!expense || !isRecurringPostableRole(expense.role))
    throw new LedgerError('error.monthlyCost.expenseCategory');
  // 継続コスト資産化の資金源は、日常資産・支払用負債に加えて、ローン等の other-liability も許可する
  // （自動車ローンで自動車を買う = 資産取得の貸方が負債）。通常の費用払いに other-liability を雑に
  // 使えるようにするのは別経路（EntrySheet 側）で禁止し、ここでは資産化の funding 貸方として受ける。
  const payment = ctx.byId.get(input.paymentSourceAccountId);
  const paymentOk =
    payment &&
    (payment.role === 'daily-asset' ||
      payment.role === 'payment-liability' ||
      payment.role === 'other-liability');
  if (!paymentOk) throw new LedgerError('error.monthlyCost.paymentSource');

  const ts = nowIso();
  // 残存価値は品目別ではなく単一の集約台帳口座へ寄せる（勘定科目を品目数ぶん増やさない）。
  const { account: ledgerAccount, created: ledgerCreated } =
    findOrCreateContinuousCostLedgerAccount(ctx, ts);

  const item: MonthlyCostItem = assertMonthlyCostItemSavable({
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
    paymentSourceAccountId: input.paymentSourceAccountId,
    recognitionCreditAccountId: ledgerAccount.id,
    ...(input.repaymentAccountId !== undefined
      ? { repaymentAccountId: input.repaymentAccountId }
      : {}),
    status: 'active',
    createdAt: ts,
    updatedAt: ts,
  });

  // 負債資金（カード=payment-liability / ローン=other-liability）+ 返済情報があれば、
  // 返済実仕訳（借方 支払い元負債 / 貸方 返済口座）を作る。`預金 → 自動車ローン` の分割返済など。
  // 返済は実予定なので monthlyCostId は付けない＝item 削除でも残す・編集/削除自由。
  let repaymentEntries: JournalEntry[] = [];
  if (
    (payment.role === 'payment-liability' || payment.role === 'other-liability') &&
    input.repaymentAccountId !== undefined &&
    input.repaymentCount !== undefined &&
    input.repaymentCount >= 1 &&
    input.repaymentStartDate
  ) {
    repaymentEntries = buildRepaymentEntries(ctx, {
      liabilityAccountId: input.paymentSourceAccountId,
      fromAccountId: input.repaymentAccountId,
      firstDate: input.repaymentStartDate,
      total: input.amount,
      count: input.repaymentCount,
      title: `${item.name} 返済`,
      ts,
    });
  }

  await writeWithRevision([STORE.accounts, STORE.monthlyCostItems, STORE.journalEntries], (t) => {
    // 集約台帳口座は新規作成された時だけ put（既存なら品目数ぶん増やさない）。
    if (ledgerCreated) t.objectStore(STORE.accounts).put(ledgerAccount);
    t.objectStore(STORE.monthlyCostItems).put(item);
    const eStore = t.objectStore(STORE.journalEntries);
    for (const e of repaymentEntries) eStore.put(e);
  });
  return item;
}

export interface ContinuousCostOpeningInput {
  /** 継続コスト対象の名前（例: PC / 年払い保険）。 */
  name: string;
  /** 現在の残存価値（最小通貨単位の正の整数）。 */
  amount: number;
  /** 残り月数（1 以上）。amount を残り月数で割って費用認識する。 */
  costMonths: number;
  /** 認識開始月 'YYYY-MM'（通常は移行した月）。 */
  startMonth: string;
  /** 月ごとの認識先（任意の通常勘定科目）。 */
  expenseAccountId: string;
}

/**
 * すでに持っている継続コスト対象（GAS 等からの移行）を「初期残高」として登録する。
 * funding 仮想仕訳の貸方を 初期残高(equity) にする＝残存価値を opening と同じ意味で計上する
 * （収入にも支出にもならない・支払い元の資金も動かない）。以降の費用認識・売却/解約は
 * 通常の継続コストと同一の仮想展開エンジン（continuousCost.ts）がそのまま扱う。
 * 更新（repeatEveryMonths）は付けない: 次の更新支払いは通常の支出→継続コスト化で新規登録する。
 */
export async function createContinuousCostFromOpening(
  input: ContinuousCostOpeningInput,
): Promise<MonthlyCostItem> {
  if (input.name.trim() === '') throw new LedgerError('error.common.nameRequired');
  if (!Number.isInteger(input.amount) || input.amount <= 0)
    throw new LedgerError('error.common.amountInvalid');
  if (!Number.isInteger(input.costMonths) || input.costMonths < 1)
    throw new LedgerError('error.monthlyCost.monthsInvalid');
  if (!isValidIsoMonth(input.startMonth))
    throw new LedgerError('error.monthlyCost.startMonthInvalid');

  const ctx = await loadSaveContext();
  const expense = ctx.byId.get(input.expenseAccountId);
  if (!expense || !isRecurringPostableRole(expense.role))
    throw new LedgerError('error.monthlyCost.expenseCategory');

  const ts = nowIso();
  const { account: ledgerAccount, created: ledgerCreated } =
    findOrCreateContinuousCostLedgerAccount(ctx, ts);
  const { account: equity, created: equityCreated } = findOrCreateOpeningEquityAccount(
    ctx.byId.values(),
    ts,
  );

  const item: MonthlyCostItem = assertMonthlyCostItemSavable({
    id: newId(),
    name: input.name.trim(),
    kind: inferMonthlyCostKind(input.costMonths, undefined),
    amount: input.amount,
    costMonths: input.costMonths,
    startMonth: input.startMonth,
    expenseAccountId: input.expenseAccountId,
    // funding 仮想仕訳の貸方 = 初期残高。opening と同じ会計意味（PL を通らない）。
    paymentSourceAccountId: equity.id,
    recognitionCreditAccountId: ledgerAccount.id,
    status: 'active',
    createdAt: ts,
    updatedAt: ts,
  });

  await writeWithRevision([STORE.accounts, STORE.monthlyCostItems], (t) => {
    const aStore = t.objectStore(STORE.accounts);
    if (ledgerCreated) aStore.put(ledgerAccount);
    if (equityCreated) aStore.put(equity);
    t.objectStore(STORE.monthlyCostItems).put(item);
  });
  return item;
}

export interface SubscriptionMigrationInput {
  /** 契約の名前（例: クラウドストレージ）。 */
  name: string;
  /** 今サイクルの残存価値（残り月数ぶんの前払い分）。 */
  remainingAmount: number;
  /** 今サイクルの残り月数（1 以上）。 */
  remainingMonths: number;
  /** 更新ごとの支払額。 */
  renewalAmount: number;
  /** 更新周期（か月。年払いは 12）。 */
  renewalEveryMonths: number;
  /** 更新の支払い元（daily-asset | payment-liability | other-liability）。 */
  paymentSourceAccountId: string;
  expenseAccountId: string;
  /** 認識開始月（既定は今日の月）。 */
  startMonth?: string;
}

/**
 * 自動更新される契約（年払いサブスク等）を**サイクル途中から**持ち込む。2 つの item を 1 tx で作る:
 *  1. 移行分: 残存価値を 初期残高(equity) funding で計上し、残り月数で認識して終了
 *     （endMonth 固定。収入・支出・資金移動にならない＝通常の移行登録と同じ会計意味）。
 *  2. 更新分: 残り月数の翌月から、更新額を更新周期で自動継続（funding 貸方=支払い元。
 *     カード払いなら仮想的にカード残高が増え、返済フローで実精算する）。
 * 解約は有効な item の売却（0円売却）1 操作＝実使用月数へ遡及再配分され、以後の更新も止まる。
 */
export async function createSubscriptionMigration(
  input: SubscriptionMigrationInput,
): Promise<{ migration: MonthlyCostItem; renewal: MonthlyCostItem }> {
  if (input.name.trim() === '') throw new LedgerError('error.common.nameRequired');
  if (!Number.isInteger(input.remainingAmount) || input.remainingAmount <= 0)
    throw new LedgerError('error.common.amountInvalid');
  if (!Number.isInteger(input.renewalAmount) || input.renewalAmount <= 0)
    throw new LedgerError('error.common.amountInvalid');
  if (!Number.isInteger(input.remainingMonths) || input.remainingMonths < 1)
    throw new LedgerError('error.monthlyCost.monthsInvalid');
  if (!Number.isInteger(input.renewalEveryMonths) || input.renewalEveryMonths < 1)
    throw new LedgerError('error.monthlyCost.repeatInvalid');

  const ctx = await loadSaveContext();
  const expense = ctx.byId.get(input.expenseAccountId);
  if (!expense || !isRecurringPostableRole(expense.role))
    throw new LedgerError('error.monthlyCost.expenseCategory');
  const payment = ctx.byId.get(input.paymentSourceAccountId);
  const paymentOk =
    payment &&
    (payment.role === 'daily-asset' ||
      payment.role === 'payment-liability' ||
      payment.role === 'other-liability');
  if (!paymentOk) throw new LedgerError('error.monthlyCost.paymentSource');

  const startMonth = input.startMonth ?? monthOf(todayLocal());
  if (!isValidIsoMonth(startMonth))
    throw new LedgerError('error.monthlyCost.startMonthInvalid');

  const ts = nowIso();
  const { account: ledgerAccount, created: ledgerCreated } =
    findOrCreateContinuousCostLedgerAccount(ctx, ts);
  const { account: equity, created: equityCreated } = findOrCreateOpeningEquityAccount(
    ctx.byId.values(),
    ts,
  );

  // 1. 移行分: 残り月数で認識し切って終了する（endMonth 固定＝動的延伸しない）。
  const migration: MonthlyCostItem = assertMonthlyCostItemSavable({
    id: newId(),
    name: `${input.name.trim()}（移行分）`,
    kind: inferMonthlyCostKind(input.remainingMonths, undefined),
    amount: input.remainingAmount,
    costMonths: input.remainingMonths,
    startMonth,
    endMonth: addMonths(startMonth, input.remainingMonths - 1),
    expenseAccountId: input.expenseAccountId,
    paymentSourceAccountId: equity.id,
    recognitionCreditAccountId: ledgerAccount.id,
    status: 'active',
    createdAt: ts,
    updatedAt: ts,
  });

  // 2. 更新分: 残り月数の翌月＝次回更新月から、更新周期で自動継続する。
  const renewal: MonthlyCostItem = assertMonthlyCostItemSavable({
    id: newId(),
    name: input.name.trim(),
    kind: inferMonthlyCostKind(input.renewalEveryMonths, input.renewalEveryMonths),
    amount: input.renewalAmount,
    costMonths: input.renewalEveryMonths,
    repeatEveryMonths: input.renewalEveryMonths,
    startMonth: addMonths(startMonth, input.remainingMonths),
    expenseAccountId: input.expenseAccountId,
    paymentSourceAccountId: input.paymentSourceAccountId,
    recognitionCreditAccountId: ledgerAccount.id,
    status: 'active',
    createdAt: ts,
    updatedAt: ts,
  });

  await writeWithRevision([STORE.accounts, STORE.monthlyCostItems], (t) => {
    const aStore = t.objectStore(STORE.accounts);
    if (ledgerCreated) aStore.put(ledgerAccount);
    if (equityCreated) aStore.put(equity);
    const mStore = t.objectStore(STORE.monthlyCostItems);
    mStore.put(migration);
    mStore.put(renewal);
  });
  return { migration, renewal };
}

/**
 * 月額化コストの更新（後編集・一時停止・終了）。保存境界で fail-closed に検証し、必要なら
 * 関連（実支払い仕訳・未実績の返済 CF）を同じトランザクションで整合させる。
 *
 * 設計上の不変条件:
 *  - 「実際の支払い仕訳」と「月次認識(formula)」を分離している。名称・期間・認識先・
 *    状態の編集は formula 側（分析レイヤ）だけを変える。
 *  - **総額(amount)の変更**は会計事実に波及するため強く制御する。
 *    - 関連返済 CF が 1 件でも posted なら拒否（現金/負債が既に動いている）。
 *    - 全て未実績なら、関連返済 CF を新総額で再配分し、生成支払い仕訳の借方/貸方金額も同時更新する。
 *  - **認識先(expenseAccountId)の変更**は、生成支払い仕訳の借方科目も同時更新する。
 *  - 支払い元・返済口座・recognition 科目・id・createdAt は変更不可（既存値を保持）。
 */
export async function upsertMonthlyCost(item: MonthlyCostItem): Promise<void> {
  const [items, entries, schedules, disposals] = await Promise.all([
    getAll<MonthlyCostItem>(STORE.monthlyCostItems),
    getAll<JournalEntry>(STORE.journalEntries),
    getAll<CashflowSchedule>(STORE.cashflowSchedules),
    getAll<AssetDisposal>(STORE.assetDisposals),
  ]);
  const existing = items.find((m) => m.id === item.id);
  if (!existing) throw new LedgerError('error.monthlyCost.notFound');

  // 処分記録がある項目は会計導出を確定済みとして凍結する。updatedAt は保存時に更新し、
  // 表示名だけ変更可能。正規化後では変更試行を見落とすため、入力値を既存値と直接比較する。
  const disposed = disposals.some((disposal) => disposal.monthlyCostId === existing.id);
  if (disposed && !isMonthlyCostNameOnlyChange(item, existing)) {
    throw new LedgerError('error.monthlyCost.disposedLocked');
  }

  // 変更不可フィールドは既存値を保持（UI が誤った値を送っても保存境界で固定する）。
  // 既存レコード由来の値を spread するため、この時点では撤去済みフィールドの残骸が混じりうる
  // （後段の assertMonthlyCostItemSavable が落とす）。
  const merged: MonthlyCostItem = {
    ...item,
    id: existing.id,
    ...(existing.paymentSourceAccountId !== undefined
      ? { paymentSourceAccountId: existing.paymentSourceAccountId }
      : {}),
    ...(existing.paymentAccountId !== undefined
      ? { paymentAccountId: existing.paymentAccountId }
      : {}),
    ...(existing.repaymentAccountId !== undefined
      ? { repaymentAccountId: existing.repaymentAccountId }
      : {}),
    ...(existing.recognitionCreditAccountId !== undefined
      ? { recognitionCreditAccountId: existing.recognitionCreditAccountId }
      : {}),
    ...(existing.disposalProceedsAmount !== undefined
      ? { disposalProceedsAmount: existing.disposalProceedsAmount }
      : {}),
    createdAt: existing.createdAt,
    updatedAt: nowIso(),
  };
  // UI 側で消し込めない optional を保持しないよう、locked 以外の undefined は素直に従う。

  // 専用エラー契約を保つため、期間不変条件は構造schemaより先に判定する。
  // endMonth の「前月」は終了済み（使用0ヶ月の同月処分）だけの正当なエンコード。
  if (merged.repeatEveryMonths !== undefined && merged.repeatEveryMonths < merged.costMonths)
    throw new LedgerError('error.monthlyCost.repeatInvalid');
  if (
    merged.endMonth !== undefined &&
    merged.endMonth < merged.startMonth &&
    !(merged.status === 'ended' && merged.endMonth === addMonths(merged.startMonth, -1))
  )
    throw new LedgerError('error.monthlyCost.endBeforeStart');
  if (merged.status !== 'active' && merged.endMonth === undefined)
    throw new LedgerError('error.monthlyCost.endMonthRequired');
  // 保存値は strip 済みを使う＝編集のたびに撤去済みフィールドの残骸が落ちて自己修復する。
  const saved: MonthlyCostItem = assertMonthlyCostItemSavable(merged);

  // 認識先は内部集約・残高調整以外の勘定科目であること（定期ルールと同じ正本）。
  // type による支出/収入減/振替の分類は導出側で行う。
  const ctx = await loadSaveContext();
  const expense = ctx.byId.get(saved.expenseAccountId);
  if (!expense || !isRecurringPostableRole(expense.role))
    throw new LedgerError('error.monthlyCost.expenseCategory');

  // 移行登録（初期残高 funding）の項目に「継続購入（自動更新）」は設定できない。
  // 更新のたびに初期残高から資金が湧く（謎の収入化・実支払いと二重計上）ため fail-closed。
  // 毎月払いのサブスクは定期ルール（毎月の支出）か、支出入力からの継続コスト化で扱う。
  const paymentSource = saved.paymentSourceAccountId
    ? ctx.byId.get(saved.paymentSourceAccountId)
    : undefined;
  if (paymentSource?.role === 'equity' && saved.repeatEveryMonths !== undefined)
    throw new LedgerError('error.monthlyCost.repeatOnOpening');

  const relatedEntries = entries.filter((e) => e.metadata?.monthlyCostId === saved.id);
  const relatedSchedules = schedules.filter((s) => s.monthlyCostId === saved.id);
  const amountChanged = saved.amount !== existing.amount;
  const expenseChanged = saved.expenseAccountId !== existing.expenseAccountId;

  // 生成支払い仕訳に反映する変更（金額・認識先）。
  const updatedEntries: JournalEntry[] = [];
  const updatedSchedules: CashflowSchedule[] = [];

  if (amountChanged) {
    // 返済 CF が 1 件でも実績化済みなら、現金/負債が動いているため総額変更を禁止。
    if (relatedSchedules.some((s) => s.status === 'posted'))
      throw new LedgerError('error.monthlyCost.editAmountPosted');
    // 未実績の返済 CF を新総額で再配分（合計＝新総額）。期日順に配る。
    if (relatedSchedules.length > 0) {
      const ordered = [...relatedSchedules].sort((a, b) =>
        a.dueDate === b.dueDate ? a.id.localeCompare(b.id) : a.dueDate.localeCompare(b.dueDate),
      );
      const parts = monthlyAmounts(saved.amount, ordered.length);
      ordered.forEach((s, i) => {
        updatedSchedules.push({ ...s, amount: parts[i] ?? 0, updatedAt: saved.updatedAt });
      });
    }
  }

  if (amountChanged || expenseChanged) {
    for (const e of relatedEntries) {
      const lines = e.lines.map((l) => {
        let next = l;
        if (amountChanged) next = { ...next, amount: saved.amount };
        // 借方（認識先）の科目を新しい認識先へ。貸方（支払い元）は変更しない。
        if (expenseChanged && l.side === 'debit')
          next = { ...next, accountId: saved.expenseAccountId };
        return next;
      });
      const updated: JournalEntry = { ...e, lines, updatedAt: saved.updatedAt };
      // 2 行・同額・正の整数・参照/役割整合を再検証し、strip 済みを保存値にする。
      updatedEntries.push(assertEntrySavable(updated, ctx));
    }
  }

  // 再配分後の返済 CF も保存境界を通す（再配分で 0 円が生じる等を fail-closed で弾く）。
  if (updatedSchedules.length > 0) assertSchedulesSavable(updatedSchedules, ctx);

  const applyUpdates = (t: IDBTransaction) => {
    t.objectStore(STORE.monthlyCostItems).put(saved);
    const eStore = t.objectStore(STORE.journalEntries);
    for (const e of updatedEntries) eStore.put(e);
    const sStore = t.objectStore(STORE.cashflowSchedules);
    for (const s of updatedSchedules) sStore.put(s);
  };

  // 外側の item / disposal は別々の readonly transaction で読まれるため、処分前後が混在しうる。
  // 最終 readwrite transaction で両方を必ず再読し、処分済みなら current 基準の名称変更だけを許可する。
  let disposedRace = false;
  let missingRace = false;
  try {
    await writeWithRevision(
      [
        STORE.monthlyCostItems,
        STORE.journalEntries,
        STORE.cashflowSchedules,
        STORE.assetDisposals,
      ],
      (t) => {
        const itemStore = t.objectStore(STORE.monthlyCostItems);
        const itemProbe = itemStore.get(saved.id);
        const disposalProbe = t.objectStore(STORE.assetDisposals).getAll();
        let current: MonthlyCostItem | undefined;
        let currentResolved = false;
        let disposals: AssetDisposal[] = [];
        let disposalsResolved = false;

        const applyAfterProbes = () => {
          if (!currentResolved || !disposalsResolved) return;
          if (!current) {
            missingRace = true;
            t.abort();
            return;
          }
          const nowDisposed = disposals.some(
            (assetDisposal) => assetDisposal.monthlyCostId === saved.id,
          );
          if (nowDisposed) {
            if (!isMonthlyCostNameOnlyChange(item, current)) {
              disposedRace = true;
              t.abort();
              return;
            }
            itemStore.put(
              stripMonthlyCostItem({ ...current, name: item.name, updatedAt: saved.updatedAt }),
            );
            return;
          }
          applyUpdates(t);
        };

        itemProbe.onsuccess = () => {
          current = itemProbe.result as MonthlyCostItem | undefined;
          currentResolved = true;
          applyAfterProbes();
        };
        disposalProbe.onsuccess = () => {
          disposals = disposalProbe.result as AssetDisposal[];
          disposalsResolved = true;
          applyAfterProbes();
        };
      },
    );
  } catch (error) {
    if (disposedRace) throw new LedgerError('error.monthlyCost.disposedLocked');
    if (missingRace) throw new LedgerError('error.monthlyCost.notFound');
    throw error;
  }
}

/**
 * 月額化コストを削除する。関連（実支払い仕訳・返済 CF）も一括で扱う fail-closed。
 *  - 現行設計では「実際の支払い仕訳（借方 費用 / 貸方 支払い元）」と「生活コスト認識の分析レイヤ
 *    （formula）」を分離している。削除では支払い仕訳と返済 CF を扱う。
 *  - **処分済み（AssetDisposal が参照）は削除禁止。**
 *    本体だけ消すと AssetDisposal.monthlyCostId が孤立する。履歴は「終了」/「売却」で残す。
 *  - 返済 CF が 1 件でも実績化(posted)済みなら、現金/負債が動いているため物理削除は禁止。
 *    `status='ended'` で終了させること（履歴と整合を壊さない）。
 *  - すべて未実績なら、実支払い仕訳・未実績 CF・本体を 1 トランザクションで同時削除する（孤立を残さない）。
 */
export async function deleteMonthlyCost(id: string): Promise<void> {
  const [entries, schedules, disposals] = await Promise.all([
    getAll<JournalEntry>(STORE.journalEntries),
    getAll<CashflowSchedule>(STORE.cashflowSchedules),
    getAll<AssetDisposal>(STORE.assetDisposals),
  ]);
  // 処分済み（AssetDisposal が参照）も削除しない（参照が孤立する）。
  if (disposals.some((d) => d.monthlyCostId === id))
    throw new LedgerError('error.monthlyCost.deleteDisposed');
  const relatedSchedules = schedules.filter((s) => s.monthlyCostId === id);
  const relatedEntries = entries.filter((e) => e.metadata?.monthlyCostId === id);
  if (relatedSchedules.some((s) => s.status === 'posted')) {
    throw new LedgerError('error.monthlyCost.deletePosted');
  }
  // 事前チェックは別トランザクションの読みに依存するため、最終トランザクションで
  // 処分の有無だけ再判定する（処分直後に削除が走ると台帳だけ消えて AssetDisposal と
  // 生成仕訳が孤立し、export が復元不能になる）。
  let disposedRace = false;
  try {
    await writeWithRevision(
      [STORE.monthlyCostItems, STORE.cashflowSchedules, STORE.journalEntries, STORE.assetDisposals],
      (t) => {
        const probe = t.objectStore(STORE.assetDisposals).getAll();
        probe.onsuccess = () => {
          if ((probe.result as AssetDisposal[]).some((d) => d.monthlyCostId === id)) {
            disposedRace = true;
            t.abort();
            return;
          }
          t.objectStore(STORE.monthlyCostItems).delete(id);
          const sStore = t.objectStore(STORE.cashflowSchedules);
          for (const s of relatedSchedules) sStore.delete(s.id);
          const eStore = t.objectStore(STORE.journalEntries);
          for (const e of relatedEntries) eStore.delete(e.id);
        };
      },
    );
  } catch (error) {
    if (disposedRace) throw new LedgerError('error.monthlyCost.deleteDisposed');
    throw error;
  }
}

/* ── 継続コスト（資産経由モデル）の売却・解約終了 ── */

export interface DisposeContinuousCostInput {
  monthlyCostId: string;
  disposalDate: string;
  proceedsAmount: number;
  destinationAccountId?: string;
}

/**
 * 継続コスト（資産経由モデル）を「売却」で終了する。サブスク解約・返金なし終了は
 * **0円で売却**として同じ導線で扱う（proceedsAmount=0）。
 *
 * 仮想モデルでは funding / recognition が終了月で止まるため、認識済み分の
 * 消し込み仕訳は不要。残存価値（funded − recognized）だけを実仕訳で精算し、
 * 継続コスト台帳口座のこの項目ぶんの残高を 0 へ消し込む:
 *  - 売却入金: 借方 入金先 / 貸方 継続コスト台帳（min(proceeds, remaining)）。
 *  - 売却損: 借方 その他支出 / 貸方 継続コスト台帳（remaining − proceeds）。生活コストに含める。
 *  - 売却益: 借方 入金先 / 貸方 その他収入（proceeds − remaining）。
 * remaining=0 かつ proceeds=0（月課金サブスクの解約など）は仕訳を作らず終了だけ記録する。
 *
 * 記録は AssetDisposal を使い（fixedAccountId=継続コスト台帳口座）、
 * 生成仕訳は metadata.assetDisposalId で保護される（通常編集・削除不可。fail-closed）。
 */
export async function disposeContinuousCost(
  input: DisposeContinuousCostInput,
): Promise<AssetDisposal> {
  if (!isValidIsoDate(input.disposalDate))
    throw new LedgerError('error.disposal.dateRequired');
  if (!Number.isInteger(input.proceedsAmount) || input.proceedsAmount < 0)
    throw new LedgerError('error.disposal.proceedsInvalid');

  const [items, accounts, disposals] = await Promise.all([
    getAll<MonthlyCostItem>(STORE.monthlyCostItems),
    getAll<Account>(STORE.accounts),
    getAll<AssetDisposal>(STORE.assetDisposals),
  ]);
  const item = items.find((m) => m.id === input.monthlyCostId);
  if (!item) throw new LedgerError('error.monthlyCost.notFound');

  // 対象は資産経由モデル（recognitionCreditAccountId が継続コスト台帳口座）に限る。
  const ledgerAccount = item.recognitionCreditAccountId
    ? accounts.find((a) => a.id === item.recognitionCreditAccountId)
    : undefined;
  if (!ledgerAccount || ledgerAccount.role !== 'continuing-cost-asset')
    throw new LedgerError('error.disposal.notContinuousCost');

  if (item.status === 'ended') throw new LedgerError('error.disposal.alreadyEnded');
  if (disposals.some((d) => d.monthlyCostId === item.id))
    throw new LedgerError('error.disposal.duplicate');

  // 売却額があるとき、入金先は必須 + role: daily-asset / reserve-asset。
  let destination: Account | undefined;
  if (input.proceedsAmount > 0) {
    if (!input.destinationAccountId) throw new LedgerError('error.disposal.destinationRequired');
    destination = accounts.find((a) => a.id === input.destinationAccountId);
    if (
      !destination ||
      (destination.role !== 'daily-asset' && destination.role !== 'reserve-asset')
    )
      throw new LedgerError('error.disposal.destinationInvalid');
  }

  const disposalMonth = monthOf(input.disposalDate);
  // 開始月より前の処分は「開始前に処分」＝入力誤り。endMonth < startMonth の item を作らせない。
  if (disposalMonth < item.startMonth) throw new LedgerError('error.disposal.beforeStart');
  // 実績動的償却: 損益の一括計上はしない。最終サイクルを「実使用月数・売却額控除」で
  // 遡及再配分する（月額に吸収）。実仕訳は売却額の資産移動と、サイクル額を超えた益だけ。
  const { fundedAmount, inflow, gain } = continuousCostDisposalOutcome(
    item,
    disposalMonth,
    input.proceedsAmount,
  );

  const ts = nowIso();
  const disposalId = newId();
  const generated: JournalEntry[] = [];

  const mkEntry = (debitId: string, creditId: string, amount: number): JournalEntry => ({
    id: newId(),
    date: input.disposalDate,
    description: `${item.name} 売却・終了`,
    kind: 'normal',
    lines: [
      { accountId: debitId, side: 'debit', amount },
      { accountId: creditId, side: 'credit', amount },
    ],
    metadata: { assetDisposalId: disposalId },
    createdAt: ts,
    updatedAt: ts,
  });

  // A: 売却入金（入金先 / 継続コスト台帳）。認識側が売却額ぶんを費用配分から控除するため、
  // 台帳に残るその残高をここで入金先へ移す（＝台帳のこの項目ぶんが 0 で閉じる）。
  if (inflow > 0 && destination) generated.push(mkEntry(destination.id, ledgerAccount.id, inflow));

  // B: 売却益（入金先 / その他収入）。売却額が最終サイクル額を超えた分だけ。
  if (gain > 0 && destination) {
    const gainAccount =
      accounts.find(
        (a) => a.role === 'income-category' && a.name === DISPOSAL_GAIN_ACCOUNT_NAME && !a.archived,
      ) ?? accounts.find((a) => a.role === 'income-category' && !a.archived);
    if (!gainAccount) throw new LedgerError('error.disposal.gainCategoryMissing');
    generated.push(mkEntry(destination.id, gainAccount.id, gain));
  }

  // 生成仕訳を保存境界で再検証する（保存値は strip 済みを使う）。
  const ctx = await loadSaveContext();
  const savableGenerated = generated.map((e) => assertEntrySavable(e, ctx));

  const disposal: AssetDisposal = {
    id: disposalId,
    monthlyCostId: item.id,
    fixedAccountId: ledgerAccount.id,
    disposalDate: input.disposalDate,
    proceedsAmount: input.proceedsAmount,
    ...(input.proceedsAmount > 0 && destination ? { destinationAccountId: destination.id } : {}),
    // 実績動的償却: 費用配分は 資産化総額 − 売却額（最終サイクル分）に収束し、残存価値は残らない。
    recognizedAmount: fundedAmount - inflow,
    remainingAmount: 0,
    generatedEntryIds: savableGenerated.map((e) => e.id),
    createdAt: ts,
    updatedAt: ts,
  };

  // 終了月（処分月まで使用として数える）から先の funding / recognition を止める。
  // 過去は実使用月数で遡及再配分される（disposalProceedsAmount は認識側の控除に使う）。
  const updatedItem: MonthlyCostItem = assertMonthlyCostItemSavable({
    ...item,
    status: 'ended',
    endMonth: continuousCostDisposalEndMonth(item, disposalMonth),
    ...(inflow > 0 ? { disposalProceedsAmount: inflow } : {}),
    updatedAt: ts,
  });
  await commitDisposalWrite({
    stores: [STORE.assetDisposals, STORE.journalEntries, STORE.monthlyCostItems, STORE.accounts],
    itemBefore: item,
    requiredAccountIds: [
      ...new Set(savableGenerated.flatMap((e) => e.lines.map((l) => l.accountId))),
    ],
    write: (t) => {
      const eStore = t.objectStore(STORE.journalEntries);
      for (const e of savableGenerated) eStore.put(e);
      t.objectStore(STORE.monthlyCostItems).put(updatedItem);
      t.objectStore(STORE.assetDisposals).put(disposal);
    },
  });
  return disposal;
}

/* ── 一括置換（import / restore で使う原子的操作） ── */

export interface ReplacePayload {
  meta: LedgerMeta;
  settings: Settings;
  accounts: Account[];
  journalEntries: JournalEntry[];
  cashflowSchedules: CashflowSchedule[];
  reserves: ReserveItem[];
  tags: Tag[];
  monthlyCostItems: MonthlyCostItem[];
  assetDisposals: AssetDisposal[];
  recurringRules: RecurringRule[];
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
      STORE.cashflowSchedules,
      STORE.reserves,
      STORE.tags,
      STORE.monthlyCostItems,
      STORE.assetDisposals,
      STORE.recurringRules,
    ],
    (t) => {
      const accounts = t.objectStore(STORE.accounts);
      const entries = t.objectStore(STORE.journalEntries);
      const schedules = t.objectStore(STORE.cashflowSchedules);
      const reserves = t.objectStore(STORE.reserves);
      const tags = t.objectStore(STORE.tags);
      const monthlyCosts = t.objectStore(STORE.monthlyCostItems);
      const disposals = t.objectStore(STORE.assetDisposals);
      const rules = t.objectStore(STORE.recurringRules);
      accounts.clear();
      entries.clear();
      schedules.clear();
      reserves.clear();
      tags.clear();
      monthlyCosts.clear();
      disposals.clear();
      rules.clear();
      for (const a of payload.accounts) accounts.put(a);
      for (const e of payload.journalEntries) entries.put(e);
      for (const s of payload.cashflowSchedules) schedules.put(s);
      for (const r of payload.reserves) reserves.put(r);
      for (const tag of payload.tags) tags.put(tag);
      for (const mc of payload.monthlyCostItems) monthlyCosts.put(mc);
      for (const d of payload.assetDisposals) disposals.put(d);
      for (const rule of payload.recurringRules) rules.put(rule);
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
      STORE.cashflowSchedules,
      STORE.reserves,
      STORE.tags,
      STORE.monthlyCostItems,
      STORE.assetDisposals,
      STORE.recurringRules,
      STORE.snapshots,
    ],
    (t) => {
      t.objectStore(STORE.kv).clear();
      t.objectStore(STORE.accounts).clear();
      t.objectStore(STORE.journalEntries).clear();
      t.objectStore(STORE.cashflowSchedules).clear();
      t.objectStore(STORE.reserves).clear();
      t.objectStore(STORE.tags).clear();
      t.objectStore(STORE.monthlyCostItems).clear();
      t.objectStore(STORE.assetDisposals).clear();
      t.objectStore(STORE.recurringRules).clear();
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
