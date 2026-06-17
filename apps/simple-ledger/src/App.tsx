/*
 * アプリ本体。foundation の AppHeader + Menu を使用。
 * updateReady バナーは削除（凍結 SW ポリシー）。
 * AppHeader center スロットに期間コンテキストを注入。
 */
import { useState } from 'react';
import { AppHeader } from '@snishi/foundation/ui/AppHeader';
import { Menu, type MenuItem } from '@snishi/foundation/ui/Menu';
import { Icon } from '@snishi/foundation/ui/Icon';
import { EnvBadge } from '@snishi/foundation/pwa/EnvBadge';
import { useLedger } from './state/store';
import { Dashboard } from './ui/screens/Dashboard';
import { Breakdown } from './ui/screens/Breakdown';
import { ExpenseBreakdown } from './ui/screens/ExpenseBreakdown';
import { NetIncome } from './ui/screens/NetIncome';
import { Journal, type JournalFilter } from './ui/screens/Journal';
import { Allocations } from './ui/screens/Allocations';
import { Cashflow } from './ui/screens/Cashflow';
import { Tags } from './ui/screens/Tags';
import { Accounts } from './ui/screens/Accounts';
import { Wallets } from './ui/screens/Wallets';
import { Settings } from './ui/screens/Settings';
import { Help } from './ui/screens/Help';
import { EntrySheet, type EntryInit } from './ui/screens/EntrySheet';
import { PeriodYearPicker, PeriodMonthPicker } from './ui/PeriodPickers';
import { NAV_ITEMS } from './ui/navigation';
import { t } from './i18n';
import { currentYearMonth, todayLocal } from './util/time';
import { availableYears, type ReportPeriod } from './domain/reportPeriod';
import { UI } from './ui-contract';
import type { Screen } from './ui/navigation';
import type { FormMode } from './ui/entryModes';
import type { JournalEntry } from './domain/types';

