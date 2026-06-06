/*
 * UI contract: テストが依存してよい安定名（data-ui 属性値）。
 *
 * - これらの名前は日本語文言の変更で壊れない契約。Playwright/Testing Library から参照する。
 * - DOM 構造や CSS class には依存させない。
 * - 詳細とポリシーは docs/dev/ui-contract.md。
 */
export const UI = {
  dashboard: {
    view: 'dashboard.view',
    addEntry: 'dashboard.entry.create',
    recentList: 'dashboard.recent.list',
    // 日常入力 3 種（ホーム上部の主導線）
    income: 'dashboard.entry.income',
    expense: 'dashboard.entry.expense',
    transfer: 'dashboard.entry.transfer',
  },
  // ヘッダー + が開く「入力の種類」シートの各ボタン
  entryType: {
    sheet: 'entry.type.sheet',
    income: 'entry.type.income',
    expense: 'entry.type.expense',
    transfer: 'entry.type.transfer',
  },
  journal: {
    view: 'journal.view',
    create: 'journal.entry.create',
    list: 'journal.entry.list',
    search: 'journal.search',
    clearAccountFilter: 'journal.filter.clearAccount',
    showFuture: 'journal.filter.showFuture',
    entry: {
      save: 'journal.entry.save',
      cancel: 'journal.entry.cancel',
      delete: 'journal.entry.delete',
      reverse: 'journal.entry.reverse',
      detailToggle: 'journal.entry.detailToggle',
      allocateToggle: 'journal.entry.allocateToggle',
      allocateMonths: 'journal.entry.allocateMonths',
      date: 'journal.entry.date',
      description: 'journal.entry.description',
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
  },
  allocations: {
    view: 'allocations.view',
    list: 'allocations.list',
    showCompleted: 'allocations.showCompleted',
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
    scheduleInstallments: 'cashflow.schedule.installments',
    summary: 'cashflow.summary',
    addReserve: 'cashflow.reserve.create',
    reserveList: 'cashflow.reserve.list',
    reserveSave: 'cashflow.reserve.save',
    reserveName: 'cashflow.reserve.name',
  },
  settings: {
    view: 'settings.view',
    exportJson: 'settings.exportJson',
    importJson: 'settings.importJson',
    importFile: 'settings.importFile',
    resetAll: 'settings.resetAll',
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
