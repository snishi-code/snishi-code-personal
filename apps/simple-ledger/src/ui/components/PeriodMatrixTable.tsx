/*
 * 期間マトリクスの表（時間平面の**数値レンズ**）。
 *
 * 列は「年 12 か月」ではなく**可視範囲 + 前後バッファの窓**（年をまたいで連続し、
 * 横スクロール/シフトで移動する）。集計は domain/periodMatrix が済ませており、
 * ここは描画と横スクロールの幾何だけを持つ。
 *
 * **行は 3 レンズ共通のラベル列**（v13.6 H3）。数値レンズ専用の 6 分類の木は廃止し、
 * 線分レンズと同じ「箱 → 科目」の木 + 恒等行（収支・純資産）に periodMatrix の値を
 * 対応づけるだけにした。ラベル列の中身（チェック・展開トグル・色）は `LensRowTree` が持つ。
 * チェック OFF の行は値のセルが空になる（行そのものは残る = チェックし直せる）。
 *
 * 枠は 3 レンズ共通（`LensFrame`）。ラベル列は左・目盛り行（列見出し）は上・左上の隅は
 * 両方に貼り、スクロールは**この枠の中だけ**で起きる（ページ本体は横に伸びない）。
 */
import { useCallback, useMemo, useRef, type CSSProperties } from 'react';
import type { PeriodMatrix, PeriodMatrixColumn } from '../../domain/periodMatrix';
import { t } from '../../i18n';
import { UI } from '../../ui-contract';
import { Money, type MoneyTone } from '../money';
import { visibleIndexRange, type ScrollEdge } from '../scrollWindow';
import { useHorizonScroll } from '../horizonScroll';
import { LensRowLabel, lensLabelWidth, lensRowLabelProps, type LensRowView } from './LensRowTree';
import { LENS_FRAME, LensFrame } from './LensFrame';

/** 値列の幅（px）。CSS は JS のこの値を custom property 経由で受け取る。 */
const COLUMN_WIDTH = 112;

/** 年をまたぐ窓なので、年の変わり目（1 月）と先頭列だけ年を名乗る。 */
function monthColumnLabel(column: PeriodMatrixColumn, index: number): string {
  const month = column.month ?? 1;
  return index === 0 || month === 1
    ? t('matrix.monthLabelWithYear', { year: column.year, month })
    : t('matrix.monthLabel', { month });
}

/**
 * 数字の見せ方。C-2 の規約で負債の行だけ負債トークン色、恒等行のうち収支だけ符号付き
 * （増減の向きが意味を持つ唯一の行）。行の種類は共通木が名乗るのでここでは並びを持たない。
 */
function rowTone(row: LensRowView): MoneyTone | undefined {
  const box = row.node.boxKey;
  return box === 'shortTermDebt' || box === 'longTermDebt' ? 'liability' : undefined;
}

function isSigned(row: LensRowView): boolean {
  return row.node.sectionKey === 'net';
}

