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

test('ホームに重大なアクセシビリティ違反がない', async ({ page }) => {
  await page.goto('./');
  await page.locator('[data-ui="dashboard.view"]').waitFor();
  await checkNoSerious(() => new AxeBuilder({ page }));
});

test('支出入力シート（チップピッカー）に重大なアクセシビリティ違反がない', async ({ page }) => {
  await page.goto('./');
  await page.locator('[data-ui="dashboard.entry.expense"]').click();
  await page.getByRole('dialog').waitFor();
  await checkNoSerious(() => new AxeBuilder({ page }));
});

test('入力の種類シートに重大なアクセシビリティ違反がない', async ({ page }) => {
  await page.goto('./');
  await page.locator('[data-ui="journal.entry.create"]').first().click(); // ヘッダー +
  await page.locator('[data-ui="entry.type.sheet"]').waitFor();
  await checkNoSerious(() => new AxeBuilder({ page }));
});

test('設定画面に重大なアクセシビリティ違反がない', async ({ page }) => {
  await page.goto('./');
  await page.locator('[data-ui="nav.menu.button"]').click();
  await page.locator('[data-ui="nav.settings"]').click();
  await page.locator('[data-ui="settings.view"]').waitFor();
  await checkNoSerious(() => new AxeBuilder({ page }));
});
