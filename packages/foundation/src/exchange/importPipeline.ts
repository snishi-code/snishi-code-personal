// 移植元: simple-ledger src/data/exportImport.ts の 7 段階 fail-closed import の汎用化
import { z } from 'zod';
import type { ImportOutcome } from './types';

export interface ImportPipelineConfig<TPkg> {
  appId: string;
  currentSchemaVersion: number;
  /** schemaVersion が現行と異なるときに呼ばれる(createMigrationChain を包む想定)。 */
  migrate: (
    data: unknown,
    fromVersion: number,
  ) => { ok: true; data: unknown } | { ok: false; reason: string };
  /** 現行スキーマの完全検証(zod safeParse を包む想定)。 */
  validate: (data: unknown) => { ok: true; pkg: TPkg } | { ok: false; detail: string };
  /** revision を使わないアプリは null を返す(衝突チェックをスキップ)。 */
  getCurrentRevision: () => Promise<number | null>;
  /** 置換前スナップショット。throw したら置換に進まない(保険なしで上書きしない)。 */
  snapshotBefore: (pkg: TPkg) => Promise<void>;
  /** 原子置換(runWrite で全 store を 1 トランザクション置換)はアプリ責務。 */
  replaceAll: (pkg: TPkg) => Promise<void>;
}

export interface ImportPipeline<TPkg> {
  importFromJsonText(raw: string, opts?: { force?: boolean }): Promise<ImportOutcome<TPkg>>;
}

const envelopeSchema = z.object({
  appId: z.string(),
  schemaVersion: z.number().int().positive(),
  revision: z.number().int().optional(),
});

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export function createImportPipeline<TPkg>(cfg: ImportPipelineConfig<TPkg>): ImportPipeline<TPkg> {
  // 7 段階 fail-closed: ①parse ②封筒 ③migration ④完全検証 ⑤revision ⑥前スナップショット ⑦置換。
  // ⑦が成功するまで既存データを一切変更しない。
  async function importFromJsonText(
    raw: string,
    opts: { force?: boolean } = {},
  ): Promise<ImportOutcome<TPkg>> {
    // ① JSON.parse
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (e) {
      return { kind: 'parse-error', detail: errorMessage(e) };
    }

    // ② 封筒確認(最小検証: appId / schemaVersion。appId 不一致 → not-our-file)
    const env = envelopeSchema.safeParse(parsed);
    if (!env.success) {
      return { kind: 'validation-error', detail: 'missing appId / schemaVersion' };
    }
    if (env.data.appId !== cfg.appId) {
      return { kind: 'not-our-file', detail: `appId mismatch: ${env.data.appId}` };
    }

    // ③ migration(未対応版・欠番・未来版は fail-closed)
    let candidate: unknown = parsed;
    if (env.data.schemaVersion !== cfg.currentSchemaVersion) {
      const migrated = cfg.migrate(parsed, env.data.schemaVersion);
      if (!migrated.ok) return { kind: 'unsupported-version', detail: migrated.reason };
      candidate = migrated.data;
    }

    // ④ 現行スキーマで完全検証
    const validated = cfg.validate(candidate);
    if (!validated.ok) return { kind: 'validation-error', detail: validated.detail };
    const pkg = validated.pkg;

    // ⑤ revision 衝突(自動上書きしない。force = 呼び出し側の明示承認でのみ通す)
    if (!opts.force) {
      let local: number | null;
      try {
        local = await cfg.getCurrentRevision();
      } catch (e) {
        return { kind: 'storage-error', detail: errorMessage(e) };
      }
      if (local !== null && env.data.revision !== undefined && local !== env.data.revision) {
        return {
          kind: 'revision-conflict',
          detail: `local revision ${local} != import revision ${env.data.revision}`,
          localRevision: local,
          importRevision: env.data.revision,
        };
      }
    }

    // ⑥ 置換前スナップショット(撮れなければ置換に進まない = 保険なしで上書きしない)
    try {
      await cfg.snapshotBefore(pkg);
    } catch (e) {
      return { kind: 'storage-error', detail: errorMessage(e) };
    }

    // ⑦ 原子置換(throw を成功扱いにしない)
    try {
      await cfg.replaceAll(pkg);
    } catch (e) {
      return { kind: 'storage-error', detail: errorMessage(e) };
    }
    return { kind: 'ok', pkg };
  }

  return { importFromJsonText };
}
