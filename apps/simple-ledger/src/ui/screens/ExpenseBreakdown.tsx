/*
 * 支出の内訳。ホーム上段「支出」のタップ先。
 * 主役は「何へ支出したか」= 費用カテゴリ別の内訳（継続コストの月割り分も各カテゴリに合算）。
 */
import { useMemo } from 'react';
import { Icon } from '@snishi/foundation/ui/Icon';
import { useLedger } from '../../state/store';
import {
  expenseCategoryBreakdownForRange,
  livingCostBreakdownForRange,
} from '../../domain/livingCost';
import { periodLabel, periodRange, type ReportPeriod } from '../../domain/reportPeriod';
import { buildSectionTrends } from './breakdownData';
import { Money } from '../money';
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

  const { breakdown, categories } = useMemo(() => {
    const accounts = ledger?.accounts ?? [];
    const entries = ledger?.derivedEntries ?? [];
    const range = periodRange(period);
    return {
      breakdown: livingCostBreakdownForRange(accounts, entries, range),
      categories: expenseCategoryBreakdownForRange(accounts, entries, range),
    };
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

      <p className="section-label">{t('expenseBreakdown.byCategory')}</p>
      <p className="field__hint" style={{ marginBottom: 'var(--space-2)' }}>
        {label}
      </p>
      <div className="card" data-ui={UI.expenseBreakdown.categoryList}>
        {categories.length === 0 ? (
          <div className="stmt-row muted">{t('expenseBreakdown.noCategory')}</div>
        ) : (
          categories.map((c) => (
            <div key={c.account.id} className="stmt-row" data-ui={UI.expenseBreakdown.categoryRow}>
              <span>{c.account.name}</span>
              <span className="stmt-row__num">
                <Money amount={c.amount} currency={currency} />
              </span>
            </div>
          ))
        )}
        <div className="stmt-row stmt-row--total">
          <span>{t('expenseBreakdown.categoryTotal')}</span>
          <span className="stmt-row__num">
            <Money amount={breakdown.total} currency={currency} />
          </span>
        </div>
      </div>

      <div className="stat-grid" style={{ marginTop: 'var(--space-4)' }}>
        <div className="stat" data-ui={UI.expenseBreakdown.normalExpense}>
          <span className="stat__label">{t('expenseBreakdown.normalExpense')}</span>
          <span className="stat__value">
            <Money amount={breakdown.normalExpense} currency={currency} />
          </span>
        </div>
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
