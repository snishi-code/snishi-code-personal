/*
 * CSV 取込（Import Profile・v8）E2E（chromium / 本番ビルド preview）。
 * 指示書 §9 の「取込 → reload → 再取込 skip」と「AI 開示（マスク適用）の表示」を実ブラウザで押さえる。
 *
 * data-ui（src/ui-contract.ts）だけに依存し、文言・DOM 構造には依存しない。
 * CSV の中身はこのファイルが作る合成データ（実データはリポジトリに入れない）。
 */
import { test, expect, type Page } from '@playwright/test';

const ui = (name: string) => `[data-ui="${name}"]`;

/** PayPay 組み込みプロファイル向けの合成 CSV（CRLF・`-`=空・quote 付きカンマ金額）。 */
const PAYPAY_CSV = [
  '取引日,出金金額（円）,入金金額（円）,取引内容,取引先,取引番号',
  '2026/08/01 09:00:00,-,500,ポイント、残高の獲得,PayPay,E2E-001',
  '2026/08/02 12:30:00,-,"1,200",ポイント、残高の獲得,PayPay,E2E-002',
].join('\r\n');

/** AI ビルダー用の未知フォーマット CSV（組み込みプロファイルでは読めない別物）。 */
const UNKNOWN_CSV = [
  '日付,内容,金額,取引先',
  '2026/08/01,買い物,-1200,スーパーA',
  '2026/08/02,給料,50000,勤務先B',
].join('\n');

async function boot(page: Page) {
  // 初回オンボーディング（初期残高の一括登録）を既読化してから起動する
  // （自動表示のモーダルが操作を遮らないように）。
  await page.addInitScript(() => localStorage.setItem('slv2.onboardingDone', '1'));
  await page.goto('./');
  await expect(page.locator(ui('dashboard.view'))).toBeVisible({ timeout: 15_000 });
}

/** メニュー → 設定 → 管理「CSV取込」。reload 後も同じ手順で戻れる（起動画面はホーム）。 */
async function openCsvImport(page: Page) {
  await page.locator(ui('nav.menu.button')).click();
  await page.locator(ui('nav.settings')).click();
  await expect(page.locator(ui('settings.view'))).toBeVisible();
  await page.locator(ui('settings.manage.csvImport')).click();
  await expect(page.locator(ui('csvImport.view'))).toBeVisible();
}

/** プロファイル選択（先頭 = 組み込み PayPay。placeholder が index 0 を占める）。 */
async function selectBuiltinProfile(page: Page) {
  const select = page.locator(ui('csvImport.profile'));
  await expect(select).toBeVisible();
  await select.selectOption({ index: 1 });
}

async function selectCsvFile(page: Page, dataUi: string, name: string, text: string) {
  await page.locator(ui(dataUi)).setInputFiles({
    name,
    mimeType: 'text/csv',
    buffer: Buffer.from(text, 'utf-8'),
  });
}

