/*
 * visual check（仕様§19）: mobile/tablet/desktop の 3 サイズで主要画面を撮影し、
 * 横スクロール（レイアウト破綻の代表症状）が無いことを機械検証する。
 * スクリーンショットは test-results/screenshots/ 配下に保存する。
 */
import { test, expect, type Page } from '@playwright/test';

const ui = (name: string) => `[data-ui="${name}"]`;

const VIEWPORTS = [
  { name: 'mobile-390x844', width: 390, height: 844 },
  { name: 'tablet-820x1180', width: 820, height: 1180 },
  { name: 'desktop-1280x800', width: 1280, height: 800 },
] as const;

async function expectNoHorizontalScroll(page: Page, label: string) {
  const overflow = await page.evaluate(() => {
    const el = document.scrollingElement ?? document.documentElement;
    return el.scrollWidth - el.clientWidth;
  });
  expect(overflow, `${label}: 横スクロールが発生 (${overflow}px)`).toBeLessThanOrEqual(1);
}

for (const vp of VIEWPORTS) {
  test(`主要画面のレイアウト確認 (${vp.name})`, async ({ page }) => {
    await page.setViewportSize({ width: vp.width, height: vp.height });
    // 初回オンボーディングを既読化してから起動する（撮影・クリックを遮らないように）。
    await page.addInitScript(() => localStorage.setItem('slv2.onboardingDone', '1'));
    // sample fixture には継続コスト台帳と movable=false 科目があり、今回追加した意味色も撮影できる。
    await page.goto('./?fixture=sample');
    await expect(page.locator(ui('dashboard.view'))).toBeVisible({ timeout: 15_000 });

    // 現在期間の仕訳導線も確認できるよう、サンプル台帳へ当日分を 1 件追加する。
    await page.locator(ui('dashboard.entry.expense')).click();
    await page.locator(ui('journal.entry.item')).fill('視覚確認用');
    await page.locator(ui('journal.entry.amount')).fill('1200');
    await page
      .locator(`${ui('journal.entry.flow.source')} label.chip`)
      .first()
      .click();
    await page
      .locator(`${ui('journal.entry.flow.destination')} label.chip`)
      .first()
      .click();
    await page.locator(ui('journal.entry.save')).click();
    await expect(page.locator(ui('journal.entry.save'))).toBeHidden();

    await expectNoHorizontalScroll(page, `dashboard ${vp.name}`);
    await page.screenshot({
      path: `test-results/screenshots/ledger-dashboard-${vp.name}.png`,
      fullPage: true,
    });

    // 額縁の宣言（スクロール量に依存しない検証）。実際に流して固定されることは
    // 専用テスト「ホームの額縁は…」で確認する（この 3 ビューポートループは仕訳 1 件で
    // スクロールしないため、ここで toBeInViewport を見ても常に真になる = 偽緑）。
    const frameStyle = await page.locator(ui('dashboard.frame')).evaluate((el) => {
      const cs = getComputedStyle(el);
      return { position: cs.position, top: cs.top };
    });
    expect(frameStyle.position, `dashboard frame sticky ${vp.name}`).toBe('sticky');
    expect(frameStyle.top, `dashboard frame top ${vp.name}`).toBe('57px');
    const viewAllBox = await page.locator(ui('dashboard.journal.openAll')).boundingBox();
    expect(viewAllBox?.height ?? 0, `すべて見る 44px ${vp.name}`).toBeGreaterThanOrEqual(44);

    // 仕訳一覧（ホームの「すべて表示」から）
    await page.locator(ui('dashboard.journal.openAll')).click();
    await expect(page.locator(ui('journal.view'))).toBeVisible();
    await expectNoHorizontalScroll(page, `journal ${vp.name}`);
    await page.screenshot({
      path: `test-results/screenshots/ledger-journal-${vp.name}.png`,
      fullPage: true,
    });

    // 入力シート（支出）
    await page.locator(ui('nav.footer.home')).click();
    await expect(page.locator(ui('dashboard.view'))).toBeVisible();
    await page.locator(ui('dashboard.entry.expense')).click();
    await expect(page.locator(ui('journal.entry.save'))).toBeVisible();
    await expectNoHorizontalScroll(page, `entrySheet ${vp.name}`);
    await page.screenshot({
      path: `test-results/screenshots/ledger-entrysheet-${vp.name}.png`,
      fullPage: true,
    });
    await page.locator(ui('journal.entry.cancel')).click();

    // 資産・負債の枠分け（意味色・小計・継続コスト台帳を含む）。
    await page.locator(ui('dashboard.stat.assets')).click();
    await expect(page.locator(ui('assetsBreakdown.view'))).toBeVisible();
    await expectNoHorizontalScroll(page, `assetsBreakdown ${vp.name}`);
    await page.screenshot({
      path: `test-results/screenshots/ledger-assets-${vp.name}.png`,
      fullPage: true,
    });
    await page.locator(ui('nav.footer.home')).click();
    await page.locator(ui('dashboard.stat.liabilities')).click();
    await expect(page.locator(ui('liabilitiesBreakdown.view'))).toBeVisible();
    await expectNoHorizontalScroll(page, `liabilitiesBreakdown ${vp.name}`);
    await page.screenshot({
      path: `test-results/screenshots/ledger-liabilities-${vp.name}.png`,
      fullPage: true,
    });

    // 勘定科目（箱見出しの意味色）。
    await page.locator(ui('nav.menu.button')).click();
    await page.locator(ui('nav.accounts')).click();
    await expect(page.locator(ui('accounts.view'))).toBeVisible();
    await expectNoHorizontalScroll(page, `accounts ${vp.name}`);
    await page.screenshot({
      path: `test-results/screenshots/ledger-accounts-${vp.name}.png`,
      fullPage: true,
    });

    // 時間平面の数値レンズ（旧「年間・全体」画面）。ページ全体ではなく表のコンテナだけを
    // 横スクロールする。入口はヘッダーのズーム（断面画面から押すと時間平面へ移動する）+
    // 画面内のレンズセレクタ。
    await page.locator(ui('period.zoom.month')).click();
    await expect(page.locator(ui('timeline.view'))).toBeVisible();
    await expect(page.locator(ui('period.zoom.month'))).toHaveAttribute('aria-pressed', 'true');
    await page.locator(ui('timeline.lens.matrix')).click();
    await expect(page.locator(ui('timeline.matrix'))).toBeVisible();
    // 数値レンズに日の列は無い = ヘッダーの「日」は押せない。
    await expect(page.locator(ui('period.zoom.day'))).toBeDisabled();
    await expectNoHorizontalScroll(page, `timelineMatrix ${vp.name}`);
    if (vp.width === 390) {
      const matrixScrolls = await page.locator(ui('timeline.matrix')).evaluate((element) => {
        return element.scrollWidth > element.clientWidth;
      });
      expect(matrixScrolls, 'mobile: 数値レンズの表のコンテナ内で横スクロールできる').toBe(true);
    }
    await page.screenshot({
      path: `test-results/screenshots/ledger-timeline-matrix-${vp.name}.png`,
      fullPage: true,
    });
    // グラフレンズ。ラベル列は 3 レンズ共通で、チェックボックスが系列選択を兼ねる。
    await page.locator(ui('timeline.lens.chart')).click();
    await expect(page.locator(ui('timeline.chart'))).toBeVisible();
    // 数値レンズと違い、グラフには日のバケットがある = ヘッダーの「日」が押せる。
    await expect(page.locator(ui('period.zoom.day'))).toBeEnabled();
    await expectNoHorizontalScroll(page, `timelineChart ${vp.name}`);
    // 既定は全 ON。ラベル列の 1 行は 44px のタップ領域。
    const netAssetsRow = page.locator(
      `${ui('timeline.row.label')}[data-row-key="identity:netAssets"]`,
    );
    const netAssetsCheck = page.locator(
      `${ui('timeline.row.check')}[data-row-key="identity:netAssets"]`,
    );
    await expect(netAssetsCheck).toBeChecked();
    const rowBox = await netAssetsRow.boundingBox();
    expect(rowBox?.height ?? 0, `共通ラベル列のタップ領域 ${vp.name}`).toBeGreaterThanOrEqual(44);
    // フローの行はグラフでは選べない（描き方が決まるまで）。
    await expect(
      page.locator(`${ui('timeline.row.check')}[data-row-key="box:expense"]`),
    ).toBeDisabled();
    await page.screenshot({
      path: `test-results/screenshots/ledger-timeline-chart-${vp.name}.png`,
      fullPage: true,
    });
    // チェックを外すと線が消える（描画の正本がチェックであることを実ブラウザでも見る）。
    await netAssetsCheck.click();
    await expect(netAssetsCheck).not.toBeChecked();
    await expect(
      page.locator(`${ui('timeline.chart.line')}[data-row-key="identity:netAssets"]`),
    ).toHaveCount(0);
    await netAssetsCheck.click();

    // 線分レンズへ戻す（以降のシナリオは既定のレンズで進める）。
    await page.locator(ui('timeline.lens.segment')).click();
    await expect(page.locator(ui('timeline.viewport'))).toBeVisible();

    // 毎月のもの → くり返し記帳シート: flat 2 列でもシート内に横スクロールが出ない（実ユーズ②）。
    await page.locator(ui('nav.menu.button')).click();
    await page.locator(ui('nav.allocations')).click();
    await expect(page.locator(ui('allocations.view'))).toBeVisible();
    await page.locator(ui('allocations.add')).click();
    await page.locator(ui('allocations.add.chooser.rule')).click();
    await expect(page.locator(ui('allocations.recurring.sheet'))).toBeVisible();
    const sheetOverflow = await page
      .locator(ui('allocations.recurring.sheet'))
      .evaluate((el) => el.scrollWidth - el.clientWidth);
    expect(sheetOverflow, `くり返し記帳シート横スクロール ${vp.name}`).toBeLessThanOrEqual(1);
    await page.keyboard.press('Escape');
    await expect(page.locator(ui('allocations.recurring.sheet'))).toBeHidden();

    // 設定
    await page.locator(ui('nav.menu.button')).click();
    await page.locator(ui('nav.settings')).click();
    await expect(page.locator(ui('settings.view'))).toBeVisible();
    await expectNoHorizontalScroll(page, `settings ${vp.name}`);
    await page.screenshot({
      path: `test-results/screenshots/ledger-settings-${vp.name}.png`,
      fullPage: true,
    });
  });
}

