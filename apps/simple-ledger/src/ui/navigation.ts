import type { IconName } from '@snishi/foundation/ui/Icon';
import type { MessageKey } from '../i18n';

export type Screen =
  | 'dashboard'
  | 'incomeBreakdown'
  | 'expenseBreakdown'
  | 'netIncome'
  | 'assetsBreakdown'
  | 'liabilitiesBreakdown'
  | 'netAssets'
  | 'journal'
  | 'allocations'
  | 'cashflow'
  | 'tags'
  | 'accounts'
  | 'wallets'
  | 'settings';

export interface NavItem {
  screen: Screen;
  labelKey: MessageKey;
  icon: IconName;
}

/**
 * ハンバーガーメニューのトップレベル項目（管理・補助機能に絞る）。
 */
export const NAV_ITEMS: NavItem[] = [
  { screen: 'allocations', labelKey: 'nav.allocations', icon: 'calendar' },
  { screen: 'cashflow', labelKey: 'nav.cashflow', icon: 'trending' },
  { screen: 'accounts', labelKey: 'nav.accounts', icon: 'wallet' },
  { screen: 'settings', labelKey: 'nav.settings', icon: 'settings' },
];

/**
 * 設定画面「管理」セクションから遷移する補助画面。
 */
export const MANAGEMENT_ITEMS: NavItem[] = [
  { screen: 'wallets', labelKey: 'nav.wallets', icon: 'wallet' },
  { screen: 'tags', labelKey: 'nav.tags', icon: 'tag' },
];
