/*
 * 期間マトリクスの表（時間平面の**数値レンズ**）。
 *
 * 旧「年間・全体」画面の表をそのまま持ってきたもの。違いは列が「年 12 か月」ではなく
 * **可視範囲 + 前後バッファの窓**であること（年をまたいで連続し、横スクロール/シフトで移動する）。
 * 集計は domain/periodMatrix が済ませており、ここは描画と横スクロールの幾何だけを持つ。
 *
 * 行はホームの 6 カードと同じ 6 分類（収入 / 支出 / 収支 / 資産 / 負債 / 純資産。v13.5 E）。
 * **段階的開示**: 子を持つ行はタップで展開するインライン木（ラベル列にインデント）。
 * 展開状態はこの画面のローカル状態で、保存しない。展開して初めて列 × 子の行を DOM 化するので、
 * 既定（全部たたんだ状態）の描画量は 6 行 × 窓の列数のまま。
 *
 * 行ラベル列は sticky。横スクロールは**この枠の中だけ**で起き、ページ本体は横に伸びない。
 */
import { useCallback, useMemo, useRef, useState, type CSSProperties } from 'react';
import type {
  PeriodMatrix,
  PeriodMatrixColumn,
  PeriodMatrixNode,
  PeriodMatrixRowKey,
} from '../../domain/periodMatrix';
import { isDisplaySectionGroupStart } from '../../domain/displayOrder';
import { t, type MessageKey } from '../../i18n';
import { UI } from '../../ui-contract';
import { Money, type MoneyTone } from '../money';
import { visibleIndexRange, type ScrollEdge } from '../scrollWindow';
import { useHorizonScroll } from '../horizonScroll';

/** 行ラベル列と値列の幅（px）。CSS は JS のこの値を custom property 経由で受け取る。 */
const LABEL_WIDTH = 112;
const COLUMN_WIDTH = 112;

/**
 * 6 分類の見せ方。**ラベルはホームのカードと同じメッセージキーを使う**（語彙を 2 か所に
 * 持たない = ホームと表で呼び名がずれない）。tone は C-2 の規約で負債の数字だけに付く。
 * 並びと段（フロー / ストックの区切り線）は持たない — 表示順マスタが決める。
 */
const SECTION_META: Record<
  PeriodMatrixRowKey,
  {
    labelKey: MessageKey;
    signed?: boolean;
    emphasis?: boolean;
    tone?: MoneyTone;
  }
> = {
  revenue: { labelKey: 'dashboard.revenue' },
  expense: { labelKey: 'dashboard.expense' },
  net: { labelKey: 'dashboard.netIncome', signed: true, emphasis: true },
  totalAssets: { labelKey: 'dashboard.assets' },
  totalLiabilities: { labelKey: 'dashboard.liabilities', tone: 'liability' },
  netAssets: { labelKey: 'dashboard.netAssets', emphasis: true },
};

interface MatrixRowSpec {
  key: string;
  depth: number;
  label: string;
  values: number[];
  hasChildren: boolean;
  expanded: boolean;
  signed: boolean;
  emphasis: boolean;
  sectionStart: boolean;
  tone?: MoneyTone;
}

function nodeLabel(node: PeriodMatrixNode): string {
  return node.label.kind === 'account' ? node.label.name : t(node.label.key);
}

