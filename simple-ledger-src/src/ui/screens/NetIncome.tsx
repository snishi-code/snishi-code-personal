/*
 * 収支ページ。ホーム上段「収支」のタップ先。
 * 収支 = 収入 − 支出の「手元に残る額」。科目別ドリルダウンではなく、
 * 「毎月どれだけ残ったか（余剰／赤字）」の推移を主役にする。期間はホームの選択に従う。
 */
import { useMemo } from 'react';
import { useLedger } from '../../state/store';
import { deriveProfitAndLoss } from '../../domain/accounting';
import { livingCostForRange } from '../../domain/livingCost';
import {
  dataMonthsOf,
  periodBuckets,
  periodLabel,
  periodRange,
  type ReportPeriod,
} from '../../domain/reportPeriod';
import { buildSectionTrends } from './breakdownData';
import { Money } from '../money';
import { TrendChart } from '../components/TrendChart';
import { t } from '../../i18n';
import { UI } from '../../ui-contract';

export function NetIncome({
  period,
  onPeriodChange,
}: {
  period: ReportPeriod;
  onPeriodChange: (p: ReportPeriod) => void;
}) {
  const { ledger } = useLedger();
  const currency = ledger?.settings.currency ?? 'JPY';

  const { revenue, living } = useMemo(() => {
    const accounts = ledger?.accounts ?? [];
    const entries = ledger?.journalEntries ?? [];
    const items = ledger?.monthlyCostItems ?? [];
    const range = periodRange(period);
    const months = periodBuckets(period, {
      dataMonths: dataMonthsOf(entries.map((e) => e.date)),
    }).map((b) => b.ym);
    return {
      revenue: deriveProfitAndLoss(accounts, entries, range).totalRevenue,
      living: livingCostForRange(accounts, entries, items, range, months),
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
        <div className="stat" data-ui={UI.netIncome.revenue}>
          <span className="stat__label">{t('netIncome.revenue')}</span>
          <span className="stat__value">
            <Money amount={revenue} currency={currency} />
          </span>
        </div>
        <div className="stat" data-ui={UI.netIncome.expense}>
          <span className="stat__label">{t('netIncome.expense')}</span>
          <span className="stat__value">
            <Money amount={living} currency={currency} />
          </span>
        </div>
        <div className="stat" data-ui={UI.netIncome.result}>
          <span className="stat__label">{t('netIncome.result')}</span>
          <span className="stat__value">
            <Money amount={revenue - living} currency={currency} signed />
          </span>
        </div>
      </div>

      {/* 毎月の残り方（余剰／赤字）の推移を主役にする（科目別ドリルはしない）。 */}
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
