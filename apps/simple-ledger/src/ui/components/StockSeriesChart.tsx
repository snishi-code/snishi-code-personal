/*
 * ストック 4 系列の折れ線（時間平面の**グラフレンズ**）。
 *
 * 数値レンズと同じ窓・同じ横スクロールの幾何に載る（可視添字の正本は `ui/scrollWindow`）。
 * 集計は `domain/stockSeries` が済ませており、ここは描画と凡例の開閉だけを持つ。
 *
 * - **ラベル列 = 凡例トグル**。系列名の行をタップで表示 / 非表示（`aria-pressed`・44px）。
 *   既定 ON は純資産と自由に動かせるお金（`STOCK_SERIES_DEFAULT_VISIBLE`）。
 * - 線は**階段**（値はバケット末断面のストックなので、そのバケットの幅ぶん水平に引く）。
 * - 色は意味色のトークン（`--series-*`）。**色だけに頼らない**ため、系列ごとに線種を変え、
 *   凡例のチップも同じ線種で描く（凡例 → 線の対応が白黒でも辿れる）。
 * - 縦軸は表示中の系列だけで決める（0 は必ず含める＝負債が下へ、資産が上へ伸びる）。
 */
import { useCallback, useMemo, useRef, useState, type CSSProperties } from 'react';
import {
  STOCK_SERIES_DEFAULT_VISIBLE,
  STOCK_SERIES_KEYS,
  type StockSeries,
  type StockSeriesKey,
} from '../../domain/stockSeries';
import type { TimelineZoom } from '../../domain/timelineCalendar';
import { t, type MessageKey } from '../../i18n';
import { formatMoney } from '../../util/format';
import { UI } from '../../ui-contract';
import { Money } from '../money';
import { useMoneyDigits } from '../money';
import { visibleIndexRange, type ScrollEdge } from '../scrollWindow';
import { useHorizonScroll } from '../horizonScroll';

/** 凡例列の幅（px）。可視添字の計算にも同じ値を使う（2 か所に生値を置かない）。 */
const LEGEND_WIDTH = 140;
const CHART_HEIGHT = 200;
const PLOT_TOP = 12;
/** これより下は目盛りのラベル帯。 */
const PLOT_BOTTOM = 168;

/**
 * 系列の見せ方。ラベルは**ホームのカード / 資産内訳の枠と同じメッセージキー**を使う
 * （語彙を 2 か所に持たない）。`dash` は色以外の識別子（凡例のチップと線で同じ）。
 */
const SERIES_META: Record<StockSeriesKey, { labelKey: MessageKey; dash: string }> = {
  assets: { labelKey: 'dashboard.assets', dash: '6 3' },
  liabilities: { labelKey: 'dashboard.liabilities', dash: '2 3' },
  netAssets: { labelKey: 'dashboard.netAssets', dash: '' },
  freeFunds: { labelKey: 'assets.frame.free', dash: '10 3 2 3' },
};

/** 大きい単位の変わり目（日 = 月が変わる / 月・年 = 年が変わる）。ここは必ず目盛りを打つ。 */
function tickGroupOf(date: string, zoom: TimelineZoom): string {
  return zoom === 'day' ? date.slice(0, 7) : date.slice(0, 4);
}

/**
 * 変わり目の**間**にも打つ間隔（バケット数）。窓のどこを見ていても目盛りが入るよう、
 * バケット幅 × これを 390px 実機の可視トラック（≒ 250px）より狭くする（年の変わり目だけだと、
 * 画面に 1 つも目盛りが無い位置が生まれる）。
 */
const TICK_EVERY: Record<TimelineZoom, number> = { day: 5, month: 2, year: 1 };

/** 変わり目は大きい単位（年 / 月）、間の目盛りは小さい単位（月 / 日）で名乗る。 */
function tickLabelOf(date: string, zoom: TimelineZoom, groupStart: boolean): string {
  const year = Number.parseInt(date.slice(0, 4), 10);
  const month = Number.parseInt(date.slice(5, 7), 10);
  if (zoom === 'year') return t('period.yearUnit', { year });
  if (zoom === 'month') {
    return groupStart ? t('period.yearUnit', { year }) : t('matrix.monthLabel', { month });
  }
  return groupStart
    ? t('matrix.monthLabel', { month })
    : t('chart.tickDay', { day: Number.parseInt(date.slice(8, 10), 10) });
}

