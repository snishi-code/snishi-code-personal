/*
 * スキーマ migration の入口。
 *
 * 方針（CLAUDE.md 憲法・fail-closed）:
 *  - schemaVersion を必ず確認する。
 *  - 未対応版（現行より新しい／登録の無い旧版）は取り込まない=fail-closed。
 *  - migration 失敗時は既存データを保持し、呼び出し側で UI 通知する。
 *
 * MVP 初期は version 1 のみ。将来 version 2 を足すときは、
 * migrations に { from: 1, to: 2, migrate } を登録する。
 */
import {
  CONTINUOUS_COST_LEDGER_ACCOUNT_ID,
  CONTINUOUS_COST_LEDGER_ACCOUNT_NAME,
  DEFAULT_MANAGEMENT_SCOPE_ID,
  DEFAULT_MANAGEMENT_SCOPE_NAME,
  RESERVE_LEDGER_ACCOUNT_ID,
  RESERVE_LEDGER_ACCOUNT_NAME,
  SCHEMA_VERSION,
} from './constants';
import { inferRole } from './accountRoles';
import { monthlyCostItemsFromAllocations } from './monthlyCostMigration';
import { nowIso } from '../util/time';
import type {
  Account,
  CashflowSchedule,
  JournalEntry,
  JournalLine,
  LedgerExportPackage,
  ManagementScope,
  MonthlyCostItem,
  ReserveItem,
} from './types';

export interface MigrationResult {
  ok: boolean;
  /** 成功時の、現行スキーマに揃えたパッケージ。 */
  data?: LedgerExportPackage;
  /** 失敗時の理由（UI 表示用キー的メッセージ）。 */
  reason?: 'too-new' | 'unknown-version' | 'migration-failed';
  detail?: string;
}

type Step = {
  from: number;
  to: number;
  migrate: (pkg: LedgerExportPackage) => LedgerExportPackage;
};

/**
 * v13→v14（勘定科目の聖域化）の共通ロジック。import 経路と既存DB起動経路の両方から使う。
 * 品目別の continuing-cost-asset 科目を単一の集約台帳口座（CONTINUOUS_COST_LEDGER_ACCOUNT_ID）へ寄せる:
 *  - 旧品目別科目を指す MonthlyCostItem.recognitionCreditAccountId を集約口座へ付け替える（name は item 上に残る）。
 *  - 参照されなくなった旧品目別科目は削除。万一 実仕訳/予定CF/取り置き資金から参照されていれば
 *    削除せず archived にフォールバック（fail-safe・通常は起きない＝funding/recognition は仮想・非永続）。
 *  - 付け替え後に集約口座を参照する item が 1 件でもあり、集約口座が未作成なら作成する。
 *  - fixed-asset 由来（recognitionCreditAccountId が fixed-asset）は対象外（旧互換の別経路）。
 */
export interface ContinuingCostConsolidation {
  /** ensure すべき集約台帳口座（既存または新規）。継続コスト item が無ければ null。 */
  ledgerAccount: Account | null;
  /** ledgerAccount を新規 put する必要があるか（既存再利用なら false）。 */
  ledgerCreated: boolean;
  /** 集約口座へ付け替えた MonthlyCostItem（recognitionCreditAccountId のみ変更）。 */
  repointedItems: MonthlyCostItem[];
  /** 削除してよい旧品目別 continuing-cost-asset 科目の id。 */
  dropAccountIds: string[];
  /** 参照中のため削除せず archived にした旧科目（fail-safe）。 */
  archivedAccounts: Account[];
}

function newContinuousCostLedgerAccount(ts: string): Account {
  return {
    id: CONTINUOUS_COST_LEDGER_ACCOUNT_ID,
    name: CONTINUOUS_COST_LEDGER_ACCOUNT_NAME,
    type: 'asset',
    role: 'continuing-cost-asset',
    archived: false,
    createdAt: ts,
    updatedAt: ts,
  };
}

