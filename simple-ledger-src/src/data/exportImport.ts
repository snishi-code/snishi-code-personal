/*
 * JSON export / import。端末間共有・バックアップの公式交換形式。
 *
 * import の不変条件（CLAUDE.md 憲法・fail-closed）:
 *  1. Zod で検証する。
 *  2. schemaVersion を確認し、未対応版は取り込まない（migration 入口を通す）。
 *  3. import 前に必ずスナップショットを作る。
 *  4. 検証・置換が成功するまで既存 DB を壊さない（置換は単一トランザクションで原子的）。
 *  5. revision 不一致は自動上書きせず、呼び出し側の確認（force）を求める。MVP は自動マージしない。
 */
import { APP_ID, SCHEMA_VERSION } from '../domain/constants';
import { ledgerExportPackageSchema } from '../domain/schema';
import { migrateToCurrent } from '../domain/migrations';
import type { Ledger, LedgerExportPackage } from '../domain/types';
import { z } from 'zod';
import { loadLedger, makeSnapshotId, replaceLedger, saveSnapshot } from './repository';
import { nowIso } from '../util/time';

/** 現在の台帳から交換用パッケージを作る。 */
export function buildExportPackage(ledger: Ledger): LedgerExportPackage {
  return {
    appId: APP_ID,
    schemaVersion: SCHEMA_VERSION,
    ledgerId: ledger.meta.id,
    exportedAt: nowIso(),
    deviceId: ledger.meta.deviceId,
    baseRevision: ledger.meta.revision,
    currentRevision: ledger.meta.revision,
    accounts: ledger.accounts,
    journalEntries: ledger.journalEntries,
    allocations: ledger.allocations,
    cashflowSchedules: ledger.cashflowSchedules,
    reserves: ledger.reserves,
    tags: ledger.tags,
    settings: ledger.settings,
  };
}

/** export を整形 JSON 文字列にする。 */
export function exportToJsonText(ledger: Ledger): string {
  return JSON.stringify(buildExportPackage(ledger), null, 2);
}

/** ダウンロード用ファイル名（端末ローカル生成・外部送信なし）。 */
export function exportFileName(ledger: Ledger): string {
  const stamp = nowIso().replace(/[:.]/g, '-');
  const safe = ledger.settings.ledgerName.replace(/[^\p{L}\p{N}_-]/gu, '') || 'ledger';
  return `${safe}_${stamp}.json`;
}

export type ImportOutcome =
  | {
      kind: 'ok';
      ledger: Ledger;
      snapshotId: string;
      counts: { accounts: number; entries: number };
    }
  | { kind: 'parse-error'; detail: string }
  | { kind: 'not-our-file'; detail: string }
  | { kind: 'validation-error'; detail: string }
  | {
      kind: 'unsupported-version';
      reason: 'too-new' | 'unknown-version' | 'migration-failed';
      detail: string;
    }
  | {
      kind: 'revision-conflict';
      localRevision: number;
      baseRevision: number;
      currentRevision: number;
    };

const envelopeSchema = z.object({
  appId: z.string(),
  schemaVersion: z.number().int().positive(),
});

/**
 * JSON テキストを取り込む。opts.force=true で revision 不一致を上書き承認。
 * 既存データは「ok を返す直前の置換」まで一切変更しない。
 */
export async function importFromJsonText(
  rawText: string,
  opts: { force?: boolean } = {},
): Promise<ImportOutcome> {
  // 1. パース
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawText);
  } catch (e) {
    return { kind: 'parse-error', detail: e instanceof Error ? e.message : String(e) };
  }

  // 2. 封筒（appId / version）の確認
  const env = envelopeSchema.safeParse(parsed);
  if (!env.success) {
    return {
      kind: 'validation-error',
      detail: '必要なフィールド(appId / schemaVersion)がありません。',
    };
  }
  if (env.data.appId !== APP_ID) {
    return {
      kind: 'not-our-file',
      detail: `このアプリのファイルではありません（appId=${env.data.appId}）。`,
    };
  }

  // 3. migration（必要なら現行版へ前進。未対応版は fail-closed）
  let candidate: unknown = parsed;
  if (env.data.schemaVersion !== SCHEMA_VERSION) {
    const result = migrateToCurrent(parsed as LedgerExportPackage);
    if (!result.ok || !result.data) {
      return {
        kind: 'unsupported-version',
        reason: result.reason ?? 'unknown-version',
        detail: result.detail ?? '未対応のスキーマ版です。',
      };
    }
    candidate = result.data;
  }

  // 4. 完全検証（現行スキーマ）
  const validated = ledgerExportPackageSchema.safeParse(candidate);
  if (!validated.success) {
    const first = validated.error.issues[0];
    const where = first?.path.join('.') ?? '';
    return {
      kind: 'validation-error',
      detail: `${where ? where + ': ' : ''}${first?.message ?? '形式が不正です。'}`,
    };
  }
  const pkg = validated.data;

  // 5. revision 不一致チェック（自動上書きしない）
  const current = await loadLedger();
  if (!opts.force && current.meta.revision !== pkg.baseRevision) {
    return {
      kind: 'revision-conflict',
      localRevision: current.meta.revision,
      baseRevision: pkg.baseRevision,
      currentRevision: pkg.currentRevision,
    };
  }

  // 6. import 前スナップショット（既存状態を保存してから置換）
  const snapshotId = makeSnapshotId();
  await saveSnapshot({
    id: snapshotId,
    createdAt: nowIso(),
    reason: 'import前',
    data: buildExportPackage(current),
  });

  // 7. 原子的に置換（ここで初めて既存を更新する）
  await replaceLedger({
    meta: {
      ...current.meta,
      schemaVersion: SCHEMA_VERSION,
      revision: pkg.currentRevision,
      updatedAt: nowIso(),
    },
    settings: pkg.settings,
    accounts: pkg.accounts,
    journalEntries: pkg.journalEntries,
    allocations: pkg.allocations,
    cashflowSchedules: pkg.cashflowSchedules,
    reserves: pkg.reserves,
    tags: pkg.tags,
  });

  const ledger = await loadLedger();
  return {
    kind: 'ok',
    ledger,
    snapshotId,
    counts: { accounts: pkg.accounts.length, entries: pkg.journalEntries.length },
  };
}

/** スナップショットから台帳を復元する（現状を上書き）。復元前に現状の保険スナップショットを取る。 */
export async function restoreFromSnapshot(snapshotData: LedgerExportPackage): Promise<Ledger> {
  const current = await loadLedger();
  await saveSnapshot({
    id: makeSnapshotId(),
    createdAt: nowIso(),
    reason: '復元前',
    data: buildExportPackage(current),
  });
  await replaceLedger({
    meta: {
      ...current.meta,
      schemaVersion: SCHEMA_VERSION,
      revision: current.meta.revision + 1,
      updatedAt: nowIso(),
    },
    settings: snapshotData.settings,
    accounts: snapshotData.accounts,
    journalEntries: snapshotData.journalEntries,
    allocations: snapshotData.allocations,
    cashflowSchedules: snapshotData.cashflowSchedules,
    reserves: snapshotData.reserves,
    tags: snapshotData.tags,
  });
  return loadLedger();
}