export function App() {
  const { status, ledger, error } = useLedger();
  const [screen, setScreen] = useState<Screen>('dashboard');
  const [menuOpen, setMenuOpen] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const [entryInit, setEntryInit] = useState<EntryInit | null>(null);
  const [journalFilter, setJournalFilter] = useState<JournalFilter | null>(null);
  const [picker, setPicker] = useState<'year' | 'month' | null>(null);
  const [period, setPeriod] = useState<ReportPeriod>(() => {
    const { year, month } = currentYearMonth();
    return { mode: 'month', year, month };
  });

  if (status === 'loading') {
    return (
      <main className="app-main center" aria-busy="true">
        <p className="muted">{t('common.loading')}</p>
      </main>
    );
  }

  if (status === 'error' || !ledger) {
    return (
      <main className="app-main">
        <div className="banner" role="alert">
          <Icon name="alert" size={18} />
          {error ?? t('toast.error')}
        </div>
      </main>
    );
  }

  const openCreate = (mode: FormMode) => setEntryInit({ kind: 'create', mode });
  const openEdit = (entry: JournalEntry) => setEntryInit({ kind: 'edit', entry });
  const openReversal = (source: JournalEntry) => setEntryInit({ kind: 'reversal', source });

  const goJournalFiltered = (filter: JournalFilter) => {
    setJournalFilter(filter);
    setScreen('journal');
  };

  const today = todayLocal();
  const periodYears = availableYears(
    [
      ...ledger.journalEntries.map((e) => e.date),
      ...ledger.cashflowSchedules.map((s) => s.dueDate),
    ],
    Number.parseInt(today.slice(0, 4), 10),
    period.mode !== 'all' ? period.year : undefined,
  );

  // --- メニュー items ビルド ---
  const menuItems: MenuItem[] = [
    ...NAV_ITEMS.map((item) => ({
      key: item.screen,
      label: t(item.labelKey),
      icon: item.icon,
      current: screen === item.screen,
      onSelect: () => setScreen(item.screen),
      dataUi: `nav.${item.screen}`,
    })),
    {
      key: 'help',
      label: t('nav.help'),
      icon: 'help' as const,
      onSelect: () => setHelpOpen(true),
    },
  ];

  // --- ヘッダー中央の期間コンテキスト ---
  const yearAriaLabel =
    period.mode === 'all' ? t('period.allPeriod') : t('period.yearUnit', { year: period.year });
  const monthAriaLabel =
    period.mode === 'month' ? t('period.monthUnit', { month: period.month }) : t('period.fullYear');
  const yearDisplay = period.mode === 'all' ? t('period.allPeriod') : String(period.year);
  const monthDisplay = period.mode === 'month' ? String(period.month) : t('period.fullYearShort');

  const periodCenter = (
    <div className="period-context">
      <button
        type="button"
        className="period-context__chip"
        onClick={() => setPicker('year')}
        aria-haspopup="dialog"
        aria-label={`${yearAriaLabel} — ${t('period.openYear')}`}
        data-ui={UI.period.yearTrigger}
      >
        <span className="period-context__text">{yearDisplay}</span>
        <Icon name="expand" size={14} />
      </button>
      {period.mode !== 'all' ? (
        <>
          <span className="period-context__sep" aria-hidden="true">
            /
          </span>
          <button
            type="button"
            className="period-context__chip"
            onClick={() => setPicker('month')}
            aria-haspopup="dialog"
            aria-label={`${monthAriaLabel} — ${t('period.openMonth')}`}
            data-ui={UI.period.monthTrigger}
          >
            <span className="period-context__text">{monthDisplay}</span>
            <Icon name="expand" size={14} />
          </button>
        </>
      ) : null}
    </div>
  );

  return (
    <>
      <a className="skip-link" href="#main">
        {t('common.home')}
      </a>

      <AppHeader
        left={
          <button
            type="button"
            className="icon-btn"
            onClick={() => setScreen('dashboard')}
            aria-label={t('header.home')}
            data-ui={UI.nav.home}
          >
            <Icon name="home" />
          </button>
        }
        center={periodCenter}
        right={
          <>
            <EnvBadge />
            <button
              type="button"
              className="icon-btn"
              onClick={() => setMenuOpen(true)}
              aria-label={t('a11y.openMenu')}
              aria-haspopup="menu"
              data-ui={UI.nav.menuButton}
            >
              <Icon name="menu" />
            </button>
          </>
        }
      />

      {picker === 'year' ? (
        <PeriodYearPicker
          period={period}
          years={periodYears}
          onChange={setPeriod}
          onClose={() => setPicker(null)}
        />
      ) : null}
      {picker === 'month' ? (
        <PeriodMonthPicker
          period={period}
          today={today}
          onChange={setPeriod}
          onClose={() => setPicker(null)}
        />
      ) : null}

      <main className="app-main" id="main">
        {screen === 'dashboard' ? (
          <Dashboard
            period={period}
            onPeriodChange={setPeriod}
            onAddEntry={openCreate}
            onEditEntry={openEdit}
            onNavigate={setScreen}
            onOpenJournal={goJournalFiltered}
          />
        ) : null}
        {screen === 'incomeBreakdown' ? (
          <Breakdown
            section="revenue"
            period={period}
            onPeriodChange={setPeriod}
            onDrillDown={goJournalFiltered}
            onNavigate={setScreen}
          />
        ) : null}
        {screen === 'expenseBreakdown' ? (
          <ExpenseBreakdown period={period} onPeriodChange={setPeriod} onNavigate={setScreen} />
        ) : null}
        {screen === 'netIncome' ? (
          <NetIncome period={period} onPeriodChange={setPeriod} onNavigate={setScreen} />
        ) : null}
        {screen === 'assetsBreakdown' ? (
          <Breakdown
            section="asset"
            period={period}
            onPeriodChange={setPeriod}
            onDrillDown={goJournalFiltered}
            onNavigate={setScreen}
          />
        ) : null}
        {screen === 'liabilitiesBreakdown' ? (
          <Breakdown
            section="liability"
            period={period}
            onPeriodChange={setPeriod}
            onDrillDown={goJournalFiltered}
            onNavigate={setScreen}
          />
        ) : null}
        {screen === 'netAssets' ? (
          <Breakdown
            section="equity"
            period={period}
            onPeriodChange={setPeriod}
            onDrillDown={goJournalFiltered}
            onNavigate={setScreen}
          />
        ) : null}
        {screen === 'journal' ? (
          <Journal
            onEditEntry={openEdit}
            onReverse={openReversal}
            filter={journalFilter}
            period={period}
            onClearAccountFilter={() => setJournalFilter(null)}
          />
        ) : null}
        {screen === 'allocations' ? <Allocations /> : null}
        {screen === 'cashflow' ? <Cashflow /> : null}
        {screen === 'tags' ? <Tags /> : null}
        {screen === 'accounts' ? <Accounts /> : null}
        {screen === 'wallets' ? <Wallets /> : null}
        {screen === 'settings' ? <Settings onNavigate={setScreen} /> : null}
      </main>

      {menuOpen ? (
        <Menu
          items={menuItems}
          onClose={() => setMenuOpen(false)}
          title={t('common.menu')}
          dataUi={UI.nav.menu}
        />
      ) : null}

      {entryInit ? <EntrySheet init={entryInit} onClose={() => setEntryInit(null)} /> : null}

      {helpOpen ? <Help onClose={() => setHelpOpen(false)} /> : null}
    </>
  );
}
