// E2E smoke: コピー移植後の実 UI (workspace 回診 surface と同じ操作フロー) を 4 本で叩く。
//
// セレクタ方針 (ui-contract.ts / foundation ui/contract.ts):
//   - 第一選択は data-ui (文言変更で壊れない安定名)。名簿 (src/ui-contract.ts の UI) 経由で参照する。
//     確認ダイアログの確定は foundation ConfirmDialog の dialog.confirm を使う。
//   - ステータス選択は 5 色ボックスの固定順 (none/yellow/green/gray/blue) を index で叩く
//     (STATUS の順序はコード契約・文言に依存しない)。
//   - 文言で叩くのは ja.ts / rounds.ts 由来の設定ボタン・トーストなど最小限に留める。
//
// 前提: Playwright はテストごとに独立した BrowserContext を作るため IndexedDB は毎回まっさら。
// 初回起動で store が seed するのは プリセットテンプレート2種 + place『グループ1』のみ (対象 0 件)。

import { expect, test, type Locator, type Page } from '@playwright/test';
import { UI } from '../src/ui-contract';

/** data-ui 安定名 → CSS セレクタ。 */
function ui(name: string): string {
  return `[data-ui="${name}"]`;
}

/** foundation ConfirmDialog の確定ボタン (uiAttr('dialog.confirm'))。 */
const CONFIRM_BTN = '[data-ui="dialog.confirm"]';

/** ステータス 5 色ボックスの固定順 (StatusSwatchRow = Object.values(STATUS) の描画順)。 */
const STATUS_INDEX = { none: 0, yellow: 1, green: 2, gray: 3, blue: 4 } as const;

async function openApp(page: Page): Promise<void> {
  await page.goto('/');
  // boot (initStore) 完了 = ホームの対象追加ボタンが出る。
  await expect(page.locator(ui(UI.home.addPatient))).toBeVisible();
}

/**
 * 対象追加: ＋ボタン → 編集ポップアップが自動で開く → 位置/名前を入力 → 閉じる。
 * ホーム行 (patient.card) に「位置 名前」で載るまで待つ。
 */
async function addPatient(page: Page, room: string, name: string): Promise<void> {
  await page.locator(ui(UI.home.addPatient)).click();
  const popup = page.locator(ui(UI.patient.editPopup));
  await expect(popup).toBeVisible();
  await popup.locator(ui(UI.patient.room)).fill(room);
  await popup.locator(ui(UI.patient.name)).fill(name);
  await popup.getByRole('button', { name: '閉じる' }).click();
  await expect(popup).toBeHidden();
  await expect(page.locator(ui(UI.patient.card))).toContainText(`${room} ${name}`);
}

/** ホーム行タップで対象詳細を開く。 */
async function openDetail(page: Page, label: string): Promise<void> {
  await page.locator(ui(UI.patient.card), { hasText: label }).click();
  await expect(page.locator(ui(UI.detail.meta))).toBeVisible();
}

/** ヘッダー右上の設定アイコンから設定画面へ。 */
async function openSettings(page: Page): Promise<void> {
  await page.getByRole('button', { name: '設定', exact: true }).click();
  await expect(page.locator(ui(UI.settings.view))).toBeVisible();
}

/** ホームのステータスボタン → ポップアップで色ボックス (固定順 index) を選ぶ。 */
async function pickStatus(page: Page, index: number): Promise<void> {
  await page.locator(ui(UI.home.statusZone)).click();
  const popup = page.locator(ui(UI.patient.statusPopup));
  await expect(popup).toBeVisible();
  await popup.locator(ui(UI.patient.statusOption)).nth(index).click();
  await expect(popup).toBeHidden();
}

/** 開いている唯一の確認ダイアログを確定する (native <dialog> は同時に 1 つ)。 */
async function confirmDialog(page: Page): Promise<void> {
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  await dialog.locator(CONFIRM_BTN).click();
  await expect(dialog).toBeHidden();
}

/** QR canvas が実際に描画されている (幅 > 0 の正方形 + 非ゼロ画素がある) ことを確認する。 */
async function expectRenderedQr(canvas: Locator): Promise<void> {
  await expect(canvas).toBeVisible();
  await expect
    .poll(() =>
      canvas.evaluate((element) => {
        const qr = element as HTMLCanvasElement;
        const context = qr.getContext('2d');
        if (!context || qr.width <= 0 || qr.width !== qr.height) return false;
        return context.getImageData(0, 0, qr.width, qr.height).data.some((value) => value !== 0);
      }),
    )
    .toBe(true);
}

test.beforeEach(async ({ page }) => {
  await openApp(page);
});

// ── 1. 初回起動 → 対象追加 → 編集ポップアップ → ホーム行 → ステータス 未→途中→済 ──

