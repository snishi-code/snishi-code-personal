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
    managementScopes: ledger.managementScopes,
    accountInstruments: ledger.accountInstruments,
    accounts: ledger.accounts,
    journalEntries: ledger.journalEntries,
    allocations: ledger.allocations,
    cashflowSchedules: ledger.cashflowSchedules,
    reserves: ledger.reserves,
    tags: ledger.tags,
    monthlyCostItems: ledger.monthlyCostItems,
    assetDisposals: ledger.assetDisposals,
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
    managementScopes: pkg.managementScopes,
    accountInstruments: pkg.accountInstruments,
    accounts: pkg.accounts,
    journalEntries: pkg.journalEntries,
    allocations: pkg.allocations,
    cashflowSchedules: pkg.cashflowSchedules,
    reserves: pkg.reserves,
    tags: pkg.tags,
    monthlyCostItems: pkg.monthlyCostItems,
    assetDisposals: pkg.assetDisposals,
  });

  const ledger = await loadLedger();
  return {
    kind: 'ok',
    ledger,
    snapshotId,
    counts: { accounts: pkg.accounts.length, entries: pkg.journalEntries.length },
  };
}

/**
 * スナップショットを現行スキーマへ前進させ、完全検証して返す（fail-closed）。
 * import と同じ不変条件（migration → Zod）を復元にも適用し、古い/壊れた
 * スナップショットを黙って取り込まないようにする。違反は Error。
 */
function migrateAndValidateSnapshot(snapshotData: LedgerExportPackage): LedgerExportPackage {
  let candidate: unknown = snapshotData;
  if (snapshotData.schemaVersion !== SCHEMA_VERSION) {
    const result = migrateToCurrent(snapshotData);
    if (!result.ok || !result.data) {
      throw new Error(
        `スナップショットを現行スキーマへ更新できません: ${result.detail ?? '未対応の版です。'}`,
      );
    }
    candidate = result.data;
  }
  const validated = ledgerExportPackageSchema.safeParse(candidate);
  if (!validated.success) {
    const first = validated.error.issues[0];
    const where = first?.path.join('.') ?? '';
    throw new Error(
      `スナップショットの形式が不正です: ${where ? where + ': ' : ''}${first?.message ?? ''}`,
    );
  }
  return validated.data;
}

/**
 * スナップショットから台帳を復元する（現状を上書き）。復元前に現状の保険スナップショットを取る。
 * import 同様に migration + Zod 検証を通し、検証成功まで既存 DB を壊さない（fail-closed）。
 */
export async function restoreFromSnapshot(snapshotData: LedgerExportPackage): Promise<Ledger> {
  // 先に検証する（失敗時は既存データを一切変更しない）。
  const pkg = migrateAndValidateSnapshot(snapshotData);
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
    settings: pkg.settings,
    managementScopes: pkg.managementScopes,
    accountInstruments: pkg.accountInstruments,
    accounts: pkg.accounts,
    journalEntries: pkg.journalEntries,
    allocations: pkg.allocations,
    cashflowSchedules: pkg.cashflowSchedules,
    reserves: pkg.reserves,
    tags: pkg.tags,
    monthlyCostItems: pkg.monthlyCostItems,
    assetDisposals: pkg.assetDisposals,
  });
  return loadLedger();
}

/**
 * 手動テスト用フィクスチャ（sample.json）を読み込む（`?fixture=sample` 用）。
 *  - import と同じく `ledgerExportPackageSchema` で検証する（fail-closed）。
 *  - 外部送信なし: sample.json はバンドルから動的 import する（fetch しない＝main チャンクにも載せない）。
 *  - 呼び出し側が「空DBのときだけ」呼ぶこと（既存ユーザーデータを上書きしない）。
 *  - 読み込み後は通常の IndexedDB 正本として扱う。
 */
export async function loadSampleFixture(): Promise<Ledger> {
  const { default: sample } = await import('./sample.json');
  const validated = ledgerExportPackageSchema.safeParse(sample);
  if (!validated.success) {
    const first = validated.error.issues[0];
    const where = first?.path.join('.') ?? '';
    throw new Error(
      `サンプルデータの形式が不正です: ${where ? where + ': ' : ''}${first?.message ?? ''}`,
    );
  }
  const pkg = validated.data;
  const current = await loadLedger();
  await replaceLedger({
    meta: {
      ...current.meta,
      schemaVersion: SCHEMA_VERSION,
      revision: pkg.currentRevision,
      updatedAt: nowIso(),
    },
    settings: pkg.settings,
    managementScopes: pkg.managementScopes,
    accountInstruments: pkg.accountInstruments,
    accounts: pkg.accounts,
    journalEntries: pkg.journalEntries,
    allocations: pkg.allocations,
    cashflowSchedules: pkg.cashflowSchedules,
    reserves: pkg.reserves,
    tags: pkg.tags,
    monthlyCostItems: pkg.monthlyCostItems,
    assetDisposals: pkg.assetDisposals,
  });
  return loadLedger();
}
