/*
 * 月額化コストの計算。
 *
 * 「按分」という会計処理ではなく、現在の生活水準を維持するための月あたりコストを見える化する。
 * MonthlyCostItem は仕訳を生成しない登録簿で、月額は formula（amount / costMonths を端数調整）で導出する。
 *  - repeatEveryMonths 未指定: startMonth から costMonths か月だけ計上して終了（1 回限り）。
 *  - repeatEveryMonths 指定: 周期ごとに同じ束を再発（先頭 costMonths か月だけ計上、以降の隙間は 0）。
 *    例) サブスク costMonths=1 / repeat=1 → 毎月、年払い costMonths=12 / repeat=12 → 毎月（連続）。
 *  - endMonth を過ぎた月、status!=='active' の月は 0。
 *
 * 端数は monthlyAmounts(amount, costMonths) と同じ配分（合計が必ず amount に一致）を使う。
 */
import { monthlyAmounts, monthsBetween } from './allocation';
import type { MonthlyCostItem } from './types';

/** 代表的な月額（表示用）。amount を costMonths で割った端数調整の先頭月額。 */
export function representativeMonthlyAmount(item: MonthlyCostItem): number {
  return monthlyAmounts(item.amount, item.costMonths)[0] ?? 0;
}

/**
 * 指定月 ym('YYYY-MM') にこの項目が生活コストへ寄与する額。寄与しない月は 0。
 */
export function monthlyCostForMonth(item: MonthlyCostItem, ym: string): number {
  if (item.status !== 'active') return 0;
  const since = monthsBetween(item.startMonth, ym);
  if (since < 0) return 0;
  if (item.endMonth && monthsBetween(ym, item.endMonth) < 0) return 0;

  const amounts = monthlyAmounts(item.amount, item.costMonths);
  if (item.repeatEveryMonths && item.repeatEveryMonths > 0) {
    const pos = since % item.repeatEveryMonths;
    return pos < item.costMonths ? (amounts[pos] ?? 0) : 0;
  }
  // 1 回限り: startMonth から costMonths か月だけ。
  return since < item.costMonths ? (amounts[since] ?? 0) : 0;
}

/** 指定月の月額化コスト合計（active な全項目の合算）。 */
export function totalMonthlyCostForMonth(items: MonthlyCostItem[], ym: string): number {
  return items.reduce((s, it) => s + monthlyCostForMonth(it, ym), 0);
}
