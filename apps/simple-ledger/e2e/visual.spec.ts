/*
 * visual check（仕様§19）: mobile/tablet/desktop の 3 サイズで主要画面を撮影し、
 * 横スクロール（レイアウト破綻の代表症状）が無いことを機械検証する。
 * スクリーンショットは test-results/screenshots/ 配下に保存する。
 */
import { test, expect, type Page } from '@playwright/test';

const ui = (name: string) => `[data-ui="${name}"]`;

const VIEWPORTS = [
  { name: 'mobile-390x844', width: 390, height: 844 },
  { name: 'tablet-820x1180', width: 820, height: 1180 },
  { name: 'desktop-1280x800', width: 1280, height: 800 },
] as const;

async function expectNoHorizontalScroll(page: Page, label: string) {
  const overflow = await page.evaluate(() => {
    const el = document.scrollingElement ?? document.documentElement;
    return el.scrollWidth - el.clientWidth;
  });
  expect(overflow, `${label}: 横スクロールが発生 (${overflow}px)`).toBeLessThanOrEqual(1);
}

for (const vp of VIEWPORTS) {
  test(`主要画面のレイアウト確認 (${vp.name})`, async ({ page }) => {
    await page.setViewportSize({ width: vp.width, height: vp.height });
    await page.goto('./');
    await expect(page.locator(ui('dashboard.view'))).toBeVisible({ timeout: 15_000 });

    // 空画面だけでなくデータのある画面も確認するため、仕訳を 1 件作る
    await page.locator(ui('dashboard.entry.expense')).click();
    await page.locator(ui('journal.entry.item')).fill('視覚確認用');
    await page.locator(ui('journal.entry.amount')).fill('1200');
    await page.locator(`${ui('journal.entry.flow.source')} label.chip`).first().click();
    await page.locator(`${ui('journal.entry.flow.destination')} label.chip`).first().click();
    await page.locator(ui('journal.entry.save')).click();
    await expect(page.locator(ui('journal.entry.save'))).toBeHidden();

    await expectNoHorizontalScroll(page, `dashboard ${vp.name}`);
    await page.screenshot({
      path: `test-results/screenshots/ledger-dashboard-${vp.name}.png`,
      fullPage: true,
    });

    // 仕訳一覧（ホームの「すべて表示」から）
    await page.locator(ui('dashboard.journal.openAll')).click();
    await expect(page.locator(ui('journal.view'))).toBeVisible();
    await expectNoHorizontalScroll(page, `journal ${vp.name}`);
    await page.screenshot({
      path: `test-results/screenshots/ledger-journal-${vp.name}.png`,
      fullPage: true,
    });

    // 入力シート（支出）
    await page.locator(ui('nav.home')).click();
    await expect(page.locator(ui('dashboard.view'))).toBeVisible();
    await page.locator(ui('dashboard.entry.expense')).click();
    await expect(page.locator(ui('journal.entry.save'))).toBeVisible();
    await expectNoHorizontalScroll(page, `entrySheet ${vp.name}`);
    await page.screenshot({
      path: `test-results/screenshots/ledger-entrysheet-${vp.name}.png`,
      fullPage: true,
    });
    await page.locator(ui('journal.entry.cancel')).click();

    // 設定
    await page.locator(ui('nav.menu.button')).click();
    await page.locator(ui('nav.settings')).click();
    await expect(page.locator(ui('settings.view'))).toBeVisible();
    await expectNoHorizontalScroll(page, `settings ${vp.name}`);
    await page.screenshot({
      path: `test-results/screenshots/ledger-settings-${vp.name}.png`,
      fullPage: true,
    });
  });
}
