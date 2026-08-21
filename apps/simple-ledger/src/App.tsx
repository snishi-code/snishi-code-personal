/*
 * アプリ本体。foundation の AppHeader + useAppHistory を使用。
 * AppHeader center スロットに期間コンテキストを注入。
 *
 * 端末/ブラウザの「戻る」は useAppHistory が中央制御する:
 *   最前面の一時 overlay（ui/overlays.tsx の登録簿）→ dirty guard（overlay の
 *   requestClose 経由）→ 画面履歴 → dashboard の終了確認、の順。
 * 個別画面は Back 対応を持たない（overlay は ui/overlays.tsx のラッパーが自動登録）。
 */
import { useEffect, useState } from 'react';
import { AppHeader } from '@snishi/foundation/ui/AppHeader';
import { ConfirmDialog as ExitConfirmDialog } from '@snishi/foundation/ui/ConfirmDialog';
import { Icon } from '@snishi/foundation/ui/Icon';
import { IconButton } from '@snishi/foundation/ui/IconButton';
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
import {
  TimelineCalendar,
  type TimelineLens,
  type TimelineZoom,
} from './ui/screens/TimelineCalendar';
import { Allocations, type AllocationsTarget } from './ui/screens/Allocations';
import { Cashflow } from './ui/screens/Cashflow';
import { Accounts } from './ui/screens/Accounts';
import { Settings } from './ui/screens/Settings';
import { PasteImport } from './ui/screens/PasteImport';
import { Help } from './ui/screens/Help';
import { EntrySheet, type EntryInit } from './ui/screens/EntrySheet';
import { OnboardingSheet } from './ui/OnboardingSheet';
import { CONTINUOUS_COST_HARD_CAP } from './domain/continuousCost';
import { NAV_ITEMS, TIME_PLANE_SCREEN, supportsTimeZoom } from './ui/navigation';
import { entryOpenPlan } from './ui/entryOpen';
import { t } from './i18n';
import { todayLocal } from './util/time';
import type { ReportPeriod } from './domain/reportPeriod';
import { UI } from './ui-contract';
import type { Screen } from './ui/navigation';
import type { FormMode } from './ui/entryModes';
import type { JournalEntry } from './domain/types';

