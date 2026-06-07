/*
 * E2E: 主要フロー（起動 → 支出入力 → 集計反映 → 取消/返金 → ドリルダウン → 財務諸表）。
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

/** 支出を 1 件入力する（カテゴリ=食費 / 支払元=現金）。 */
async function addExpense(page: Page, description: string, amount: string) {
  await page.locator(ui('dashboard.entry.expense')).click();
  await page.locator(ui('journal.entry.item')).fill(description);
  await pick(page, 'journal.entry.flow.destination', '食費');
  await pick(page, 'journal.entry.flow.source', '現金');
  await page.locator(ui('journal.entry.amount')).fill(amount);
  await page.locator(ui('journal.entry.save')).click();
}

/** 仕訳画面はホーム下部「当月の仕訳」の「すべて見る」から開く（メニューには無い）。 */
async function openJournal(page: Page) {
  await page.locator(ui('nav.home')).click();
  await page.locator(ui('dashboard.journal.openAll')).click();
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

  // ホーム下部「当月の仕訳」→「すべて見る」で仕訳画面に反映を確認する。
  await openJournal(page);
  await expect(page.locator(ui('journal.entry.list'))).toContainText('テスト支出');
});

test('振替は項目なしでも保存でき、移動元→移動先が自動で付く', async ({ page }) => {
  await page.goto('./');
  await page.locator(ui('dashboard.entry.transfer')).click();
  // お金の流れ: 移動元=普通預金 → 移動先=現金（項目は未入力）
  await pick(page, 'journal.entry.flow.source', '普通預金');
  await pick(page, 'journal.entry.flow.destination', '現金');
  await page.locator(ui('journal.entry.amount')).fill('30000');
  await page.locator(ui('journal.entry.save')).click();

  await openJournal(page);
  await expect(page.locator(ui('journal.entry.list'))).toContainText('普通預金 → 現金');
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
  await page.locator(ui('journal.entry.item')).fill('ノートPC');
  await pick(page, 'journal.entry.flow.destination', '食費');
  await pick(page, 'journal.entry.flow.source', '現金');
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

test('月額化コストは実支払いを仕訳に残し、当月の月割り認識も見える', async ({ page }) => {
  await page.goto('./');
  await page.locator(ui('dashboard.entry.expense')).click();
  await page.locator(ui('journal.entry.item')).fill('スマホ年払い');
  await pick(page, 'journal.entry.flow.destination', '食費');
  await pick(page, 'journal.entry.flow.source', '現金');
  await page.locator(ui('journal.entry.amount')).fill('120000');
  await page.locator(ui('journal.entry.allocateToggle')).check();
  await page.locator(ui('journal.entry.allocateMonths')).fill('12');
  await page.locator(ui('journal.entry.save')).click();

  await openJournal(page);
  // 実際の支払い（120,000）は仕訳に残る（読み取り専用の「月額化」タグ付き）。
  await expect(page.locator(`${ui('journal.entry.list')} > li`)).toHaveCount(1);
  await expect(page.locator(ui('journal.entry.list'))).toContainText('スマホ年払い');
  // 当月の月割り認識（120,000/12 = 10,000）も読み取り専用で見える。
  await expect(page.locator(ui('journal.monthlyRecognition'))).toContainText('10,000');
});

test('資金繰り: 目的別資金を作成できる（CF は確認専用・予定の独立追加UIは無い）', async ({
  page,
}) => {
  await page.goto('./');
  await page.locator(ui('nav.menu.button')).click();
  await page.locator(ui('nav.cashflow')).click();
  await expect(page.locator(ui('cashflow.view'))).toBeVisible();

  // CF 画面に予定の独立追加ボタンは無い（入力はホームに一本化）。
  await expect(page.locator(ui('cashflow.schedule.create'))).toHaveCount(0);

  // 目的別資金は下部の「目的別資金・資金目標」を開いてから追加する
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
  // 未来日付（約100日後）の支出を登録（使い道=食費 / 支払い方法=現金）
  await page.locator(ui('dashboard.entry.expense')).click();
  await page.locator(ui('journal.entry.item')).fill('未来の支払い');
  await page.locator(ui('journal.entry.date')).fill(isoOffset(100));
  await pick(page, 'journal.entry.flow.destination', '食費');
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

test('振替入力から目的別資金を作成し、行き先に選べる', async ({ page }) => {
  await page.goto('./');
  await page.locator(ui('dashboard.entry.transfer')).click();
  // 先に源泉（移動元）を選ぶ。その後で行き先の目的別資金を入力中に作成する。
  await pick(page, 'journal.entry.flow.source', '普通預金');
  await page.locator(ui('journal.entry.reserveCreate')).click();
  await page.locator(ui('cashflow.reserve.name')).fill('新婚旅行');
  await page.locator(ui('cashflow.reserve.save')).click();

  // 作成シートが閉じ、行き先に新規目的別資金が自動選択される。
  await expect(page.locator(ui('journal.entry.flow.destination'))).toContainText('新婚旅行');
  await page.locator(ui('journal.entry.amount')).fill('100000');
  await page.locator(ui('journal.entry.save')).click();

  await openJournal(page);
  await expect(page.locator(ui('journal.entry.list'))).toContainText('普通預金 → 新婚旅行');
});

test('目的別資金は支出の支払い方法に既定で出ず、トグルで出る', async ({ page }) => {
  await page.goto('./');
  // 先に目的別資金を作る（CF 補助セクション）
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
  // 「目的別資金を使う」トグルで出る
  await page.locator(ui('journal.entry.reserveToggle')).check();
  await expect(page.locator(ui('journal.entry.flow.source'))).toContainText('旅行積立');
});

test('入力中に新しい負債（ローン）を作り、分割返済が資金繰りに出る', async ({ page }) => {
  await page.goto('./');
  await page.locator(ui('dashboard.entry.transfer')).click();
  // 先に行き先（移動先=借入金の入り先）を選ぶ。その後で源泉の負債を入力中に作成する。
  await pick(page, 'journal.entry.flow.destination', '普通預金');
  // 新しい負債（ローン=other-liability）を作る → 源泉（移動元）に選択 = 借入実行
  await page.locator(ui('journal.entry.liabilityCreate')).click();
  await page.locator(ui('journal.entry.liabilityCreate.name')).fill('自動車ローン');
  await page.locator(ui('journal.entry.liabilityCreate.save')).click();

  // 作成シートが閉じ、源泉(移動元)に新規負債が自動選択される。
  await expect(page.locator(ui('journal.entry.flow.source'))).toContainText('自動車ローン');
  await page.locator(ui('journal.entry.amount')).fill('1200000');
  // 分割返済を資金繰りに入れる（返済元=普通預金 / 12回）
  await page.locator(ui('journal.entry.loanRepayToggle')).locator('input').check();
  await pick(page, 'journal.entry.loanRepayAccount', '普通預金');
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
  await pick(page, 'journal.entry.flow.destination', '食費');
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
  await page.locator(ui('dashboard.stat.revenue')).click();
  await page.locator(ui('statements.row')).filter({ hasText: '食費' }).first().click();

  await expect(page.locator(ui('journal.view'))).toBeVisible();
  await expect(page.getByText('「食費」で絞り込み中')).toBeVisible();
  await expect(page.locator(ui('journal.entry.list'))).toContainText('コーヒー');
});

test('ホームの損益/資産サマリーから財務諸表(PL/BS)を開ける', async ({ page }) => {
  await page.goto('./');
  // 損益サマリー → 損益計算書
  await page.locator(ui('dashboard.stat.revenue')).click();
  await expect(page.locator(ui('statements.profitAndLoss'))).toBeVisible();
  // ホームへ戻り、資産負債サマリー → 貸借対照表
  await page.locator(ui('nav.home')).click();
  await page.locator(ui('dashboard.stat.assets')).click();
  await expect(page.locator(ui('statements.balanceSheet'))).toBeVisible();
  // タブ切替も従来どおり動く
  await page.locator(ui('statements.tab.pl')).click();
  await expect(page.locator(ui('statements.profitAndLoss'))).toBeVisible();
});

test('ホーム上部の入力ボタン直下に誤解を招く空カードを出さない', async ({ page }) => {
  await page.goto('./');
  await expect(page.locator(ui('dashboard.view'))).toBeVisible();
  // 入力導線の直下に「まだ仕訳がありません」カードは出さない（入力位置に仕訳が入るわけではない）。
  await expect(page.getByText('まだ仕訳がありません')).toHaveCount(0);
});

test('生活コストの月額化コストをタップすると月額化コスト画面へ遷移する（CF ではない）', async ({
  page,
}) => {
  await page.goto('./');
  await page.locator(ui('dashboard.openMonthlyCost')).click();
  await expect(page.locator(ui('allocations.view'))).toBeVisible();
});

test('ヘッダーの粒度切替（月/年/全期間）でホームの推移が直接切り替わる', async ({ page }) => {
  await page.goto('./');
  await addExpense(page, '期間テスト支出', '1500');

  // 既定は月別 → 単月なので推移は出ない。
  await expect(page.locator(ui('period.trend'))).toHaveCount(0);

  // 「年」へ直接切替 → 推移ブロックが出る。
  await page.locator(ui('period.toYear')).click();
  await expect(page.locator(ui('period.trend'))).toBeVisible();

  // 「全期間」へ直接切替 → 推移は表示され、前後移動は無効になる。
  await page.locator(ui('period.toAll')).click();
  await expect(page.locator(ui('period.trend'))).toBeVisible();
  await expect(page.locator(ui('period.prev'))).toBeDisabled();
  await expect(page.locator(ui('period.next'))).toBeDisabled();

  // 「月」へ戻すと推移は消える（単月は推移を出さない）。
  await page.locator(ui('period.toMonth')).click();
  await expect(page.locator(ui('period.trend'))).toHaveCount(0);
});

test('ヘッダーの前後移動で仕訳一覧も期間に追従する', async ({ page }) => {
  await page.goto('./');
  await addExpense(page, '当月の支出', '1000');

  // 当月の仕訳としてホームから仕訳画面を開く（当月フィルタ）。
  await openJournal(page);
  await expect(page.locator(ui('journal.entry.list'))).toContainText('当月の支出');

  // ヘッダーの「次の期間」で翌月（データなし）へ → 仕訳一覧が追従して空になる。
  await page.locator(ui('period.next')).click();
  await expect(page.getByText('当月の支出')).toHaveCount(0);
  await expect(page.getByText('該当する仕訳がありません。')).toBeVisible();

  // 「前の期間」で当月へ戻すと再び表示される。
  await page.locator(ui('period.prev')).click();
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
