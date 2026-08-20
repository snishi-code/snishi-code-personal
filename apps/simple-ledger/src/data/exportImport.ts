/*
 * JSON export / import。端末間共有・バックアップの公式交換形式。
 *
 * import の不変条件（fail-closed）は foundation の createImportPipeline に委譲する:
 *  1. Zod で検証する。
 *  2. schemaVersion を確認し、未対応版は取り込まない（migration チェーンの入口を通す）。
 *  3. import 前に必ずスナップショットを作る。
 *  4. 検証・置換が成功するまで既存 DB を壊さない（置換は単一トランザクションで原子的）。
 *  5. 取り込みは**空の台帳（取引データなし）だけ**が受け付ける（v13.9 項目 1）。既存台帳の
 *     上書き置換（旧・強制 import）は撤去した。マージはしない。
 *
 * v2 の封筒は APP_ID('snishi-code.simple-ledger-v2') + SCHEMA_VERSION（現行値は
 * src/domain/constants.ts が正本）。
 * migration チェーンは**空**（後方互換をコードで持たない作者決定。旧版が読みたければ
 * 単発変換で対応する）。現行版以外（版 1・v1 の 16・未来版）は unsupported-version で
 * fail-closed に拒否される。
 * revision は foundation 封筒の `revision` フィールドに repository の meta.revision を載せて運ぶ。
 */
import { createImportPipeline } from '@snishi/foundation/exchange/importPipeline';
import { createMigrationChain } from '@snishi/foundation/exchange/migrations';
import { buildExportText, buildExportFileName } from '@snishi/foundation/exchange/export';
import { APP_ID, SCHEMA_VERSION } from '../domain/constants';
import { ledgerExportPackageSchema } from '../domain/schema';
import type { Ledger, LedgerExportPackage } from '../domain/types';
import {
  loadLedger,
  makeSnapshotId,
  replaceLedger,
  saveSnapshot,
  type LedgerVersion,
} from './repository';
import { nowIso } from '../util/time';

/**
 * migration チェーン（空）。後方互換をコードで持たない（作者決定）。
 * 版上げしても step は足さず、旧版は unsupported-version で明確に拒否する。
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
    accounts: ledger.accounts,
    journalEntries: ledger.journalEntries,
    monthlyCostItems: ledger.monthlyCostItems,
    recurringRules: ledger.recurringRules,
    settings: ledger.settings,
  };
}

/**
 * export を整形 JSON 文字列にする。書き出す前に必ず現行 schema を通す（fail-closed・監査 P1-4）。
 * ここで失敗する状態はどこかの保存境界の欠陥なので、「現行版を名乗る復元不能 JSON」を
 * 黙って作るより明示して止める（スナップショットは安全網なので対象外・復元時に検証する）。
 */
