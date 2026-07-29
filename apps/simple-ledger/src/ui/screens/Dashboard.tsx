/*
 * ホーム（初期表示）。日常入力の主導線（収入/支出/振替）、期間の収支・財政状態サマリー、推移。
 */
import { useMemo, type ReactNode } from 'react';
import { Icon } from '@snishi/foundation/ui/Icon';
import type { IconName } from '@snishi/foundation/ui/Icon';
import { useLedger } from '../../state/store';
import { deriveBalanceSheet, deriveProfitAndLoss } from '../../domain/accounting';
import { livingCostBreakdownForRange } from '../../domain/livingCost';
import { reportBasis, type ReportPeriod } from '../../domain/reportPeriod';
import { reportEntriesForAsOf } from '../../domain/reportEntries';
import { todayLocal } from '../../util/time';
import { buildSectionTrends } from './breakdownData';
import { Money } from '../money';
import { periodLabel } from '../periodLabel';
import { EntryListItem } from '../EntryListItem';
import { TrendChart } from '../components/TrendChart';
import { t } from '../../i18n';
import { UI } from '../../ui-contract';
import type { JournalEntry } from '../../domain/types';
import type { Screen } from '../navigation';
import type { FormMode } from '../entryModes';
import type { MessageKey } from '../../i18n';

const ENTRY_TYPES: { mode: FormMode; labelKey: MessageKey; icon: IconName; ui: string }[] = [
  { mode: 'income', labelKey: 'entry.type.income', icon: 'income', ui: UI.dashboard.income },
  { mode: 'expense', labelKey: 'entry.type.expense', icon: 'expense', ui: UI.dashboard.expense },
  {
    mode: 'transfer',
    labelKey: 'entry.type.transfer',
    icon: 'transfer',
    ui: UI.dashboard.transfer,
  },
];