test('タイムラインは 390px でページを横にはみ出さず、表示領域内だけを横スクロールできる', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.addInitScript(() => localStorage.setItem('slv2.onboardingDone', '1'));
  await page.goto('./?fixture=sample');
  await expect(page.locator(ui('dashboard.view'))).toBeVisible({ timeout: 15_000 });

  await page.locator(ui('nav.menu.button')).click();
  await page.locator(ui('nav.timeline')).click();
  await expect(page.locator(ui('timeline.view'))).toBeVisible();

  const viewport = page.locator(ui('timeline.viewport'));
  await expect(viewport).toBeVisible();
  await expectNoHorizontalScroll(page, 'timeline mobile-390x844');
  const viewportScrolls = await viewport.evaluate((element) => {
    return element.scrollWidth > element.clientWidth;
  });
  expect(viewportScrolls, 'mobile: タイムラインの表示領域内で横スクロールできる').toBe(true);
  await page.screenshot({
    path: 'test-results/screenshots/ledger-timeline-mobile-390x844.png',
    fullPage: true,
  });
});

test('資金繰りのグラフは 390px でページを横にはみ出さず、表示領域内だけを横スクロールできる', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.addInitScript(() => localStorage.setItem('slv2.onboardingDone', '1'));
  await page.goto('./?fixture=sample');
  await expect(page.locator(ui('dashboard.view'))).toBeVisible({ timeout: 15_000 });

  await page.locator(ui('nav.menu.button')).click();
  await page.locator(ui('nav.cashflow')).click();
  await expect(page.locator(ui('cashflow.view'))).toBeVisible();

  // グラフの幅は「窓の日数 × 1 日あたりの px」なので、必ず実機幅より広くなる。
  // はみ出す先は viewport の中だけ = ページ本体は横スクロールしない。
  const viewport = page.locator(ui('cashflow.chart.viewport'));
  await expect(viewport).toBeVisible();
  await expectNoHorizontalScroll(page, 'cashflow mobile-390x844');
  const widthBefore = await viewport.evaluate((el) => el.scrollWidth);
  expect(widthBefore, 'mobile: グラフの表示領域内で横スクロールできる').toBeGreaterThan(
    await viewport.evaluate((el) => el.clientWidth),
  );

  // 「さらに先へ」で窓が伸びても、はみ出しは viewport の中に留まる。
  await page.locator(ui('cashflow.chart.extend')).click();
  await expect.poll(() => viewport.evaluate((el) => el.scrollWidth)).toBeGreaterThan(widthBefore);
  await expectNoHorizontalScroll(page, 'cashflow extended mobile-390x844');
  await page.screenshot({
    path: 'test-results/screenshots/ledger-cashflow-mobile-390x844.png',
    fullPage: true,
  });
});

