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
