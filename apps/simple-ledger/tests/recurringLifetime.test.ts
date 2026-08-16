import { describe, expect, it } from 'vitest';
import {
  accountReferenceIntervals,
  effectiveRecurringRuleStartDate,
  recurringRuleReferenceStartDate,
  ruleExistsAt,
} from '../src/domain/accountLifetime';
import {
  deriveRecurringOutputs,
  parseRuleItemId,
  recurringPostingsDue,
} from '../src/domain/recurring';
import { CONTINUOUS_COST_LEDGER_ACCOUNT_ID } from '../src/domain/constants';
import type { Account, RecurringRule } from '../src/domain/types';

/** v13.1（c 案）: 保存形は一形だけ — 借方 = 継続コスト台帳 + 計上先 = spread。 */
function rule(overrides: Partial<RecurringRule> = {}): RecurringRule {
  return {
    id: 'rule',
    name: '毎月のもの',
    amount: 1000,
    dayOfMonth: 20,
    everyMonths: 1,
    debitAccountId: CONTINUOUS_COST_LEDGER_ACCOUNT_ID,
    spreadExpenseAccountId: 'expense',
    creditAccountId: 'cash',
    startMonth: '2026-04',
    startDate: '2026-04-12',
    createdAt: '2026-04-12T00:00:00.000Z',
    updatedAt: '2026-04-12T00:00:00.000Z',
    ...overrides,
  };
}

const accounts: Account[] = [
  {
    id: 'investment',
    name: '投資',
    type: 'asset',
    role: 'investment-asset',
    archived: false,
    startDate: '2026-01-01',
    createdAt: 'x',
    updatedAt: 'x',
  },
  {
    id: 'expense',
    name: '固定費',
    type: 'expense',
    role: 'expense-category',
    archived: false,
    startDate: '2026-01-01',
    createdAt: 'x',
    updatedAt: 'x',
  },
  {
    id: 'cash',
    name: '預金',
    type: 'asset',
    role: 'daily-asset',
    archived: false,
    startDate: '2026-01-01',
    createdAt: 'x',
    updatedAt: 'x',
  },
  {
    id: CONTINUOUS_COST_LEDGER_ACCOUNT_ID,
    name: '継続コスト台帳',
    type: 'asset',
    role: 'continuing-cost-asset',
    archived: false,
    startDate: '2026-01-01',
    createdAt: 'x',
    updatedAt: 'x',
  },
];

describe('定期ルールの存在期間（半開区間）', () => {
  it('存在開始点は周期アンカーとは独立した明示 startDate を使う', () => {
    const subject = rule({ startDate: '2024-02-29', startMonth: '2024-02', dayOfMonth: 31 });
    expect(effectiveRecurringRuleStartDate(subject)).toBe('2024-02-29');
    expect(ruleExistsAt(subject, '2024-02-28')).toBe(false);
    expect(ruleExistsAt(subject, '2024-02-29')).toBe(true);
  });

  it('4/18変更: 旧ルールは4月分を作らず、同日開始の新ルールが4/20に作る', () => {
    const oldRule = rule({ id: 'old', endDate: '2026-04-18' });
    const newRule = rule({ id: 'new', startDate: '2026-04-18' });

    expect(recurringPostingsDue(oldRule, '2026-04-30')).toEqual([]);
    expect(recurringPostingsDue(newRule, '2026-04-30')).toEqual([
      { month: '2026-04', date: '2026-04-20' },
    ]);
  });

  it('4/22変更: 旧ルールが4/20に一度だけ作り、新ルールは翌月から作る', () => {
    const oldRule = rule({ id: 'old', endDate: '2026-04-22' });
    const newRule = rule({ id: 'new', startDate: '2026-04-22' });

    expect(recurringPostingsDue(oldRule, '2026-05-31')).toEqual([
      { month: '2026-04', date: '2026-04-20' },
    ]);
    expect(recurringPostingsDue(newRule, '2026-05-31')).toEqual([
      { month: '2026-05', date: '2026-05-20' },
    ]);
  });

  it('起票日当日の変更は排他的終端により新ルールだけが当日分を作る', () => {
    const oldRule = rule({ id: 'old', endDate: '2026-04-20' });
    const newRule = rule({ id: 'new', startDate: '2026-04-20' });
    const postings = [oldRule, newRule].flatMap((candidate) =>
      recurringPostingsDue(candidate, '2026-04-20'),
    );

    expect(postings).toEqual([{ month: '2026-04', date: '2026-04-20' }]);
  });

  it('everyMonthsの位相はstartMonthに保ち、存在期間だけで前後を切る', () => {
    const quarterly = rule({
      startMonth: '2026-01',
      startDate: '2026-02-01',
      endDate: '2026-10-01',
      everyMonths: 3,
    });

    expect(recurringPostingsDue(quarterly, '2026-12-31')).toEqual([
      { month: '2026-04', date: '2026-04-20' },
      { month: '2026-07', date: '2026-07-20' },
    ]);
  });

  it('導出も存在期間外の起票を作らない', () => {
    const { entries } = deriveRecurringOutputs(
      [
        rule({
          spreadExpenseAccountId: 'investment',
          startDate: '2026-04-22',
          endDate: '2026-06-01',
        }),
      ],
      accounts,
      '2026-07-31',
    );

    // 4/20 は開始前・6/20 は排他的終了日の後なので、断面をどれだけ先へ伸ばしても 5/20 だけ。
    expect(entries.map((entry) => entry.date)).toEqual(['2026-05-20']);
  });

  it('科目参照は次の起票日から最後の起票が作る item の配分終端までの有限区間になる', () => {
    const subject = rule({ endDate: '2026-06-15' });
    expect(recurringRuleReferenceStartDate(subject)).toBe('2026-04-20');
    // 存在期間の最終日は 6/14 だが、全ルールが台帳経由なので最後の起票（5/20）が作る
    // item の終端（= 次回起票日 6/20）まで科目を参照する。
    expect(
      accountReferenceIntervals('cash', {
        entries: [],
        monthlyCostItems: [],
        recurringRules: [subject],
      }),
    ).toEqual([{ kind: 'recurringRule', from: '2026-04-20', to: '2026-06-20' }]);
  });

  it('存在終了日までに次の周期日がなければ将来参照もない', () => {
    expect(
      recurringRuleReferenceStartDate(rule({ startDate: '2026-04-22', endDate: '2026-05-20' })),
    ).toBeUndefined();
  });

  it('rule idにハイフンがあってもitem idを正しく分解する', () => {
    expect(parseRuleItemId('ccr-a-b-2026-04')).toEqual({ ruleId: 'a-b', month: '2026-04' });
  });
});
