/*
 * 期間マトリクスの表（時間平面の**数値レンズ**）。
 *
 * 旧「年間・全体」画面の表をそのまま持ってきたもの。違いは列が「年 12 か月」ではなく
 * **可視範囲 + 前後バッファの窓**であること（年をまたいで連続し、横スクロール/シフトで移動する）。
 * 集計は domain/periodMatrix が済ませており、ここは描画と横スクロールの幾何だけを持つ。
 *
 * 行ラベル列は sticky。横スクロールは**この枠の中だけ**で起き、ページ本体は横に伸びない。
 */
import { useCallback, useLayoutEffect, useMemo, useRef, type CSSProperties } from 'react';
import type { PeriodMatrix, PeriodMatrixColumn } from '../../domain/periodMatrix';
import { t } from '../../i18n';
import { UI } from '../../ui-contract';
import { Money } from '../money';
import { visibleIndexRange } from '../scrollWindow';

/** 行ラベル列と値列の幅（px）。CSS は JS のこの値を custom property 経由で受け取る。 */
const LABEL_WIDTH = 112;
const COLUMN_WIDTH = 112;

/** 年をまたぐ窓なので、年の変わり目（1 月）と先頭列だけ年を名乗る。 */
function monthColumnLabel(column: PeriodMatrixColumn, index: number): string {
  const month = column.month ?? 1;
  return index === 0 || month === 1
    ? t('matrix.monthLabelWithYear', { year: column.year, month })
    : t('matrix.monthLabel', { month });
}

export function PeriodMatrixTable({
  matrix,
  currency,
  focusDate,
  onOpenMonth,
  onOpenYear,
  onVisibleRangeChange,
}: {
  matrix: PeriodMatrix;
  currency: string;
  /** 開いたとき / 窓を送ったときに中央へ置く日付。 */
  focusDate?: string;
  /** 月列のタップ: その月末を基準日にしてホームへ。 */
  onOpenMonth: (asOf: string) => void;
  /** 年列のタップ: その年を月ズームで見る。 */
  onOpenYear: (year: number) => void;
  /** 実際に見えている列の範囲（窓送りの起点に使う）。 */
  onVisibleRangeChange?: (range: { from: string; to: string }) => void;
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
        viewport.clientWidth - LABEL_WIDTH,
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
  const focusIndex = useMemo(() => {
    if (focusDate === undefined) return -1;
    return columns.findIndex((column) => column.from <= focusDate && focusDate <= column.to);
  }, [columns, focusDate]);

  useLayoutEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    if (focusIndex >= 0) {
      const trackWidth = Math.max(0, viewport.clientWidth - LABEL_WIDTH);
      viewport.scrollLeft = Math.max(0, (focusIndex + 0.5) * COLUMN_WIDTH - trackWidth / 2);
    }
    readViewport(viewport);
  }, [focusIndex, readViewport]);

  if (columns.length === 0) {
    return <p className="muted period-matrix__empty">{t('matrix.noData')}</p>;
  }

  return (
    <div
      ref={viewportRef}
      className="period-matrix__scroll card"
      role="region"
      aria-label={caption}
      tabIndex={0}
      data-ui={UI.timeline.matrix}
      onScroll={(event) => readViewport(event.currentTarget)}
      style={
        {
          '--period-matrix-label-width': `${LABEL_WIDTH}px`,
          '--period-matrix-column-width': `${COLUMN_WIDTH}px`,
        } as CSSProperties
      }
    >
      <table className="period-matrix__table">
        <caption className="sr-only">{caption}</caption>
        <thead>
          <tr>
            <th className="period-matrix__label period-matrix__corner" scope="col">
              {t('matrix.itemColumn')}
            </th>
            {columns.map((column, index) => (
              <th className="period-matrix__value" scope="col" key={column.key}>
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
          <MatrixRow label={t('matrix.revenue')} values={matrix.rows.revenue} currency={currency} />
          <MatrixRow label={t('matrix.expense')} values={matrix.rows.expense} currency={currency} />
          <MatrixRow
            label={t('matrix.net')}
            values={matrix.rows.net}
            currency={currency}
            signed
            emphasis
          />
          <MatrixRow
            label={t('matrix.monthlyCost')}
            values={matrix.rows.monthlyCost}
            currency={currency}
          />
          {matrix.expenseCategories.map(({ account, values }) => (
            <MatrixRow
              key={account.id}
              label={account.name}
              accessibleLabel={t('matrix.expenseCategory', { name: account.name })}
              values={values}
              currency={currency}
              category
            />
          ))}
          <MatrixRow
            label={t('matrix.totalAssets')}
            values={matrix.rows.totalAssets}
            currency={currency}
            sectionStart
          />
          <MatrixRow
            label={t('matrix.netAssets')}
            values={matrix.rows.netAssets}
            currency={currency}
            emphasis
          />
        </tbody>
      </table>
    </div>
  );
}

function MatrixRow({
  label,
  accessibleLabel,
  values,
  currency,
  signed = false,
  emphasis = false,
  category = false,
  sectionStart = false,
}: {
  label: string;
  accessibleLabel?: string;
  values: number[];
  currency: string;
  signed?: boolean;
  emphasis?: boolean;
  category?: boolean;
  sectionStart?: boolean;
}) {
  const classes = [
    emphasis ? 'period-matrix__row--emphasis' : '',
    category ? 'period-matrix__row--category' : '',
    sectionStart ? 'period-matrix__row--section' : '',
  ]
    .filter(Boolean)
    .join(' ');
  return (
    <tr className={classes || undefined}>
      <th className="period-matrix__label" scope="row" aria-label={accessibleLabel ?? label}>
        {label}
      </th>
      {values.map((value, index) => (
        <td className="period-matrix__value" key={index}>
          <Money amount={value} currency={currency} signed={signed} />
        </td>
      ))}
    </tr>
  );
}
