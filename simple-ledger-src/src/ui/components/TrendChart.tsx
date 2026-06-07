/*
 * 軽量トレンドチャート（外部ライブラリ不使用）。div/CSS の横棒で推移を俯瞰する。
 * 色だけに依存しないよう、各バーに数値ラベルと aria-label を付ける。
 * onSelect を渡すと各バーがボタンになり、タップでドリルダウンできる（全体表示→その年など）。
 */
import { Money } from '../money';
import { t } from '../../i18n';

export interface TrendPoint {
  key: string;
  label: string;
  value: number;
}

export function TrendChart({
  title,
  data,
  currency,
  onSelect,
  selectHint,
  dataUi,
}: {
  title: string;
  data: TrendPoint[];
  currency: string;
  onSelect?: (key: string) => void;
  /** ボタン化したときの aria 補足（例: 「その年の内訳を見る」）。 */
  selectHint?: string;
  dataUi?: string;
}) {
  if (data.length === 0) {
    return (
      <>
        <p className="section-label">{title}</p>
        <div className="card card--pad muted">{t('period.noTrendData')}</div>
      </>
    );
  }
  const max = Math.max(1, ...data.map((d) => Math.abs(d.value)));

  return (
    <div data-ui={dataUi}>
      <p className="section-label">{title}</p>
      <ul className="card trend-chart">
        {data.map((d) => {
          const pct = Math.max(2, Math.round((Math.abs(d.value) / max) * 100));
          const neg = d.value < 0;
          const bar = (
            <>
              <span className="trend-chart__label">{d.label}</span>
              <span className="trend-chart__track" aria-hidden="true">
                <span
                  className={`trend-chart__bar ${neg ? 'trend-chart__bar--neg' : ''}`}
                  style={{ width: `${pct}%` }}
                />
              </span>
              <span className="trend-chart__value">
                <Money amount={d.value} currency={currency} signed />
              </span>
            </>
          );
          const aria = `${d.label} ${title}`;
          return (
            <li key={d.key} className="trend-chart__row">
              {onSelect ? (
                <button
                  type="button"
                  className="trend-chart__btn"
                  onClick={() => onSelect(d.key)}
                  aria-label={selectHint ? `${aria}（${selectHint}）` : aria}
                  data-ui={dataUi ? `${dataUi}.bar` : undefined}
                >
                  {bar}
                </button>
              ) : (
                <span className="trend-chart__static" aria-label={aria}>
                  {bar}
                </span>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
