import { describe, expect, it } from 'vitest';
import { t } from '../src/i18n';
import { NAV_ITEMS } from '../src/ui/navigation';

describe('ハンバーガーメニューのナビゲーション', () => {
  it('年間・全体を独立画面として公開する', () => {
    const item = NAV_ITEMS.find(({ screen }) => screen === 'yearlyOverview');

    expect(item).toEqual({
      screen: 'yearlyOverview',
      labelKey: 'nav.yearlyOverview',
      icon: 'chart',
    });
    expect(t(item!.labelKey)).toBe('年間・全体');
  });

  it('画面キーを重複させない', () => {
    const screens = NAV_ITEMS.map(({ screen }) => screen);
    expect(new Set(screens).size).toBe(screens.length);
  });
});
