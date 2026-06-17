import { describe, expect, it } from 'vitest';
import './setup';
import {
  isCurrentSchema,
  journalEntrySchema,
  ledgerExportPackageSchema,
  reserveItemSchema,
} from '../src/domain/schema';
import { APP_ID, RESERVE_LEDGER_ACCOUNT_ID, SCHEMA_VERSION } from '../src/domain/constants';
import { buildAllocation } from '../src/domain/allocation';

const validEntry = {
  id: 'e1',
  date: '2026-06-01',
  description: 'ランチ',
  kind: 'normal',
  managementScopeId: 'scope-personal',
  lines: [
    { accountId: 'a', side: 'debit', amount: 1000 },
    { accountId: 'b', side: 'credit', amount: 1000 },
  ],
  createdAt: '2026-06-01T00:00:00.000Z',
  updatedAt: '2026-06-01T00:00:00.000Z',
};

describe('journalEntrySchema', () => {
  it('借方=貸方の仕訳を受け入れる', () => {
    expect(journalEntrySchema.safeParse(validEntry).success).toBe(true);
  });
  it('借方≠貸方は拒否する', () => {
    const bad = {
      ...validEntry,
      lines: [
        { accountId: 'a', side: 'debit', amount: 1000 },
        { accountId: 'b', side: 'credit', amount: 999 },
      ],
    };
    const r = journalEntrySchema.safeParse(bad);
    expect(r.success).toBe(false);
  });
  it('金額が 0 や小数は拒否する', () => {
    expect(
      journalEntrySchema.safeParse({
        ...validEntry,
        lines: [
          { accountId: 'a', side: 'debit', amount: 0 },
          { accountId: 'b', side: 'credit', amount: 0 },
        ],
      }).success,
    ).toBe(false);
    expect(
      journalEntrySchema.safeParse({
        ...validEntry,
        lines: [
          { accountId: 'a', side: 'debit', amount: 10.5 },
          { accountId: 'b', side: 'credit', amount: 10.5 },
        ],
      }).success,
    ).toBe(false);
  });
  it('不正な日付形式は拒否する', () => {
    expect(journalEntrySchema.safeParse({ ...validEntry, date: '2026/06/01' }).success).toBe(false);
  });
});