export function PeriodMatrixTable({
  matrix,
  rows,
  onToggleRow,
  onCheckRow,
  currency,
  focusDate,
  windowKey,
  onOpenMonth,
  onOpenYear,
  onVisibleRangeChange,
  onExtend,
}: {
  matrix: PeriodMatrix;
  /** 3 レンズ共通のラベル列の行（画面が解決済み）。 */
  rows: LensRowView[];
  onToggleRow: (id: string) => void;
  onCheckRow: (id: string, checked: boolean) => void;
  currency: string;
  /** 開いたとき / 窓を送ったときに中央へ置く日付。 */
  focusDate?: string;
  /** 窓の同一性。**列が継ぎ足されただけでは変わらない**（変わると中央へ戻ってしまう）。 */
  windowKey?: string;
  /** 月列のタップ: その月末を基準日にしてホームへ。 */
  onOpenMonth: (asOf: string) => void;
  /** 年列のタップ: その年を月ズームで見る。 */
  onOpenYear: (year: number) => void;
  /** 実際に見えている列の範囲（窓送りの起点に使う）。 */
  onVisibleRangeChange?: (range: { from: string; to: string }) => void;
  /** 端に近づいた = 窓をその側へ伸ばしたい（連続スクロール・v13.6 H2-3）。 */
  onExtend?: (edge: ScrollEdge) => void;
}) {
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const { columns } = matrix;
  const first = columns[0];
  const last = columns.at(-1);
  const caption =
    first && last ? t('matrix.caption', { from: first.key, to: last.key }) : t('matrix.noData');

  const readViewport = useCallback(
    (viewport: HTMLDivElement) => {
      if (viewport.clientWidth <= 0) return;
      const visible = visibleIndexRange(
        viewport.scrollLeft,
        viewport.clientWidth - lensLabelWidth(viewport.clientWidth),
        COLUMN_WIDTH,
        columns.length,
      );
      const from = visible && columns[visible.first];
      const to = visible && columns[visible.last];
      if (from && to) onVisibleRangeChange?.({ from: from.from, to: to.to });
    },
    [columns, onVisibleRangeChange],
  );

  // 窓を送った / ズームを変えた直後は、中央日付が見える位置から始める（線分レンズと同じ作法）。
  // 連続スクロールで列が左へ継ぎ足されたときの scrollLeft 補正も同じ機構が持つ。
  const focusIndex = useMemo(() => {
    if (focusDate === undefined) return -1;
    return columns.findIndex((column) => column.from <= focusDate && focusDate <= column.to);
  }, [columns, focusDate]);
  const columnKeys = useMemo(() => columns.map((column) => column.key), [columns]);
  const handleScroll = useHorizonScroll({
    viewportRef,
    keys: columnKeys,
    itemWidth: COLUMN_WIDTH,
    windowKey: `${windowKey ?? ''}:${focusDate ?? ''}`,
    focusScrollLeft: (viewport) => {
      if (focusIndex < 0) return viewport.scrollLeft;
      const trackWidth = Math.max(0, viewport.clientWidth - lensLabelWidth(viewport.clientWidth));
      return Math.max(0, (focusIndex + 0.5) * COLUMN_WIDTH - trackWidth / 2);
    },
    onSettle: readViewport,
    ...(onExtend ? { onExtend } : {}),
  });

  if (columns.length === 0) {
    return <p className="muted period-matrix__empty">{t('matrix.noData')}</p>;
  }

  return (
    <LensFrame
      viewportRef={viewportRef}
      className="period-matrix__scroll card"
      label={caption}
      dataUi={UI.timeline.matrix}
      onScroll={handleScroll}
      style={{ '--period-matrix-column-width': `${COLUMN_WIDTH}px` } as CSSProperties}
    >
      <table className="period-matrix__table">
        <caption className="sr-only">{caption}</caption>
        <thead>
          <tr>
            {/* 左上の隅。ラベル列の**見出し**であって行ではないので、行のセル
                （lens-row__label = display:flex）は着せない: 表のセルを flex にすると
                sticky の相手が匿名セルへ変わり、上（top）に貼れなくなる。 */}
            <th
              className={`period-matrix__corner ${LENS_FRAME.head} ${LENS_FRAME.corner}`}
              scope="col"
            >
              {t('matrix.itemColumn')}
            </th>
            {columns.map((column, index) => (
              <th
                className={`period-matrix__value ${LENS_FRAME.head} ${LENS_FRAME.pane}`}
                scope="col"
                key={column.key}
              >
                {column.month === undefined ? (
                  // 年ズーム: 年をタップ → その年を月ズームで見る（ヘッダーの日付は変えない）。
                  <button
                    type="button"
                    className="period-matrix__col-btn"
                    onClick={() => onOpenYear(column.year)}
                    aria-label={t('matrix.yearDrill', { year: column.year })}
                    data-ui={UI.timeline.matrixYearColumn}
                  >
                    {t('period.yearUnit', { year: column.year })}
                  </button>
                ) : (
                  // 月ズーム: 月をタップ → 基準日をその月末にしてホームへ（残高を見に行く導線）。
                  // column.to は集計と同じ月末の正本なので再計算しない。
                  <button
                    type="button"
                    className="period-matrix__col-btn"
                    onClick={() => onOpenMonth(column.to)}
                    aria-label={t('matrix.monthJump', { date: column.to })}
                    data-ui={UI.timeline.matrixMonthColumn}
                  >
                    {monthColumnLabel(column, index)}
                  </button>
                )}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <MatrixRow
              key={row.id}
              row={row}
              // チェック OFF の行 / 値を持たない行（月割り項目など）はセルを空にする。
              values={row.checked ? matrix.values.get(row.id) : undefined}
              columnCount={columns.length}
              currency={currency}
              onToggleRow={onToggleRow}
              onCheckRow={onCheckRow}
            />
          ))}
        </tbody>
      </table>
    </LensFrame>
  );
}

function MatrixRow({
  row,
  values,
  columnCount,
  currency,
  onToggleRow,
  onCheckRow,
}: {
  row: LensRowView;
  values: readonly number[] | undefined;
  columnCount: number;
  currency: string;
  onToggleRow: (id: string) => void;
  onCheckRow: (id: string, checked: boolean) => void;
}) {
  const labelProps = lensRowLabelProps(row);
  const tone = rowTone(row);
  return (
    <tr
      className={row.emphasis ? 'period-matrix__row--emphasis' : undefined}
      data-ui={UI.timeline.matrixRow}
      data-row-key={row.id}
    >
      <th {...labelProps} scope="row">
        <LensRowLabel row={row} onToggle={onToggleRow} onCheckChange={onCheckRow} />
      </th>
      {Array.from({ length: columnCount }, (_unused, index) => (
        <td
          className={`period-matrix__value ${LENS_FRAME.pane}`}
          data-ui={UI.timeline.matrixCell}
          key={index}
        >
          {values === undefined ? null : (
            <Money
              amount={values[index] ?? 0}
              currency={currency}
              signed={isSigned(row)}
              {...(tone ? { tone } : {})}
            />
          )}
        </td>
      ))}
    </tr>
  );
}
