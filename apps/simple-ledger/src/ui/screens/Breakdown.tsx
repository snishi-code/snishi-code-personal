/*
 * 内訳ページ（汎用）。ホームの項目（収入 / 資産 / 負債 / 純資産）ごとの遷移先。
 * 旧・財務諸表（PL/BS トグル）を「項目ごとの内訳 + 推移」に分解したもの。
 *
 *  - revenue（収入・フロー）: 期間の収入科目内訳 + 収入の推移（bar）。
 *  - asset（資産・ストック）: 期間末時点の資産科目内訳 + 資産の推移（line）。
 *  - liability（負債・ストック）: 同上 + 資金繰り/返済計画への導線。
 *  - equity（純資産・ストック）: 元手 + 今期の損益 + 純資産の推移（line）。
 */
import { Fragment, useMemo } from 'react';
import { Icon } from '@snishi/foundation/ui/Icon';
import { useLedger } from '../../state/store';
import { deriveBalanceSheet, deriveProfitAndLoss } from '../../domain/accounting';
import { reserveBalances } from '../../domain/reserve';
import { RESERVE_LEDGER_ACCOUNT_ID } from '../../domain/constants';
import { periodAsOf, periodLabel, periodRange, type ReportPeriod } from '../../domain/reportPeriod';
import { todayLocal } from '../../util/time';
import { buildSectionTrends, type SectionTrends } from './breakdownData';
import { Money } from '../money';
import { TrendChart } from '../components/TrendChart';
import { t } from '../../i18n';
import { UI } from '../../ui-contract';
import type { AccountBalance } from '../../domain/types';
import type { MessageKey } from '../../i18n';
import type { Screen } from '../navigation';
import type { JournalFilter } from './Journal';

export type BreakdownSection = 'revenue' | 'asset' | 'liability' | 'equity';

interface SectionConfig {
  kind: 'flow' | 'stock';
  view: string;
  row: string;
  total: string;
  titleKey: MessageKey;
  introKey: MessageKey;
  totalLabelKey: MessageKey;
  trendKey: MessageKey;
  trendVariant: 'bar' | 'line';
  series: keyof Omit<SectionTrends, 'drillable'>;
}

const CONFIG: Record<BreakdownSection, SectionConfig> = {
  revenue: {
    kind: 'flow',
    view: UI.incomeBreakdown.view,
    row: UI.incomeBreakdown.row,
    total: UI.incomeBreakdown.total,
    titleKey: 'income.title',
    introKey: 'income.intro',
    totalLabelKey: 'income.total',
    trendKey: 'income.trend',
    trendVariant: 'bar',
    series: 'revenue',
  },
  asset: {
    kind: 'stock',
    view: UI.assetsBreakdown.view,
    row: UI.assetsBreakdown.row,
    total: UI.assetsBreakdown.total,
    titleKey: 'assets.title',
    introKey: 'assets.intro',
    totalLabelKey: 'assets.total',
    trendKey: 'assets.trend',
    trendVariant: 'line',
    series: 'assets',
  },
  liability: {
    kind: 'stock',
    view: UI.liabilitiesBreakdown.view,
    row: UI.liabilitiesBreakdown.row,
    total: UI.liabilitiesBreakdown.total,
    titleKey: 'liabilities.title',
    introKey: 'liabilities.intro',
    totalLabelKey: 'liabilities.total',
    trendKey: 'liabilities.trend',
    trendVariant: 'line',
    series: 'liabilities',
  },
  equity: {
    kind: 'stock',
    view: UI.netAssets.view,
    row: UI.netAssets.row,
    total: UI.netAssets.total,
    titleKey: 'netAssets.title',
    introKey: 'netAssets.intro',
    totalLabelKey: 'netAssets.total',
    trendKey: 'netAssets.trend',
    trendVariant: 'line',
    series: 'netAssets',
  },
};

function Row({
  b,
  currency,
  rowUi,
  onDrill,
}: {
  b: AccountBalance;
  currency: string;
  rowUi: string;
  onDrill: (accountId: string) => void;
}) {
  return (
    <button
      type="button"
      className="stmt-row"
      onClick={() => onDrill(b.account.id)}
      aria-label={t('breakdown.viewEntries', { name: b.account.name })}
      data-ui={rowUi}
    >
      <span>{b.account.name}</span>
      <span className="stmt-row__num">
        <Money amount={b.balance} currency={currency} />
      </span>
    </button>
  );
}

