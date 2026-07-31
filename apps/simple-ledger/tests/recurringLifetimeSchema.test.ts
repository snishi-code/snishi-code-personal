import { describe, expect, it } from 'vitest';
import { APP_ID, CONTINUOUS_COST_LEDGER_ACCOUNT_ID, SCHEMA_VERSION } from '../src/domain/constants';
import { ledgerExportPackageSchema, recurringRuleSchema } from '../src/domain/schema';
import type { JournalEntry, MonthlyCostItem, RecurringRule } from '../src/domain/types';

const cash = {
  id: 'cash',
  name: '預金',
  type: 'asset',
  role: 'daily-asset',
  archived: false,
  startDate: '2026-01-01',
  createdAt: 'x',
  updatedAt: 'x',
};
const investment = {
  id: 'investment',
  name: '投資',
  type: 'asset',
  role: 'investment-asset',
  archived: false,
  startDate: '2026-01-01',
  createdAt: 'x',
  updatedAt: 'x',
};
const expense = {
  id: 'expense',
  name: '固定費',
  type: 'expense',
  role: 'expense-category',
  archived: false,
  startDate: '2026-01-01',
  createdAt: 'x',
  updatedAt: 'x',
};
const costLedger = {
  id: CONTINUOUS_COST_LEDGER_ACCOUNT_ID,
  name: '継続コスト台帳',
  type: 'asset',
  role: 'continuing-cost-asset',
  archived: false,
  startDate: '2026-01-01',
  createdAt: 'x',
  updatedAt: 'x',
};

function directRule(overrides: Partial<RecurringRule> = {}): RecurringRule {
  return {
    id: 'rule',
    name: '積立',
    amount: 1000,
    dayOfMonth: 20,
    everyMonths: 1,
    debitAccountId: investment.id,
    creditAccountId: cash.id,
    startMonth: '2026-04',
    startDate: '2026-04-18',
    endDate: '2026-05-01',
    createdAt: 'x',
    updatedAt: 'x',
    ...overrides,
  };
}

function entry(rule: RecurringRule, date: string, recurringMonth: string): JournalEntry {
  return {
    id: `rec-${rule.id}-${recurringMonth}`,
    date,
    description: rule.name,
    kind: 'normal',
    lines: [
      { accountId: rule.debitAccountId, side: 'debit', amount: rule.amount },
      { accountId: rule.creditAccountId, side: 'credit', amount: rule.amount },
    ],
    metadata: { recurringRuleId: rule.id, recurringMonth },
    createdAt: 'x',
    updatedAt: 'x',
  };
}

function pkg(
  rule: RecurringRule,
  journalEntries: JournalEntry[] = [],
  monthlyCostItems: MonthlyCostItem[] = [],
) {
  return {
    appId: APP_ID,
    schemaVersion: SCHEMA_VERSION,
    ledgerId: 'ledger',
    exportedAt: '2026-07-31T00:00:00.000Z',
    deviceId: 'device',
    revision: 0,
    accounts: [cash, investment, expense, costLedger],
    journalEntries,
    cashflowSchedules: [],
    tags: [],
    monthlyCostItems,
    recurringRules: [rule],
    settings: { ledgerName: '家計簿', currency: 'JPY', locale: 'ja' as const },
  };
}

