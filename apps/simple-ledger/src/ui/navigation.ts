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
  | 'allocations'
  | 'cashflow'
  | 'accounts'
  | 'settings';

/**
 * 時間の窓を描く画面（ウィンドウ世界）。ヘッダーのズーム（日/月/年）が点灯するのはここだけで、
 * 断面画面（ある 1 日を見る画面）では消灯する。
 * `timeline` が時間平面の正本＝断面画面からズームを押したときの行き先。
 */
export const TIME_PLANE_SCREEN = 'timeline' satisfies Screen;
const ZOOMABLE_SCREENS: readonly Screen[] = [TIME_PLANE_SCREEN, 'cashflow'];

export function supportsTimeZoom(screen: Screen): boolean {
  return ZOOMABLE_SCREENS.includes(screen);
}

export interface NavItem {
  screen: Screen;
  labelKey: MessageKey;
  icon: IconName;
}

/**
 * ハンバーガーメニューのトップレベル項目。
 * ホームとは独立した俯瞰画面と、管理・補助機能を並べる。
 * 年間・全体は画面ごと廃止し、タイムライン（時間平面）の数値レンズへ吸収した
 * （時間のズームは場所ではない・2026-08-14 / レンズ化は v13.5 D・2026-08-18）。
 */
export const NAV_ITEMS: NavItem[] = [
  { screen: 'timeline', labelKey: 'nav.timeline', icon: 'calendar' },
  { screen: 'allocations', labelKey: 'nav.allocations', icon: 'calendar' },
  { screen: 'cashflow', labelKey: 'nav.cashflow', icon: 'trending' },
  { screen: 'accounts', labelKey: 'nav.accounts', icon: 'wallet' },
  { screen: 'settings', labelKey: 'nav.settings', icon: 'settings' },
];
