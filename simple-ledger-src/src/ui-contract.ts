/*
 * UI contract: テストが依存してよい安定名（data-ui 属性値）。
 *
 * - これらの名前は日本語文言の変更で壊れない契約。Playwright/Testing Library から参照する。
 * - DOM 構造や CSS class には依存させない。
 * - 詳細とポリシーは docs/dev/ui-contract.md。
 */
export const UI = {
  // 期間切替（ヘッダー中央の期間ボタン → 期間メニュー。ホーム/財務諸表で共有）
  period: {
    // ヘッダー中央の期間ラベルボタン（押すと期間メニューを開く）
    button: 'period.button',
    // 期間メニュー内: 年を選ぶ / 全期間
    kindYear: 'period.kind.year',
    kindAll: 'period.kind.all',
    // 年セレクト + 粒度（月 / 年全体）+ 月セレクト
    year: 'period.input.year',
    grainMonth: 'period.grain.month',
    grainFullYear: 'period.grain.fullYear',
    month: 'period.input.month',
    // トレンド（グラフ）
    trend: 'period.trend',
    trendBar: 'period.trend.bar',
  },
  dashboard: {
    view: 'dashboard.view',
    // 日常入力 3 種（ホーム上部の主導線）
    income: 'dashboard.entry.income',
    expense: 'dashboard.entry.expense',
    transfer: 'dashboard.entry.transfer',
    // 損益/資産負債サマリーの項目別ボタン（タップで財務諸表の該当セクションへ）
    statRevenue: 'dashboard.stat.revenue',
    statExpense: 'dashboard.stat.expense',
    statNetIncome: 'dashboard.stat.netIncome',
    statAssets: 'dashboard.stat.assets',
    statLiabilities: 'dashboard.stat.liabilities',
    statNetAssets: 'dashboard.stat.netAssets',
    // 後方互換（旧 e2e 用に維持）: 収益=PL入口 / 資産=BS入口
    openPl: 'dashboard.stat.revenue',
    openBs: 'dashboard.stat.assets',
    // 生活コスト領域（タップで資金計画・負債へ）
    openCashflow: 'dashboard.openCashflow',
    // 当月の仕訳プレビュー
    journalPreview: 'dashboard.journal.preview',
    journalOpenAll: 'dashboard.journal.openAll',
  },
  journal: {
    view: 'journal.view',
    list: 'journal.entry.list',
    monthlyRecognition: 'journal.monthlyRecognition',
    search: 'journal.search',
    clearAccountFilter: 'journal.filter.clearAccount',
    showFuture: 'journal.filter.showFuture',
    filterTag: 'journal.filter.tag',
    entry: {
      save: 'journal.entry.save',
      cancel: 'journal.entry.cancel',
      delete: 'journal.entry.delete',
      reverse: 'journal.entry.reverse',
      detailToggle: 'journal.entry.detailToggle',
      manualSwitch: 'journal.entry.manualSwitch',
      tags: 'journal.entry.tags',
      debitTags: 'journal.entry.debitTags',
      creditTags: 'journal.entry.creditTags',
      allocateToggle: 'journal.entry.allocateToggle',
      allocateMonths: 'journal.entry.allocateMonths',
      monthlyizeContinue: 'journal.entry.monthlyizeContinue',
      monthlyizeRepayToggle: 'journal.entry.monthlyizeRepayToggle',
      monthlyizeRepayAccount: 'journal.entry.monthlyizeRepayAccount',
      monthlyizeRepayCount: 'journal.entry.monthlyizeRepayCount',
      monthlyizeRepayStart: 'journal.entry.monthlyizeRepayStart',
      // 借入・ローン実行（振替）からの分割返済登録
      loanRepayToggle: 'journal.entry.loanRepayToggle',
      loanRepayAccount: 'journal.entry.loanRepayAccount',
      loanRepayCount: 'journal.entry.loanRepayCount',
      loanRepayStart: 'journal.entry.loanRepayStart',
      date: 'journal.entry.date',
      description: 'journal.entry.description',
      item: 'journal.entry.item',
      // お金の流れ（源泉 → 行き先）。source=貸方 / destination=借方。
      flow: 'journal.entry.flow',
      flowSource: 'journal.entry.flow.source',
      flowDestination: 'journal.entry.flow.destination',
      flowError: 'journal.entry.flow.error',
      debitAccount: 'journal.entry.debitAccount',
      creditAccount: 'journal.entry.creditAccount',
      amount: 'journal.entry.amount',
      memo: 'journal.entry.memo',
    },
  },
  statements: {
    view: 'statements.view',
    profitAndLoss: 'statements.profitAndLoss',
    balanceSheet: 'statements.balanceSheet',
    tabPl: 'statements.tab.pl',
    tabBs: 'statements.tab.bs',
    asOf: 'statements.asOf',
    // 科目行（クリックで Journal へドリルダウン）
    row: 'statements.row',
  },
  accounts: {
    view: 'accounts.view',
    create: 'accounts.create',
    save: 'accounts.save',
    list: 'accounts.list',
    type: 'accounts.type',
    role: 'accounts.role',
  },
  allocations: {
    view: 'allocations.view',
    list: 'allocations.list',
    showCompleted: 'allocations.showCompleted',
  },
  tags: {
    view: 'tags.view',
    create: 'tags.create',
    save: 'tags.save',
    name: 'tags.name',
    list: 'tags.list',
    period: 'tags.period',
    entrySummary: 'tags.summary.entry',
    lineSummary: 'tags.summary.line',
  },
  adjustments: {
    view: 'adjustments.view',
    account: 'adjust.account',
    date: 'adjust.date',
    kind: 'adjust.kind',
    actual: 'adjust.actual',
    save: 'adjust.save',
  },
  cashflow: {
    view: 'cashflow.view',
    addSchedule: 'cashflow.schedule.create',
    list: 'cashflow.schedule.list',
    scheduleSave: 'cashflow.schedule.save',
    schedulePost: 'cashflow.schedule.post',
    scheduleName: 'cashflow.schedule.name',
    scheduleAmount: 'cashflow.schedule.amount',
    scheduleAccount: 'cashflow.schedule.account',
    scheduleCounter: 'cashflow.schedule.counter',
    // 予定入力のお金の流れ（源泉 → 行き先）。入金/出金はロールから推定。
    scheduleFlowSource: 'cashflow.schedule.flow.source',
    scheduleFlowDestination: 'cashflow.schedule.flow.destination',
    scheduleInstallments: 'cashflow.schedule.installments',
    liabilityList: 'cashflow.liability.list',
    // CF 再構成: 自由資金推移 / 未来予定 / 目的別・目標の折りたたみ
    freeTrend: 'cashflow.freeTrend',
    futureList: 'cashflow.future.list',
    advancedToggle: 'cashflow.advanced.toggle',
    // 予定CF のタグ欄（実績化時に仕訳へコピーされる）
    scheduleEntryTags: 'cashflow.schedule.entryTags',
    scheduleAccountTags: 'cashflow.schedule.accountTags',
    scheduleCounterTags: 'cashflow.schedule.counterTags',
    summary: 'cashflow.summary',
    addReserve: 'cashflow.reserve.create',
    reserveList: 'cashflow.reserve.list',
    reserveSave: 'cashflow.reserve.save',
    reserveName: 'cashflow.reserve.name',
    // 資金目標
    addGoal: 'cashflow.goal.create',
    goalList: 'cashflow.goal.list',
    goalSave: 'cashflow.goal.save',
    goalName: 'cashflow.goal.name',
    goalAmount: 'cashflow.goal.amount',
    goalDate: 'cashflow.goal.date',
  },
  settings: {
    view: 'settings.view',
    // 管理セクション（補助画面への遷移リスト）。各行は settings.manage.<screen>
    manageList: 'settings.manage.list',
    exportJson: 'settings.exportJson',
    importJson: 'settings.importJson',
    importFile: 'settings.importFile',
    resetAll: 'settings.resetAll',
    expectedReturn: 'settings.expectedReturn',
  },
  nav: {
    home: 'nav.home',
    menuButton: 'nav.menu.button',
    menu: 'nav.menu',
  },
  dialog: {
    confirm: 'dialog.confirm',
    cancel: 'dialog.cancel',
  },
  toast: 'toast',
} as const;
