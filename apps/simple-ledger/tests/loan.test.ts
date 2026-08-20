/*
 * ローン（= 台帳のルール）の純関数。**終了日が正**で、回数・月額はそこから導出する。
 */
import { describe, expect, it } from 'vitest';
import {
  isLoanRule,
  loanDayOfMonth,
  loanFirstRepaymentDate,
  loanInstallmentCount,
  loanMonthlyAmount,
  loanRemainingInstallments,
  loanRuleEndDate,
  loanRuleForLiability,
  loanScheduledTotal,
  loanStartMonth,
} from '../src/domain/loan';
import { addMonthsToDate } from '../src/domain/allocation';
import type { RecurringRule } from '../src/domain/types';

const rule = (over: Partial<RecurringRule> = {}): RecurringRule => ({
  id: 'r1',
  name: '自動車ローン',
  amount: 1000000,
  dayOfMonth: 18,
  everyMonths: 1,
  spreadExpenseAccountId: 'loan',
  debitAccountId: 'cc-ledger',
  creditAccountId: 'cash',
  startMonth: '2026-09',
  startDate: '2026-08-18',
  endDate: '2027-09-18',
  createdAt: '2026-08-18T00:00:00.000Z',
  updatedAt: '2026-08-18T00:00:00.000Z',
  ...over,
});

const roleOf = (id: string) =>
  id === 'loan'
    ? ('other-liability' as const)
    : id === 'card'
      ? ('payment-liability' as const)
      : id === 'cash'
        ? ('daily-asset' as const)
        : ('expense-category' as const);

describe('ローンの判定（計上先が負債科目）', () => {
  it('計上先が負債ならローン。費用・資産ならローンではない', () => {
    expect(isLoanRule(rule(), roleOf)).toBe(true);
    expect(isLoanRule(rule({ spreadExpenseAccountId: 'card' }), roleOf)).toBe(true);
    expect(isLoanRule(rule({ spreadExpenseAccountId: 'food' }), roleOf)).toBe(false);
    expect(isLoanRule(rule({ spreadExpenseAccountId: 'cash' }), roleOf)).toBe(false);
  });

  it('負債から返済ルールを引ける（無ければ undefined = 台帳に出ない負債）', () => {
    const rules = [rule()];
    expect(loanRuleForLiability(rules, 'loan')?.id).toBe('r1');
    expect(loanRuleForLiability(rules, 'card')).toBeUndefined();
    expect(loanRuleForLiability([], 'loan')).toBeUndefined();
  });
});

describe('日付の導出', () => {
  it('初回返済 = 購入日の 1 ヶ月後（月末はクランプ）', () => {
    expect(loanFirstRepaymentDate('2026-08-18')).toBe('2026-09-18');
    expect(loanFirstRepaymentDate('2026-01-31')).toBe('2026-02-28');
  });

  it('排他的終了日 = 初回返済日 + 回数ヶ月（最終回はその 1 ヶ月前）', () => {
    expect(loanRuleEndDate('2026-09-18', 12)).toBe('2027-09-18');
    expect(loanRuleEndDate('2026-09-18', 60)).toBe('2031-09-18');
  });

  it('回数は終了日から導出する（終了日が正）', () => {
    expect(loanInstallmentCount('2026-09-18', '2027-09-18')).toBe(12);
    expect(loanInstallmentCount('2026-09-18', '2031-09-18')).toBe(60);
    // 初回より前・当日の終了日は 1 回も起きない（保存境界が拒む）。
    expect(loanInstallmentCount('2026-09-18', '2026-09-18')).toBe(0);
    expect(loanInstallmentCount('2026-09-18', '2026-09-01')).toBe(0);
    // 端数の月でも「起票日 < 終了日」だけで決まる。
    expect(loanInstallmentCount('2026-09-18', '2026-10-17')).toBe(1);
    expect(loanInstallmentCount('2026-09-18', '2026-10-19')).toBe(2);
  });

  it('上限（1,200 回 = 100 年）は飽和せず超過が見える（v13.9 監査 #4）', () => {
    // ちょうど上限 = 有効。導出（上限なし）と月額の分母が一致する。
    expect(loanInstallmentCount('2000-02-15', addMonthsToDate('2000-02-15', 1200))).toBe(1200);
    // 超過は 1,200 に丸めず「上限 + 1」で可視化する（旧実装は 1,200 へ黙って飽和し、
    // 月額の分母 < 実起票回数となって過返済が起きた）。
    expect(
      loanInstallmentCount('2000-02-15', addMonthsToDate('2000-02-15', 1201)),
    ).toBeGreaterThan(1200);
    expect(loanInstallmentCount('2000-02-15', '2100-12-31')).toBeGreaterThan(1200);
  });

  it('位相の基点と返済日は初回返済日が決める', () => {
    expect(loanStartMonth('2026-09-18')).toBe('2026-09');
    expect(loanDayOfMonth('2026-09-18')).toBe(18);
    expect(loanDayOfMonth('2026-09-01')).toBe(1);
  });
});

describe('月額の導出', () => {
  it('割り切れるときは総額 ÷ 回数', () => {
    expect(loanMonthlyAmount(12000000, 12)).toBe(1000000);
    expect(loanMonthlyAmount(3600000, 36)).toBe(100000);
  });

  it('割り切れないときは切り捨て、正の端数が残高に残る（過返済にしない・監査 D）', () => {
    const monthly = loanMonthlyAmount(1000000, 60);
    expect(monthly).toBe(16666);
    expect(loanScheduledTotal(monthly, 60)).toBe(999960);
    // 差（借入額 − 予定合計）は常に 0 以上 = 返済し切った負債がマイナス残高にならない。
    expect(1000000 - loanScheduledTotal(monthly, 60)).toBe(40);
    // 監査 D の具体例: 四捨五入だと 1,667×6 = 10,002 > 10,000（過返済）になっていた。
    expect(loanMonthlyAmount(10000, 6)).toBe(1666);
    expect(10000 - loanScheduledTotal(1666, 6)).toBe(4);
  });

  it('月額 × 回数 ≤ 総額（floor の普遍性: どの total/count でも過返済にならない）', () => {
    for (const [total, count] of [
      [1, 1],
      [7, 3],
      [10000, 6],
      [999999, 7],
      [5, 10],
    ] as const) {
      expect(loanScheduledTotal(loanMonthlyAmount(total, count), count)).toBeLessThanOrEqual(total);
    }
  });

  it('不正な入力と回数 > 総額（月額 1 未満）は 0（保存境界が拒否する値）', () => {
    expect(loanMonthlyAmount(0, 12)).toBe(0);
    expect(loanMonthlyAmount(12000, 0)).toBe(0);
    expect(loanMonthlyAmount(1.5, 12)).toBe(0);
    // 回数 > 総額: 旧実装は Math.max(1, …) で月額 1 に持ち上げ、1×count > total の過返済を許した。
    expect(loanMonthlyAmount(5, 10)).toBe(0);
  });
});

describe('残回数（基準日より後の起票数）', () => {
  it('終了日から導出し、断面が進むほど減る', () => {
    const r = rule();
    expect(loanRemainingInstallments(r, '2026-08-18')).toBe(12);
    expect(loanRemainingInstallments(r, '2026-09-18')).toBe(11);
    expect(loanRemainingInstallments(r, '2027-08-18')).toBe(0);
  });

  it('終了日なし（終わらない返済）は回数が決まらない', () => {
    const noEnd = { ...rule() };
    delete noEnd.endDate;
    expect(loanRemainingInstallments(noEnd, '2026-08-18')).toBeUndefined();
  });
});
