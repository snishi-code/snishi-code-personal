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

/** from〜to（'YYYY-MM'）を含む連続月の列（昇順）。from > to なら空。 */
function monthsBetween(from: string, to: string): string[] {
  const out: string[] = [];
  let cur = from;
  // 上限ガード（最長でも数百年）。実データ規模では到達しない。
  for (let i = 0; i < 12000 && cur <= to; i++) {
    out.push(cur);
    cur = addMonths(cur, 1);
  }
  return out;
}

/**
 * トレンド用の月次バケット列。
 *  - month: その月 1 つ。
 *  - year:  その年の 1〜12 月（12 個）。
 *  - all:   最初のデータ月〜最後のデータ月を**連続**で（空白月も含む）。データが無ければ空配列。
 *           空白月を落とさないのは、家計の推移として連続した時間軸で見たいため。
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
  // all: 最初〜最後のデータ月を連続で（空白月も埋める）。
  const months = Array.from(new Set(opts.dataMonths ?? [])).sort();
  if (months.length === 0) return [];
  const filled = monthsBetween(months[0]!, months[months.length - 1]!);
  return filled.map((ym) => {
    const { year, month } = ymParts(ym);
    return bucket(year, month, true);
  });
}

/** 'YYYY-MM-DD' の配列から、データのある月 'YYYY-MM' を昇順・重複排除で返す。 */
export function dataMonthsOf(dates: string[]): string[] {
  return Array.from(new Set(dates.map((d) => d.slice(0, 7)))).sort();
}

/** 'YYYY-MM-DD' の配列から、データのある年（数値）を昇順・重複排除で返す。 */
export function dataYearsOf(dates: string[]): number[] {
  return Array.from(new Set(dates.map((d) => Number.parseInt(d.slice(0, 4), 10))))
    .filter((y) => Number.isFinite(y) && y > 0)
    .sort((a, b) => a - b);
}

/** トレンドの 1 バー分。年集約のときは key=年文字列・year で「その年へ切替」できる。 */
export interface TrendBucket {
  /** 月集約は 'YYYY-MM'、年集約は 'YYYY'。 */
  key: string;
  /** バーのラベル（年集約は 'YYYY年'、月集約は 'M月'）。 */
  label: string;
  /** この区間（年集約=その年、月集約=その月）。フロー集計に使う。 */
  range: DateRange;
  /** 区間末（年末/月末）。BS 時系列に使う基準日。 */
  asOf: string;
  /** この区間が属する年（年集約のクリック遷移に使う）。 */
  year: number;
}

/**
 * トレンド（グラフ）用のバケット列。縦長リストを避け、俯瞰しやすい粒度にする。
 *  - month: 単月なので推移は出さない（空配列）。
 *  - year:  その年の 1〜12 月（12 本の月次バー）。
 *  - all:   最初〜最後のデータ年を**連続**で（年次バー。空白年も埋める）。データが無ければ空配列。
 */
export function trendBuckets(p: ReportPeriod, opts: { dataYears?: number[] } = {}): TrendBucket[] {
  if (p.mode === 'month') return [];
  if (p.mode === 'year') {
    return Array.from({ length: 12 }, (_, i) => {
      const range = monthRange(p.year, i + 1);
      return {
        key: `${p.year}-${pad2(i + 1)}`,
        label: `${i + 1}月`,
        range,
        asOf: range.to,
        year: p.year,
      };
    });
  }
  // all: データのある年を最小〜最大で連続に（年次バー）。
  const years = (opts.dataYears ?? []).filter((y) => Number.isFinite(y) && y > 0);
  if (years.length === 0) return [];
  const lo = Math.min(...years);
  const hi = Math.max(...years);
  const out: TrendBucket[] = [];
  for (let y = lo; y <= hi && out.length < 200; y++) {
    out.push({
      key: `${y}`,
      label: `${y}年`,
      range: { from: `${y}-01-01`, to: `${y}-12-31` },
      asOf: `${y}-12-31`,
      year: y,
    });
  }
  return out;
}

/**
 * 年別セレクトの選択肢（降順）。データ（仕訳・予定CF の日付）がある年、現在年、翌年、
 * 選択中の年を含む連続範囲を返す。長期の資金計画（数十年）にも追従する。
 * 異常値での暴発を防ぐため現在年 ±50 にクランプする（選択中の年は必ず含める）。
 */
export function availableYears(
  dates: string[],
  currentYear: number,
  selectedYear?: number,
): number[] {
  const ys = dates
    .map((d) => Number.parseInt(d.slice(0, 4), 10))
    .filter((y) => Number.isFinite(y) && y > 0);
  const candidates = [...ys, currentYear, currentYear + 1];
  let lo = Math.max(Math.min(...candidates), currentYear - 50);
  let hi = Math.min(Math.max(...candidates), currentYear + 50);
  if (selectedYear) {
    lo = Math.min(lo, selectedYear);
    hi = Math.max(hi, selectedYear);
  }
  const out: number[] = [];
  for (let y = hi; y >= lo; y--) out.push(y);
  return out;
}
