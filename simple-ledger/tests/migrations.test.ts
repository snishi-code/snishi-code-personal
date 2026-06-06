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
    // 現状 v1 のみ。v0 のような未知の旧版は手順が無く fail-closed。
    const r = migrateToCurrent(pkg(0));
    expect(r.ok).toBe(false);
    // 0 < SCHEMA_VERSION なので migration を試み、手順が無いため unknown-version
    expect(r.reason).toBe('unknown-version');
  });
});
