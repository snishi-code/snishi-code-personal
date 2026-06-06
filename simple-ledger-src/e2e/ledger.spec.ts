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

/** 財務諸表/勘定科目/タグ/残高補正は設定の「管理」セクションから開く。 */
async function openManagement(page: Page, screen: string) {
  await page.locator(ui('nav.menu.button')).click();
  await page.locator(ui('nav.settings')).click();
  await page.locator(ui(`settings.manage.${screen}`)).click();
}

test('起動してホームが表示される', async ({ page }) => {
  await page.goto('./');
  await expect(page.locator(ui('dashboard.view'))).toBeVisible();
  await expect(page.getByRole('heading', { name: 'ホーム' })).toBeVisible();
});

test('支出を追加するとホームと一覧に反映される', async ({ page }) => {
  await page.goto('./');
  await addExpense(page, 'テスト支出', '2500');

  // ホームには最近の仕訳一覧を置かない。仕訳画面で反映を確認する。
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

test('月額化コストを作成すると一覧と生活コストに反映される', async ({ page }) => {
  await page.goto('./');
  await page.locator(ui('dashboard.entry.expense')).click();
  await page.locator(ui('journal.entry.description')).fill('ノートPC');
  await pick(page, 'journal.entry.debitAccount', '食費');
  await pick(page, 'journal.entry.creditAccount', '現金');
  await page.locator(ui('journal.entry.amount')).fill('240000');
  await page.locator(ui('journal.entry.allocateToggle')).check(); // 「月額化する」
  await page.locator(ui('journal.entry.allocateMonths')).fill('48');
  await page.locator(ui('journal.entry.save')).click();

  // 月額化コスト一覧に出る（月額目安 5,000）
  await page.locator(ui('nav.menu.button')).click();
  await page.locator(ui('nav.allocations')).click();
  await expect(page.locator(ui('allocations.view'))).toBeVisible();
  await expect(page.locator(ui('allocations.list'))).toContainText('ノートPC');
  await expect(page.locator(ui('allocations.list'))).toContainText('5,000');

  // ホームの生活コストに月額化額が反映（240,000 そのものは費用にしない）
  await page.locator(ui('nav.home')).click();
  await expect(page.locator(ui('dashboard.view'))).toContainText('5,000');
});

test('月額化コストは仕訳を作らない（登録簿）', async ({ page }) => {
  await page.goto('./');
  await page.locator(ui('dashboard.entry.expense')).click();
  await page.locator(ui('journal.entry.description')).fill('スマホ年払い');
  await pick(page, 'journal.entry.debitAccount', '食費');
  await pick(page, 'journal.entry.creditAccount', '現金');
  await page.locator(ui('journal.entry.amount')).fill('120000');
  await page.locator(ui('journal.entry.allocateToggle')).check();
  await page.locator(ui('journal.entry.allocateMonths')).fill('12');
  await page.locator(ui('journal.entry.save')).click();

  // 仕訳一覧には何も増えない（月額化は仕訳を生成しない）。
  await openJournal(page);
  await expect(page.locator(`${ui('journal.entry.list')} > li`)).toHaveCount(0);
  // ただし当月の月額化認識は読み取り専用で見える（120,000/12 = 10,000）。
  await expect(page.locator(ui('journal.monthlyRecognition'))).toContainText('スマホ年払い');
  await expect(page.locator(ui('journal.monthlyRecognition'))).toContainText('10,000');
});

test('資金繰り: 予定と目的別資金を作成できる', async ({ page }) => {
  await page.goto('./');
  await page.locator(ui('nav.menu.button')).click();
  await page.locator(ui('nav.cashflow')).click();
  await expect(page.locator(ui('cashflow.view'))).toBeVisible();

  // 入出金予定（支出予定 / 対象口座=現金）を追加
  await page.locator(ui('cashflow.schedule.create')).click();
  await page.locator(ui('cashflow.schedule.name')).fill('カード引き落とし');
  await page.locator(ui('cashflow.schedule.amount')).fill('50000');
  await pick(page, 'cashflow.schedule.account', '現金');
  await page.locator(ui('cashflow.schedule.save')).click();
  await expect(page.locator(ui('cashflow.schedule.list'))).toContainText('カード引き落とし');

  // 目的別資金を追加
  await page.locator(ui('cashflow.reserve.create')).click();
  await page.locator(ui('cashflow.reserve.name')).fill('結婚資金');
  await page.locator(ui('cashflow.reserve.save')).click();
  await expect(page.locator(ui('cashflow.reserve.list'))).toContainText('結婚資金');
});

test('タグ: 作成 → 支出に付与 → Journal で抽出できる', async ({ page }) => {
  await page.goto('./');

  // タグ画面でタグを作成（設定→管理→タグ）
  await openManagement(page, 'tags');
  await page.locator(ui('tags.create')).click();
  await page.locator(ui('tags.name')).fill('北海道旅行');
  await page.locator(ui('tags.save')).click();
  await expect(page.locator(ui('tags.list'))).toContainText('北海道旅行');

  // 支出にタグを付与
  await page.locator(ui('nav.home')).click();
  await page.locator(ui('dashboard.entry.expense')).click();
  await page.locator(ui('journal.entry.description')).fill('旅行の食事');
  await pick(page, 'journal.entry.debitAccount', '食費');
  await pick(page, 'journal.entry.creditAccount', '現金');
  await page.locator(ui('journal.entry.amount')).fill('5000');
  // タグは「詳細」を開いてから付与する（日常入力では折りたたみ）。
  await page.locator(ui('journal.entry.detailToggle')).click();
  await page.locator(ui('journal.entry.tags')).getByText('北海道旅行', { exact: true }).click();
  await page.locator(ui('journal.entry.save')).click();

  // Journal でタグ絞り込み
  await openJournal(page);
  await page.locator(ui('journal.filter.tag')).selectOption({ label: '北海道旅行' });
  await expect(page.locator(ui('journal.entry.list'))).toContainText('旅行の食事');
});

test('残高補正: 実残高を入力すると補正仕訳ができる', async ({ page }) => {
  await page.goto('./');
  await openManagement(page, 'adjustments');
  await expect(page.locator(ui('adjustments.view'))).toBeVisible();

  // 現金の実残高を 8000 として補正（理論残高 0 → +8000）
  await pick(page, 'adjust.account', '現金');
  await page.locator(ui('adjust.actual')).fill('8000');
  await page.locator(ui('adjust.save')).click();

  // Journal に補正仕訳が出る
  await openJournal(page);
  await expect(page.locator(ui('journal.entry.list'))).toContainText('残高補正');
});

test('損益計算書の科目から仕訳一覧へドリルダウンできる', async ({ page }) => {
  await page.goto('./');
  await addExpense(page, 'コーヒー', '500');

  // 財務諸表はホームの損益サマリーから開く（管理メニューには無い）。
  await page.locator(ui('dashboard.openPl')).click();
  await page.locator(ui('statements.row')).filter({ hasText: '食費' }).first().click();

  await expect(page.locator(ui('journal.view'))).toBeVisible();
  await expect(page.getByText('「食費」で絞り込み中')).toBeVisible();
  await expect(page.locator(ui('journal.entry.list'))).toContainText('コーヒー');
});

test('ホームの損益/資産サマリーから財務諸表(PL/BS)を開ける', async ({ page }) => {
  await page.goto('./');
  // 損益サマリー → 損益計算書
  await page.locator(ui('dashboard.openPl')).click();
  await expect(page.locator(ui('statements.profitAndLoss'))).toBeVisible();
  // ホームへ戻り、資産負債サマリー → 貸借対照表
  await page.locator(ui('nav.home')).click();
  await page.locator(ui('dashboard.openBs')).click();
  await expect(page.locator(ui('statements.balanceSheet'))).toBeVisible();
  // タブ切替も従来どおり動く
  await page.locator(ui('statements.tab.pl')).click();
  await expect(page.locator(ui('statements.profitAndLoss'))).toBeVisible();
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
  await expect(page.locator(ui('dashboard.view'))).toBeVisible();

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
