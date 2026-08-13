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
import { reportBasis, type ReportPeriod } from '../../domain/reportPeriod';
import { displayEntriesResultForAsOf } from '../../domain/reportEntries';
import { todayLocal } from '../../util/time';
import { buildSectionTrends } from './breakdownData';
import { Money, moneyText, useMoneyDigits } from '../money';
import { periodLabel } from '../periodLabel';
import { TrendChart } from '../components/TrendChart';
import { t } from '../../i18n';
import { UI } from '../../ui-contract';
import type { Screen } from '../navigation';
import { ScrollTopButton } from '../ScrollTopButton';
import { assertSafeAmount } from '../../domain/safeSum';
import { InvestmentProjectionTruncationNotice } from '../components/InvestmentProjectionTruncationNotice';

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
  const currency = ledger?.settings.currency ?? '';
  const digits = useMoneyDigits();
  const today = todayLocal();
  const basis = useMemo(() => reportBasis(period, today), [period, today]);

  const { revenue, living, investmentProjectionTruncations } = useMemo(() => {
    const accounts = ledger?.accounts ?? [];
    const display = ledger ? displayEntriesResultForAsOf(ledger, basis.asOf, today) : null;
    const entries = display?.entries ?? [];
    return {
      revenue: deriveProfitAndLoss(accounts, entries, basis.flowRange).totalRevenue,
      living: livingCostForRange(accounts, entries, basis.flowRange),
      investmentProjectionTruncations: display?.investmentProjectionTruncations ?? [],
    };
  }, [basis, ledger, today]);

  const trends = useMemo(() => buildSectionTrends(period, ledger, today), [period, ledger, today]);
  const visibleProjectionTruncations =
    trends?.investmentProjectionTruncations ?? investmentProjectionTruncations;

  return (
    <section aria-labelledby="net-income-title" data-ui={UI.netIncome.view}>
      <h1 className="screen-title" id="net-income-title">
        {t('netIncome.title')}
      </h1>
      <p className="field__hint" style={{ marginBottom: 'var(--space-3)' }}>
        {t('netIncome.intro')}
      </p>
      <InvestmentProjectionTruncationNotice
        truncations={visibleProjectionTruncations}
        accounts={ledger?.accounts ?? []}
      />
      <p className="section-label">{periodLabel(period)}</p>
      <div className="stat-grid">
        <button
          type="button"
          className="stat stat--btn"
          onClick={() => onNavigate('incomeBreakdown')}
          aria-label={t('dashboard.statDetail', {
            label: t('netIncome.revenue'),
            amount: moneyText(revenue, currency, digits),
          })}
          data-ui={UI.netIncome.revenue}
        >
          <span className="stat__label" aria-hidden="true">
            {t('netIncome.revenue')} <Icon name="chevronRight" size={12} />
          </span>
          <span className="stat__value" aria-hidden="true">
            <Money amount={revenue} currency={currency} />
          </span>
        </button>
        <button
          type="button"
          className="stat stat--btn"
          onClick={() => onNavigate('expenseBreakdown')}
          aria-label={t('dashboard.statDetail', {
            label: t('netIncome.expense'),
            amount: moneyText(living, currency, digits),
          })}
          data-ui={UI.netIncome.expense}
        >
          <span className="stat__label" aria-hidden="true">
            {t('netIncome.expense')} <Icon name="chevronRight" size={12} />
          </span>
          <span className="stat__value" aria-hidden="true">
            <Money amount={living} currency={currency} />
          </span>
        </button>
        <div className="stat" data-ui={UI.netIncome.result}>
          <span className="stat__label">{t('netIncome.result')}</span>
          <span className="stat__value">
            <Money amount={assertSafeAmount(revenue - living)} currency={currency} signed />
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
      <ScrollTopButton />
    </section>
  );
}