describe('ledgerExportPackageSchema', () => {
  const validPkg = {
    appId: APP_ID,
    schemaVersion: SCHEMA_VERSION,
    ledgerId: 'ledger',
    exportedAt: '2026-06-01T00:00:00.000Z',
    deviceId: 'dev1',
    revision: 0,
    managementScopes: [
      { id: 'scope-personal', name: '個人用', archived: false, createdAt: 'x', updatedAt: 'x' },
    ],
    accountInstruments: [],
    accounts: [
      {
        id: 'a',
        name: '現金',
        type: 'asset',
        role: 'daily-asset',
        archived: false,
        createdAt: 'x',
        updatedAt: 'x',
      },
      {
        id: 'b',
        name: '食費',
        type: 'expense',
        role: 'expense-category',
        archived: false,
        createdAt: 'x',
        updatedAt: 'x',
      },
    ],
    journalEntries: [validEntry],
    allocations: [],
    cashflowSchedules: [],
    reserves: [],
    tags: [],
    monthlyCostItems: [],
    assetDisposals: [],
    settings: { ledgerName: '家計簿', currency: 'JPY', locale: 'ja' },
  };

  it('正しいパッケージを受け入れる', () => {
    expect(ledgerExportPackageSchema.safeParse(validPkg).success).toBe(true);
  });
  it('B 側レガシーの余計なキー（fundingGoals・expectedAnnualReturnBps）は strip される（v16 契約・出力に残さない）', () => {
    const withLegacy = {
      ...validPkg,
      fundingGoals: [{ id: 'g', name: '老後', targetAmount: 5000000 }],
      settings: {
        ledgerName: '家計簿',
        currency: 'JPY',
        locale: 'ja',
        expectedAnnualReturnBps: 500,
      },
    };
    const parsed = ledgerExportPackageSchema.safeParse(withLegacy);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      // 出力に B 側キーは残らない（unknown key は strip）。
      expect((parsed.data as unknown as Record<string, unknown>).fundingGoals).toBeUndefined();
      expect(
        (parsed.data.settings as unknown as Record<string, unknown>).expectedAnnualReturnBps,
      ).toBeUndefined();
    }
  });
  it('取り置きの旧目標フィールド（targetAmount/targetDate）は reserveItemSchema で strip される', () => {
    const parsed = reserveItemSchema.safeParse({
      id: 'r',
      name: '旅行',
      reserveAccountId: RESERVE_LEDGER_ACCOUNT_ID,
      targetAmount: 100,
      targetDate: '2026-12-31',
      createdAt: 'x',
      updatedAt: 'x',
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      const res = parsed.data as unknown as Record<string, unknown>;
      expect(res.targetAmount).toBeUndefined();
      expect(res.targetDate).toBeUndefined();
    }
  });
  it('appId が違うと拒否する', () => {
    expect(ledgerExportPackageSchema.safeParse({ ...validPkg, appId: 'other' }).success).toBe(
      false,
    );
  });
  it('role と type が矛盾する科目は拒否する', () => {
    const bad = {
      ...validPkg,
      // 現金(asset) に expense-category を付ける → 不整合
      accounts: [{ ...validPkg.accounts[0], role: 'expense-category' }, validPkg.accounts[1]],
    };
    expect(ledgerExportPackageSchema.safeParse(bad).success).toBe(false);
  });
  it('存在しない勘定科目を参照する仕訳は拒否する（参照整合性）', () => {
    // account 'b' を取り除くと、validEntry の貸方 'b' が宙吊りになる
    const dangling = {
      ...validPkg,
      accounts: [validPkg.accounts[0]],
    };
    expect(ledgerExportPackageSchema.safeParse(dangling).success).toBe(false);
  });
  it('勘定科目 ID の重複は拒否する', () => {
    const dup = {
      ...validPkg,
      accounts: [...validPkg.accounts, validPkg.accounts[0]],
    };
    expect(ledgerExportPackageSchema.safeParse(dup).success).toBe(false);
  });
  it('支払い手段の親科目が資金口座/クレジットカード以外（投資資産）は拒否する', () => {
    const bad = {
      ...validPkg,
      accounts: [
        ...validPkg.accounts,
        {
          id: 'inv',
          name: '投資',
          type: 'asset',
          role: 'investment-asset',
          archived: false,
          createdAt: 'x',
          updatedAt: 'x',
        },
      ],
      accountInstruments: [
        {
          id: 'i1',
          managementScopeId: 'scope-personal',
          accountId: 'inv',
          name: '証券口座',
          kind: 'other',
          archived: false,
          createdAt: 'x',
          updatedAt: 'x',
        },
      ],
    };
    expect(ledgerExportPackageSchema.safeParse(bad).success).toBe(false);
  });
  it('支払い手段の親科目が資金口座（daily-asset）なら受け入れる', () => {
    const ok = {
      ...validPkg,
      accountInstruments: [
        {
          id: 'i1',
          managementScopeId: 'scope-personal',
          accountId: 'a',
          name: '楽天銀行',
          kind: 'bank',
          archived: false,
          createdAt: 'x',
          updatedAt: 'x',
        },
      ],
    };
    expect(ledgerExportPackageSchema.safeParse(ok).success).toBe(true);
  });
});

describe('isCurrentSchema', () => {
  it('現行版のみ true', () => {
    expect(isCurrentSchema(SCHEMA_VERSION)).toBe(true);
    expect(isCurrentSchema(SCHEMA_VERSION + 1)).toBe(false);
  });
});

