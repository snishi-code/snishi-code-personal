/*
 * 継続コスト資産（MonthlyCostItem・4項目モデル）の月割り計算。
 *
 * 開始日・終了日・金額から「月あたりの費用」を導出する純関数群。費用の行は 1 件も
 * 保存されないため、終了日を書き換えた瞬間に全期間が新しい月数で再計算される
 * （遡及アルゴリズムは存在しない。それが仕様）。
 *
 * 規則:
 *  - **月割り**（日割りしない）。startDate/endDate の「日」は配分に使わない。
 *  - **終了日が未設定なら費用の割り振りをしない**（n が決まらないので配分できないだけ。
 *    特別扱いの分岐を作らない）。残存価値 = 全額。
 *  - 月割りの起点は **費用化の開始日（allocationStartDate ?? startDate）**。初月の月割り日は
 *    起点日、2ヶ月目以降は月初（monthlyAllocationDate）。起点は購入日以降（保存境界が保証）
 *    なので、購入の仕訳より前に費用行が立って台帳がマイナスになる断面を構造的に防ぐ。
 *  - 端数は monthlyAmounts（合計が必ず配分総額に一致）。
 *  - spreadTotal は既定 item.amount。アーカイブ時の回収の振替があるときだけ
 *    `amount − 回収額` が渡る（負になってよい＝過去にわたる費用減）。item.amount は
 *    絶対に書き換えない（購入の仕訳とのミラーが壊れる）。
 */
import { addMonths, addMonthsToDate, monthlyAmounts, monthOf, monthsBetween } from './allocation';
import type { MonthlyCostItem } from './types';

/** 月割りの起点日（費用化の開始日）。未設定 = 購入日（startDate）。 */
export function allocationStartOf(item: MonthlyCostItem): string {
  return item.allocationStartDate ?? item.startDate;
}

/** 月バケット（費用化開始月〜終了月）。終了日が無ければ null（= 配分しない）。 */
export function monthlyAllocationSpan(item: MonthlyCostItem): { from: string; n: number } | null {
  if (item.endDate === undefined) return null;
  const from = monthOf(allocationStartOf(item));
  const n = monthsBetween(from, monthOf(item.endDate)) + 1; // n >= 1 は保存境界が保証
  return { from, n };
}

/** k 番目に費用になる日。初月だけ費用化の開始日、2ヶ月目以降は月初。 */
export function monthlyAllocationDate(item: MonthlyCostItem, from: string, k: number): string {
  return k === 0 ? allocationStartOf(item) : `${addMonths(from, k)}-01`;
}

/** その月に費用として割り振られる額。寄与しない月・終了日なしは 0。 */
export function monthlyCostForMonth(
  item: MonthlyCostItem,
  ym: string,
  spreadTotal: number = item.amount,
): number {
  const span = monthlyAllocationSpan(item);
  if (!span) return 0;
  const i = monthsBetween(span.from, ym);
  if (i < 0 || i >= span.n) return 0;
  return monthlyAmounts(spreadTotal, span.n)[i] ?? 0;
}

/** 一覧に出す「月あたり」（先頭月額）。終了日なしは 0（UI は — を出す）。 */
export function representativeMonthlyAmount(
  item: MonthlyCostItem,
  spreadTotal: number = item.amount,
): number {
  const span = monthlyAllocationSpan(item);
  if (!span) return 0;
  return monthlyAmounts(spreadTotal, span.n)[0] ?? 0;
}

/**
 * asOf 時点でまだ費用になっていない額（= 残存価値）。
 * 単一正本 = `割り振る総額（購入額 − 回収額 = spreadTotal） − asOf までの月割り額`。
 * 台帳残高のこの item ぶんと一致する（回収額を二重に引かない・引き忘れない。監査 P2-1）。
 * 終了日なしは月割り 0 なので spreadTotal がそのまま残る。
 */
export function remainingValue(
  item: MonthlyCostItem,
  asOf: string,
  spreadTotal: number = item.amount,
): number {
  const span = monthlyAllocationSpan(item);
  if (!span) return spreadTotal;
  const amounts = monthlyAmounts(spreadTotal, span.n);
  let done = 0;
  for (let k = 0; k < span.n; k++) {
    if (monthlyAllocationDate(item, span.from, k) <= asOf) done += amounts[k] ?? 0;
  }
  return spreadTotal - done;
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
