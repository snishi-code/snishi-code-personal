/*
 * ホーム（初期表示）。日常入力の主導線（収入/支出/振替）、期間の収支・財政状態サマリー、推移。
 */
import { useMemo, useRef, useState } from 'react';
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
import { Money, moneyText, useMoneyDigits } from '../money';
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
import { assertSafeAmount } from '../../domain/safeSum';

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
  const listRef = useRef<HTMLUListElement>(null);

  // 「さらに表示」は末尾追記なので既存行は動かない（scrollTo を呼ばない）。ただし最終ページでは
  // ボタン自身が消えてフォーカスが body へ落ちるため、最初に増えた行へ意図的に移す。
  const showMore = () => {
    const firstAdded = visibleEntries.length;
    const willFinish = remaining <= HOME_ENTRY_PAGE;
    setShown((s) => ({ ...s, count: s.count + HOME_ENTRY_PAGE }));
    if (!willFinish) return;
    // 追加行の描画後にフォーカスを移す（ボタンが消えるのは同じコミット）。
    queueMicrotask(() => {
      const rows = listRef.current?.querySelectorAll<HTMLElement>('button.list__item');
      rows?.[firstAdded]?.focus();
    });
  };

  const { pl, bs, asOf, livingTotal } = useMemo(() => {
    const accounts = ledger?.accounts ?? [];
    // 表示は投影込み（displayEntries）。ヘッダー日付を未来にすると資産・純資産が投影込みになる。
    const entries = ledger ? displayEntriesForAsOf(ledger, basis.asOf, today) : [];
    const breakdown = livingCostBreakdownForRange(accounts, entries, range);
    return {
      pl: deriveProfitAndLoss(accounts, entries, range),
      bs: deriveBalanceSheet(accounts, entries, basis.asOf),
      asOf: basis.asOf,
      // 支出合計・純益は domain の値をそのまま使う（UI で式を再実装しない）。
      livingTotal: breakdown.total,
    };
  }, [basis.asOf, ledger, range, today]);

  const trend = useMemo(() => buildSectionTrends(period, ledger, today), [period, ledger, today]);

  const currency = ledger?.settings.currency ?? '';

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
              amount={pl.totalRevenue}
              currency={currency}
              onClick={() => onNavigate('incomeBreakdown')}
              dataUi={UI.dashboard.statRevenue}
            />
            <StatButton
              label={t('dashboard.expense')}
              amount={livingTotal}
              currency={currency}
              onClick={() => onNavigate('expenseBreakdown')}
              dataUi={UI.dashboard.statExpense}
            />
            <StatButton
              label={t('dashboard.netIncome')}
              amount={assertSafeAmount(pl.totalRevenue - livingTotal)}
              currency={currency}
              signed
              onClick={() => onNavigate('netIncome')}
              dataUi={UI.dashboard.statNetIncome}
            />
          </div>

          <p className="section-label">{t('dashboard.positionAsOf', { date: asOf })}</p>
          <div className="stat-grid">
            <StatButton
              label={t('dashboard.assets')}
              amount={bs.totalAssets}
              currency={currency}
              onClick={() => onNavigate('assetsBreakdown')}
              dataUi={UI.dashboard.statAssets}
            />
            <StatButton
              label={t('dashboard.liabilities')}
              amount={bs.totalLiabilities}
              currency={currency}
              onClick={() => onNavigate('liabilitiesBreakdown')}
              dataUi={UI.dashboard.statLiabilities}
            />
            <StatButton
              label={t('dashboard.netAssets')}
              amount={bs.netAssets}
              currency={currency}
              signed
              onClick={() => onNavigate('netAssets')}
              dataUi={UI.dashboard.statNetAssets}
            />
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
            <ul
              ref={listRef}
              className="card list dashboard__entries"
              data-ui={UI.dashboard.journalPreview}
            >
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
            {/* 追加結果を読み上げる（ボタンが消える最終ページでは何も起きなかったように見えるため）。 */}
            <p className="sr-only" role="status" data-ui={UI.dashboard.journalCount}>
              {t('dashboard.shownCount', {
                shown: visibleEntries.length,
                total: periodEntries.length,
              })}
            </p>
            {remaining > 0 ? (
              // 末尾追記のみ（scrollTo を呼ばない = 既に表示中の行は動かない）。
              <Button variant="ghost" block dataUi={UI.dashboard.journalMore} onClick={showMore}>
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

/**
 * ホームの 6 枠。aria-label は子の金額を上書きするので、**名称・金額・操作の 3 つを含める**
 * （label だけだと読み上げから金額が消える。額縁として固定した主要情報なので必須）。
 * 表示と読み上げが食い違わないよう、金額は Money と同じ moneyText から作る。
 */
function StatButton({
  label,
  amount,
  currency,
  signed = false,
  onClick,
  dataUi,
}: {
  label: string;
  amount: number;
  currency: string;
  signed?: boolean;
  onClick: () => void;
  dataUi?: string;
}) {
  const digits = useMoneyDigits();
  return (
    <button
      type="button"
      className="stat stat--btn"
      onClick={onClick}
      aria-label={t('dashboard.statDetail', {
        label,
        amount: moneyText(amount, currency, digits, signed),
      })}
      data-ui={dataUi}
    >
      <span className="stat__label" aria-hidden="true">
        {label} <Icon name="chevronRight" size={12} />
      </span>
      <span className="stat__value" aria-hidden="true">
        <Money amount={amount} currency={currency} signed={signed} />
      </span>
    </button>
  );
}
