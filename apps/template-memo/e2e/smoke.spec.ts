// E2E smoke: コピー移植後の実 UI (workspace 回診 surface と同じ操作フロー) を一通り叩く。
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
import { BUILDER_EXPECTED_JSON } from '../src/domain/templateBuilder';
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
  // 追加した行そのものを見る（複数件あると非スコープの locator は strict mode に触れる）。
  await expect(page.locator(ui(UI.patient.card), { hasText: `${room} ${name}` })).toBeVisible();
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

/** 正常チェックを長押しして確定する。 */
async function hold(page: Page, target: Locator, ms = 450): Promise<void> {
  await target.dispatchEvent('pointerdown', { pointerType: 'touch' });
  await page.waitForTimeout(ms);
  await target.dispatchEvent('pointerup', { pointerType: 'touch' });
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

// ── 2. 詳細 → 場所ごとの自由入力欄 + 固定フォーム → その場合成 → QRダイアログ ──

test('場所ごとの自由入力と固定フォームから完成文を合成し、QRダイアログを表示できる', async ({
  page,
}) => {
  await addPatient(page, '202', '検証対象B');
  await openDetail(page, '202 検証対象B');

  // 場所は空でも常時表示: フォーマットを持たない (S)/(A)/(P) も見出しが出る (フィルタ復活の回帰網)。
  const projectionCard = page.locator(ui(UI.projection.card));
  for (const heading of ['(S)', '(O)', '(A)', '(P)']) {
    await expect(projectionCard).toContainText(heading);
  }

  // SOAP プリセットは 4 場所とも freeText: 自由入力欄が場所の数だけ出る。
  const freeTexts = projectionCard.locator(ui(UI.projection.freeText));
  await expect(freeTexts).toHaveCount(4);

  // (S) と (O) へ別々の自由本文を入れる (取り違えると完成文の並びで検知できる)。
  await freeTexts.nth(0).fill('食欲低下あり');
  await freeTexts.nth(1).fill('右下肺に湿性ラ音');

  // 固定フォーム (ラウンド入力カード): バイタルの BP と、肺音の正常チェックを入力。
  // (BP/肺音/正常文はプリセットテンプレート『回診』のデータであり UI 文言ではない)
  await page.getByLabel('BP（mmHg）', { exact: true }).fill('120/80');
  const lungRow = page.locator('.projectionField', {
    has: page.getByLabel('肺音', { exact: true }),
  });
  await hold(page, lungRow.locator(ui(UI.projection.normalBtn)));
  await expect(page.getByLabel('肺音', { exact: true })).toHaveValue('明らかなラ音なし');

  // 転記用QRを開いた時点で、空の場所は正常文で充填され、自由本文はそれぞれの場所へ載る。
  await page.locator(ui(UI.detail.emrQr)).click();
  const qrDialog = page.locator(ui(UI.detail.qrDialog));
  await expect(qrDialog).toBeVisible();
  await qrDialog.getByText('本文を確認', { exact: true }).click();
  // (S) の下に S の本文 → (O) の下にフォーム値と O の本文 → 空の (A)(P) は正常文へ倒れる。
  await expect(qrDialog).toContainText('(S)\n食欲低下あり');
  await expect(qrDialog).toContainText('BP 120/80mmHg');
  await expect(qrDialog).toContainText('肺音：明らかなラ音なし');
  await expect(qrDialog).toContainText(
    '(O)\nBP 120/80mmHg\n\n肺音：明らかなラ音なし\n\n右下肺に湿性ラ音\n\n(A)\n著変なし',
  );
  await expect(qrDialog).toContainText('(P)\n現行加療継続');
  // (S) を空にすると normal (変わりない) へ倒れる。
  await qrDialog.getByRole('button', { name: '閉じる' }).click();
  await freeTexts.nth(0).fill('');
  await page.locator(ui(UI.detail.emrQr)).click();
  await qrDialog.getByText('本文を確認', { exact: true }).click();
  await expect(qrDialog).toContainText('(S)\n変わりない');
  await expectRenderedQr(qrDialog.locator(ui(UI.qr.canvas)));
});

test('freeText を外した場所には自由入力欄が出ない', async ({ page }) => {
  await addPatient(page, '209', '自由本文なし確認');
  await openSettings(page);
  const frameSection = page.locator(ui(UI.settings.frameSection));
  await frameSection
    .locator('.formatListRow', { hasText: 'SOAP' })
    .first()
    .getByRole('button', { name: /を編集$/ })
    .click();
  // 先頭の場所 (S) の「自由本文欄を持つ」を外す。
  await page.getByRole('checkbox', { name: '自由本文欄を持つ' }).first().uncheck();
  await page.locator(ui(UI.frameEdit.save)).click();
  await page.locator(ui(UI.settings.homeBottom)).click();
  await openDetail(page, '209 自由本文なし確認');

  const projectionCard = page.locator(ui(UI.projection.card));
  await expect(projectionCard.locator(ui(UI.projection.freeText))).toHaveCount(3);
});

test('ホームの縦位置は詳細から戻っても保たれ、一番上へ戻るボタンで先頭へ返れる', async ({
  page,
}) => {
  // 一覧を実際にスクロールできる高さにする（位置順に並ぶので 3 桁で連番）。
  await page.setViewportSize({ width: 375, height: 640 });
  for (let n = 0; n < 12; n += 1) {
    await addPatient(page, `${101 + n}`, `対象${n}`);
  }

  // 下の方の対象までスクロールして開く。
  const target = page.locator(ui(UI.patient.card), { hasText: '112 対象11' });
  await target.scrollIntoViewIfNeeded();
  const before = await page.evaluate(() => window.scrollY);
  expect(before).toBeGreaterThan(0);

  await target.click();
  await expect(page.locator(ui(UI.detail.meta))).toBeVisible();
  // 詳細は先頭から見せる（前の画面の位置を持ち込まない）。
  expect(await page.evaluate(() => window.scrollY)).toBe(0);

  // ホームへ戻ると、さっきまで見ていた位置に戻る（1 件ごとに先頭へ飛ばされない）。
  await page.locator(ui(UI.detail.home)).click();
  await expect(page.locator(ui(UI.home.addPatient))).toBeVisible();
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(before);

  // 深い位置では「一番上へ移動」が出て、押すと先頭へ返る。
  const scrollTop = page.locator(ui(UI.home.scrollTop));
  await expect(scrollTop).toBeVisible();
  await scrollTop.click();
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(0);
  // 先頭では要素ごと消える（タブ順・支援技術に出さない）。
  await expect(scrollTop).toHaveCount(0);
});

test('呼び出しフォーマットを保存すると入力カードへ昇格する', async ({ page }) => {
  await addPatient(page, '205', '呼び出し確認');
  // 既定の回診は 2 配置とも「展開」なので、身体所見を「呼び出し」へ変えてから確かめる。
  await openSettings(page);
  await page
    .locator('.formatListRow', { hasText: '回診' })
    .first()
    .getByRole('button', { name: '回診 を編集' })
    .click();
  await page
    .locator(ui(UI.templateEdit.placement), { hasText: '身体所見' })
    .first()
    .locator(ui(UI.templateEdit.display))
    .selectOption('oncall');
  await page.locator(ui(UI.templateEdit.save)).click();
  await page.locator(ui(UI.settings.homeBottom)).click();

  await openDetail(page, '205 呼び出し確認');
  await page.getByRole('button', { name: '身体所見', exact: true }).click();
  await page.getByLabel('肺音', { exact: true }).fill('湿性ラ音あり');
  await page.locator(ui(UI.projection.sheetSave)).click();

  await expect(page.getByLabel('肺音', { exact: true })).toHaveValue('湿性ラ音あり');
  await expect(page.getByRole('button', { name: '身体所見', exact: true })).toHaveCount(0);
});

test('フォーマット編集で選択項目を作り、チップで単一選択できる', async ({ page }) => {
  await addPatient(page, '206', '選択確認');
  await openSettings(page);
  const formatSection = page.locator(ui(UI.settings.formatSection));
  const formatRow = formatSection.locator('.formatListRow', { hasText: 'バイタル' });
  await formatRow.getByRole('button', { name: /を編集$/ }).click();

  // 「種類」と kind 別フィールドが同じ行に並ぶ (先頭項目は SpO2 = 入力なので「種類」+「単位」)。
  const firstKindRow = page.locator('.templateEditKindRow').first();
  await expect(firstKindRow.locator('.field')).toHaveCount(2);
  await expect
    .poll(() =>
      firstKindRow.locator('.field').evaluateAll((fields) => {
        const tops = fields.map((field) => field.getBoundingClientRect().top);
        return tops.every((top) => Math.abs(top - (tops[0] ?? top)) < 2);
      }),
    )
    .toBe(true);

  // フォーマット > 項目の入れ子が、主用途の 375px 幅でも横にはみ出さない。
  await page.setViewportSize({ width: 375, height: 812 });
  await expect
    .poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth))
    .toBe(true);
  // 種類 + kind 別フィールドは 375px でも 1 行に収まる (行圧縮の主目的はスマホ幅)。
  await expect
    .poll(() =>
      firstKindRow.locator('.field').evaluateAll((fields) => {
        const tops = fields.map((field) => field.getBoundingClientRect().top);
        return tops.every((top) => Math.abs(top - (tops[0] ?? top)) < 2);
      }),
    )
    .toBe(true);
  // 以降の手順はデスクトップ幅へ戻して続ける (他テストと条件を揃える)。
  await page.setViewportSize({ width: 1280, height: 720 });

  await page.locator(ui(UI.formatEdit.kind)).first().selectOption('select');
  await page.locator(ui(UI.formatEdit.save)).click();
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
  const templateRow = page.locator('.formatListRow', { hasText: '回診' }).first();
  await templateRow.getByRole('button', { name: '回診 を編集' }).click();

  const placement = page.locator(ui(UI.templateEdit.placement), { hasText: '身体所見' }).first();
  await placement.locator(ui(UI.templateEdit.display)).selectOption('menu');
  await page.locator(ui(UI.templateEdit.save)).click();
  await page.locator(ui(UI.settings.homeBottom)).click();
  await openDetail(page, '207 メニュー確認');

  await page.locator(ui(UI.projection.menu)).click();
  await page.getByRole('button', { name: '身体所見', exact: true }).click();
  await page.getByLabel('肺音', { exact: true }).fill('異常なし');
  await page.locator(ui(UI.projection.sheetSave)).click();
  await expect(page.getByLabel('肺音', { exact: true })).toHaveValue('異常なし');
});

