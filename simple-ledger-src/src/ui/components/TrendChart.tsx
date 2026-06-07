/*
 * 推移チャート（外部ライブラリ不使用の自前 SVG）。CSS 横棒リストではなく、軸・ゼロ線・
 * 目盛ラベルを持つグラフで俯瞰する。
 *  - variant 'bar'（フロー: 収支・生活コスト）/ 'line'（ストック: 純資産）。
 *  - SVG 本体は装飾（aria-hidden）。数値はゼロ線＋上下の目盛ラベルで見せ、スクリーンリーダー向けに
 *    全点の要約テキスト（sr-only）を持つ。色だけに依存しない。
 *  - onSelect を渡すと x 軸ラベルがボタンになり、タップでドリルダウン（全期間→その年）。
 */
import { Money } from '../money';
import { t } from '../../i18n';

export interface TrendPoint {
  key: string;
  label: string;
  value: number;
}

// viewBox 座標（width:100% で拡大縮小。preserveAspectRatio は既定 meet）。
const VB_W = 320;
const VB_H = 140;
const PAD_X = 10;
const PLOT_TOP = 12;
const PLOT_BOTTOM = 116;

function fmtSigned(v: number): string {
  return `${v < 0 ? '−' : ''}${Math.abs(v).toLocaleString('ja-JP')}`;
}

export function TrendChart({
  title,
  data,
  currency,
  variant = 'bar',
  onSelect,
  selectHint,
  dataUi,
  pointDataUi,
}: {
  title: string;
  data: TrendPoint[];
  currency: string;
  variant?: 'bar' | 'line';
  onSelect?: (key: string) => void;
  /** ボタン化したときの aria 補足（例: 「その年の内訳を見る」）。 */
  selectHint?: string;
  dataUi?: string;
  /** ドリルダウン用の x 軸ボタンの data-ui。 */
  pointDataUi?: string;
}) {
  if (data.length === 0) {
    return (
      <figure data-ui={dataUi} style={{ margin: 0 }}>
        <figcaption className="section-label">{title}</figcaption>
        <div className="card card--pad muted">{t('period.noTrendData')}</div>
      </figure>
    );
  }

  const values = data.map((d) => d.value);
  const max = Math.max(1, ...values.map((v) => Math.abs(v)));
  const hasNeg = values.some((v) => v < 0);
  const plotH = PLOT_BOTTOM - PLOT_TOP;
  const zeroY = hasNeg ? PLOT_TOP + plotH / 2 : PLOT_BOTTOM;
  const scale = (hasNeg ? plotH / 2 : plotH) / max;
  const plotW = VB_W - PAD_X * 2;
  const step = plotW / data.length;
  const cx = (i: number) => PAD_X + step * (i + 0.5);
  const y = (v: number) => zeroY - v * scale;
  const barW = Math.min(step * 0.6, 26);

  const summary = `${title}: ${data.map((d) => `${d.label} ${fmtSigned(d.value)}`).join('、')}`;

  return (
    <figure data-ui={dataUi} style={{ margin: 0 }}>
      <figcaption className="section-label">{title}</figcaption>
      <div className="trend-svg">
        <svg
          viewBox={`0 0 ${VB_W} ${VB_H}`}
          className="trend-svg__svg"
          preserveAspectRatio="xMidYMid meet"
          aria-hidden="true"
          focusable="false"
        >
          {/* 目盛: 最大値（上）・0（ゼロ線）・最小値（負があるとき下） */}
          <text className="trend-svg__tick" x={2} y={PLOT_TOP + 3}>
            {fmtSigned(max)}
          </text>
          <line className="trend-svg__zero" x1={PAD_X} x2={VB_W - PAD_X} y1={zeroY} y2={zeroY} />
          <text className="trend-svg__tick" x={2} y={zeroY + 3}>
            0
          </text>
          {hasNeg ? (
            <text className="trend-svg__tick" x={2} y={PLOT_BOTTOM + 3}>
              {fmtSigned(-max)}
            </text>
          ) : null}

          {variant === 'line' ? (
            <>
              <polyline
                className="trend-svg__line"
                points={data.map((d, i) => `${cx(i)},${y(d.value)}`).join(' ')}
              />
              {data.map((d, i) => (
                <circle key={d.key} className="trend-svg__dot" cx={cx(i)} cy={y(d.value)} r={2.5} />
              ))}
            </>
          ) : (
            data.map((d, i) => {
              const yv = y(d.value);
              return (
                <rect
                  key={d.key}
                  className={`trend-svg__bar ${d.value < 0 ? 'trend-svg__bar--neg' : ''}`}
                  x={cx(i) - barW / 2}
                  width={barW}
                  y={Math.min(zeroY, yv)}
                  height={Math.max(1, Math.abs(yv - zeroY))}
                  rx={1.5}
                />
              );
            })
          )}
        </svg>

        {/* スクリーンリーダー向けの全点要約（SVG は装飾）。 */}
        <p className="sr-only">{summary}</p>

        {/* x 軸ラベル。onSelect 時はボタン（ドリルダウン）。数値は aria に含める。 */}
        <div className="trend-x">
          {data.map((d) => {
            const aria = `${d.label} ${title} ${fmtSigned(d.value)}`;
            return onSelect ? (
              <button
                key={d.key}
                type="button"
                className="trend-x__btn"
                onClick={() => onSelect(d.key)}
                aria-label={selectHint ? `${aria}（${selectHint}）` : aria}
                data-ui={pointDataUi}
              >
                {d.label}
              </button>
            ) : (
              <span key={d.key} className="trend-x__label" aria-hidden="true">
                {d.label}
              </span>
            );
          })}
        </div>
      </div>
      {/* 通貨つきの最新値を 1 つだけ視覚補足（数値の桁感を掴むため）。 */}
      <p className="trend-svg__latest muted">
        {data[data.length - 1]?.label}：
        <Money amount={data[data.length - 1]?.value ?? 0} currency={currency} signed />
      </p>
    </figure>
  );
}