describe('entry metadata / allocationPlan', () => {
  it('metadata なしの仕訳も有効', () => {
    expect(journalEntrySchema.safeParse(validEntry).success).toBe(true);
  });
  it('inputMode と allocationPlan を含む仕訳を受け入れる（将来按分の拡張点）', () => {
    const withMeta = {
      ...validEntry,
      metadata: {
        inputMode: 'expense',
        allocationPlan: {
          kind: 'period',
          startDate: '2026-06-01',
          endDate: '2026-12-31',
          method: 'even-monthly',
          recognitionAccountId: 'a',
          deferredAccountId: 'b',
          generatedEntryIds: [],
        },
      },
    };
    expect(journalEntrySchema.safeParse(withMeta).success).toBe(true);
  });
  it('export パッケージで metadata が保持される（round-trip）', () => {
    const pkg = {
      appId: APP_ID,
      schemaVersion: SCHEMA_VERSION,
      ledgerId: 'ledger',
      exportedAt: '2026-06-01T00:00:00.000Z',
      deviceId: 'd',
      revision: 0,
      managementScopes: [
        { id: 'scope-personal', name: '個人用', archived: false, createdAt: 'x', updatedAt: 'x' },
      ],
      accountInstruments: [],
      accounts: [
        {
          id: 'a',
          name: '現金',
          type: 'asset',
          role: 'daily-asset',
          archived: false,
          createdAt: 'x',
          updatedAt: 'x',
        },
        {
          id: 'b',
          name: '食費',
          type: 'expense',
          role: 'expense-category',
          archived: false,
          createdAt: 'x',
          updatedAt: 'x',
        },
      ],
      journalEntries: [
        { ...validEntry, metadata: { inputMode: 'reversal', reversalOfEntryId: 'z' } },
      ],
      allocations: [],
      cashflowSchedules: [],
      reserves: [],
      tags: [],
      monthlyCostItems: [],
      fundingGoals: [],
      assetDisposals: [],
      settings: { ledgerName: '家計簿', currency: 'JPY', locale: 'ja' },
    };
    const parsed = ledgerExportPackageSchema.safeParse(pkg);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.journalEntries[0]?.metadata?.inputMode).toBe('reversal');
    }
  });
});

describe('journalEntrySchema 行数ルール（MVP: 1 借方・1 貸方）', () => {
  it('3 行以上の複合仕訳は拒否する', () => {
    const threeLines = {
      ...validEntry,
      lines: [
        { accountId: 'a', side: 'debit', amount: 600 },
        { accountId: 'b', side: 'credit', amount: 1000 },
        { accountId: 'c', side: 'debit', amount: 400 },
      ],
    };
    expect(journalEntrySchema.safeParse(threeLines).success).toBe(false);
  });
  it('片側に偏った 2 行（借方2/貸方0）は拒否する', () => {
    const bothDebit = {
      ...validEntry,
      lines: [
        { accountId: 'a', side: 'debit', amount: 500 },
        { accountId: 'b', side: 'debit', amount: 500 },
      ],
    };
    expect(journalEntrySchema.safeParse(bothDebit).success).toBe(false);
  });
});