test('フォーマット単独QRを受け取り、同じIDはコピーとして保存する', async ({ page }) => {
  await openSettings(page);
  const pages = await page.evaluate(async () => {
    // Vite がブラウザへ配信する実モジュールを使い、UI と同じ C1/FMT wire を作る。
    // モジュール指定子はブラウザ側の URL パスで、tsc のモジュール解決対象ではないため、
    // 文字列リテラルのまま import() へ渡さない（変数越しにして静的解決を避ける）。
    const wireModulePath = '/src/domain/templateWire.ts';
    const wire = await import(wireModulePath);
    return wire.encodeShareWirePages(
      {
        kind: wire.FORMAT_WIRE_KIND,
        format: {
          id: 'fmt_e2e_shared',
          name: 'QR共有フォーマット',
          joiner: '\n',
          labelSep: '：',
          titleWrap: '',
          items: [{ id: 'itm_e2e_shared', label: '共有項目', kind: 'text' }],
        },
      },
      { batchId: 'e2e-format' },
    );
  });

  async function receive(): Promise<void> {
    // 「QRで受け取る」は 3 節 (テンプレート/フレーム/フォーマット) の見出しに同じ名前で並ぶため、
    // 受け取る部品の節 (ここではフォーマット) に絞って掴む。
    await page
      .locator(ui(UI.settings.formatSection))
      .getByRole('button', { name: 'QRで受け取る', exact: true })
      .click();
    for (const wirePage of pages) {
      await page.getByLabel('QR文字列を貼り付け').fill(wirePage);
      await page.getByRole('button', { name: 'このページを読み取る' }).click();
    }
    const dialog = page.getByRole('dialog');
    await expect(dialog.getByText('QR共有フォーマット', { exact: true })).toBeVisible();
    await dialog.getByRole('button', { name: '保存', exact: true }).click();
  }

  await receive();
  await receive();
  const formatSection = page
    .locator('.settingsSection')
    .filter({ has: page.getByText('フォーマット', { exact: true }) });
  await expect(
    formatSection.locator('.formatListRow', { hasText: 'QR共有フォーマット' }),
  ).toHaveCount(2);

  const importedRow = formatSection
    .locator('.formatListRow', {
      hasText: 'QR共有フォーマット',
    })
    .first();
  await importedRow.getByRole('button', { name: 'QR送信' }).click();
  await expectRenderedQr(page.getByRole('dialog').locator('canvas'));
  await page.getByRole('dialog').getByRole('button', { name: '閉じる' }).click();
});