export function consolidateContinuingCostAccounts(
  accounts: Account[],
  monthlyCostItems: MonthlyCostItem[],
  journalEntries: JournalEntry[],
  cashflowSchedules: CashflowSchedule[],
  reserves: ReserveItem[],
  ts: string,
): ContinuingCostConsolidation {
  const ledgerId = CONTINUOUS_COST_LEDGER_ACCOUNT_ID;
  const oldPerItem = accounts.filter(
    (a) => a.role === 'continuing-cost-asset' && a.id !== ledgerId,
  );
  const oldIds = new Set(oldPerItem.map((a) => a.id));

  const repointedItems = monthlyCostItems
    .filter(
      (m) => m.recognitionCreditAccountId !== undefined && oldIds.has(m.recognitionCreditAccountId),
    )
    .map((m) => ({ ...m, recognitionCreditAccountId: ledgerId }));

  // 付け替え後に集約口座を参照する item があるか（＝集約口座が要るか）。
  const repointedById = new Map(repointedItems.map((m) => [m.id, m]));
  const needLedger = monthlyCostItems.some(
    (m) => (repointedById.get(m.id) ?? m).recognitionCreditAccountId === ledgerId,
  );

  const existingLedger = accounts.find((a) => a.id === ledgerId) ?? null;
  const ledgerAccount = existingLedger ?? (needLedger ? newContinuousCostLedgerAccount(ts) : null);
  const ledgerCreated = existingLedger === null && ledgerAccount !== null;

  // 旧品目別科目が monthlyCostItems 以外（実仕訳/予定CF/取り置き資金）から参照されていないか。
  const referencedOutside = new Set<string>();
  for (const e of journalEntries) for (const l of e.lines) referencedOutside.add(l.accountId);
  for (const s of cashflowSchedules) {
    referencedOutside.add(s.accountId);
    if (s.counterAccountId !== undefined) referencedOutside.add(s.counterAccountId);
  }
  for (const r of reserves) referencedOutside.add(r.reserveAccountId);

  const dropAccountIds: string[] = [];
  const archivedAccounts: Account[] = [];
  for (const a of oldPerItem) {
    if (referencedOutside.has(a.id)) archivedAccounts.push({ ...a, archived: true, updatedAt: ts });
    else dropAccountIds.push(a.id);
  }

  return { ledgerAccount, ledgerCreated, repointedItems, dropAccountIds, archivedAccounts };
}

/** consolidation を LedgerExportPackage に適用する（import 経路）。 */
function applyContinuingCostConsolidation(pkg: LedgerExportPackage): LedgerExportPackage {
  const items = pkg.monthlyCostItems ?? [];
  const c = consolidateContinuingCostAccounts(
    pkg.accounts,
    items,
    pkg.journalEntries,
    pkg.cashflowSchedules ?? [],
    pkg.reserves ?? [],
    nowIso(),
  );
  const repointById = new Map(c.repointedItems.map((m) => [m.id, m]));
  const archivedById = new Map(c.archivedAccounts.map((a) => [a.id, a]));
  const dropSet = new Set(c.dropAccountIds);
  let accounts = pkg.accounts
    .filter((a) => !dropSet.has(a.id))
    .map((a) => archivedById.get(a.id) ?? a);
  if (c.ledgerCreated && c.ledgerAccount) accounts = [...accounts, c.ledgerAccount];
  const monthlyCostItems = items.map((m) => repointById.get(m.id) ?? m);
  return { ...pkg, accounts, monthlyCostItems };
}

/**
 * v14→v15（取り置き資金の聖域化・集約）の共通ロジック。import 経路と既存DB起動経路の両方から使う。
 * 目的別の reserve-asset 科目を単一の集約口座（RESERVE_LEDGER_ACCOUNT_ID）へ寄せる:
 *  - 旧目的別科目を指す ReserveItem.reserveAccountId を集約口座へ付け替える（name は ReserveItem に残る）。
 *  - 旧目的別科目に触れる仕訳（取り置きの振替）を、その口座の ReserveItem の id で `metadata.reserveId`
 *    タグ付けし、口座参照を集約口座へ差し替える（目的別残高がタグ集計で導出できるように）。
 *  - 参照されなくなった旧目的別科目を削除する。
 */
export interface ReserveConsolidation {
  ledgerAccount: Account | null;
  ledgerCreated: boolean;
  repointedReserves: ReserveItem[];
  retaggedEntries: JournalEntry[];
  dropAccountIds: string[];
}

function newReserveLedgerAccount(ts: string): Account {
  return {
    id: RESERVE_LEDGER_ACCOUNT_ID,
    name: RESERVE_LEDGER_ACCOUNT_NAME,
    type: 'asset',
    role: 'reserve-asset',
    archived: false,
    createdAt: ts,
    updatedAt: ts,
  };
}

