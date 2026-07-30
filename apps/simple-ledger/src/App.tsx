/*
 * アプリ本体。foundation の AppHeader + useAppHistory を使用。
 * AppHeader center スロットに期間コンテキストを注入。
 *
 * 端末/ブラウザの「戻る」は useAppHistory が中央制御する:
 *   最前面の一時 overlay（ui/overlays.tsx の登録簿）→ dirty guard（overlay の
 *   requestClose 経由）→ 画面履歴 → dashboard の終了確認、の順。
 * 個別画面は Back 対応を持たない（overlay は ui/overlays.tsx のラッパーが自動登録）。
 */
import { useState } from 'react';
import { AppHeader } from '@snishi/foundation/ui/AppHeader';
import { ConfirmDialog as ExitConfirmDialog } from '@snishi/foundation/ui/ConfirmDialog';
import { Icon } from '@snishi/foundation/ui/Icon';
import { EnvBadge } from '@snishi/foundation/pwa/EnvBadge';
import { useAppHistory } from '@snishi/foundation/history/useAppHistory';
import { Menu, closeTopOverlay, type MenuItem } from './ui/overlays';
import { RecoveryScreen } from './ui/ErrorBoundary';
import { isPristineSeedLedger, useLedger } from './state/store';
import { isOnboardingDone, markOnboardingDone } from './data/localFlags';
import { Dashboard } from './ui/screens/Dashboard';
import { Breakdown } from './ui/screens/Breakdown';
import { ExpenseBreakdown } from './ui/screens/ExpenseBreakdown';
import { NetIncome } from './ui/screens/NetIncome';
import { Journal, type JournalFilter } from './ui/screens/Journal';
import { Allocations, type AllocationsTarget } from './ui/screens/Allocations';
import { Cashflow } from './ui/screens/Cashflow';
import { Tags } from './ui/screens/Tags';
import { Accounts } from './ui/screens/Accounts';
import { Settings } from './ui/screens/Settings';
import { Help } from './ui/screens/Help';
import { EntrySheet, type EntryInit } from './ui/screens/EntrySheet';
import { OnboardingSheet } from './ui/OnboardingSheet';
import { CONTINUOUS_COST_HARD_CAP } from './domain/continuousCost';
import { NAV_ITEMS } from './ui/navigation';
import { t } from './i18n';
import { todayLocal } from './util/time';
import type { ReportPeriod } from './domain/reportPeriod';
import { UI } from './ui-contract';
import type { Screen } from './ui/navigation';
import type { FormMode } from './ui/entryModes';
import type { JournalEntry } from './domain/types';

