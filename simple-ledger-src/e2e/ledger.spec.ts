/*
 * E2E: 主要フロー（起動 → 仕訳追加 → 集計反映 → 財務諸表 → export）。
 * 外部送信ゼロも検証する（同一オリジン以外へのリクエストが無いこと）。
 */
import { test, expect, type Request } from '@playwright/test';

// data-ui（UI contract）に依存する。日本語文言の変更で壊れないようにする。
const ui = (name: string) => `[data-ui="${name}"]`;

test('起動してホームが表示される', async ({ page }) => {
  await page.goto('./');
  await expect(page.locator(ui('dashboard.view'))).toBeVisible();
  await expect(page.getByRole('heading', { name: 'ホーム' })).toBeVisible();
});

test('仕訳を追加するとホームと一覧に反映される', async ({ page }) => {
  await page.goto('./');
  await page.locator(ui('journal.entry.create')).first().click();

  await page.locator(ui('journal.entry.description')).fill('テスト支出');
  await page.locator(ui('journal.entry.debitAccount')).selectOption({ label: '食費' });
  await page.locator(ui('journal.entry.creditAccount')).selectOption({ label: '現金' });
  await page.locator(ui('journal.entry.amount')).fill('2500');
  await page.locator(ui('journal.entry.save')).click();

  await expect(page.getByText('テスト支出')).toBeVisible();

  // 仕訳一覧へ移動して確認
  await page.locator(ui('nav.menu.button')).click();
  await page.locator(ui('nav.journal')).click();
  await expect(page.locator(ui('journal.entry.list'))).toContainText('テスト支出');
});

test('財務諸表 PL / BS を切り替えられる', async ({ page }) => {
  await page.goto('./');
  await page.locator(ui('nav.menu.button')).click();
  await page.locator(ui('nav.statements')).click();
  await expect(page.locator(ui('statements.profitAndLoss'))).toBeVisible();
  await page.locator(ui('statements.tab.bs')).click();
  await expect(page.locator(ui('statements.balanceSheet'))).toBeVisible();
});

test('外部オリジンへのリクエストが発生しない（外部送信ゼロ）', async ({ page, baseURL }) => {
  const external: string[] = [];
  const origin = new URL(baseURL ?? 'http://localhost:4173').origin;
  page.on('request', (req: Request) => {
    const url = req.url();
    if (!url.startsWith(origin) && !url.startsWith('data:') && !url.startsWith('blob:')) {
      external.push(url);
    }
  });

  await page.goto('./');
  await page.locator(ui('journal.entry.create')).first().click();
  await page.locator(ui('journal.entry.description')).fill('オフライン確認');
  await page.locator(ui('journal.entry.debitAccount')).selectOption({ label: '食費' });
  await page.locator(ui('journal.entry.creditAccount')).selectOption({ label: '現金' });
  await page.locator(ui('journal.entry.amount')).fill('100');
  await page.locator(ui('journal.entry.save')).click();
  await expect(page.getByText('オフライン確認')).toBeVisible();

  expect(external, `外部リクエスト: ${external.join(', ')}`).toHaveLength(0);
});

test('manifest が読み込める', async ({ page, request }) => {
  await page.goto('./');
  const href = await page.locator('link[rel="manifest"]').getAttribute('href');
  expect(href).toBeTruthy();
  const res = await request.get(new URL(href!, page.url()).toString());
  expect(res.ok()).toBeTruthy();
  const json = await res.json();
  expect(json.scope).toContain('/simple-ledger/');
});
