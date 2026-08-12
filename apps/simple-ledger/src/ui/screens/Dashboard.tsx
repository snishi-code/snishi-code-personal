/*
 * ホーム（初期表示）。日常入力の主導線（収入/支出/振替）、期間の収支・財政状態サマリー、推移。
 */
import { useMemo, useState, type ReactNode } from 'react';
import { Icon } from '@snishi/foundation/ui/Icon';
import type { IconName } from '@snishi/foundation/ui/Icon';
import { Button } from '@snishi/foundation/ui/Button';
import { useLedger } from '../../state/store';
import {
  deriveBalanceSheet,
  deriveProfitAndLoss,
  filterByDateRange,
} from '../../domain/accounting';
import { livingCostBreakdownForRange } from '../../domain/livingCost';
import { reportBasis, type ReportPeriod } from '../../domain/reportPeriod';
import { displayEntriesForAsOf } from '../../domain/reportEntries';
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
import { ScrollTopButton } from '../ScrollTopButton';

/** ホームの仕訳一覧の 1 ページぶん（「さらに表示」で足す刻み）。 */
const HOME_ENTRY_PAGE = 50;

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
  // 期間内の保存される仕訳（導出行は混ぜない = 自分が付けた記録が埋もれない）。
  // 並び順は loadLedger の既定（日付降順 → createdAt 降順）に乗る。件数上限は撤廃し、
  // 「さらに表示」で HOME_ENTRY_PAGE 件ずつ開く（実ユーズ④・作者決定 2026-08-12:
  // 月内ぶんをその場でスクロールして読めればよく、月をまたぐ遡りは「すべて見る」のまま）。
  const periodEntries = useMemo(
    () => filterByDateRange(ledger?.journalEntries ?? [], range.from, range.to),
    [ledger, range],
  );
  // 表示日（期間）を変えたら表示件数を初期化する（effect を使わない render 中の派生調整）。
  const rangeKey = `${range.from ?? ''}..${range.to}`;
  const [shown, setShown] = useState({ key: rangeKey, count: HOME_ENTRY_PAGE });
  if (shown.key !== rangeKey) setShown({ key: rangeKey, count: HOME_ENTRY_PAGE });
  const visibleEntries = periodEntries.slice(0, shown.count);
  const remaining = periodEntries.length - visibleEntries.length;
  const label = periodLabel(period);

  const { pl, bs, asOf, monthlyCost, normalExpense } = useMemo(() => {
    const accounts = ledger?.accounts ?? [];
    // 表示は投影込み（displayEntries）。ヘッダー日付を未来にすると資産・純資産が投影込みになる。
    const entries = ledger ? displayEntriesForAsOf(ledger, basis.asOf, today) : [];
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

        {/* 額縁: 収支 + 財政状態の 6 枠を sticky 固定し、下の仕訳だけが流れる
            （実ユーズ④・作者決定 2026-08-12「6枠を固定」）。 */}
        <div className="dashboard__frame" data-ui={UI.dashboard.frame}>
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
          <>
            <ul className="card list dashboard__entries" data-ui={UI.dashboard.journalPreview}>
              {visibleEntries.map((entry) => {
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
            {remaining > 0 ? (
              // 末尾追記のみ（scrollTo を呼ばない = 既に表示中の行は動かない）。
              <Button
                variant="ghost"
                block
                dataUi={UI.dashboard.journalMore}
                onClick={() => setShown((s) => ({ ...s, count: s.count + HOME_ENTRY_PAGE }))}
              >
                {t('dashboard.moreEntries', { count: remaining })}
              </Button>
            ) : null}
          </>
        )}
        <ScrollTopButton />
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