export function App() {
  const { status, ledger, error } = useLedger();
  const [menuOpen, setMenuOpen] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const [entryInit, setEntryInit] = useState<EntryInit | null>(null);
  const [journalFilter, setJournalFilter] = useState<JournalFilter | null>(null);
  // 仕訳一覧の計算で生まれた行タップ → 「毎月のもの」で開くシートの対象（1 回で消費）。
  const [allocationsTarget, setAllocationsTarget] = useState<AllocationsTarget | null>(null);
  const [exitConfirm, setExitConfirm] = useState(false);
  // オンボーディングは「初回状態からの派生 + ユーザー操作の上書き」で開閉する
  // （effect での setState を避ける。render 中の派生調整パターン）。
  const [onboardingDismissed, setOnboardingDismissed] = useState(false);
  const [onboardingManualOpen, setOnboardingManualOpen] = useState(false);
  const [period, setPeriod] = useState<ReportPeriod>(() => ({
    mode: 'date',
    date: todayLocal(),
  }));

  // 端末/ブラウザ Back の中央制御。overlay → (overlay 側 dirty guard) → 画面履歴 → 終了確認。
  const { view, navigate, beginExit } = useAppHistory({
    initialView: 'dashboard',
    closeTopOverlay,
    showExitConfirm: () => setExitConfirm(true),
    isExitConfirmOpen: () => exitConfirm,
  });
  const screen = view as Screen;
  const go = (s: Screen) => {
    setJournalFilter(null);
    setAllocationsTarget(null);
    navigate(s);
  };
  // ヘッダーの日付を変えたら明示フィルターより日付を優先する（フィルターが居座らない）。
  const changePeriod = (next: ReportPeriod) => {
    setJournalFilter(null);
    setPeriod(next);
  };

  // 初回起動（完全に初期 seed 状態 + 未既読）だけ、初期残高の一括登録を自動表示する。
  const onboardingAutoOpen =
    status === 'ready' &&
    !!ledger &&
    isPristineSeedLedger(ledger) &&
    !isOnboardingDone() &&
    !onboardingDismissed;
  const onboardingOpen = onboardingManualOpen || onboardingAutoOpen;
  const closeOnboarding = () => {
    // 完了・スキップ・破棄いずれでも既読化する（再表示は 設定 > 初期残高の一括登録）。
    markOnboardingDone();
    setOnboardingDismissed(true);
    setOnboardingManualOpen(false);
  };

  if (status === 'loading') {
    return (
      <main className="app-main center" aria-busy="true">
        <p className="muted">{t('common.loading')}</p>
      </main>
    );
  }

  if (status === 'error' || !ledger) {
    // banner だけで終わらせない: 設定（JSON 読み込み・スナップショット復元）へ入れる。
    return <RecoveryScreen message={error} />;
  }

  const openCreate = (mode: FormMode) => setEntryInit({ kind: 'create', mode });
  const openEdit = (entry: JournalEntry) => setEntryInit({ kind: 'edit', entry });
  const openReversal = (source: JournalEntry) => setEntryInit({ kind: 'reversal', source });

  // 明示フィルターは「その遷移だけ」のもの。go は必ず捨てるので、accountId を持たない
  // 日付だけの絞り込み（解除チップが出ない）が居座らない。
  const goJournalFiltered = (filter: JournalFilter) => {
    navigate('journal');
    setJournalFilter(filter);
  };

  // 仕訳一覧 → 毎月のもの（計算で生まれた行の由来を開く）。
  const goAllocationsFor = (target: AllocationsTarget) => {
    navigate('allocations');
    setAllocationsTarget(target);
  };

  const today = todayLocal();

  // --- メニュー items ビルド ---
  const menuItems: MenuItem[] = [
    ...NAV_ITEMS.map((item) => ({
      key: item.screen,
      label: t(item.labelKey),
      icon: item.icon,
      current: screen === item.screen,
      onSelect: () => go(item.screen),
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
  // year/all は俯瞰ロジックとして残すが、現時点のヘッダー UI は日付選択だけを公開する。
  // チップに透明な <input type="date"> を重ね、1 タップで OS のカレンダーを直接開く。
  // max = 継続コスト資産エンジンの展開上限（エンジンが展開できる範囲の外を選べなくする）。
  const selectedDate = period.mode === 'date' ? period.date : today;

  const periodCenter = (
    <div className="period-context">
      <span className="period-context__chip" data-ui={UI.period.dateTrigger}>
        <span className="period-context__text" aria-hidden="true">
          {selectedDate}
        </span>
        <Icon name="expand" size={14} />
        <input
          type="date"
          className="period-context__input"
          value={selectedDate}
          max={CONTINUOUS_COST_HARD_CAP}
          aria-label={`${selectedDate} — ${t('period.openDate')}`}
          onChange={(e) => {
            if (e.target.value !== '') changePeriod({ mode: 'date', date: e.target.value });
          }}
          data-ui={UI.period.dateInput}
        />
      </span>
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
            onClick={() => go('dashboard')}
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

      <main className="app-main" id="main">
        {screen === 'dashboard' ? (
          <Dashboard
            period={period}
            onPeriodChange={changePeriod}
            onAddEntry={openCreate}
            onEditEntry={openEdit}
            onNavigate={go}
            onOpenJournal={goJournalFiltered}
          />
        ) : null}
        {screen === 'incomeBreakdown' ? (
          <Breakdown
            section="revenue"
            period={period}
            onPeriodChange={changePeriod}
            onDrillDown={goJournalFiltered}
            onNavigate={go}
          />
        ) : null}
        {screen === 'expenseBreakdown' ? (
          <ExpenseBreakdown
            period={period}
            onPeriodChange={changePeriod}
            onDrillDown={goJournalFiltered}
            onNavigate={go}
          />
        ) : null}
        {screen === 'netIncome' ? (
          <NetIncome period={period} onPeriodChange={changePeriod} onNavigate={go} />
        ) : null}
        {screen === 'assetsBreakdown' ? (
          <Breakdown
            section="asset"
            period={period}
            onPeriodChange={changePeriod}
            onDrillDown={goJournalFiltered}
            onNavigate={go}
          />
        ) : null}
        {screen === 'liabilitiesBreakdown' ? (
          <Breakdown
            section="liability"
            period={period}
            onPeriodChange={changePeriod}
            onDrillDown={goJournalFiltered}
            onNavigate={go}
          />
        ) : null}
        {screen === 'netAssets' ? (
          <Breakdown
            section="equity"
            period={period}
            onPeriodChange={changePeriod}
            onDrillDown={goJournalFiltered}
            onNavigate={go}
          />
        ) : null}
        {screen === 'journal' ? (
          <Journal
            onEditEntry={openEdit}
            onReverse={openReversal}
            onOpenAllocations={goAllocationsFor}
            filter={journalFilter}
            period={period}
            onClearAccountFilter={() => setJournalFilter(null)}
          />
        ) : null}
        {screen === 'allocations' ? (
          <Allocations onEditEntry={openEdit} target={allocationsTarget} />
        ) : null}
        {screen === 'cashflow' ? <Cashflow onEditEntry={openEdit} /> : null}
        {screen === 'tags' ? <Tags /> : null}
        {screen === 'accounts' ? <Accounts /> : null}
        {screen === 'settings' ? (
          <Settings onNavigate={go} onOpenOnboarding={() => setOnboardingManualOpen(true)} />
        ) : null}
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

      {onboardingOpen ? <OnboardingSheet onClose={closeOnboarding} /> : null}

      {exitConfirm ? (
        // 終了確認は overlay 登録簿に載せない: appHistory が isExitConfirmOpen で
        // Back を消費して維持する（連打で確認なしに離脱させないため foundation を直接使う）。
        <ExitConfirmDialog
          title={t('exit.confirmTitle')}
          body={t('exit.confirmBody')}
          confirmLabel={t('exit.confirmLabel')}
          dataUi={UI.app.exitConfirm}
          onCancel={() => setExitConfirm(false)}
          onConfirm={() => {
            setExitConfirm(false);
            beginExit();
          }}
        />
      ) : null}
    </>
  );
}
