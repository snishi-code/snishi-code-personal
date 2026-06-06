/*
 * ホーム（初期表示）。日常入力の主導線（収入/支出/振替）、今月の損益・資産負債サマリー、
 * 生活コスト。最近の仕訳一覧は仕訳画面に集約し、ここには置かない。
 * 損益サマリー→PL / 資産負債サマリー→BS へ遷移できる。
 */
import { useMemo } from 'react';
import { useLedger } from '../../state/store';
import { deriveBalanceSheet, deriveProfitAndLoss, monthRange } from '../../domain/accounting';
import { isCompleted } from '../../domain/allocation';
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

  const { pl, bs, recognition, investmentValuation, activeCount } = useMemo(() => {
    const accounts = ledger?.accounts ?? [];
    const entries = ledger?.journalEntries ?? [];
    const range = monthRange(year, month);
    const currentYm = `${year}-${String(month).padStart(2, '0')}`;
    const inMonth = (e: JournalEntry) => e.date >= range.from && e.date <= range.to;
    const expenseIds = new Set(accounts.filter((a) => a.type === 'expense').map((a) => a.id));
    // 今月の按分認識額（recognition 仕訳の費用＝借方額）。
    const recognitionAmt = entries
      .filter((e) => e.metadata?.allocationRole === 'recognition' && inMonth(e))
      .reduce((s, e) => s + (e.lines.find((l) => l.side === 'debit')?.amount ?? 0), 0);
    // 今月の投資評価損益（生活コストから除外する）。費用側=損、収益側=益。
    let investmentLoss = 0;
    let investmentGain = 0;
    for (const e of entries) {
      if (e.metadata?.adjustment?.kind !== 'investment-valuation' || !inMonth(e)) continue;
      const debit = e.lines.find((l) => l.side === 'debit');
      const credit = e.lines.find((l) => l.side === 'credit');
      if (debit && expenseIds.has(debit.accountId)) investmentLoss += debit.amount;
      else if (credit) investmentGain += credit.amount; // 評価益は revenue 貸方
    }
    return {
      pl: deriveProfitAndLoss(accounts, entries, range),
      bs: deriveBalanceSheet(accounts, entries, todayLocal()),
      recognition: recognitionAmt,
      investmentValuation: { loss: investmentLoss, gain: investmentGain },
      activeCount: (ledger?.allocations ?? []).filter((a) => !isCompleted(a, currentYm)).length,
    };
  }, [ledger, year, month]);

  const currency = ledger?.settings.currency ?? 'JPY';
  const hasEntries = (ledger?.journalEntries.length ?? 0) > 0;
  // 生活コストの費用から、按分認識と投資評価損を除いた「通常費用」。
  const normalExpense = pl.totalExpense - recognition - investmentValuation.loss;

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
          <span className="stat__label">{t('dashboard.allocatedExpense')}</span>
          <span className="stat__value">
            <Money amount={recognition} currency={currency} />
          </span>
        </div>
        <div className="stat">
          <span className="stat__label">{t('dashboard.livingCostTotal')}</span>
          <span className="stat__value">
            <Money amount={normalExpense + recognition} currency={currency} />
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
        <span>{t('dashboard.activeAllocations', { count: activeCount })}</span>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
          {t('dashboard.viewAllocations')}
          <Icon name="chevronRight" size={16} />
        </span>
      </button>
    </section>
  );
}
