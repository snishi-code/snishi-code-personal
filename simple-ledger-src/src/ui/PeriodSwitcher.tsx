/*
 * 期間選択コントロール（期間メニューの中身）。
 * ユーザーの理解に沿って 2 段で選ばせる:
 *   1. 年を選ぶ / 全期間
 *   2.（年を選ぶとき）年セレクト + 「月 / 年全体」、月のときだけ月セレクト
 * 対応:
 *   年を選ぶ + 月     → mode 'month'
 *   年を選ぶ + 年全体 → mode 'year'
 *   全期間            → mode 'all'
 * 「全期間 + 月」は作らない。mode を切り替えても年/月はなるべく保持する。
 * 月はネイティブ select、年も select（独自カレンダーは作らない）。
 */
import { useState } from 'react';
import { t } from '../i18n';
import { UI } from '../ui-contract';
import type { ReportPeriod } from '../domain/reportPeriod';

type Grain = 'month' | 'fullYear';

const MONTHS = Array.from({ length: 12 }, (_, i) => i + 1);

export function PeriodSwitcher({
  value,
  onChange,
  today,
  years,
}: {
  value: ReportPeriod;
  onChange: (p: ReportPeriod) => void;
  today: string;
  /** 年セレクトの選択肢（降順）。データ・予定・資金目標から導出して渡す。 */
  years: number[];
}) {
  const thisYear = Number.parseInt(today.slice(0, 4), 10);
  const thisMonth = Number.parseInt(today.slice(5, 7), 10);

  // 年/月/粒度はローカルに保持し、「全期間」へ切り替えても記憶しておく。
  const [year, setYear] = useState(value.mode === 'all' ? thisYear : value.year);
  const [month, setMonth] = useState(value.mode === 'month' ? value.month : thisMonth);
  const [grain, setGrain] = useState<Grain>(value.mode === 'year' ? 'fullYear' : 'month');

  const kind: 'year' | 'all' = value.mode === 'all' ? 'all' : 'year';

  const emitYear = (y: number, g: Grain, m: number) =>
    onChange(g === 'fullYear' ? { mode: 'year', year: y } : { mode: 'month', year: y, month: m });

  return (
    <div className="period-switcher">
      {/* 1段目: 年を選ぶ / 全期間 */}
      <div className="segmented" role="tablist" aria-label={t('period.selectMode')}>
        <button
          type="button"
          role="tab"
          aria-selected={kind === 'year'}
          className="segmented__btn"
          onClick={() => emitYear(year, grain, month)}
          data-ui={UI.period.kindYear}
        >
          {t('period.kind.year')}
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={kind === 'all'}
          className="segmented__btn"
          onClick={() => onChange({ mode: 'all' })}
          data-ui={UI.period.kindAll}
        >
          {t('period.kind.all')}
        </button>
      </div>

      {kind === 'year' ? (
        <div className="stack" style={{ marginTop: 'var(--space-3)' }}>
          <label className="field" style={{ margin: 0 }}>
            <span className="field__label">{t('period.year')}</span>
            <select
              className="input"
              value={String(year)}
              onChange={(e) => {
                const y = Number.parseInt(e.target.value, 10);
                setYear(y);
                emitYear(y, grain, month);
              }}
              data-ui={UI.period.year}
            >
              {years.map((y) => (
                <option key={y} value={y}>
                  {t('period.yearUnit', { year: y })}
                </option>
              ))}
            </select>
          </label>

          {/* 2段目: 月 / 年全体 */}
          <div className="segmented" role="tablist" aria-label={t('period.grainLabel')}>
            <button
              type="button"
              role="tab"
              aria-selected={grain === 'month'}
              className="segmented__btn"
              onClick={() => {
                setGrain('month');
                emitYear(year, 'month', month);
              }}
              data-ui={UI.period.grainMonth}
            >
              {t('period.grain.month')}
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={grain === 'fullYear'}
              className="segmented__btn"
              onClick={() => {
                setGrain('fullYear');
                emitYear(year, 'fullYear', month);
              }}
              data-ui={UI.period.grainFullYear}
            >
              {t('period.grain.fullYear')}
            </button>
          </div>

          {grain === 'month' ? (
            <label className="field" style={{ margin: 0 }}>
              <span className="field__label">{t('period.month')}</span>
              <select
                className="input"
                value={String(month)}
                onChange={(e) => {
                  const m = Number.parseInt(e.target.value, 10);
                  setMonth(m);
                  emitYear(year, 'month', m);
                }}
                data-ui={UI.period.month}
              >
                {MONTHS.map((m) => (
                  <option key={m} value={m}>
                    {m}月
                  </option>
                ))}
              </select>
            </label>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