export function Dashboard({
  period,
  onPeriodChange,
  onAddEntry,
  onEditEntry,
  onNavigate,
  onOpenJournal,
}: {
  period: ReportPeriod;
  onPeriodChange: (p: ReportPeriod) => void;
  onAddEntry: (mode: FormMode) => void;
  onEditEntry: (entry: JournalEntry) => void;
  onNavigate: (screen: Screen) => void;
  onOpenJournal: (filter: { from?: string; to?: string }) => void;
}) {
  const { ledger } = useLedger();
  const today = todayLocal();
  const basis = useMemo(() => reportBasis(period, today), [period, today]);
  const range = basis.flowRange;
  // Journal へは全期間のときクランプ済み range を渡さない（「未来も表示」トグルを殺さないため）。
  const journalFilter = period.mode === 'all' ? {} : range;
  const inRange = (e: JournalEntry) =>
    (!range.from || e.date >= range.from) && e.date <= range.to;
  const periodEntries = (ledger?.journalEntries ?? []).filter(inRange).slice(0, 5);
  const label = periodLabel(period);

  const { pl, bs, asOf, monthlyCost, normalExpense } = useMemo(() => {
    const accounts = ledger?.accounts ?? [];
    const entries = ledger ? reportEntriesForAsOf(ledger, basis.asOf, today) : [];
    const breakdown = livingCostBreakdownForRange(accounts, entries, range);
    return {
      pl: deriveProfitAndLoss(accounts, entries, range),
      bs: deriveBalanceSheet(accounts, entries, basis.asOf),
      asOf: basis.asOf,
      monthlyCost: breakdown.monthlyCost,
      normalExpense: breakdown.normalExpense,
    };
  }, [basis.asOf, ledger, range, today]);

  const trend = useMemo(() => buildSectionTrends(period, ledger, today), [period, ledger, today]);

  const currency = ledger?.settings.currency ?? 'JPY';

  return (
    <>
      <section className="dashboard" aria-labelledby="dashboard-title" data-ui={UI.dashboard.view}>
        <h1 className="sr-only" id="dashboard-title">
          {t('dashboard.title')}
        </h1>

        <p className="section-label">{t('dashboard.flowOf', { label })}</p>
        <div className="stat-grid">
          <StatButton
            label={t('dashboard.revenue')}
            onClick={() => onNavigate('incomeBreakdown')}
            dataUi={UI.dashboard.statRevenue}
          >
            <Money amount={pl.totalRevenue} currency={currency} />
          </StatButton>
          <StatButton
            label={t('dashboard.expense')}
            onClick={() => onNavigate('expenseBreakdown')}
            dataUi={UI.dashboard.statExpense}
          >
            <Money amount={normalExpense + monthlyCost} currency={currency} />
          </StatButton>
          <StatButton
            label={t('dashboard.netIncome')}
            onClick={() => onNavigate('netIncome')}
            dataUi={UI.dashboard.statNetIncome}
          >
            <Money
              amount={pl.totalRevenue - (normalExpense + monthlyCost)}
              currency={currency}
              signed
            />
          </StatButton>
        </div>

        <p className="section-label">{t('dashboard.positionAsOf', { date: asOf })}</p>
        <div className="stat-grid">
          <StatButton
            label={t('dashboard.assets')}
            onClick={() => onNavigate('assetsBreakdown')}
            dataUi={UI.dashboard.statAssets}
          >
            <Money amount={bs.totalAssets} currency={currency} />
          </StatButton>
          <StatButton
            label={t('dashboard.liabilities')}
            onClick={() => onNavigate('liabilitiesBreakdown')}
            dataUi={UI.dashboard.statLiabilities}
          >
            <Money amount={bs.totalLiabilities} currency={currency} />
          </StatButton>
          <StatButton
            label={t('dashboard.netAssets')}
            onClick={() => onNavigate('netAssets')}
            dataUi={UI.dashboard.statNetAssets}
          >
            <Money amount={bs.netAssets} currency={currency} signed />
          </StatButton>
        </div>

        {trend ? (
          <div data-ui={UI.period.trend}>
            <TrendChart
              title={t('dashboard.trendNet')}
              data={trend.net}
              currency={currency}
              variant="bar"
              dataUi={UI.period.trendChart}
              pointDataUi={UI.period.trendPoint}
              {...(trend.drillable
                ? {
                    onSelect: (key: string) =>
                      onPeriodChange({ mode: 'year', year: Number.parseInt(key, 10) }),
                    selectHint: t('dashboard.trendDrillYear'),
                  }
                : {})}
            />
            <TrendChart
              title={t('dashboard.trendLiving')}
              data={trend.living}
              currency={currency}
              variant="bar"
            />
            <TrendChart
              title={t('dashboard.trendAssets')}
              data={trend.netAssets}
              currency={currency}
              variant="line"
            />
            {trend.drillable ? <p className="field__hint">{t('period.trendYearHint')}</p> : null}
          </div>
        ) : null}

        <div
          className="section-label"
          style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}
        >
          <span>{t('dashboard.entriesOf', { label })}</span>
          {periodEntries.length > 0 ? (
            <button
              type="button"
              className="btn btn--ghost"
              style={{ minHeight: 32 }}
              onClick={() => onOpenJournal(journalFilter)}
              data-ui={UI.dashboard.journalOpenAll}
            >
              {t('dashboard.viewAll')}
              <Icon name="chevronRight" size={16} />
            </button>
          ) : null}
        </div>
        {periodEntries.length === 0 ? (
          <div className="card card--pad muted">{t('dashboard.noMonthEntries')}</div>
        ) : (
          <ul className="card list" data-ui={UI.dashboard.journalPreview}>
            {periodEntries.map((entry) => {
              const generated = !!entry.metadata?.monthlyCostId;
              return (
                <EntryListItem
                  key={entry.id}
                  entry={entry}
                  accounts={ledger?.accounts ?? []}
                  currency={currency}
                  onClick={() => (generated ? onOpenJournal(journalFilter) : onEditEntry(entry))}
                />
              );
            })}
          </ul>
        )}
      </section>

      <div
        className="entry-bar"
        role="group"
        aria-label={t('dashboard.entryActions')}
        data-ui={UI.dashboard.entryBar}
      >
        <div className="entry-bar__inner">
          {ENTRY_TYPES.map((ty) => (
            <button
              key={ty.mode}
              type="button"
              className="entry-type-btn"
              onClick={() => onAddEntry(ty.mode)}
              data-ui={ty.ui}
            >
              <span className="entry-type-btn__icon">
                <Icon name={ty.icon} size={20} />
              </span>
              {t(ty.labelKey)}
            </button>
          ))}
        </div>
      </div>
    </>
  );
}

function StatButton({
  label,
  onClick,
  dataUi,
  children,
}: {
  label: string;
  onClick: () => void;
  dataUi?: string;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      className="stat stat--btn"
      onClick={onClick}
      aria-label={t('dashboard.statDetail', { label })}
      data-ui={dataUi}
    >
      <span className="stat__label">
        {label} <Icon name="chevronRight" size={12} />
      </span>
      <span className="stat__value">{children}</span>
    </button>
  );
}