describe('定期ルール存在期間のschema検証', () => {
  it('startDate欠落と空・逆転区間を拒否し、終了点省略の半開区間を受理する', () => {
    const missingStartDate = { ...directRule() } as Record<string, unknown>;
    delete missingStartDate.startDate;
    expect(recurringRuleSchema.safeParse(missingStartDate).success).toBe(false);
    expect(recurringRuleSchema.safeParse(directRule({ endDate: undefined })).success).toBe(true);
    expect(recurringRuleSchema.safeParse(directRule()).success).toBe(true);
    expect(recurringRuleSchema.safeParse(directRule({ endDate: '2026-04-18' })).success).toBe(
      false,
    );
    expect(recurringRuleSchema.safeParse(directRule({ endDate: '2026-04-17' })).success).toBe(
      false,
    );
    expect(
      recurringRuleSchema.safeParse(directRule({ postedThroughMonth: '2026-06' })).success,
    ).toBe(true);
    expect(
      recurringRuleSchema.safeParse(directRule({ postedThroughMonth: '2026-05' })).success,
    ).toBe(true);
  });

  it('linked仕訳は存在期間内かつ recurringMonth が日付の月と一致する', () => {
    const rule = directRule();
    expect(
      ledgerExportPackageSchema.safeParse(pkg(rule, [entry(rule, '2026-04-20', '2026-04')]))
        .success,
    ).toBe(true);
    expect(
      ledgerExportPackageSchema.safeParse(pkg(rule, [entry(rule, '2026-04-17', '2026-04')]))
        .success,
    ).toBe(false);
    // endDate は排他的なので、同日の仕訳は含まない。
    expect(
      ledgerExportPackageSchema.safeParse(pkg(rule, [entry(rule, '2026-05-01', '2026-05')]))
        .success,
    ).toBe(false);
    expect(
      ledgerExportPackageSchema.safeParse(pkg(rule, [entry(rule, '2026-04-20', '2026-05')]))
        .success,
    ).toBe(false);
    expect(
      ledgerExportPackageSchema.safeParse(
        pkg(rule, [{ ...entry(rule, '2026-04-20', '2026-04'), id: 'arbitrary-id' }]),
      ).success,
    ).toBe(false);
  });

  it('同一系譜の半開区間の重なりだけを拒否する', () => {
    const predecessor = directRule({ endDate: '2026-04-22' });
    const successor = directRule({
      id: 'successor',
      startDate: '2026-04-22',
      endDate: '2026-05-10',
      splitFromRuleId: predecessor.id,
    });
    const valid = { ...pkg(predecessor), recurringRules: [predecessor, successor] };
    expect(ledgerExportPackageSchema.safeParse(valid).success).toBe(true);
    expect(
      ledgerExportPackageSchema.safeParse({
        ...valid,
        recurringRules: [{ ...successor, splitFromRuleId: 'missing' }],
      }).success,
    ).toBe(false);
    expect(
      ledgerExportPackageSchema.safeParse({
        ...valid,
        recurringRules: [predecessor, { ...successor, startDate: '2026-04-21' }],
      }).success,
    ).toBe(false);
    // 境界に隙間があっても、存在期間が重ならなければ受理する。
    expect(
      ledgerExportPackageSchema.safeParse({
        ...valid,
        recurringRules: [predecessor, { ...successor, startDate: '2026-04-23' }],
      }).success,
    ).toBe(true);
    // 位相の変更も、存在期間の非重複とは独立した設定として受理する。
    expect(
      ledgerExportPackageSchema.safeParse({
        ...valid,
        recurringRules: [predecessor, { ...successor, startMonth: '2026-05' }],
      }).success,
    ).toBe(true);
    // 1 本の元ルールから複数の線分が続いても、系譜全体で重ならなければ受理する。
    expect(
      ledgerExportPackageSchema.safeParse({
        ...valid,
        recurringRules: [
          predecessor,
          successor,
          {
            ...successor,
            id: 'second-successor',
            startDate: '2026-05-10',
            endDate: undefined,
          },
        ],
      }).success,
    ).toBe(true);
    expect(
      ledgerExportPackageSchema.safeParse({
        ...valid,
        recurringRules: [{ ...predecessor, splitFromRuleId: successor.id }, successor],
      }).success,
    ).toBe(false);
  });

  it('現存ルールの決定的entry IDは、由来metadataなしの通常仕訳に使えない', () => {
    const rule = directRule();
    const reserved = entry(rule, '2026-04-20', '2026-04');
    delete reserved.metadata;
    expect(ledgerExportPackageSchema.safeParse(pkg(rule, [reserved])).success).toBe(false);
    expect(
      ledgerExportPackageSchema.safeParse(
        pkg(rule, [{ ...reserved, id: 'rec-unrelated-rule-2026-04' }]),
      ).success,
    ).toBe(true);
  });

  it('回収の仕訳をルールの自動起票実績として偽装できない', () => {
    const rule = directRule({
      debitAccountId: CONTINUOUS_COST_LEDGER_ACCOUNT_ID,
      spreadExpenseAccountId: expense.id,
      endDate: undefined,
    });
    const item: MonthlyCostItem = {
      id: `ccr-${rule.id}-2026-04`,
      name: rule.name,
      amount: 1000,
      startDate: '2026-04-20',
      endDate: '2026-04-30',
      expenseAccountId: expense.id,
      createdAt: 'x',
      updatedAt: 'x',
    };
    const purchase: JournalEntry = {
      ...entry(rule, item.startDate, '2026-04'),
      lines: [
        { accountId: CONTINUOUS_COST_LEDGER_ACCOUNT_ID, side: 'debit', amount: item.amount },
        { accountId: cash.id, side: 'credit', amount: item.amount },
      ],
      metadata: {
        monthlyCostId: item.id,
        recurringRuleId: rule.id,
        recurringMonth: '2026-04',
      },
    };
    const invalidRecovery: JournalEntry = {
      id: 'recovery',
      date: '2026-05-20',
      description: '回収',
      kind: 'normal',
      lines: [
        { accountId: cash.id, side: 'debit', amount: 100 },
        { accountId: CONTINUOUS_COST_LEDGER_ACCOUNT_ID, side: 'credit', amount: 100 },
      ],
      metadata: {
        monthlyCostId: item.id,
        monthlyCostRecovery: true as const,
        recurringRuleId: rule.id,
        recurringMonth: '2026-05',
      },
      createdAt: 'x',
      updatedAt: 'x',
    };
    const result = ledgerExportPackageSchema.safeParse(
      pkg(rule, [purchase, invalidRecovery], [item]),
    );
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((issue) => issue.message.includes('回収の仕訳'))).toBe(true);
    }
  });

  it('ルール由来itemは作成日だけを存在期間へ照合し、itemの配分終了日は独立してよい', () => {
    const rule = directRule({
      debitAccountId: CONTINUOUS_COST_LEDGER_ACCOUNT_ID,
      spreadExpenseAccountId: expense.id,
      everyMonths: 12,
    });
    const item: MonthlyCostItem = {
      id: `ccr-${rule.id}-2026-04`,
      name: rule.name,
      amount: rule.amount,
      startDate: '2026-04-20',
      // ルールは5/1で終了しても、4/20に生まれた資産の配分期間は翌年まで独立して続く。
      endDate: '2027-03-31',
      expenseAccountId: expense.id,
      createdAt: 'x',
      updatedAt: 'x',
    };
    const purchase: JournalEntry = {
      id: `rec-${rule.id}-2026-04`,
      date: item.startDate,
      description: item.name,
      kind: 'normal',
      lines: [
        { accountId: CONTINUOUS_COST_LEDGER_ACCOUNT_ID, side: 'debit', amount: item.amount },
        { accountId: cash.id, side: 'credit', amount: item.amount },
      ],
      metadata: {
        monthlyCostId: item.id,
        recurringRuleId: rule.id,
        recurringMonth: '2026-04',
      },
      createdAt: 'x',
      updatedAt: 'x',
    };

    expect(ledgerExportPackageSchema.safeParse(pkg(rule, [purchase], [item])).success).toBe(true);
    expect(
      ledgerExportPackageSchema.safeParse(
        pkg(
          rule,
          [
            {
              ...purchase,
              metadata: { monthlyCostId: item.id },
            },
          ],
          [item],
        ),
      ).success,
    ).toBe(false);
    const neutralItem = { ...item, id: 'neutral-item' };
    expect(
      ledgerExportPackageSchema.safeParse(
        pkg(
          rule,
          [
            {
              ...purchase,
              id: 'neutral-purchase',
              metadata: {
                ...purchase.metadata,
                monthlyCostId: neutralItem.id,
              },
            },
          ],
          [neutralItem],
        ),
      ).success,
    ).toBe(false);
    expect(
      ledgerExportPackageSchema.safeParse({
        ...pkg(rule, [purchase], [item]),
        recurringRules: [],
      }).success,
    ).toBe(false);
    const outside = { ...item, startDate: '2026-04-17' };
    expect(
      ledgerExportPackageSchema.safeParse(
        pkg(rule, [{ ...purchase, date: outside.startDate }], [outside]),
      ).success,
    ).toBe(false);
  });
});
