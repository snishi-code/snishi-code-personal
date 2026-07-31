import { describe, expect, it } from 'vitest';
import './setup';
import {
  accountSchema,
  entryMetadataSchema,
  journalEntrySchema,
  ledgerExportPackageSchema,
  monthlyCostItemSchema,
  recurringRuleSchema,
} from '../src/domain/schema';
import { APP_ID, CONTINUOUS_COST_LEDGER_ACCOUNT_ID, SCHEMA_VERSION } from '../src/domain/constants';

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
const removedRecognitionKey = ['monthly', 'Cost', 'Recognition'].join('');

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
    for (const date of ['2026-02-29', '2026-02-31', '2026-04-31', '2026-13-01', '2026-00-01']) {
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
    startDate: '2026-12-01',
    createdAt: 'x',
    updatedAt: 'x',
  };

  it('定期由来メタデータとルールの不正月を拒否する', () => {
    expect(entryMetadataSchema.safeParse({ recurringMonth: '2026-12' }).success).toBe(true);
    expect(entryMetadataSchema.safeParse({ recurringMonth: '2026-99' }).success).toBe(false);
    expect(recurringRuleSchema.safeParse(rule).success).toBe(true);
    const missingStartDate = { ...rule } as Record<string, unknown>;
    delete missingStartDate.startDate;
    expect(recurringRuleSchema.safeParse(missingStartDate).success).toBe(false);
    expect(recurringRuleSchema.safeParse({ ...rule, startMonth: '2026-99' }).success).toBe(false);
    expect(recurringRuleSchema.safeParse({ ...rule, postedThroughMonth: '2026-00' }).success).toBe(
      false,
    );
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

describe('勘定科目の存在期間（schema/import）', () => {
  const account = (
    id: string,
    name: string,
    type: string,
    role: string,
    lifetime: Record<string, unknown> = {},
  ) => ({
    id,
    name,
    type,
    role,
    archived: false,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...lifetime,
  });
  const cash = account('cash', '預金', 'asset', 'daily-asset');
  const food = account('food', '食費', 'expense', 'expense-category');
  const basePackage = (overrides: Record<string, unknown> = {}) => ({
    appId: APP_ID,
    schemaVersion: SCHEMA_VERSION,
    ledgerId: 'ledger',
    exportedAt: '2026-06-01T00:00:00.000Z',
    deviceId: 'device',
    revision: 0,
    accounts: [cash, food],
    journalEntries: [],
    cashflowSchedules: [],
    tags: [],
    monthlyCostItems: [],
    recurringRules: [],
    settings: { ledgerName: '家計簿', currency: 'JPY', locale: 'ja' },
    ...overrides,
  });

  it('端点なしの旧データと正しい明示端点を受理し、不正日付・開始後の終了を拒否する', () => {
    expect(accountSchema.safeParse(cash).success).toBe(true);
    expect(
      accountSchema.safeParse({
        ...cash,
        archived: true,
        startDate: '2026-01-01',
        endDate: '2026-12-31',
      }).success,
    ).toBe(true);
    expect(accountSchema.safeParse({ ...cash, endDate: '2026-12-31' }).success).toBe(false);
    expect(accountSchema.safeParse({ ...cash, startDate: '2026-02-30' }).success).toBe(false);
    expect(
      accountSchema.safeParse({
        ...cash,
        archived: true,
        startDate: '2026-02-02',
        endDate: '2026-02-01',
      }).success,
    ).toBe(false);
    expect(ledgerExportPackageSchema.safeParse(basePackage()).success).toBe(true);
  });

  it('exportedAt が不正でも未来終了の同名科目を終了済みと推測しない', () => {
    const duplicateName = '将来も有効';
    expect(
      ledgerExportPackageSchema.safeParse(
        basePackage({
          exportedAt: 'invalid',
          accounts: [
            {
              ...cash,
              name: duplicateName,
              archived: true,
              startDate: '2026-01-01',
              endDate: '2099-12-31',
            },
            { ...food, name: duplicateName },
          ],
        }),
      ).success,
    ).toBe(false);
  });

  it('明示端点は科目が関与する全仕訳日を包含する', () => {
    const journalEntries = [
      {
        ...validEntry,
        date: '2026-06-15',
        lines: [
          { accountId: 'food', side: 'debit', amount: 1000 },
          { accountId: 'cash', side: 'credit', amount: 1000 },
        ],
      },
    ];
    expect(
      ledgerExportPackageSchema.safeParse(
        basePackage({
          accounts: [
            { ...cash, startDate: '2026-06-15' },
            {
              ...food,
              archived: true,
              startDate: '2026-06-15',
              endDate: '2026-06-15',
            },
          ],
          journalEntries,
        }),
      ).success,
    ).toBe(true);
    expect(
      ledgerExportPackageSchema.safeParse(
        basePackage({
          accounts: [{ ...cash, startDate: '2026-06-16' }, food],
          journalEntries,
        }),
      ).success,
    ).toBe(false);
    expect(
      ledgerExportPackageSchema.safeParse(
        basePackage({
          accounts: [cash, { ...food, archived: true, endDate: '2026-06-14' }],
          journalEntries,
        }),
      ).success,
    ).toBe(false);
  });

  it('累計が残る費用の終了点は受理し、明示した両端をround-tripで保持する', () => {
    const journalEntries = [
      {
        ...validEntry,
        date: '2026-06-15',
        lines: [
          { accountId: 'food', side: 'debit', amount: 1000 },
          { accountId: 'cash', side: 'credit', amount: 1000 },
        ],
      },
    ];
    const parsed = ledgerExportPackageSchema.safeParse(
      basePackage({
        accounts: [
          { ...cash, startDate: '2026-01-01' },
          {
            ...food,
            archived: true,
            startDate: '2026-06-01',
            endDate: '2026-06-30',
          },
        ],
        journalEntries,
      }),
    );

    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.accounts.find((candidate) => candidate.id === 'food')).toMatchObject({
        startDate: '2026-06-01',
        endDate: '2026-06-30',
      });
    }
  });

  it('終了点で残高が残る資産は拒否するが、端点のない旧アーカイブ形状は受理する', () => {
    const journalEntries = [
      {
        ...validEntry,
        date: '2026-06-15',
        lines: [
          { accountId: 'food', side: 'debit', amount: 1000 },
          { accountId: 'cash', side: 'credit', amount: 1000 },
        ],
      },
    ];
    expect(
      ledgerExportPackageSchema.safeParse(
        basePackage({
          accounts: [{ ...cash, archived: true, endDate: '2026-06-30' }, food],
          journalEntries,
        }),
      ).success,
    ).toBe(false);
    expect(
      ledgerExportPackageSchema.safeParse(
        basePackage({
          accounts: [{ ...cash, archived: true }, food],
        }),
      ).success,
    ).toBe(true);
  });

  it('予定CFの口座・相手科目は期日を包含する', () => {
    const card = account('card', 'カード', 'liability', 'payment-liability');
    const schedule = {
      id: 'schedule',
      title: '引き落とし',
      dueDate: '2026-07-10',
      amount: 1000,
      direction: 'outflow',
      accountId: 'cash',
      counterAccountId: 'card',
      source: 'manual',
      status: 'planned',
      createdAt: 'x',
      updatedAt: 'x',
    };
    expect(
      ledgerExportPackageSchema.safeParse(
        basePackage({
          accounts: [{ ...cash, endDate: '2026-07-09' }, card],
          cashflowSchedules: [schedule],
        }),
      ).success,
    ).toBe(false);
    expect(
      ledgerExportPackageSchema.safeParse(
        basePackage({
          accounts: [cash, { ...card, startDate: '2026-07-11' }],
          cashflowSchedules: [schedule],
        }),
      ).success,
    ).toBe(false);
  });

  it('継続コストの費用科目と集約台帳はitemの全期間を包含する', () => {
    const ledger = account(
      CONTINUOUS_COST_LEDGER_ACCOUNT_ID,
      '継続コスト台帳',
      'asset',
      'continuing-cost-asset',
    );
    const item = {
      id: 'item',
      name: '年払い',
      amount: 1200,
      startDate: '2026-02-10',
      endDate: '2026-05-31',
      expenseAccountId: 'food',
      createdAt: 'x',
      updatedAt: 'x',
    };
    const purchase = {
      id: 'purchase',
      date: item.startDate,
      description: item.name,
      kind: 'normal',
      lines: [
        { accountId: ledger.id, side: 'debit', amount: item.amount },
        { accountId: cash.id, side: 'credit', amount: item.amount },
      ],
      metadata: { monthlyCostId: item.id },
      createdAt: 'x',
      updatedAt: 'x',
    };
    const itemPackage = (accounts: unknown[], itemValue: Record<string, unknown> = item) =>
      basePackage({
        accounts,
        journalEntries: [purchase],
        monthlyCostItems: [itemValue],
      });

    expect(ledgerExportPackageSchema.safeParse(itemPackage([cash, food, ledger])).success).toBe(
      true,
    );
    expect(
      ledgerExportPackageSchema.safeParse(
        itemPackage([cash, { ...food, endDate: '2026-05-30' }, ledger]),
      ).success,
    ).toBe(false);
    expect(
      ledgerExportPackageSchema.safeParse(
        itemPackage([cash, food, { ...ledger, endDate: '2026-05-30' }]),
      ).success,
    ).toBe(false);
    const openItem = { ...item } as Record<string, unknown>;
    delete openItem.endDate;
    expect(
      ledgerExportPackageSchema.safeParse(
        itemPackage([cash, { ...food, endDate: '2099-12-31' }, ledger], openItem),
      ).success,
    ).toBe(false);
  });

  it('定期ルールの参照は開始日から終了なしの開区間として扱う', () => {
    const ledger = account(
      CONTINUOUS_COST_LEDGER_ACCOUNT_ID,
      '継続コスト台帳',
      'asset',
      'continuing-cost-asset',
    );
    const rule = {
      id: 'rule',
      name: '毎月の支出',
      amount: 1000,
      dayOfMonth: 31,
      everyMonths: 1,
      debitAccountId: ledger.id,
      spreadExpenseAccountId: 'food',
      creditAccountId: 'cash',
      startMonth: '2026-04',
      startDate: '2026-04-01',
      createdAt: 'x',
      updatedAt: 'x',
    };
    expect(
      ledgerExportPackageSchema.safeParse(
        basePackage({ accounts: [cash, food, ledger], recurringRules: [rule] }),
      ).success,
    ).toBe(true);
    expect(
      ledgerExportPackageSchema.safeParse(
        basePackage({
          accounts: [{ ...cash, endDate: '2099-12-31' }, food, ledger],
          recurringRules: [rule],
        }),
      ).success,
    ).toBe(false);
    expect(
      ledgerExportPackageSchema.safeParse(
        basePackage({
          accounts: [cash, { ...food, startDate: '2026-05-01' }, ledger],
          recurringRules: [rule],
        }),
      ).success,
    ).toBe(false);
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
        {
          ...validEntry,
          metadata: {
            inputMode: 'reversal',
            reversalOfEntryId: 'z',
            [removedRecognitionKey]: true,
          },
        },
      ],
      cashflowSchedules: [],
      tags: [],
      monthlyCostItems: [],
      recurringRules: [],
      settings: { ledgerName: '家計簿', currency: 'JPY', locale: 'ja' },
    };
    const parsed = ledgerExportPackageSchema.safeParse(pkg);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.journalEntries[0]?.metadata?.inputMode).toBe('reversal');
      // 廃止済みの旧分類印は未知キーとして strip し、JSON 全体の受理は維持する。
      expect(parsed.data.journalEntries[0]?.metadata).not.toHaveProperty(removedRecognitionKey);
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
    tags: [],
    monthlyCostItems: [],
    recurringRules: [],
    settings: { ledgerName: '家計簿', currency: 'JPY', locale: 'ja' },
  });

  it('相手が system-adjustment で明細と差額が一致する補正だけを受け入れる', () => {
    expect(ledgerExportPackageSchema.safeParse(pkg(entry)).success).toBe(true);
    expect(
      ledgerExportPackageSchema.safeParse(pkg(entry, { ...counter, role: 'expense-category' }))
        .success,
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

describe('予定CFの検証（package）', () => {
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
  function cfPkg(over: Record<string, unknown> = {}) {
    return {
      appId: APP_ID,
      schemaVersion: SCHEMA_VERSION,
      ledgerId: 'ledger',
      exportedAt: '2026-06-01T00:00:00.000Z',
      deviceId: 'd',
      revision: 0,
      accounts: [bank, card],
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
      tags: [],
      monthlyCostItems: [],
      recurringRules: [],
      settings: { ledgerName: '家計簿', currency: 'JPY', locale: 'ja' },
      ...over,
    };
  }

  it('正しい予定CFは valid', () => {
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

describe('継続コスト資産(monthlyCostItems)の参照・不変条件検証（⑥⑦⑧⑨）', () => {
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
  it('集約台帳の well-known ID を別 role として使うパッケージは invalid', () => {
    const invalid = {
      ...mcPkg([base]),
      accounts: [cash, food, { ...ccLedger, name: '偽の台帳', role: 'daily-asset' as const }],
    };
    expect(ledgerExportPackageSchema.safeParse(invalid).success).toBe(false);
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
  it('⑦ 購入の仕訳は日付・金額が item と完全一致（日レベル）・借方 = 台帳', () => {
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
  });
  it('⑦ 購入の仕訳の貸方（支払い元）は起票可能な全 role（費用カテゴリも可・内部集約は不可）', () => {
    // 貸方 = 費用カテゴリも valid（種別の役割制限は撤廃。給与など income-category も同様）。
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
    ).toBe(true);
    // 貸方 = 残高調整科目（system-adjustment）は invalid（RECURRING_POSTABLE_ROLES 外）。
    const adj = {
      id: 'adj',
      name: '残高調整費',
      type: 'expense',
      role: 'system-adjustment',
      archived: false,
      createdAt: 'x',
      updatedAt: 'x',
    };
    const pkg = mcPkg(
      [base],
      [
        purchaseOf(base, {
          lines: [
            { accountId: CONTINUOUS_COST_LEDGER_ACCOUNT_ID, side: 'debit', amount: 12000 },
            { accountId: 'adj', side: 'credit', amount: 12000 },
          ],
        }),
      ],
    ) as Record<string, unknown>;
    pkg.accounts = [cash, food, ccLedger, adj];
    expect(ledgerExportPackageSchema.safeParse(pkg).success).toBe(false);
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
  it('同一ルール由来の item は生成後に独立し、月区間が重なっても valid', () => {
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
    const rule = {
      id: 'rule1',
      name: '火災保険',
      amount: 60000,
      dayOfMonth: 25,
      everyMonths: 12,
      debitAccountId: CONTINUOUS_COST_LEDGER_ACCOUNT_ID,
      spreadExpenseAccountId: 'food',
      creditAccountId: 'cash',
      startMonth: '2026-04',
      startDate: '2026-04-01',
      createdAt: 'x',
      updatedAt: 'x',
    };
    const rulePkg = (items: Record<string, unknown>[]) => ({
      ...mcPkg(
        items,
        items.map((item) => {
          const month = (item.id as string).slice(-7);
          return purchaseOf(item, {
            id: `rec-${rule.id}-${month}`,
            metadata: {
              inputMode: 'expense',
              monthlyCostId: item.id,
              recurringRuleId: rule.id,
              recurringMonth: month,
            },
          });
        }),
      ),
      recurringRules: [rule],
    });
    const a = cycle('2026-04', '2026-04-25', '2027-03-31');
    const b = cycle('2027-04', '2027-04-25', '2028-03-31');
    expect(ledgerExportPackageSchema.safeParse(rulePkg([a, b])).success).toBe(true);
    // a の終了日を伸ばして 2027-04 と重ねても、それぞれの生成事実を保つ。
    const overlapped = { ...a, endDate: '2027-04-30' };
    const pkg = rulePkg([overlapped, b]);
    expect(ledgerExportPackageSchema.safeParse(pkg).success).toBe(true);
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

describe('終了点がない旧アーカイブ形状の受理', () => {
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

  it('endDate のない旧 archived レコードには終了点残高を要求しない', () => {
    // 終了点がない旧形状には残高を測る基準日がない。新モデルの終了点残高 0 は
    // endDate が明示された資産・負債へだけ適用し、この旧 JSON は引き続き受理する。
    expect(
      ledgerExportPackageSchema.safeParse(pkgWith([wallet(true), food], [topUp])).success,
    ).toBe(true);
    expect(
      ledgerExportPackageSchema.safeParse(pkgWith([wallet(true), food], [topUp, spend])).success,
    ).toBe(true);
    expect(
      ledgerExportPackageSchema.safeParse(pkgWith([wallet(false), food], [topUp])).success,
    ).toBe(true);
  });
});

describe('accountSchema の movable（「自由に動かせる」フラグ）正規化', () => {
  const daily = {
    id: 'cash',
    name: '現金',
    type: 'asset',
    role: 'daily-asset',
    archived: false,
    createdAt: 'x',
    updatedAt: 'x',
  };

  it('movable: false（daily-asset）は保持する', () => {
    const parsed = accountSchema.safeParse({ ...daily, movable: false });
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.movable).toBe(false);
  });
  it('movable: true は undefined へ正規化する（レコードを最小に保つ）', () => {
    const parsed = accountSchema.safeParse({ ...daily, movable: true });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.movable).toBeUndefined();
      expect('movable' in parsed.data).toBe(false);
    }
  });
  it('daily-asset 以外に付いた movable は剥がす（fail-soft・拒否しない）', () => {
    const invest = { ...daily, id: 'nisa', name: 'NISA', role: 'investment-asset' };
    const parsed = accountSchema.safeParse({ ...invest, movable: false });
    expect(parsed.success).toBe(true);
    if (parsed.success) expect('movable' in parsed.data).toBe(false);
  });
  it('package を通しても movable: false が保持される', () => {
    const pkg = {
      appId: APP_ID,
      schemaVersion: SCHEMA_VERSION,
      ledgerId: 'ledger',
      exportedAt: '2026-06-01T00:00:00.000Z',
      deviceId: 'd',
      revision: 0,
      accounts: [{ ...daily, id: 'suica', name: 'Suica', movable: false }],
      journalEntries: [],
      cashflowSchedules: [],
      tags: [],
      monthlyCostItems: [],
      recurringRules: [],
      settings: { ledgerName: '家計簿', currency: 'JPY', locale: 'ja' },
    };
    const parsed = ledgerExportPackageSchema.safeParse(pkg);
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.accounts[0]?.movable).toBe(false);
  });
});

describe('月割りするルールの schema（周期にかかわらず台帳経由・支払い元は全 role）', () => {
  const spreadRule = {
    id: 'r-rent',
    name: '家賃',
    amount: 80000,
    dayOfMonth: 27,
    everyMonths: 1,
    spreadExpenseAccountId: 'fixed',
    debitAccountId: CONTINUOUS_COST_LEDGER_ACCOUNT_ID,
    creditAccountId: 'bank',
    startMonth: '2026-07',
    startDate: '2026-07-01',
    createdAt: 'x',
    updatedAt: 'x',
  };

  it('everyMonths = 1 の月割りルールは valid（毎月の家賃も台帳経由）', () => {
    expect(recurringRuleSchema.safeParse(spreadRule).success).toBe(true);
  });
  it('月割りルールの借方は引き続き台帳固定', () => {
    expect(recurringRuleSchema.safeParse({ ...spreadRule, debitAccountId: 'bank' }).success).toBe(
      false,
    );
  });

  const bank = {
    id: 'bank',
    name: '普通預金',
    type: 'asset',
    role: 'daily-asset',
    archived: false,
    createdAt: 'x',
    updatedAt: 'x',
  };
  const salary = {
    id: 'salary',
    name: '給与',
    type: 'revenue',
    role: 'income-category',
    archived: false,
    createdAt: 'x',
    updatedAt: 'x',
  };
  const fixed = {
    id: 'fixed',
    name: '固定費',
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
  const adj = {
    id: 'adj',
    name: '残高調整費',
    type: 'expense',
    role: 'system-adjustment',
    archived: false,
    createdAt: 'x',
    updatedAt: 'x',
  };
  function rulePkg(rule: Record<string, unknown>) {
    return {
      appId: APP_ID,
      schemaVersion: SCHEMA_VERSION,
      ledgerId: 'ledger',
      exportedAt: '2026-06-01T00:00:00.000Z',
      deviceId: 'd',
      revision: 0,
      accounts: [bank, salary, fixed, ccLedger, adj],
      journalEntries: [],
      cashflowSchedules: [],
      tags: [],
      monthlyCostItems: [],
      recurringRules: [rule],
      settings: { ledgerName: '家計簿', currency: 'JPY', locale: 'ja' },
    };
  }

  it('package: 源泉（支払い元）は income-category でも valid（健康保険 = 銀行→給与 の逆方向も可）', () => {
    expect(
      ledgerExportPackageSchema.safeParse(rulePkg({ ...spreadRule, creditAccountId: 'salary' }))
        .success,
    ).toBe(true);
  });
  it('package: 費用の論理的な行き先と源泉が同一なルールは invalid', () => {
    expect(
      ledgerExportPackageSchema.safeParse(
        rulePkg({ ...spreadRule, creditAccountId: spreadRule.spreadExpenseAccountId }),
      ).success,
    ).toBe(false);
  });
  it('package: spread の行き先は費用科目だけ valid', () => {
    expect(
      ledgerExportPackageSchema.safeParse(
        rulePkg({ ...spreadRule, spreadExpenseAccountId: 'salary' }),
      ).success,
    ).toBe(false);
    expect(
      ledgerExportPackageSchema.safeParse(
        rulePkg({
          ...spreadRule,
          spreadExpenseAccountId: undefined,
          debitAccountId: 'fixed',
        }),
      ).success,
    ).toBe(false);
  });
  it('package: 源泉・費用の行き先とも残高調整科目（system-adjustment）は invalid', () => {
    expect(
      ledgerExportPackageSchema.safeParse(rulePkg({ ...spreadRule, creditAccountId: 'adj' }))
        .success,
    ).toBe(false);
    expect(
      ledgerExportPackageSchema.safeParse(rulePkg({ ...spreadRule, spreadExpenseAccountId: 'adj' }))
        .success,
    ).toBe(false);
  });
});
