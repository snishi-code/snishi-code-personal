/*
 * 財務諸表。損益計算書(PL)と貸借対照表(BS)を切替表示。いずれも仕訳から毎回導出。
 */
import { useEffect, useMemo, useState } from 'react';
import { useLedger } from '../../state/store';
import { deriveBalanceSheet, deriveProfitAndLoss } from '../../domain/accounting';
import {
  availableYears,
  periodAsOf,
  periodRange,
  type ReportPeriod,
} from '../../domain/reportPeriod';
import { todayLocal } from '../../util/time';
import { Money } from '../money';
import { Icon } from '../Icon';
import { PeriodSwitcher } from '../PeriodSwitcher';
import { t } from '../../i18n';
import { UI } from '../../ui-contract';
import type { AccountBalance } from '../../domain/types';
import type { JournalFilter } from './Journal';

type Tab = 'pl' | 'bs';

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

export function Statements({
  initialTab = 'pl',
  initialSection,
  period,
  onPeriodChange,
  onDrillDown,
}: {
  initialTab?: Tab;
  initialSection?: string;
  period: ReportPeriod;
  onPeriodChange: (p: ReportPeriod) => void;
  onDrillDown: (filter: JournalFilter) => void;
}) {
  const { ledger } = useLedger();
  const [tab, setTab] = useState<Tab>(initialTab);
  const today = todayLocal();
  const currency = ledger?.settings.currency ?? 'JPY';

  // フロー（PL）は期間、ストック（BS）は期間末の基準日。
  const range = useMemo(() => periodRange(period), [period]);
  const asOf = useMemo(() => {
    const entries = ledger?.journalEntries ?? [];
    const lastDataDate = entries.reduce((m, e) => (e.date > m ? e.date : m), '');
    return periodAsOf(period, today, lastDataDate);
  }, [ledger, period, today]);

  // 年別セレクトの選択肢（ホームと同じ導出）。
  const years = useMemo(() => {
    const dates = [
      ...(ledger?.journalEntries ?? []).map((e) => e.date),
      ...(ledger?.cashflowSchedules ?? []).map((s) => s.dueDate),
      ...(ledger?.fundingGoals ?? []).map((g) => g.targetDate),
    ];
    return availableYears(
      dates,
      Number.parseInt(today.slice(0, 4), 10),
      period.mode !== 'all' ? period.year : undefined,
    );
  }, [ledger, today, period]);

  // ホームの項目別遷移で渡されたセクションへスクロールする。
  useEffect(() => {
    if (!initialSection) return;
    const el = document.getElementById(`fs-${initialSection}`);
    el?.scrollIntoView({ block: 'start', behavior: 'smooth' });
  }, [initialSection, tab]);

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

      {/* 期間切替（ホームと共有）。PL は期間合計、BS は期間末時点。 */}
      <PeriodSwitcher value={period} onChange={onPeriodChange} today={today} years={years} />

      {tab === 'pl' ? (
        <div data-ui={UI.statements.profitAndLoss}>
          {/* 個人家計向け: 収入 / 支出 を独立表示し、差引収支は別枠サマリー（混ぜない）。 */}
          <div className="fs-cols">
            <div id="fs-revenue">
              <div className="fs-col__head fs-col--revenue">{t('dashboard.revenue')}</div>
              <div className="card">
                <Rows items={pl.revenues} currency={currency} onDrill={drillPL} />
                <div className="stmt-row stmt-row--total">
                  <span>{t('statements.totalRevenue')}</span>
                  <span className="stmt-row__num">
                    <Money amount={pl.totalRevenue} currency={currency} />
                  </span>
                </div>
              </div>
            </div>
            <div id="fs-expense">
              <div className="fs-col__head fs-col--expense">{t('dashboard.expense')}</div>
              <div className="card">
                <Rows items={pl.expenses} currency={currency} onDrill={drillPL} />
                <div className="stmt-row stmt-row--total">
                  <span>{t('statements.totalExpense')}</span>
                  <span className="stmt-row__num">
                    <Money amount={pl.totalExpense} currency={currency} />
                  </span>
                </div>
              </div>
            </div>
          </div>

          {/* 差引収支（収入合計 − 支出合計）。特定科目ではないのでドリルダウンしない。 */}
          <div className="card" id="fs-net" style={{ marginTop: 'var(--space-3)' }}>
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
          <p
            className="field__hint"
            style={{ marginBottom: 'var(--space-3)' }}
            data-ui={UI.statements.asOf}
          >
            {t('statements.asOfDate', { date: asOf })}
          </p>

          {!bs.balanced ? (
            <div className="banner" role="alert">
              <Icon name="alert" size={18} />
              {t('statements.unbalanced')}
            </div>
          ) : null}

          {/* 左=資産 / 右=負債＋純資産。左右合計が一致する。 */}
          <div className="fs-cols">
            <div id="fs-assets">
              <div className="fs-col__head fs-col--asset">{t('statements.assets')}</div>
              <div className="card">
                <Rows items={bs.assets} currency={currency} onDrill={drillBS} />
                <div className="stmt-row stmt-row--total">
                  <span>{t('statements.total')}</span>
                  <span className="stmt-row__num">
                    <Money amount={bs.totalAssets} currency={currency} />
                  </span>
                </div>
              </div>
            </div>
            <div>
              <div id="fs-liabilities">
                <div className="fs-col__head fs-col--liability">{t('statements.liabilities')}</div>
                <div className="card">
                  <Rows items={bs.liabilities} currency={currency} onDrill={drillBS} />
                  <div className="stmt-row stmt-row--total">
                    <span>{t('statements.totalLiabilities')}</span>
                    <span className="stmt-row__num">
                      <Money amount={bs.totalLiabilities} currency={currency} />
                    </span>
                  </div>
                </div>
              </div>
              <div id="fs-equity" style={{ marginTop: 'var(--space-3)' }}>
                <div className="fs-col__head fs-col--equity">{t('statements.equity')}</div>
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
              <div className="stmt-row stmt-row--total" style={{ marginTop: 'var(--space-3)' }}>
                <span>{t('statements.total')}</span>
                <span className="stmt-row__num">
                  <Money amount={bs.totalLiabilities + bs.netAssets} currency={currency} />
                </span>
              </div>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
