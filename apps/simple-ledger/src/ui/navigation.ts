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
  | 'timeline'
  | 'yearlyOverview'
  | 'allocations'
  | 'cashflow'
  | 'tags'
  | 'accounts'
  | 'settings';

export interface NavItem {
  screen: Screen;
  labelKey: MessageKey;
  icon: IconName;
}

/**
 * ハンバーガーメニューのトップレベル項目。
 * ホームとは独立した俯瞰画面と、管理・補助機能を並べる。
 * 年間・全体はヘッダーの粒度セグメントへ移設した（時間のズームは場所ではない・2026-08-14）。
 */
export const NAV_ITEMS: NavItem[] = [
  { screen: 'timeline', labelKey: 'nav.timeline', icon: 'calendar' },
  { screen: 'allocations', labelKey: 'nav.allocations', icon: 'calendar' },
  { screen: 'cashflow', labelKey: 'nav.cashflow', icon: 'trending' },
  { screen: 'accounts', labelKey: 'nav.accounts', icon: 'wallet' },
  { screen: 'settings', labelKey: 'nav.settings', icon: 'settings' },
];

/**
 * 設定画面「管理」セクションから遷移する補助画面。
 */
export const MANAGEMENT_ITEMS: NavItem[] = [{ screen: 'tags', labelKey: 'nav.tags', icon: 'tag' }];
