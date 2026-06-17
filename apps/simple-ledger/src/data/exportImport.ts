/*
 * JSON export / import。端末間共有・バックアップの公式交換形式。
 *
 * import の不変条件（fail-closed）は foundation の createImportPipeline に委譲する:
 *  1. Zod で検証する。
 *  2. schemaVersion を確認し、未対応版は取り込まない（migration チェーンの入口を通す）。
 *  3. import 前に必ずスナップショットを作る。
 *  4. 検証・置換が成功するまで既存 DB を壊さない（置換は単一トランザクションで原子的）。
 *  5. revision 不一致は自動上書きせず、呼び出し側の確認（force）を求める。MVP は自動マージしない。
 *
 * v2 の封筒は APP_ID('snishi-code.simple-ledger-v2') + SCHEMA_VERSION=1。
 * migration チェーンは**空**（v2 は最新モデルを版 1 として開始・レガシー migration なし・仕様§16）。
 * 版 1 以外（v1 の 16 や未来版）は unsupported-version で fail-closed に拒否される。
 * revision は foundation 封筒の `revision` フィールドに repository の meta.revision を載せて運ぶ。
 */
import { createImportPipeline } from '@snishi/foundation/exchange/importPipeline';
import { createMigrationChain } from '@snishi/foundation/exchange/migrations';
import { buildExportText, buildExportFileName } from '@snishi/foundation/exchange/export';
import { APP_ID, SCHEMA_VERSION } from '../domain/constants';
import { ledgerExportPackageSchema } from '../domain/schema';
import type { Ledger, LedgerExportPackage } from '../domain/types';
import { loadLedger, makeSnapshotId, replaceLedger, saveSnapshot } from './repository';
import { nowIso } from '../util/time';

/**
 * migration チェーン（空）。v2 に旧版は存在しないため step を持たない。
 * 互換性のない変更で SCHEMA_VERSION を上げるときに step を足す。
 * 空チェーンでは「現行版以外＝missing-step / too-new」となり fail-closed。
 */
const migrationChain = createMigrationChain<unknown>([]);

/** 現在の台帳から交換用パッケージを作る。 */
export function buildExportPackage(ledger: Ledger): LedgerExportPackage {
  return {
    appId: APP_ID,
    schemaVersion: SCHEMA_VERSION,
    ledgerId: ledger.meta.id,
    exportedAt: nowIso(),
    deviceId: ledger.meta.deviceId,
    // foundation 封筒の revision（楽観的衝突検出）。export 時点の編集リビジョン。
    revision: ledger.meta.revision,
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
  return buildExportText(buildExportPackage(ledger));
}

/** ダウンロード用ファイル名（端末ローカル生成・外部送信なし）。 */
export function exportFileName(ledger: Ledger): string {
  return buildExportFileName(ledger.settings.ledgerName);
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
  | { kind: 'unsupported-version'; detail: string }
  | { kind: 'validation-error'; detail: string }
  | {
      kind: 'revision-conflict';
      detail: string;
      localRevision: number;
      importRevision: number;
    }
  | { kind: 'storage-error'; detail: string };

/** zod 検証を pipeline の validate 形に包む（先頭 issue の path + message を detail にする）。 */
function validatePackage(
  data: unknown,
): { ok: true; pkg: LedgerExportPackage } | { ok: false; detail: string } {
  const validated = ledgerExportPackageSchema.safeParse(data);
  if (!validated.success) {
    const first = validated.error.issues[0];
    const where = first?.path.join('.') ?? '';
    return { ok: false, detail: `${where ? where + ': ' : ''}${first?.message ?? '形式が不正です。'}` };
  }
  return { ok: true, pkg: validated.data };
}

/** 検証済みパッケージで台帳全体を原子置換する（meta.revision は封筒の revision に合わせる）。 */
async function replaceWithPackage(pkg: LedgerExportPackage, current: Ledger): Promise<void> {
  await replaceLedger({
    meta: {
      ...current.meta,
      schemaVersion: SCHEMA_VERSION,
      revision: pkg.revision,
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
}

/**
 * JSON テキストを取り込む。opts.force=true で revision 不一致を上書き承認。
 * 7 段階 fail-closed（parse → 封筒 → migration → 完全検証 → revision → 前スナップショット → 原子置換）
 * は foundation の pipeline が実施し、既存データは「ok を返す直前の置換」まで一切変更しない。
 */
export async function importFromJsonText(
  rawText: string,
  opts: { force?: boolean } = {},
): Promise<ImportOutcome> {
  // pipeline はステートレスだが、snapshotBefore で採番した id を ok 結果へ載せるため
  // 呼び出しごとに closure で組み立てる。
  let snapshotId = '';
  let current: Ledger | null = null;
  const pipeline = createImportPipeline<LedgerExportPackage>({
    appId: APP_ID,
    currentSchemaVersion: SCHEMA_VERSION,
    migrate: (data, fromVersion) => migrationChain.migrateToVersion(data, fromVersion, SCHEMA_VERSION),
    validate: validatePackage,
    getCurrentRevision: async () => (await loadLedger()).meta.revision,
    // 置換前スナップショット（既存状態を保存してから置換）。throw したら置換に進まない。
    snapshotBefore: async () => {
      current = await loadLedger();
      snapshotId = makeSnapshotId();
      await saveSnapshot({
        id: snapshotId,
        createdAt: nowIso(),
        reason: 'import前',
        data: buildExportPackage(current),
      });
    },
    // 原子置換（repository.replaceLedger = runWrite で全 store を 1 トランザクション置換）。
    replaceAll: async (pkg) => {
      // snapshotBefore が先に成功している（pipeline の順序保証）ため current は必ずある。
      if (!current) current = await loadLedger();
      await replaceWithPackage(pkg, current);
    },
  });

  const outcome = await pipeline.importFromJsonText(rawText, opts);
  if (outcome.kind !== 'ok') return outcome;
  const ledger = await loadLedger();
  return {
    kind: 'ok',
    ledger,
    snapshotId,
    counts: { accounts: outcome.pkg.accounts.length, entries: outcome.pkg.journalEntries.length },
  };
}

/**
 * スナップショットを現行スキーマへ前進させ、完全検証して返す（fail-closed）。
 * import と同じ不変条件（migration チェーン → Zod）を復元にも適用し、古い/壊れた
 * スナップショットを黙って取り込まないようにする。違反は Error。
 */
function migrateAndValidateSnapshot(snapshotData: LedgerExportPackage): LedgerExportPackage {
  let candidate: unknown = snapshotData;
  if (snapshotData.schemaVersion !== SCHEMA_VERSION) {
    const result = migrationChain.migrateToVersion(
      snapshotData,
      snapshotData.schemaVersion,
      SCHEMA_VERSION,
    );
    if (!result.ok) {
      throw new Error(`スナップショットを現行スキーマへ更新できません: ${result.reason}`);
    }
    candidate = result.data;
  }
  const validated = validatePackage(candidate);
  if (!validated.ok) {
    throw new Error(`スナップショットの形式が不正です: ${validated.detail}`);
  }
  return validated.pkg;
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
  const validated = validatePackage(sample);
  if (!validated.ok) {
    throw new Error(`サンプルデータの形式が不正です: ${validated.detail}`);
  }
  const pkg = validated.pkg;
  const current = await loadLedger();
  await replaceWithPackage(pkg, current);
  return loadLedger();
}
