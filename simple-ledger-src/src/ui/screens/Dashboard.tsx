/*
 * ホーム（初期表示）。日常入力の主導線（収入/支出/振替）、今月の損益・資産負債サマリー、
 * 生活コスト。最近の仕訳一覧は仕訳画面に集約し、ここには置かない。
 * 損益サマリー→PL / 資産負債サマリー→BS へ遷移できる。
 */
import { useMemo } from 'react';
import { useLedger } from '../../state/store';
import { deriveBalanceSheet, deriveProfitAndLoss, monthRange } from '../../domain/accounting';
import { totalMonthlyCostForMonth } from '../../domain/monthlyCost';
import { currentYearMonth, todayLocal } from '../../util/time';
import { Money } from '../money';
import { Icon } from '../Icon';
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
  onNavigate,
  onOpenStatement,
}: {
  onAddEntry: (mode: FormMode) => void;
  onNavigate: (screen: Screen) => void;
  onOpenStatement: (tab: 'pl' | 'bs') => void;
}) {
  const { ledger } = useLedger();
  const { year, month } = currentYearMonth();

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
      <h1 className="screen-title" id="dashboard-title">
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

      {!hasEntries ? (
        <div className="card card--pad empty">
          <Icon name="sprout" size={32} />
          <p style={{ marginTop: 'var(--space-3)' }}>{t('dashboard.noEntries')}</p>
        </div>
      ) : null}

      {/* 今月の損益（クリックで損益計算書へ） */}
      <button
        type="button"
        className="summary-card"
        onClick={() => onOpenStatement('pl')}
        aria-label={t('dashboard.openPl')}
        data-ui={UI.dashboard.openPl}
      >
        <div className="summary-card__head">
          <span className="section-label" style={{ margin: 0 }}>
            {t('dashboard.thisMonth', { year, month })}
          </span>
          <Icon name="chevronRight" size={16} />
        </div>
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
      </button>

      {/* 資産と負債（クリックで貸借対照表へ） */}
      <button
        type="button"
        className="summary-card"
        onClick={() => onOpenStatement('bs')}
        aria-label={t('dashboard.openBs')}
        data-ui={UI.dashboard.openBs}
      >
        <div className="summary-card__head">
          <span className="section-label" style={{ margin: 0 }}>
            {t('dashboard.position')}
          </span>
          <Icon name="chevronRight" size={16} />
        </div>
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
      </button>

      <p className="section-label">{t('dashboard.livingCost')}</p>
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
      <button
        type="button"
        className="btn btn--ghost btn--block"
        style={{ marginTop: 'var(--space-2)', justifyContent: 'space-between' }}
        onClick={() => onNavigate('allocations')}
      >
        <span>{t('dashboard.activeMonthlyCosts', { count: activeCount })}</span>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
          {t('dashboard.viewMonthlyCosts')}
          <Icon name="chevronRight" size={16} />
        </span>
      </button>
    </section>
  );
}