/**
 * 当日の支出を n 件登録する（ホームを実際にスクロールさせるため）。
 * 保存トーストは画面下端の記帳バーに重なり次のクリックを遮るので、都度タップして閉じる。
 */
async function seedTodayExpenses(page: Page, n: number) {
  const toast = page.locator(`${ui('toast')} .toast`);
  for (let i = 0; i < n; i++) {
    if (await toast.first().isVisible()) {
      await toast.first().click();
      await expect(toast).toHaveCount(0);
    }
    await page.locator(ui('dashboard.entry.expense')).click();
    await page.locator(ui('journal.entry.item')).fill(`スクロール確認${i}`);
    await page.locator(ui('journal.entry.amount')).fill(String(1000 + i));
    await page
      .locator(`${ui('journal.entry.flow.source')} label.chip`)
      .first()
      .click();
    await page
      .locator(`${ui('journal.entry.flow.destination')} label.chip`)
      .first()
      .click();
    await page.locator(ui('journal.entry.save')).click();
    await expect(page.locator(ui('journal.entry.save'))).toBeHidden();
  }
}

test('ホームの額縁は 6 枠を sticky 固定し、仕訳だけがスクロールする (375x667)', async ({
  page,
}) => {
  // 実機相当の狭い画面。ここで固定部が仕訳を潰さないことまで見る。
  await page.setViewportSize({ width: 375, height: 667 });
  await page.addInitScript(() => localStorage.setItem('slv2.onboardingDone', '1'));
  await page.goto('./?fixture=sample');
  await expect(page.locator(ui('dashboard.view'))).toBeVisible({ timeout: 15_000 });

  await seedTodayExpenses(page, 10);

  const frame = page.locator(ui('dashboard.frame'));
  const STATS = [
    'dashboard.stat.revenue',
    'dashboard.stat.expense',
    'dashboard.stat.netIncome',
    'dashboard.stat.assets',
    'dashboard.stat.liabilities',
    'dashboard.stat.netAssets',
  ] as const;

  // スクロール前は「自然位置」（sticky はしきい値に達するまで貼り付かない）。
  // app-main の padding ぶんヘッダーより下にあるので 57px ちょうどではなく、57px 以上。
  const topBefore = await frame.evaluate((el) => Math.round(el.getBoundingClientRect().top));
  expect(topBefore, 'スクロール前の額縁上端はヘッダー下').toBeGreaterThanOrEqual(57);

  // **実際にスクロールしたことを必ず確認する**（ここを省くと以降の assert が偽緑になる）。
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  const scrollY = await page.evaluate(() => window.scrollY);
  expect(
    scrollY,
    '仕訳を 10 件入れてもホームがスクロールしない = 検証が成立しない',
  ).toBeGreaterThan(0);

  // スクロール後は 57px（= ヘッダー実高）へ貼り付き、6 枠すべてが見えている。
  const topAfter = await frame.evaluate((el) => Math.round(el.getBoundingClientRect().top));
  expect(topAfter, 'スクロール後の額縁上端 = ヘッダー実高に貼り付く').toBe(57);
  expect(topAfter, '自然位置から貼り付き位置へ動いた（= sticky が効いた）').toBeLessThan(topBefore);
  for (const stat of STATS) {
    await expect(page.locator(ui(stat)), `${stat} がスクロール後も見えている`).toBeInViewport();
  }
  // 「すべて見る」も額縁に含まれて固定される（作者決定 2026-08-14）。
  await expect(
    page.locator(ui('dashboard.journal.openAll')),
    'すべて見るがスクロール後も見えている',
  ).toBeInViewport();

  // 仕訳の方は流れている（先頭行が額縁の下へ隠れる）。
  const firstRowTop = await page
    .locator(`${ui('dashboard.journal.preview')} button.list__item`)
    .first()
    .evaluate((el) => el.getBoundingClientRect().top);
  expect(firstRowTop, '仕訳の先頭行はスクロールで上へ流れる').toBeLessThan(57);

  await page.screenshot({
    path: 'test-results/screenshots/ledger-dashboard-sticky-375x667.png',
  });
});

