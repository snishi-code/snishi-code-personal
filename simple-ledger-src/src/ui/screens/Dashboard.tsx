/*
 * ホーム（初期表示）。日常入力の主導線（収入/支出/振替）、今月の損益・資産負債サマリー、
 * 生活コスト。最近の仕訳一覧は仕訳画面に集約し、ここには置かない。
 * 損益サマリー→PL / 資産負債サマリー→BS へ遷移できる。
 */
import { useMemo, type ReactNode } from 'react';
import { useLedger } from '../../state/store';
import { deriveBalanceSheet, deriveProfitAndLoss, monthRange } from '../../domain/accounting';
import { totalMonthlyCostForMonth } from '../../domain/monthlyCost';
import { currentYearMonth, todayLocal } from '../../util/time';
import { Money } from '../money';
import { Icon } from '../Icon';
import { EntryListItem } from '../EntryListItem';
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
  onAddEntry,
  onEditEntry,
  onNavigate,
  onOpenStatement,
  onOpenJournal,
}: {
  onAddEntry: (mode: FormMode) => void;
  onEditEntry: (entry: JournalEntry) => void;
  onNavigate: (screen: Screen) => void;
  onOpenStatement: (tab: 'pl' | 'bs', section?: string) => void;
  onOpenJournal: (filter: { from?: string; to?: string }) => void;
}) {
  const { ledger } = useLedger();
  const { year, month } = currentYearMonth();
  const monthRangeValue = monthRange(year, month);
  // 当月の仕訳（日付降順。loadLedger で既にソート済み）の先頭 5 件。
  const monthEntries = (ledger?.journalEntries ?? [])
    .filter((e) => e.date >= monthRangeValue.from && e.date <= monthRangeValue.to)
    .slice(0, 5);

  const {
    pl,
    bs,
    monthlyCost,
    investmentValuation,
    recognition,
    systemAdjExpense,
    monthlyCostPaid,
    activeCount,
  } = useMemo(() => {
    const accounts = ledger?.accounts ?? [];
    const entries = ledger?.journalEntries ?? [];
    const monthlyCostItems = ledger?.monthlyCostItems ?? [];
    const range = monthRange(year, month);
    const currentYm = `${year}-${String(month).padStart(2, '0')}`;
    const inMonth = (e: JournalEntry) => e.date >= range.from && e.date <= range.to;
    const roleById = new Map(accounts.map((a) => [a.id, a.role]));
    const expenseIds = new Set(accounts.filter((a) => a.type === 'expense').map((a) => a.id));
    // 既存按分の今月の認識額（移行済み項目は formula で数えるため normalExpense から除く）。
    const recognitionAmt = entries
      .filter((e) => e.metadata?.allocationRole === 'recognition' && inMonth(e))
      .reduce((s, e) => s + (e.lines.find((l) => l.side === 'debit')?.amount ?? 0), 0);
    // 今月の調整用(system-adjustment)費用（残高調整費・投資評価損）。生活コストから除外する。
    let systemAdj = 0;
    let investmentLoss = 0;
    let investmentGain = 0;
    // 月額化コストの実支払い仕訳（monthlyCostId 付き）の今月の費用。生活コストでは formula 側で
    // 数えるため、ここで除外して二重計上を防ぐ。
    let monthlyCostPaid = 0;
    for (const e of entries) {
      if (!inMonth(e)) continue;
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
    return {
      pl: deriveProfitAndLoss(accounts, entries, range),
      bs: deriveBalanceSheet(accounts, entries, todayLocal()),
      // 月額化コスト = MonthlyCostItem の formula（仕訳ではなく登録簿から導出）。
      monthlyCost: totalMonthlyCostForMonth(monthlyCostItems, currentYm),
      investmentValuation: { loss: investmentLoss, gain: investmentGain },
      recognition: recognitionAmt,
      systemAdjExpense: systemAdj,
      monthlyCostPaid,
      activeCount: monthlyCostItems.filter((m) => m.status === 'active').length,
    };
  }, [ledger, year, month]);

  const currency = ledger?.settings.currency ?? 'JPY';
  const hasEntries = (ledger?.journalEntries.length ?? 0) > 0;
  // 通常支出 = 今月の費用 − 既存按分の認識 − 調整用費用 − 月額化の実支払い
  // （月額化は formula で別途足すため二重計上しない）。
  const normalExpense = pl.totalExpense - recognition - systemAdjExpense - monthlyCostPaid;

  return (
    <section aria-labelledby="dashboard-title" data-ui={UI.dashboard.view}>
      <h1 className="screen-title" id="dashboard-title" aria-label={t('dashboard.title')}>
        {t('header.yearMonth', { year, month })}
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

      {/* 今月の損益（各項目から損益計算書の該当セクションへ） */}
      <p className="section-label">{t('dashboard.thisMonth', { year, month })}</p>
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

      {/* 財政状態（各項目から貸借対照表の該当セクションへ） */}
      <p className="section-label">{t('dashboard.position')}</p>
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

      {/* 生活コスト（領域全体が資金繰り/資金計画への導線） */}
      <p className="section-label">{t('dashboard.livingCost')}</p>
      <button
        type="button"
        className="summary-card"
        onClick={() => onNavigate('cashflow')}
        aria-label={t('dashboard.openCashflow')}
        data-ui={UI.dashboard.openCashflow}
      >
        <div className="summary-card__head">
          <span className="muted" style={{ fontSize: 13 }}>
            {t('dashboard.activeMonthlyCosts', { count: activeCount })}
          </span>
          <Icon name="chevronRight" size={16} />
        </div>
        <div className="stat-grid">
          <div className="stat">
            <span className="stat__label">{t('dashboard.normalExpense')}</span>
            <span className="stat__value">
              <Money amount={normalExpense} currency={currency} />
            </span>
          </div>
          <div className="stat">
            <span className="stat__label">{t('dashboard.monthlyCost')}</span>
            <span className="stat__value">
              <Money amount={monthlyCost} currency={currency} />
            </span>
          </div>
          <div className="stat">
            <span className="stat__label">{t('dashboard.livingCostTotal')}</span>
            <span className="stat__value">
              <Money amount={normalExpense + monthlyCost} currency={currency} />
            </span>
          </div>
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
      </button>

      {/* 当月の仕訳（下部・スクロールで見える）。詳細は仕訳画面へ。 */}
      <div
        className="section-label"
        style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}
      >
        <span>{t('dashboard.thisMonthEntries')}</span>
        {monthEntries.length > 0 ? (
          <button
            type="button"
            className="btn btn--ghost"
            style={{ minHeight: 32 }}
            onClick={() => onOpenJournal({ from: monthRangeValue.from, to: monthRangeValue.to })}
            data-ui={UI.dashboard.journalOpenAll}
          >
            {t('dashboard.viewAll')}
            <Icon name="chevronRight" size={16} />
          </button>
        ) : null}
      </div>
      {monthEntries.length === 0 ? (
        <div className="card card--pad muted">{t('dashboard.noMonthEntries')}</div>
      ) : (
        <ul className="card list" data-ui={UI.dashboard.journalPreview}>
          {monthEntries.map((entry) => {
            // 生成仕訳（按分/月額化）は編集不可なので、タップは仕訳画面へ。
            const generated = !!(entry.metadata?.allocationId || entry.metadata?.monthlyCostId);
            return (
              <EntryListItem
                key={entry.id}
                entry={entry}
                accounts={ledger?.accounts ?? []}
                currency={currency}
                onClick={() =>
                  generated
                    ? onOpenJournal({ from: monthRangeValue.from, to: monthRangeValue.to })
                    : onEditEntry(entry)
                }
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