test('CSV取込: 一括適用で仕訳が増え、reload 後に同じ CSV を読み直すと全行が決定的スキップされる', async ({
  page,
}) => {
  await boot(page);
  await openCsvImport(page);
  await selectBuiltinProfile(page);
  await selectCsvFile(page, 'csvImport.file.input', 'paypay-e2e.csv', PAYPAY_CSV);

  // binding 未設定なので取込に進めない（fail-closed の gate・§1-1b）。
  await expect(page.locator(ui('csvImport.setup.open'))).toBeVisible();
  await expect(page.locator(ui('csvImport.counts'))).toBeHidden();

  // 取込元のセットアップ: 名前・自口座・獲得の計上先（サジェスト）・チャージ源泉。
  // 科目はチップの並び順で選ぶ（自口座と源泉が同じだと保存できないので別のチップにする）。
  await page.locator(ui('csvImport.setup.open')).click();
  await expect(page.locator(ui('csvImport.setup'))).toBeVisible();
  await page.locator(ui('csvImport.setup.identity')).fill('E2E取込元');
  await page
    .locator(`${ui('csvImport.setup.own')} label.chip`)
    .first()
    .click();
  await page.locator(ui('csvImport.setup.incomeSuggest')).click();
  await page
    .locator(`${ui('csvImport.setup.charge')} label.chip`)
    .nth(1)
    .click();
  await page.locator(ui('csvImport.setup.save')).click();

  // 変換できた 2 行がレビューに出る（行種は 1 種類なので一括適用が 1 つ）。
  await expect(page.locator(ui('csvImport.counts'))).toBeVisible();
  await expect(page.locator(ui('csvImport.review.row'))).toHaveCount(2);
  await expect(page.locator(ui('csvImport.review.kindBulk'))).toHaveCount(1);

  // 一括適用（確認 → 実行）。全行決定で「取込完了」になる。
  await page.locator(ui('csvImport.review.kindBulk')).click();
  const bulkConfirm = page.locator(ui('csvImport.review.bulkConfirm'));
  await expect(bulkConfirm).toBeVisible();
  await bulkConfirm.locator(ui('dialog.confirm')).click();
  await expect(page.locator(ui('csvImport.review.complete'))).toBeVisible();
  await expect(page.locator(ui('csvImport.review.row'))).toHaveCount(0);

  // 決定済み一覧: 2 件が「登録」で残り、どちらもリンク先の仕訳が実在する
  // （「仕訳を見る」は台帳に該当仕訳があるときだけ出る = 仕訳が増えたことの検証）。
  await page.locator(ui('csvImport.tab.decisions')).click();
  await expect(page.locator(ui('csvImport.decisions.row'))).toHaveCount(2);
  await page.locator(ui('csvImport.decisions.status.registered')).click();
  await expect(page.locator(ui('csvImport.decisions.row'))).toHaveCount(2);
  await expect(page.locator(ui('csvImport.decisions.openEntry'))).toHaveCount(2);
  await page.locator(ui('csvImport.decisions.openEntry')).first().click();
  await expect(page.locator(ui('journal.view'))).toBeVisible();

  // reload（= 別セッションでの再取込と同型）→ 同じ CSV を読み直す。
  await page.reload();
  await expect(page.locator(ui('dashboard.view'))).toBeVisible({ timeout: 15_000 });
  await openCsvImport(page);
  await selectBuiltinProfile(page);
  await selectCsvFile(page, 'csvImport.file.input', 'paypay-e2e.csv', PAYPAY_CSV);

  // 決定済みは黙って除外され、レビューは 0 件のまま「取込完了」。ファイル記録も出る。
  await expect(page.locator(ui('csvImport.counts'))).toBeVisible();
  await expect(page.locator(ui('csvImport.review.complete'))).toBeVisible();
  await expect(page.locator(ui('csvImport.review.row'))).toHaveCount(0);
  await expect(page.locator(ui('csvImport.fileRecord'))).toBeVisible();
});

test('AI プロファイルビルダー: 送信内容の完全プレビューがマスク・除外の指定どおりに変わる', async ({
  page,
}) => {
  await boot(page);
  await openCsvImport(page);
  await page.locator(ui('csvImport.tab.profiles')).click();
  await page.locator(ui('csvImport.builder.open')).click();
  await expect(page.locator(ui('csvImport.builder'))).toBeVisible();
  await selectCsvFile(page, 'csvImport.builder.fileInput', 'unknown-bank.csv', UNKNOWN_CSV);

  // 依頼文 = AI に渡る内容の全文。既定（そのまま）ではサンプル行の実値が入る。
  const prompt = page.locator(ui('csvImport.builder.prompt'));
  await expect(prompt).toBeVisible();
  await expect(prompt).toHaveValue(/スーパーA/);
  await expect(prompt).toHaveValue(/2026\/08\/01/);

  // 取引先（4 列目）をマスク → 実値が消えて *** に置き換わる（他列の実値は残る）。
  const maskModes = page.locator(
    `${ui('csvImport.builder.maskList')} ${ui('csvImport.builder.maskMode')}`,
  );
  await expect(maskModes).toHaveCount(4);
  await maskModes.nth(3).selectOption('mask');
  await expect(prompt).not.toHaveValue(/スーパーA/);
  await expect(prompt).not.toHaveValue(/勤務先B/);
  await expect(prompt).toHaveValue(/\*\*\*/);
  await expect(prompt).toHaveValue(/買い物/);

  // 日付（1 列目）を除外 → 列ごと送られない。戻せば再び入る。
  await maskModes.nth(0).selectOption('omit');
  await expect(prompt).not.toHaveValue(/2026\/08\/01/);
  await maskModes.nth(0).selectOption('raw');
  await expect(prompt).toHaveValue(/2026\/08\/01/);
});