test('テンプレートはグループとページで切り替えられる（作成時にデフォルトを写す）', async ({
  page,
}) => {
  // グループのデフォルトを日報へ変える (設定のグループ一覧のプルダウン)。
  await openSettings(page);
  const wardRow = page.locator(ui(UI.settings.wardRow)).first();
  await wardRow.locator(ui(UI.settings.wardTemplate)).selectOption({ label: '日報' });
  await page.locator(ui(UI.settings.homeBottom)).click();

  // 以後このグループに増やすページは日報になる。
  await addPatient(page, '501', '日報ページ');
  await openDetail(page, '501 日報ページ');
  const projection = page.locator(ui(UI.projection.card));
  await expect(projection).toContainText('【今日やったこと】');
  await expect(projection).not.toContainText('(S)');

  // ページ単位の切替 (タグ行の右端)。回診へ切り替えると入力カードも追従する。
  await page.locator(ui(UI.detail.template)).selectOption({ label: '回診' });
  await expect(projection).toContainText('(S)');
  await expect(page.getByLabel('BP（mmHg）', { exact: true })).toBeVisible();

  // 転記用 QR もページのテンプレートで合成される。
  await page.getByLabel('BP（mmHg）', { exact: true }).fill('120/80');
  await page.locator(ui(UI.detail.emrQr)).click();
  const qrDialog = page.locator(ui(UI.detail.qrDialog));
  await qrDialog.getByText('本文を確認', { exact: true }).click();
  await expect(qrDialog).toContainText('BP 120/80mmHg');
  await qrDialog.getByRole('button', { name: '閉じる' }).click();

  // 書き込みはデバウンス保存 (180ms)。テストは人間より速く、リロードまでに保存の
  // 隙間が生まれないことがあるため、IDB へ着地してからリロードする (実利用では
  // 操作間隔が常にデバウンスより長い)。永続化そのものの検証も兼ねる。
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          new Promise((res) => {
            const req = indexedDB.open('template-memo');
            req.onsuccess = () => {
              const db = req.result;
              db.transaction('patients').objectStore('patients').getAll().onsuccess = (e) => {
                const rows = (e.target as IDBRequest).result as { name?: string }[];
                res(rows[0]?.name ?? '');
                db.close();
              };
            };
          }),
      ),
    )
    .toBe('日報ページ');

  // 再読み込みしてもページの選択は残る (templateId の永続化)。
  await page.reload();
  await openDetail(page, '501 日報ページ');
  await expect(page.locator(ui(UI.projection.card))).toContainText('(S)');

  // テンプレート一覧の行タップは編集 (2026-08-20 に全一覧共通の「行タップ = 編集」へ)。
  await page.locator(ui(UI.detail.home)).click();
  await openSettings(page);
  const dailyRow = page.locator('.formatListRow', { hasText: '日報' }).first();
  // グループのデフォルトを日報へ変えたので、メタ表記は使用グループ数を示す。
  await expect(dailyRow.locator('.pickerRowMeta')).toHaveText('グループ 1件で使用');
  await dailyRow.getByRole('button', { name: '日報 を編集' }).click();
  await expect(page.locator(ui(UI.templateEdit.view))).toBeVisible();
});