export function consolidateReserveAccounts(
  accounts: Account[],
  reserves: ReserveItem[],
  journalEntries: JournalEntry[],
  ts: string,
): ReserveConsolidation {
  const ledgerId = RESERVE_LEDGER_ACCOUNT_ID;
  const oldAccts = accounts.filter((a) => a.role === 'reserve-asset' && a.id !== ledgerId);
  const oldIds = new Set(oldAccts.map((a) => a.id));
  // 旧目的別口座 id → その口座を持つ ReserveItem の id（1:1 前提）。
  const acctToReserve = new Map<string, string>();
  for (const r of reserves) {
    if (oldIds.has(r.reserveAccountId)) acctToReserve.set(r.reserveAccountId, r.id);
  }

  const repointedReserves = reserves.map((r) =>
    oldIds.has(r.reserveAccountId) ? { ...r, reserveAccountId: ledgerId } : r,
  );
  const needLedger =
    repointedReserves.some((r) => r.reserveAccountId === ledgerId) || oldAccts.length > 0;
  const existingLedger = accounts.find((a) => a.id === ledgerId) ?? null;
  const ledgerAccount = existingLedger ?? (needLedger ? newReserveLedgerAccount(ts) : null);
  const ledgerCreated = existingLedger === null && ledgerAccount !== null;

  // 旧目的別口座に触れる仕訳を、口座参照を集約口座へ差し替え + reserveId タグ付け。
  const retaggedEntries: JournalEntry[] = [];
  for (const e of journalEntries) {
    const touched = e.lines.find((l) => oldIds.has(l.accountId));
    if (!touched) continue;
    const rid = e.metadata?.reserveId ?? acctToReserve.get(touched.accountId);
    const lines = e.lines.map((l) => (oldIds.has(l.accountId) ? { ...l, accountId: ledgerId } : l));
    retaggedEntries.push({
      ...e,
      lines,
      metadata: rid ? { ...e.metadata, reserveId: rid } : e.metadata,
    });
  }
  // 旧目的別口座は付け替え後に参照されない（仕訳は集約口座へ・ReserveItem も付け替え）→ 削除。
  const dropAccountIds = oldAccts.map((a) => a.id);

  return { ledgerAccount, ledgerCreated, repointedReserves, retaggedEntries, dropAccountIds };
}

/** consolidation を LedgerExportPackage に適用する（import 経路）。 */
function applyReserveConsolidation(pkg: LedgerExportPackage): LedgerExportPackage {
  const c = consolidateReserveAccounts(
    pkg.accounts,
    pkg.reserves ?? [],
    pkg.journalEntries,
    nowIso(),
  );
  const retaggedById = new Map(c.retaggedEntries.map((e) => [e.id, e]));
  const dropSet = new Set(c.dropAccountIds);
  let accounts = pkg.accounts.filter((a) => !dropSet.has(a.id));
  if (c.ledgerCreated && c.ledgerAccount) accounts = [...accounts, c.ledgerAccount];
  const journalEntries = pkg.journalEntries.map((e) => retaggedById.get(e.id) ?? e);
  return { ...pkg, accounts, reserves: c.repointedReserves, journalEntries };
}