describe('allocationPlan の参照整合性（package 検証）', () => {
  function pkgWithPlan(plan: Record<string, unknown>) {
    return {
      appId: APP_ID,
      schemaVersion: SCHEMA_VERSION,
      ledgerId: 'ledger',
      exportedAt: '2026-06-01T00:00:00.000Z',
      deviceId: 'd',
      revision: 0,
      managementScopes: [
        { id: 'scope-personal', name: '個人用', archived: false, createdAt: 'x', updatedAt: 'x' },
      ],
      accountInstruments: [],
      accounts: [
        {
          id: 'a',
          name: '現金',
          type: 'asset',
          role: 'daily-asset',
          archived: false,
          createdAt: 'x',
          updatedAt: 'x',
        },
        {
          id: 'b',
          name: '食費',
          type: 'expense',
          role: 'expense-category',
          archived: false,
          createdAt: 'x',
          updatedAt: 'x',
        },
      ],
      journalEntries: [{ ...validEntry, metadata: { allocationPlan: plan } }],
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
  const base = {
    kind: 'period',
    startDate: '2026-06-01',
    endDate: '2026-12-31',
    method: 'even-monthly',
    recognitionAccountId: 'b',
    deferredAccountId: 'a',
    generatedEntryIds: [] as string[],
  };

  it('科目参照が揃っていれば有効', () => {
    expect(ledgerExportPackageSchema.safeParse(pkgWithPlan(base)).success).toBe(true);
  });
  it('存在しない recognition/deferred 科目は拒否する', () => {
    expect(
      ledgerExportPackageSchema.safeParse(pkgWithPlan({ ...base, recognitionAccountId: 'zzz' }))
        .success,
    ).toBe(false);
  });
  it('存在しない generatedEntryIds は拒否する', () => {
    expect(
      ledgerExportPackageSchema.safeParse(pkgWithPlan({ ...base, generatedEntryIds: ['nope'] }))
        .success,
    ).toBe(false);
  });
  it('既存仕訳 ID を指す generatedEntryIds は許可する', () => {
    expect(
      ledgerExportPackageSchema.safeParse(pkgWithPlan({ ...base, generatedEntryIds: ['e1'] }))
        .success,
    ).toBe(true);
  });
});

describe('按分(allocations) の深い整合性検証（package）', () => {
  const built = buildAllocation({
    date: '2026-06-15',
    description: 'PC',
    totalAmount: 1000,
    months: 3,
    expenseAccountId: 'exp',
    paymentAccountId: 'pay',
    deferredAccountId: 'def',
  });
  function allocPkg(overrides: Record<string, unknown> = {}) {
    return {
      appId: APP_ID,
      schemaVersion: SCHEMA_VERSION,
      ledgerId: 'ledger',
      exportedAt: '2026-06-01T00:00:00.000Z',
      deviceId: 'd',
      revision: 0,
      managementScopes: [
        { id: 'scope-personal', name: '個人用', archived: false, createdAt: 'x', updatedAt: 'x' },
      ],
      accountInstruments: [],
      accounts: [
        {
          id: 'exp',
          name: '食費',
          type: 'expense',
          role: 'expense-category',
          archived: false,
          createdAt: 'x',
          updatedAt: 'x',
        },
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
          id: 'def',
          name: '按分中資産',
          type: 'asset',
          role: 'deferred-asset',
          archived: false,
          createdAt: 'x',
          updatedAt: 'x',
        },
      ],
      journalEntries: [built.sourceEntry, ...built.recognitionEntries],
      allocations: [built.item],
      cashflowSchedules: [],
      reserves: [],
      tags: [],
      monthlyCostItems: [],
      fundingGoals: [],
      assetDisposals: [],
      settings: { ledgerName: '家計簿', currency: 'JPY', locale: 'ja' },
      ...overrides,
    };
  }

  it('buildAllocation 由来の正しいパッケージは valid', () => {
    expect(ledgerExportPackageSchema.safeParse(allocPkg()).success).toBe(true);
  });
  it('認識仕訳数が月数と不一致なら invalid', () => {
    const bad = allocPkg({ allocations: [{ ...built.item, months: 2 }] });
    expect(ledgerExportPackageSchema.safeParse(bad).success).toBe(false);
  });
  it('deferred が資産科目でないと invalid', () => {
    const bad = allocPkg({
      accounts: [
        {
          id: 'exp',
          name: '食費',
          type: 'expense',
          role: 'expense-category',
          archived: false,
          createdAt: 'x',
          updatedAt: 'x',
        },
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
          id: 'def',
          name: '誤区分',
          type: 'expense',
          role: 'expense-category',
          archived: false,
          createdAt: 'x',
          updatedAt: 'x',
        },
      ],
    });
    expect(ledgerExportPackageSchema.safeParse(bad).success).toBe(false);
  });
  it('deferred の role が deferred-asset でないと invalid（asset だが daily-asset）', () => {
    const bad = allocPkg({
      accounts: [
        {
          id: 'exp',
          name: '食費',
          type: 'expense',
          role: 'expense-category',
          archived: false,
          createdAt: 'x',
          updatedAt: 'x',
        },
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
          id: 'def',
          name: '按分中資産',
          type: 'asset',
          role: 'daily-asset', // type は asset だが role が deferred-asset でない
          archived: false,
          createdAt: 'x',
          updatedAt: 'x',
        },
      ],
    });
    expect(ledgerExportPackageSchema.safeParse(bad).success).toBe(false);
  });
  it('孤立した按分仕訳（どの台帳からも参照されない）は invalid', () => {
    const ghost = {
      ...built.recognitionEntries[0],
      id: 'ghost',
      metadata: { allocationId: 'zzz', allocationRole: 'recognition' },
    };
    const bad = allocPkg({
      journalEntries: [built.sourceEntry, ...built.recognitionEntries, ghost],
    });
    expect(ledgerExportPackageSchema.safeParse(bad).success).toBe(false);
  });
  it('認識仕訳の金額を改ざんすると invalid（合計/月額不一致）', () => {
    const tampered = built.recognitionEntries.map((e, i) =>
      i === 0
        ? {
            ...e,
            lines: [
              { ...e.lines[0]!, amount: e.lines[0]!.amount + 100 },
              { ...e.lines[1]!, amount: e.lines[1]!.amount + 100 },
            ],
          }
        : e,
    );
    const bad = allocPkg({ journalEntries: [built.sourceEntry, ...tampered] });
    expect(ledgerExportPackageSchema.safeParse(bad).success).toBe(false);
  });
});

