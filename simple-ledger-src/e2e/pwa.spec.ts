/*
 * PWA E2E: 本番ビルド(preview)に対して、
 *  - Web App Manifest が installable な内容で読める
 *  - Service Worker が登録・有効化され、ページを制御する
 *  - オフラインでも app shell が起動する（同一オリジンのみキャッシュ）
 * を検証する。
 */
import { test, expect } from '@playwright/test';

test('manifest が installable な内容で読める', async ({ page }) => {
  await page.goto('./');
  const href = await page.locator('link[rel="manifest"]').getAttribute('href');
  expect(href).toBeTruthy();
  const res = await page.request.get(new URL(href!, page.url()).toString());
  expect(res.ok()).toBeTruthy();
  const m = await res.json();
  expect(m.name).toBeTruthy();
  expect(m.start_url).toBeTruthy();
  expect(m.display).toBe('standalone');
  expect(m.scope).toContain('/simple-ledger/');
  // 192/512 のアイコンが揃っている（installability 要件）
  const sizes = (m.icons as { sizes: string }[]).map((i) => i.sizes);
  expect(sizes).toContain('192x192');
  expect(sizes).toContain('512x512');
});

test('Service Worker が登録され、ページを制御する', async ({ page }) => {
  await page.goto('./');
  // 登録 + activated まで待つ
  const scope = await page.evaluate(async () => {
    const reg = await navigator.serviceWorker.ready;
    return reg.scope;
  });
  expect(scope).toContain('/simple-ledger/');

  // clients.claim() によりこのページが制御される
  await page.waitForFunction(() => navigator.serviceWorker.controller !== null, null, {
    timeout: 10_000,
  });
  const controlled = await page.evaluate(() => navigator.serviceWorker.controller !== null);
  expect(controlled).toBe(true);
});

test('オフラインでも app shell が起動する', async ({ page, context }) => {
  // 1 回目: SW 登録 → 制御開始。アセットがランタイムキャッシュに入る。
  await page.goto('./');
  await page.evaluate(() => navigator.serviceWorker.ready);
  await page.waitForFunction(() => navigator.serviceWorker.controller !== null, null, {
    timeout: 10_000,
  });
  // SW 制御下でアセットがキャッシュされるよう、一度リロード
  await page.reload();
  await expect(page.locator('[data-ui="dashboard.view"]')).toBeVisible();

  // オフラインにして再読込 → それでも起動する
  await context.setOffline(true);
  try {
    await page.reload();
    await expect(page.locator('[data-ui="dashboard.view"]')).toBeVisible({ timeout: 10_000 });
  } finally {
    await context.setOffline(false);
  }
});
