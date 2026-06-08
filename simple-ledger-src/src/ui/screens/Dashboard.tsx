/*
 * ホーム（初期表示）。日常入力の主導線（収入/支出/振替）、期間の収支・財政状態サマリー、推移。
 * 最近の仕訳一覧は仕訳画面に集約し、ここには置かない。
 * 各項目（収入/支出/収支/資産/負債/純資産）をタップすると、その項目の「内訳 + 推移」ページへ遷移する。
 */
import { useMemo, type ReactNode } from 'react';
import { useLedger } from '../../state/store';
import { deriveBalanceSheet, deriveProfitAndLoss } from '../../domain/accounting';
import { livingCostBreakdownForRange } from '../../domain/livingCost';
import {
  dataMonthsOf,
  periodAsOf,
  periodBuckets,
  periodLabel,
  periodRange,
  type ReportPeriod,
} from '../../domain/reportPeriod';
import { todayLocal } from '../../util/time';
import { buildSectionTrends } from './breakdownData';
import { Money } from '../money';
import { Icon } from '../Icon';
import { EntryListItem } from '../EntryListItem';
import { TrendChart } from '../components/TrendChart';
import { t } from '../../i18n';
import { UI } from '../../ui-contract';
import type { JournalEntry } from '../../domain/types';
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
  const range = periodRange(period); // フロー（PL/仕訳）。all は undefined。
  const inRange = (e: JournalEntry) => !range || (e.date >= range.from && e.date <= range.to);
  // 期間内の仕訳（日付降順。loadLedger で既にソート済み）の先頭 5 件。
  const periodEntries = (ledger?.journalEntries ?? []).filter(inRange).slice(0, 5);
  const label = periodLabel(period);

  const { pl, bs, asOf, monthlyCost, normalExpense, investmentValuation } = useMemo(() => {
    const accounts = ledger?.accounts ?? [];
    const entries = ledger?.journalEntries ?? [];
    const monthlyCostItems = ledger?.monthlyCostItems ?? [];
    // BS は期間末の基準日（ストック）。全体は最終データ日（無ければ今日）。
    const lastDataDate = entries.reduce((m, e) => (e.date > m ? e.date : m), '');
    const asOfDate = periodAsOf(period, today, lastDataDate);
    const within = (e: JournalEntry) => !range || (e.date >= range.from && e.date <= range.to);
    const expenseIds = new Set(accounts.filter((a) => a.type === 'expense').map((a) => a.id));
    // 投資の評価損益（生活コストとは別の補助情報）。
    let investmentLoss = 0;
    let investmentGain = 0;
    for (const e of entries) {
      if (!within(e)) continue;
      if (e.metadata?.adjustment?.kind !== 'investment-valuation') continue;
      const debit = e.lines.find((l) => l.side === 'debit');
      const credit = e.lines.find((l) => l.side === 'credit');
      if (debit && expenseIds.has(debit.accountId)) investmentLoss += debit.amount;
      else if (credit) investmentGain += credit.amount; // 評価益は revenue 貸方
    }
    // 支出（生活コスト）= 通常支出 + 月額化。支出の内訳画面・推移と同じ正本ヘルパを使う。
    const months = periodBuckets(period, { dataMonths: dataMonthsOf(entries.map((e) => e.date)) });
    const breakdown = livingCostBreakdownForRange(
      accounts,
      entries,
      monthlyCostItems,
      range,
      months.map((b) => b.ym),
    );
    return {
      pl: deriveProfitAndLoss(accounts, entries, range),
      bs: deriveBalanceSheet(accounts, entries, asOfDate),
      asOf: asOfDate,
      monthlyCost: breakdown.monthlyCost,
      normalExpense: breakdown.normalExpense,
      investmentValuation: { loss: investmentLoss, gain: investmentGain },
    };
  }, [ledger, period, range, today]);

  // 推移（年別=12ヶ月 / 全体=年集約）。グラフで俯瞰する（縦長リストにしない）。
  // 推移シリーズは内訳ページと同じ正本（buildSectionTrends）から取り、数字をズラさない。
  // ホームでは 収支（=収入−生活コスト）/ 生活コスト / 純資産 の 3 本を見せる。
  const trend = useMemo(() => buildSectionTrends(period, ledger), [period, ledger]);

  const currency = ledger?.settings.currency ?? 'JPY';

  return (
    <section aria-labelledby="dashboard-title" data-ui={UI.dashboard.view}>
      <h1 className="sr-only" id="dashboard-title">
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

      {/* 期間の切替はヘッダー中央の期間ボタンから（正本）。ここでは結果だけを見せる。 */}

      {/* 期間の収支（各項目から、その項目の「内訳 + 推移」ページへ） */}
      <p className="section-label">{t('dashboard.flowOf', { label })}</p>
      <div className="stat-grid">
        <StatButton
          label={t('dashboard.revenue')}
          onClick={() => onNavigate('incomeBreakdown')}
          dataUi={UI.dashboard.statRevenue}
        >
          <Money amount={pl.totalRevenue} currency={currency} />
        </StatButton>
        {/* 「支出」= 生活コスト（通常支出 + 月額化）。購入額そのもの・返済・振替は支出に含めない
            （購入は資産取得、償却分の費用＝月額化として計上）。タップで「支出の内訳」へ。 */}
        <StatButton
          label={t('dashboard.expense')}
          onClick={() => onNavigate('expenseBreakdown')}
          dataUi={UI.dashboard.statExpense}
        >
          <Money amount={normalExpense + monthlyCost} currency={currency} />
        </StatButton>
        {/* 収支 = 収入 − 支出（生活コスト）の生活余剰。タップで「収支」ページ（月ごとの残り方）へ。 */}
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

      {/* 財政状態（期間末時点。各項目から、その項目の「内訳 + 推移」ページへ） */}
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
        {/* 投資の評価損益は財政状態の補助情報としてここに置く（旧・生活コストセクションから移設）。 */}
        {investmentValuation.loss > 0 || investmentValuation.gain > 0 ? (
          <div className="stat">
            <span className="stat__label">{t('dashboard.investmentValuation')}</span>
            <span className="stat__value">
              <Money
                amount={investmentValuation.gain - investmentValuation.loss}
                currency={currency}
                signed
              />
            </span>
          </div>
        ) : null}
      </div>

      {/* 推移（年別=12ヶ月 / 全体=年集約）。SVG グラフで俯瞰。全体は年ラベルをタップで年別へ。 */}
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

      {/* 生活コストはホーム独立セクションにしない（上段の「支出」= 通常支出 + 月額化 がその値）。
          内訳の月額化は月額化コスト画面（支出カードのタップ先）、通常支出は損益計算書で見る。 */}

      {/* 期間内の仕訳（下部・スクロールで見える）。詳細は仕訳画面へ。 */}
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
            onClick={() => onOpenJournal(range ?? {})}
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
            // 生成仕訳（按分/月額化）は編集不可なので、タップは仕訳画面へ。
            const generated = !!(entry.metadata?.allocationId || entry.metadata?.monthlyCostId);
            return (
              <EntryListItem
                key={entry.id}
                entry={entry}
                accounts={ledger?.accounts ?? []}
                currency={currency}
                onClick={() => (generated ? onOpenJournal(range ?? {}) : onEditEntry(entry))}
              />
            );
          })}
        </ul>
      )}
    </section>
  );
}

/** タップで遷移する stat。見た目はカード、role はボタン。 */
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