test('仕訳一覧と毎月のものは検索・並び替えを sticky 固定し、カードだけが流れる (375x667)', async ({
  page,
}) => {
  // ホームの額縁と同型（作者合意 2026-08-15）。実機相当の狭い画面で、固定部が一覧を潰さず、
  // カードだけが額縁の下を流れることまで見る。
  await page.setViewportSize({ width: 375, height: 667 });
  await page.addInitScript(() => localStorage.setItem('slv2.onboardingDone', '1'));
  await page.goto('./?fixture=sample');
  await expect(page.locator(ui('dashboard.view'))).toBeVisible({ timeout: 15_000 });

  // 下端 furniture（フッター）の対になる上端側。ヘッダーは全画面 sticky top:0 なので
  // スクロールポートの上端は常にヘッダー実高ぶん内側にある。
  const scrollPaddingTop = await page.evaluate(
    () => getComputedStyle(document.documentElement).scrollPaddingTop,
  );
  expect(scrollPaddingTop, ':root の scroll-padding-top がヘッダー実高ぶん入っている').toBe('57px');

  await seedTodayExpenses(page, 10);

  // ── 仕訳一覧 ──
  await page.locator(ui('dashboard.journal.openAll')).click();
  await expect(page.locator(ui('journal.view'))).toBeVisible();

  const journalFrame = page.locator(ui('journal.filterFrame'));
  const jTopBefore = await journalFrame.evaluate((el) =>
    Math.round(el.getBoundingClientRect().top),
  );
  expect(jTopBefore, 'スクロール前の額縁上端はヘッダー下').toBeGreaterThanOrEqual(57);

  // **実際にスクロールしたことを必ず確認する**（ここを省くと以降の assert が偽緑になる）。
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  expect(
    await page.evaluate(() => window.scrollY),
    '仕訳一覧がスクロールしない = 検証が成立しない',
  ).toBeGreaterThan(0);

  const jTopAfter = await journalFrame.evaluate((el) => Math.round(el.getBoundingClientRect().top));
  expect(jTopAfter, 'スクロール後の額縁上端 = ヘッダー実高に貼り付く').toBe(57);
  expect(jTopAfter, '自然位置から貼り付き位置へ動いた（= sticky が効いた）').toBeLessThan(
    jTopBefore,
  );

  // 検索欄はスクロール後も画面内（座標で見る。sticky は覆われないので上端 = 額縁の中）。
  const searchBox = (await page.locator(ui('journal.search')).boundingBox())!;
  expect(searchBox.y, '検索欄がヘッダーの裏に入っている').toBeGreaterThanOrEqual(57);
  expect(searchBox.y + searchBox.height, '検索欄が画面外へ出ている').toBeLessThanOrEqual(667);
  // 並び替えも一緒に残り、44px のタップ領域を保つ。
  for (const name of ['journal.sort.date', 'journal.sort.desc']) {
    const box = (await page.locator(ui(name)).boundingBox())!;
    expect(box.y, `${name} が画面外`).toBeGreaterThanOrEqual(57);
    expect(box.height, `${name} のタップ領域が 44px 未満`).toBeGreaterThanOrEqual(44);
  }

  // 仕訳カードの方は流れている（先頭行が額縁の下へ隠れる）。
  const jFirstRowTop = await page
    .locator(`${ui('journal.entry.list')} li.list__item`)
    .first()
    .evaluate((el) => el.getBoundingClientRect().top);
  expect(jFirstRowTop, '仕訳の先頭行はスクロールで上へ流れる').toBeLessThan(57);

  // **Shift+Tab のフォーカスが額縁の裏へ潜らない**（scroll-padding-top と、額縁ぶんを足す
  // scroll-margin-top の対）。フッターの下端版と同じ理由で、座標で見ないと検出できない。
  for (let i = 0; i < 20; i++) {
    await page.keyboard.press('Shift+Tab');
    const hidden = await page.evaluate(() => {
      const el = document.activeElement as HTMLElement | null;
      const frame = document.querySelector('.list-filter-frame');
      if (!el || !frame || el === document.body) return null;
      // 額縁自身の中・ヘッダー・フッターは固定側なので対象外。
      if (el.closest('.list-filter-frame, .app-header, .app-footer')) return null;
      // 額縁より前（h1 など）は裏に入りようがない。
      if (!(frame.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING)) return null;
      const r = el.getBoundingClientRect();
      if (r.width === 0 && r.height === 0) return null;
      const bottom = frame.getBoundingClientRect().bottom;
      return r.top < bottom ? `${el.getAttribute('data-ui') ?? el.tagName} top=${r.top}` : null;
    });
    expect(hidden, `Shift+Tab ${i + 1} 回目のフォーカス要素が額縁の裏に潜っている`).toBeNull();
  }

  await page.screenshot({ path: 'test-results/screenshots/ledger-journal-sticky-375x667.png' });

  // ── 毎月のもの ──
  await page.locator(ui('nav.menu.button')).click();
  await page.locator(ui('nav.allocations')).click();
  await expect(page.locator(ui('allocations.view'))).toBeVisible();

  const allocFrame = page.locator(ui('allocations.filterFrame'));
  const aTopBefore = await allocFrame.evaluate((el) => Math.round(el.getBoundingClientRect().top));
  expect(aTopBefore, 'スクロール前の額縁上端はヘッダー下').toBeGreaterThanOrEqual(57);

  const aCardTopBefore = await page
    .locator(ui('allocations.item'))
    .first()
    .evaluate((el) => el.getBoundingClientRect().top);

  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  expect(
    await page.evaluate(() => window.scrollY),
    '毎月のものがスクロールしない = 検証が成立しない',
  ).toBeGreaterThan(0);

  const aTopAfter = await allocFrame.evaluate((el) => Math.round(el.getBoundingClientRect().top));
  expect(aTopAfter, 'スクロール後の額縁上端 = ヘッダー実高に貼り付く').toBe(57);
  expect(aTopAfter, '自然位置から貼り付き位置へ動いた（= sticky が効いた）').toBeLessThan(
    aTopBefore,
  );

  const aSearchBox = (await page.locator(ui('allocations.search')).boundingBox())!;
  expect(aSearchBox.y, '検索欄がヘッダーの裏に入っている').toBeGreaterThanOrEqual(57);
  expect(aSearchBox.y + aSearchBox.height, '検索欄が画面外へ出ている').toBeLessThanOrEqual(667);
  for (const name of ['allocations.sort.date', 'allocations.sort.desc']) {
    const box = (await page.locator(ui(name)).boundingBox())!;
    expect(box.y, `${name} が画面外`).toBeGreaterThanOrEqual(57);
    expect(box.height, `${name} のタップ領域が 44px 未満`).toBeGreaterThanOrEqual(44);
  }

  // item カードは額縁の下を流れる（額縁が動かないぶん、カードだけが上がる）。
  const aCardTopAfter = await page
    .locator(ui('allocations.item'))
    .first()
    .evaluate((el) => el.getBoundingClientRect().top);
  expect(aCardTopAfter, 'item カードはスクロールで上へ流れる').toBeLessThan(aCardTopBefore);

  await page.screenshot({ path: 'test-results/screenshots/ledger-allocations-sticky-375x667.png' });
});

