import type { IconName } from './Icon';
import type { MessageKey } from '../i18n';

export type Screen =
  | 'dashboard'
  | 'expenseBreakdown'
  | 'journal'
  | 'statements'
  | 'allocations'
  | 'cashflow'
  | 'tags'
  | 'adjustments'
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
 * ホーム=ヘッダーのホームアイコン、仕訳=ホーム下部「当月の仕訳」やドリルダウン、
 * 財務諸表=ホームの PL/BS から辿るため、メニューには置かない。
 * 勘定科目/タグ/残高補正は Settings の「管理」セクション。
 */
export const NAV_ITEMS: NavItem[] = [
  { screen: 'allocations', labelKey: 'nav.allocations', icon: 'calendar' },
  { screen: 'cashflow', labelKey: 'nav.cashflow', icon: 'trending' },
  { screen: 'settings', labelKey: 'nav.settings', icon: 'settings' },
];

/**
 * 設定画面「管理」セクションから遷移する補助画面。
 * 財務諸表(statements)はここに含めない（ホームの PL/BS サマリーから辿る）。
 */
export const MANAGEMENT_ITEMS: NavItem[] = [
  { screen: 'accounts', labelKey: 'nav.accounts', icon: 'wallet' },
  { screen: 'wallets', labelKey: 'nav.wallets', icon: 'wallet' },
  { screen: 'tags', labelKey: 'nav.tags', icon: 'tag' },
  { screen: 'adjustments', labelKey: 'nav.adjustments', icon: 'adjust' },
];
