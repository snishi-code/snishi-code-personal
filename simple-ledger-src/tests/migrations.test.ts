import { describe, expect, it } from 'vitest';
import { migrateToCurrent } from '../src/domain/migrations';
import { SCHEMA_VERSION } from '../src/domain/constants';
import type { LedgerExportPackage } from '../src/domain/types';

function pkg(version: number): LedgerExportPackage {
  return {
    appId: 'snishi-code.simple-ledger',
    schemaVersion: version,
    ledgerId: 'ledger',
    exportedAt: 'x',
    deviceId: 'd',
    baseRevision: 0,
    currentRevision: 0,
    accounts: [],
    journalEntries: [],
    allocations: [],
    cashflowSchedules: [],
    reserves: [],
    tags: [],
    settings: { ledgerName: '家計簿', currency: 'JPY', locale: 'ja' },
  };
}

describe('migrateToCurrent', () => {
  it('現行版はそのまま通す', () => {
    const r = migrateToCurrent(pkg(SCHEMA_VERSION));
    expect(r.ok).toBe(true);
    expect(r.data?.schemaVersion).toBe(SCHEMA_VERSION);
  });
  it('現行より新しい版は fail-closed（too-new）', () => {
    const r = migrateToCurrent(pkg(SCHEMA_VERSION + 1));
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('too-new');
  });
  it('変換手順が無い旧版は unknown-version', () => {
    // v0 のような未知の旧版は手順が無く fail-closed。
    const r = migrateToCurrent(pkg(0));
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('unknown-version');
  });
  it('v1 → 現行へ migrate し、allocations を補う', () => {
    // v1 JSON は allocations を持たない想定。
    const v1 = { ...pkg(1) } as Record<string, unknown>;
    delete v1.allocations;
    const r = migrateToCurrent(v1 as unknown as LedgerExportPackage);
    expect(r.ok).toBe(true);
    expect(r.data?.schemaVersion).toBe(SCHEMA_VERSION);
    expect(r.data?.allocations).toEqual([]);
  });
  it('v4 → v5 は恒等移行（構造は変えず version だけ前進）', () => {
    const v4 = pkg(4);
    const r = migrateToCurrent(v4);
    expect(r.ok).toBe(true);
    expect(r.data?.schemaVersion).toBe(5);
    // 既存配列はそのまま（補完だけで内容は不変）。
    expect(r.data?.tags).toEqual([]);
    expect(r.data?.cashflowSchedules).toEqual([]);
  });
});
