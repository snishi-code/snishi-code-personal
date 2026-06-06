/*
 * 財務諸表。損益計算書(PL)と貸借対照表(BS)を切替表示。いずれも仕訳から毎回導出。
 */
import { useMemo, useState } from 'react';
import { useLedger } from '../../state/store';
import { deriveBalanceSheet, deriveProfitAndLoss, monthRange } from '../../domain/accounting';
import { currentYearMonth, todayLocal } from '../../util/time';
import { Money } from '../money';
import { Icon } from '../Icon';
import { t } from '../../i18n';
import { UI } from '../../ui-contract';
import type { AccountBalance } from '../../domain/types';
import type { JournalFilter } from './Journal';

type Tab = 'pl' | 'bs';
type Period = 'all' | 'month' | 'year';

function Rows({
  items,
  currency,
  onDrill,
}: {
  items: AccountBalance[];
  currency: string;
  onDrill: (accountId: string) => void;
}) {
  if (items.length === 0) {
    return <div className="stmt-row muted">{t('statements.noData')}</div>;
  }
  return (
    <>
      {items.map((b) => (
        <button
          type="button"
          className="stmt-row"
          key={b.account.id}
          onClick={() => onDrill(b.account.id)}
          aria-label={t('statements.viewEntries', { name: b.account.name })}
          data-ui={UI.statements.row}
        >
          <span>{b.account.name}</span>
          <span className="stmt-row__num">
            <Money amount={b.balance} currency={currency} />
          </span>
        </button>
      ))}
    </>
  );
}

export function Statements({ onDrillDown }: { onDrillDown: (filter: JournalFilter) => void }) {
  const { ledger } = useLedger();
  const [tab, setTab] = useState<Tab>('pl');
  const [period, setPeriod] = useState<Period>('month');
  // BS の基準日。既定は今日（未来月の按分認識仕訳を現在残高に含めない）。
  const [asOf, setAsOf] = useState<string>(todayLocal());
  const { year, month } = currentYearMonth();
  const currency = ledger?.settings.currency ?? 'JPY';

  const range = useMemo(() => {
    if (period === 'all') return undefined;
    if (period === 'year') return { from: `${year}-01-01`, to: `${year}-12-31` };
    return monthRange(year, month);
  }, [period, year, month]);

  const pl = useMemo(
    () => deriveProfitAndLoss(ledger?.accounts ?? [], ledger?.journalEntries ?? [], range),
    [ledger, range],
  );
  const bs = useMemo(
    () =>
      deriveBalanceSheet(ledger?.accounts ?? [], ledger?.journalEntries ?? [], asOf || undefined),
    [ledger, asOf],
  );

  // PL は期間を、BS は基準日(asOf)を引き継いで Journal へドリルダウンする。
  const drillPL = (accountId: string) => onDrillDown({ accountId, ...(range ?? {}) });
  const drillBS = (accountId: string) => onDrillDown({ accountId, ...(asOf ? { to: asOf } : {}) });

  return (
    <section aria-labelledby="statements-title" data-ui={UI.statements.view}>
      <h1 className="screen-title" id="statements-title">
        {t('statements.title')}
      </h1>

      <div
        className="segmented"
        role="tablist"
        aria-label={t('statements.title')}
        style={{ marginBottom: 'var(--space-4)' }}
      >
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'pl'}
          className="segmented__btn"
          onClick={() => setTab('pl')}
          data-ui={UI.statements.tabPl}
        >
          {t('statements.pl')}
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'bs'}
          className="segmented__btn"
          onClick={() => setTab('bs')}
          data-ui={UI.statements.tabBs}
        >
          {t('statements.bs')}
        </button>
      </div>

      <p className="field__hint" style={{ marginBottom: 'var(--space-3)' }}>
        {t('statements.drilldownHint')}
      </p>

      {tab === 'pl' ? (
        <div data-ui={UI.statements.profitAndLoss}>
          <div className="toolbar">
            <label className="sr-only" htmlFor="pl-period">
              {t('statements.period')}
            </label>
            <select
              id="pl-period"
              className="select"
              value={period}
              aria-label={t('statements.period')}
              onChange={(e) => setPeriod(e.target.value as Period)}
            >
              <option value="month">{t('statements.thisMonth')}</option>
              <option value="year">{t('statements.thisYear')}</option>
              <option value="all">{t('statements.allPeriods')}</option>
            </select>
          </div>

          <p className="section-label">{t('dashboard.revenue')}</p>
          <div className="card">
            <Rows items={pl.revenues} currency={currency} onDrill={drillPL} />
            <div className="stmt-row stmt-row--total">
              <span>{t('statements.totalRevenue')}</span>
              <span className="stmt-row__num">
                <Money amount={pl.totalRevenue} currency={currency} />
              </span>
            </div>
          </div>

          <p className="section-label">{t('dashboard.expense')}</p>
          <div className="card">
            <Rows items={pl.expenses} currency={currency} onDrill={drillPL} />
            <div className="stmt-row stmt-row--total">
              <span>{t('statements.totalExpense')}</span>
              <span className="stmt-row__num">
                <Money amount={pl.totalExpense} currency={currency} />
              </span>
            </div>
          </div>

          <div className="card" style={{ marginTop: 'var(--space-4)' }}>
            <div className="stmt-row stmt-row--total">
              <span>{t('statements.netIncome')}</span>
              <span className="stmt-row__num">
                <Money amount={pl.netIncome} currency={currency} signed />
              </span>
            </div>
          </div>
        </div>
      ) : (
        <div data-ui={UI.statements.balanceSheet}>
          <div className="toolbar">
            <label className="sr-only" htmlFor="bs-asof">
              {t('statements.asOf')}
            </label>
            <input
              id="bs-asof"
              className="input"
              type="date"
              value={asOf}
              aria-label={t('statements.asOf')}
              onChange={(e) => setAsOf(e.target.value)}
              data-ui={UI.statements.asOf}
            />
          </div>
          <p className="field__hint" style={{ marginBottom: 'var(--space-3)' }}>
            {t('statements.asOfHint')}
          </p>

          {!bs.balanced ? (
            <div className="banner" role="alert">
              <Icon name="alert" size={18} />
              {t('statements.unbalanced')}
            </div>
          ) : null}

          <p className="section-label">{t('statements.assets')}</p>
          <div className="card">
            <Rows items={bs.assets} currency={currency} onDrill={drillBS} />
            <div className="stmt-row stmt-row--total">
              <span>{t('statements.totalAssets')}</span>
              <span className="stmt-row__num">
                <Money amount={bs.totalAssets} currency={currency} />
              </span>
            </div>
          </div>

          <p className="section-label">{t('statements.liabilities')}</p>
          <div className="card">
            <Rows items={bs.liabilities} currency={currency} onDrill={drillBS} />
            <div className="stmt-row stmt-row--total">
              <span>{t('statements.totalLiabilities')}</span>
              <span className="stmt-row__num">
                <Money amount={bs.totalLiabilities} currency={currency} />
              </span>
            </div>
          </div>

          <p className="section-label">{t('statements.equity')}</p>
          <div className="card">
            <Rows items={bs.equity} currency={currency} onDrill={drillBS} />
            <div className="stmt-row">
              <span>{t('statements.retainedEarnings')}</span>
              <span className="stmt-row__num">
                <Money amount={bs.retainedEarnings} currency={currency} signed />
              </span>
            </div>
            <div className="stmt-row stmt-row--total">
              <span>{t('statements.netAssets')}</span>
              <span className="stmt-row__num">
                <Money amount={bs.netAssets} currency={currency} signed />
              </span>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
