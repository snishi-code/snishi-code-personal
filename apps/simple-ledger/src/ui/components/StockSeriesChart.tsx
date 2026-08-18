/*
 * ストックの折れ線（時間平面の**グラフレンズ**）。
 *
 * 数値レンズと同じ窓・同じ横スクロールの幾何・同じ集計（`domain/periodMatrix`）に載る。
 * ここは描画だけを持つ。
 *
 * - **ラベル列は 3 レンズ共通**（v13.6 H3）。専用の凡例は持たない: チェックボックスが
 *   そのまま系列選択で、色と名前も線分レンズ・数値レンズと同じもの。
 * - 系列 = **チェックされたストックの行**（箱 = その箱の科目の合算 / 科目 = 単独 /
 *   恒等行の純資産）。フロー行（収入・支出・収支）は描き方が決まるまで対象外で、
 *   チェックボックス自体が disabled（理由は読み上げる）。
 * - 枠は 3 レンズ共通（`LensFrame`）。**目盛り行（年月日）は枠の上端に貼る**ので SVG の
 *   中には持たない（中に置くと縦に送ったとき目盛りが流れる）。SVG は縦罫だけを描く。
 * - 線は**階段**（値はバケット末断面のストックなので、そのバケットの幅ぶん水平に引く）。
 * - 符号は自然符号（負債は借金の大きさがそのまま上へ伸びる）。0 の線は必ず軸に含める。
 * - 色は行の色（箱のアクセント = ラベル列と同じ）。同じ箱の科目どうしは色が同じになるので、
 *   **色だけに頼らない**ため線種をマスタ順に割り当てる。
 * - 縦軸は表示中の系列だけで決める。
 */
import { useCallback, useMemo, useRef, type CSSProperties } from 'react';
import type { PeriodMatrix } from '../../domain/periodMatrix';
import type { TimelineZoom } from '../../domain/timelineCalendar';
import { t } from '../../i18n';
import { formatMoney } from '../../util/format';
import { UI } from '../../ui-contract';
import { useMoneyDigits } from '../money';
import { visibleIndexRange, type ScrollEdge } from '../scrollWindow';
import { useHorizonScroll } from '../horizonScroll';
import { LensRowLabel, lensLabelWidth, lensRowLabelProps, type LensRowView } from './LensRowTree';
import { LENS_FRAME, LensFrame } from './LensFrame';

/** ラベル列 1 行の高さ（px）= タップ規約の 44px。CSS と同じ値をここでも使う。 */
const ROW_HEIGHT = 44;
const MIN_CHART_HEIGHT = 200;
const PLOT_TOP = 12;
/** プロット下端の余白（目盛りの文字は枠の上端へ移したので、ここは息継ぎだけ）。 */
const PLOT_BOTTOM_PAD = 12;

/**
 * 線種（色以外の識別子）。同じ箱の科目は色が同じなので、**マスタ順**に順番へ割り当てる
 * ＝ どの行がどの線かが白黒でも辿れる。先頭は実線。
 */