test('新しいグループは 1 つ上のグループのデフォルトテンプレートを写す', async ({ page }) => {
  // 既存グループ (グループ1) のデフォルトを日報へ変えてからグループを追加する。
  await openSettings(page);
  const wardRow = page.locator(ui(UI.settings.wardRow)).first();
  await wardRow.locator(ui(UI.settings.wardTemplate)).selectOption({ label: '日報' });
  await page.locator(ui(UI.settings.wardAdd)).click();
  await page.getByLabel('グループを追加').fill('グループ2');
  await page.keyboard.press('Enter');
  const newRow = page.locator(ui(UI.settings.wardRow), { hasText: 'グループ2' });
  await expect(newRow.locator(ui(UI.settings.wardTemplate))).toHaveValue(
    await wardRow.locator(ui(UI.settings.wardTemplate)).inputValue(),
  );
});

test('使用中フォーマットは参照テンプレート名を示して削除を拒否する', async ({ page }) => {
  await openSettings(page);
  const formatSection = page.locator(ui(UI.settings.formatSection));
  const row = formatSection.locator('.formatListRow', { hasText: 'バイタル' });
  await row.getByRole('button', { name: '削除', exact: true }).click();
  await confirmDialog(page);
  await expect(
    page.getByText('このフォーマットはテンプレート「回診」で使用中のため削除できません'),
  ).toBeVisible();
  await expect(row).toBeVisible();
});

