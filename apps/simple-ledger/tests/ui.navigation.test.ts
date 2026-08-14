import { describe, expect, it } from 'vitest';
import { t } from '../src/i18n';
import { NAV_ITEMS } from '../src/ui/navigation';

describe('ハンバーガーメニューのナビゲーション', () => {
  it('メニューは 5 項目（年間・全体はヘッダーの粒度セグメントへ移設済み）', () => {
    expect(NAV_ITEMS.map(({ screen }) => screen)).toEqual([
      'timeline',
      'allocations',
      'cashflow',
      'accounts',
      'settings',
    ]);
    // 時間のズームは「場所」ではないのでメニューに項目を持たない。
    expect(NAV_ITEMS.some(({ screen }) => screen === 'yearlyOverview')).toBe(false);
    // 表示名は i18n から引ける（キーの取り違えを落とす）。
    expect(NAV_ITEMS.map((item) => t(item.labelKey))).not.toContain('');
  });

  it('画面キーを重複させない', () => {
    const screens = NAV_ITEMS.map(({ screen }) => screen);
    expect(new Set(screens).size).toBe(screens.length);
  });
});
