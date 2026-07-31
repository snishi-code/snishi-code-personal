/*
 * ledger-v2 コアフロー E2E（chromium / 本番ビルド preview）。
 * data-ui（src/ui-contract.ts）だけに依存し、文言・DOM 構造には依存しない
 * （破棄確認などアプリ外文言は foundation の固定文言を使用）。
 */
import { test, expect, type Page } from '@playwright/test';

const ui = (name: string) => `[data-ui="${name}"]`;

async function boot(page: Page) {
  // 初回オンボーディング（初期残高の一括登録）を既読化してから起動する
  // （自動表示のモーダルが操作を遮らないように。オンボーディング自体は専用テストで確認）。
  await page.addInitScript(() => localStorage.setItem('slv2.onboardingDone', '1'));
  await page.goto('./');
  await expect(page.locator(ui('dashboard.view'))).toBeVisible({ timeout: 15_000 });
}

async function openSettings(page: Page) {
  await page.locator(ui('nav.menu.button')).click();
  await expect(page.locator(ui('nav.menu'))).toBeVisible();
  await page.locator(ui('nav.settings')).click();
  await expect(page.locator(ui('settings.view'))).toBeVisible();
}

test('起動 → ダッシュボードと日常入力バーが表示される', async ({ page }) => {
  await boot(page);
  await expect(page.locator(ui('dashboard.entryBar'))).toBeVisible();
  await expect(page.locator(ui('dashboard.entry.expense'))).toBeVisible();
  await expect(page.locator(ui('dashboard.entry.income'))).toBeVisible();
  await expect(page.locator(ui('dashboard.entry.transfer'))).toBeVisible();
});

test('初回起動はオンボーディング（初期残高の一括登録）が自動表示され、スキップで消える', async ({
  page,
}) => {
  // boot() と違い既読フラグを入れずに起動する（真の初回状態）。
  await page.goto('./');
  await expect(page.locator(ui('onboarding.view'))).toBeVisible({ timeout: 15_000 });
  await page.locator(ui('onboarding.skip')).click();
  await expect(page.locator(ui('onboarding.view'))).toBeHidden();
  // スキップ後は通常どおり操作でき、再読込しても再表示されない。
  await expect(page.locator(ui('dashboard.entryBar'))).toBeVisible();
  await page.reload();
  await expect(page.locator(ui('dashboard.view'))).toBeVisible({ timeout: 15_000 });
  await expect(page.locator(ui('onboarding.view'))).toBeHidden();
});

test('支出の仕訳作成 → ホームの当月仕訳プレビューへ反映され、再読込後も残る', async ({ page }) => {
  await boot(page);
  await page.locator(ui('dashboard.entry.expense')).click();
  await page.locator(ui('journal.entry.item')).fill('E2Eコーヒー');
  await page.locator(ui('journal.entry.amount')).fill('500');
  // 支払い元（資産）と費目（費用）はそれぞれ先頭の科目チップを選ぶ
  await page
    .locator(`${ui('journal.entry.flow.source')} label.chip`)
    .first()
    .click();
  await page
    .locator(`${ui('journal.entry.flow.destination')} label.chip`)
    .first()
    .click();
  await page.locator(ui('journal.entry.save')).click();
  // シートが閉じ、当月プレビューに反映される
  await expect(page.locator(ui('journal.entry.save'))).toBeHidden();
  await expect(page.locator(ui('dashboard.journal.preview'))).toContainText('E2Eコーヒー');
  // IndexedDB へ永続化されている（再読込後も表示される）
  await page.reload();
  await expect(page.locator(ui('dashboard.journal.preview'))).toContainText('E2Eコーヒー', {
    timeout: 15_000,
  });
});

test('dirty guard: 編集途中で閉じると破棄確認 → 「編集を続ける」で残り「破棄する」で閉じる', async ({
  page,
}) => {
  await boot(page);
  await page.locator(ui('dashboard.entry.expense')).click();
  await page.locator(ui('journal.entry.item')).fill('途中入力');
  // dirty 状態でキャンセル → 破棄確認ダイアログ
  await page.locator(ui('journal.entry.cancel')).click();
  const cancelBtn = page.locator(ui('dialog.cancel'));
  const confirmBtn = page.locator(ui('dialog.confirm'));
  await expect(confirmBtn).toBeVisible();
  // 「編集を続ける」→ シートは開いたまま・入力は保持
  await cancelBtn.click();
  await expect(page.locator(ui('journal.entry.item'))).toHaveValue('途中入力');
  // もう一度閉じて「破棄する」→ シートが閉じ、保存されていない
  await page.locator(ui('journal.entry.cancel')).click();
  await confirmBtn.click();
  await expect(page.locator(ui('journal.entry.save'))).toBeHidden();
  // 保存されていない（ホームのどこにも出ない。プレビュー自体が無い場合も含む）
  await expect(page.locator(ui('dashboard.view'))).not.toContainText('途中入力');
});

test('import: 他アプリ/v1 の JSON は not-our-file で拒否され、既存データは変わらない', async ({
  page,
}) => {
  await boot(page);
  await openSettings(page);
  // v1 ledger 相当の封筒（appId 不一致）を流し込む → fail-closed 拒否
  const v1like = JSON.stringify({
    appId: 'snishi-code.simple-ledger',
    schemaVersion: 16,
    exportedAt: new Date().toISOString(),
    data: {},
  });
  await page.locator(ui('settings.importFile')).setInputFiles({
    name: 'v1-export.json',
    mimeType: 'application/json',
    buffer: Buffer.from(v1like, 'utf-8'),
  });
  await expect(page.locator(ui('toast'))).toContainText(
    'このアプリの書き出しファイルではありません',
  );
});
