import { describe, expect, it } from 'vitest';
import { migrateToCurrent } from '../src/domain/migrations';
import {
  CONTINUOUS_COST_LEDGER_ACCOUNT_ID,
  RESERVE_LEDGER_ACCOUNT_ID,
  SCHEMA_VERSION,
} from '../src/domain/constants';
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
  it('v12 → v13（破壊的）: 旧モデルの継続コスト/按分の生成物をクリアし新モデルへ一本化する', () => {
    // 旧按分 + 生成仕訳 + 月額化コスト + その返済CF を持つ v6 台帳を現行(v13)まで前進させると、
    // v6→v7 で一旦生成された monthlyCostItems も含め、旧モデル由来は v13 ですべて落ちる。
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
    v6.journalEntries = [
      {
        id: 'plain',
        date: '2026-01-05',
        description: '手入力支出',
        kind: 'normal',
        lines: [
          { accountId: 'exp', side: 'debit', amount: 500 },
          { accountId: 'pay', side: 'credit', amount: 500 },
        ],
        createdAt: 'x',
        updatedAt: 'x',
      },
      {
        id: 'gen',
        date: '2026-01-06',
        description: '生成（月額化の支払い）',
        kind: 'normal',
        metadata: { monthlyCostId: 'mc1' },
        lines: [
          { accountId: 'exp', side: 'debit', amount: 1000 },
          { accountId: 'pay', side: 'credit', amount: 1000 },
        ],
        createdAt: 'x',
        updatedAt: 'x',
      },
    ];
    const r = migrateToCurrent(v6 as unknown as LedgerExportPackage);
    expect(r.ok).toBe(true);
    expect(r.data?.schemaVersion).toBe(SCHEMA_VERSION);
    // 旧モデルの登録簿は空に。
    expect(r.data?.monthlyCostItems).toEqual([]);
    expect(r.data?.allocations).toEqual([]);
    expect(r.data?.assetDisposals).toEqual([]);
    // 生成仕訳は落ち、手入力の通常仕訳は残る。
    const ids = (r.data?.journalEntries ?? []).map((e) => e.id);
    expect(ids).toContain('plain');
    expect(ids).not.toContain('gen');
  });
  it('v15 → v16 で B 側レガシー（資金目標・取り置きの目標額/期限・期待年利）を落とす', () => {
    const v15 = pkg(15) as unknown as Record<string, unknown>;
    v15.fundingGoals = [{ id: 'g1', name: '老後', targetAmount: 5000000 }];
    v15.reserves = [
      {
        id: 'r1',
        name: '旅行',
        reserveAccountId: 'reserve-ledger',
        targetAmount: 200000,
        targetDate: '2026-12-31',
        createdAt: 'x',
        updatedAt: 'x',
      },
    ];
    v15.settings = {
      ledgerName: '家計簿',
      currency: 'JPY',
      locale: 'ja',
      expectedAnnualReturnBps: 500,
    };
    const r = migrateToCurrent(v15 as unknown as LedgerExportPackage);
    expect(r.ok).toBe(true);
    expect(r.data?.schemaVersion).toBe(SCHEMA_VERSION);
    // 資金目標・期待年利・取り置きの目標は消える。
    expect((r.data as unknown as Record<string, unknown>).fundingGoals).toBeUndefined();
    const res = r.data?.reserves[0] as unknown as Record<string, unknown>;
    expect(res.targetAmount).toBeUndefined();
    expect(res.targetDate).toBeUndefined();
    expect(
      (r.data?.settings as unknown as Record<string, unknown>).expectedAnnualReturnBps,
    ).toBeUndefined();
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
  it('v13 → v14 で品目別 continuing-cost-asset 科目を集約台帳口座へ寄せる', () => {
    const v13 = pkg(13) as unknown as Record<string, unknown>;
    v13.accounts = [
      {
        id: 'pay',
        name: '現金',
        type: 'asset',
        role: 'daily-asset',
        archived: false,
        createdAt: 'x',
        updatedAt: 'x',
      },
      {
        id: 'exp',
        name: '変動費',
        type: 'expense',
        role: 'expense-category',
        archived: false,
        createdAt: 'x',
        updatedAt: 'x',
      },
      // 旧モデルの品目別資産科目（2 件）。
      {
        id: 'cc-washer',
        name: '洗濯機',
        type: 'asset',
        role: 'continuing-cost-asset',
        archived: false,
        createdAt: 'x',
        updatedAt: 'x',
      },
      {
        id: 'cc-youtube',
        name: 'YouTube',
        type: 'asset',
        role: 'continuing-cost-asset',
        archived: false,
        createdAt: 'x',
        updatedAt: 'x',
      },
    ];
    v13.monthlyCostItems = [
      {
        id: 'm1',
        name: '洗濯機',
        managementScopeId: 'scope-personal',
        kind: 'durable-asset',
        amount: 240000,
        costMonths: 84,
        startMonth: '2026-01',
        expenseAccountId: 'exp',
        paymentSourceAccountId: 'pay',
        recognitionCreditAccountId: 'cc-washer',
        status: 'active',
        createdAt: 'x',
        updatedAt: 'x',
      },
      {
        id: 'm2',
        name: 'YouTube',
        managementScopeId: 'scope-personal',
        kind: 'subscription',
        amount: 12000,
        costMonths: 12,
        startMonth: '2026-01',
        expenseAccountId: 'exp',
        paymentSourceAccountId: 'pay',
        recognitionCreditAccountId: 'cc-youtube',
        status: 'active',
        createdAt: 'x',
        updatedAt: 'x',
      },
    ];
    const r = migrateToCurrent(v13 as unknown as LedgerExportPackage);
    expect(r.ok).toBe(true);
    expect(r.data?.schemaVersion).toBe(SCHEMA_VERSION);
    // 旧品目別科目は消え、集約口座が 1 件だけ。
    const ccAccounts = (r.data?.accounts ?? []).filter((a) => a.role === 'continuing-cost-asset');
    expect(ccAccounts).toHaveLength(1);
    expect(ccAccounts[0]?.id).toBe(CONTINUOUS_COST_LEDGER_ACCOUNT_ID);
    expect((r.data?.accounts ?? []).some((a) => a.id === 'cc-washer')).toBe(false);
    expect((r.data?.accounts ?? []).some((a) => a.id === 'cc-youtube')).toBe(false);
    // 品目名は失われず、recognitionCreditAccountId は集約口座へ付け替わる。
    const items = r.data?.monthlyCostItems ?? [];
    expect(items.map((m) => m.name).sort()).toEqual(['YouTube', '洗濯機']);
    expect(
      items.every((m) => m.recognitionCreditAccountId === CONTINUOUS_COST_LEDGER_ACCOUNT_ID),
    ).toBe(true);
  });

  it('v14 → v15 で目的別 reserve-asset 科目を集約口座へ寄せ、取り置き振替に reserveId を付ける', () => {
    const v14 = pkg(14) as unknown as Record<string, unknown>;
    const acc = (id: string, name: string, role: string, type = 'asset') => ({
      id,
      name,
      type,
      role,
      archived: false,
      createdAt: 'x',
      updatedAt: 'x',
    });
    v14.accounts = [
      acc('bank', '預金', 'daily-asset'),
      acc('res-trip', '旅行積立', 'reserve-asset'),
      acc('res-car', '車の頭金', 'reserve-asset'),
    ];
    v14.reserves = [
      {
        id: 'r-trip',
        name: '旅行積立',
        reserveAccountId: 'res-trip',
        createdAt: 'x',
        updatedAt: 'x',
      },
      {
        id: 'r-car',
        name: '車の頭金',
        reserveAccountId: 'res-car',
        createdAt: 'x',
        updatedAt: 'x',
      },
    ];
    // 取り置き振替（預金 → 旧目的別口座）。
    v14.journalEntries = [
      {
        id: 'mv-trip',
        date: '2026-01-05',
        description: '預金 → 旅行積立',
        kind: 'normal',
        lines: [
          { accountId: 'res-trip', side: 'debit', amount: 20000 },
          { accountId: 'bank', side: 'credit', amount: 20000 },
        ],
        createdAt: 'x',
        updatedAt: 'x',
      },
    ];
    const r = migrateToCurrent(v14 as unknown as LedgerExportPackage);
    expect(r.ok).toBe(true);
    expect(r.data?.schemaVersion).toBe(SCHEMA_VERSION);
    // 旧目的別口座は消え、集約口座が 1 件だけ。
    const resAccts = (r.data?.accounts ?? []).filter((a) => a.role === 'reserve-asset');
    expect(resAccts).toHaveLength(1);
    expect(resAccts[0]?.id).toBe(RESERVE_LEDGER_ACCOUNT_ID);
    // ReserveItem は集約口座へ付け替え、目的名は残る。
    const reserves = r.data?.reserves ?? [];
    expect(reserves.map((x) => x.name).sort()).toEqual(['旅行積立', '車の頭金']);
    expect(reserves.every((x) => x.reserveAccountId === RESERVE_LEDGER_ACCOUNT_ID)).toBe(true);
    // 取り置き振替は集約口座参照へ差し替え + reserveId タグ付け。
    const mv = (r.data?.journalEntries ?? []).find((e) => e.id === 'mv-trip')!;
    expect(mv.metadata?.reserveId).toBe('r-trip');
    expect(mv.lines.find((l) => l.side === 'debit')?.accountId).toBe(RESERVE_LEDGER_ACCOUNT_ID);
  });
});