test('初回起動から対象を追加し、ステータスを未→途中→済へ進められる', async ({ page }) => {
  // 初回 seed: place『グループ1』がヘッダー中央に出る (対象は 0 件)。
  await expect(page.getByRole('button', { name: 'グループ1' })).toBeVisible();
  await expect(page.locator(ui(UI.patient.card))).toHaveCount(0);

  // ＋対象追加 → 編集ポップアップ → ホーム行に「位置 名前」で表示 (addPatient 内で検証)。
  await addPatient(page, '101', '検証対象A');

  // ステータスは 未 (白・−) から始まる。
  const statusBtn = page.locator(ui(UI.home.statusZone));
  await expect(statusBtn).toHaveClass(/status-none/);
  await expect(statusBtn).toHaveText('−');

  // 未 → 途中 (黄・▲)
  await pickStatus(page, STATUS_INDEX.yellow);
  await expect(statusBtn).toHaveClass(/status-yellow/);
  await expect(statusBtn).toHaveText('▲');

  // 途中 → 済 (緑・✓)
  await pickStatus(page, STATUS_INDEX.green);
  await expect(statusBtn).toHaveClass(/status-green/);
  await expect(statusBtn).toHaveText('✓');
});

// ── 2. 詳細 → 今回メモ + 固定フォーム → その場合成 → QRダイアログ ──

test('今回メモと固定フォームから完成文を合成し、QRダイアログを表示できる', async ({ page }) => {
  await addPatient(page, '202', '検証対象B');
  await openDetail(page, '202 検証対象B');

  // 今回メモ (自由本文) 入力。
  await page.locator(ui(UI.memo.visit.input)).fill('食欲低下あり');

  // 固定フォーム (ラウンド入力カード): バイタルの BP と、身体所見の「全部正常」ワンタップ。
  // (BP/肺音/正常文はプリセットテンプレート『回診メモ』のデータであり UI 文言ではない)
  await page.getByLabel('BP', { exact: true }).fill('120/80');
  await page.getByRole('button', { name: '全部正常', exact: true }).click();
  await expect(page.getByLabel('肺音', { exact: true })).toHaveValue('明らかなラ音なし');

  // 転記用QRを開いた時点で空セクションが正常文で充填され、memoSection (O) に今回メモが入る。
  await page.locator(ui(UI.detail.emrQr)).click();
  const qrDialog = page.locator(ui(UI.detail.qrDialog));
  await expect(qrDialog).toBeVisible();
  await qrDialog.getByText('本文を確認', { exact: true }).click();
  await expect(qrDialog).toContainText('(S)');
  await expect(qrDialog).toContainText('変わりない');
  await expect(qrDialog).toContainText('BP 120/80mmHg');
  await expect(qrDialog).toContainText('肺音：明らかなラ音なし');
  await expect(qrDialog).toContainText('食欲低下あり');
  await expect(qrDialog).toContainText('現行加療継続');
  await expectRenderedQr(qrDialog.locator(ui(UI.qr.canvas)));
});

test('呼び出しフォーマットを保存すると入力カードへ昇格する', async ({ page }) => {
  await addPatient(page, '205', '呼び出し確認');
  await openDetail(page, '205 呼び出し確認');

  await page.getByRole('button', { name: '血糖', exact: true }).click();
  await page.getByLabel('Glu', { exact: true }).fill('108');
  await page.locator(ui(UI.projection.sheetSave)).click();

  await expect(page.getByLabel('Glu', { exact: true })).toHaveValue('108');
  await expect(page.getByRole('button', { name: '血糖', exact: true })).toHaveCount(0);
});

test('テンプレート編集で選択項目を作り、チップで単一選択できる', async ({ page }) => {
  await addPatient(page, '206', '選択確認');
  await openSettings(page);
  const templateRow = page.locator('.formatListRow', { hasText: '回診メモ' }).first();
  await templateRow.getByRole('button', { name: '編集', exact: true }).click();

  await page.locator(ui(UI.templateEdit.kind)).first().selectOption('select');
  await page.locator(ui(UI.templateEdit.save)).click();
  await page.locator(ui(UI.settings.homeBottom)).click();
  await openDetail(page, '206 選択確認');

  const option = page.getByRole('button', { name: '選択肢', exact: true });
  await option.click();
  await expect(option).toHaveAttribute('aria-pressed', 'true');
  await option.click();
  await expect(option).toHaveAttribute('aria-pressed', 'false');
});

