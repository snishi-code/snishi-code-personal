/*
 * 支出の内訳。ホーム上段「支出」のタップ先。
 * 支出 = 通常支出 + 月額化コスト（生活コスト）。月額化コストをタップすると月額化コスト台帳へ。
 * 生活コストはホーム独立セクションにはしない（ここで内訳を見せる）。期間はホームの選択に従う。
 */
import { useMemo } from 'react';
import { useLedger } from '../../state/store';
import { livingCostBreakdownForRange } from '../../domain/livingCost';
import {
  dataMonthsOf,
  periodBuckets,
  periodLabel,
  periodRange,
  type ReportPeriod,
} from '../../domain/reportPeriod';
import { buildSectionTrends } from './breakdownData';
import { Money } from '../money';
import { Icon } from '../Icon';
import { TrendChart } from '../components/TrendChart';
import { t } from '../../i18n';
import { UI } from '../../ui-contract';
import type { Screen } from '../navigation';

export function ExpenseBreakdown({
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
  const label = periodLabel(period);

  const breakdown = useMemo(() => {
    const accounts = ledger?.accounts ?? [];
    const entries = ledger?.journalEntries ?? [];
    const items = ledger?.monthlyCostItems ?? [];
    const range = periodRange(period);
    const months = periodBuckets(period, {
      dataMonths: dataMonthsOf(entries.map((e) => e.date)),
    }).map((b) => b.ym);
    return livingCostBreakdownForRange(accounts, entries, items, range, months);
  }, [ledger, period]);

  const trends = useMemo(() => buildSectionTrends(period, ledger), [period, ledger]);

  return (
    <section aria-labelledby="expense-breakdown-title" data-ui={UI.expenseBreakdown.view}>
      <h1 className="screen-title" id="expense-breakdown-title">
        {t('expenseBreakdown.title')}
      </h1>
      <p className="field__hint" style={{ marginBottom: 'var(--space-3)' }}>
        {t('expenseBreakdown.intro')}
      </p>
      <p className="section-label">{label}</p>
      <div className="stat-grid">
        <div className="stat" data-ui={UI.expenseBreakdown.normalExpense}>
          <span className="stat__label">{t('expenseBreakdown.normalExpense')}</span>
          <span className="stat__value">
            <Money amount={breakdown.normalExpense} currency={currency} />
          </span>
        </div>
        {/* 月額化コスト（生活コスト）。タップで月額化コスト台帳へ。 */}
        <button
          type="button"
          className="stat stat--btn"
          onClick={() => onNavigate('allocations')}
          aria-label={t('expenseBreakdown.monthlyCost')}
          data-ui={UI.expenseBreakdown.monthlyCost}
        >
          <span className="stat__label">
            {t('expenseBreakdown.monthlyCost')} <Icon name="chevronRight" size={12} />
          </span>
          <span className="stat__value">
            <Money amount={breakdown.monthlyCost} currency={currency} />
          </span>
        </button>
        <div className="stat" data-ui={UI.expenseBreakdown.total}>
          <span className="stat__label">{t('expenseBreakdown.total')}</span>
          <span className="stat__value">
            <Money amount={breakdown.total} currency={currency} />
          </span>
        </div>
      </div>

      {/* 生活コスト（支出）の推移。年別=12ヶ月 / 全体=年集約。全体は年ラベルでその年へ。 */}
      {trends && trends.living.length > 1 ? (
        <div style={{ marginTop: 'var(--space-4)' }}>
          <TrendChart
            title={t('expenseBreakdown.trend')}
            data={trends.living}
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