test('一番上へ移動ボタンは実ブラウザで出現し、押すと先頭へ戻る (375x667)', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 667 });
  await page.addInitScript(() => localStorage.setItem('slv2.onboardingDone', '1'));
  await page.goto('./?fixture=sample');
  await expect(page.locator(ui('dashboard.view'))).toBeVisible({ timeout: 15_000 });

  // 縦に長い画面（勘定科目）へ移動する。
  await page.locator(ui('nav.menu.button')).click();
  await page.locator(ui('nav.accounts')).click();
  await expect(page.locator(ui('accounts.view'))).toBeVisible();

  const button = page.getByRole('button', { name: '一番上へ移動' });
  await expect(button, 'しきい値以下では存在しない').toHaveCount(0);

  await page.evaluate(() => window.scrollTo(0, 401));
  expect(await page.evaluate(() => window.scrollY), '401px スクロールできる高さがある').toBe(401);
  await expect(button, '401px 超で出現する').toBeVisible();

  // hover しても面がページ背景へ落ちない（iOS は hover をタップ後も保持する）。
  const surface = await page.evaluate(() =>
    getComputedStyle(document.documentElement).getPropertyValue('--surface').trim(),
  );
  await button.hover();
  const hovered = await button.evaluate((el) => getComputedStyle(el).backgroundColor);
  const surfaceRgb = await page.evaluate((c) => {
    const probe = document.createElement('span');
    probe.style.color = c;
    document.body.appendChild(probe);
    const v = getComputedStyle(probe).color;
    probe.remove();
    return v;
  }, surface);
  expect(hovered, 'hover 時も --surface のまま').toBe(surfaceRgb);

  await button.click();
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(0);

  // 画面を切り替えたらスクロール位置は先頭へ戻る（③④の共通前提）。
  await page.evaluate(() => window.scrollTo(0, 401));
  await page.locator(ui('nav.menu.button')).click();
  await page.locator(ui('nav.cashflow')).click();
  await expect(page.locator(ui('cashflow.view'))).toBeVisible();
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(0);
});

test('フッターナビは全画面に常設され、下端のコンテンツを隠さない (375x667)', async ({ page }) => {
  // 実機相当の狭い画面。フッター（fixed）は本文の上に重なるため、
  // **toBeInViewport では検証にならない**（隠れた要素も viewport 内と判定される）。
  // 実座標でフッター上端より上にあることを見る。
  await page.setViewportSize({ width: 375, height: 667 });
  await page.addInitScript(() => localStorage.setItem('slv2.onboardingDone', '1'));
  await page.goto('./?fixture=sample');
  await expect(page.locator(ui('dashboard.view'))).toBeVisible({ timeout: 15_000 });

  const footer = page.locator(ui('nav.footer'));
  await expect(footer).toBeVisible();
  const footerBox = (await footer.boundingBox())!;
  // 画面下端にぴったり接している（safe-area は padding 側で吸収）。
  expect(Math.round(footerBox.y + footerBox.height), 'フッターは画面下端に接する').toBe(667);

  // 3 ボタンとも 44px のタップ領域を保つ。
  for (const name of ['nav.footer.back', 'nav.footer.home', 'nav.menu.button']) {
    const box = (await page.locator(ui(name)).boundingBox())!;
    expect(box.height, `${name} のタップ領域が 44px 未満`).toBeGreaterThanOrEqual(44);
  }

  // ホーム: 記帳バーはフッターの上に積まれ、重ならない。
  const entryBarBox = (await page.locator(ui('dashboard.entryBar')).boundingBox())!;
  expect(
    entryBarBox.y + entryBarBox.height,
    '記帳バーの下端がフッター上端と一致（重なりも隙間も無い）',
  ).toBeCloseTo(footerBox.y, 1);

  // 設定画面: 最下端の破壊的ボタンがフッターに隠れないこと（一番シビアな面）。
  // 設定はメニュー内が唯一の入口（ヘッダー右のボタンは撤去済み）。
  await page.locator(ui('nav.menu.button')).click();
  await page.locator(ui('nav.settings')).click();
  await expect(page.locator(ui('settings.view'))).toBeVisible();
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  const resetBox = (await page.locator(ui('settings.resetAll')).boundingBox())!;
  const footerTopAfter = (await footer.boundingBox())!.y;
  expect(
    resetBox.y + resetBox.height,
    '「すべてのデータを削除」の下端がフッターに潜っている',
  ).toBeLessThanOrEqual(footerTopAfter);

  // フッターは画面が変わっても出続ける（常設ナビ）。
  await expect(footer).toBeVisible();

  // **Tab のフォーカスがフッターの下へ潜らない**（scroll-padding-bottom が効いている）。
  // 下端 furniture を足すとブラウザは「要素の下端をビューポート下端へ」寄せるため、
  // 補正が無いとフォーカス中の要素が完全に隠れる。座標で見ないと検出できない。
  await page.evaluate(() => window.scrollTo(0, 0));
  const footerTop = (await footer.boundingBox())!.y;
  for (let i = 0; i < 30; i++) {
    await page.keyboard.press('Tab');
    const hidden = await page.evaluate((top) => {
      const el = document.activeElement as HTMLElement | null;
      if (!el || el === document.body || el.closest('.app-footer')) return null;
      const r = el.getBoundingClientRect();
      if (r.width === 0 && r.height === 0) return null;
      return r.top >= top ? `${el.getAttribute('aria-label') ?? el.tagName} top=${r.top}` : null;
    }, footerTop);
    expect(hidden, `Tab ${i + 1} 回目のフォーカス要素がフッターの下に潜っている`).toBeNull();
  }

  // 実ブラウザで「見えるボタンで戻れる」ことまで見る（unit 側は history.back を spy で潰すため）。
  await page.locator(ui('nav.footer.back')).click();
  await expect(page.locator(ui('dashboard.view'))).toBeVisible();

  await page.screenshot({ path: 'test-results/screenshots/ledger-footer-nav-375x667.png' });
});