// version を上げるたびにここへ追加していく。
const STEPS: Step[] = [
  {
    // v1 → v2: 按分支出(allocations)を追加。v1 JSON には無いので空配列を付ける。
    from: 1,
    to: 2,
    migrate: (pkg) => ({
      ...pkg,
      allocations: Array.isArray(pkg.allocations) ? pkg.allocations : [],
    }),
  },
  {
    // v2 → v3: 予定キャッシュフロー・目的別資金を追加。v2 JSON には無いので空配列を付ける。
    from: 2,
    to: 3,
    migrate: (pkg) => ({
      ...pkg,
      cashflowSchedules: Array.isArray(pkg.cashflowSchedules) ? pkg.cashflowSchedules : [],
      reserves: Array.isArray(pkg.reserves) ? pkg.reserves : [],
    }),
  },
  {
    // v3 → v4: タグを追加。v3 JSON には無いので空配列を付ける。
    from: 3,
    to: 4,
    migrate: (pkg) => ({ ...pkg, tags: Array.isArray(pkg.tags) ? pkg.tags : [] }),
  },
  {
    // v4 → v5: 残高補正(metadata.adjustment)の永続化に伴う版上げ。
    // 既存データの構造は変えない＝恒等移行（version だけ前進させる）。
    from: 4,
    to: 5,
    migrate: (pkg) => pkg,
  },
  {
    // v5 → v6: 勘定科目に role を追加。type・参照集合（按分中資産/目的別資金）から推定する。
    from: 5,
    to: 6,
    migrate: (pkg) => {
      const deferredIds = new Set((pkg.allocations ?? []).map((a) => a.deferredAccountId));
      const reserveIds = new Set((pkg.reserves ?? []).map((r) => r.reserveAccountId));
      const accounts: Account[] = (pkg.accounts ?? []).map((a) => {
        const acc = a as Account & { role?: unknown };
        // 既に role があればそれを尊重（再 migrate の冪等性）。
        if (typeof acc.role === 'string') return acc as Account;
        return { ...acc, role: inferRole(acc as Account, { deferredIds, reserveIds }) } as Account;
      });
      return { ...pkg, accounts };
    },
  },
  {
    // v6 → v7: 月額化コストを追加。既存按分(allocations)から移行生成する。
    // 既存 allocations と生成済み仕訳は消さない（履歴保持）。
    from: 6,
    to: 7,
    migrate: (pkg) => {
      const existing = Array.isArray(pkg.monthlyCostItems) ? pkg.monthlyCostItems : [];
      // 再 migrate の冪等性: 既にあればそのまま、無ければ allocations から作る。
      const monthlyCostItems =
        existing.length > 0 ? existing : monthlyCostItemsFromAllocations(pkg.allocations ?? []);
      return { ...pkg, monthlyCostItems };
    },
  },
  {
    // v7 → v8: 資金目標(fundingGoals)を追加。既存 JSON には無いので空配列を補う。
    // ReserveItem は targetDate を持たないため自動移行はせず、既存データは保持する。
    from: 7,
    to: 8,
    migrate: (pkg) => ({
      ...pkg,
      fundingGoals: Array.isArray(pkg.fundingGoals) ? pkg.fundingGoals : [],
    }),
  },
  {
    // v8 → v9: 予定CF direction に transfer を追加（許容値拡張）。既存データは
    // transfer を含まないため構造変更なし＝恒等移行（version だけ前進させる）。
    from: 8,
    to: 9,
    migrate: (pkg) => pkg,
  },
  {
    // v9 → v10: AccountRole に fixed-asset、MonthlyCostItem に任意フィールドを追加（拡張のみ）。
    // 既存データはこれらを含まないため構造変更なし＝恒等移行。
    from: 9,
    to: 10,
    migrate: (pkg) => pkg,
  },
  {
    // v10 → v11: 管理区分(managementScopes)・支払い手段(accountInstruments)を追加。
    // 仕訳/予定CF/月額化に managementScopeId を付与（既存は『個人用』へ寄せる）。
    // タグを「仕訳全体のみ」に再設計: 明細タグ(line.tagIds / 予定CFの明細タグ)を破棄し、tag.scope を entry に固定。
    from: 10,
    to: 11,
    migrate: (pkg) => {
      const ts = pkg.exportedAt;
      const raw = pkg as LedgerExportPackage & {
        managementScopes?: ManagementScope[];
        accountInstruments?: unknown[];
      };
      const existingScopes = Array.isArray(raw.managementScopes) ? raw.managementScopes : [];
      const managementScopes: ManagementScope[] =
        existingScopes.length > 0
          ? existingScopes
          : [
              {
                id: DEFAULT_MANAGEMENT_SCOPE_ID,
                name: DEFAULT_MANAGEMENT_SCOPE_NAME,
                archived: false,
                createdAt: ts,
                updatedAt: ts,
              },
            ];
      const accountInstruments = Array.isArray(raw.accountInstruments)
        ? raw.accountInstruments
        : [];
      const scopeId = managementScopes[0]?.id ?? DEFAULT_MANAGEMENT_SCOPE_ID;
      const withScope = <T extends { managementScopeId?: string }>(x: T): T => ({
        ...x,
        managementScopeId: x.managementScopeId ?? scopeId,
      });
      // 明細タグ（JournalLine.tagIds）を破棄してクリーンな行に作り直す（タグは仕訳全体のみ）。
      const cleanLine = (l: JournalLine): JournalLine => {
        const line: JournalLine = { accountId: l.accountId, side: l.side, amount: l.amount };
        if (l.instrumentId !== undefined) line.instrumentId = l.instrumentId;
        return line;
      };
      const journalEntries = pkg.journalEntries.map((e) => ({
        ...withScope(e),
        lines: e.lines.map(cleanLine),
      }));
      const cashflowSchedules = pkg.cashflowSchedules.map((s) => {
        const copy = { ...s } as Record<string, unknown>;
        delete copy.accountLineTagIds; // 予定CFの明細タグを破棄。
        delete copy.counterLineTagIds;
        return withScope(copy as unknown as CashflowSchedule);
      });
      const monthlyCostItems = pkg.monthlyCostItems.map(withScope);
      const tags = pkg.tags.map((t) => ({ ...t, scope: 'entry' as const }));
      return {
        ...pkg,
        managementScopes,
        accountInstruments,
        journalEntries,
        cashflowSchedules,
        monthlyCostItems,
        tags,
      };
    },
  },
  {
    // v11 → v12: 固定資産の売却・故障処分(assetDisposals)を追加。既存 JSON には無いので空配列を補う。
    from: 11,
    to: 12,
    migrate: (pkg) => ({
      ...pkg,
      assetDisposals: Array.isArray(pkg.assetDisposals) ? pkg.assetDisposals : [],
    }),
  },
  {
    // v12 → v13: 継続コストを資産経由モデルへ統一（AccountRole に continuing-cost-asset、
    // MonthlyCostItem に任意 paymentSourceAccountId、EntryMetadata に continuousCostId/ccKind/virtual）。
    // **破壊的（未実運用前提）**: 旧モデルの継続コスト/按分の生成物をクリアし、新モデルへ一本化する。
    // これをしないと、集計が derivedEntries 前提に変わったため旧データが整合しない
    // （旧 paymentAccountId 由来は実支払い月に全額費用化、旧固定資産由来は認識されない）。
    // 生成仕訳（monthlyCostId / allocationId / allocationRole / assetDisposalId）と
    // monthlyCostItems / allocations / assetDisposals を落とす（手入力の通常仕訳・科目は残す）。
    from: 12,
    to: 13,
    migrate: (pkg) => {
      const journalEntries = pkg.journalEntries.filter((e) => {
        const m = e.metadata;
        return !m?.monthlyCostId && !m?.allocationId && !m?.allocationRole && !m?.assetDisposalId;
      });
      const cashflowSchedules = (pkg.cashflowSchedules ?? []).filter((s) => !s.monthlyCostId);
      return {
        ...pkg,
        journalEntries,
        cashflowSchedules,
        monthlyCostItems: [],
        allocations: [],
        assetDisposals: [],
      };
    },
  },
  {
    // v13 → v14: 勘定科目の聖域化。品目別の continuing-cost-asset 科目を単一の集約台帳口座へ寄せ、
    // 旧品目別科目を指す MonthlyCostItem を集約口座へ付け替え、参照されなくなった旧科目を削除する。
    from: 13,
    to: 14,
    migrate: applyContinuingCostConsolidation,
  },
  {
    // v14 → v15: 取り置き資金の聖域化・集約。目的別の reserve-asset 科目を単一の集約口座へ寄せ、
    // ReserveItem.reserveAccountId を付け替え、取り置き振替に reserveId を付与、旧科目を削除する。
    from: 14,
    to: 15,
    migrate: applyReserveConsolidation,
  },
];

