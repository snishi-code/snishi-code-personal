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
  },
  journal: {
    view: 'journal.view',
    create: 'journal.entry.create',
    list: 'journal.entry.list',
    search: 'journal.search',
    entry: {
      save: 'journal.entry.save',
      cancel: 'journal.entry.cancel',
      delete: 'journal.entry.delete',
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
  },
  accounts: {
    view: 'accounts.view',
    create: 'accounts.create',
    save: 'accounts.save',
    list: 'accounts.list',
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
