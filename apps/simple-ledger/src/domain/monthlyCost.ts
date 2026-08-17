/*
 * 継続コスト資産（MonthlyCostItem・4項目モデル）の同日刻み計算（v12〜）。
 *
 * 統一原則（作者決定 2026-08-15）: **「支払いが買った期間を同日刻みで n 等分し、各刻みの
 * 終端の日に費用化する。残高 0 になる日 = 期間の終わり = 次の支払い日」**。
 * 費用の行は 1 件も保存されないため、終了日を書き換えた瞬間に全期間が新しい刻みで
 * 再計算される（遡及アルゴリズムは存在しない。それが仕様）。
 *
 * 規則:
 *  - **k 番目の刻み日 = addMonthsToDate(startDate, k)**（k = 1..n・月末クランプ・
 *    起点は常に元の startDate なので 1/31 起点の刻みは 2/28, 3/31, … と日を保つ）。
 *  - **n = 刻み日 <= endDate を満たす最大の k**（同日通過カウント）。購入日当日の費用は
 *    常に 0（月払いの費用が 1 刻み遅れるのは作者承認済み: 「今日買ってもまだ消費していない」）。
 *  - **n = 0（同日通過なしで終了）は終了日に全額 1 本**（作者決定 2026-08-15）。
 *  - **終了日が未設定なら費用の割り振りをしない**（n が決まらないので配分できないだけ。
 *    特別扱いの分岐を作らない）。残存価値 = 全額。
 *  - 端数は monthlyAmounts（合計が必ず配分総額に一致・先頭刻みから 1 ずつ）。
 *  - spreadTotal は既定 item.amount。アーカイブ時の回収の振替があるときだけ
 *    `amount − 回収額` が渡る（負になってよい＝過去にわたる費用減）。item.amount は
 *    絶対に書き換えない（購入の仕訳とのミラーが壊れる）。
 */
import { addMonthsToDate, monthlyAmounts, monthOf, monthsBetween } from './allocation';
import { assertSafeAmount } from './safeSum';
import type { MonthlyCostItem } from './types';

/** 費用化の 1 刻み（費用が立つ日とその額）。 */
export interface AllocationCut {
  date: string;
  amount: number;
}

/**
 * 同日通過カウント: addMonthsToDate(startDate, k) <= endDate を満たす最大の k（>= 0）。
 * 月数の差から候補を出し、日のクランプ差だけ 1 戻す（走査しない・決定的）。
 */
export function dayCutCount(startDate: string, endDate: string): number {
  const k = monthsBetween(monthOf(startDate), monthOf(endDate));
  if (k <= 0) return 0;
  return addMonthsToDate(startDate, k) <= endDate ? k : k - 1;
}

/**
 * 同日刻みの配分そのもの（**刻み規約の単一正本**）。継続コストの費用化
 * （allocationSchedule）と残高補正の按分（adjustmentSpread.ts）が同じ規約を共有する。
 *  - n >= 1: k = 1..n の刻み日（addMonthsToDate(startDate, k)）に monthlyAmounts を配る。
 *  - n = 0（同日通過なし・endDate < startDate も含む）: endDate に全額 1 本。
 * 日付は単調増加・月内に高々 1 本（刻みは 1 か月間隔）。合計は必ず total に一致する。
 */
export function allocationCuts(startDate: string, endDate: string, total: number): AllocationCut[] {
  const n = dayCutCount(startDate, endDate);
  if (n === 0) return [{ date: endDate, amount: assertSafeAmount(total) }];
  const amounts = monthlyAmounts(total, n);
  return amounts.map((amount, i) => ({ date: addMonthsToDate(startDate, i + 1), amount }));
}

/**
 * 費用化の予定表（単一正本）。導出仕訳・画面・残存価値がすべてこれを使う。
 *  - 終了日なし: 空（1 本も生まれない）。
 *  - それ以外は allocationCuts（刻み規約）そのもの。
 */
export function allocationSchedule(
  item: MonthlyCostItem,
  spreadTotal: number = item.amount,
): AllocationCut[] {
  if (item.endDate === undefined) return [];
  return allocationCuts(item.startDate, item.endDate, spreadTotal);
}

/** その月に費用として割り振られる額。寄与しない月・終了日なしは 0。 */
export function monthlyCostForMonth(
  item: MonthlyCostItem,
  ym: string,
  spreadTotal: number = item.amount,
): number {
  let sum = 0;
  for (const cut of allocationSchedule(item, spreadTotal)) {
    if (monthOf(cut.date) === ym) sum = assertSafeAmount(sum + cut.amount);
  }
  return sum;
}

/** 一覧に出す「月あたり」（先頭刻みの額）。終了日なしは 0（UI は — を出す）。 */
export function representativeMonthlyAmount(
  item: MonthlyCostItem,
  spreadTotal: number = item.amount,
): number {
  return allocationSchedule(item, spreadTotal)[0]?.amount ?? 0;
}

/**
 * asOf 時点でまだ費用になっていない額（= 残存価値）。
 * 単一正本 = `割り振る総額（購入額 − 回収額 = spreadTotal） − asOf までの刻み額`。
 * 台帳残高のこの item ぶんと一致する（回収額を二重に引かない・引き忘れない。監査 P2-1）。
 * 終了日なしは刻み 0 なので spreadTotal がそのまま残る。
 */
export function remainingValue(
  item: MonthlyCostItem,
  asOf: string,
  spreadTotal: number = item.amount,
): number {
  let done = 0;
  for (const cut of allocationSchedule(item, spreadTotal)) {
    if (cut.date <= asOf) done = assertSafeAmount(done + cut.amount);
  }
  return assertSafeAmount(spreadTotal - done);
}

/* ── アーカイブの導出規則（status フィールドは持たない・猶予なし） ── */

/** 終了日を過ぎた = アーカイブ済み。終了日が無ければ永久にアーカイブされない。 */
export function isArchived(item: MonthlyCostItem, today: string): boolean {
  return item.endDate !== undefined && item.endDate < today;
}

/** 終了まで1ヶ月以内（一覧で行の色を変える対象）。 */
export function isEndingSoon(item: MonthlyCostItem, today: string): boolean {
  return (
    item.endDate !== undefined &&
    !isArchived(item, today) &&
    item.endDate <= addMonthsToDate(today, 1)
  );
}

/**
 * 一覧の並び順: 終了が近い順（endDate 昇順・未設定は最後）。同着は名前で安定化。
 */
export function compareMonthlyCostItems(a: MonthlyCostItem, b: MonthlyCostItem): number {
  if (a.endDate !== b.endDate) {
    if (a.endDate === undefined) return 1;
    if (b.endDate === undefined) return -1;
    return a.endDate < b.endDate ? -1 : 1;
  }
  return a.name.localeCompare(b.name, 'ja');
}
