/*
 * 内訳ページ（汎用）。ホームの項目（収入 / 資産 / 負債 / 純資産）ごとの遷移先。
 * 旧・財務諸表（PL/BS トグル）を「項目ごとの内訳 + 推移」に分解したもの。
 *
 *  - revenue（収入・フロー）: 期間の収入科目内訳 + 収入の推移（bar）。
 *  - asset（資産・ストック）: 期間末時点の資産内訳を 4 枠で表示 + 資産の推移（line）。
 *    枠 = 自由に動かせるお金 / 自由に動かせないお金 / 投資 / 継続コスト台帳（1 行 = 残存価値
 *    合計・タップで「毎月のもの」へ）。各枠に小計・最後に全体合計。
 *  - liability（負債・ストック）: 同上 + 資金繰り/返済計画への導線。
 *  - equity（純資産・ストック）: 元手 + 今期の損益 + 純資産の推移（line）。
 */
import { Fragment, useMemo, type CSSProperties } from 'react';
import { Icon } from '@snishi/foundation/ui/Icon';
import { useLedger } from '../../state/store';
import { deriveBalanceSheet, deriveProfitAndLoss } from '../../domain/accounting';
import { reportBasis, type ReportPeriod } from '../../domain/reportPeriod';
import { reportEntriesForAsOf } from '../../domain/reportEntries';
import { todayLocal } from '../../util/time';
import { buildSectionTrends, type SectionTrends } from './breakdownData';
import { Money } from '../money';
import { periodLabel } from '../periodLabel';
import { TrendChart } from '../components/TrendChart';
import { t } from '../../i18n';
import { UI } from '../../ui-contract';
import type { AccountBalance } from '../../domain/types';
import type { MessageKey } from '../../i18n';
import type { Screen } from '../navigation';
import type { JournalFilter } from './Journal';
import { ACCOUNT_ACCENTS, boxByKey, type AccountAccent } from '../accountBoxes';

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

interface BreakdownFrame {
  key: string;
  labelKey: MessageKey;
  rows: AccountBalance[];
  subtotalUi: string;
  accent: AccountAccent;
  /** 継続コスト台帳だけは複数科目を見せず、残存価値合計の1行として毎月のものへ遷移する。 */
  aggregateLedger?: boolean;
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
  const basis = useMemo(() => reportBasis(period, today), [period, today]);
  const range = basis.flowRange;
  const asOf = basis.asOf;
  const reportEntries = useMemo(
    () => (ledger ? reportEntriesForAsOf(ledger, asOf) : []),
    [asOf, ledger],
  );

  const { rows, total, retained } = useMemo(() => {
    const accounts = ledger?.accounts ?? [];
    if (section === 'revenue') {
      const pl = deriveProfitAndLoss(accounts, reportEntries, range);
      return { rows: pl.revenues, total: pl.totalRevenue, retained: undefined };
    }
    const bs = deriveBalanceSheet(accounts, reportEntries, asOf);
    if (section === 'asset') return { rows: bs.assets, total: bs.totalAssets, retained: undefined };
    if (section === 'liability')
      return { rows: bs.liabilities, total: bs.totalLiabilities, retained: undefined };
    return { rows: bs.equity, total: bs.netAssets, retained: bs.retainedEarnings };
  }, [asOf, ledger, range, reportEntries, section]);

  const trends = useMemo(() => buildSectionTrends(period, ledger, today), [period, ledger, today]);
  const trendData = trends ? trends[cfg.series] : null;

  const drill = (accountId: string) =>
    cfg.kind === 'flow'
      ? onDrillDown({ accountId, ...range })
      : onDrillDown({ accountId, to: asOf });

  // 資産は4枠、負債はカード/未払とローンの2枠。同じ描画構造と色の正本を共有する。
  const frames: BreakdownFrame[] | null =
    section === 'asset'
      ? [
          {
            key: 'free',
            labelKey: 'assets.frame.free',
            rows: rows.filter(
              (b) => b.account.role === 'daily-asset' && b.account.movable !== false,
            ),
            subtotalUi: UI.assetsBreakdown.freeSubtotal,
            accent: ACCOUNT_ACCENTS.assetFree,
          },
          {
            key: 'fixed',
            labelKey: 'assets.frame.fixed',
            rows: rows.filter(
              (b) => b.account.role === 'daily-asset' && b.account.movable === false,
            ),
            subtotalUi: UI.assetsBreakdown.fixedSubtotal,
            accent: ACCOUNT_ACCENTS.assetFixed,
          },
          {
            key: 'investment',
            labelKey: 'assets.frame.investment',
            rows: rows.filter((b) => b.account.role === 'investment-asset'),
            subtotalUi: UI.assetsBreakdown.investmentSubtotal,
            accent: boxByKey('investment').accent,
          },
          {
            key: 'ledger',
            labelKey: 'assets.frame.ledger',
            rows: rows.filter((b) => b.account.role === 'continuing-cost-asset'),
            subtotalUi: UI.assetsBreakdown.ledgerSubtotal,
            accent: ACCOUNT_ACCENTS.continuingCost,
            aggregateLedger: true,
          },
        ]
      : section === 'liability'
        ? [
            {
              key: 'shortTermDebt',
              labelKey: 'box.shortTermDebt',
              rows: rows.filter((b) => b.account.role === 'payment-liability'),
              subtotalUi: UI.liabilitiesBreakdown.shortTermSubtotal,
              accent: boxByKey('shortTermDebt').accent,
            },
            {
              key: 'longTermDebt',
              labelKey: 'box.longTermDebt',
              rows: rows.filter((b) => b.account.role === 'other-liability'),
              subtotalUi: UI.liabilitiesBreakdown.longTermSubtotal,
              accent: boxByKey('longTermDebt').accent,
            },
          ]
        : null;

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
        ) : frames ? (
          <>
            {frames.map((frame) =>
              frame.rows.length === 0 ? null : (
                <Fragment key={frame.key}>
                  <div
                    className="stmt-row stmt-row--frame"
                    style={{ '--account-accent': frame.accent } as CSSProperties}
                    data-ui={`${section === 'asset' ? UI.assetsBreakdown.frame : UI.liabilitiesBreakdown.frame}.${frame.key}`}
                  >
                    {t(frame.labelKey)}
                  </div>
                  {frame.aggregateLedger ? (
                    <button
                      type="button"
                      className="stmt-row"
                      onClick={() => onNavigate('allocations')}
                      data-ui={UI.assetsBreakdown.ledgerRow}
                    >
                      <span>{t('assets.frame.ledger')}</span>
                      <span className="stmt-row__num">
                        <Money
                          amount={frame.rows.reduce((s, b) => s + b.balance, 0)}
                          currency={currency}
                        />
                      </span>
                    </button>
                  ) : (
                    frame.rows.map((b) => (
                      <Row
                        key={b.account.id}
                        b={b}
                        currency={currency}
                        rowUi={cfg.row}
                        onDrill={drill}
                      />
                    ))
                  )}
                  <div className="stmt-row stmt-row--subtotal" data-ui={frame.subtotalUi}>
                    <span>{t('breakdown.subtotal')}</span>
                    <span className="stmt-row__num">
                      <Money
                        amount={frame.rows.reduce((s, b) => s + b.balance, 0)}
                        currency={currency}
                      />
                    </span>
                  </div>
                </Fragment>
              ),
            )}
          </>
        ) : (
          rows.map((b) => (
            <Row key={b.account.id} b={b} currency={currency} rowUi={cfg.row} onDrill={drill} />
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
