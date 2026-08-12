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
    // 初回オンボーディングを既読化してから起動する（撮影・クリックを遮らないように）。
    await page.addInitScript(() => localStorage.setItem('slv2.onboardingDone', '1'));
    // sample fixture には継続コスト台帳と movable=false 科目があり、今回追加した意味色も撮影できる。
    await page.goto('./?fixture=sample');
    await expect(page.locator(ui('dashboard.view'))).toBeVisible({ timeout: 15_000 });

    // 現在期間の仕訳導線も確認できるよう、サンプル台帳へ当日分を 1 件追加する。
    await page.locator(ui('dashboard.entry.expense')).click();
    await page.locator(ui('journal.entry.item')).fill('視覚確認用');
    await page.locator(ui('journal.entry.amount')).fill('1200');
    await page
      .locator(`${ui('journal.entry.flow.source')} label.chip`)
      .first()
      .click();
    await page
      .locator(`${ui('journal.entry.flow.destination')} label.chip`)
      .first()
      .click();
    await page.locator(ui('journal.entry.save')).click();
    await expect(page.locator(ui('journal.entry.save'))).toBeHidden();

    await expectNoHorizontalScroll(page, `dashboard ${vp.name}`);
    await page.screenshot({
      path: `test-results/screenshots/ledger-dashboard-${vp.name}.png`,
      fullPage: true,
    });

    // 額縁（収支 + 財政状態の 6 枠）が sticky で固定される（実ユーズ④）。
    // fixture の高さに依存しない機械検証 = computed style。下端スクロール後の
    // toBeInViewport は、スクロールできない高さでも成立する（黙って skip しない）。
    const frameStyle = await page.locator(ui('dashboard.frame')).evaluate((el) => {
      const cs = getComputedStyle(el);
      return { position: cs.position, top: cs.top };
    });
    expect(frameStyle.position, `dashboard frame sticky ${vp.name}`).toBe('sticky');
    expect(frameStyle.top, `dashboard frame top ${vp.name}`).toBe('57px');
    const viewAllBox = await page.locator(ui('dashboard.journal.openAll')).boundingBox();
    expect(viewAllBox?.height ?? 0, `すべて見る 44px ${vp.name}`).toBeGreaterThanOrEqual(44);
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await expect(page.locator(ui('dashboard.stat.revenue'))).toBeInViewport();
    await expect(page.locator(ui('dashboard.stat.assets'))).toBeInViewport();
    await page.evaluate(() => window.scrollTo(0, 0));

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

    // 資産・負債の枠分け（意味色・小計・継続コスト台帳を含む）。
    await page.locator(ui('dashboard.stat.assets')).click();
    await expect(page.locator(ui('assetsBreakdown.view'))).toBeVisible();
    await expectNoHorizontalScroll(page, `assetsBreakdown ${vp.name}`);
    await page.screenshot({
      path: `test-results/screenshots/ledger-assets-${vp.name}.png`,
      fullPage: true,
    });
    await page.locator(ui('nav.home')).click();
    await page.locator(ui('dashboard.stat.liabilities')).click();
    await expect(page.locator(ui('liabilitiesBreakdown.view'))).toBeVisible();
    await expectNoHorizontalScroll(page, `liabilitiesBreakdown ${vp.name}`);
    await page.screenshot({
      path: `test-results/screenshots/ledger-liabilities-${vp.name}.png`,
      fullPage: true,
    });

    // 勘定科目（箱見出しの意味色）。
    await page.locator(ui('nav.menu.button')).click();
    await page.locator(ui('nav.accounts')).click();
    await expect(page.locator(ui('accounts.view'))).toBeVisible();
    await expectNoHorizontalScroll(page, `accounts ${vp.name}`);
    await page.screenshot({
      path: `test-results/screenshots/ledger-accounts-${vp.name}.png`,
      fullPage: true,
    });

    // 年間・全体（ページ全体ではなく表のコンテナだけを横スクロール）。
    await page.locator(ui('nav.menu.button')).click();
    await page.locator(ui('nav.yearlyOverview')).click();
    await expect(page.locator(ui('yearlyOverview.view'))).toBeVisible();
    await expect(page.locator(ui('yearlyOverview.matrix'))).toBeVisible();
    await expectNoHorizontalScroll(page, `yearlyOverview ${vp.name}`);
    if (vp.width === 390) {
      const matrixScrolls = await page.locator(ui('yearlyOverview.matrix')).evaluate((element) => {
        return element.scrollWidth > element.clientWidth;
      });
      expect(matrixScrolls, 'mobile: 年間表のコンテナ内で横スクロールできる').toBe(true);
    }
    await page.screenshot({
      path: `test-results/screenshots/ledger-yearly-overview-${vp.name}.png`,
      fullPage: true,
    });

    // 毎月のもの → くり返し記帳シート: flat 2 列でもシート内に横スクロールが出ない（実ユーズ②）。
    await page.locator(ui('nav.menu.button')).click();
    await page.locator(ui('nav.allocations')).click();
    await expect(page.locator(ui('allocations.view'))).toBeVisible();
    await page.locator(ui('allocations.add')).click();
    await page.locator(ui('allocations.add.chooser.rule')).click();
    await expect(page.locator(ui('allocations.recurring.sheet'))).toBeVisible();
    const sheetOverflow = await page
      .locator(ui('allocations.recurring.sheet'))
      .evaluate((el) => el.scrollWidth - el.clientWidth);
    expect(sheetOverflow, `くり返し記帳シート横スクロール ${vp.name}`).toBeLessThanOrEqual(1);
    await page.keyboard.press('Escape');
    await expect(page.locator(ui('allocations.recurring.sheet'))).toBeHidden();

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

test('タイムラインは 390px でページを横にはみ出さず、表示領域内だけを横スクロールできる', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.addInitScript(() => localStorage.setItem('slv2.onboardingDone', '1'));
  await page.goto('./?fixture=sample');
  await expect(page.locator(ui('dashboard.view'))).toBeVisible({ timeout: 15_000 });

  await page.locator(ui('nav.menu.button')).click();
  await page.locator(ui('nav.timeline')).click();
  await expect(page.locator(ui('timeline.view'))).toBeVisible();

  const viewport = page.locator(ui('timeline.viewport'));
  await expect(viewport).toBeVisible();
  await expectNoHorizontalScroll(page, 'timeline mobile-390x844');
  const viewportScrolls = await viewport.evaluate((element) => {
    return element.scrollWidth > element.clientWidth;
  });
  expect(viewportScrolls, 'mobile: タイムラインの表示領域内で横スクロールできる').toBe(true);
  await page.screenshot({
    path: 'test-results/screenshots/ledger-timeline-mobile-390x844.png',
    fullPage: true,
  });
});
