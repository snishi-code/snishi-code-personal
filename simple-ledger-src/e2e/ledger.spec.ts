/*
 * E2E: 主要フロー（起動 → 支出入力 → 集計反映 → 取消/返金 → 各項目の内訳ページ → ドリルダウン）。
 * 外部送信ゼロも検証する（同一オリジン以外へのリクエストが無いこと）。
 *
 * 借方/貸方は日常入力に出さない。お金の流れ（源泉 → 行き先）をチップ(radio)で選ぶ。
 */
import { test, expect, type Page, type Request } from '@playwright/test';

const ui = (name: string) => `[data-ui="${name}"]`;

/** チップピッカー（科目）から名前で選ぶ。 */
async function pick(page: Page, fieldUi: string, name: string) {
  await page.locator(ui(fieldUi)).getByText(name, { exact: true }).click();
}

/** 支出を 1 件入力する（カテゴリ=変動費 / 支払元=現金）。 */
async function addExpense(page: Page, description: string, amount: string) {
  await page.locator(ui('dashboard.entry.expense')).click();
  await page.locator(ui('journal.entry.item')).fill(description);
  await pick(page, 'journal.entry.flow.destination', '変動費');
  await pick(page, 'journal.entry.flow.source', '現金');
  await page.locator(ui('journal.entry.amount')).fill(amount);
  await page.locator(ui('journal.entry.save')).click();
}

/** 仕訳画面はホーム下部「当月の仕訳」の「すべて見る」から開く（メニューには無い）。 */
async function openJournal(page: Page) {
  await page.locator(ui('nav.home')).click();
  await page.locator(ui('dashboard.journal.openAll')).click();
}

/** 勘定科目/タグ/残高補正は設定の「管理」セクションから開く。 */
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

test('?fixture=sample で空DBを開くと最初からサンプルデータが入っている', async ({ page }) => {
  await page.goto('./?fixture=sample');
  await expect(page.locator(ui('dashboard.view'))).toBeVisible();

  // 継続コスト一覧にサンプルの「家賃」が入っている（fixture が読み込まれた証拠・期間非依存）。
  await page.locator(ui('nav.menu.button')).click();
  await page.locator(ui('nav.allocations')).click();
  await expect(page.locator(ui('allocations.list'))).toContainText('家賃');
});

test('通常起動（fixture 指定なし）では空の台帳で始まる（サンプルを勝手に入れない）', async ({
  page,
}) => {
  await page.goto('./');
  await expect(page.locator(ui('dashboard.view'))).toBeVisible();
  // サンプルの継続コスト「家賃」は入っていない（fixture を勝手に投入しない）。
  await page.locator(ui('nav.menu.button')).click();
  await page.locator(ui('nav.allocations')).click();
  await expect(page.locator(ui('allocations.view'))).toBeVisible();
  await expect(page.getByText('家賃')).toHaveCount(0);
});

test('支出を追加するとホームと一覧に反映される', async ({ page }) => {
  await page.goto('./');
  await addExpense(page, 'テスト支出', '2500');

  // ホーム下部「当月の仕訳」→「すべて見る」で仕訳画面に反映を確認する。
  await openJournal(page);
  await expect(page.locator(ui('journal.entry.list'))).toContainText('テスト支出');
});

