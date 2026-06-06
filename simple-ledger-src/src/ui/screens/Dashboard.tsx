/*
 * ホーム（初期表示）。今月の収益/費用/純損益と、資産/負債/純資産、最近の仕訳。
 */
import { useMemo } from 'react';
import { useLedger } from '../../state/store';
import { deriveBalanceSheet, deriveProfitAndLoss, monthRange } from '../../domain/accounting';
import { isCompleted } from '../../domain/allocation';
import { currentYearMonth } from '../../util/time';
import { Money } from '../money';
import { Icon } from '../Icon';
import { t } from '../../i18n';
import { UI } from '../../ui-contract';
import type { JournalEntry } from '../../domain/types';
import { EntryListItem } from '../EntryListItem';
import type { Screen } from '../navigation';
import type { FormMode } from '../entryModes';
import type { IconName } from '../Icon';
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
  onAddEntry,
  onEditEntry,
  onNavigate,
}: {
  onAddEntry: (mode: FormMode) => void;
  onEditEntry: (entry: JournalEntry) => void;
  onNavigate: (screen: Screen) => void;
}) {
  const { ledger } = useLedger();
  const { year, month } = currentYearMonth();

  const { pl, bs, recent, recognition, activeCount } = useMemo(() => {
    const accounts = ledger?.accounts ?? [];
    const entries = ledger?.journalEntries ?? [];
    const range = monthRange(year, month);
    const currentYm = `${year}-${String(month).padStart(2, '0')}`;
    // 今月の按分認識額（recognition 仕訳の費用＝借方額）。
    const recognitionAmt = entries
      .filter(
        (e) =>
          e.metadata?.allocationRole === 'recognition' &&
          e.date >= range.from &&
          e.date <= range.to,
      )
      .reduce((s, e) => s + (e.lines.find((l) => l.side === 'debit')?.amount ?? 0), 0);
    return {
      pl: deriveProfitAndLoss(accounts, entries, range),
      bs: deriveBalanceSheet(accounts, entries),
      recent: entries.slice(0, 5),
      recognition: recognitionAmt,
      activeCount: (ledger?.allocations ?? []).filter((a) => !isCompleted(a, currentYm)).length,
    };
  }, [ledger, year, month]);

  const currency = ledger?.settings.currency ?? 'JPY';
  const hasEntries = (ledger?.journalEntries.length ?? 0) > 0;
  const normalExpense = pl.totalExpense - recognition;

  return (
    <section aria-labelledby="dashboard-title" data-ui={UI.dashboard.view}>
      <h1 className="screen-title" id="dashboard-title">
        {t('dashboard.title')}
      </h1>

      {/* 日常入力の主導線（収入/支出/振替） */}
      <div className="entry-types">
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

      {!hasEntries ? (
        <div className="card card--pad empty">
          <Icon name="sprout" size={32} />
          <p style={{ marginTop: 'var(--space-3)' }}>{t('dashboard.noEntries')}</p>
        </div>
      ) : null}

      <p className="section-label">{t('dashboard.thisMonth', { year, month })}</p>
      <div className="stat-grid">
        <div className="stat">
          <span className="stat__label">{t('dashboard.revenue')}</span>
          <span className="stat__value">
            <Money amount={pl.totalRevenue} currency={currency} />
          </span>
        </div>
        <div className="stat">
          <span className="stat__label">{t('dashboard.expense')}</span>
          <span className="stat__value">
            <Money amount={pl.totalExpense} currency={currency} />
          </span>
        </div>
        <div className="stat">
          <span className="stat__label">{t('dashboard.netIncome')}</span>
          <span className="stat__value">
            <Money amount={pl.netIncome} currency={currency} signed />
          </span>
        </div>
      </div>

      <p className="section-label">{t('dashboard.position')}</p>
      <div className="stat-grid">
        <div className="stat">
          <span className="stat__label">{t('dashboard.assets')}</span>
          <span className="stat__value">
            <Money amount={bs.totalAssets} currency={currency} />
          </span>
        </div>
        <div className="stat">
          <span className="stat__label">{t('dashboard.liabilities')}</span>
          <span className="stat__value">
            <Money amount={bs.totalLiabilities} currency={currency} />
          </span>
        </div>
        <div className="stat">
          <span className="stat__label">{t('dashboard.netAssets')}</span>
          <span className="stat__value">
            <Money amount={bs.netAssets} currency={currency} signed />
          </span>
        </div>
      </div>

      <p className="section-label">{t('dashboard.livingCost')}</p>
      <div className="stat-grid">
        <div className="stat">
          <span className="stat__label">{t('dashboard.normalExpense')}</span>
          <span className="stat__value">
            <Money amount={normalExpense} currency={currency} />
          </span>
        </div>
        <div className="stat">
          <span className="stat__label">{t('dashboard.allocatedExpense')}</span>
          <span className="stat__value">
            <Money amount={recognition} currency={currency} />
          </span>
        </div>
        <div className="stat">
          <span className="stat__label">{t('dashboard.livingCostTotal')}</span>
          <span className="stat__value">
            <Money amount={pl.totalExpense} currency={currency} />
          </span>
        </div>
      </div>
      <button
        type="button"
        className="btn btn--ghost btn--block"
        style={{ marginTop: 'var(--space-2)', justifyContent: 'space-between' }}
        onClick={() => onNavigate('allocations')}
      >
        <span>{t('dashboard.activeAllocations', { count: activeCount })}</span>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
          {t('dashboard.viewAllocations')}
          <Icon name="chevronRight" size={16} />
        </span>
      </button>

      {hasEntries ? (
        <>
          <div
            className="section-label"
            style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}
          >
            <span>{t('dashboard.recentEntries')}</span>
            <button
              type="button"
              className="btn btn--ghost"
              style={{ minHeight: 32 }}
              onClick={() => onNavigate('journal')}
            >
              {t('dashboard.viewAll')}
              <Icon name="chevronRight" size={16} />
            </button>
          </div>
          <ul className="card list" data-ui={UI.dashboard.recentList}>
            {recent.map((entry) => (
              <EntryListItem
                key={entry.id}
                entry={entry}
                accounts={ledger?.accounts ?? []}
                currency={currency}
                onClick={() => onEditEntry(entry)}
              />
            ))}
          </ul>
        </>
      ) : null}
    </section>
  );
}
