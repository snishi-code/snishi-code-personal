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
import { reportBasis, type ReportPeriod } from '../../domain/reportPeriod';
import { displayEntriesResultForAsOf } from '../../domain/reportEntries';
import { todayLocal } from '../../util/time';
import { buildSectionTrends } from './breakdownData';
import { Money } from '../money';
import { periodLabel } from '../periodLabel';
import { TrendChart } from '../components/TrendChart';
import { t } from '../../i18n';
import { UI } from '../../ui-contract';
import type { Screen } from '../navigation';
import type { JournalFilter } from './Journal';
import { ScrollTopButton } from '../ScrollTopButton';
import { InvestmentProjectionTruncationNotice } from '../components/InvestmentProjectionTruncationNotice';

export function ExpenseBreakdown({
  period,
  onPeriodChange,
  onDrillDown,
  onNavigate,
}: {
  period: ReportPeriod;
  onPeriodChange: (p: ReportPeriod) => void;
  /** 費用カテゴリ行タップ → 仕訳一覧をそのカテゴリで絞り込んで開く。 */
  onDrillDown: (filter: JournalFilter) => void;
  onNavigate: (screen: Screen) => void;
}) {
  const { ledger } = useLedger();
  const currency = ledger?.settings.currency ?? '';
  const label = periodLabel(period);
  const today = todayLocal();
  const basis = useMemo(() => reportBasis(period, today), [period, today]);
  const range = basis.flowRange;

  const { breakdown, categories, investmentProjectionTruncations } = useMemo(() => {
    const accounts = ledger?.accounts ?? [];
    const display = ledger ? displayEntriesResultForAsOf(ledger, basis.asOf) : null;
    const entries = display?.entries ?? [];
    return {
      breakdown: livingCostBreakdownForRange(accounts, entries, range),
      categories: expenseCategoryBreakdownForRange(accounts, entries, range),
      investmentProjectionTruncations: display?.investmentProjectionTruncations ?? [],
    };
  }, [basis.asOf, ledger, range]);

  const trends = useMemo(() => buildSectionTrends(period, ledger, today), [period, ledger, today]);
  const visibleProjectionTruncations =
    trends?.investmentProjectionTruncations ?? investmentProjectionTruncations;

  return (
    <section aria-labelledby="expense-breakdown-title" data-ui={UI.expenseBreakdown.view}>
      <h1 className="screen-title" id="expense-breakdown-title">
        {t('expenseBreakdown.title')}
      </h1>
      <p className="field__hint" style={{ marginBottom: 'var(--space-3)' }}>
        {t('expenseBreakdown.intro')}
      </p>

      <InvestmentProjectionTruncationNotice
        truncations={visibleProjectionTruncations}
        accounts={ledger?.accounts ?? []}
      />

      <p className="section-label">{t('expenseBreakdown.byCategory')}</p>
      <p className="field__hint" style={{ marginBottom: 'var(--space-2)' }}>
        {label}
      </p>
      <div className="card" data-ui={UI.expenseBreakdown.categoryList}>
        {categories.length === 0 ? (
          <div className="stmt-row muted">{t('expenseBreakdown.noCategory')}</div>
        ) : (
          categories.map((c) => (
            <button
              key={c.account.id}
              type="button"
              className="stmt-row stmt-row--btn"
              style={{ width: '100%', background: 'transparent', border: 'none' }}
              onClick={() => onDrillDown({ accountId: c.account.id, ...range })}
              aria-label={t('expenseBreakdown.drillDown', { name: c.account.name })}
              data-ui={UI.expenseBreakdown.categoryRow}
            >
              <span>
                {c.account.name} <Icon name="chevronRight" size={12} />
              </span>
              <span className="stmt-row__num">
                <Money amount={c.amount} currency={currency} />
              </span>
            </button>
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
        <button
          type="button"
          className="stat stat--btn"
          onClick={() => onDrillDown({ expenseKind: 'normal', ...range })}
          data-ui={UI.expenseBreakdown.normalExpense}
        >
          <span className="stat__label">
            {t('expenseBreakdown.normalExpense')} <Icon name="chevronRight" size={12} />
          </span>
          <span className="stat__value">
            <Money amount={breakdown.normalExpense} currency={currency} />
          </span>
        </button>
        <button
          type="button"
          className="stat stat--btn"
          onClick={() => onNavigate('allocations')}
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
      <ScrollTopButton />
    </section>
  );
}
