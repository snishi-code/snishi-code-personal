export interface MigrationStep {
  from: number;
  to: number;
  migrate: (data: unknown) => unknown;
}

export type MigrationResult<TFinal> = { ok: true; data: TFinal } | { ok: false; reason: string };

export interface MigrationChain<TFinal> {
  migrateToVersion(
    data: unknown,
    fromVersion: number,
    targetVersion: number,
  ): MigrationResult<TFinal>;
}

export function createMigrationChain<TFinal>(steps: MigrationStep[]): MigrationChain<TFinal> {
  const byFrom = new Map<number, MigrationStep>();
  for (const s of steps) {
    // 後退/停滞 step や同一 from の重複は構成ミス(無限ループ・不定動作の芽)なので即時に弾く。
    if (s.to <= s.from) throw new Error(`migration step must move forward: ${s.from}->${s.to}`);
    if (byFrom.has(s.from)) throw new Error(`duplicate migration step from version ${s.from}`);
    byFrom.set(s.from, s);
  }

  function migrateToVersion(
    data: unknown,
    fromVersion: number,
    targetVersion: number,
  ): MigrationResult<TFinal> {
    if (fromVersion === targetVersion) return { ok: true, data: data as TFinal };
    // 未来版は fail-closed(知らない形式を壊して取り込むより拒否する)。
    if (fromVersion > targetVersion) {
      return { ok: false, reason: `too-new: version ${fromVersion} > ${targetVersion}` };
    }
    let current = data;
    let v = fromVersion;
    while (v < targetVersion) {
      const step = byFrom.get(v);
      // 欠番(登録の無い旧版)も fail-closed。
      if (!step) return { ok: false, reason: `missing-step: no migration from version ${v}` };
      if (step.to > targetVersion) {
        return {
          ok: false,
          reason: `overshoot: step ${v}->${step.to} passes target ${targetVersion}`,
        };
      }
      try {
        current = step.migrate(current);
      } catch (e) {
        return {
          ok: false,
          reason: `migration-failed at ${v}->${step.to}: ${e instanceof Error ? e.message : String(e)}`,
        };
      }
      v = step.to;
    }
    return { ok: true, data: current as TFinal };
  }

  return { migrateToVersion };
}