const DASH_PATTERNS: readonly string[] = ['', '6 3', '2 3', '10 3 2 3', '1 4'];

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
  rows,
  onToggleRow,
  onCheckRow,
  zoom,
  bucketWidth,
  currency,
  focusDate,
  windowKey,
  onVisibleRangeChange,
  onExtend,
}: {
  /** バケット末断面の値（行 id → 列値）。数値レンズと同じ集計エンジンの出力。 */
  series: PeriodMatrix;
  /** 3 レンズ共通のラベル列の行（画面が解決済み）。 */
  rows: LensRowView[];
  onToggleRow: (id: string) => void;
  onCheckRow: (id: string, checked: boolean) => void;
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
  /** 端に近づいた = 窓を伸ばしたい（連続スクロール・v13.6 H2-3）。 */
  onExtend?: (edge: ScrollEdge) => void;
}) {
  const digits = useMoneyDigits();
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const buckets = series.columns;
  const first = buckets[0];
  const last = buckets.at(-1);
  const caption =
    first && last ? t('chart.caption', { from: first.from, to: last.to }) : t('matrix.noData');

  const readViewport = useCallback(
    (viewport: HTMLDivElement) => {
      if (viewport.clientWidth <= 0) return;
      const range = visibleIndexRange(
        viewport.scrollLeft,
        viewport.clientWidth - lensLabelWidth(viewport.clientWidth),
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
      const trackWidth = Math.max(0, viewport.clientWidth - lensLabelWidth(viewport.clientWidth));
      return Math.max(0, (focusIndex + 0.5) * bucketWidth - trackWidth / 2);
    },
    onSettle: readViewport,
    ...(onExtend ? { onExtend } : {}),
  });

  /**
   * 描く系列 = チェックされたストックの行のうち、値を持つもの。**行の並びのまま**
   * （ラベル列を上から読んだ順に線種が割り当たる）。
   */
  const plotted = rows
    .map((row, index) => ({ row, values: series.values.get(row.id), index }))
    .filter(
      (candidate): candidate is { row: LensRowView; values: number[]; index: number } =>
        candidate.row.node.stock && candidate.row.checked && candidate.values !== undefined,
    );

  // 縦軸は**表示中の系列だけ**で決める。0 は必ず入れる。
  const shownValues = plotted.flatMap((candidate) => candidate.values);
  const top = shownValues.reduce((maximum, value) => Math.max(maximum, value), 0);
  const bottom = shownValues.reduce((minimum, value) => Math.min(minimum, value), 0);
  const span = top - bottom || 1;
  const chartHeight = Math.max(MIN_CHART_HEIGHT, rows.length * ROW_HEIGHT);
  const plotBottom = chartHeight - PLOT_BOTTOM_PAD;
  const plotHeight = plotBottom - PLOT_TOP;
  const yOf = (value: number): number => PLOT_TOP + ((top - value) / span) * plotHeight;
  const width = Math.max(bucketWidth, buckets.length * bucketWidth);

  /** 階段折れ線。値はバケット末の断面なので、そのバケットの幅ぶん水平に引く。 */
  const stepPoints = (values: readonly number[]): string =>
    buckets
      .flatMap((_bucket, index) => {
        const y = yOf(values[index] ?? 0);
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
      <LensFrame
        viewportRef={viewportRef}
        className="timeline-chart__viewport card"
        label={caption}
        dataUi={UI.timeline.chartViewport}
        onScroll={handleScroll}
      >
        {/* 目盛り行は 3 レンズ共通で**上に貼る**。SVG の中に置くと縦に送ったとき流れる。 */}
        <div className={`timeline-chart__head ${LENS_FRAME.head}`} data-ui={UI.timeline.chartHead}>
          <div className={`timeline-chart__head-corner ${LENS_FRAME.corner}`} aria-hidden="true" />
          <div
            className={`timeline-chart__ticks ${LENS_FRAME.pane}`}
            style={{ width }}
            aria-hidden="true"
          >
            {ticks.map((tick) => (
              <span className="timeline-chart__tick-label" key={tick.key} style={{ left: tick.x }}>
                {tick.label}
              </span>
            ))}
          </div>
        </div>

        <div className="timeline-chart__canvas">
          {/* ラベル列は 3 レンズ共通（チェックボックスが凡例を兼ねる）。 */}
          <div className="timeline-chart__rows" role="group" aria-label={t('lens.rowTree')}>
            {rows.map((row) => {
              const labelProps = lensRowLabelProps(row);
              return (
                <div key={row.id} {...labelProps}>
                  <LensRowLabel row={row} onToggle={onToggleRow} onCheckChange={onCheckRow} />
                </div>
              );
            })}
          </div>

          <div className={`timeline-chart__plot ${LENS_FRAME.pane}`}>
            <svg
              className="timeline-chart__svg"
              width={width}
              height={chartHeight}
              viewBox={`0 0 ${width} ${chartHeight}`}
              aria-hidden="true"
              focusable="false"
            >
              {/* 目盛りの**文字**は枠の上端（timeline-chart__head）が持つ。ここは縦罫だけ。 */}
              {ticks.map((tick) => (
                <line
                  className="timeline-chart__gridline"
                  key={tick.key}
                  x1={tick.x}
                  x2={tick.x}
                  y1={PLOT_TOP}
                  y2={plotBottom}
                />
              ))}
              <line className="timeline-chart__zero" x1={0} x2={width} y1={yOf(0)} y2={yOf(0)} />
              {plotted.map((candidate) => {
                const dash = DASH_PATTERNS[candidate.index % DASH_PATTERNS.length]!;
                return (
                  <polyline
                    key={candidate.row.id}
                    className="timeline-chart__line"
                    style={{ '--lens-accent': candidate.row.accent } as CSSProperties}
                    data-ui={UI.timeline.chartLine}
                    data-row-key={candidate.row.id}
                    points={stepPoints(candidate.values)}
                    {...(dash ? { strokeDasharray: dash } : {})}
                  />
                );
              })}
            </svg>
          </div>
        </div>
      </LensFrame>
      {plotted.length === 0 ? (
        <p className="field__hint" data-ui={UI.timeline.chartNoSeries}>
          {t('chart.noSeries')}
        </p>
      ) : (
        <p className="sr-only">
          {plotted
            .map((candidate) =>
              t('chart.seriesSummary', {
                name: candidate.row.label,
                from: first?.from ?? '',
                start: formatMoney(candidate.values[0] ?? 0, currency, digits),
                to: last?.to ?? '',
                end: formatMoney(candidate.values.at(-1) ?? 0, currency, digits),
              }),
            )
            .join('')}
        </p>
      )}
    </figure>
  );
}
