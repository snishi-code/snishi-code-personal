/*
 * 期間切替（月別 / 年別 / 全体）。ホームと財務諸表で共有する。
 * 月はネイティブの input[type=month]、年は select を使う（独自カレンダーは作らない）。
 * 値は ReportPeriod（App の共有 state）。フロー（PL/仕訳/CF）は期間を、
 * ストック（BS）は基準日を、それぞれ helper で導出する。
 */
import { t } from '../i18n';
import { UI } from '../ui-contract';
import type { ReportPeriod } from '../domain/reportPeriod';

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

export function PeriodSwitcher({
  value,
  onChange,
  today,
}: {
  value: ReportPeriod;
  onChange: (p: ReportPeriod) => void;
  today: string;
}) {
  const thisYear = Number.parseInt(today.slice(0, 4), 10);
  const thisMonth = Number.parseInt(today.slice(5, 7), 10);
  // 直近 6 年 + 翌年（将来の按分/予定を見るため）。
  const years = Array.from({ length: 8 }, (_, i) => thisYear + 1 - i);

  const curYear = value.mode === 'all' ? thisYear : value.year;
  const curMonth = value.mode === 'month' ? value.month : thisMonth;

  const setMode = (mode: ReportPeriod['mode']) => {
    if (mode === 'month') onChange({ mode: 'month', year: curYear, month: curMonth });
    else if (mode === 'year') onChange({ mode: 'year', year: curYear });
    else onChange({ mode: 'all' });
  };

  return (
    <div className="period-switcher" style={{ marginBottom: 'var(--space-3)' }}>
      <div
        className="segmented"
        role="tablist"
        aria-label={t('period.selectMode')}
        style={{ marginBottom: 'var(--space-2)' }}
      >
        <button
          type="button"
          role="tab"
          aria-selected={value.mode === 'month'}
          className="segmented__btn"
          onClick={() => setMode('month')}
          data-ui={UI.period.modeMonth}
        >
          {t('period.mode.month')}
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={value.mode === 'year'}
          className="segmented__btn"
          onClick={() => setMode('year')}
          data-ui={UI.period.modeYear}
        >
          {t('period.mode.year')}
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={value.mode === 'all'}
          className="segmented__btn"
          onClick={() => setMode('all')}
          data-ui={UI.period.modeAll}
        >
          {t('period.mode.all')}
        </button>
      </div>

      {value.mode === 'month' ? (
        <label className="field" style={{ margin: 0 }}>
          <span className="field__label">{t('period.month')}</span>
          <input
            className="input"
            type="month"
            value={`${value.year}-${pad2(value.month)}`}
            onChange={(e) => {
              const v = e.target.value;
              if (!/^\d{4}-\d{2}$/.test(v)) return;
              onChange({
                mode: 'month',
                year: Number.parseInt(v.slice(0, 4), 10),
                month: Number.parseInt(v.slice(5, 7), 10),
              });
            }}
            data-ui={UI.period.month}
          />
        </label>
      ) : null}

      {value.mode === 'year' ? (
        <label className="field" style={{ margin: 0 }}>
          <span className="field__label">{t('period.year')}</span>
          <select
            className="input"
            value={String(value.year)}
            onChange={(e) => onChange({ mode: 'year', year: Number.parseInt(e.target.value, 10) })}
            data-ui={UI.period.year}
          >
            {years.map((y) => (
              <option key={y} value={y}>
                {t('period.yearUnit', { year: y })}
              </option>
            ))}
          </select>
        </label>
      ) : null}
    </div>
  );
}
