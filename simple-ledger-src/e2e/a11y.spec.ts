/*
 * アクセシビリティ E2E: 主要画面で axe-core の重大(critical/serious)違反が無いこと。
 */
import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

async function checkNoSerious(makeBuilder: () => AxeBuilder) {
  const results = await makeBuilder().withTags(['wcag2a', 'wcag2aa']).analyze();
  const serious = results.violations.filter(
    (v) => v.impact === 'critical' || v.impact === 'serious',
  );
  const summary = serious.map((v) => `${v.id} (${v.impact})`).join(', ');
  expect(serious, `重大なアクセシビリティ違反: ${summary}`).toHaveLength(0);
}

/**
 * PROD ビルドでは Service Worker の初回 activate → controllerchange で 1 回 reload する。
 * クリック直後の reload でダイアログ（実行コンテキスト）が壊れるのを避けるため、
 * 操作の前に SW の制御確立を待つ。
 */
async function gotoSettled(page: import('@playwright/test').Page) {
  await page.goto('./');
  await page.locator('[data-ui="dashboard.view"]').waitFor();
  await page.waitForFunction(
    () => !('serviceWorker' in navigator) || navigator.serviceWorker.controller != null,
  );
  await page.locator('[data-ui="dashboard.view"]').waitFor();
}

test('ホームに重大なアクセシビリティ違反がない', async ({ page }) => {
  await gotoSettled(page);
  await checkNoSerious(() => new AxeBuilder({ page }));
});

test('支出入力シート（チップピッカー）に重大なアクセシビリティ違反がない', async ({ page }) => {
  await gotoSettled(page);
  await page.locator('[data-ui="dashboard.entry.expense"]').click();
  await page.getByRole('dialog').waitFor();
  await checkNoSerious(() => new AxeBuilder({ page }));
});

test('勘定科目の追加シート（区分・役割）に重大なアクセシビリティ違反がない', async ({ page }) => {
  await gotoSettled(page);
  // 設定 → 管理 → 勘定科目 → 追加
  await page.locator('[data-ui="nav.menu.button"]').click();
  await page.locator('[data-ui="nav.settings"]').click();
  await page.locator('[data-ui="settings.manage.accounts"]').click();
  await page.locator('[data-ui="accounts.create"]').first().click();
  await page.getByRole('dialog').waitFor();
  await checkNoSerious(() => new AxeBuilder({ page }));
});

test('設定画面に重大なアクセシビリティ違反がない', async ({ page }) => {
  await gotoSettled(page);
  await page.locator('[data-ui="nav.menu.button"]').click();
  await page.locator('[data-ui="nav.settings"]').click();
  await page.locator('[data-ui="settings.view"]').waitFor();
  await checkNoSerious(() => new AxeBuilder({ page }));
});
