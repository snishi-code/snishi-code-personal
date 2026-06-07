import { describe, expect, it } from 'vitest';
import {
  goalRequiredMonthly,
  monthsUntil,
  requiredMonthlyContribution,
  reserveRequiredMonthly,
} from '../src/domain/fundingGoal';
import type { FundingGoal, ReserveItem } from '../src/domain/types';

describe('requiredMonthlyContribution', () => {
  it('年利 0% は単純割り', () => {
    expect(
      requiredMonthlyContribution({
        targetAmount: 1200000,
        currentAmount: 0,
        months: 12,
        annualRateBps: 0,
      }),
    ).toBe(100000);
  });
  it('既に到達していれば 0', () => {
    expect(
      requiredMonthlyContribution({
        targetAmount: 100,
        currentAmount: 100,
        months: 12,
        annualRateBps: 500,
      }),
    ).toBe(0);
  });
  it('年利 5% は 0% より必要積立額が小さい', () => {
    const zero = requiredMonthlyContribution({
      targetAmount: 3000000,
      currentAmount: 0,
      months: 60,
      annualRateBps: 0,
    });
    const five = requiredMonthlyContribution({
      targetAmount: 3000000,
      currentAmount: 0,
      months: 60,
      annualRateBps: 500,
    });
    expect(five).toBeLessThan(zero);
    expect(five).toBeGreaterThan(0);
  });
  it('期間が長いほど必要積立額が小さい（1年 vs 10年）', () => {
    const oneYear = requiredMonthlyContribution({
      targetAmount: 1000000,
      currentAmount: 0,
      months: 12,
      annualRateBps: 300,
    });
    const tenYear = requiredMonthlyContribution({
      targetAmount: 1000000,
      currentAmount: 0,
      months: 120,
      annualRateBps: 300,
    });
    expect(tenYear).toBeLessThan(oneYear);
  });
});

describe('monthsUntil / goalRequiredMonthly', () => {
  it('monthsUntil は最低 1', () => {
    expect(monthsUntil('2026-06', '2026-06-15')).toBe(1); // 同月 → 1
    expect(monthsUntil('2026-06', '2027-06-15')).toBe(12);
  });
  it('goalRequiredMonthly は active のみ、円で四捨五入', () => {
    const goal: FundingGoal = {
      id: 'g',
      name: '車',
      targetAmount: 1200000,
      targetDate: '2027-06-30',
      currentAmount: 0,
      status: 'active',
      createdAt: 'x',
      updatedAt: 'x',
    };
    // 12 か月・年利 0% → 100,000/月
    expect(goalRequiredMonthly(goal, '2026-06', 0)).toBe(100000);
    expect(goalRequiredMonthly({ ...goal, status: 'achieved' }, '2026-06', 0)).toBe(0);
  });
});

describe('reserveRequiredMonthly（目的別資金の必要月額・現在額は残高から）', () => {
  const base: ReserveItem = {
    id: 'r',
    name: '結婚資金',
    reserveAccountId: 'acc',
    createdAt: 'x',
    updatedAt: 'x',
  };
  it('目標額・目標日が無ければ 0（計画でない取り置き）', () => {
    expect(reserveRequiredMonthly(base, 0, '2026-06', 0)).toBe(0);
    expect(reserveRequiredMonthly({ ...base, targetAmount: 1200000 }, 0, '2026-06', 0)).toBe(0);
  });
  it('現在残高を current として必要月額を出す（残高分は差し引かれる）', () => {
    const r: ReserveItem = { ...base, targetAmount: 1200000, targetDate: '2027-06-30' };
    // 12 か月・年利 0% → (1,200,000 − 残高)/12
    expect(reserveRequiredMonthly(r, 0, '2026-06', 0)).toBe(100000);
    expect(reserveRequiredMonthly(r, 600000, '2026-06', 0)).toBe(50000);
    // 既に到達していれば 0
    expect(reserveRequiredMonthly(r, 1200000, '2026-06', 0)).toBe(0);
  });
});