test('ヘッダーの日/月/年と「今日」は 375px でも 44px のタップ領域を保つ (v13.6 H2-1)', async ({
  page,
}) => {
  // 実機で一番狭い側。ここで 44px を割らないなら、どの幅でも割らない。
  await page.setViewportSize({ width: 375, height: 667 });
  await page.addInitScript(() => localStorage.setItem('slv2.onboardingDone', '1'));
  await page.goto('./?fixture=sample');
  await expect(page.locator(ui('dashboard.view'))).toBeVisible({ timeout: 15_000 });

  const zoomButtons = ['period.zoom.day', 'period.zoom.month', 'period.zoom.year'];
  for (const name of zoomButtons) {
    const box = (await page.locator(ui(name)).boundingBox())!;
    expect(box.height, `${name} の高さが 44px 未満`).toBeGreaterThanOrEqual(44);
    expect(box.width, `${name} の幅が 44px 未満`).toBeGreaterThanOrEqual(44);
  }

  // タイムスリップさせて「今日」を出す（普段は出ない = 別途測るしかない）。
  // React は value プロパティを差し替えるので、素の setter を通さないと onChange が起きない。
  await page.locator(ui('period.date.input')).evaluate((el) => {
    const input = el as HTMLInputElement;
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
    setter?.call(input, '2020-01-15');
    input.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await expect(page.locator(ui('period.today'))).toBeVisible();
  const todayBox = (await page.locator(ui('period.today')).boundingBox())!;
  expect(todayBox.height, '「今日」の高さが 44px 未満').toBeGreaterThanOrEqual(44);
  expect(todayBox.width, '「今日」の幅が 44px 未満').toBeGreaterThanOrEqual(44);

  // 44px にしてもヘッダーの実高（--sticky-top = 57px）は変わらない（sticky の相手が動かない）。
  const headerBox = (await page.locator('.app-header').boundingBox())!;
  expect(Math.round(headerBox.height), 'ヘッダーの実高が 57px から動いた').toBe(57);

  // 1 行に収まり、ページ本体は横へはみ出さない。
  await expectNoHorizontalScroll(page, 'header zoom 375x667');

  // レンズセレクタ（タイムライン）も同じ規約を満たす。
  await page.locator(ui('nav.menu.button')).click();
  await page.locator(ui('nav.timeline')).click();
  await expect(page.locator(ui('timeline.view'))).toBeVisible();
  for (const name of ['timeline.lens.segment', 'timeline.lens.matrix', 'timeline.lens.chart']) {
    const box = (await page.locator(ui(name)).boundingBox())!;
    expect(box.height, `${name} のタップ領域が 44px 未満`).toBeGreaterThanOrEqual(44);
  }

  await page.screenshot({ path: 'test-results/screenshots/ledger-header-zoom-375x667.png' });
});

/**
 * 連続スクロール（v13.6 H2-3）。jsdom は clientWidth / scrollWidth を 0 にするため
 * **端に近づいたら伸びる**ことは実ブラウザでしか見られない（unit 側は配線だけを見る）。
 * 3 レンズとも同じ機構なので、線分レンズで幾何まで測り、数値レンズで「同じ機構が効く」を見る。
 */

/**
 * 枠を `scrollLeft` へ動かし、窓が伸びるまで待って**伸びた量と scrollLeft の増分**を返す。
 * 左へ伸びたときは両者が一致する = 見えている中身が動いていない、の機械的な言い方。
 */
async function scrollAndAwaitExtend(
  locator: ReturnType<Page['locator']>,
  scrollLeft: number | 'end',
): Promise<{ grew: number; shifted: number } | null> {
  return locator.evaluate(
    (el, target) =>
      new Promise<{ grew: number; shifted: number } | null>((resolve) => {
        el.scrollLeft = target === 'end' ? el.scrollWidth : target;
        // 代入直後の実測を起点にする（クランプ後の値を読む）。
        const width0 = el.scrollWidth;
        const left0 = el.scrollLeft;
        const deadline = performance.now() + 3000;
        const tick = () => {
          if (el.scrollWidth > width0) {
            resolve({ grew: el.scrollWidth - width0, shifted: el.scrollLeft - left0 });
            return;
          }
          if (performance.now() > deadline) {
            resolve(null);
            return;
          }
          requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
      }),
    scrollLeft,
  );
}

test('タイムラインは端に近づくと窓が自動で伸び、左へ伸びても見えているものが動かない (375x667)', async ({
  page,
}) => {
  await page.setViewportSize({ width: 375, height: 667 });
  await page.addInitScript(() => localStorage.setItem('slv2.onboardingDone', '1'));
  await page.goto('./?fixture=sample');
  await expect(page.locator(ui('dashboard.view'))).toBeVisible({ timeout: 15_000 });

  await page.locator(ui('nav.menu.button')).click();
  await page.locator(ui('nav.timeline')).click();
  await expect(page.locator(ui('timeline.view'))).toBeVisible();

  const viewport = page.locator(ui('timeline.viewport'));
  await expect(viewport).toBeVisible();

  // ── 右端へ寄せると未来側が伸びる（「次へ」を押さなくても先が生える）。
  const grownRight = await scrollAndAwaitExtend(viewport, 'end');
  expect(grownRight, '右端に触れても窓が伸びない').not.toBeNull();
  // 未来側の継ぎ足しは左端を動かさないので、scrollLeft は据え置き = 見ていた位置のまま。
  expect(grownRight!.shifted, '未来側へ伸ばしたのに表示が飛んだ').toBe(0);

  // ── 左は「データのある最初の年」で止まる。sample の窓は開いた時点でそこへ届いているので、
  //    左の継ぎ足しを見るには窓を未来へ送っておく（= 下限より後ろから始まる窓にする）。
  await page.locator(ui('timeline.range.next')).click();
  await page.locator(ui('timeline.range.next')).click();

  // しきい値の外（端から十分遠い位置）では伸びない。
  const staysPut = await viewport.evaluate(async (el) => {
    el.scrollLeft = Math.round((el.scrollWidth - el.clientWidth) / 2);
    const width = el.scrollWidth;
    await new Promise((r) => setTimeout(r, 400));
    return el.scrollWidth === width;
  });
  expect(staysPut, '端から遠いのに窓が伸びた（開いた直後から育ち続ける）').toBe(true);

  // 左端へ寄せると過去側が伸び、**伸びたぶんだけ scrollLeft が足される**（見た目が動かない）。
  const grownLeft = await scrollAndAwaitExtend(viewport, 0);
  expect(grownLeft, '左端に触れても窓が伸びない').not.toBeNull();
  expect(grownLeft!.grew, '過去側の継ぎ足しが 0').toBeGreaterThan(0);
  expect(grownLeft!.shifted, '左へ伸ばしたぶんの scrollLeft 補正が一致しない').toBe(
    grownLeft!.grew,
  );

  await expectNoHorizontalScroll(page, 'timeline continuous scroll 375x667');

  // ── 数値レンズでも同じ機構が効く（レンズごとの独自実装ではない）。
  await page.locator(ui('timeline.lens.matrix')).click();
  const matrix = page.locator(ui('timeline.matrix'));
  await expect(matrix).toBeVisible();
  const grownMatrix = await scrollAndAwaitExtend(matrix, 'end');
  expect(grownMatrix, '数値レンズが端で伸びない').not.toBeNull();
  await expectNoHorizontalScroll(page, 'timeline matrix continuous scroll 375x667');

  // ── グラフレンズも同じ（3 レンズ共通の viewport 機構）。
  await page.locator(ui('timeline.lens.chart')).click();
  const chart = page.locator(ui('timeline.chart.viewport'));
  await expect(chart).toBeVisible();
  const grownChart = await scrollAndAwaitExtend(chart, 'end');
  expect(grownChart, 'グラフレンズが端で伸びない').not.toBeNull();
  await expectNoHorizontalScroll(page, 'timeline chart continuous scroll 375x667');

  await page.screenshot({
    path: 'test-results/screenshots/ledger-timeline-continuous-375x667.png',
  });
});

/**
 * v13.6 H3: **レンズは右ペインの描画を交換するだけ**。左のラベル列（行・順序・名前・
 * チェック状態・開閉）は 3 レンズで同じ 1 つのものを共有する。
 * jsdom では「同じに見える」を測れないので、実ブラウザの実幅（375px）で突き合わせる。
 */
test('375px で 3 レンズのラベル列が同一（行・順序・名前・幅・チェック状態）', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 667 });
  await page.addInitScript(() => localStorage.setItem('slv2.onboardingDone', '1'));
  await page.goto('./?fixture=sample');
  await expect(page.locator(ui('dashboard.view'))).toBeVisible({ timeout: 15_000 });

  await page.locator(ui('nav.menu.button')).click();
  await page.locator(ui('nav.timeline')).click();
  await expect(page.locator(ui('timeline.view'))).toBeVisible();

  /**
   * ラベル列のスナップショット（行 id・見えている名前・チェック・列幅）。
   * 読み上げ専用の補足（グラフでフロー行が選べない理由）はレンズ固有でよいので、
   * 見えている文字（.lens-row__text）だけを比べる。
   */
  const labelColumn = () =>
    page.locator(ui('timeline.row.label')).evaluateAll((rows) =>
      rows.map((row) => ({
        key: row.getAttribute('data-row-key'),
        text: (row.querySelector('.lens-row__text')?.textContent ?? '').trim(),
        checked: row.querySelector<HTMLInputElement>('input[type="checkbox"]')?.checked ?? null,
        width: Math.round(row.getBoundingClientRect().width),
      })),
    );

  const segment = await labelColumn();
  expect(segment.length, 'ラベル列の行が 1 つも無い').toBeGreaterThan(0);
  // 幅は 1 つの正本（--lens-label-width）。行ごとに違えば列が揃わない。
  expect(new Set(segment.map((row) => row.width)).size, 'ラベル列の幅が行ごとに違う').toBe(1);

  // 箱を 1 つ開き、チェックを 1 つ外した状態で比べる（既定値だけの一致にしない）。
  await page.locator(`${ui('timeline.row.toggle')}[data-row-key="box:assetFree"]`).click();
  await page.locator(`${ui('timeline.row.check')}[data-row-key="box:income"]`).click();
  const opened = await labelColumn();
  expect(opened.length, '箱を開いても行が増えていない').toBeGreaterThan(segment.length);
  expect(opened.find((row) => row.key === 'box:income')?.checked).toBe(false);

  for (const lens of ['timeline.lens.matrix', 'timeline.lens.chart']) {
    await page.locator(ui(lens)).click();
    await expect(page.locator(ui('timeline.row.label')).first()).toBeVisible();
    // グラフはフロー行のチェックを disabled にするだけで、行と状態そのものは同じ。
    expect(await labelColumn(), `${lens} のラベル列が線分レンズと違う`).toEqual(opened);
    await expectNoHorizontalScroll(page, `lens label column ${lens} 375x667`);
  }

  await page.screenshot({
    path: 'test-results/screenshots/ledger-timeline-lens-labels-375x667.png',
    fullPage: true,
  });
});

