import { describe, expect, it } from 'vitest';
import './setup';
import {
  entryMetadataSchema,
  journalEntrySchema,
  ledgerExportPackageSchema,
  monthlyCostItemSchema,
  recurringRuleSchema,
  reserveItemSchema,
} from '../src/domain/schema';
import {
  APP_ID,
  CONTINUOUS_COST_LEDGER_ACCOUNT_ID,
  RESERVE_LEDGER_ACCOUNT_ID,
  SCHEMA_VERSION,
} from '../src/domain/constants';

const validEntry = {
  id: 'e1',
  date: '2026-06-01',
  description: 'ランチ',
  kind: 'normal',
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
  it('存在しない日付を拒否し、閏日の実在日を受け入れる', () => {
    expect(journalEntrySchema.safeParse({ ...validEntry, date: '2024-02-29' }).success).toBe(true);
    for (const date of [
      '2026-02-29',
      '2026-02-31',
      '2026-04-31',
      '2026-13-01',
      '2026-00-01',
    ]) {
      expect(journalEntrySchema.safeParse({ ...validEntry, date }).success).toBe(false);
    }
  });
});

describe('年月の暦検証', () => {
  const rule = {
    id: 'r1',
    name: '家賃',
    amount: 100000,
    dayOfMonth: 27,
    debitAccountId: 'expense',
    creditAccountId: 'bank',
    startMonth: '2026-12',
    createdAt: 'x',
    updatedAt: 'x',
  };

  it('定期由来メタデータとルールの不正月を拒否する', () => {
    expect(entryMetadataSchema.safeParse({ recurringMonth: '2026-12' }).success).toBe(true);
    expect(entryMetadataSchema.safeParse({ recurringMonth: '2026-99' }).success).toBe(false);
    expect(recurringRuleSchema.safeParse(rule).success).toBe(true);
    expect(recurringRuleSchema.safeParse({ ...rule, startMonth: '2026-99' }).success).toBe(false);
    expect(
      recurringRuleSchema.safeParse({ ...rule, postedThroughMonth: '2026-00' }).success,
    ).toBe(false);
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
    cashflowSchedules: [],
    reserves: [],
    tags: [],
    monthlyCostItems: [],
    assetDisposals: [],
    recurringRules: [],
    settings: { ledgerName: '家計簿', currency: 'JPY', locale: 'ja' },
  };

  it('正しいパッケージを受け入れる', () => {
    expect(ledgerExportPackageSchema.safeParse(validPkg).success).toBe(true);
  });
  it('旧バージョン固有の余計なキーは strip される（撤去済みフィールドの残骸で取り込みが壊れない）', () => {
    const withLegacy = {
      ...validPkg,
      // 撤去済みの概念（旧 allocations 等）と、B 側レガシーのキー。
      allocations: [],
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
      // 出力に余計なキーは残らない（unknown key は strip）。
      const res = parsed.data as unknown as Record<string, unknown>;
      expect(res.allocations).toBeUndefined();
      expect(res.fundingGoals).toBeUndefined();
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
  it('現行以外の schemaVersion は直接の schema 検証でも拒否する', () => {
    expect(
      ledgerExportPackageSchema.safeParse({
        ...validPkg,
        schemaVersion: SCHEMA_VERSION - 1,
      }).success,
    ).toBe(false);
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
});

describe('entry metadata', () => {
  it('metadata なしの仕訳も有効', () => {
    expect(journalEntrySchema.safeParse(validEntry).success).toBe(true);
  });
  it('inputMode を含む仕訳を受け入れる', () => {
    const withMeta = {
      ...validEntry,
      metadata: { inputMode: 'expense' },
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
      cashflowSchedules: [],
      reserves: [],
      tags: [],
      monthlyCostItems: [],
      assetDisposals: [],
      recurringRules: [],
      settings: { ledgerName: '家計簿', currency: 'JPY', locale: 'ja' },
    };
    const parsed = ledgerExportPackageSchema.safeParse(pkg);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.journalEntries[0]?.metadata?.inputMode).toBe('reversal');
    }
  });
});

describe('残高補正 metadata の package 整合性', () => {
  const target = {
    id: 'cash',
    name: '現金',
    type: 'asset',
    role: 'daily-asset',
    archived: false,
    createdAt: 'x',
    updatedAt: 'x',
  };
  const counter = {
    id: 'balance-expense',
    name: '残高調整費',
    type: 'expense',
    role: 'system-adjustment',
    archived: false,
    createdAt: 'x',
    updatedAt: 'x',
  };
  const entry = {
    id: 'adjustment',
    date: '2026-06-30',
    description: '残高補正',
    kind: 'normal',
    lines: [
      { accountId: counter.id, side: 'debit', amount: 200 },
      { accountId: target.id, side: 'credit', amount: 200 },
    ],
    metadata: {
      inputMode: 'manual',
      adjustment: {
        accountId: target.id,
        expectedBalance: 1000,
        actualBalance: 800,
        delta: -200,
        counterpartAccountId: counter.id,
      },
    },
    createdAt: 'x',
    updatedAt: 'x',
  };
  const pkg = (entryValue: Record<string, unknown>, counterValue = counter) => ({
    appId: APP_ID,
    schemaVersion: SCHEMA_VERSION,
    ledgerId: 'ledger',
    exportedAt: '2026-06-01T00:00:00.000Z',
    deviceId: 'd',
    revision: 0,
    accounts: [target, counterValue],
    journalEntries: [entryValue],
    cashflowSchedules: [],
    reserves: [],
    tags: [],
    monthlyCostItems: [],
    assetDisposals: [],
    recurringRules: [],
    settings: { ledgerName: '家計簿', currency: 'JPY', locale: 'ja' },
  });

  it('相手が system-adjustment で明細と差額が一致する補正だけを受け入れる', () => {
    expect(ledgerExportPackageSchema.safeParse(pkg(entry)).success).toBe(true);
    expect(
      ledgerExportPackageSchema.safeParse(
        pkg(entry, { ...counter, role: 'expense-category' }),
      ).success,
    ).toBe(false);
    expect(
      ledgerExportPackageSchema.safeParse(
        pkg({
          ...entry,
          lines: [
            { accountId: target.id, side: 'debit', amount: 200 },
            { accountId: counter.id, side: 'credit', amount: 200 },
          ],
        }),
      ).success,
    ).toBe(false);
  });

  it('廃止済みの補正種別フィールド(kind)の残骸は strip され、取り込みを壊さない', () => {
    const parsed = ledgerExportPackageSchema.safeParse(
      pkg({
        ...entry,
        metadata: {
          ...entry.metadata,
          adjustment: { ...entry.metadata.adjustment, kind: 'obsolete' },
        },
      }),
    );
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      const adjustment = parsed.data.journalEntries[0]?.metadata?.adjustment as unknown as
        | Record<string, unknown>
        | undefined;
      expect(adjustment?.kind).toBeUndefined();
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

describe('予定CF・目的別資金の検証（package）', () => {
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
      accounts: [bank, card, reserveAcc],
      journalEntries: [],
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
      assetDisposals: [],
      recurringRules: [],
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
      accounts: [acc('food', 'expense'), acc('cash', 'asset')],
      journalEntries: [
        {
          id: 'e1',
          date: '2026-06-01',
          description: 'x',
          kind: 'normal',
          tagIds: ['trip'],
          lines: [
            { accountId: 'food', side: 'debit', amount: 1000 },
            { accountId: 'cash', side: 'credit', amount: 1000 },
          ],
          createdAt: 'x',
          updatedAt: 'x',
        },
      ],
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
      assetDisposals: [],
      recurringRules: [],
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

describe('月額化コスト(monthlyCostItems) の参照・不変条件検証', () => {
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
      accounts: [cash, food],
      journalEntries: [],
      cashflowSchedules: [],
      reserves: [],
      tags: [],
      monthlyCostItems: items,
      assetDisposals: [],
      recurringRules: [],
      settings: { ledgerName: '家計簿', currency: 'JPY', locale: 'ja' },
    };
  }
  const base = {
    id: 'm1',
    name: 'Netflix',
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
    expect(monthlyCostItemSchema.safeParse(base).success).toBe(true);
    expect(ledgerExportPackageSchema.safeParse(mcPkg([base])).success).toBe(true);
  });
  it('expenseAccountId は会計 type を問わず、存在する科目なら valid', () => {
    const otherType = { ...base, expenseAccountId: 'cash' };
    expect(monthlyCostItemSchema.safeParse(otherType).success).toBe(true);
    expect(ledgerExportPackageSchema.safeParse(mcPkg([otherType])).success).toBe(true);
  });
  it('存在しない expenseAccountId は package で invalid', () => {
    const bad = mcPkg([{ ...base, expenseAccountId: 'missing' }]);
    expect(ledgerExportPackageSchema.safeParse(bad).success).toBe(false);
  });
  it('paymentAccountId が日常資産/支払用負債でないと invalid', () => {
    const bad = mcPkg([{ ...base, paymentAccountId: 'food' }]);
    expect(ledgerExportPackageSchema.safeParse(bad).success).toBe(false);
  });
  it.each([
    ['repeatEveryMonths < costMonths', { costMonths: 12, repeatEveryMonths: 6 }],
    ['endMonth < startMonth の前月', { endMonth: '2026-04' }],
    // 前月の例外は「終了済み（使用0ヶ月処分）」限定。active には認めない。
    ['active で endMonth = startMonth の前月', { endMonth: '2026-05' }],
    ['paused なのに endMonth がない', { status: 'paused' }],
    ['ended なのに endMonth がない', { status: 'ended' }],
  ])('%s は item schema / package ともに invalid', (_label, patch) => {
    const invalid = { ...base, ...patch };
    expect(monthlyCostItemSchema.safeParse(invalid).success).toBe(false);
    expect(ledgerExportPackageSchema.safeParse(mcPkg([invalid])).success).toBe(false);
  });
  it.each([
    ['active・endMonth なし', {}],
    ['active・固定 endMonth あり', { endMonth: '2026-12' }],
    ['paused・endMonth あり', { status: 'paused', endMonth: '2026-12' }],
    ['ended・endMonth あり', { status: 'ended', endMonth: '2026-12' }],
    // 前月 = 使用0ヶ月のエンコード（購入と同じ月に処分すると保存境界が正当に書く）。
    ['ended・endMonth = startMonth の前月', { status: 'ended', endMonth: '2026-05' }],
  ])('%s は item schema / package ともに valid', (_label, patch) => {
    const valid = { ...base, ...patch };
    expect(monthlyCostItemSchema.safeParse(valid).success).toBe(true);
    expect(ledgerExportPackageSchema.safeParse(mcPkg([valid])).success).toBe(true);
  });
  it('認識先(expenseAccountId)に内部集約・残高調整の科目は package で invalid', () => {
    const ccLedger = {
      id: 'cc-ledger',
      name: '継続コスト台帳',
      type: 'asset',
      role: 'continuing-cost-asset',
      archived: false,
      createdAt: 'x',
      updatedAt: 'x',
    };
    const pkg = mcPkg([{ ...base, expenseAccountId: 'cc-ledger' }]);
    (pkg.accounts as Record<string, unknown>[]).push(ccLedger);
    expect(ledgerExportPackageSchema.safeParse(pkg).success).toBe(false);
  });
  it('初期残高(equity) funding の項目に repeatEveryMonths があると package で invalid', () => {
    const equity = {
      id: 'opening',
      name: '初期残高',
      type: 'equity',
      role: 'equity',
      archived: false,
      createdAt: 'x',
      updatedAt: 'x',
    };
    const item = {
      ...base,
      costMonths: 12,
      repeatEveryMonths: 12,
      paymentSourceAccountId: 'opening',
    };
    const pkg = mcPkg([item]);
    (pkg.accounts as Record<string, unknown>[]).push(equity);
    expect(ledgerExportPackageSchema.safeParse(pkg).success).toBe(false);
    // repeat を外せば valid（移行登録そのものは正当）。
    const okItem = { ...base, costMonths: 12, paymentSourceAccountId: 'opening' };
    const okPkg = mcPkg([okItem]);
    (okPkg.accounts as Record<string, unknown>[]).push(equity);
    expect(ledgerExportPackageSchema.safeParse(okPkg).success).toBe(true);
  });
  it('仕訳の monthlyCostId が存在しないと invalid', () => {
    const pkg = mcPkg([base]) as Record<string, unknown>;
    pkg.journalEntries = [
      {
        id: 'e1',
        date: '2026-06-01',
        description: '購入',
        kind: 'normal',
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
        monthlyCostId: 'nope',
        createdAt: 'x',
        updatedAt: 'x',
      },
    ];
    expect(ledgerExportPackageSchema.safeParse(pkg).success).toBe(false);
  });
});

describe('継続コスト処分の重複検証', () => {
  it('同一 monthlyCostId への処分が2件あると package で invalid', () => {
    const ledgerAccount = {
      id: CONTINUOUS_COST_LEDGER_ACCOUNT_ID,
      name: '継続コスト台帳',
      type: 'asset',
      role: 'continuing-cost-asset',
      archived: false,
      createdAt: 'x',
      updatedAt: 'x',
    };
    const item = {
      id: 'm1',
      name: '車の月額化',
      kind: 'durable-asset',
      amount: 120000,
      costMonths: 12,
      startMonth: '2026-01',
      expenseAccountId: 'food',
      recognitionCreditAccountId: CONTINUOUS_COST_LEDGER_ACCOUNT_ID,
      status: 'ended',
      endMonth: '2026-06',
      createdAt: 'x',
      updatedAt: 'x',
    };
    const disposal = (id: string) => ({
      id,
      monthlyCostId: 'm1',
      fixedAccountId: CONTINUOUS_COST_LEDGER_ACCOUNT_ID,
      disposalDate: '2026-07-15',
      proceedsAmount: 0,
      recognizedAmount: 120000,
      remainingAmount: 0,
      generatedEntryIds: [],
      createdAt: 'x',
      updatedAt: 'x',
    });
    const pkg = (disposals: Record<string, unknown>[]) => ({
      appId: APP_ID,
      schemaVersion: SCHEMA_VERSION,
      ledgerId: 'ledger',
      exportedAt: '2026-06-01T00:00:00.000Z',
      deviceId: 'd',
      revision: 0,
      accounts: [
        {
          id: 'food',
          name: '食費',
          type: 'expense',
          role: 'expense-category',
          archived: false,
          createdAt: 'x',
          updatedAt: 'x',
        },
        ledgerAccount,
      ],
      journalEntries: [],
      cashflowSchedules: [],
      reserves: [],
      tags: [],
      monthlyCostItems: [item],
      assetDisposals: disposals,
      recurringRules: [],
      settings: { ledgerName: '家計簿', currency: 'JPY', locale: 'ja' },
    });
    const single = ledgerExportPackageSchema.safeParse(pkg([disposal('d1')]));
    expect(single.success).toBe(true);
    expect(
      ledgerExportPackageSchema.safeParse(pkg([disposal('d1'), disposal('d2')])).success,
    ).toBe(false);
    expect(
      ledgerExportPackageSchema.safeParse({
        ...pkg([disposal('d1')]),
        monthlyCostItems: [{ ...item, status: 'active', endMonth: undefined }],
      }).success,
    ).toBe(false);
    expect(
      ledgerExportPackageSchema.safeParse(
        pkg([{ ...disposal('d1'), fixedAccountId: 'food' }]),
      ).success,
    ).toBe(false);
  });

  it('generatedEntryIds と仕訳 metadata は双方向に一致する必要がある', () => {
    const ledgerAccount = {
      id: CONTINUOUS_COST_LEDGER_ACCOUNT_ID,
      name: '継続コスト台帳',
      type: 'asset',
      role: 'continuing-cost-asset',
      archived: false,
      createdAt: 'x',
      updatedAt: 'x',
    };
    const bank = {
      id: 'bank',
      name: '預金',
      type: 'asset',
      role: 'daily-asset',
      archived: false,
      createdAt: 'x',
      updatedAt: 'x',
    };
    const item = {
      id: 'm1',
      name: '年払い',
      kind: 'prepaid-service',
      amount: 12000,
      costMonths: 12,
      startMonth: '2026-01',
      endMonth: '2026-07',
      expenseAccountId: 'food',
      paymentSourceAccountId: bank.id,
      recognitionCreditAccountId: ledgerAccount.id,
      disposalProceedsAmount: 500,
      status: 'ended',
      createdAt: 'x',
      updatedAt: 'x',
    };
    const disposal = {
      id: 'd1',
      monthlyCostId: item.id,
      fixedAccountId: ledgerAccount.id,
      disposalDate: '2026-07-15',
      proceedsAmount: 500,
      destinationAccountId: bank.id,
      recognizedAmount: 11500,
      remainingAmount: 0,
      generatedEntryIds: ['generated'],
      createdAt: 'x',
      updatedAt: 'x',
    };
    const generated = {
      id: 'generated',
      date: '2026-07-15',
      description: '売却',
      kind: 'normal',
      lines: [
        { accountId: bank.id, side: 'debit', amount: 500 },
        { accountId: ledgerAccount.id, side: 'credit', amount: 500 },
      ],
      metadata: { assetDisposalId: disposal.id },
      createdAt: 'x',
      updatedAt: 'x',
    };
    const base = {
      appId: APP_ID,
      schemaVersion: SCHEMA_VERSION,
      ledgerId: 'ledger',
      exportedAt: '2026-06-01T00:00:00.000Z',
      deviceId: 'd',
      revision: 0,
      accounts: [
        bank,
        ledgerAccount,
        {
          id: 'food',
          name: '食費',
          type: 'expense',
          role: 'expense-category',
          archived: false,
          createdAt: 'x',
          updatedAt: 'x',
        },
      ],
      journalEntries: [generated],
      cashflowSchedules: [],
      reserves: [],
      tags: [],
      monthlyCostItems: [item],
      assetDisposals: [disposal],
      recurringRules: [],
      settings: { ledgerName: '家計簿', currency: 'JPY', locale: 'ja' },
    };

    // 既存仕訳 ID を指す generatedEntryIds は許可する。
    expect(ledgerExportPackageSchema.safeParse(base).success).toBe(true);
    expect(
      ledgerExportPackageSchema.safeParse({
        ...base,
        assetDisposals: [{ ...disposal, generatedEntryIds: [] }],
      }).success,
    ).toBe(false);
    expect(
      ledgerExportPackageSchema.safeParse({
        ...base,
        journalEntries: [{ ...generated, metadata: undefined }],
      }).success,
    ).toBe(false);
  });
});
