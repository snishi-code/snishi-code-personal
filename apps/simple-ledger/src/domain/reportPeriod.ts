/*
 * レポート期間モデル。ダッシュボード/財務諸表/仕訳/資金繰りが共有する「いつの数字か」。
 *
 *  - レポート表示は reportBasis からフロー期間とストック基準日を同時に得る。
 *  - date は選択日の断面、選択中の年だけ今日で止め、過去・未来の年は期間末、
 *    全期間は今日を基準日とする。
 *  - フローも同じ基準日までに揃え、PL と BS の日付境界をずらさない。
 *  - periodRange は「将来予定も表示」を別に扱う仕訳一覧の互換 API。レポート集計には使わない。
 */
export type ReportPeriod =
  | { mode: 'date'; date: string }
  | { mode: 'year'; year: number }
  | { mode: 'all' };

export interface DateRange {
  from: string;
  to: string;
}

/** レポートのフロー期間。全期間だけ開始日を持たず、今日までを表す。 */
export interface ReportFlowRange {
  from?: string;
  to: string;
}

/** 1 画面のフロー集計とストック集計が共有する日付基準。 */
export interface ReportBasis {
  flowRange: ReportFlowRange;
  asOf: string;
}

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

/**
 * フロー（PL/仕訳/CF）が使う期間。全体(all)は期間制約なし = undefined。
 */
export function periodRange(p: ReportPeriod): DateRange | undefined {
  if (p.mode === 'all') return undefined;
  if (p.mode === 'year') return { from: `${p.year}-01-01`, to: `${p.year}-12-31` };
  return { from: `${p.date.slice(0, 7)}-01`, to: p.date };
}

/**
 * レポート表示の単一期間基準。
 *  - date: 選択月の月初〜選択日、asOf=選択日
 *  - 過去の year: 年初〜年末、asOf=年末
 *  - 選択中の year: 年初〜今日、asOf=今日
 *  - 未来の year: 年初〜年末、asOf=年末
 *  - all: 開始制約なし〜今日、asOf=今日
 *
 * 未来期間を明示的に選んだ場合だけ、その期間末までの見込みを表示する。全期間表示へ
 * 未来の実仕訳・継続コストを混ぜないため、all は常に今日で止める。
 */
export function reportBasis(p: ReportPeriod, today: string): ReportBasis {
  if (p.mode === 'all') return { flowRange: { to: today }, asOf: today };

  const fullRange = periodRange(p);
  if (!fullRange) throw new Error('date/year の期間範囲を導出できません。');
  if (p.mode === 'date') {
    return {
      flowRange: { from: fullRange.from, to: p.date },
      asOf: p.date,
    };
  }
  const isCurrent = fullRange.from <= today && today <= fullRange.to;
  const asOf = isCurrent ? today : fullRange.to;
  return {
    flowRange: { from: fullRange.from, to: asOf },
    asOf,
  };
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
 *  - date: 選択日までの単月なので推移は出さない（空配列）。
 *  - year:  その年の 1〜12 月（12 本の月次バー）。
 *  - all:   最初〜最後のデータ年を**連続**で（年次バー。空白年も埋める）。データが無ければ空配列。
 */
export function trendBuckets(
  p: ReportPeriod,
  today: string,
  opts: { dataYears?: number[] } = {},
): TrendBucket[] {
  if (p.mode === 'date') return [];
  if (p.mode === 'year') {
    return Array.from({ length: 12 }, (_, i) => {
      const month = i + 1;
      const from = `${p.year}-${pad2(month)}-01`;
      const lastDay = new Date(p.year, month, 0).getDate();
      const to = `${p.year}-${pad2(month)}-${pad2(lastDay)}`;
      const asOf = from <= today && today <= to ? today : to;
      return {
        key: `${p.year}-${pad2(month)}`,
        label: `${month}月`,
        range: { from, to: asOf },
        asOf,
        year: p.year,
      };
    });
  }
  // all: データのある年を最小〜最大で連続に（年次バー）。
  const todayYear = Number.parseInt(today.slice(0, 4), 10);
  const years = (opts.dataYears ?? []).filter((y) => Number.isFinite(y) && y > 0 && y <= todayYear);
  if (years.length === 0) return [];
  const lo = Math.min(...years);
  const hi = Math.max(...years);
  const out: TrendBucket[] = [];
  for (let y = lo; y <= hi && out.length < 200; y++) {
    const basis = reportBasis({ mode: 'year', year: y }, today);
    const from = basis.flowRange.from;
    if (!from) throw new Error('年次トレンドの開始日を導出できません。');
    out.push({
      key: `${y}`,
      label: `${y}年`,
      range: { from, to: basis.flowRange.to },
      asOf: basis.asOf,
      year: y,
    });
  }
  return out;
}

/**
 * 年別セレクトの選択肢（降順）。データ（仕訳の日付）がある年、現在年、翌年、
 * 選択中の年とその翌年を含む連続範囲を返す。長期の資金計画（数十年）にも追従し、
 * 継続中ルールだけの台帳でも年を 1 つずつ先へ進めて任意の未来断面を選べる。
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
    hi = Math.max(hi, selectedYear + 1);
  }
  const out: number[] = [];
  for (let y = hi; y >= lo; y--) out.push(y);
  return out;
}