test('複製してから編集すれば、元のフォーマットを使うテンプレートは変わらない', async ({ page }) => {
  await addPatient(page, '208', '複製確認');
  await openSettings(page);
  const formatSection = page.locator(ui(UI.settings.formatSection));
  await formatSection
    .locator('.formatListRow', { hasText: '身体所見' })
    .first()
    .getByRole('button', { name: '複製', exact: true })
    .click();
  const copyRow = formatSection.locator('.formatListRow', { hasText: '身体所見のコピー' });
  await expect(copyRow).toBeVisible();

  // コピー側の先頭項目 (肺音) を書き換えて保存しても、回診は元の身体所見を参照したまま。
  await copyRow.getByRole('button', { name: /を編集$/ }).click();
  await page.getByLabel('ラベル（例 肺音）').first().fill('肺音改');
  await page.locator(ui(UI.formatEdit.save)).click();
  await page.locator(ui(UI.settings.homeBottom)).click();
  await openDetail(page, '208 複製確認');
  const projection = page.locator(ui(UI.projection.card));
  await expect(projection).toContainText('肺音');
  await expect(projection).not.toContainText('肺音改');
});

test('文章の例と固定JSON返答から候補を確認し、テンプレート一式を登録できる', async ({ page }) => {
  await openSettings(page);
  await page.setViewportSize({ width: 375, height: 812 });
  await expect
    .poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth))
    .toBe(true);
  const builder = page.locator(ui(UI.settings.builderSection));
  const formatSection = page.locator(ui(UI.settings.formatSection));
  const templateSection = page.locator(ui(UI.settings.templateSection));
  const beforeFormats = await formatSection.locator('.formatListRow').count();
  const beforeTemplates = await templateSection.locator('.formatListRow').count();

  await builder.locator(ui(UI.settings.builderSources)).click();
  let dialog = page.getByRole('dialog');
  await dialog
    .getByRole('textbox', { name: '文章の例 1' })
    .fill(
      '【点検概要】\n定期点検を実施\n【測定値】\n温度 24℃、混合比 1/2、運転モード 自動\n外装：異常なし',
    );
  await dialog.getByRole('button', { name: '文章の例を保存' }).click();

  const promptButton = builder.locator(ui(UI.settings.builderPrompt));
  await expect(promptButton).toContainText('要再作成');
  await promptButton.click();
  dialog = page.getByRole('dialog');
  const prompt = await dialog.locator('textarea[readonly]').inputValue();
  const requestId = /requestId は「([^」]+)」/.exec(prompt)?.[1];
  expect(requestId).toBeTruthy();
  await expect(promptButton).toContainText('作成済み');
  await dialog.getByRole('button', { name: '閉じる' }).click();

  await builder.locator(ui(UI.settings.builderResponse)).click();
  dialog = page.getByRole('dialog');
  await dialog
    .getByRole('textbox', { name: 'AIアプリから返されたJSON' })
    .fill(BUILDER_EXPECTED_JSON.replace('<依頼文の requestId をそのまま返す>', requestId!));
  await dialog.getByRole('button', { name: '返答を解析' }).click();
  await expect(builder.locator(ui(UI.settings.builderResponse))).toContainText('解析済み');

  await builder.locator(ui(UI.settings.builderPreviewOpen)).click();
  await expect(page.locator(ui(UI.settings.builderPreview))).toContainText('設備点検');
  await page.locator(ui(UI.settings.builderApply)).click();

  await expect(formatSection.locator('.formatListRow')).toHaveCount(beforeFormats + 2);
  await expect(templateSection.locator('.formatListRow')).toHaveCount(beforeTemplates + 1);
});

