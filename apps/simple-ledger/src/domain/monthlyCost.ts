/*
 * 月額化コスト（継続コスト）の計算 — **実績動的償却**。
 *
 * 「按分」という会計処理ではなく、現在の生活水準を維持するための月あたりコストを見える化する。
 * MonthlyCostItem は仕訳を生成しない登録簿で、月額はここで導出する。
 *
 * 実績動的償却（2026-07 作者決定）:
 *  - 見込み（costMonths）はあくまで暫定値。実績が確定するにつれて月額は真の値に収束する。
 *  - 更新なし・使用中の項目が見込みを超えたら、経過月数で全期間を再配分する
 *    （過去に遡って月額が下がる。30 万円を 5 年見込み → 実際 7 年使えば月 3,571 円に収束）。
 *  - 終了（売却・故障=0円売却・解約）したら、実使用月数で再配分し売却額を控除する
 *    （早く壊れれば過去に遡って月額が上がる。売却損益の一括計上はしない＝実績月額へ吸収）。
 *  - 自動更新あり（repeatEveryMonths）は各サイクルの期間・金額が固定なので動的化しない。
 *    最終サイクルだけは解約時に実使用月数へ切り詰める。
 * 過去の再計算は、認識が保存されない導出（仮想仕訳）だから可能になっている。
 *
 * 端数は monthlyAmounts（合計が必ず配分総額に一致）を使う。
 */
import { addMonths, monthlyAmounts, monthsBetween } from './allocation';
import type { MonthlyCostItem, MonthlyCostKind } from './types';

/**
 * 入力（何か月分 / 更新周期）から種類(kind)を推定する。
 * 入力 UI から「種類」選択を省くため。表示・将来拡張のための分類で、計算には使わない。
 */
export function inferMonthlyCostKind(
  costMonths: number,
  repeatEveryMonths: number | undefined,
): MonthlyCostKind {
  if (costMonths === 1 && repeatEveryMonths === 1) return 'subscription';
  if (costMonths === 12) return 'prepaid-service';
  if (costMonths > 12) return 'durable-asset';
  return 'recurring-event';
}

function hasRepeat(item: MonthlyCostItem): boolean {
  return item.repeatEveryMonths !== undefined && item.repeatEveryMonths > 0;
}

/**
 * サイクルの認識月数（実績動的償却の中核規則）。
 *  - 終了（status='ended'＝売却・解約・故障）: 実使用月数（cycleYm〜endMonth）で遡及再配分。
 *    更新ありは最終サイクルだけが切り詰められる（min(実使用, costMonths)）。
 *  - 一時停止（paused）: 遡及しない。見込みレートのまま endMonth で認識が止まる
 *    （再開でそのまま続きから。停止は「終了」ではないので過去を書き換えない）。
 *  - 更新なし・使用中: max(見込み costMonths, todayYm までの経過月数) ＝ 見込み超過で延伸。
 *  - 更新あり・使用中: costMonths 固定。
 */
export function cycleSpreadMonths(
  item: MonthlyCostItem,
  cycleYm: string,
  todayYm: string,
): number {
  if (item.endMonth !== undefined && item.status === 'ended') {
    const used = monthsBetween(cycleYm, item.endMonth) + 1;
    if (used <= 0) return 0;
    return hasRepeat(item) ? Math.min(used, item.costMonths) : used;
  }
  if (item.endMonth !== undefined || hasRepeat(item)) return item.costMonths;
  const elapsed = monthsBetween(cycleYm, todayYm) + 1;
  return Math.max(item.costMonths, Math.max(elapsed, 1));
}

/**
 * サイクルの配分総額。終了済みの最終サイクルは売却額（disposalProceedsAmount）を控除する
 * （売却益 = 売却額がサイクル額を超えた分だけ。処分時に別途実仕訳で計上される）。
 */
export function cycleSpreadTotal(item: MonthlyCostItem, cycleYm: string): number {
  const proceeds = item.disposalProceedsAmount ?? 0;
  if (proceeds === 0 || item.endMonth === undefined) return item.amount;
  const isFinal =
    !hasRepeat(item) ||
    (cycleYm <= item.endMonth &&
      monthsBetween(cycleYm, item.endMonth) < (item.repeatEveryMonths ?? 0));
  return isFinal ? Math.max(item.amount - proceeds, 0) : item.amount;
}

/**
 * 指定月 ym にこの項目が生活コストへ寄与する額。寄与しない月は 0。
 * todayYm は「いま」の月（動的償却の再配分基準）。過去の月を見ても、いまの知識
 * （実績月数）で再計算された値を返す＝仮想仕訳エンジンと同じ値になる。
 */
export function monthlyCostForMonth(
  item: MonthlyCostItem,
  ym: string,
  todayYm: string = ym,
): number {
  const since = monthsBetween(item.startMonth, ym);
  if (since < 0) return 0;
  if (item.endMonth !== undefined && monthsBetween(ym, item.endMonth) < 0) return 0;

  let cycleYm = item.startMonth;
  let pos = since;
  if (hasRepeat(item)) {
    const repeat = item.repeatEveryMonths ?? 1;
    const idx = Math.floor(since / repeat);
    cycleYm = addMonths(item.startMonth, idx * repeat);
    pos = since % repeat;
  }
  const months = cycleSpreadMonths(item, cycleYm, todayYm);
  if (pos >= months) return 0;
  return monthlyAmounts(cycleSpreadTotal(item, cycleYm), months)[pos] ?? 0;
}

/** 代表的な月額（表示用）。動的償却を反映した先頭月額。 */
export function representativeMonthlyAmount(
  item: MonthlyCostItem,
  todayYm: string = item.startMonth,
): number {
  const months = cycleSpreadMonths(item, item.startMonth, todayYm);
  if (months <= 0) return 0;
  return monthlyAmounts(cycleSpreadTotal(item, item.startMonth), months)[0] ?? 0;
}

/** 指定月の月額化コスト合計（全項目の合算）。 */
export function totalMonthlyCostForMonth(
  items: MonthlyCostItem[],
  ym: string,
  todayYm: string = ym,
): number {
  return items.reduce((s, it) => s + monthlyCostForMonth(it, ym, todayYm), 0);
}

/**
 * 見込み（costMonths）を超えて使用中か（更新なし・終了なしの項目のみ）。
 * 超過中は月額が実績で再計算され続ける（自動終了はしない。終了は売却/0円売却の明示操作）。
 */
export function isOverEstimate(item: MonthlyCostItem, todayYm: string): boolean {
  if (hasRepeat(item)) return false;
  if (item.endMonth !== undefined || item.status !== 'active') return false;
  return monthsBetween(item.startMonth, todayYm) + 1 > item.costMonths;
}
