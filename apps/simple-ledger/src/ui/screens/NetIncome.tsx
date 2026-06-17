/*
 * 収支ページ。ホーム上段「収支」のタップ先。
 * 収支 = 収入 − 支出の「手元に残る額」。科目別ドリルダウンではなく、
 * 「毎月どれだけ残ったか（余剰／赤字）」の推移を主役にする。
 */
import { useMemo } from 'react';
import { Icon } from '@snishi/foundation/ui/Icon';
import { useLedger } from '../../state/store';
import { deriveProfitAndLoss } from '../../domain/accounting';
import { livingCostForRange } from '../../domain/livingCost';
import { periodLabel, periodRange, type ReportPeriod } from '../../domain/reportPeriod';
import { buildSectionTrends } from './breakdownData';
import { Money } from '../money';
import { TrendChart } from '../components/TrendChart';
import { t } from '../../i18n';
import { UI } from '../../ui-contract';
import type { Screen } from '../navigation';

export function NetIncome({
  period,
  onPeriodChange,
  onNavigate,
}: {
  period: ReportPeriod;
  onPeriodChange: (p: ReportPeriod) => void;
  onNavigate: (screen: Screen) => void;
}) {
  const { ledger } = useLedger();
  const currency = ledger?.settings.currency ?? 'JPY';

  const { revenue, living } = useMemo(() => {
    const accounts = ledger?.accounts ?? [];
    const entries = ledger?.derivedEntries ?? [];
    const range = periodRange(period);
    return {
      revenue: deriveProfitAndLoss(accounts, entries, range).totalRevenue,
      living: livingCostForRange(accounts, entries, range),
    };
  }, [ledger, period]);

  const trends = useMemo(() => buildSectionTrends(period, ledger), [period, ledger]);

  return (
    <section aria-labelledby="net-income-title" data-ui={UI.netIncome.view}>
      <h1 className="screen-title" id="net-income-title">
        {t('netIncome.title')}
      </h1>
      <p className="field__hint" style={{ marginBottom: 'var(--space-3)' }}>
        {t('netIncome.intro')}
      </p>
      <p className="section-label">{periodLabel(period)}</p>
      <div className="stat-grid">
        <button
          type="button"
          className="stat stat--btn"
          onClick={() => onNavigate('incomeBreakdown')}
          aria-label={t('dashboard.statDetail', { label: t('netIncome.revenue') })}
          data-ui={UI.netIncome.revenue}
        >
          <span className="stat__label">
            {t('netIncome.revenue')} <Icon name="chevronRight" size={12} />
          </span>
          <span className="stat__value">
            <Money amount={revenue} currency={currency} />
          </span>
        </button>
        <button
          type="button"
          className="stat stat--btn"
          onClick={() => onNavigate('expenseBreakdown')}
          aria-label={t('dashboard.statDetail', { label: t('netIncome.expense') })}
          data-ui={UI.netIncome.expense}
        >
          <span className="stat__label">
            {t('netIncome.expense')} <Icon name="chevronRight" size={12} />
          </span>
          <span className="stat__value">
            <Money amount={living} currency={currency} />
          </span>
        </button>
        <div className="stat" data-ui={UI.netIncome.result}>
          <span className="stat__label">{t('netIncome.result')}</span>
          <span className="stat__value">
            <Money amount={revenue - living} currency={currency} signed />
          </span>
        </div>
      </div>

      {trends && trends.net.length > 1 ? (
        <div style={{ marginTop: 'var(--space-4)' }}>
          <TrendChart
            title={t('netIncome.trend')}
            data={trends.net}
            currency={currency}
            variant="bar"
            {...(trends.drillable
              ? {
                  onSelect: (key: string) =>
                    onPeriodChange({ mode: 'year', year: Number.parseInt(key, 10) }),
                  selectHint: t('dashboard.trendDrillYear'),
                }
              : {})}
          />
        </div>
      ) : null}
    </section>
  );
}