export function exportToJsonText(ledger: Ledger): string {
  const validated = validatePackage(buildExportPackage(ledger));
  if (!validated.ok) {
    throw new Error(`エクスポートが現行スキーマの検証を通りません: ${validated.detail}`);
  }
  return buildExportText(validated.pkg);
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
  | { kind: 'storage-error'; detail: string };

/**
 * 取り込みを受け付ける「空の台帳」= 取引データ（仕訳・持ち物・定期ルール）が無いこと
 * （v13.9 項目 1・作者決定）。科目や設定だけの変更は取り込みを妨げない（どのみち置換される
 * うえ、失われる取引が無い）。UI の出し分けと durable 境界（下の importFromJsonText）が
 * 同じ判定を共有する。
 */
export function isImportableEmptyLedger(
  ledger: Pick<Ledger, 'journalEntries' | 'monthlyCostItems' | 'recurringRules'>,
): boolean {
  return (
    ledger.journalEntries.length === 0 &&
    ledger.monthlyCostItems.length === 0 &&
    ledger.recurringRules.length === 0
  );
}

/** zod 検証を pipeline の validate 形に包む（先頭 issue の path + message を detail にする）。 */
function validatePackage(
  data: unknown,
): { ok: true; pkg: LedgerExportPackage } | { ok: false; detail: string } {
  const validated = ledgerExportPackageSchema.safeParse(data);
  if (!validated.success) {
    const first = validated.error.issues[0];
    const where = first?.path.join('.') ?? '';
    return {
      ok: false,
      detail: `${where ? where + ': ' : ''}${first?.message ?? '形式が不正です。'}`,
    };
  }
  return { ok: true, pkg: validated.data };
}

/**
 * 検証済みパッケージで台帳全体を原子置換する。
 * revision は置換 transaction 内で「DB 現在値と封筒の大きい方 + 1」へ必ず進める。
 * snapshot 作成時の revision を expectedRevision として固定し、その後に別タブが書いていれば
 * 全置換を abort する（再監査 P1 対応）。
 *
 * 封筒の revision をそのまま据えると、別タブが import 前の revision と同じ値を見て
 * CAS を通過し、古い画面のデータを新しい台帳へ書き込めてしまう。復元（restoreFromSnapshot）が
 * current.revision + 1 へ進めるのと同じ規則。以後の import は封筒 revision と一致しなくなるが、
 * それは「置換後の台帳はその封筒より新しい」という事実どおり（revision-conflict → force で通す）。
 */
function versionOf(ledger: Ledger): LedgerVersion {
  return { deviceId: ledger.meta.deviceId, revision: ledger.meta.revision };
}

async function replaceWithPackage(
  pkg: LedgerExportPackage,
  current: Ledger,
  expectedVersion: LedgerVersion = versionOf(current),
): Promise<void> {
  await replaceLedger(
    {
      meta: {
        ...current.meta,
        schemaVersion: SCHEMA_VERSION,
        // replaceLedger が DB 現在値との max + 1 を採番するため、ここでは封筒値を floor として渡す。
        revision: pkg.revision,
        updatedAt: nowIso(),
      },
      settings: pkg.settings,
      accounts: pkg.accounts,
      journalEntries: pkg.journalEntries,
      monthlyCostItems: pkg.monthlyCostItems,
      recurringRules: pkg.recurringRules,
    },
    expectedVersion,
  );
}

/**
 * JSON テキストを取り込む（**空の台帳への取り込み専用**・v13.9 項目 1）。
 *
 * 旧「強制 import（revision 不一致を force で上書きして既存台帳を置換する取り込み）」は
 * 機能ごと撤去した。取り込みは「全削除 → 空台帳へ読み込み」に一本化され、revision の
 * 世代比較は意味を持たない（空台帳と封筒の revision は必ず食い違う）ため、封筒 revision は
 * 置換時の採番 floor としてだけ使う。空でない台帳への取り込みは snapshotBefore で
 * fail-closed に拒否する（UI の出し分けをすり抜けた経路も止める）。
 * 段階は parse → 封筒 → migration → 完全検証 → 前スナップショット（+ 空判定）→ 原子置換で、
 * 既存データは「ok を返す直前の置換」まで一切変更しない。置換の CAS（スナップショット時点の
 * 版）が並行書き込みとの競合を守る。
 */
export async function importFromJsonText(rawText: string): Promise<ImportOutcome> {
  // pipeline はステートレスだが、snapshotBefore で採番した id を ok 結果へ載せるため
  // 呼び出しごとに closure で組み立てる。
  let snapshotId = '';
  let current: Ledger | null = null;
  let expectedVersion: LedgerVersion | null = null;
  const pipeline = createImportPipeline<LedgerExportPackage>({
    appId: APP_ID,
    currentSchemaVersion: SCHEMA_VERSION,
    migrate: (data, fromVersion) =>
      migrationChain.migrateToVersion(data, fromVersion, SCHEMA_VERSION),
    validate: validatePackage,
    // revision 追跡は使わない（null = pipeline の衝突チェックをスキップ。上の doc コメント）。
    getCurrentRevision: async () => null,
    // 置換前スナップショット（既存状態を保存してから置換）。throw したら置換に進まない。
    snapshotBefore: async () => {
      const snapshotCurrent = await loadLedger();
      // 空台帳ゲート（durable 境界）: 取引データを持つ台帳は置換しない。
      if (!isImportableEmptyLedger(snapshotCurrent)) {
        throw new Error('error.import.requiresEmpty');
      }
      const snapshotVersion = versionOf(snapshotCurrent);
      current = snapshotCurrent;
      expectedVersion = snapshotVersion;
      snapshotId = makeSnapshotId();
      await saveSnapshot(
        {
          id: snapshotId,
          createdAt: nowIso(),
          // 理由コード（表示は i18n が訳す）。生文言を保存しない（v11・指示書v3 §A-5）。
          reason: 'import',
          data: buildExportPackage(current),
        },
        snapshotVersion,
      );
    },
    // 原子置換（repository.replaceLedger = runWrite で全 store を 1 トランザクション置換）。
    replaceAll: async (pkg) => {
      // snapshotBefore が先に成功している（pipeline の順序保証）ため current は必ずある。
      if (!current || !expectedVersion) throw new Error('import snapshot is missing');
      await replaceWithPackage(pkg, current, expectedVersion);
    },
  });

  const outcome = await pipeline.importFromJsonText(rawText);
  // getCurrentRevision が null を返すため revision-conflict は発生しない（型合わせの網羅分岐）。
  if (outcome.kind === 'revision-conflict') {
    return { kind: 'storage-error', detail: outcome.detail };
  }
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
  await saveSnapshot(
    {
      id: makeSnapshotId(),
      createdAt: nowIso(),
      reason: 'restore',
      data: buildExportPackage(current),
    },
    versionOf(current),
  );
  await replaceLedger(
    {
      meta: {
        ...current.meta,
        schemaVersion: SCHEMA_VERSION,
        // 復元は封筒の世代を採用せず、現在のローカル世代を floor にして +1 する。
        revision: current.meta.revision,
        updatedAt: nowIso(),
      },
      settings: pkg.settings,
      accounts: pkg.accounts,
      journalEntries: pkg.journalEntries,
      monthlyCostItems: pkg.monthlyCostItems,
      recurringRules: pkg.recurringRules,
    },
    versionOf(current),
  );
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