/** 6 分類 + 展開中の子だけを、表に出す順で 1 本の配列にする。 */
function flattenRows(matrix: PeriodMatrix, expanded: ReadonlySet<string>): MatrixRowSpec[] {
  const rows: MatrixRowSpec[] = [];
  const pushNode = (node: PeriodMatrixNode, depth: number, tone?: MoneyTone) => {
    const isExpanded = expanded.has(node.key);
    rows.push({
      key: node.key,
      depth,
      label: nodeLabel(node),
      values: node.values,
      hasChildren: node.children.length > 0,
      expanded: isExpanded,
      signed: false,
      emphasis: false,
      sectionStart: false,
      ...(tone ? { tone } : {}),
    });
    if (!isExpanded) return;
    for (const child of node.children) pushNode(child, depth + 1, tone);
  };

  for (const section of matrix.sections) {
    const meta = SECTION_META[section.key];
    const isExpanded = expanded.has(section.key);
    rows.push({
      key: section.key,
      depth: 0,
      label: t(meta.labelKey),
      values: section.values,
      hasChildren: section.children.length > 0,
      expanded: isExpanded,
      signed: meta.signed === true,
      emphasis: meta.emphasis === true,
      // 段の切り替わり（フロー → ストック）に区切り線。どこが変わり目かはマスタが持つ。
      sectionStart: isDisplaySectionGroupStart(section.key),
      ...(meta.tone ? { tone: meta.tone } : {}),
    });
    if (!isExpanded) continue;
    for (const child of section.children) pushNode(child, 1, meta.tone);
  }
  return rows;
}

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
  windowKey,
  onOpenMonth,
  onOpenYear,
  onVisibleRangeChange,
  onExtend,
}: {
  matrix: PeriodMatrix;
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
  // 展開状態は画面ローカル・保存しない（窓を送っても木のキーは変わらないので開いたまま）。
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set<string>());
  const toggleRow = (key: string) => {
    setExpanded((previous) => {
      const next = new Set(previous);
      if (!next.delete(key)) next.add(key);
      return next;
    });
  };
  const { columns } = matrix;
  const first = columns[0];
  const last = columns.at(-1);
  const caption =
    first && last ? t('matrix.caption', { from: first.key, to: last.key }) : t('matrix.noData');
  const rows = useMemo(() => flattenRows(matrix, expanded), [matrix, expanded]);

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
      const trackWidth = Math.max(0, viewport.clientWidth - LABEL_WIDTH);
      return Math.max(0, (focusIndex + 0.5) * COLUMN_WIDTH - trackWidth / 2);
    },
    onSettle: readViewport,
    ...(onExtend ? { onExtend } : {}),
  });

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
      onScroll={(event) => handleScroll(event.currentTarget)}
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
          {rows.map((row) => (
            <MatrixRow key={row.key} row={row} currency={currency} onToggle={toggleRow} />
          ))}
        </tbody>
      </table>
    </div>
  );
}

function MatrixRow({
  row,
  currency,
  onToggle,
}: {
  row: MatrixRowSpec;
  currency: string;
  onToggle: (key: string) => void;
}) {
  const classes = [
    row.emphasis ? 'period-matrix__row--emphasis' : '',
    row.depth > 0 ? 'period-matrix__row--child' : '',
    row.sectionStart ? 'period-matrix__row--section' : '',
  ]
    .filter(Boolean)
    .join(' ');
  const labelClasses = [
    'period-matrix__label',
    row.hasChildren ? 'period-matrix__label--interactive' : '',
  ]
    .filter(Boolean)
    .join(' ');
  return (
    <tr
      className={classes || undefined}
      data-ui={UI.timeline.matrixRow}
      data-row-key={row.key}
      style={{ '--period-matrix-depth': row.depth } as CSSProperties}
    >
      <th className={labelClasses} scope="row">
        {row.hasChildren ? (
          // 段階的開示のトグル（タップ領域は --tap = 44px。開閉は aria-expanded が名乗る）。
          <button
            type="button"
            className="period-matrix__row-btn"
            aria-expanded={row.expanded}
            onClick={() => onToggle(row.key)}
            data-ui={UI.timeline.matrixRowToggle}
            data-row-key={row.key}
          >
            <span className="period-matrix__caret" aria-hidden="true">
              {row.expanded ? '▾' : '▸'}
            </span>
            {row.label}
          </button>
        ) : (
          row.label
        )}
      </th>
      {row.values.map((value, index) => (
        <td className="period-matrix__value" key={index}>
          <Money
            amount={value}
            currency={currency}
            signed={row.signed}
            {...(row.tone ? { tone: row.tone } : {})}
          />
        </td>
      ))}
    </tr>
  );
}