test('振替は項目なしでも保存でき、移動元→移動先が自動で付く', async ({ page }) => {
  await page.goto('./');
  await page.locator(ui('dashboard.entry.transfer')).click();
  // お金の流れ: 移動元=預金 → 移動先=現金（項目は未入力）
  await pick(page, 'journal.entry.flow.source', '預金');
  await pick(page, 'journal.entry.flow.destination', '現金');
  await page.locator(ui('journal.entry.amount')).fill('30000');
  await page.locator(ui('journal.entry.save')).click();

  await openJournal(page);
  await expect(page.locator(ui('journal.entry.list'))).toContainText('預金 → 現金');
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

test('継続コストを作成すると一覧と支出に反映される', async ({ page }) => {
  await page.goto('./');
  await page.locator(ui('dashboard.entry.expense')).click();
  await page.locator(ui('journal.entry.item')).fill('ノートPC');
  await pick(page, 'journal.entry.flow.destination', '変動費');
  await pick(page, 'journal.entry.flow.source', '現金');
  await page.locator(ui('journal.entry.amount')).fill('240000');
  await page.locator(ui('journal.entry.allocateToggle')).check(); // 「継続コスト化する」
  await page.locator(ui('journal.entry.allocateMonths')).fill('48');
  await page.locator(ui('journal.entry.save')).click();

  // 継続コスト一覧に出る（月額目安 5,000）
  await page.locator(ui('nav.menu.button')).click();
  await page.locator(ui('nav.allocations')).click();
  await expect(page.locator(ui('allocations.view'))).toBeVisible();
  await expect(page.locator(ui('allocations.list'))).toContainText('ノートPC');
  await expect(page.locator(ui('allocations.list'))).toContainText('5,000');

  // ホームの支出に継続コスト額が反映（240,000 そのものは費用にしない）
  await page.locator(ui('nav.home')).click();
  await expect(page.locator(ui('dashboard.view'))).toContainText('5,000');
});

test('ホーム上段の「支出」は購入額でなく支出（継続コスト分）を表示する', async ({ page }) => {
  await page.goto('./');
  // 冷蔵庫 240,000 を継続コスト（資産経由）として 48 か月で認識（現金払い）。
  await page.locator(ui('dashboard.entry.expense')).click();
  await page.locator(ui('journal.entry.item')).fill('冷蔵庫');
  await pick(page, 'journal.entry.flow.destination', '固定費');
  await pick(page, 'journal.entry.flow.source', '現金');
  await page.locator(ui('journal.entry.amount')).fill('240000');
  await page.locator(ui('journal.entry.allocateToggle')).check();
  await page.locator(ui('journal.entry.allocateMonths')).fill('48');
  await page.locator(ui('journal.entry.save')).click();

  // ホーム上段「支出」は購入額 240,000 ではなく、当月の継続コスト分 5,000（支出）を表示する。
  await page.locator(ui('nav.home')).click();
  const expenseStat = page.locator(ui('dashboard.stat.expense'));
  await expect(expenseStat).toContainText('5,000');
  await expect(expenseStat).not.toContainText('240,000');
});

test('継続コストを後から編集すると一覧とホームの支出に反映される', async ({ page }) => {
  await page.goto('./');
  // まず作成（240,000 を 48 か月 = 月額 5,000）。
  await page.locator(ui('dashboard.entry.expense')).click();
  await page.locator(ui('journal.entry.item')).fill('ノートPC');
  await pick(page, 'journal.entry.flow.destination', '変動費');
  await pick(page, 'journal.entry.flow.source', '現金');
  await page.locator(ui('journal.entry.amount')).fill('240000');
  await page.locator(ui('journal.entry.allocateToggle')).check();
  await page.locator(ui('journal.entry.allocateMonths')).fill('48');
  await page.locator(ui('journal.entry.save')).click();

  // 継続コスト画面で編集（名称変更 + 期間 48 → 24 か月 = 月額 10,000）。
  await page.locator(ui('nav.menu.button')).click();
  await page.locator(ui('nav.allocations')).click();
  await page.locator(ui('allocations.edit')).first().click();
  await page.locator(ui('allocations.edit.name')).fill('ノートPC（編集）');
  await page.locator(ui('allocations.edit.costMonths')).fill('24');
  await page.locator(ui('allocations.edit.save')).click();

  // 一覧に新しい名称と月額目安 10,000 が反映される。
  await expect(page.locator(ui('allocations.list'))).toContainText('ノートPC（編集）');
  await expect(page.locator(ui('allocations.list'))).toContainText('10,000');

  // ホームの支出も 10,000 に反映される。
  await page.locator(ui('nav.home')).click();
  await expect(page.locator(ui('dashboard.view'))).toContainText('10,000');
});

test('固定資産由来の継続コストを売却/故障で処分でき、終了する', async ({ page }) => {
  await page.goto('./');
  // 1) 固定資産科目「社用車」を作る。
  await openManagement(page, 'accounts');
  await page.locator(ui('accounts.create')).click();
  await page.getByLabel('科目名').fill('社用車');
  await page.locator(ui('accounts.type')).selectOption('asset');
  await page.locator(ui('accounts.role')).selectOption('fixed-asset');
  await page.locator(ui('accounts.save')).click();

  // 2) 支出で固定資産購入を「固定資産として継続コスト」する（120 か月）。
  await page.locator(ui('nav.home')).click();
  await page.locator(ui('dashboard.entry.expense')).click();
  await page.locator(ui('journal.entry.item')).fill('社用車の購入');
  await pick(page, 'journal.entry.flow.destination', '社用車');
  await pick(page, 'journal.entry.flow.source', '現金');
  await page.locator(ui('journal.entry.amount')).fill('1200000');
  await page.locator(ui('journal.entry.fixedMonthlyToggle')).check();
  await page.locator(ui('journal.entry.allocateMonths')).fill('120');
  await pick(page, 'journal.entry.fixedMonthlyCategory', '変動費');
  await page.locator(ui('journal.entry.save')).click();

  // 3) 継続コスト画面で「売却/故障」→ 0 円故障で処分。
  await page.locator(ui('nav.menu.button')).click();
  await page.locator(ui('nav.allocations')).click();
  await expect(page.locator(ui('allocations.list'))).toContainText('社用車の購入');
  await page.locator(ui('allocations.dispose')).first().click();
  await page.locator(ui('allocations.dispose.proceeds')).fill('0');
  await page.locator(ui('allocations.dispose.confirm')).click();

  // 4) 既定（有効のみ）一覧からは消える（空表示）。終了分を表示すると「終了」として現れる。
  await expect(page.locator(ui('allocations.view'))).toContainText('継続コストはありません');
  await page.locator(ui('allocations.showCompleted')).check();
  await expect(page.locator(ui('allocations.list'))).toContainText('社用車の購入');
  await expect(page.locator(ui('allocations.list'))).toContainText('終了');
});

test('洗濯機（カード/84か月・償却のみ）を継続コスト対象に資産化し、返済CFを作る', async ({
  page,
}) => {
  await page.goto('./');
  // クレカ → 洗濯機(資産)。認識は 洗濯機 → 固定費。返済は 現金 → クレカ（2 回）。
  await page.locator(ui('dashboard.entry.expense')).click();
  await page.locator(ui('journal.entry.item')).fill('洗濯機');
  await pick(page, 'journal.entry.flow.destination', '固定費');
  await pick(page, 'journal.entry.flow.source', 'クレジットカード');
  await page.locator(ui('journal.entry.amount')).fill('240000');
  await page.locator(ui('journal.entry.allocateToggle')).check();
  await page.locator(ui('journal.entry.allocateMonths')).fill('84');
  // 継続購入トグルは付けない＝償却のみ（再購入しない）。カード払いなので 2 回返済を登録。
  await page.locator(ui('journal.entry.monthlyizeRepayToggle')).check();
  await pick(page, 'journal.entry.monthlyizeRepayAccount', '現金');
  await page.locator(ui('journal.entry.monthlyizeRepayCount')).fill('2');
  await page.locator(ui('journal.entry.save')).click();

  // 継続コスト台帳に洗濯機が出て「償却のみ」。資産経由なので売却/故障ボタンは v1 で出さない。
  await page.locator(ui('nav.menu.button')).click();
  await page.locator(ui('nav.allocations')).click();
  await expect(page.locator(ui('allocations.list'))).toContainText('洗濯機');
  await expect(page.locator(ui('allocations.list'))).toContainText('償却のみ');
  await expect(page.locator(ui('allocations.dispose'))).toHaveCount(0);

  // 資金繰りに返済予定（洗濯機 返済）が出る。
  await page.locator(ui('nav.menu.button')).click();
  await page.locator(ui('nav.cashflow')).click();
  await expect(page.locator(ui('cashflow.schedule.list'))).toContainText('洗濯機 返済');
});

test('YouTube年払い（継続購入）: クレカ→YouTube資産化、当月認識1,000・資産は未認識11,000', async ({
  page,
}) => {
  await page.goto('./');
  await page.locator(ui('dashboard.entry.expense')).click();
  await page.locator(ui('journal.entry.item')).fill('YouTube');
  await pick(page, 'journal.entry.flow.destination', '娯楽費');
  await pick(page, 'journal.entry.flow.source', 'クレジットカード');
  await page.locator(ui('journal.entry.amount')).fill('12000');
  await page.locator(ui('journal.entry.allocateToggle')).check();
  await page.locator(ui('journal.entry.allocateMonths')).fill('12');
  // 継続購入（自動更新）。
  await page.locator(ui('journal.entry.monthlyizeContinue')).check();
  await page.locator(ui('journal.entry.save')).click();

  // 台帳に YouTube が「継続購入」で並ぶ。
  await page.locator(ui('nav.menu.button')).click();
  await page.locator(ui('nav.allocations')).click();
  await expect(page.locator(ui('allocations.list'))).toContainText('YouTube');
  await expect(page.locator(ui('allocations.list'))).toContainText('継続購入');

  // ホーム「支出」は購入額 12,000 でなく当月の認識 1,000（12,000/12）。
  await page.locator(ui('nav.home')).click();
  const expenseStat = page.locator(ui('dashboard.stat.expense'));
  await expect(expenseStat).toContainText('1,000');
  await expect(expenseStat).not.toContainText('12,000');

  // 資産の内訳: YouTube 資産 = 未認識残高 11,000（資産化 12,000 − 当月認識 1,000）。
  await page.locator(ui('dashboard.stat.assets')).click();
  await expect(page.locator(ui('assetsBreakdown.view'))).toContainText('YouTube');
  await expect(page.locator(ui('assetsBreakdown.view'))).toContainText('11,000');
});

test('継続コストは実支払い仕訳を残さない（資産化は仮想）。当月の月割り認識は読み取り専用で見える', async ({
  page,
}) => {
  await page.goto('./');
  // Journal へ到達するために通常支出を 1 件入れておく。
  await addExpense(page, 'コーヒー', '300');
  await page.locator(ui('dashboard.entry.expense')).click();
  await page.locator(ui('journal.entry.item')).fill('スマホ年払い');
  await pick(page, 'journal.entry.flow.destination', '変動費');
  await pick(page, 'journal.entry.flow.source', '現金');
  await page.locator(ui('journal.entry.amount')).fill('120000');
  await page.locator(ui('journal.entry.allocateToggle')).check();
  await page.locator(ui('journal.entry.allocateMonths')).fill('12');
  await page.locator(ui('journal.entry.save')).click();

  await openJournal(page);
  // 実仕訳は通常支出（コーヒー）の 1 件だけ。継続コストの資産化/認識は仮想＝実仕訳にしない。
  await expect(page.locator(`${ui('journal.entry.list')} > li`)).toHaveCount(1);
  await expect(page.locator(ui('journal.entry.list'))).toContainText('コーヒー');
  await expect(page.locator(ui('journal.entry.list'))).not.toContainText('スマホ年払い');
  // 当月の月割り認識（120,000/12 = 10,000）は読み取り専用の仮想行で見える。
  await expect(page.locator(ui('journal.monthlyRecognition'))).toContainText('10,000');
});

test('資金繰り: 取り置き資金を作成できる（CF は確認専用・予定の独立追加UIは無い）', async ({
  page,
}) => {
  await page.goto('./');
  await page.locator(ui('nav.menu.button')).click();
  await page.locator(ui('nav.cashflow')).click();
  await expect(page.locator(ui('cashflow.view'))).toBeVisible();

  // CF 画面に予定の独立追加ボタンは無い（入力はホームに一本化）。
  await expect(page.locator(ui('cashflow.schedule.create'))).toHaveCount(0);

  // 取り置き資金は下部の「取り置き資金・資金目標」を開いてから追加する
  await page.locator(ui('cashflow.advanced.toggle')).click();
  await page.locator(ui('cashflow.reserve.create')).click();
  await page.locator(ui('cashflow.reserve.name')).fill('結婚資金');
  await page.locator(ui('cashflow.reserve.save')).click();
  await expect(page.locator(ui('cashflow.reserve.list'))).toContainText('結婚資金');
});

/** 今日から days 日後の 'YYYY-MM-DD'。 */
function isoOffset(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}

test('資金繰り: 表示終了日を変えると未来予定の範囲が変わる', async ({ page }) => {
  await page.goto('./');
  // 未来日付（約100日後）の支出を登録（使い道=変動費 / 支払い方法=現金）
  await page.locator(ui('dashboard.entry.expense')).click();
  await page.locator(ui('journal.entry.item')).fill('未来の支払い');
  await page.locator(ui('journal.entry.date')).fill(isoOffset(100));
  await pick(page, 'journal.entry.flow.destination', '変動費');
  await pick(page, 'journal.entry.flow.source', '現金');
  await page.locator(ui('journal.entry.amount')).fill('5000');
  await page.locator(ui('journal.entry.save')).click();

  await page.locator(ui('nav.menu.button')).click();
  await page.locator(ui('nav.cashflow')).click();
  // 既定の表示終了日（今日+6か月）には 100日後が含まれる
  await expect(page.locator(ui('cashflow.future.list'))).toContainText('未来の支払い');

  // 表示終了日を 30日後に縮めると範囲外になり、未来予定一覧から消える
  await page.locator(ui('cashflow.until')).fill(isoOffset(30));
  await expect(page.locator(ui('cashflow.future.list'))).toHaveCount(0);
});

test('振替入力から取り置き資金を作成し、行き先に選べる', async ({ page }) => {
  await page.goto('./');
  await page.locator(ui('dashboard.entry.transfer')).click();
  // 先に源泉（移動元）を選ぶ。その後で行き先の取り置き資金を入力中に作成する。
  await pick(page, 'journal.entry.flow.source', '預金');
  await page.locator(ui('journal.entry.reserveCreate')).click();
  await page.locator(ui('cashflow.reserve.name')).fill('新婚旅行');
  await page.locator(ui('cashflow.reserve.save')).click();

  // 作成シートが閉じ、行き先に新規取り置き資金が自動選択される。
  await expect(page.locator(ui('journal.entry.flow.destination'))).toContainText('新婚旅行');
  await page.locator(ui('journal.entry.amount')).fill('100000');
  await page.locator(ui('journal.entry.save')).click();

  await openJournal(page);
  await expect(page.locator(ui('journal.entry.list'))).toContainText('預金 → 新婚旅行');
});

test('取り置き資金は支出の支払い方法に既定で出ず、トグルで出る', async ({ page }) => {
  await page.goto('./');
  // 先に取り置き資金を作る（CF 補助セクション）
  await page.locator(ui('nav.menu.button')).click();
  await page.locator(ui('nav.cashflow')).click();
  await page.locator(ui('cashflow.advanced.toggle')).click();
  await page.locator(ui('cashflow.reserve.create')).click();
  await page.locator(ui('cashflow.reserve.name')).fill('旅行積立');
  await page.locator(ui('cashflow.reserve.save')).click();

  // 支出の支払い方法（source）には既定で出ない
  await page.locator(ui('nav.home')).click();
  await page.locator(ui('dashboard.entry.expense')).click();
  await expect(page.locator(ui('journal.entry.flow.source'))).not.toContainText('旅行積立');
  // 「取り置き資金を使う」トグルで出る
  await page.locator(ui('journal.entry.reserveToggle')).check();
  await expect(page.locator(ui('journal.entry.flow.source'))).toContainText('旅行積立');
});

test('支出の支払い方法でクレジットカード(payment-liability)をトグル無しで選べる', async ({
  page,
}) => {
  await page.goto('./');
  await page.locator(ui('dashboard.entry.expense')).click();
  // トグルを操作せず、支払い方法にクレジットカードが既定で出る。
  await expect(page.locator(ui('journal.entry.flow.source'))).toContainText('クレジットカード');
  await page.locator(ui('journal.entry.item')).fill('カード払いの買い物');
  await pick(page, 'journal.entry.flow.destination', '変動費');
  await pick(page, 'journal.entry.flow.source', 'クレジットカード');
  await page.locator(ui('journal.entry.amount')).fill('3000');
  await page.locator(ui('journal.entry.save')).click();
  // 保存され、仕訳一覧に反映される。
  await openJournal(page);
  await expect(page.locator(ui('journal.entry.list'))).toContainText('カード払いの買い物');
});

test('支出は使い道に費用カテゴリ、支払い方法に資金/カードを出し、左右を取り違えない', async ({
  page,
}) => {
  await page.goto('./');
  await page.locator(ui('dashboard.entry.expense')).click();
  const source = page.locator(ui('journal.entry.flow.source'));
  const dest = page.locator(ui('journal.entry.flow.destination'));
  // 支払い方法(source)= 資金(daily-asset) + カード(payment-liability)。費用は出さない。
  await expect(source).toContainText('現金');
  await expect(source).toContainText('クレジットカード');
  await expect(source).not.toContainText('変動費');
  // 使い道(destination)= 費用カテゴリ。資金(現金)は出さない。
  await expect(dest).toContainText('変動費');
  await expect(dest).not.toContainText('現金');
});

test('金額欄は詳細を開いても主要入力順（金額 → お金の流れ → 詳細）から外れない', async ({
  page,
}) => {
  await page.goto('./');
  await page.locator(ui('dashboard.entry.expense')).click();
  await page.locator(ui('journal.entry.amount')).fill('1200');
  const amount = page.locator(ui('journal.entry.amount'));
  const detailToggle = page.locator(ui('journal.entry.detailToggle'));
  await detailToggle.click();
  // 金額欄は詳細トグルより上にあり、値も保持される（下に落ちない）。
  await expect(amount).toHaveValue('1200');
  const ab = await amount.boundingBox();
  const db = await detailToggle.boundingBox();
  expect(ab && db && ab.y < db.y).toBe(true);
});

test('簿記編集も左から右の流れで表示し、金額欄を下に落とさない', async ({ page }) => {
  await page.goto('./');
  await page.locator(ui('dashboard.entry.expense')).click();
  await page.locator(ui('journal.entry.amount')).fill('1200');
  await page.locator(ui('journal.entry.manualSwitch')).click();

  const amount = page.locator(ui('journal.entry.amount'));
  const flow = page.locator(ui('journal.entry.flow'));
  await expect(flow).toContainText('貸方 → 借方');
  await expect(page.locator(ui('journal.entry.flow.source'))).toContainText('左側（貸方）');
  await expect(page.locator(ui('journal.entry.flow.destination'))).toContainText('右側（借方）');
  await expect(amount).toHaveValue('1200');
  const ab = await amount.boundingBox();
  const fb = await flow.boundingBox();
  expect(ab && fb && ab.y >= 0 && ab.y < fb.y).toBe(true);
});

test('入力中に新しい負債（ローン）を作り、分割返済が資金繰りに出る', async ({ page }) => {
  await page.goto('./');
  await page.locator(ui('dashboard.entry.transfer')).click();
  // 先に行き先（移動先=借入金の入り先）を選ぶ。その後で源泉の負債を入力中に作成する。
  await pick(page, 'journal.entry.flow.destination', '預金');
  // 新しい負債（ローン=other-liability）を作る → 源泉（移動元）に選択 = 借入実行
  await page.locator(ui('journal.entry.liabilityCreate')).click();
  await page.locator(ui('journal.entry.liabilityCreate.name')).fill('自動車ローン');
  await page.locator(ui('journal.entry.liabilityCreate.save')).click();

  // 作成シートが閉じ、源泉(移動元)に新規負債が自動選択される。
  await expect(page.locator(ui('journal.entry.flow.source'))).toContainText('自動車ローン');
  await page.locator(ui('journal.entry.amount')).fill('1200000');
  // 分割返済を資金繰りに入れる（返済元=預金 / 12回）
  await page.locator(ui('journal.entry.loanRepayToggle')).locator('input').check();
  await pick(page, 'journal.entry.loanRepayAccount', '預金');
  await page.locator(ui('journal.entry.loanRepayCount')).fill('12');
  await page.locator(ui('journal.entry.save')).click();

  // CF の「分割・定期の返済予定」に出る
  await page.locator(ui('nav.menu.button')).click();
  await page.locator(ui('nav.cashflow')).click();
  await expect(page.locator(ui('cashflow.schedule.list'))).toContainText('自動車ローン');
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
  await page.locator(ui('journal.entry.item')).fill('旅行の食事');
  await pick(page, 'journal.entry.flow.destination', '変動費');
  await pick(page, 'journal.entry.flow.source', '現金');
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

test('管理区分・支払い手段: 細目を追加できる', async ({ page }) => {
  await page.goto('./');
  await openManagement(page, 'wallets');
  await expect(page.locator(ui('wallets.view'))).toBeVisible();

  // 支払い手段の細目を 1 件追加（親科目=現金 など既定の資産）。
  await page.locator(ui('wallets.instrument.create')).click();
  await page.locator(ui('wallets.instrument.name')).fill('楽天カード');
  await page.locator(ui('wallets.instrument.save')).click();
  await expect(page.locator(ui('wallets.instrument.list'))).toContainText('楽天カード');
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

test('資産の内訳の科目から仕訳一覧へドリルダウンできる', async ({ page }) => {
  await page.goto('./');
  await addExpense(page, 'コーヒー', '500');

  // 旧・財務諸表は廃止。各項目の内訳ページから科目をタップしてドリルダウンする。
  await page.locator(ui('dashboard.stat.assets')).click();
  await expect(page.locator(ui('assetsBreakdown.view'))).toBeVisible();
  await page.locator(ui('assetsBreakdown.row')).filter({ hasText: '現金' }).first().click();

  await expect(page.locator(ui('journal.view'))).toBeVisible();
  await expect(page.getByText('「現金」で絞り込み中')).toBeVisible();
  await expect(page.locator(ui('journal.entry.list'))).toContainText('コーヒー');
});

test('ホーム各項目は同じ財務諸表ではなく、それぞれの内訳ページへ分かれて遷移する', async ({
  page,
}) => {
  await page.goto('./');

  // 収入 → 収入の内訳
  await page.locator(ui('dashboard.stat.revenue')).click();
  await expect(page.locator(ui('incomeBreakdown.view'))).toBeVisible();

  // 収支 → 収支ページ（科目別ドリルではなく残り方を見る）
  await page.locator(ui('nav.home')).click();
  await page.locator(ui('dashboard.stat.netIncome')).click();
  await expect(page.locator(ui('netIncome.view'))).toBeVisible();
  await expect(page.locator(ui('netIncome.result'))).toBeVisible();

  // 資産 → 資産の内訳
  await page.locator(ui('nav.home')).click();
  await page.locator(ui('dashboard.stat.assets')).click();
  await expect(page.locator(ui('assetsBreakdown.view'))).toBeVisible();

  // 負債 → 負債の内訳（資産の内訳とは別ページ）。資金繰りへの導線を持つ。
  await page.locator(ui('nav.home')).click();
  await page.locator(ui('dashboard.stat.liabilities')).click();
  await expect(page.locator(ui('liabilitiesBreakdown.view'))).toBeVisible();
  await expect(page.locator(ui('assetsBreakdown.view'))).toHaveCount(0);
  await page.locator(ui('liabilitiesBreakdown.cashflowLink')).click();
  await expect(page.locator(ui('cashflow.view'))).toBeVisible();

  // 純資産 → 純資産ページ（資産/負債とは別ページ）
  await page.locator(ui('nav.home')).click();
  await page.locator(ui('dashboard.stat.netAssets')).click();
  await expect(page.locator(ui('netAssets.view'))).toBeVisible();
  await expect(page.locator(ui('assetsBreakdown.view'))).toHaveCount(0);
  await expect(page.locator(ui('liabilitiesBreakdown.view'))).toHaveCount(0);
});

test('ホーム上部の入力ボタン直下に誤解を招く空カードを出さない', async ({ page }) => {
  await page.goto('./');
  await expect(page.locator(ui('dashboard.view'))).toBeVisible();
  // 入力導線の直下に「まだ仕訳がありません」カードは出さない（入力位置に仕訳が入るわけではない）。
  await expect(page.getByText('まだ仕訳がありません')).toHaveCount(0);
});

test('ホーム「支出」→ 支出の内訳 → 継続コスト台帳の導線', async ({ page }) => {
  await page.goto('./');
  // 「支出」は継続コスト台帳へ直行せず、まず「支出の内訳」へ。
  await page.locator(ui('dashboard.stat.expense')).click();
  await expect(page.locator(ui('expenseBreakdown.view'))).toBeVisible();
  await expect(page.locator(ui('allocations.view'))).toHaveCount(0);
  // 内訳には通常支出と支出（継続コスト）が見える。
  await expect(page.locator(ui('expenseBreakdown.normalExpense'))).toBeVisible();
  await expect(page.locator(ui('expenseBreakdown.monthlyCost'))).toBeVisible();
  await expect(page.locator(ui('expenseBreakdown.total'))).toBeVisible();
  // 支出（継続コスト）からだけ継続コスト台帳へ進める。
  await page.locator(ui('expenseBreakdown.monthlyCost')).click();
  await expect(page.locator(ui('allocations.view'))).toBeVisible();
});

test('ハンバーガーメニューから継続コスト台帳へ直接行ける', async ({ page }) => {
  await page.goto('./');
  await page.locator(ui('nav.menu.button')).click();
  await page.locator(ui('nav.allocations')).click();
  await expect(page.locator(ui('allocations.view'))).toBeVisible();
});

test('ヘッダーは期間コンテキスト表示で、軽量ピッカーから年/月/年全体/全期間を切り替える', async ({
  page,
}) => {
  await page.goto('./');
  const now = new Date();
  const currentYear = String(now.getFullYear());
  const currentMonth = String(now.getMonth() + 1);
  await expect(page.locator(ui('period.year.trigger'))).toHaveText(currentYear);
  await expect(page.locator(ui('period.month.trigger'))).toHaveText(currentMonth);
  await expect(page.getByText(`${currentYear}年${currentMonth}月`, { exact: true })).toHaveCount(0);
  await expect(
    page.getByText(`${currentYear}年${currentMonth}月の収支`, { exact: true }),
  ).toHaveCount(0);
  await expect(page.locator('.section-label').filter({ hasText: '収支' })).toHaveCount(1);
  await expect(page.locator('.section-label').filter({ hasText: '財務' })).toHaveCount(1);
  // 継続コスト（旧「支出/継続コスト」）は独立セクションにしない（上段「支出」がその値）。
  await expect(page.locator('.section-label').filter({ hasText: '継続コスト' })).toHaveCount(0);

  await addExpense(page, '期間テスト支出', '1500');

  // ヘッダーに前後ボタン・粒度トグルの常設操作群は無い（コンテキスト表示のみ）。
  await expect(page.locator(ui('period.prev'))).toHaveCount(0);
  await expect(page.locator(ui('period.next'))).toHaveCount(0);
  await expect(page.locator(ui('period.toYear'))).toHaveCount(0);

  // 既定は月別 → 単月なので推移は出ない。
  await expect(page.locator(ui('period.trend'))).toHaveCount(0);

  // 月ラベルのピッカーで「年全体」→ 年表示。推移が SVG グラフとして出る。
  await page.locator(ui('period.month.trigger')).click();
  await expect(page.locator(ui('period.month.picker'))).toBeVisible();
  await page.locator(ui('period.fullYear.row')).click();
  await expect(page.locator(ui('period.year.trigger'))).toHaveText(currentYear);
  await expect(page.locator(ui('period.month.trigger'))).toHaveText('全体');
  await expect(page.locator(`${ui('period.trend.chart')} svg`).first()).toBeVisible();

  // 年ラベルのピッカーで「全期間」→ 全期間。月トリガーは消える。
  await page.locator(ui('period.year.trigger')).click();
  await expect(page.locator(ui('period.year.picker'))).toBeVisible();
  await page.locator(ui('period.all.row')).click();
  await expect(page.locator(ui('period.month.trigger'))).toHaveCount(0);
  await expect(page.locator(`${ui('period.trend.chart')} svg`).first()).toBeVisible();

  // 全期間の推移から年へドリルダウン（年ポイントをタップ）→ 月トリガーが戻る。
  await page.locator(ui('period.trend.point')).first().click();
  await expect(page.locator(ui('period.month.trigger'))).toBeVisible();
});

test('期間ピッカーで対象を変えると仕訳一覧も追従する', async ({ page }) => {
  await page.goto('./');
  await addExpense(page, '当月の支出', '1000');

  // 当月の仕訳としてホームから仕訳画面を開く（当月フィルタ）。
  await openJournal(page);
  await expect(page.locator(ui('journal.entry.list'))).toContainText('当月の支出');

  // 年ピッカーで翌年（データなし）へ → 仕訳一覧が追従して空になる。
  const now = new Date();
  await page.locator(ui('period.year.trigger')).click();
  await page
    .locator(ui('period.year.picker'))
    .getByText(`${now.getFullYear() + 1}年`, { exact: true })
    .click();
  await expect(page.getByText('当月の支出')).toHaveCount(0);
  await expect(page.getByText('該当する仕訳がありません。')).toBeVisible();

  // 今年へ戻すと再び表示される。
  await page.locator(ui('period.year.trigger')).click();
  await page
    .locator(ui('period.year.picker'))
    .getByText(`${now.getFullYear()}年`, { exact: true })
    .click();
  await expect(page.locator(ui('journal.entry.list'))).toContainText('当月の支出');
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