export function StockSeriesChart({
  series,
  zoom,
  bucketWidth,
  currency,
  focusDate,
  windowKey,
  onVisibleRangeChange,
  onExtend,
}: {
  series: StockSeries;
  zoom: TimelineZoom;
  /** 1 バケットの幅（px）。線分レンズと同じ値を受け取る（窓の幾何を揃える）。 */
  bucketWidth: number;
  currency: string;
  /** 開いたとき / 窓を送ったときに中央へ置く日付。 */
  focusDate?: string;
  /** 窓の同一性。**バケットが継ぎ足されただけでは変わらない**（変わると中央へ戻ってしまう）。 */
  windowKey?: string;
  /** 実際に見えている範囲（窓送りの起点に使う）。 */
  onVisibleRangeChange?: (range: { from: string; to: string }) => void;
  /** 端に近づいた = 窓をその側へ伸ばしたい（連続スクロール・v13.6 H2-3）。 */
  onExtend?: (edge: ScrollEdge) => void;
}) {
  const digits = useMoneyDigits();
  const viewportRef = useRef<HTMLDivElement | null>(null);
  // 凡例の開閉は画面ローカル・保存しない（数値レンズの展開状態と同じ作法）。
  const [visible, setVisible] = useState<ReadonlySet<StockSeriesKey>>(
    () => new Set(STOCK_SERIES_DEFAULT_VISIBLE),
  );
  const toggle = (key: StockSeriesKey) => {
    setVisible((previous) => {
      const next = new Set(previous);
      if (!next.delete(key)) next.add(key);
      return next;
    });
  };

  const { buckets, values } = series;
  const first = buckets[0];
  const last = buckets.at(-1);
  const caption =
    first && last ? t('chart.caption', { from: first.from, to: last.to }) : t('matrix.noData');

  const readViewport = useCallback(
    (viewport: HTMLDivElement) => {
      if (viewport.clientWidth <= 0) return;
      const range = visibleIndexRange(
        viewport.scrollLeft,
        viewport.clientWidth - LEGEND_WIDTH,
        bucketWidth,
        buckets.length,
      );
      const from = range && buckets[range.first];
      const to = range && buckets[range.last];
      if (from && to) onVisibleRangeChange?.({ from: from.from, to: to.to });
    },
    [bucketWidth, buckets, onVisibleRangeChange],
  );

  // 中央寄せ（窓を送った直後）と、連続スクロールの継ぎ足し・scrollLeft 補正は
  // 3 レンズ共通の機構が持つ（線分レンズ・数値レンズと同じ規則で動く）。
  const focusIndex = useMemo(() => {
    if (focusDate === undefined) return -1;
    return buckets.findIndex((bucket) => bucket.from <= focusDate && focusDate <= bucket.to);
  }, [buckets, focusDate]);
  const bucketKeys = useMemo(() => buckets.map((bucket) => bucket.key), [buckets]);
  const handleScroll = useHorizonScroll({
    viewportRef,
    keys: bucketKeys,
    itemWidth: bucketWidth,
    windowKey: `${windowKey ?? ''}:${focusDate ?? ''}`,
    focusScrollLeft: (viewport) => {
      if (focusIndex < 0) return viewport.scrollLeft;
      const trackWidth = Math.max(0, viewport.clientWidth - LEGEND_WIDTH);
      return Math.max(0, (focusIndex + 0.5) * bucketWidth - trackWidth / 2);
    },
    onSettle: readViewport,
    ...(onExtend ? { onExtend } : {}),
  });

  // 縦軸は**表示中の系列だけ**で決める。0 は必ず入れる（負債が下・資産が上に出る軸にする）。
  const shown = STOCK_SERIES_KEYS.filter((key) => visible.has(key));
  const plotted = shown.flatMap((key) => values[key]);
  const top = plotted.reduce((maximum, value) => Math.max(maximum, value), 0);
  const bottom = plotted.reduce((minimum, value) => Math.min(minimum, value), 0);
  const span = top - bottom || 1;
  const plotHeight = PLOT_BOTTOM - PLOT_TOP;
  const yOf = (value: number): number => PLOT_TOP + ((top - value) / span) * plotHeight;
  const width = Math.max(bucketWidth, buckets.length * bucketWidth);

  /** 階段折れ線。値はバケット末の断面なので、そのバケットの幅ぶん水平に引く。 */
  const stepPoints = (key: StockSeriesKey): string =>
    buckets
      .flatMap((_bucket, index) => {
        const y = yOf(values[key][index] ?? 0);
        return [`${index * bucketWidth},${y}`, `${(index + 1) * bucketWidth},${y}`];
      })
      .join(' ');

  const ticks: { key: string; x: number; label: string }[] = [];
  let previousGroup: string | undefined;
  buckets.forEach((bucket, index) => {
    const group = tickGroupOf(bucket.from, zoom);
    const groupStart = group !== previousGroup;
    previousGroup = group;
    if (!groupStart && index % TICK_EVERY[zoom] !== 0) return;
    ticks.push({
      key: bucket.key,
      x: index * bucketWidth,
      label: tickLabelOf(bucket.from, zoom, groupStart),
    });
  });

  if (buckets.length === 0) {
    return <p className="muted period-matrix__empty">{t('matrix.noData')}</p>;
  }

  return (
    <figure className="timeline-chart" data-ui={UI.timeline.chart}>
      <figcaption className="sr-only">{caption}</figcaption>
      <div
        ref={viewportRef}
        className="timeline-chart__viewport card"
        role="region"
        tabIndex={0}
        aria-label={caption}
        data-ui={UI.timeline.chartViewport}
        onScroll={(event) => handleScroll(event.currentTarget)}
        style={{ '--timeline-chart-legend-width': `${LEGEND_WIDTH}px` } as CSSProperties}
      >
        <div className="timeline-chart__canvas">
          {/* ラベル列 = 凡例。系列名の行そのものがトグル（別のチェックボックスを足さない）。 */}
          <div className="timeline-chart__legend" role="group" aria-label={t('chart.legend')}>
            {STOCK_SERIES_KEYS.map((key) => {
              const meta = SERIES_META[key];
              const name = t(meta.labelKey);
              const endValue = values[key].at(-1) ?? 0;
              const on = visible.has(key);
              return (
                <button
                  type="button"
                  key={key}
                  className="timeline-chart__legend-btn"
                  style={{ '--timeline-series': `var(--series-${key})` } as CSSProperties}
                  aria-pressed={on}
                  aria-label={t('chart.legendToggle', {
                    name,
                    date: last?.to ?? '',
                    amount: formatMoney(endValue, currency, digits),
                  })}
                  onClick={() => toggle(key)}
                  data-ui={UI.timeline.chartLegend}
                  data-series-key={key}
                >
                  {/* 色見本チップ。線と**同じ線種**で描くので、色が見えなくても対応が取れる。 */}
                  <svg
                    className="timeline-chart__chip"
                    width={24}
                    height={8}
                    viewBox="0 0 24 8"
                    aria-hidden="true"
                    focusable="false"
                  >
                    <line
                      className="timeline-chart__chip-line"
                      x1={1}
                      x2={23}
                      y1={4}
                      y2={4}
                      {...(meta.dash ? { strokeDasharray: meta.dash } : {})}
                    />
                  </svg>
                  <span className="timeline-chart__legend-text" aria-hidden="true">
                    <span className="timeline-chart__legend-name">{name}</span>
                    <span className="timeline-chart__legend-value">
                      <Money amount={endValue} currency={currency} />
                    </span>
                  </span>
                </button>
              );
            })}
          </div>

          <div className="timeline-chart__plot">
            <svg
              className="timeline-chart__svg"
              width={width}
              height={CHART_HEIGHT}
              viewBox={`0 0 ${width} ${CHART_HEIGHT}`}
              aria-hidden="true"
              focusable="false"
            >
              {ticks.map((tick) => (
                <g key={tick.key}>
                  <line
                    className="timeline-chart__gridline"
                    x1={tick.x}
                    x2={tick.x}
                    y1={PLOT_TOP}
                    y2={PLOT_BOTTOM}
                  />
                  <text className="timeline-chart__tick" x={tick.x + 2} y={CHART_HEIGHT - 8}>
                    {tick.label}
                  </text>
                </g>
              ))}
              <line className="timeline-chart__zero" x1={0} x2={width} y1={yOf(0)} y2={yOf(0)} />
              {shown.map((key) => (
                <polyline
                  key={key}
                  className="timeline-chart__line"
                  style={{ '--timeline-series': `var(--series-${key})` } as CSSProperties}
                  data-ui={UI.timeline.chartLine}
                  data-series-key={key}
                  points={stepPoints(key)}
                  {...(SERIES_META[key].dash ? { strokeDasharray: SERIES_META[key].dash } : {})}
                />
              ))}
            </svg>
          </div>
        </div>
      </div>
      {shown.length === 0 ? (
        <p className="field__hint" data-ui={UI.timeline.chartNoSeries}>
          {t('chart.noSeries')}
        </p>
      ) : (
        <p className="sr-only">
          {shown
            .map((key) =>
              t('chart.seriesSummary', {
                name: t(SERIES_META[key].labelKey),
                from: first?.from ?? '',
                start: formatMoney(values[key][0] ?? 0, currency, digits),
                to: last?.to ?? '',
                end: formatMoney(values[key].at(-1) ?? 0, currency, digits),
              }),
            )
            .join('')}
        </p>
      )}
    </figure>
  );
}
