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
  DEFAULT_MANAGEMENT_SCOPE_ID,
  DEFAULT_MANAGEMENT_SCOPE_NAME,
  SCHEMA_VERSION,
} from './constants';
import { inferRole } from './accountRoles';
import { monthlyCostItemsFromAllocations } from './monthlyCostMigration';
import type {
  Account,
  CashflowSchedule,
  JournalLine,
  LedgerExportPackage,
  ManagementScope,
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
    // v12 → v13: 継続コストを資産経由モデルへ統一。AccountRole に continuing-cost-asset、
    // MonthlyCostItem に任意 paymentSourceAccountId、EntryMetadata に continuousCostId/ccKind/virtual
    // を追加（許容値・任意項目の拡張のみ）。既存データの構造は変えない＝恒等移行（version だけ前進）。
    // 仮想仕訳は保存しない導出専用のため、移行で生成・変換するものはない。
    from: 12,
    to: 13,
    migrate: (pkg) => pkg,
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
