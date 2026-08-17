/*
 * UI contract: テストが依存してよい安定名（data-ui 属性値）。
 *
 * - これらの名前は日本語文言の変更で壊れない契約。Playwright/Testing Library から参照する。
 * - DOM 構造や CSS class には依存させない。
 * - 詳細とポリシーは docs/dev/ui-contract.md。
 */
export const UI = {
  // 期間（データ抽出条件）。ヘッダー中央の「現在コンテキスト表示」。ホーム/財務諸表/仕訳で共有
  period: {
    // ヘッダーの日付チップ（透明な date input を重ねた 1 タップ選択）
    dateTrigger: 'period.date.trigger',
    dateInput: 'period.date.input',
    // タイムスリップ中だけ現れる「今日」ボタン（日付だけを今日へ戻す・画面と粒度は不変）
    today: 'period.today',
    // 年・全期間はロジックを維持するが、現在は UI から到達させない。
    yearPicker: 'period.year.picker',
    yearRow: 'period.year.row',
    allRow: 'period.all.row',
    // トレンド（SVG グラフ）
    trend: 'period.trend',
    trendChart: 'period.trend.chart',
    trendPoint: 'period.trend.point',
  },
  dashboard: {
    view: 'dashboard.view',
    // 日常入力 3 種（ホーム下部の固定バー＝主導線）
    entryBar: 'dashboard.entryBar',
    income: 'dashboard.entry.income',
    expense: 'dashboard.entry.expense',
    transfer: 'dashboard.entry.transfer',
    // 収支/財政状態の項目別ボタン（タップで各項目の「内訳 + 推移」ページへ）。
    statRevenue: 'dashboard.stat.revenue',
    statExpense: 'dashboard.stat.expense',
    statNetIncome: 'dashboard.stat.netIncome',
    statAssets: 'dashboard.stat.assets',
    statLiabilities: 'dashboard.stat.liabilities',
    statNetAssets: 'dashboard.stat.netAssets',
    // 当月の仕訳プレビュー
    frame: 'dashboard.frame',
    journalPreview: 'dashboard.journal.preview',
    journalOpenAll: 'dashboard.journal.openAll',
    journalMore: 'dashboard.journal.more',
    journalCount: 'dashboard.journal.count',
  },
  // 収入の内訳
  incomeBreakdown: {
    view: 'incomeBreakdown.view',
    row: 'incomeBreakdown.row',
    total: 'incomeBreakdown.total',
  },
  // 支出の内訳
  expenseBreakdown: {
    view: 'expenseBreakdown.view',
    categoryList: 'expenseBreakdown.categoryList',
    categoryRow: 'expenseBreakdown.categoryRow',
    normalExpense: 'expenseBreakdown.normalExpense',
    monthlyCost: 'expenseBreakdown.monthlyCost',
    total: 'expenseBreakdown.total',
  },
  // 収支
  netIncome: {
    view: 'netIncome.view',
    revenue: 'netIncome.revenue',
    expense: 'netIncome.expense',
    result: 'netIncome.result',
  },
  // 資産の内訳（4 枠: 自由に動かせるお金 / 自由に動かせないお金 / 投資 / 月割り台帳）
  assetsBreakdown: {
    view: 'assetsBreakdown.view',
    row: 'assetsBreakdown.row',
    total: 'assetsBreakdown.total',
    freeSubtotal: 'assetsBreakdown.subtotal.free',
    fixedSubtotal: 'assetsBreakdown.subtotal.fixed',
    investmentSubtotal: 'assetsBreakdown.subtotal.investment',
    ledgerSubtotal: 'assetsBreakdown.subtotal.ledger',
    frame: 'assetsBreakdown.frame',
    // 月割り台帳の 1 行（残存価値合計・タップで「月割り台帳」へ）
    ledgerRow: 'assetsBreakdown.ledgerRow',
  },
  // 負債の内訳
  liabilitiesBreakdown: {
    view: 'liabilitiesBreakdown.view',
    row: 'liabilitiesBreakdown.row',
    total: 'liabilitiesBreakdown.total',
    shortTermSubtotal: 'liabilitiesBreakdown.subtotal.shortTermDebt',
    longTermSubtotal: 'liabilitiesBreakdown.subtotal.longTermDebt',
    frame: 'liabilitiesBreakdown.frame',
    cashflowLink: 'liabilitiesBreakdown.cashflowLink',
  },
  // 純資産
  netAssets: {
    view: 'netAssets.view',
    row: 'netAssets.row',
    total: 'netAssets.total',
  },
  // 年間・全体（年別の月次表 / 全期間の年次表）
  yearlyOverview: {
    view: 'yearlyOverview.view',
    // 2026-08-14 に画面内からヘッダーの粒度セグメントへ移設（値は据え置き）。
    modeYear: 'yearlyOverview.mode.year',
    modeAll: 'yearlyOverview.mode.all',
    horizonActual: 'yearlyOverview.horizon.actual',
    horizonPlus30: 'yearlyOverview.horizon.plus30',
    horizonHardCap: 'yearlyOverview.horizon.hardCap',
    prevYear: 'yearlyOverview.year.previous',
    nextYear: 'yearlyOverview.year.next',
    matrix: 'yearlyOverview.matrix',
    projectionNote: 'yearlyOverview.projectionNote',
    projectionTruncatedNote: 'yearlyOverview.projectionTruncatedNote',
    // 列見出しのタップ（年間 = 月末の基準日でホームへ / 全体 = その年の年間表示へ）
    monthColumn: 'yearlyOverview.monthColumn',
    yearColumn: 'yearlyOverview.yearColumn',
  },
  // 横軸=時間、縦軸=勘定科目の箱。保存データを変更しない閲覧専用の地図。
  timeline: {
    view: 'timeline.view',
    zoomDay: 'timeline.zoom.day',
    zoomMonth: 'timeline.zoom.month',
    zoomYear: 'timeline.zoom.year',
    previous: 'timeline.range.previous',
    next: 'timeline.range.next',
    showEnded: 'timeline.showEnded',
    viewport: 'timeline.viewport',
    boxRow: 'timeline.box.row',
    boxToggle: 'timeline.box.toggle',
    detailRow: 'timeline.detail.row',
    band: 'timeline.band',
    flowDot: 'timeline.dot.flow',
    generationDot: 'timeline.dot.generation',
    popover: 'timeline.popover',
    flowList: 'timeline.popover.flows',
    open: 'timeline.popover.open',
  },
  journal: {
    view: 'journal.view',
    list: 'journal.entry.list',
    // 検索・並び替え・絞り込みの額縁（sticky。仕訳カードだけが下を流れる）
    filterFrame: 'journal.filterFrame',
    search: 'journal.search',
    clearAccountFilter: 'journal.filter.clearAccount',
    clearNormalExpenseFilter: 'journal.filter.clearNormalExpense',
    showFuture: 'journal.filter.showFuture',
    // 表示専用の並び替え（C-4）と抽出結果の件数+合計（C-3）。
    sortByDate: 'journal.sort.date',
    sortByAmount: 'journal.sort.amount',
    // 名称軸 = 摘要の五十音順（月割り台帳の「名称」と同じ語彙・同じ正本 LIST_SORT_AXES）。
    sortByName: 'journal.sort.name',
    sortDesc: 'journal.sort.desc',
    sortAsc: 'journal.sort.asc',
    summary: 'journal.summary',
    entry: {
      save: 'journal.entry.save',
      // 固定額振替の「振替せずに実行」（費用・収入の終了のみ）
      transferSkip: 'journal.entry.transferSkip',
      cancel: 'journal.entry.cancel',
      delete: 'journal.entry.delete',
      reverse: 'journal.entry.reverse',
      // 反対仕訳シートの「取消済み / 残り」行（取消が 0 件なら出ない）と、
      // 入力額が残りを超えたときの注意（警告のみ・保存は止めない）
      reversalSummary: 'journal.entry.reversal.summary',
      reversalOverWarning: 'journal.entry.reversal.overWarning',
      detailToggle: 'journal.entry.detailToggle',
      manualSwitch: 'journal.entry.manualSwitch',
      monthlyizeRepayToggle: 'journal.entry.monthlyizeRepayToggle',
      monthlyizeRepayAccount: 'journal.entry.monthlyizeRepayAccount',
      monthlyizeRepayCount: 'journal.entry.monthlyizeRepayCount',
      monthlyizeRepayStart: 'journal.entry.monthlyizeRepayStart',
      ccToggle: 'journal.entry.ccToggle',
      ccName: 'journal.entry.ccName',
      ccCategory: 'journal.entry.ccCategory',
      ccEndDate: 'journal.entry.ccEndDate',
      loanArrange: 'journal.entry.loanArrange',
      liabilityCreate: 'journal.entry.liabilityCreate',
      liabilityCreateName: 'journal.entry.liabilityCreate.name',
      liabilityCreateRole: 'journal.entry.liabilityCreate.role',
      liabilityCreateSave: 'journal.entry.liabilityCreate.save',
      date: 'journal.entry.date',
      description: 'journal.entry.description',
      item: 'journal.entry.item',
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
    box: 'accounts.box',
    // 残高調整科目（system-adjustment）の「自動」バッジ。表示のみ＝管理操作は出さない
    systemBadge: 'accounts.systemBadge',
    adjust: 'accounts.adjust',
    // 終了/解除ボタン（tonal の文字ボタン・v13.2）。残高が残る資産・負債は振替シート（EntrySheet transfer 再利用）を経由する
    archiveToggle: 'accounts.archiveToggle',
    // 残高 0 の終了 / 解除の確認（残高が残る科目は振替シートが確認を兼ねる）
    archiveConfirm: 'accounts.archiveConfirm',
    unarchiveConfirm: 'accounts.unarchiveConfirm',
    // 削除は編集シート最下部（動詞体系 v13.1）: 未使用なら活性・使用中は件数つきで不活性
    delete: 'accounts.delete',
    deleteConfirm: 'accounts.deleteConfirm',
    openingAmount: 'accounts.openingAmount',
    openingDate: 'accounts.openingDate',
    startDate: 'accounts.startDate',
    endDate: 'accounts.endDate',
    archiveRenameConfirm: 'accounts.archiveRenameConfirm',
    // 「自由に動かせる」チェック（現預金の内訳のみ・OFF = 資金繰りの原資に数えない）
    // 返済設定（負債の編集シートのみ）
    repaymentAccount: 'accounts.repaymentAccount',
    repaymentDay: 'accounts.repaymentDay',
    // 投資の利回り投影（投資科目の編集シートのみ・年率% ⇄ bp + 計上先セレクタ）
    annualReturn: 'accounts.annualReturn',
    projectionAccount: 'accounts.projectionAccount',
    // 並び替えモード（箱内・上下ボタン式）
    reorderToggle: 'accounts.reorder.toggle',
    moveUp: 'accounts.reorder.up',
    moveDown: 'accounts.reorder.down',
  },
  allocations: {
    view: 'allocations.view',
    // 検索・並び替え・「終了分も表示」の額縁（sticky。ルール/item カードだけが下を流れる）
    filterFrame: 'allocations.filterFrame',
    search: 'allocations.search',
    searchEmpty: 'allocations.searchEmpty',
    searchCount: 'allocations.searchCount',
    sortByDate: 'allocations.sort.date',
    sortByAmount: 'allocations.sort.amount',
    sortByName: 'allocations.sort.name',
    sortDesc: 'allocations.sort.desc',
    sortAsc: 'allocations.sort.asc',
    list: 'allocations.list',
    // 継続コスト資産の 1 項目カード（data-ending="true" = 終了まで1ヶ月以内）
    item: 'allocations.item',
    // 終了した定期ルールと継続コスト資産を再表示する共通トグル
    showCompleted: 'allocations.showCompleted',
    // 統一追加フロー（2択: .rule = くり返し記帳 / .asset = 継続コスト資産の持ち込み）
    unifiedAdd: 'allocations.add',
    addChooser: 'allocations.add.chooser',
    // 定期ルール（くり返し記帳。費用行きは自動で継続コスト化）
    recurringList: 'allocations.recurring.list',
    recurringAdd: 'allocations.recurring.add',
    recurringSheet: 'allocations.recurring.sheet',
    recurringName: 'allocations.recurring.name',
    recurringAmount: 'allocations.recurring.amount',
    recurringEvery: 'allocations.recurring.every',
    recurringFirstPostingDate: 'allocations.recurring.firstPostingDate',
    recurringFlow: 'allocations.recurring.flow',
    recurringFirstPosting: 'allocations.recurring.firstPosting',
    recurringFirstPostingStatus: 'allocations.recurring.firstPostingStatus',
    recurringStartDate: 'allocations.recurring.startDate',
    // 編集 = 全期間の引き直しの予告（過去の起票数つき・編集時のみ）
    recurringEditRetroactiveNote: 'allocations.recurring.editRetroactiveNote',
    // 存在期間（開始日・終了日）の折りたたみ（編集時のみ・新規は開始 = 初回起票日で自動)
    recurringDetailsToggle: 'allocations.recurring.detailsToggle',
    recurringEndDate: 'allocations.recurring.endDate',
    // ルールの終了日の解除（iOS date input にクリア手段が無いための明示ボタン）
    recurringEndDateClear: 'allocations.recurring.endDateClear',
    recurringFrom: 'allocations.recurring.from',
    recurringTo: 'allocations.recurring.to',
    recurringSave: 'allocations.recurring.save',
    recurringAmountChangeDialog: 'allocations.recurring.amountChange.dialog',
    recurringAmountChangeAll: 'allocations.recurring.amountChange.all',
    recurringAmountChangeFromToday: 'allocations.recurring.amountChange.fromToday',
    recurringAmountChangeCancel: 'allocations.recurring.amountChange.cancel',
    // 編集は行そのもののタップ（編集アイコンは置かない）。
    // 終了 = 排他的終点を打つ。同じ設定で新しく始める = 系譜なしの独立ルール作成。
    // どちらも無確認では実行しない（終了は終了日シート・再開は確認ダイアログ）。
    recurringEnd: 'allocations.recurring.end',
    // 操作ボタンが出ない行の状態チップ（同じ位置・縦揃えを崩さない）
    recurringStatus: 'allocations.recurring.status',
    recurringEndSheet: 'allocations.recurring.endSheet',
    recurringEndSheetDate: 'allocations.recurring.endSheet.date',
    recurringEndSheetConfirm: 'allocations.recurring.endSheet.confirm',
    // 切り替え = この日から別の線分（編集 = 全期間の引き直しとは別の動詞）。
    // シートそのものが確認面なので前置きの確認ダイアログは無い。
    recurringSwitch: 'allocations.recurring.switch',
    recurringSwitchSheet: 'allocations.recurring.switchSheet',
    recurringSwitchDate: 'allocations.recurring.switchSheet.date',
    recurringSwitchAmount: 'allocations.recurring.switchSheet.amount',
    recurringSwitchDayOfMonth: 'allocations.recurring.switchSheet.dayOfMonth',
    recurringSwitchEvery: 'allocations.recurring.switchSheet.every',
    recurringSwitchPreview: 'allocations.recurring.switchSheet.preview',
    recurringSwitchConfirm: 'allocations.recurring.switchSheet.confirm',
    // 配分中 item の清算パネル（切り替えシート・終了シートで共通）。
    // item 行は data-item-id で個別に引く（同じ data-ui が item のぶんだけ並ぶ）。
    recurringSettlement: 'allocations.recurring.settlement',
    recurringSettlementItem: 'allocations.recurring.settlement.item',
    recurringSettlementKeep: 'allocations.recurring.settlement.keep',
    recurringSettlementEnd: 'allocations.recurring.settlement.end',
    recurringSettlementRecoveryAmount: 'allocations.recurring.settlement.recoveryAmount',
    recurringSettlementRecoveryTo: 'allocations.recurring.settlement.recoveryTo',
    recurringSettlementRemainder: 'allocations.recurring.settlement.remainder',
    recurringSettlementRemainderSpread: 'allocations.recurring.settlement.remainder.spread',
    recurringSettlementRemainderExpense: 'allocations.recurring.settlement.remainder.expense',
    // 終了の Undo（編集シート下部・終了済みのときだけ表示）。
    recurringClearEndDate: 'allocations.recurring.clearEndDate',
    recurringClearEndDateConfirm: 'allocations.recurring.clearEndDate.confirm',
    // 削除はカスケード（ルール + 起票済みの仕訳・持ち物）。確認に起票回数を出す。
    recurringDelete: 'allocations.recurring.delete',
    // 継続コスト資産シート（登録＝編集の 1 コンポーネント）。
    // 編集の入口は item カードそのもののタップ（編集アイコンは置かない）。
    editDialog: 'allocations.editDialog',
    editName: 'allocations.edit.name',
    editAmount: 'allocations.edit.amount',
    editStartDate: 'allocations.edit.startDate',
    editEndDate: 'allocations.edit.endDate',
    // 終了日の解除（iOS date input にクリア手段が無いための明示ボタン）
    editEndDateClear: 'allocations.edit.endDateClear',
    editQuickSpan: 'allocations.edit.quickSpan',
    editOpenPurchase: 'allocations.edit.openPurchase',
    editExpense: 'allocations.edit.expense',
    editSave: 'allocations.edit.save',
    editImpactWarning: 'allocations.edit.impactWarning',
    // 削除は編集シート最下部（動詞体系 v13.1）。行アクションには置かない。
    editDelete: 'allocations.edit.delete',
    // 終了 = 終了日の設定 + 残存価値の始末を 1 枚で決めるシート（シート自体が確認面）。
    archive: 'allocations.archive',
    archiveDialog: 'allocations.archiveDialog',
    archiveDate: 'allocations.archive.date',
    // 回収額（既定 = 終了日時点の残存価値・0 も超過も可）と回収先（0 なら回収先は出さない）
    archiveRecoveryAmount: 'allocations.archive.recoveryAmount',
    archiveRecoveryTo: 'allocations.archive.recoveryTo',
    // 残り（残存価値 − 回収額）の扱い: 期間に割り振る（既定）/ 終了日に全額費用にする
    archiveRemainder: 'allocations.archive.remainder',
    archiveRemainderSpread: 'allocations.archive.remainder.spread',
    archiveRemainderExpense: 'allocations.archive.remainder.expense',
    archiveConfirm: 'allocations.archive.confirm',
  },
  // 残高補正・初期残高のシート（勘定科目の内訳行・仕訳一覧から開く）。
  adjustments: {
    account: 'adjust.account',
    date: 'adjust.date',
    actual: 'adjust.actual',
    save: 'adjust.save',
    createDialog: 'adjustments.createDialog',
    // 履歴の無い科目の「補正」導線は初期残高登録へ自動分岐する
    openingRegisterDialog: 'adjustments.openingRegister.dialog',
    openingRegisterAmount: 'adjustments.openingRegister.amount',
    openingRegisterDate: 'adjustments.openingRegister.date',
    openingRegisterSave: 'adjustments.openingRegister.save',
    rowEdit: 'adjustments.row.edit',
    editDialog: 'adjustments.editDialog',
    editAccount: 'adjustments.edit.account',
    editDate: 'adjustments.edit.date',
    editActual: 'adjustments.edit.actual',
    editSave: 'adjustments.edit.save',
    // 削除は編集シート最下部（動詞体系 v13.1）。行アクションには置かない。
    editDelete: 'adjustments.edit.delete',
    deleteConfirm: 'adjustments.deleteConfirm',
    openingRowEdit: 'opening.row.edit',
    openingEditDialog: 'opening.editDialog',
    openingEditAmount: 'opening.edit.amount',
    openingEditDate: 'opening.edit.date',
    openingEditSave: 'opening.edit.save',
    openingEditDelete: 'opening.edit.delete',
    openingDeleteConfirm: 'opening.deleteConfirm',
  },
  cashflow: {
    view: 'cashflow.view',
    liabilityList: 'cashflow.liability.list',
    // カード・ローンの返済計画づくり（負債行から開く）
    repayAdd: 'cashflow.repay.add',
    liabilityRow: 'cashflow.liability.row',
    repaySheet: 'cashflow.repay.sheet',
    repayAmount: 'cashflow.repay.amount',
    repayDate: 'cashflow.repay.date',
    repayFrom: 'cashflow.repay.from',
    repayCount: 'cashflow.repay.count',
    repayPerMonth: 'cashflow.repay.perMonth',
    repaySave: 'cashflow.repay.save',
    // 自由に動かせるお金の日次折れ線（基準日起点・右へ横スクロール）と、窓を +12ヶ月 伸ばす操作
    freeTrend: 'cashflow.freeTrend',
    chartViewport: 'cashflow.chart.viewport',
    chartExtend: 'cashflow.chart.extend',
    // 基準日以降で最初に 0 を下回る日（下回りが無いときは静かな 1 行が同じ場所に出る）
    shortfall: 'cashflow.shortfall',
    futureList: 'cashflow.future.list',
    // 将来行（タップで編集 or 由来へ・entryOpenPlan 消費）
    futureRow: 'cashflow.future.row',
    summary: 'cashflow.summary',
    // 負債行の展開 = 登録済みの返済（未来日付の保存仕訳）。タップで仕訳の編集シートへ
    repaymentsToggle: 'cashflow.repayments.toggle',
    repaymentsList: 'cashflow.repayments.list',
    repaymentRow: 'cashflow.repayments.row',
  },
  settings: {
    view: 'settings.view',
    fractionDigits: 'settings.fractionDigits',
    exportJson: 'settings.exportJson',
    importJson: 'settings.importJson',
    importFile: 'settings.importFile',
    resetAll: 'settings.resetAll',
    onboardingOpen: 'settings.onboardingOpen',
  },
  nav: {
    // ハンバーガー。フッター右が唯一の置き場所（2026-08-14 ヘッダーから移設・値は据え置き）。
    menuButton: 'nav.menu.button',
    menu: 'nav.menu',
    // 画面下端の固定ナビ（座標検証で上端を取るために nav 要素自体にも付ける）。
    // ホームはフッター中央が唯一（旧ヘッダー左の nav.home は 2026-08-14 撤去）。
    footer: 'nav.footer',
    footerBack: 'nav.footer.back',
    footerHome: 'nav.footer.home',
  },
  dialog: {
    confirm: 'dialog.confirm',
    cancel: 'dialog.cancel',
  },
  // 端末/ブラウザ Back の終了確認（appHistory が管理・オーバーレイ登録簿には載せない）
  app: {
    exitConfirm: 'app.exitConfirm',
    // 台帳が読めない / 描画時例外のときの復旧画面（設定へ入って JSON 読み込み・復元）。
    recovery: 'app.recovery',
    recoverySettings: 'app.recovery.settings',
    // VersionError 詰み対策の最終手段（deleteDatabase → reload）
    recoveryWipe: 'app.recovery.wipe',
  },
  // 初期残高の一括登録シート（初回起動時に自動表示・設定から再表示可能）
  onboarding: {
    view: 'onboarding.view',
    amount: 'onboarding.amount',
    registered: 'onboarding.registered',
    save: 'onboarding.save',
    skip: 'onboarding.skip',
  },
  toast: 'toast',
} as const;
