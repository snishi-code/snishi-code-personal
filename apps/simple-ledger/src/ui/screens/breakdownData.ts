/*
 * ホーム/各内訳ページが共有する「推移」シリーズの単一正本。
 *
 * ホームの上段カード・各内訳ページ・推移グラフが必ず同じ定義を使うため、フロー（収入/支出/収支）
 * とストック（資産/負債/純資産）の月次バケット集計をここに集約する（数字のズレ防止）。
 *  - フロー（収入/支出/収支）は各バケットの `range` で集計（bar 表示）。
 *  - ストック（資産/負債/純資産）は各バケット末 `asOf` 時点の残高（line 表示）。
 *  - month モードは推移を出さない（単月）→ null。
 *  - all モードは年集約バーで、各点をタップしてその年へドリルできる（drillable）。
 */
import { deriveBalanceSheet, deriveProfitAndLoss } from '../../domain/accounting';
import { livingCostForRange } from '../../domain/livingCost';
import { dataYearsOf, trendBuckets, type ReportPeriod } from '../../domain/reportPeriod';
import type { Ledger } from '../../domain/types';
import type { TrendPoint } from '../components/TrendChart';

export interface SectionTrends {
  /** 収入（フロー）。 */
  revenue: TrendPoint[];
  /** 支出（フロー）。 */
  living: TrendPoint[];
  /** 収支＝収入 − 支出（フロー）。 */
  net: TrendPoint[];
  /** 資産合計（ストック）。 */
  assets: TrendPoint[];
  /** 負債合計（ストック）。 */
  liabilities: TrendPoint[];
  /** 純資産（ストック）。 */
  netAssets: TrendPoint[];
  /** all モードのとき、年キーでその年へドリルできる。 */
  drillable: boolean;
}

/**
 * 期間に応じた推移シリーズ一式を返す。month モード・データ無しは null。
 * 各画面は必要なシリーズだけを取り出して使う（定義は 1 か所）。
 */
export function buildSectionTrends(
  period: ReportPeriod,
  ledger: Ledger | null,
): SectionTrends | null {
  if (period.mode === 'month' || !ledger) return null;
  const accounts = ledger.accounts;
  // 集計は導出専用 entries（実仕訳 + 継続コストの仮想認識）を使う（単一正本）。
  const entries = ledger.derivedEntries;
  const buckets = trendBuckets(period, { dataYears: dataYearsOf(entries.map((e) => e.date)) });
  if (buckets.length === 0) return null;

  const revenue: TrendPoint[] = [];
  const living: TrendPoint[] = [];
  const net: TrendPoint[] = [];
  const assets: TrendPoint[] = [];
  const liabilities: TrendPoint[] = [];
  const netAssets: TrendPoint[] = [];

  for (const b of buckets) {
    const pl = deriveProfitAndLoss(accounts, entries, b.range);
    const bs = deriveBalanceSheet(accounts, entries, b.asOf);
    const livingB = livingCostForRange(accounts, entries, b.range);
    const base = { key: b.key, label: b.label };
    revenue.push({ ...base, value: pl.totalRevenue });
    living.push({ ...base, value: livingB });
    net.push({ ...base, value: pl.totalRevenue - livingB });
    assets.push({ ...base, value: bs.totalAssets });
    liabilities.push({ ...base, value: bs.totalLiabilities });
    netAssets.push({ ...base, value: bs.netAssets });
  }

  return {
    revenue,
    living,
    net,
    assets,
    liabilities,
    netAssets,
    drillable: period.mode === 'all',
  };
}
