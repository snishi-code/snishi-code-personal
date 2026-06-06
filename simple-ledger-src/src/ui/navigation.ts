import type { IconName } from './Icon';
import type { MessageKey } from '../i18n';

export type Screen =
  | 'dashboard'
  | 'journal'
  | 'statements'
  | 'allocations'
  | 'cashflow'
  | 'tags'
  | 'adjustments'
  | 'accounts'
  | 'settings';

export interface NavItem {
  screen: Screen;
  labelKey: MessageKey;
  icon: IconName;
}

/**
 * ハンバーガーメニューのトップレベル項目。
 * 主要動線だけに絞り、財務諸表/勘定科目/タグ/残高補正は設定配下へ移す
 * （画面自体は残し、Settings の「管理」セクションから遷移する）。
 */
export const NAV_ITEMS: NavItem[] = [
  { screen: 'dashboard', labelKey: 'nav.dashboard', icon: 'home' },
  { screen: 'journal', labelKey: 'nav.journal', icon: 'list' },
  { screen: 'allocations', labelKey: 'nav.allocations', icon: 'calendar' },
  { screen: 'cashflow', labelKey: 'nav.cashflow', icon: 'trending' },
  { screen: 'settings', labelKey: 'nav.settings', icon: 'settings' },
];

/** 設定画面「管理」セクションから遷移する補助画面。 */
export const MANAGEMENT_ITEMS: NavItem[] = [
  { screen: 'statements', labelKey: 'nav.statements', icon: 'chart' },
  { screen: 'accounts', labelKey: 'nav.accounts', icon: 'wallet' },
  { screen: 'tags', labelKey: 'nav.tags', icon: 'tag' },
  { screen: 'adjustments', labelKey: 'nav.adjustments', icon: 'adjust' },
];
