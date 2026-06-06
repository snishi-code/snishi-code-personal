/*
 * レポート期間モデル。ダッシュボード/財務諸表/仕訳/資金繰りが共有する「いつの数字か」。
 *
 *  - PL・仕訳・CF（フロー）は「期間」= periodRange を使う（all は全期間 = undefined）。
 *  - BS（ストック）は「基準日」= periodAsOf を使う（月→月末 / 年→年末 / 全体→今日 or 最終データ日）。
 *    フロー（期間合計）と BS（ある時点の残高）を混同しない。
 *  - トレンド（年/全体）は periodBuckets で月次バケットに割る。
 */
import { monthRange } from './accounting';
import { addMonths } from './allocation';

export type ReportPeriod =
  | { mode: 'month'; year: number; month: number }
  | { mode: 'year'; year: number }
  | { mode: 'all' };

export interface DateRange {
  from: string;
  to: string;
}

/** その期間の月次バケット 1 つ分（トレンド用）。 */
export interface PeriodBucket {
  /** 'YYYY-MM' */
  ym: string;
  /** バー等に出す短いラベル。 */
  label: string;
  /** その月のフロー集計に使う期間。 */
  range: DateRange;
  /** その月末（BS の時系列に使う基準日）。 */
  asOf: string;
}

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

function ymParts(ym: string): { year: number; month: number } {
  const [y, m] = ym.split('-');
  return { year: Number.parseInt(y ?? '0', 10), month: Number.parseInt(m ?? '0', 10) };
}

/**
 * フロー（PL/仕訳/CF）が使う期間。全体(all)は期間制約なし = undefined。
 */
export function periodRange(p: ReportPeriod): DateRange | undefined {
  if (p.mode === 'all') return undefined;
  if (p.mode === 'year') return { from: `${p.year}-01-01`, to: `${p.year}-12-31` };
  return monthRange(p.year, p.month);
}

/**
 * BS（ストック）が使う基準日。
 *  - month: 月末
 *  - year:  年末
 *  - all:   最終データ日（あれば）/ なければ今日
 */
export function periodAsOf(p: ReportPeriod, today: string, lastDataDate?: string): string {
  if (p.mode === 'month') return monthRange(p.year, p.month).to;
  if (p.mode === 'year') return `${p.year}-12-31`;
  return lastDataDate && lastDataDate.length > 0 ? lastDataDate : today;
}

/** 表示用ラベル（日本語）。 */
export function periodLabel(p: ReportPeriod): string {
  if (p.mode === 'month') return `${p.year}年${p.month}月`;
  if (p.mode === 'year') return `${p.year}年`;
  return '全期間';
}

/**
 * トレンド用の月次バケット列。
 *  - month: その月 1 つ。
 *  - year:  その年の 1〜12 月（12 個）。
 *  - all:   データのある月（dataMonths, 'YYYY-MM'）を昇順に。空なら空配列。
 */
export function periodBuckets(
  p: ReportPeriod,
  opts: { dataMonths?: string[] } = {},
): PeriodBucket[] {
  const bucket = (year: number, month: number, withYear: boolean): PeriodBucket => {
    const range = monthRange(year, month);
    return {
      ym: `${year}-${pad2(month)}`,
      label: withYear ? `${year}/${pad2(month)}` : `${month}月`,
      range,
      asOf: range.to,
    };
  };

  if (p.mode === 'month') return [bucket(p.year, p.month, true)];
  if (p.mode === 'year') {
    return Array.from({ length: 12 }, (_, i) => bucket(p.year, i + 1, false));
  }
  // all: データのある月だけ（昇順・重複排除）。
  const months = Array.from(new Set(opts.dataMonths ?? [])).sort();
  return months.map((ym) => {
    const { year, month } = ymParts(ym);
    return bucket(year, month, true);
  });
}

/** 'YYYY-MM-DD' の配列から、データのある月 'YYYY-MM' を昇順・重複排除で返す。 */
export function dataMonthsOf(dates: string[]): string[] {
  return Array.from(new Set(dates.map((d) => d.slice(0, 7)))).sort();
}

/** n か月ぶん次の ym（'YYYY-MM'）。期間移動の UI 用。 */
export function shiftYm(ym: string, n: number): string {
  return addMonths(ym, n);
}
