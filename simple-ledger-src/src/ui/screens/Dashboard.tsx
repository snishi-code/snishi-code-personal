/*
 * ホーム（初期表示）。日常入力の主導線（収入/支出/振替）、今月の損益・資産負債サマリー、
 * 生活コスト。最近の仕訳一覧は仕訳画面に集約し、ここには置かない。
 * 損益サマリー→PL / 資産負債サマリー→BS へ遷移できる。
 */
import { useMemo, type ReactNode } from 'react';
import { useLedger } from '../../state/store';
import { deriveBalanceSheet, deriveProfitAndLoss } from '../../domain/accounting';
import { totalMonthlyCostForMonth } from '../../domain/monthlyCost';
import {
  dataMonthsOf,
  dataYearsOf,
  periodAsOf,
  periodBuckets,
  periodLabel,
  periodRange,
  trendBuckets,
  type DateRange,
  type ReportPeriod,
} from '../../domain/reportPeriod';
import { todayLocal } from '../../util/time';
import { Money } from '../money';
import { Icon } from '../Icon';
import { EntryListItem } from '../EntryListItem';
import { TrendChart, type TrendPoint } from '../components/TrendChart';
import { t } from '../../i18n';
import { UI } from '../../ui-contract';
import type { Account, JournalEntry, MonthlyCostItem } from '../../domain/types';
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

/**
 * ある期間の「生活コスト」= 通常支出（費用 − 既存按分の認識 − 調整用費用 − 月額化の実支払い）
 * + 月額化コスト formula（区間内の各月を合算）。ホームの当期計算と同じ定義をトレンドに使う。
 */
function livingCostForRange(
  accounts: Account[],
  entries: JournalEntry[],
  items: MonthlyCostItem[],
  range: DateRange,
  months: string[],
): number {
  const roleById = new Map(accounts.map((a) => [a.id, a.role]));
  const expenseIds = new Set(accounts.filter((a) => a.type === 'expense').map((a) => a.id));
  const within = (e: JournalEntry) => e.date >= range.from && e.date <= range.to;
  let recognition = 0;
  let systemAdj = 0;
  let monthlyCostPaid = 0;
  for (const e of entries) {
    if (!within(e)) continue;
    const debit = e.lines.find((l) => l.side === 'debit');
    if (e.metadata?.allocationRole === 'recognition') recognition += debit?.amount ?? 0;
    if (debit && roleById.get(debit.accountId) === 'system-adjustment') systemAdj += debit.amount;
    if (e.metadata?.monthlyCostId && debit && expenseIds.has(debit.accountId))
      monthlyCostPaid += debit.amount;
  }
  const pl = deriveProfitAndLoss(accounts, entries, range);
  const monthlyCostSum = months.reduce((s, ym) => s + totalMonthlyCostForMonth(items, ym), 0);
  return pl.totalExpense - recognition - systemAdj - monthlyCostPaid + monthlyCostSum;
}