/**
 * 取り込んだパッケージを現行スキーマまで前進させる。
 * 現行より新しい版は取り込まない（fail-closed）。
 */
export function migrateToCurrent(pkg: LedgerExportPackage): MigrationResult {
  let version = pkg.schemaVersion;

  if (version === SCHEMA_VERSION) return { ok: true, data: pkg };

  if (version > SCHEMA_VERSION) {
    return {
      ok: false,
      reason: 'too-new',
      detail: `このアプリ(スキーマ v${SCHEMA_VERSION})より新しい v${version} のデータです。アプリを更新してください。`,
    };
  }

  let current = pkg;
  // 古い版 → 現行まで、登録済みステップを辿る。
  // 無限ループ防止のため版が必ず前進することを確認する。
  const guard = SCHEMA_VERSION + 1;
  for (let i = 0; i < guard && version < SCHEMA_VERSION; i++) {
    const step = STEPS.find((s) => s.from === version);
    if (!step) {
      return {
        ok: false,
        reason: 'unknown-version',
        detail: `v${version} から現行へ更新する手順が見つかりません。`,
      };
    }
    try {
      current = step.migrate(current);
    } catch (e) {
      return {
        ok: false,
        reason: 'migration-failed',
        detail: e instanceof Error ? e.message : String(e),
      };
    }
    if (step.to <= version) {
      return { ok: false, reason: 'migration-failed', detail: 'migration が前進しませんでした。' };
    }
    version = step.to;
    current = { ...current, schemaVersion: version };
  }

  if (version !== SCHEMA_VERSION) {
    return { ok: false, reason: 'unknown-version', detail: `v${version} で停止しました。` };
  }
  return { ok: true, data: current };
}
