/*
 * ホーム（初期表示）。今月の収益/費用/純損益と、資産/負債/純資産、最近の仕訳。
 */
import { useMemo } from 'react';
import { useLedger } from '../../state/store';
import { deriveBalanceSheet, deriveProfitAndLoss, monthRange } from '../../domain/accounting';
import { currentYearMonth } from '../../util/time';
import { Money } from '../money';
import { Icon } from '../Icon';
import { t } from '../../i18n';
import { UI } from '../../ui-contract';
import type { JournalEntry } from '../../domain/types';
import { EntryListItem } from '../EntryListItem';
import type { Screen } from '../navigation';

export function Dashboard({
  onAddEntry,
  onEditEntry,
  onNavigate,
}: {
  onAddEntry: () => void;
  onEditEntry: (entry: JournalEntry) => void;
  onNavigate: (screen: Screen) => void;
}) {
  const { ledger } = useLedger();
  const { year, month } = currentYearMonth();

  const { pl, bs, recent } = useMemo(() => {
    const accounts = ledger?.accounts ?? [];
    const entries = ledger?.journalEntries ?? [];
    const range = monthRange(year, month);
    return {
      pl: deriveProfitAndLoss(accounts, entries, range),
      bs: deriveBalanceSheet(accounts, entries),
      recent: entries.slice(0, 5),
    };
  }, [ledger, year, month]);

  const currency = ledger?.settings.currency ?? 'JPY';
  const hasEntries = (ledger?.journalEntries.length ?? 0) > 0;

  return (
    <section aria-labelledby="dashboard-title" data-ui={UI.dashboard.view}>
      <h1 className="screen-title" id="dashboard-title">
        {t('dashboard.title')}
      </h1>

      {!hasEntries ? (
        <div className="card card--pad empty">
          <Icon name="sprout" size={32} />
          <p style={{ marginTop: 'var(--space-3)' }}>{t('dashboard.noEntries')}</p>
          <div className="empty__cta">
            <button
              type="button"
              className="btn btn--primary"
              onClick={onAddEntry}
              data-ui={UI.dashboard.addEntry}
            >
              <Icon name="plus" size={18} />
              {t('dashboard.emptyCta')}
            </button>
          </div>
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