export function Breakdown({
  section,
  period,
  onPeriodChange,
  onDrillDown,
  onNavigate,
}: {
  section: BreakdownSection;
  period: ReportPeriod;
  onPeriodChange: (p: ReportPeriod) => void;
  onDrillDown: (filter: JournalFilter) => void;
  onNavigate: (screen: Screen) => void;
}) {
  const cfg = CONFIG[section];
  const { ledger } = useLedger();
  const currency = ledger?.settings.currency ?? 'JPY';
  const today = todayLocal();
  const range = useMemo(() => periodRange(period), [period]);
  const asOf = useMemo(() => {
    const entries = ledger?.journalEntries ?? [];
    const lastDataDate = entries.reduce((m, e) => (e.date > m ? e.date : m), '');
    return periodAsOf(period, today, lastDataDate);
  }, [ledger, period, today]);

  const { rows, total, retained } = useMemo(() => {
    const accounts = ledger?.accounts ?? [];
    const entries = ledger?.derivedEntries ?? [];
    if (section === 'revenue') {
      const pl = deriveProfitAndLoss(accounts, entries, range);
      return { rows: pl.revenues, total: pl.totalRevenue, retained: undefined };
    }
    const bs = deriveBalanceSheet(accounts, entries, asOf || undefined);
    if (section === 'asset') return { rows: bs.assets, total: bs.totalAssets, retained: undefined };
    if (section === 'liability')
      return { rows: bs.liabilities, total: bs.totalLiabilities, retained: undefined };
    return { rows: bs.equity, total: bs.netAssets, retained: bs.retainedEarnings };
  }, [ledger, section, range, asOf]);

  const trends = useMemo(() => buildSectionTrends(period, ledger), [period, ledger]);
  const trendData = trends ? trends[cfg.series] : null;

  const reserves = ledger?.reserves ?? [];
  const reserveSub = useMemo(() => reserveBalances(ledger?.journalEntries ?? []), [ledger]);

  const drill = (accountId: string) =>
    cfg.kind === 'flow'
      ? onDrillDown({ accountId, ...(range ?? {}) })
      : onDrillDown({ accountId, ...(asOf ? { to: asOf } : {}) });

  return (
    <section aria-labelledby="breakdown-title" data-ui={cfg.view}>
      <h1 className="screen-title" id="breakdown-title">
        {t(cfg.titleKey)}
      </h1>
      <p className="field__hint" style={{ marginBottom: 'var(--space-3)' }}>
        {t(cfg.introKey)}
      </p>

      {cfg.kind === 'flow' ? (
        <p className="section-label">{periodLabel(period)}</p>
      ) : (
        <p className="field__hint" style={{ marginBottom: 'var(--space-2)' }}>
          {t('breakdown.asOfDate', { date: asOf })}
        </p>
      )}

      <div className="card">
        {rows.length === 0 && retained === undefined ? (
          <div className="stmt-row muted">{t('breakdown.noData')}</div>
        ) : (
          rows.map((b) => (
            <Fragment key={b.account.id}>
              <Row b={b} currency={currency} rowUi={cfg.row} onDrill={drill} />
              {section === 'asset' && b.account.id === RESERVE_LEDGER_ACCOUNT_ID
                ? reserves.map((r) => (
                    <div
                      key={r.id}
                      className="stmt-row stmt-row--sub"
                      style={{ paddingLeft: 'var(--space-5)' }}
                      data-ui={UI.assetsBreakdown.reserveSub}
                    >
                      <span className="muted">{t('breakdown.reserveOf', { name: r.name })}</span>
                      <span className="stmt-row__num">
                        <Money amount={reserveSub.get(r.id) ?? 0} currency={currency} />
                      </span>
                    </div>
                  ))
                : null}
            </Fragment>
          ))
        )}
        {retained !== undefined ? (
          <div className="stmt-row">
            <span>{t('netAssets.retained')}</span>
            <span className="stmt-row__num">
              <Money amount={retained} currency={currency} signed />
            </span>
          </div>
        ) : null}
        <div className="stmt-row stmt-row--total" data-ui={cfg.total}>
          <span>{t(cfg.totalLabelKey)}</span>
          <span className="stmt-row__num">
            <Money amount={total} currency={currency} signed={section === 'equity'} />
          </span>
        </div>
      </div>

      {rows.length > 0 ? (
        <p className="field__hint" style={{ marginTop: 'var(--space-2)' }}>
          {t('breakdown.drilldownHint')}
        </p>
      ) : null}

      {trendData && trendData.length > 1 ? (
        <div style={{ marginTop: 'var(--space-4)' }}>
          <TrendChart
            title={t(cfg.trendKey)}
            data={trendData}
            currency={currency}
            variant={cfg.trendVariant}
            {...(trends?.drillable
              ? {
                  onSelect: (key: string) =>
                    onPeriodChange({ mode: 'year', year: Number.parseInt(key, 10) }),
                  selectHint: t('dashboard.trendDrillYear'),
                }
              : {})}
          />
        </div>
      ) : null}

      {section === 'liability' ? (
        <button
          type="button"
          className="btn btn--ghost"
          style={{ marginTop: 'var(--space-3)' }}
          onClick={() => onNavigate('cashflow')}
          data-ui={UI.liabilitiesBreakdown.cashflowLink}
        >
          <Icon name="trending" size={16} />
          {t('liabilities.cashflowLink')}
          <Icon name="chevronRight" size={16} />
        </button>
      ) : null}
    </section>
  );
}
