import type { IconName } from './Icon';
import type { MessageKey } from '../i18n';

export type Screen =
  | 'dashboard'
  // ホーム各項目の遷移先（旧・財務諸表を項目ごとの「内訳 + 推移」に分解したもの）
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
 * 収入/支出/収支/資産/負債/純資産の内訳=ホームの各項目から辿るため、メニューには置かない。
 * 勘定科目/タグ/残高補正は Settings の「管理」セクション。
 */
export const NAV_ITEMS: NavItem[] = [
  { screen: 'allocations', labelKey: 'nav.allocations', icon: 'calendar' },
  { screen: 'cashflow', labelKey: 'nav.cashflow', icon: 'trending' },
  { screen: 'settings', labelKey: 'nav.settings', icon: 'settings' },
];

/**
 * 設定画面「管理」セクションから遷移する補助画面。
 * 各内訳ページ（収入/支出/資産/負債/純資産・収支）はここに含めない（ホームの各項目から辿る）。
 */
export const MANAGEMENT_ITEMS: NavItem[] = [
  { screen: 'accounts', labelKey: 'nav.accounts', icon: 'wallet' },
  { screen: 'wallets', labelKey: 'nav.wallets', icon: 'wallet' },
  { screen: 'tags', labelKey: 'nav.tags', icon: 'tag' },
  { screen: 'adjustments', labelKey: 'nav.adjustments', icon: 'adjust' },
];
