/*
 * 資金目標（FundingGoal）の必要積立額の計算。
 *
 * 「5 年後に車 300 万円」「40 年後に老後 5000 万円」などを、目標額・期限・現在確保額・
 * 期待年利から「毎月いくら積み立てれば届くか」で見える化する。期待年利は参考計算のための
 * 仮定であり投資助言ではない（Settings.expectedAnnualReturnBps）。
 */
import { monthsBetween } from './allocation';
import type { FundingGoal, ReserveItem } from './types';

/** 今月（'YYYY-MM'）から目標月（targetDate の月）までの残り月数（最低 1）。 */
export function monthsUntil(currentYm: string, targetDate: string): number {
  const targetYm = targetDate.slice(0, 7);
  return Math.max(1, monthsBetween(currentYm, targetYm));
}

export interface RequiredMonthlyInput {
  targetAmount: number;
  currentAmount: number;
  months: number;
  /** 期待年利（basis point 整数。例: 5% = 500）。 */
  annualRateBps: number;
}

/**
 * 目標到達に必要な毎月積立額（円。表示時に丸める。内部保存にはしない）。
 *  - 既に到達していれば 0。
 *  - 年利 0% は単純割り。
 *  - それ以外は積立の将来価値式。
 */
export function requiredMonthlyContribution(input: RequiredMonthlyInput): number {
  const months = Math.max(1, input.months);
  const remaining = input.targetAmount - input.currentAmount;
  if (remaining <= 0) return 0;

  const annualRate = input.annualRateBps / 10000;
  if (annualRate === 0) return remaining / months;

  const r = Math.pow(1 + annualRate, 1 / 12) - 1;
  const growth = Math.pow(1 + r, months);
  const fvCurrent = input.currentAmount * growth;
  const monthly = ((input.targetAmount - fvCurrent) * r) / (growth - 1);
  return monthly <= 0 ? 0 : monthly;
}

/** 目標の必要積立額（円・四捨五入）。currentYm 基準。 */
export function goalRequiredMonthly(
  goal: FundingGoal,
  currentYm: string,
  annualRateBps: number,
): number {
  if (goal.status !== 'active') return 0;
  const months = monthsUntil(currentYm, goal.targetDate);
  return Math.round(
    requiredMonthlyContribution({
      targetAmount: goal.targetAmount,
      currentAmount: goal.currentAmount,
      months,
      annualRateBps,
    }),
  );
}

/**
 * 目的別資金（取り置き枠）の必要な毎月の積立額（円・四捨五入）。currentYm 基準。
 * 資金目標を統合した枠なので、現在額は手入力ではなく口座残高(currentBalance)を使う。
 * 目標額・目標日が無ければ 0（計画ではない取り置き）。
 */
export function reserveRequiredMonthly(
  reserve: ReserveItem,
  currentBalance: number,
  currentYm: string,
  annualRateBps: number,
): number {
  if (reserve.targetAmount === undefined || reserve.targetDate === undefined) return 0;
  const months = monthsUntil(currentYm, reserve.targetDate);
  return Math.round(
    requiredMonthlyContribution({
      targetAmount: reserve.targetAmount,
      currentAmount: currentBalance,
      months,
      annualRateBps,
    }),
  );
}