export function Dashboard({
  period,
  onPeriodChange,
  onAddEntry,
  onEditEntry,
  onNavigate,
  onOpenStatement,
  onOpenJournal,
}: {
  period: ReportPeriod;
  onPeriodChange: (p: ReportPeriod) => void;
  onAddEntry: (mode: FormMode) => void;
  onEditEntry: (entry: JournalEntry) => void;
  onNavigate: (screen: Screen) => void;
  onOpenStatement: (tab: 'pl' | 'bs', section?: string) => void;
  onOpenJournal: (filter: { from?: string; to?: string }) => void;
}) {
  const { ledger } = useLedger();
  const today = todayLocal();
  const range = periodRange(period); // フロー（PL/仕訳）。all は undefined。
  const inRange = (e: JournalEntry) => !range || (e.date >= range.from && e.date <= range.to);
  // 期間内の仕訳（日付降順。loadLedger で既にソート済み）の先頭 5 件。
  const periodEntries = (ledger?.journalEntries ?? []).filter(inRange).slice(0, 5);
  const label = periodLabel(period);

  const {
    pl,
    bs,
    asOf,
    monthlyCost,
    investmentValuation,
    recognition,
    systemAdjExpense,
    monthlyCostPaid,
  } = useMemo(() => {
    const accounts = ledger?.accounts ?? [];
    const entries = ledger?.journalEntries ?? [];
    const monthlyCostItems = ledger?.monthlyCostItems ?? [];
    // BS は期間末の基準日（ストック）。全体は最終データ日（無ければ今日）。
    const lastDataDate = entries.reduce((m, e) => (e.date > m ? e.date : m), '');
    const asOfDate = periodAsOf(period, today, lastDataDate);
    const within = (e: JournalEntry) => !range || (e.date >= range.from && e.date <= range.to);
    const roleById = new Map(accounts.map((a) => [a.id, a.role]));
    const expenseIds = new Set(accounts.filter((a) => a.type === 'expense').map((a) => a.id));
    // 既存按分の期間内の認識額（移行済み項目は formula で数えるため normalExpense から除く）。
    const recognitionAmt = entries
      .filter((e) => e.metadata?.allocationRole === 'recognition' && within(e))
      .reduce((s, e) => s + (e.lines.find((l) => l.side === 'debit')?.amount ?? 0), 0);
    // 期間内の調整用(system-adjustment)費用（残高調整費・投資評価損）。生活コストから除外する。
    let systemAdj = 0;
    let investmentLoss = 0;
    let investmentGain = 0;
    // 月額化コストの実支払い仕訳（monthlyCostId 付き）の期間内費用。生活コストでは formula 側で
    // 数えるため、ここで除外して二重計上を防ぐ。
    let monthlyCostPaid = 0;
    for (const e of entries) {
      if (!within(e)) continue;
      const debit = e.lines.find((l) => l.side === 'debit');
      const credit = e.lines.find((l) => l.side === 'credit');
      if (debit && roleById.get(debit.accountId) === 'system-adjustment') systemAdj += debit.amount;
      if (e.metadata?.monthlyCostId && debit && expenseIds.has(debit.accountId))
        monthlyCostPaid += debit.amount;
      if (e.metadata?.adjustment?.kind === 'investment-valuation') {
        if (debit && expenseIds.has(debit.accountId)) investmentLoss += debit.amount;
        else if (credit) investmentGain += credit.amount; // 評価益は revenue 貸方
      }
    }
    // 月額化コスト = MonthlyCostItem の formula。期間内の各月を合算する。
    const months = periodBuckets(period, { dataMonths: dataMonthsOf(entries.map((e) => e.date)) });
    const monthlyCostSum = months.reduce(
      (s, b) => s + totalMonthlyCostForMonth(monthlyCostItems, b.ym),
      0,
    );
    return {
      pl: deriveProfitAndLoss(accounts, entries, range),
      bs: deriveBalanceSheet(accounts, entries, asOfDate),
      asOf: asOfDate,
      monthlyCost: monthlyCostSum,
      investmentValuation: { loss: investmentLoss, gain: investmentGain },
      recognition: recognitionAmt,
      systemAdjExpense: systemAdj,
      monthlyCostPaid,
    };
  }, [ledger, period, range, today]);

  // 推移（年別=12ヶ月 / 全体=年集約）。グラフで俯瞰する（縦長リストにしない）。
  // フロー=各区間の収支・生活コスト、ストック=各区間末の純資産。
  const trend = useMemo(() => {
    if (period.mode === 'month') return null;
    const accounts = ledger?.accounts ?? [];
    const entries = ledger?.journalEntries ?? [];
    const items = ledger?.monthlyCostItems ?? [];
    const buckets = trendBuckets(period, { dataYears: dataYearsOf(entries.map((e) => e.date)) });
    if (buckets.length === 0) return null;
    const net: TrendPoint[] = [];
    const living: TrendPoint[] = [];
    const assets: TrendPoint[] = [];
    for (const b of buckets) {
      // 年集約バケットは 12 ヶ月、月バケットは 1 ヶ月ぶんの月額化コストを数える。
      const months =
        b.key.length === 4
          ? Array.from({ length: 12 }, (_, i) => `${b.year}-${String(i + 1).padStart(2, '0')}`)
          : [b.key];
      net.push({
        key: b.key,
        label: b.label,
        value: deriveProfitAndLoss(accounts, entries, b.range).netIncome,
      });
      living.push({
        key: b.key,
        label: b.label,
        value: livingCostForRange(accounts, entries, items, b.range, months),
      });
      assets.push({
        key: b.key,
        label: b.label,
        value: deriveBalanceSheet(accounts, entries, b.asOf).netAssets,
      });
    }
    return { net, living, assets };
  }, [ledger, period]);

  const currency = ledger?.settings.currency ?? 'JPY';
  // 通常支出 = 今月の費用 − 既存按分の認識 − 調整用費用 − 月額化の実支払い
  // （月額化は formula で別途足すため二重計上しない）。
  const normalExpense = pl.totalExpense - recognition - systemAdjExpense - monthlyCostPaid;

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

      {/* 期間の収支（各項目から損益計算書の該当セクションへ） */}
      <p className="section-label">{t('dashboard.flowOf', { label })}</p>
      <div className="stat-grid">
        <StatButton
          label={t('dashboard.revenue')}
          onClick={() => onOpenStatement('pl', 'revenue')}
          dataUi={UI.dashboard.statRevenue}
        >
          <Money amount={pl.totalRevenue} currency={currency} />
        </StatButton>
        <StatButton
          label={t('dashboard.expense')}
          onClick={() => onOpenStatement('pl', 'expense')}
          dataUi={UI.dashboard.statExpense}
        >
          <Money amount={pl.totalExpense} currency={currency} />
        </StatButton>
        <StatButton
          label={t('dashboard.netIncome')}
          onClick={() => onOpenStatement('pl', 'net')}
          dataUi={UI.dashboard.statNetIncome}
        >
          <Money amount={pl.netIncome} currency={currency} signed />
        </StatButton>
      </div>

      {/* 財政状態（期間末時点。各項目から貸借対照表の該当セクションへ） */}
      <p className="section-label">{t('dashboard.positionAsOf', { date: asOf })}</p>
      <div className="stat-grid">
        <StatButton
          label={t('dashboard.assets')}
          onClick={() => onOpenStatement('bs', 'assets')}
          dataUi={UI.dashboard.statAssets}
        >
          <Money amount={bs.totalAssets} currency={currency} />
        </StatButton>
        <StatButton
          label={t('dashboard.liabilities')}
          onClick={() => onOpenStatement('bs', 'liabilities')}
          dataUi={UI.dashboard.statLiabilities}
        >
          <Money amount={bs.totalLiabilities} currency={currency} />
        </StatButton>
        <StatButton
          label={t('dashboard.netAssets')}
          onClick={() => onOpenStatement('bs', 'equity')}
          dataUi={UI.dashboard.statNetAssets}
        >
          <Money amount={bs.netAssets} currency={currency} signed />
        </StatButton>
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
            {...(period.mode === 'all'
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
            data={trend.assets}
            currency={currency}
            variant="line"
          />
          {period.mode === 'all' ? (
            <p className="field__hint">{t('period.trendYearHint')}</p>
          ) : null}
        </div>
      ) : null}

      {/* 生活コスト（収支/財政状態と同じ stat-grid。月額化コストは月額化コスト画面へ。CF とは別概念） */}
      <p className="section-label">{t('dashboard.livingCostOf', { label })}</p>
      <div className="stat-grid">
        <StatButton
          label={t('dashboard.normalExpense')}
          onClick={() => onOpenStatement('pl', 'expense')}
          dataUi={UI.dashboard.statNormalExpense}
        >
          <Money amount={normalExpense} currency={currency} />
        </StatButton>
        <StatButton
          label={t('dashboard.monthlyCost')}
          onClick={() => onNavigate('allocations')}
          dataUi={UI.dashboard.openMonthlyCost}
        >
          <Money amount={monthlyCost} currency={currency} />
        </StatButton>
        <StatButton
          label={t('dashboard.livingCostTotal')}
          onClick={() => onNavigate('allocations')}
          dataUi={UI.dashboard.statLivingCostTotal}
        >
          <Money amount={normalExpense + monthlyCost} currency={currency} />
        </StatButton>
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
