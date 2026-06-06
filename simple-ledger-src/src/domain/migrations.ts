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
import { SCHEMA_VERSION } from './constants';
import type { LedgerExportPackage } from './types';

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
