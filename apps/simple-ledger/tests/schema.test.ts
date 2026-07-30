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
    everyMonths: 1,
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

describe('継続コスト資産(monthlyCostItems)の参照・不変条件検証（⑤⑥⑦⑧⑨）', () => {
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
  const ccLedger = {
    id: CONTINUOUS_COST_LEDGER_ACCOUNT_ID,
    name: '継続コスト台帳',
    type: 'asset',
    role: 'continuing-cost-asset',
    archived: false,
    createdAt: 'x',
    updatedAt: 'x',
  };
  const base = {
    id: 'm1',
    name: '年払いクラウド',
    amount: 12000,
    startDate: '2026-06-15',
    endDate: '2027-05-31',
    expenseAccountId: 'food',
    createdAt: 'x',
    updatedAt: 'x',
  };
  /** 購入の仕訳（借方 台帳 / 貸方 現金・item と金額/日付が完全一致）。 */
  function purchaseOf(item: Record<string, unknown>, over: Record<string, unknown> = {}) {
    return {
      id: `p-${item.id as string}`,
      date: item.startDate,
      description: item.name,
      kind: 'normal',
      lines: [
        { accountId: CONTINUOUS_COST_LEDGER_ACCOUNT_ID, side: 'debit', amount: item.amount },
        { accountId: 'cash', side: 'credit', amount: item.amount },
      ],
      metadata: { inputMode: 'expense', monthlyCostId: item.id },
      createdAt: 'x',
      updatedAt: 'x',
      ...over,
    };
  }
  function mcPkg(items: Record<string, unknown>[], entries?: Record<string, unknown>[]) {
    return {
      appId: APP_ID,
      schemaVersion: SCHEMA_VERSION,
      ledgerId: 'ledger',
      exportedAt: '2026-06-01T00:00:00.000Z',
      deviceId: 'd',
      revision: 0,
      accounts: [cash, food, ccLedger],
      journalEntries: entries ?? items.map((item) => purchaseOf(item)),
      cashflowSchedules: [],
      reserves: [],
      tags: [],
      monthlyCostItems: items,
      recurringRules: [],
      settings: { ledgerName: '家計簿', currency: 'JPY', locale: 'ja' },
    };
  }

  it('正しい item + 購入の仕訳は valid（終了日なしも valid）', () => {
    expect(monthlyCostItemSchema.safeParse(base).success).toBe(true);
    expect(ledgerExportPackageSchema.safeParse(mcPkg([base])).success).toBe(true);
    const open = { ...base };
    delete (open as Record<string, unknown>).endDate;
    expect(monthlyCostItemSchema.safeParse(open).success).toBe(true);
    expect(ledgerExportPackageSchema.safeParse(mcPkg([open])).success).toBe(true);
  });
  it('endDate < startDate / 暦にない日付 / 1200ヶ月超は item schema で invalid', () => {
    expect(monthlyCostItemSchema.safeParse({ ...base, endDate: '2026-06-14' }).success).toBe(false);
    expect(monthlyCostItemSchema.safeParse({ ...base, endDate: '2027-02-30' }).success).toBe(false);
    expect(monthlyCostItemSchema.safeParse({ ...base, startDate: '2026/06/15' }).success).toBe(
      false,
    );
    expect(monthlyCostItemSchema.safeParse({ ...base, endDate: '2126-06-30' }).success).toBe(false);
    // ちょうど 1200ヶ月（2026-06 〜 2126-05）は valid。
    expect(monthlyCostItemSchema.safeParse({ ...base, endDate: '2126-05-31' }).success).toBe(true);
  });
  it('存在しない/内部集約の expenseAccountId は package で invalid', () => {
    expect(
      ledgerExportPackageSchema.safeParse(mcPkg([{ ...base, expenseAccountId: 'missing' }]))
        .success,
    ).toBe(false);
    expect(
      ledgerExportPackageSchema.safeParse(
        mcPkg([{ ...base, expenseAccountId: CONTINUOUS_COST_LEDGER_ACCOUNT_ID }]),
      ).success,
    ).toBe(false);
  });
  it('⑥ 購入の仕訳がちょうど 1 件（0 件・2 件は invalid）', () => {
    expect(ledgerExportPackageSchema.safeParse(mcPkg([base], [])).success).toBe(false);
    expect(
      ledgerExportPackageSchema.safeParse(
        mcPkg([base], [purchaseOf(base), purchaseOf(base, { id: 'p-dup' })]),
      ).success,
    ).toBe(false);
  });
  it('⑦ 購入の仕訳は日付・金額が item と完全一致（日レベル）・借方 = 台帳・貸方 role 制限', () => {
    // 同じ月でも日が違えば invalid（月レベル一致にしない＝初月の台帳マイナスを防ぐ）。
    expect(
      ledgerExportPackageSchema.safeParse(mcPkg([base], [purchaseOf(base, { date: '2026-06-01' })]))
        .success,
    ).toBe(false);
    // 金額不一致。
    expect(
      ledgerExportPackageSchema.safeParse(
        mcPkg(
          [base],
          [
            purchaseOf(base, {
              lines: [
                { accountId: CONTINUOUS_COST_LEDGER_ACCOUNT_ID, side: 'debit', amount: 9999 },
                { accountId: 'cash', side: 'credit', amount: 9999 },
              ],
            }),
          ],
        ),
      ).success,
    ).toBe(false);
    // 借方が台帳でない。
    expect(
      ledgerExportPackageSchema.safeParse(
        mcPkg(
          [base],
          [
            purchaseOf(base, {
              lines: [
                { accountId: 'food', side: 'debit', amount: 12000 },
                { accountId: 'cash', side: 'credit', amount: 12000 },
              ],
            }),
          ],
        ),
      ).success,
    ).toBe(false);
    // 貸方 role が費用カテゴリ（資金・負債・初期残高のどれでもない）。
    expect(
      ledgerExportPackageSchema.safeParse(
        mcPkg(
          [base],
          [
            purchaseOf(base, {
              lines: [
                { accountId: CONTINUOUS_COST_LEDGER_ACCOUNT_ID, side: 'debit', amount: 12000 },
                { accountId: 'food', side: 'credit', amount: 12000 },
              ],
            }),
          ],
        ),
      ).success,
    ).toBe(false);
  });
  it('⑧ 台帳にふれる保存仕訳は monthlyCostId が必須（§13-14 の import 側）', () => {
    const plain = {
      id: 'e-ledger',
      date: '2026-06-15',
      description: '台帳へ直接',
      kind: 'normal',
      lines: [
        { accountId: CONTINUOUS_COST_LEDGER_ACCOUNT_ID, side: 'debit', amount: 100 },
        { accountId: 'cash', side: 'credit', amount: 100 },
      ],
      createdAt: 'x',
      updatedAt: 'x',
    };
    expect(
      ledgerExportPackageSchema.safeParse(mcPkg([base], [purchaseOf(base), plain])).success,
    ).toBe(false);
  });
  it('⑨ 回収の振替は貸方 = 台帳・回収額に上限なし（購入額超の valid を確認）', () => {
    const recovery = (amount: number, over: Record<string, unknown> = {}) => ({
      id: 'e-recovery',
      date: '2026-12-31',
      description: '売却',
      kind: 'normal',
      lines: [
        { accountId: 'cash', side: 'debit', amount },
        { accountId: CONTINUOUS_COST_LEDGER_ACCOUNT_ID, side: 'credit', amount },
      ],
      metadata: { inputMode: 'transfer', monthlyCostId: 'm1', monthlyCostRecovery: true },
      createdAt: 'x',
      updatedAt: 'x',
      ...over,
    });
    expect(
      ledgerExportPackageSchema.safeParse(mcPkg([base], [purchaseOf(base), recovery(3000)]))
        .success,
    ).toBe(true);
    // 回収額 > 購入額 でも valid（過去にわたる費用減）。
    expect(
      ledgerExportPackageSchema.safeParse(mcPkg([base], [purchaseOf(base), recovery(99999)]))
        .success,
    ).toBe(true);
    // 貸方が台帳でない回収の振替は invalid。
    expect(
      ledgerExportPackageSchema.safeParse(
        mcPkg(
          [base],
          [
            purchaseOf(base),
            recovery(3000, {
              lines: [
                { accountId: CONTINUOUS_COST_LEDGER_ACCOUNT_ID, side: 'debit', amount: 3000 },
                { accountId: 'cash', side: 'credit', amount: 3000 },
              ],
            }),
          ],
        ),
      ).success,
    ).toBe(false);
  });
  it('⑤ 同一ルール由来の item（ccr-{ruleId}-{month}）の月区間が重なると invalid（§13-12）', () => {
    const cycle = (month: string, startDate: string, endDate: string) => ({
      id: `ccr-rule1-${month}`,
      name: '火災保険',
      amount: 60000,
      startDate,
      endDate,
      expenseAccountId: 'food',
      createdAt: 'x',
      updatedAt: 'x',
    });
    const a = cycle('2026-04', '2026-04-25', '2027-03-31');
    const b = cycle('2027-04', '2027-04-25', '2028-03-31');
    expect(ledgerExportPackageSchema.safeParse(mcPkg([a, b])).success).toBe(true);
    // a の終了日を伸ばして 2027-04 と重ねると invalid（当該月が 2 倍計上される）。
    const overlapped = { ...a, endDate: '2027-04-30' };
    const pkg = mcPkg([overlapped, b]);
    expect(ledgerExportPackageSchema.safeParse(pkg).success).toBe(false);
  });
  it('仕訳・予定CF の monthlyCostId が存在しないと invalid', () => {
    const dangling = purchaseOf(base, { metadata: { inputMode: 'expense', monthlyCostId: 'no' } });
    expect(ledgerExportPackageSchema.safeParse(mcPkg([], [dangling])).success).toBe(false);
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

describe('勘定科目のアーカイブ不変条件（アーカイブ済み = 残高 0）', () => {
  const food = {
    id: 'food',
    name: '食費',
    type: 'expense',
    role: 'expense-category',
    archived: false,
    createdAt: 'x',
    updatedAt: 'x',
  };
  function pkgWith(accounts: Record<string, unknown>[], entries: Record<string, unknown>[]) {
    return {
      appId: APP_ID,
      schemaVersion: SCHEMA_VERSION,
      ledgerId: 'ledger',
      exportedAt: '2026-06-01T00:00:00.000Z',
      deviceId: 'd',
      revision: 0,
      accounts,
      journalEntries: entries,
      cashflowSchedules: [],
      reserves: [],
      tags: [],
      monthlyCostItems: [],
      recurringRules: [],
      settings: { ledgerName: '家計簿', currency: 'JPY', locale: 'ja' },
    };
  }
  const wallet = (archived: boolean) => ({
    id: 'wallet',
    name: '旧財布',
    type: 'asset',
    role: 'daily-asset',
    archived,
    createdAt: 'x',
    updatedAt: 'x',
  });
  const spend = {
    id: 'e1',
    date: '2026-06-01',
    description: '支出',
    kind: 'normal',
    lines: [
      { accountId: 'food', side: 'debit', amount: 1000 },
      { accountId: 'wallet', side: 'credit', amount: 1000 },
    ],
    createdAt: 'x',
    updatedAt: 'x',
  };
  const topUp = {
    id: 'e0',
    date: '2026-05-01',
    description: '入金',
    kind: 'normal',
    lines: [
      { accountId: 'wallet', side: 'debit', amount: 1000 },
      { accountId: 'food', side: 'credit', amount: 1000 },
    ],
    createdAt: 'x',
    updatedAt: 'x',
  };

  it('残高が 0 でない資産をアーカイブ済みにした package は invalid', () => {
    expect(
      ledgerExportPackageSchema.safeParse(pkgWith([wallet(true), food], [topUp])).success,
    ).toBe(false);
  });
  it('最終残高 0 なら archived でも valid・未アーカイブは残高があっても valid', () => {
    expect(
      ledgerExportPackageSchema.safeParse(pkgWith([wallet(true), food], [topUp, spend])).success,
    ).toBe(true);
    expect(
      ledgerExportPackageSchema.safeParse(pkgWith([wallet(false), food], [topUp])).success,
    ).toBe(true);
  });
});
