/*
 * UI contract: テストが依存してよい安定名（data-ui 属性値）。
 *
 * - これらの名前は日本語文言の変更で壊れない契約。Playwright/Testing Library から参照する。
 * - DOM 構造や CSS class には依存させない。
 * - 詳細とポリシーは docs/dev/ui-contract.md。
 */
export const UI = {
  // 期間（データ抽出条件）。ヘッダー中央の「現在コンテキスト表示」+ 軽量ピッカー。ホーム/財務諸表/仕訳で共有
  period: {
    // ヘッダーの現在コンテキスト表示（タップで対応ピッカーを開く）
    yearTrigger: 'period.year.trigger',
    monthTrigger: 'period.month.trigger',
    // 軽量ピッカー本体
    yearPicker: 'period.year.picker',
    monthPicker: 'period.month.picker',
    // ピッカーの行（選択で即反映して閉じる）
    yearRow: 'period.year.row',
    monthRow: 'period.month.row',
    allRow: 'period.all.row',
    fullYearRow: 'period.fullYear.row',
    // トレンド（SVG グラフ）
    trend: 'period.trend',
    trendChart: 'period.trend.chart',
    trendPoint: 'period.trend.point',
  },
  dashboard: {
    view: 'dashboard.view',
    // 日常入力 3 種（ホーム上部の主導線）
    income: 'dashboard.entry.income',
    expense: 'dashboard.entry.expense',
    transfer: 'dashboard.entry.transfer',
    // 収支/財政状態の項目別ボタン（タップで各項目の「内訳 + 推移」ページへ）。
    // 旧・財務諸表（PL/BS トグル）を項目ごとの遷移先に分解した（同じページに集約しない）。
    statRevenue: 'dashboard.stat.revenue', // → 収入の内訳
    statExpense: 'dashboard.stat.expense', // → 支出の内訳
    statNetIncome: 'dashboard.stat.netIncome', // → 収支
    statAssets: 'dashboard.stat.assets', // → 資産の内訳
    statLiabilities: 'dashboard.stat.liabilities', // → 負債の内訳
    statNetAssets: 'dashboard.stat.netAssets', // → 純資産
    // 当月の仕訳プレビュー
    journalPreview: 'dashboard.journal.preview',
    journalOpenAll: 'dashboard.journal.openAll',
  },
  // 収入の内訳（ホーム「収入」のタップ先・フロー）。科目行は仕訳へドリル。
  incomeBreakdown: {
    view: 'incomeBreakdown.view',
    row: 'incomeBreakdown.row',
    total: 'incomeBreakdown.total',
  },
  // 支出の内訳（通常支出 + 月額化＝生活コスト）。月額化からは月額化コスト台帳へ。
  expenseBreakdown: {
    view: 'expenseBreakdown.view',
    normalExpense: 'expenseBreakdown.normalExpense',
    monthlyCost: 'expenseBreakdown.monthlyCost',
    total: 'expenseBreakdown.total',
  },
  // 収支（ホーム「収支」のタップ先・フロー）。科目別ドリルはせず、月ごとの残り方を推移で見せる。
  netIncome: {
    view: 'netIncome.view',
    revenue: 'netIncome.revenue',
    expense: 'netIncome.expense',
    result: 'netIncome.result',
  },
  // 資産の内訳（ホーム「資産」のタップ先・ストック）。科目行は仕訳へドリル。
  assetsBreakdown: {
    view: 'assetsBreakdown.view',
    row: 'assetsBreakdown.row',
    total: 'assetsBreakdown.total',
  },
  // 負債の内訳（ホーム「負債」のタップ先・ストック）。資金繰り/返済計画への導線を持つ。
  liabilitiesBreakdown: {
    view: 'liabilitiesBreakdown.view',
    row: 'liabilitiesBreakdown.row',
    total: 'liabilitiesBreakdown.total',
    cashflowLink: 'liabilitiesBreakdown.cashflowLink',
  },
  // 純資産（ホーム「純資産」のタップ先・ストック）。元手 + 今期の損益 + 推移。
  netAssets: {
    view: 'netAssets.view',
    row: 'netAssets.row',
    total: 'netAssets.total',
  },
  journal: {
    view: 'journal.view',
    list: 'journal.entry.list',
    monthlyRecognition: 'journal.monthlyRecognition',
    monthlyRecognitionRow: 'journal.monthlyRecognition.row',
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
      allocateAssetKind: 'journal.entry.allocateAssetKind',
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
      // 固定資産購入の月額化
      fixedMonthlyToggle: 'journal.entry.fixedMonthlyToggle',
      fixedMonthlyCategory: 'journal.entry.fixedMonthlyCategory',
      // 目的別資金（reserve-asset）を支出/振替の候補に出す・その場で作る
      reserveToggle: 'journal.entry.reserveToggle',
      reserveCreate: 'journal.entry.reserveCreate',
      // 負債（payment/other-liability）を候補に出す・その場で作る
      liabilityToggle: 'journal.entry.liabilityToggle',
      liabilityCreate: 'journal.entry.liabilityCreate',
      liabilityCreateName: 'journal.entry.liabilityCreate.name',
      liabilityCreateRole: 'journal.entry.liabilityCreate.role',
      liabilityCreateSave: 'journal.entry.liabilityCreate.save',
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
    edit: 'allocations.edit',
    editDialog: 'allocations.editDialog',
    editName: 'allocations.edit.name',
    editKind: 'allocations.edit.kind',
    editAmount: 'allocations.edit.amount',
    editCostMonths: 'allocations.edit.costMonths',
    editRepeat: 'allocations.edit.repeat',
    editStartMonth: 'allocations.edit.startMonth',
    editEndMonth: 'allocations.edit.endMonth',
    editExpense: 'allocations.edit.expense',
    editStatus: 'allocations.edit.status',
    editSave: 'allocations.edit.save',
    dispose: 'allocations.dispose',
    disposeDialog: 'allocations.disposeDialog',
    disposeDate: 'allocations.dispose.date',
    disposeProceeds: 'allocations.dispose.proceeds',
    disposeDestination: 'allocations.dispose.destination',
    disposeConfirm: 'allocations.dispose.confirm',
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
  wallets: {
    view: 'wallets.view',
    scopeList: 'wallets.scope.list',
    scopeCreate: 'wallets.scope.create',
    scopeName: 'wallets.scope.name',
    scopeSave: 'wallets.scope.save',
    instrumentList: 'wallets.instrument.list',
    instrumentCreate: 'wallets.instrument.create',
    instrumentName: 'wallets.instrument.name',
    instrumentAccount: 'wallets.instrument.account',
    instrumentKind: 'wallets.instrument.kind',
    instrumentSave: 'wallets.instrument.save',
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
    // 表示終了日（任意日付まで投影する）
    until: 'cashflow.until',
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
    reserveTarget: 'cashflow.reserve.target',
    reserveDate: 'cashflow.reserve.date',
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