describe('予定CF・目的別資金・allocation メタの検証（package）', () => {
  const bank = {
    id: 'bank',
    name: '普通預金',
    type: 'asset',
    role: 'daily-asset',
    archived: false,
    createdAt: 'x',
    updatedAt: 'x',
  };
  const card = {
    id: 'card',
    name: 'カード',
    type: 'liability',
    role: 'payment-liability',
    archived: false,
    createdAt: 'x',
    updatedAt: 'x',
  };
  // 集約モデル: 取り置きは目的別科目でなく単一の集約口座に寄せる（id は集約口座固定）。
  const reserveAcc = {
    id: RESERVE_LEDGER_ACCOUNT_ID,
    name: '取り置き資金',
    type: 'asset',
    role: 'reserve-asset',
    archived: false,
    createdAt: 'x',
    updatedAt: 'x',
  };
  function cfPkg(over: Record<string, unknown> = {}) {
    return {
      appId: APP_ID,
      schemaVersion: SCHEMA_VERSION,
      ledgerId: 'ledger',
      exportedAt: '2026-06-01T00:00:00.000Z',
      deviceId: 'd',
      revision: 0,
      managementScopes: [
        { id: 'scope-personal', name: '個人用', archived: false, createdAt: 'x', updatedAt: 'x' },
      ],
      accountInstruments: [],
      accounts: [bank, card, reserveAcc],
      journalEntries: [],
      allocations: [],
      cashflowSchedules: [
        {
          id: 's1',
          title: 'カード引き落とし',
          dueDate: '2026-07-10',
          amount: 50000,
          direction: 'outflow',
          accountId: 'bank',
          counterAccountId: 'card',
          source: 'credit-card',
          status: 'planned',
          managementScopeId: 'scope-personal',
          createdAt: 'x',
          updatedAt: 'x',
        },
      ],
      reserves: [
        {
          id: 'r1',
          name: '結婚資金',
          reserveAccountId: RESERVE_LEDGER_ACCOUNT_ID,
          createdAt: 'x',
          updatedAt: 'x',
        },
      ],
      tags: [],
      monthlyCostItems: [],
      fundingGoals: [],
      assetDisposals: [],
      settings: { ledgerName: '家計簿', currency: 'JPY', locale: 'ja' },
      ...over,
    };
  }

  it('正しい予定CF・目的別資金は valid', () => {
    expect(ledgerExportPackageSchema.safeParse(cfPkg()).success).toBe(true);
  });
  it('予定CF の口座が資産でないと invalid', () => {
    const bad = cfPkg({
      cashflowSchedules: [
        {
          id: 's1',
          title: 'x',
          dueDate: '2026-07-10',
          amount: 100,
          direction: 'outflow',
          accountId: 'card',
          source: 'manual',
          status: 'planned',
          createdAt: 'x',
          updatedAt: 'x',
        },
      ],
    });
    expect(ledgerExportPackageSchema.safeParse(bad).success).toBe(false);
  });
  it('posted の予定CF が仕訳に紐づかないと invalid', () => {
    const bad = cfPkg({
      cashflowSchedules: [
        {
          id: 's1',
          title: 'x',
          dueDate: '2026-07-10',
          amount: 100,
          direction: 'outflow',
          accountId: 'bank',
          counterAccountId: 'card',
          source: 'manual',
          status: 'posted',
          createdAt: 'x',
          updatedAt: 'x',
        },
      ],
    });
    expect(ledgerExportPackageSchema.safeParse(bad).success).toBe(false);
  });
  it('目的別資金の科目が資産でないと invalid', () => {
    const bad = cfPkg({
      reserves: [{ id: 'r1', name: 'x', reserveAccountId: 'card', createdAt: 'x', updatedAt: 'x' }],
    });
    expect(ledgerExportPackageSchema.safeParse(bad).success).toBe(false);
  });
  it('目的別資金の科目の role が reserve-asset でないと invalid（bank は daily-asset）', () => {
    const bad = cfPkg({
      reserves: [{ id: 'r1', name: 'x', reserveAccountId: 'bank', createdAt: 'x', updatedAt: 'x' }],
    });
    expect(ledgerExportPackageSchema.safeParse(bad).success).toBe(false);
  });
  it('集約モデルの不変条件: 目的別の reserve-asset 科目（集約口座以外）は invalid（import で再導入させない）', () => {
    // 集約口座でない reserve-asset 科目を足し、それを reserveAccountId に使う = 旧モデル。
    const bad = cfPkg({
      accounts: [
        bank,
        card,
        reserveAcc,
        {
          id: 'per-purpose',
          name: '旅行積立',
          type: 'asset',
          role: 'reserve-asset',
          archived: false,
          createdAt: 'x',
          updatedAt: 'x',
        },
      ],
      reserves: [
        { id: 'r1', name: '旅行', reserveAccountId: 'per-purpose', createdAt: 'x', updatedAt: 'x' },
      ],
    });
    expect(ledgerExportPackageSchema.safeParse(bad).success).toBe(false);
  });
  it('集約モデルの不変条件: metadata.reserveId が存在しない取り置きを参照すると invalid', () => {
    const bad = cfPkg({
      reserves: [
        {
          id: 'r1',
          name: '旅行',
          reserveAccountId: RESERVE_LEDGER_ACCOUNT_ID,
          createdAt: 'x',
          updatedAt: 'x',
        },
      ],
      journalEntries: [
        {
          id: 'e-bad',
          date: '2026-02-01',
          description: '取り置き',
          kind: 'normal',
          managementScopeId: 'scope-personal',
          metadata: { inputMode: 'transfer', reserveId: 'nope' },
          lines: [
            { accountId: RESERVE_LEDGER_ACCOUNT_ID, side: 'debit', amount: 10000 },
            { accountId: 'bank', side: 'credit', amount: 10000 },
          ],
          createdAt: 'x',
          updatedAt: 'x',
        },
      ],
    });
    expect(ledgerExportPackageSchema.safeParse(bad).success).toBe(false);
  });
  it('allocationRole 単独（allocationId なし）の仕訳は invalid', () => {
    const bad = cfPkg({
      journalEntries: [
        {
          id: 'x1',
          date: '2026-06-01',
          description: '混入',
          kind: 'normal',
          managementScopeId: 'scope-personal',
          lines: [
            { accountId: 'bank', side: 'debit', amount: 100 },
            { accountId: 'card', side: 'credit', amount: 100 },
          ],
          metadata: { allocationRole: 'recognition' },
          createdAt: 'x',
          updatedAt: 'x',
        },
      ],
    });
    expect(ledgerExportPackageSchema.safeParse(bad).success).toBe(false);
  });
});