export function App() {
  const { status, ledger, error, errorCode } = useLedger();
  const [menuOpen, setMenuOpen] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const [entryInit, setEntryInit] = useState<EntryInit | null>(null);
  const [journalFilter, setJournalFilter] = useState<JournalFilter | null>(null);
  const [journalTargetEntryId, setJournalTargetEntryId] = useState<string | null>(null);
  // 仕訳一覧の計算で生まれた行タップ → 「月割り台帳」で開くシートの対象（1 回で消費）。
  const [allocationsTarget, setAllocationsTarget] = useState<AllocationsTarget | null>(null);
  // 科目行タップ（資金繰りのローン科目など）→ 勘定科目で開く編集シートの対象（1 回で消費）。
  const [accountsTarget, setAccountsTarget] = useState<{ accountId: string } | null>(null);
  const [exitConfirm, setExitConfirm] = useState(false);
  // オンボーディングは「初回状態からの派生 + ユーザー操作の上書き」で開閉する
  // （effect での setState を避ける。render 中の派生調整パターン）。
  const [onboardingDismissed, setOnboardingDismissed] = useState(false);
  const [onboardingManualOpen, setOnboardingManualOpen] = useState(false);
  const [period, setPeriod] = useState<ReportPeriod>(() => ({
    mode: 'date',
    date: todayLocal(),
  }));
  // 時間平面のズーム（日/月/年）。ヘッダーのセグメントが正本で、ウィンドウ世界の画面が従う。
  // ボタンは**日付を変えない**（タイムスリップはヘッダーの日付のみ。ズームは目盛りを変えるだけ）。
  const [timeZoom, setTimeZoom] = useState<TimelineZoom>('month');
  // 時間平面のレンズ（線分/数値/グラフ）。セレクタは時間平面の画面内にあるが、状態は App が持つ:
  // 「数値レンズに日の列は無い」＝ヘッダーの「日」の可否がレンズに依存するため
  // （旧 overviewMode がヘッダーのために App に居たのと同じ理由）。
  const [timelineLens, setTimelineLens] = useState<TimelineLens>('segment');

  // 端末/ブラウザ Back の中央制御。overlay → (overlay 側 dirty guard) → 画面履歴 → 終了確認。
  const { view, navigate, beginExit } = useAppHistory({
    initialView: 'dashboard',
    closeTopOverlay,
    showExitConfirm: () => setExitConfirm(true),
    isExitConfirmOpen: () => exitConfirm,
  });
  const screen = view as Screen;

  // 画面を切り替えたら document スクロールを先頭へ戻す（オーバーレイの開閉では動かさない）。
  // document スクロールは画面差し替えをまたいで残るため、長い画面（ホームの仕訳・一覧）から
  // 遷移すると次の画面が途中位置で開いてしまうのを防ぐ。
  useEffect(() => {
    if (typeof window.scrollTo === 'function') window.scrollTo(0, 0);
  }, [screen]);

  /*
   * 不変則「**タイムラインの**数値レンズに日の列は無い」の唯一の強制点（v13.5 F）。
   *
   * レンズはタイムラインの見え方でしかないので、効かせるのも**タイムラインに居るとき
   * （これから行くとき）だけ**にする。資金繰りはレンズを持たないウィンドウ世界なので、
   * 日/月/年のすべてを押せる（v13.5 D で「数値レンズのまま資金繰りへ行くと日が押せない」
   * という取り違えが出ていた）。グラフレンズには日のバケットがあるので丸めない。
   */
  const enforceLensZoom = (
    destination: Screen,
    lens: TimelineLens,
    zoom: TimelineZoom,
  ): TimelineZoom =>
    destination === TIME_PLANE_SCREEN && lens === 'matrix' && zoom === 'day' ? 'month' : zoom;

  const go = (s: Screen) => {
    setJournalFilter(null);
    setJournalTargetEntryId(null);
    setAllocationsTarget(null);
    setAccountsTarget(null);
    // 資金繰りで「日」を選んだままタイムライン（数値レンズ）へ戻る経路でも不変則を保つ。
    setTimeZoom((current) => enforceLensZoom(s, timelineLens, current));
    navigate(s);
  };
  // ヘッダーのズーム = ウィンドウ世界の名乗り。ズーム対応画面なら目盛りだけを変え、
  // 断面画面なら時間平面へ移動してそのズームで点灯する（旧 openOverview の一般化）。
  const changeZoom = (zoom: TimelineZoom) => {
    const destination = supportsTimeZoom(screen) ? screen : TIME_PLANE_SCREEN;
    setTimeZoom(enforceLensZoom(destination, timelineLens, zoom));
    if (destination !== screen) go(destination);
  };
  // レンズの切替。数値レンズに日の列は無いので、日ズームのまま切り替えたら月へ丸める。
  const changeLens = (lens: TimelineLens) => {
    setTimelineLens(lens);
    setTimeZoom((current) => enforceLensZoom(screen, lens, current));
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

  // 終了確認は overlay 登録簿に載せない: appHistory が isExitConfirmOpen で
  // Back を消費して維持する（連打で確認なしに離脱させないため foundation を直接使う）。
  //
  // 早期 return より**前**で組み立て、loading / 復旧画面を含む全状態の return へ同じものを
  // 差し込む。useAppHistory は status に関係なく popstate を拾って showExitConfirm を呼ぶので、
  // ここが本文の後ろにしか無いと台帳が読めない状態だけ確認なしで離脱してしまう。
  // 実体は 1 つ（分岐した return のどれか 1 本だけが描画される）＝ dialog の重複は生まれない。
  const exitConfirmDialog = exitConfirm ? (
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
  ) : null;

  if (status === 'loading') {
    return (
      <>
        <main className="app-main center" aria-busy="true">
          <p className="muted">{t('common.loading')}</p>
        </main>
        {exitConfirmDialog}
      </>
    );
  }

  if (status === 'error' || !ledger) {
    // banner だけで終わらせない: 設定（JSON 読み込み・スナップショット復元）へ入れる。
    // 版不一致だけは直接 import も内部で loadLedger に失敗して通らないため、専用の
    // 手順（初期化 → 変換済み JSON 読み込み）を出す（再監査対応・正式な移行手順の固定）。
    return (
      <>
        <RecoveryScreen
          message={error}
          schemaMismatch={errorCode === 'error.db.schemaVersionMismatch'}
        />
        {exitConfirmDialog}
      </>
    );
  }

  const openCreate = (mode: FormMode) => setEntryInit({ kind: 'create', mode });
  const openEdit = (entry: JournalEntry) => setEntryInit({ kind: 'edit', entry });
  const openReversal = (source: JournalEntry) => setEntryInit({ kind: 'reversal', source });

  // 明示フィルターは「その遷移だけ」のもの。go は必ず捨てるので、accountId を持たない
  // 日付だけの絞り込み（解除チップが出ない）が居座らない。
  const goJournalFiltered = (filter: JournalFilter) => {
    navigate('journal');
    setJournalTargetEntryId(null);
    setJournalFilter(filter);
  };

  // 仕訳一覧 → 月割り台帳（計算で生まれた行の由来を開く）。
  const goAllocationsFor = (target: AllocationsTarget) => {
    navigate('allocations');
    setAllocationsTarget(target);
  };

  // 資金繰りなど → 勘定科目（指定の科目の編集シートを開く）。
  const goAccountFor = (accountId: string) => {
    navigate('accounts');
    setAccountsTarget({ accountId });
  };

  // タイムラインは保存仕訳の種類を再解釈せず、仕訳一覧の既存 resolver へ ID を渡す。
  // これにより通常仕訳だけでなく、初期残高・残高補正も各専用シートで開く。
  const goJournalEntry = (entryId: string) => {
    const entry = ledger.journalEntries.find((candidate) => candidate.id === entryId);
    if (!entry) return;
    // 何を開くかは entryOpenPlan（単一正本）。くり返し記帳から生まれた仕訳はここでも
    // 編集シートではなく由来ルールへ流す（画面ごとに判定を手書きしない）。
    const plan = entryOpenPlan(entry);
    if (plan.kind === 'rule') {
      goAllocationsFor({ ruleId: plan.ruleId });
      return;
    }
    navigate('journal');
    setJournalFilter(null);
    // 初期残高・残高補正は専用シートが要る = 仕訳一覧の既存 resolver へ ID を渡す。
    // 補正は plan が指す宣言（stored の pin）を開く（按分スライスからの遷移でも親へ着く）。
    if (plan.kind === 'adjustment') setJournalTargetEntryId(plan.entryId);
    else if (plan.kind === 'opening') setJournalTargetEntryId(entryId);
    else {
      setJournalTargetEntryId(null);
      openEdit(entry);
    }
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
  const timeSlipped = !(period.mode === 'date' && period.date === today);

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
      {/* 「今」へ戻る。タイムスリップ中（ヘッダーの日付 ≠ 今日）だけ現れる＝警告灯を兼ねる
          （iOS カレンダーの「今日」・マップの現在地ボタンと同型）。日付だけを戻し、
          画面もズームも動かさない（動作であって状態ではないので、ズームに混ぜない）。 */}
      {timeSlipped ? (
        <button
          type="button"
          className="period-today"
          onClick={() => changePeriod({ mode: 'date', date: today })}
          data-ui={UI.period.today}
        >
          {t('period.today')}
        </button>
      ) : null}
      {/* 時間の単位（日/月/年 = 時間平面のズーム）。ヘッダー = 時間、の「時間」には目盛りも
          含まれる（写真 App の 年別/月別/日別 と同型・作者決定 2026-08-14 / 2026-08-18）。
          押してもヘッダーの日付は変えない。**点灯 = ウィンドウ世界の名乗り**:
          ズーム対応画面に居るときだけ現在ズームが点灯し、断面画面ではすべて消灯する
          （押すと時間平面へ移動してそこで点灯する）。 */}
      <div className="period-zoom" role="group" aria-label={t('zoom.group')}>
        {(
          [
            ['day', 'zoom.day', UI.period.zoomDay],
            ['month', 'zoom.month', UI.period.zoomMonth],
            ['year', 'zoom.year', UI.period.zoomYear],
          ] as const
        ).map(([zoom, labelKey, dataUi]) => {
          // タイムラインの数値レンズには日の列が無い。押せないことと**理由**を読み上げにも出す。
          // 資金繰り（レンズを持たないウィンドウ世界）では日も押せる（v13.5 F）。
          const unavailable =
            zoom === 'day' && timelineLens === 'matrix' && screen === TIME_PLANE_SCREEN;
          return (
            <button
              key={zoom}
              type="button"
              className="period-zoom__btn"
              aria-pressed={supportsTimeZoom(screen) && timeZoom === zoom}
              disabled={unavailable}
              {...(unavailable ? { 'aria-label': t('zoom.dayUnavailable') } : {})}
              onClick={() => changeZoom(zoom)}
              data-ui={dataUi}
            >
              {t(labelKey)}
            </button>
          );
        })}
      </div>
    </div>
  );

  return (
    <>
      <a className="skip-link" href="#main">
        {t('a11y.skipToContent')}
      </a>

      {/* ヘッダーは時間（日付 + 粒度）だけに徹する。ホームはフッター中央、
          設定はメニュー内が唯一の置き場所（重複を作らない・作者決定 2026-08-14）。 */}
      <AppHeader center={periodCenter} right={<EnvBadge />} />

      <main className="app-main" id="main">
        {screen === 'dashboard' ? (
          <Dashboard
            period={period}
            onPeriodChange={changePeriod}
            onAddEntry={openCreate}
            onEditEntry={openEdit}
            onNavigate={go}
            onOpenJournal={goJournalFiltered}
            onOpenAllocations={goAllocationsFor}
            onOpenEntry={goJournalEntry}
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
            targetEntryId={journalTargetEntryId}
            onClearFilter={() => setJournalFilter(null)}
          />
        ) : null}
        {screen === 'timeline' ? (
          <TimelineCalendar
            period={period}
            zoom={timeZoom}
            onZoomChange={setTimeZoom}
            lens={timelineLens}
            onLensChange={changeLens}
            onPeriodChange={changePeriod}
            onNavigate={go}
            onOpenEntry={goJournalEntry}
            onOpenAllocations={goAllocationsFor}
          />
        ) : null}
        {screen === 'allocations' ? (
          <Allocations period={period} onEditEntry={openEdit} target={allocationsTarget} />
        ) : null}
        {screen === 'cashflow' ? (
          <Cashflow
            period={period}
            zoom={timeZoom}
            onEditEntry={openEdit}
            onOpenAllocations={goAllocationsFor}
            onOpenAccount={goAccountFor}
            onOpenEntry={goJournalEntry}
          />
        ) : null}
        {screen === 'accounts' ? <Accounts period={period} target={accountsTarget} /> : null}
        {screen === 'pasteImport' ? (
          // 成功したらホームへ（作者決定 2026-08-20・v13.12 項目 2）。個別の手直しは
          // 仕訳一覧の通常編集でいつでもできるので、着地は全体が見える面にする。
          <PasteImport onDone={() => go('dashboard')} />
        ) : null}
        {screen === 'settings' ? (
          <Settings onOpenOnboarding={() => setOnboardingManualOpen(true)} />
        ) : null}
      </main>

      {/*
       * 画面下端の固定ナビ（左 = 戻る / 中央 = ホーム / 右 = メニュー）。
       * iOS の PWA は戻るジェスチャが効いたり効かなかったりするため、見えるボタンで補う
       * （ジェスチャは残す・作者決定 2026-08-14）。
       *
       * 戻るは window.history.back() を呼ぶだけにする。overlay を閉じる → dirty guard →
       * 画面履歴 → 終了確認、の順序は useAppHistory が中央制御しており、ジェスチャと
       * 同じ popstate を起こす＝**意味が 1 箇所に留まる**（app 側に分岐を複製しない）。
       * ホームで押すと終了確認が出るのは端末ジェスチャと同じ帰結なので、disabled にしない。
       *
       * overlay 表示中は native <dialog> が top-layer に乗り、フッターは inert で押せない
       * （シート上の Back は端末ジェスチャ経由になる＝既存の .entry-bar と同じ状態）。
       * loading / RecoveryScreen の早期 return には出さない（台帳が読めない状態で
       * 各画面へ入れないため・fail-closed）。
       */}
      {/* ページ内の navigation ランドマークはこれ 1 つなので aria-label は付けない
          （名前にロール名を含めると読み上げが同語反復になる）。 */}
      <nav className="app-footer" data-ui={UI.nav.footer}>
        <div className="app-footer__inner">
          <IconButton
            label={t('a11y.back')}
            onClick={() => window.history.back()}
            dataUi={UI.nav.footerBack}
          >
            {/* 左向きアイコンは foundation に無い。新概念を足さず chevronRight の鏡像で作る
                （前例: .scroll-top__icon）。 */}
            <span className="app-footer__back-icon">
              <Icon name="chevronRight" />
            </span>
          </IconButton>
          <IconButton
            label={t('a11y.home')}
            onClick={() => go('dashboard')}
            {...(screen === 'dashboard' ? { 'aria-current': 'page' as const } : {})}
            dataUi={UI.nav.footerHome}
          >
            <Icon name="home" />
          </IconButton>
          {/* 開くのは role=menu のウィジェットではなく native <dialog>（foundation の Menu）。
              予告する型を実体に合わせ、開閉状態も伝える（foundation 側は編集しない）。 */}
          <IconButton
            label={t('a11y.openMenu')}
            onClick={() => setMenuOpen(true)}
            aria-haspopup="dialog"
            aria-expanded={menuOpen}
            dataUi={UI.nav.menuButton}
          >
            <Icon name="menu" />
          </IconButton>
        </div>
      </nav>

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

      {exitConfirmDialog}
    </>
  );
}
