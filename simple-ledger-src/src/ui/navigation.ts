import type { IconName } from './Icon';
import type { MessageKey } from '../i18n';

export type Screen =
  | 'dashboard'
  | 'journal'
  | 'statements'
  | 'allocations'
  | 'accounts'
  | 'settings';

export interface NavItem {
  screen: Screen;
  labelKey: MessageKey;
  icon: IconName;
}

export const NAV_ITEMS: NavItem[] = [
  { screen: 'dashboard', labelKey: 'nav.dashboard', icon: 'home' },
  { screen: 'journal', labelKey: 'nav.journal', icon: 'list' },
  { screen: 'statements', labelKey: 'nav.statements', icon: 'chart' },
  { screen: 'allocations', labelKey: 'nav.allocations', icon: 'calendar' },
  { screen: 'accounts', labelKey: 'nav.accounts', icon: 'wallet' },
  { screen: 'settings', labelKey: 'nav.settings', icon: 'settings' },
];
