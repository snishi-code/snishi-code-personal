/*
 * アプリ本体。ヘッダー + 画面切替 + メニュー + 入力シート + 更新バナー。
 * ルーティングは MVP では state ベースの単純な画面切替。
 */
import { useState } from 'react';
import { useLedger } from './state/store';
import { Header } from './ui/Header';
import { Menu } from './ui/Menu';
import { Dashboard } from './ui/screens/Dashboard';
import { Breakdown } from './ui/screens/Breakdown';
import { ExpenseBreakdown } from './ui/screens/ExpenseBreakdown';
import { NetIncome } from './ui/screens/NetIncome';
import { Journal, type JournalFilter } from './ui/screens/Journal';
import { Allocations } from './ui/screens/Allocations';
import { Cashflow } from './ui/screens/Cashflow';
import { Tags } from './ui/screens/Tags';
import { Adjustments } from './ui/screens/Adjustments';
import { Accounts } from './ui/screens/Accounts';
import { Wallets } from './ui/screens/Wallets';
import { Settings } from './ui/screens/Settings';
import { Help } from './ui/screens/Help';
import { EntrySheet, type EntryInit } from './ui/screens/EntrySheet';
import { useServiceWorker } from './pwa/useServiceWorker';
import { Icon } from './ui/Icon';
import { t } from './i18n';
import { currentYearMonth, todayLocal } from './util/time';
import { availableYears, type ReportPeriod } from './domain/reportPeriod';
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
  // レポート期間（ホーム/各内訳ページ/仕訳で共有）。正本はヘッダー中央の期間メニュー。既定は今月。
  const [period, setPeriod] = useState<ReportPeriod>(() => {
    const { year, month } = currentYearMonth();
    return { mode: 'month', year, month };
  });
  const { updateReady, applyUpdate } = useServiceWorker();

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

  // 期間メニューの年セレクト候補（仕訳・予定CF の年 + 現在/翌年 + 選択中の年）。
  const today = todayLocal();
  const periodYears = availableYears(
    [
      ...ledger.journalEntries.map((e) => e.date),
      ...ledger.cashflowSchedules.map((s) => s.dueDate),
    ],
    Number.parseInt(today.slice(0, 4), 10),
    period.mode !== 'all' ? period.year : undefined,
  );

  return (
    <>
      <a className="skip-link" href="#main">
        {t('common.home')}
      </a>
      <Header
        period={period}
        today={today}
        years={periodYears}
        onPeriodChange={setPeriod}
        onHome={() => setScreen('dashboard')}
        onMenu={() => setMenuOpen(true)}
      />

      <main className="app-main" id="main">
        {updateReady ? (
          <div className="banner" role="status">
            <Icon name="alert" size={18} />
            {t('update.available')}
            <button type="button" className="btn btn--primary" onClick={applyUpdate}>
              {t('update.apply')}
            </button>
          </div>
        ) : null}

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
        {screen === 'netIncome' ? <NetIncome period={period} onPeriodChange={setPeriod} /> : null}
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
        {screen === 'adjustments' ? <Adjustments /> : null}
        {screen === 'accounts' ? <Accounts /> : null}
        {screen === 'wallets' ? <Wallets /> : null}
        {screen === 'settings' ? <Settings onNavigate={setScreen} /> : null}
      </main>

      {menuOpen ? (
        <Menu
          current={screen}
          onNavigate={setScreen}
          onClose={() => setMenuOpen(false)}
          onHelp={() => setHelpOpen(true)}
        />
      ) : null}

      {entryInit ? <EntrySheet init={entryInit} onClose={() => setEntryInit(null)} /> : null}

      {helpOpen ? <Help onClose={() => setHelpOpen(false)} /> : null}
    </>
  );
}