// ── 3. ラウンド開始 (確認ダイアログ) → 今回分クリア・問題/継続メモ維持 → 巻き戻しで復元 ──

test('ラウンド開始で今回分をクリアし（問題・継続メモは維持）、巻き戻しで復元できる', async ({
  page,
}) => {
  await addPatient(page, '303', '検証対象C');

  // クリア対象/維持対象の両方を作る: ステータス黄 + 問題 + 継続メモ + 自由本文 + フォーム値。
  await pickStatus(page, STATUS_INDEX.yellow);
  await openDetail(page, '303 検証対象C');
  await page.locator(ui(UI.problem.input)).first().fill('誤嚥性肺炎');
  await page.locator(ui(UI.memo.standing.input)).fill('継続メモ本文');
  const freeTexts = page.locator(ui(UI.projection.card)).locator(ui(UI.projection.freeText));
  await freeTexts.nth(0).fill('Sの自由本文');
  await freeTexts.nth(1).fill('Oの自由本文');
  await page.getByLabel('BP（mmHg）', { exact: true }).fill('120/80');
  await page.locator(ui(UI.detail.home)).click();

  // ラウンド開始 (= 記録クリア)。確認ダイアログを経由する。
  await page.locator(ui(UI.home.start)).click();
  await confirmDialog(page);

  // クリア結果: ステータス 未 / 自由本文・フォーム値は空。問題リスト・継続メモは残る。
  const statusBtn = page.locator(ui(UI.home.statusZone));
  await expect(statusBtn).toHaveClass(/status-none/);
  await openDetail(page, '303 検証対象C');
  await expect(freeTexts.nth(0)).toHaveValue('');
  await expect(freeTexts.nth(1)).toHaveValue('');
  await expect(page.getByLabel('BP（mmHg）', { exact: true })).toHaveValue('');
  await expect(page.locator(ui(UI.problem.input)).first()).toHaveValue('誤嚥性肺炎');
  await expect(page.locator(ui(UI.memo.standing.input))).toHaveValue('継続メモ本文');
  await page.locator(ui(UI.detail.home)).click();

  // Undo: 設定の巻き戻しに「ラウンド開始」直前のスナップショットが 1 行だけ載る → 戻す。
  await openSettings(page);
  const restoreRow = page.locator(ui(UI.settings.restoreRow));
  await expect(restoreRow).toHaveCount(1);
  await restoreRow.locator(ui(UI.settings.restoreAction)).click();
  await confirmDialog(page);

  // 復元結果: ステータス黄と場所ごとの自由本文が戻る (取り違えず元の場所へ)。
  await page.locator(ui(UI.settings.homeBottom)).click();
  await expect(statusBtn).toHaveClass(/status-yellow/);
  await openDetail(page, '303 検証対象C');
  await expect(freeTexts.nth(0)).toHaveValue('Sの自由本文');
  await expect(freeTexts.nth(1)).toHaveValue('Oの自由本文');
  await expect(page.locator(ui(UI.memo.standing.input))).toHaveValue('継続メモ本文');
});