/** レンズごとの枠（縦横 2 次元の窓）の data-ui。 */
const LENS_FRAMES = [
  { lens: 'timeline.lens.segment', frame: 'timeline.viewport' },
  { lens: 'timeline.lens.matrix', frame: 'timeline.matrix' },
  { lens: 'timeline.lens.chart', frame: 'timeline.chart.viewport' },
] as const;

/**
 * v13.7 I1: **枠も 3 レンズ共通**。ラベル列は左・目盛り行は上・左上の隅は両方に貼りつき、
 * 描画部だけが縦横に流れる。jsdom は sticky を評価しないので実ブラウザで測るしかない。
 * かつて数値レンズだけ器の sticky が共通化から漏れていたので、パリティとして固定する。
 */
test('3 レンズとも ラベル列・目盛り行・左上の隅が枠に貼りつく (375x667)', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 667 });
  await page.addInitScript(() => localStorage.setItem('slv2.onboardingDone', '1'));
  await page.goto('./?fixture=sample');
  await expect(page.locator(ui('dashboard.view'))).toBeVisible({ timeout: 15_000 });

  await page.locator(ui('nav.menu.button')).click();
  await page.locator(ui('nav.timeline')).click();
  await expect(page.locator(ui('timeline.view'))).toBeVisible();

  // 縦に送れる高さを作る（箱をすべて開いて行を増やす）。3 レンズで行は共通なので 1 回でよい。
  for (const toggle of await page.locator(ui('timeline.row.toggle')).all()) {
    await toggle.click();
  }

  for (const { lens, frame } of LENS_FRAMES) {
    await page.locator(ui(lens)).click();
    const viewport = page.locator(ui(frame));
    await expect(viewport).toBeVisible();

    const measured = await viewport.evaluate((el) => {
      const box = (node: Element | null) => {
        if (!node) return null;
        const rect = node.getBoundingClientRect();
        return { top: Math.round(rect.top), left: Math.round(rect.left) };
      };
      // 隅は目盛り行を兼ねることがある（数値レンズの「項目」セル）。目盛り行そのものの
      // 貼りつきを見たいので、隅ではない方を選ぶ。
      const head = el.querySelector('.lens-frame__head:not(.lens-frame__corner)');
      const corner = el.querySelector('.lens-frame__corner');
      const label = el.querySelector('[data-ui="timeline.row.label"]');
      const pane = el.querySelector('.lens-frame__pane');
      el.scrollTop = 0;
      el.scrollLeft = 0;
      const before = { head: box(head), corner: box(corner), label: box(label), pane: box(pane) };
      el.scrollTop = 200;
      el.scrollLeft = 300;
      return {
        scrollable: { y: el.scrollHeight - el.clientHeight, x: el.scrollWidth - el.clientWidth },
        moved: { y: el.scrollTop, x: el.scrollLeft },
        before,
        after: { head: box(head), corner: box(corner), label: box(label), pane: box(pane) },
      };
    });

    // 前提: 枠の中で縦にも横にも送れている（送れていなければ貼りつきを測ったことにならない）。
    expect(measured.scrollable.y, `${lens}: 枠が縦に送れない`).toBeGreaterThan(0);
    expect(measured.moved.y, `${lens}: 縦に動いていない`).toBeGreaterThan(0);
    expect(measured.moved.x, `${lens}: 横に動いていない`).toBeGreaterThan(0);

    // 目盛り行は上に貼る（縦に送っても消えない）が、横には一緒に流れる。
    expect(measured.after.head!.top, `${lens}: 目盛り行が上に貼りついていない`).toBe(
      measured.before.head!.top,
    );
    expect(measured.after.head!.left, `${lens}: 目盛り行が横に流れていない`).toBeLessThan(
      measured.before.head!.left,
    );
    // ラベル列は左に貼る（横に送っても消えない）が、縦には一緒に流れる。
    expect(measured.after.label!.left, `${lens}: ラベル列が左に貼りついていない`).toBe(
      measured.before.label!.left,
    );
    expect(measured.after.label!.top, `${lens}: ラベル列が縦に流れていない`).toBeLessThan(
      measured.before.label!.top,
    );
    // 左上の隅はどちらへ送っても動かない唯一の点。
    expect(measured.after.corner, `${lens}: 左上の隅が動いた`).toEqual(measured.before.corner);
    // 描画部は横に流れる（貼りついていたら中身が見えない）。
    expect(measured.after.pane!.left, `${lens}: 描画部が横に流れていない`).toBeLessThan(
      measured.before.pane!.left,
    );

    // 軸ロック: 指で触れた場所が軸を決める（描画部 = 横だけ / ラベル列 = 縦だけ）。
    const touch = await viewport.evaluate((el) => ({
      pane: getComputedStyle(el.querySelector('.lens-frame__pane')!).touchAction,
      label: getComputedStyle(el.querySelector('[data-ui="timeline.row.label"]')!).touchAction,
    }));
    expect(touch.pane, `${lens}: 描画部の軸ロックが無い`).toBe('pan-x');
    expect(touch.label, `${lens}: ラベル列の軸ロックが無い`).toBe('pan-y');

    await expectNoHorizontalScroll(page, `lens frame ${lens} 375x667`);
  }

  await page.screenshot({
    path: 'test-results/screenshots/ledger-timeline-lens-frame-375x667.png',
  });
});