describe('タグ(tags) の scope・参照検証（package）', () => {
  const acc = (id: string, type: string) => ({
    id,
    name: id,
    type,
    role: type === 'asset' ? 'daily-asset' : type === 'expense' ? 'expense-category' : 'equity',
    archived: false,
    createdAt: 'x',
    updatedAt: 'x',
  });
  function tagPkg(over: Record<string, unknown> = {}) {
    return {
      appId: APP_ID,
      schemaVersion: SCHEMA_VERSION,
      ledgerId: 'ledger',
      exportedAt: '2026-06-01T00:00:00.000Z',
      deviceId: 'd',
      revision: 0,
      managementScopes: [
        { id: 'scope-personal', name: '個人用', archived: false, createdAt: 'x', updatedAt: 'x' },
      ],
      accountInstruments: [],
      accounts: [acc('food', 'expense'), acc('cash', 'asset')],
      journalEntries: [
        {
          id: 'e1',
          date: '2026-06-01',
          description: 'x',
          kind: 'normal',
          managementScopeId: 'scope-personal',
          tagIds: ['trip'],
          lines: [
            { accountId: 'food', side: 'debit', amount: 1000 },
            { accountId: 'cash', side: 'credit', amount: 1000 },
          ],
          createdAt: 'x',
          updatedAt: 'x',
        },
      ],
      allocations: [],
      cashflowSchedules: [],
      reserves: [],
      tags: [
        {
          id: 'trip',
          name: '旅行',
          scope: 'entry',
          archived: false,
          createdAt: 'x',
          updatedAt: 'x',
        },
      ],
      monthlyCostItems: [],
      fundingGoals: [],
      assetDisposals: [],
      settings: { ledgerName: '家計簿', currency: 'JPY', locale: 'ja' },
      ...over,
    };
  }

  it('仕訳全体タグの付与は valid', () => {
    expect(ledgerExportPackageSchema.safeParse(tagPkg()).success).toBe(true);
  });
  it('存在しないタグ参照は invalid', () => {
    const bad = tagPkg({
      journalEntries: [
        {
          id: 'e1',
          date: '2026-06-01',
          description: 'x',
          kind: 'normal',
          managementScopeId: 'scope-personal',
          tagIds: ['nope'],
          lines: [
            { accountId: 'food', side: 'debit', amount: 1000 },
            { accountId: 'cash', side: 'credit', amount: 1000 },
          ],
          createdAt: 'x',
          updatedAt: 'x',
        },
      ],
    });
    expect(ledgerExportPackageSchema.safeParse(bad).success).toBe(false);
  });
  it('有効な同名タグの重複は invalid', () => {
    const bad = tagPkg({
      tags: [
        { id: 't1', name: '旅行', scope: 'entry', archived: false, createdAt: 'x', updatedAt: 'x' },
        { id: 't2', name: '旅行', scope: 'entry', archived: false, createdAt: 'x', updatedAt: 'x' },
      ],
      journalEntries: [],
    });
    expect(ledgerExportPackageSchema.safeParse(bad).success).toBe(false);
  });
});