test('メニュー配置からフォーマットを開いて保存できる', async ({ page }) => {
  await addPatient(page, '207', 'メニュー確認');
  await openSettings(page);
  const templateRow = page.locator('.formatListRow', { hasText: '回診メモ' }).first();
  await templateRow.getByRole('button', { name: '編集', exact: true }).click();

  const labGroup = page.locator(ui(UI.templateEdit.group), { hasText: '検査所見' }).first();
  await labGroup.locator(ui(UI.templateEdit.display)).selectOption('menu');
  await page.locator(ui(UI.templateEdit.save)).click();
  await page.locator(ui(UI.settings.homeBottom)).click();
  await openDetail(page, '207 メニュー確認');

  await page.locator(ui(UI.projection.menu)).click();
  await page.getByRole('button', { name: '検査所見', exact: true }).click();
  await page.getByLabel('採血', { exact: true }).fill('異常なし');
  await page.locator(ui(UI.projection.sheetSave)).click();
  await expect(page.getByLabel('採血', { exact: true })).toHaveValue('異常なし');
});

// ── 3. ラウンド開始 (確認ダイアログ) → 今回分クリア・問題/継続メモ維持 → 巻き戻しで復元 ──

test('ラウンド開始で今回分をクリアし（問題・継続メモは維持）、巻き戻しで復元できる', async ({
  page,
}) => {
  await addPatient(page, '303', '検証対象C');

  // クリア対象/維持対象の両方を作る: ステータス黄 + 問題 + 継続メモ + 今回メモ。
  await pickStatus(page, STATUS_INDEX.yellow);
  await openDetail(page, '303 検証対象C');
  await page.locator(ui(UI.problem.input)).first().fill('誤嚥性肺炎');
  await page.locator(ui(UI.memo.standing.input)).fill('継続メモ本文');
  await page.locator(ui(UI.memo.visit.input)).fill('今回メモ本文');
  await page.locator(ui(UI.detail.home)).click();

  // ラウンド開始 (= 記録クリア)。確認ダイアログを経由する。
  await page.locator(ui(UI.home.start)).click();
  await confirmDialog(page);

  // クリア結果: ステータス 未 / 今回メモ空。問題リスト・継続メモは残る。
  const statusBtn = page.locator(ui(UI.home.statusZone));
  await expect(statusBtn).toHaveClass(/status-none/);
  await openDetail(page, '303 検証対象C');
  await expect(page.locator(ui(UI.memo.visit.input))).toHaveValue('');
  await expect(page.locator(ui(UI.problem.input)).first()).toHaveValue('誤嚥性肺炎');
  await expect(page.locator(ui(UI.memo.standing.input))).toHaveValue('継続メモ本文');
  await page.locator(ui(UI.detail.home)).click();

  // Undo: 設定の巻き戻しに「ラウンド開始」直前のスナップショットが 1 行だけ載る → 戻す。
  await openSettings(page);
  const restoreRow = page.locator(ui(UI.settings.restoreRow));
  await expect(restoreRow).toHaveCount(1);
  await restoreRow.locator(ui(UI.settings.restoreAction)).click();
  await confirmDialog(page);

  // 復元結果: ステータス黄と今回メモが戻る。
  await page.locator(ui(UI.settings.homeBottom)).click();
  await expect(statusBtn).toHaveClass(/status-yellow/);
  await openDetail(page, '303 検証対象C');
  await expect(page.locator(ui(UI.memo.visit.input))).toHaveValue('今回メモ本文');
  await expect(page.locator(ui(UI.memo.standing.input))).toHaveValue('継続メモ本文');
});

// ── 4. 設定 → バックアップ書き出し → 全削除 → 復元 ──

test('バックアップを書き出し、全削除後に同じデータを復元できる', async ({ page }) => {
  await addPatient(page, '404', '検証対象D');
  await openSettings(page);

  // 書き出し (127.0.0.1 は test 環境判定のため test_ prefix が付く)。
  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: 'JSONバックアップを書き出す' }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toMatch(/^test_template_memo_\d{4}_\d{4}_\d{4}\.json$/);
  const backupPath = await download.path();

  // 全削除 → 初期状態 (対象 0 件・seed し直し)。
  await page.getByRole('button', { name: '全データを削除して初期状態に戻す' }).click();
  await confirmDialog(page);
  await expect(page.getByText('初期状態に戻しました', { exact: true })).toBeVisible();
  await page.locator(ui(UI.settings.homeBottom)).click();
  await expect(page.locator(ui(UI.patient.card))).toHaveCount(0);

  // 復元 (ファイル選択 → 確認ダイアログ → 置換)。
  await openSettings(page);
  const fileChooserPromise = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: 'JSONバックアップから復元する' }).click();
  const fileChooser = await fileChooserPromise;
  await fileChooser.setFiles(backupPath);
  await confirmDialog(page);
  await expect(page.getByText('復元しました', { exact: true })).toBeVisible();

  // 復元結果: 対象がホームへ戻る。
  await page.locator(ui(UI.settings.homeBottom)).click();
  await expect(page.locator(ui(UI.patient.card))).toContainText('404 検証対象D');
});
