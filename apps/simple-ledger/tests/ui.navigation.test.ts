import { describe, expect, it } from 'vitest';
import { t } from '../src/i18n';
import { NAV_ITEMS, TIME_PLANE_SCREEN, supportsTimeZoom } from '../src/ui/navigation';

describe('ハンバーガーメニューのナビゲーション', () => {
  it('メニューは 6 項目（年間・全体は時間平面の数値レンズへ吸収済み・まとめて登録は v13.10）', () => {
    expect(NAV_ITEMS.map(({ screen }) => screen)).toEqual([
      'timeline',
      'allocations',
      'cashflow',
      'accounts',
      'pasteImport',
      'settings',
    ]);
    // 表示名は i18n から引ける（キーの取り違えを落とす）。
    expect(NAV_ITEMS.map((item) => t(item.labelKey))).not.toContain('');
  });

  it('画面キーを重複させない', () => {
    const screens = NAV_ITEMS.map(({ screen }) => screen);
    expect(new Set(screens).size).toBe(screens.length);
  });
});

describe('ウィンドウ世界の名乗り', () => {
  it('ズームが点灯するのは時間の窓を描く画面だけ（断面画面では消灯）', () => {
    expect(supportsTimeZoom('timeline')).toBe(true);
    expect(supportsTimeZoom('cashflow')).toBe(true);
    for (const screen of ['dashboard', 'journal', 'allocations', 'accounts', 'settings'] as const) {
      expect(supportsTimeZoom(screen), `${screen} は断面画面`).toBe(false);
    }
  });

  it('断面画面からズームを押したときの行き先は時間平面', () => {
    expect(TIME_PLANE_SCREEN).toBe('timeline');
    expect(supportsTimeZoom(TIME_PLANE_SCREEN)).toBe(true);
  });
});
