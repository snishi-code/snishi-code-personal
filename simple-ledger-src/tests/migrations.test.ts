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
    managementScopes: [],
    accountInstruments: [],
    accounts: [],
    journalEntries: [],
    allocations: [],
    cashflowSchedules: [],
    reserves: [],
    tags: [],
    monthlyCostItems: [],
    fundingGoals: [],
    assetDisposals: [],
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
  it('v4 → 現行へ migrate（v4→v5 恒等 + v5→v6 role 補完で停止しない）', () => {
    const v4 = pkg(4);
    const r = migrateToCurrent(v4);
    expect(r.ok).toBe(true);
    expect(r.data?.schemaVersion).toBe(SCHEMA_VERSION);
    // 既存配列はそのまま（補完だけで内容は不変）。
    expect(r.data?.tags).toEqual([]);
    expect(r.data?.cashflowSchedules).toEqual([]);
  });
  it('v5 → v6 で account に role を type・参照集合から補う', () => {
    const v5 = pkg(5) as unknown as Record<string, unknown>;
    v5.accounts = [
      { id: 'cash', name: '現金', type: 'asset', archived: false, createdAt: 'x', updatedAt: 'x' },
      {
        id: 'def',
        name: '按分中資産',
        type: 'asset',
        archived: false,
        createdAt: 'x',
        updatedAt: 'x',
      },
      {
        id: 'card',
        name: 'クレジットカード',
        type: 'liability',
        archived: false,
        createdAt: 'x',
        updatedAt: 'x',
      },
      {
        id: 'food',
        name: '食費',
        type: 'expense',
        archived: false,
        createdAt: 'x',
        updatedAt: 'x',
      },
    ];
    const r = migrateToCurrent(v5 as unknown as LedgerExportPackage);
    expect(r.ok).toBe(true);
    const byId = Object.fromEntries((r.data?.accounts ?? []).map((a) => [a.id, a.role]));
    expect(byId.cash).toBe('daily-asset');
    expect(byId.def).toBe('deferred-asset');
    expect(byId.card).toBe('payment-liability');
    expect(byId.food).toBe('expense-category');
  });
  it('v6 → v7 で既存按分から月額化コストを生成する', () => {
    const v6 = pkg(6) as unknown as Record<string, unknown>;
    v6.allocations = [
      {
        id: 'al1',
        name: 'ノートPC',
        totalAmount: 240000,
        months: 48,
        startMonth: '2026-01',
        expenseAccountId: 'exp',
        paymentAccountId: 'pay',
        deferredAccountId: 'def',
        sourceEntryId: 'se',
        recognitionEntryIds: [],
        status: 'active',
        createdAt: 'x',
        updatedAt: 'x',
      },
    ];
    const r = migrateToCurrent(v6 as unknown as LedgerExportPackage);
    expect(r.ok).toBe(true);
    const mcs = r.data?.monthlyCostItems ?? [];
    expect(mcs).toHaveLength(1);
    expect(mcs[0]).toMatchObject({
      name: 'ノートPC',
      amount: 240000,
      costMonths: 48,
      startMonth: '2026-01',
      sourceAllocationId: 'al1',
      status: 'active',
    });
  });
  it('v7 → v8 で fundingGoals を空配列で補う', () => {
    const v7 = { ...pkg(7) } as Record<string, unknown>;
    delete v7.fundingGoals;
    const r = migrateToCurrent(v7 as unknown as LedgerExportPackage);
    expect(r.ok).toBe(true);
    expect(r.data?.fundingGoals).toEqual([]);
  });
  it('v8 → v9 は恒等移行（version だけ前進し内容は不変）', () => {
    const v8 = pkg(8);
    const r = migrateToCurrent(v8);
    expect(r.ok).toBe(true);
    expect(r.data?.schemaVersion).toBe(SCHEMA_VERSION);
    expect(r.data?.cashflowSchedules).toEqual(v8.cashflowSchedules);
  });
  it('v9 → v10 は恒等移行（fixed-asset role / MonthlyCostItem 拡張の版上げ）', () => {
    const v9 = pkg(9);
    const r = migrateToCurrent(v9);
    expect(r.ok).toBe(true);
    expect(r.data?.schemaVersion).toBe(SCHEMA_VERSION);
    expect(r.data?.accounts).toEqual(v9.accounts);
  });
  it('v11 → v12 で固定資産処分(assetDisposals)を空配列で補う', () => {
    const v11 = pkg(11) as unknown as Record<string, unknown>;
    delete v11.assetDisposals; // 旧 JSON には無い。
    const r = migrateToCurrent(v11 as unknown as LedgerExportPackage);
    expect(r.ok).toBe(true);
    expect(r.data?.schemaVersion).toBe(SCHEMA_VERSION);
    expect(r.data?.assetDisposals).toEqual([]);
  });
});
