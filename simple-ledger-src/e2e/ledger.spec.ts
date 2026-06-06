/*
 * E2E: 主要フロー（起動 → 支出入力 → 集計反映 → 取消/返金 → ドリルダウン → 財務諸表）。
 * 外部送信ゼロも検証する（同一オリジン以外へのリクエストが無いこと）。
 *
 * 借方/貸方は日常入力に出さない。カテゴリ/支払元などのチップ(radio)で選ぶ。
 */
import { test, expect, type Page, type Request } from '@playwright/test';

const ui = (name: string) => `[data-ui="${name}"]`;

/** チップピッカー（科目）から名前で選ぶ。 */
async function pick(page: Page, fieldUi: string, name: string) {
  await page.locator(ui(fieldUi)).getByText(name, { exact: true }).click();
}

/** 支出を 1 件入力する（カテゴリ=食費 / 支払元=現金）。 */
async function addExpense(page: Page, description: string, amount: string) {
  await page.locator(ui('dashboard.entry.expense')).click();
  await page.locator(ui('journal.entry.description')).fill(description);
  await pick(page, 'journal.entry.debitAccount', '食費');
  await pick(page, 'journal.entry.creditAccount', '現金');
  await page.locator(ui('journal.entry.amount')).fill(amount);
  await page.locator(ui('journal.entry.save')).click();
}

async function openJournal(page: Page) {
  await page.locator(ui('nav.menu.button')).click();
  await page.locator(ui('nav.journal')).click();
}

test('起動してホームが表示される', async ({ page }) => {
  await page.goto('./');
  await expect(page.locator(ui('dashboard.view'))).toBeVisible();
  await expect(page.getByRole('heading', { name: 'ホーム' })).toBeVisible();
});

test('支出を追加するとホームと一覧に反映される', async ({ page }) => {
  await page.goto('./');
  await addExpense(page, 'テスト支出', '2500');

  await expect(page.getByText('テスト支出')).toBeVisible();

  await openJournal(page);
  await expect(page.locator(ui('journal.entry.list'))).toContainText('テスト支出');
});

test('取消/返金で逆仕訳が作られ、元仕訳は残る', async ({ page }) => {
  await page.goto('./');
  await addExpense(page, 'ランチ代', '1200');

  await openJournal(page);
  await page.locator(ui('journal.entry.reverse')).first().click();
  // reversal シートは逆仕訳が埋まっている。そのまま保存。
  await page.locator(ui('journal.entry.save')).click();

  await expect(page.locator(`${ui('journal.entry.list')} > li`)).toHaveCount(2);
  await expect(page.getByText('取消: ランチ代')).toBeVisible();
});

test('按分支出を作成すると按分台帳と生活コストに反映される', async ({ page }) => {
  await page.goto('./');
  await page.locator(ui('dashboard.entry.expense')).click();
  await page.locator(ui('journal.entry.description')).fill('ノートPC');
  await pick(page, 'journal.entry.debitAccount', '食費');
  await pick(page, 'journal.entry.creditAccount', '現金');
  await page.locator(ui('journal.entry.amount')).fill('240000');
  await page.locator(ui('journal.entry.allocateToggle')).check();
  await page.locator(ui('journal.entry.allocateMonths')).fill('48');
  await page.locator(ui('journal.entry.save')).click();

  // 按分台帳に出る（月額目安 5,000）
  await page.locator(ui('nav.menu.button')).click();
  await page.locator(ui('nav.allocations')).click();
  await expect(page.locator(ui('allocations.view'))).toBeVisible();
  await expect(page.locator(ui('allocations.list'))).toContainText('ノートPC');
  await expect(page.locator(ui('allocations.list'))).toContainText('5,000');

  // ダッシュボードの生活コストに月額按分額が反映（240,000 そのものは費用にしない）
  await page.locator(ui('nav.home')).click();
  await expect(page.locator(ui('dashboard.view'))).toContainText('5,000');
});

test('Journal は既定で未来の按分仕訳を隠し、トグルで表示する', async ({ page }) => {
  await page.goto('./');
  await page.locator(ui('dashboard.entry.expense')).click();
  await page.locator(ui('journal.entry.description')).fill('スマホ分割');
  await pick(page, 'journal.entry.debitAccount', '食費');
  await pick(page, 'journal.entry.creditAccount', '現金');
  await page.locator(ui('journal.entry.amount')).fill('120000');
  await page.locator(ui('journal.entry.allocateToggle')).check();
  await page.locator(ui('journal.entry.allocateMonths')).fill('12');
  await page.locator(ui('journal.entry.save')).click();

  await openJournal(page);
  // 既定（今日まで）: 原始仕訳 + 当月認識 のみ。未来 11 か月の認識は隠れる。
  const defaultCount = await page.locator(`${ui('journal.entry.list')} > li`).count();
  expect(defaultCount).toBeLessThanOrEqual(3);

  // 「将来予定も表示」で全件（原始 1 + 認識 12 = 13）になる。
  await page.locator(ui('journal.filter.showFuture')).check();
  await expect(page.locator(`${ui('journal.entry.list')} > li`)).toHaveCount(13);
});

test('損益計算書の科目から仕訳一覧へドリルダウンできる', async ({ page }) => {
  await page.goto('./');
  await addExpense(page, 'コーヒー', '500');

  await page.locator(ui('nav.menu.button')).click();
  await page.locator(ui('nav.statements')).click();
  await page.locator(ui('statements.row')).filter({ hasText: '食費' }).first().click();

  await expect(page.locator(ui('journal.view'))).toBeVisible();
  await expect(page.getByText('「食費」で絞り込み中')).toBeVisible();
  await expect(page.locator(ui('journal.entry.list'))).toContainText('コーヒー');
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
  await addExpense(page, 'オフライン確認', '100');
  await expect(page.getByText('オフライン確認')).toBeVisible();

  expect(external, `外部リクエスト: ${external.join(', ')}`).toHaveLength(0);
});

test('manifest が読み込める', async ({ page }) => {
  await page.goto('./');
  const href = await page.locator('link[rel="manifest"]').getAttribute('href');
  expect(href).toBeTruthy();
  const res = await page.request.get(new URL(href!, page.url()).toString());
  expect(res.ok()).toBeTruthy();
  const json = await res.json();
  expect(json.scope).toContain('/simple-ledger/');
});
