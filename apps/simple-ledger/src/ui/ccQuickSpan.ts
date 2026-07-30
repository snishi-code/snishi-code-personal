/*
 * 継続コスト資産の終了日クイックチップ（[1年][3年][5年]）の共通計算。
 * 「開始月 + 12n − 1 ヶ月」の月末に置く（素朴な「+N年 −1日」は 13/37/61 ヶ月配分になる。
 * 配分が月単位である以上、終了日は月で決めて末日に置くのが唯一の正解）。
 */
import { addMonths, monthOf } from '../domain/allocation';
import { clampDayToMonth } from '../domain/recurring';

export function quickSpanEndDate(startDate: string, years: number): string {
  return clampDayToMonth(addMonths(monthOf(startDate), years * 12 - 1), 31);
}