// ── 3b. タグ: 設定で作成 (既定色) → 詳細のタグ行で付け外し → ラウンド開始で色ごとの去就 ──

test('タグは既定で青（残る）で作られ、オレンジにした分だけラウンド開始で外れる', async ({
  page,
}) => {
  await addPatient(page, '404', 'タグ対象D');

  // 設定でタグを 2 つ作る (新規タグの既定色 = 青 = ラウンド開始で残る)。
  await openSettings(page);
  for (const name of ['継続', '今回']) {
    await page.locator(ui(UI.tags.addBtn)).click();
    await page.getByLabel('新規タグ', { exact: true }).fill(name);
    await page.getByLabel('新規タグ', { exact: true }).press('Enter');
  }
  const tagRows = page.locator(ui(UI.settings.tagRow));
  await expect(tagRows).toHaveCount(2);

  // 色スウォッチは TAG_COLORS の固定順 (0=青=残る / 1=オレンジ=外れる)。
  const keepSwatch = (row: Locator) => row.locator(ui(UI.settings.tagColor)).nth(0);
  const clearSwatch = (row: Locator) => row.locator(ui(UI.settings.tagColor)).nth(1);
  // 既定は青 (色を付け忘れたタグが黙って消えない安全側)。
  await expect(keepSwatch(tagRows.nth(0))).toHaveAttribute('aria-pressed', 'true');
  await expect(keepSwatch(tagRows.nth(1))).toHaveAttribute('aria-pressed', 'true');
  // 「今回」だけオレンジ (= ラウンド開始で外れる) にする。
  await clearSwatch(tagRows.nth(1)).click();
  await expect(clearSwatch(tagRows.nth(1))).toHaveAttribute('aria-pressed', 'true');

  // 詳細のヘッダー直下のタグ行から、その場で 2 つとも付ける。
  await page.locator(ui(UI.settings.homeBottom)).click();
  await openDetail(page, '404 タグ対象D');
  const detailTags = page.locator(ui(UI.detail.tags)).locator(ui(UI.tags.selectChip));
  await expect(detailTags).toHaveCount(2);
  await detailTags.nth(0).click();
  await detailTags.nth(1).click();
  await expect(detailTags.nth(0)).toHaveAttribute('aria-pressed', 'true');
  await expect(detailTags.nth(1)).toHaveAttribute('aria-pressed', 'true');

  // ラウンド開始: 青のタグは残り、オレンジのタグだけ外れる。
  await page.locator(ui(UI.detail.home)).click();
  await page.locator(ui(UI.home.start)).click();
  await confirmDialog(page);
  await openDetail(page, '404 タグ対象D');
  await expect(detailTags.nth(0)).toHaveAttribute('aria-pressed', 'true');
  await expect(detailTags.nth(1)).toHaveAttribute('aria-pressed', 'false');
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