describe('月額化コスト(monthlyCostItems) の参照・role 検証（package）', () => {
  const cash = {
    id: 'cash',
    name: '現金',
    type: 'asset',
    role: 'daily-asset',
    archived: false,
    createdAt: 'x',
    updatedAt: 'x',
  };
  const food = {
    id: 'food',
    name: '食費',
    type: 'expense',
    role: 'expense-category',
    archived: false,
    createdAt: 'x',
    updatedAt: 'x',
  };
  function mcPkg(items: Record<string, unknown>[]) {
    return {
      appId: APP_ID,
      schemaVersion: SCHEMA_VERSION,
      ledgerId: 'ledger',
      exportedAt: '2026-06-01T00:00:00.000Z',
      deviceId: 'd',
      revision: 0,
      managementScopes: [
        { id: 'scope-personal', name: '個人用', archived: false, createdAt: 'x', updatedAt: 'x' },
      ],
      accountInstruments: [],
      accounts: [cash, food],
      journalEntries: [],
      allocations: [],
      cashflowSchedules: [],
      reserves: [],
      tags: [],
      monthlyCostItems: items,
      fundingGoals: [],
      assetDisposals: [],
      settings: { ledgerName: '家計簿', currency: 'JPY', locale: 'ja' },
    };
  }
  const base = {
    id: 'm1',
    name: 'Netflix',
    managementScopeId: 'scope-personal',
    kind: 'subscription',
    amount: 1500,
    costMonths: 1,
    startMonth: '2026-06',
    expenseAccountId: 'food',
    paymentAccountId: 'cash',
    status: 'active',
    createdAt: 'x',
    updatedAt: 'x',
  };

  it('正しい月額化コストは valid', () => {
    expect(ledgerExportPackageSchema.safeParse(mcPkg([base])).success).toBe(true);
  });
  it('expenseAccountId が支出カテゴリでないと invalid', () => {
    const bad = mcPkg([{ ...base, expenseAccountId: 'cash' }]);
    expect(ledgerExportPackageSchema.safeParse(bad).success).toBe(false);
  });
  it('paymentAccountId が日常資産/支払用負債でないと invalid', () => {
    const bad = mcPkg([{ ...base, paymentAccountId: 'food' }]);
    expect(ledgerExportPackageSchema.safeParse(bad).success).toBe(false);
  });
  it('存在しない sourceAllocationId は invalid', () => {
    const bad = mcPkg([{ ...base, sourceAllocationId: 'nope' }]);
    expect(ledgerExportPackageSchema.safeParse(bad).success).toBe(false);
  });
  it('repeatEveryMonths < costMonths は invalid', () => {
    const bad = mcPkg([{ ...base, costMonths: 12, repeatEveryMonths: 6 }]);
    expect(ledgerExportPackageSchema.safeParse(bad).success).toBe(false);
  });
  it('仕訳の monthlyCostId が存在しないと invalid', () => {
    const pkg = mcPkg([base]) as Record<string, unknown>;
    pkg.journalEntries = [
      {
        id: 'e1',
        date: '2026-06-01',
        description: '購入',
        kind: 'normal',
        managementScopeId: 'scope-personal',
        lines: [
          { accountId: 'food', side: 'debit', amount: 100 },
          { accountId: 'cash', side: 'credit', amount: 100 },
        ],
        metadata: { inputMode: 'manual', monthlyCostId: 'nope' },
        createdAt: 'x',
        updatedAt: 'x',
      },
    ];
    expect(ledgerExportPackageSchema.safeParse(pkg).success).toBe(false);
  });
  it('予定CF の monthlyCostId が存在しないと invalid', () => {
    const pkg = mcPkg([base]) as Record<string, unknown>;
    pkg.cashflowSchedules = [
      {
        id: 's1',
        title: '返済',
        dueDate: '2026-07-10',
        amount: 100,
        direction: 'outflow',
        accountId: 'cash',
        counterAccountId: 'cash',
        source: 'installment',
        status: 'planned',
        managementScopeId: 'scope-personal',
        monthlyCostId: 'nope',
        createdAt: 'x',
        updatedAt: 'x',
      },
    ];
    expect(ledgerExportPackageSchema.safeParse(pkg).success).toBe(false);
  });
});
