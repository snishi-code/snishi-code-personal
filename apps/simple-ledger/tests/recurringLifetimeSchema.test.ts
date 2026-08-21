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
  role: 'daily-asset',
  movable: false,
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

/** v13.1（c 案）: 保存形は一形だけ — 借方 = 継続コスト台帳 + 計上先 = spread。 */
function baseRule(overrides: Partial<RecurringRule> = {}): RecurringRule {
  return {
    id: 'rule',
    name: '積立',
    amount: 1000,
    dayOfMonth: 20,
    everyMonths: 1,
    debitAccountId: CONTINUOUS_COST_LEDGER_ACCOUNT_ID,
    spreadExpenseAccountId: investment.id,
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
    monthlyCostItems,
    recurringRules: [rule],
    settings: { ledgerName: '家計簿', currency: 'JPY', displayFractionDigits: 0 },
  };
}

describe('定期ルール存在期間のschema検証', () => {
  it('startDate欠落と空・逆転区間を拒否し、終了点省略の半開区間を受理する', () => {
    const missingStartDate = { ...baseRule() } as Record<string, unknown>;
    delete missingStartDate.startDate;
    expect(recurringRuleSchema.safeParse(missingStartDate).success).toBe(false);
    expect(recurringRuleSchema.safeParse(baseRule({ endDate: undefined })).success).toBe(true);
    expect(recurringRuleSchema.safeParse(baseRule()).success).toBe(true);
    expect(recurringRuleSchema.safeParse(baseRule({ endDate: '2026-04-18' })).success).toBe(false);
    expect(recurringRuleSchema.safeParse(baseRule({ endDate: '2026-04-17' })).success).toBe(false);
    expect(
      recurringRuleSchema.safeParse(
        baseRule({ postedThroughMonth: '2026-06' } as Partial<RecurringRule> & {
          postedThroughMonth?: string;
        }),
      ).success,
    ).toBe(true);
    expect(
      recurringRuleSchema.safeParse(
        baseRule({ postedThroughMonth: '2026-05' } as Partial<RecurringRule> & {
          postedThroughMonth?: string;
        }),
      ).success,
    ).toBe(true);
  });

  it('ルール由来の保存仕訳（rec- ID / 由来メタ）は wire で拒否する（v13: 完全導出）', () => {
    const rule = baseRule();
    // v12 の正規形（決定的 ID + 由来メタ）そのものも保存はできない＝導出が唯一の姿。
    expect(
      ledgerExportPackageSchema.safeParse(pkg(rule, [entry(rule, '2026-04-20', '2026-04')]))
        .success,
    ).toBe(false);
    // 由来メタだけ（任意 ID）でも拒否する。
    expect(
      ledgerExportPackageSchema.safeParse(
        pkg(rule, [{ ...entry(rule, '2026-04-20', '2026-04'), id: 'arbitrary-id' }]),
      ).success,
    ).toBe(false);
  });

  it('rec- の決定的 ID は由来メタが無くても・ルールが無くても拒否する（名乗り = 由来）', () => {
    const rule = baseRule();
    const reserved = entry(rule, '2026-04-20', '2026-04');
    delete reserved.metadata;
    expect(ledgerExportPackageSchema.safeParse(pkg(rule, [reserved])).success).toBe(false);
    // 存在しないルールの rec- ID も fail-closed に拒否（v12 は通常仕訳として受理していた）。
    expect(
      ledgerExportPackageSchema.safeParse(
        pkg(rule, [{ ...reserved, id: 'rec-unrelated-rule-2026-04' }]),
      ).success,
    ).toBe(false);
  });

  it('同一系譜の半開区間の重なりだけを拒否する', () => {
    const predecessor = baseRule({ endDate: '2026-04-22' });
    const successor = baseRule({
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

  it('回収の振替は導出 item（ccr-）を参照でき、由来メタの偽装・導出できない月は拒否する', () => {
    const rule = baseRule({ spreadExpenseAccountId: expense.id, endDate: undefined });
    const recovery = (overrides: Partial<JournalEntry> = {}): JournalEntry => ({
      id: 'recovery',
      date: '2026-05-20',
      description: '回収',
      kind: 'normal',
      lines: [
        { accountId: cash.id, side: 'debit', amount: 100 },
        { accountId: CONTINUOUS_COST_LEDGER_ACCOUNT_ID, side: 'credit', amount: 100 },
      ],
      metadata: { monthlyCostId: `ccr-${rule.id}-2026-04`, monthlyCostRecovery: true as const },
      createdAt: 'x',
      updatedAt: 'x',
      ...overrides,
    });
    // 保存 item が無くても、そのルールが 2026-04 を導出できるなら回収は valid（v13 の新しい正）。
    expect(ledgerExportPackageSchema.safeParse(pkg(rule, [recovery()])).success).toBe(true);
    // 由来メタを重ねた偽装は拒否。
    const forged = recovery();
    forged.metadata = { ...forged.metadata, recurringRuleId: rule.id, recurringMonth: '2026-05' };
    const forgedResult = ledgerExportPackageSchema.safeParse(pkg(rule, [forged]));
    expect(forgedResult.success).toBe(false);
    // 導出起票日（4/20）より前の回収は拒否（導出 item の開始日で検証する）。
    expect(
      ledgerExportPackageSchema.safeParse(pkg(rule, [recovery({ date: '2026-04-19' })])).success,
    ).toBe(false);
    // 位相に乗らない月（everyMonths 12 の 5 月）への参照は「導出 item が無い」ので拒否。
    const yearly = baseRule({
      id: 'yearly',
      spreadExpenseAccountId: expense.id,
      everyMonths: 12,
      endDate: undefined,
    });
    expect(
      ledgerExportPackageSchema.safeParse(
        pkg(yearly, [
          recovery({
            metadata: { monthlyCostId: 'ccr-yearly-2026-05', monthlyCostRecovery: true },
          }),
        ]),
      ).success,
    ).toBe(false);
  });

  it('清算（settlements）は導出する月・起票日〜既定終了日の範囲だけを受理する', () => {
    const rule = baseRule({ spreadExpenseAccountId: expense.id, endDate: undefined });
    const withSettlements = (settlements: { month: string; endDate: string }[]) =>
      pkg({ ...rule, settlements }, []);
    // 4/20 起票の item（既定終了 5/20）を 5/1 で早期終了 = valid。
    expect(
      ledgerExportPackageSchema.safeParse(
        withSettlements([{ month: '2026-04', endDate: '2026-05-01' }]),
      ).success,
    ).toBe(true);
    // 起票日当日 = valid（同日通過 0 回 → 終了日に全額の意味論）。既定終了日ちょうども valid。
    expect(
      ledgerExportPackageSchema.safeParse(
        withSettlements([{ month: '2026-04', endDate: '2026-04-20' }]),
      ).success,
    ).toBe(true);
    expect(
      ledgerExportPackageSchema.safeParse(
        withSettlements([{ month: '2026-04', endDate: '2026-05-20' }]),
      ).success,
    ).toBe(true);
    // 起票日より前・既定終了日より後は拒否。
    expect(
      ledgerExportPackageSchema.safeParse(
        withSettlements([{ month: '2026-04', endDate: '2026-04-19' }]),
      ).success,
    ).toBe(false);
    expect(
      ledgerExportPackageSchema.safeParse(
        withSettlements([{ month: '2026-04', endDate: '2026-05-21' }]),
      ).success,
    ).toBe(false);
    // 導出しない月（存在期間前）・清算月の重複は拒否。
    expect(
      ledgerExportPackageSchema.safeParse(
        withSettlements([{ month: '2026-03', endDate: '2026-04-01' }]),
      ).success,
    ).toBe(false);
    expect(
      ledgerExportPackageSchema.safeParse(
        withSettlements([
          { month: '2026-04', endDate: '2026-05-01' },
          { month: '2026-04', endDate: '2026-05-02' },
        ]),
      ).success,
    ).toBe(false);
  });
});