/**
 * v13.7 I2: 窓を送って基準日を見失ったときだけ現れる「{基準日} へ戻る」。
 * 押すと**見ている位置だけ**が基準日へ戻り、ヘッダーの断面日付は動かない。
 */
test('基準日が見えなくなったときだけ「戻る」が出て、押しても断面は動かない (375x667)', async ({
  page,
}) => {
  await page.setViewportSize({ width: 375, height: 667 });
  await page.addInitScript(() => localStorage.setItem('slv2.onboardingDone', '1'));
  await page.goto('./?fixture=sample');
  await expect(page.locator(ui('dashboard.view'))).toBeVisible({ timeout: 15_000 });

  const headerDate = await page.locator('.period-context__text').textContent();

  await page.locator(ui('nav.menu.button')).click();
  await page.locator(ui('nav.timeline')).click();
  await expect(page.locator(ui('timeline.view'))).toBeVisible();

  const jump = page.locator(ui('timeline.backToBasis'));
  await expect(jump, '開いた直後は基準日が見えているので出ない').toHaveCount(0);

  // 窓を送って基準日を可視範囲の外へ出す。
  await page.locator(ui('timeline.range.next')).click();
  await page.locator(ui('timeline.range.next')).click();
  await expect(jump).toBeVisible();
  await expect(jump).toHaveText(new RegExp(headerDate!.trim()));
  const box = (await jump.boundingBox())!;
  expect(box.height, '「戻る」のタップ領域が 44px 未満').toBeGreaterThanOrEqual(44);

  await jump.click();
  await expect(jump, '基準日が見える位置へ戻ったのにボタンが残っている').toHaveCount(0);
  // 断面（ヘッダーの日付）は動かさない = ここが「今日」ボタンとの違い。
  expect(await page.locator('.period-context__text').textContent()).toBe(headerDate);

  await expectNoHorizontalScroll(page, 'timeline back-to-basis 375x667');
  await page.screenshot({
    path: 'test-results/screenshots/ledger-timeline-back-to-basis-375x667.png',
  });
});
