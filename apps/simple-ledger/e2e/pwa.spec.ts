/*
 * PWA E2E（凍結 SW ポリシー版）。本番ビルド（preview）に対して:
 *  - manifest が installable な内容で読める
 *  - SW が登録・activate される（凍結ポリシーのため clients.claim は呼ばれない →
 *    初回ロードのページは非制御。リロード後のページから制御される）
 *  - オフラインでも app shell が起動する（cache-first の検証）
 */
import { test, expect, type Page } from '@playwright/test';

const ui = (name: string) => `[data-ui="${name}"]`;

// index.html の env 判定は localhost を 'test' に倒す(本番限定の副作用を誤って有効化しない
// fail-safe)。SW の実挙動を localhost preview で検証するため、e2e では data-env を 'prod' へ
// 強制する(head の判定スクリプトが 'test' を書いた直後に observer が 'prod' へ戻す)。
async function forceProdEnv(page: Page) {
  await page.addInitScript(() => {
    // init script 実行時点では documentElement が未生成 → 生成を待って attribute を監視する
    const attach = (root: HTMLElement) => {
      if (root.dataset.env !== 'prod') root.dataset.env = 'prod';
      new MutationObserver(() => {
        if (root.dataset.env !== 'prod') root.dataset.env = 'prod';
      }).observe(root, { attributes: true, attributeFilter: ['data-env'] });
    };
    if (document.documentElement) {
      attach(document.documentElement);
    } else {
      const boot = new MutationObserver(() => {
        if (!document.documentElement) return;
        boot.disconnect();
        attach(document.documentElement);
      });
      boot.observe(document, { childList: true });
    }
  });
}

async function waitForControlled(page: Page) {
  // 凍結 SW: claim を呼ばないため、activate 済み SW の制御下に入るには再読込が必要。
  await page.goto('./');
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
  });
  await page.reload();
  await page.waitForFunction(() => navigator.serviceWorker.controller !== null, null, {
    timeout: 10_000,
  });
}

test('manifest が installable な内容で読める', async ({ page }) => {
  await page.goto('./');
  const href = await page.locator('link[rel="manifest"]').getAttribute('href');
  expect(href).toBeTruthy();
  const res = await page.request.get(new URL(href!, page.url()).toString());
  expect(res.ok()).toBeTruthy();
  const m = await res.json();
  expect(m.name).toBeTruthy();
  expect(m.start_url).toBeTruthy();
  expect(m.display).toBe('standalone');
  const sizes = (m.icons as { sizes: string }[]).map((i) => i.sizes);
  expect(sizes).toContain('192x192');
  expect(sizes).toContain('512x512');
});

test('SW が登録・activate される（凍結ポリシー: 初回ページは claim されない）', async ({
  page,
}) => {
  await forceProdEnv(page);
  await page.goto('./');
  const scope = await page.evaluate(async () => {
    const reg = await navigator.serviceWorker.ready;
    return reg.active ? reg.scope : null;
  });
  expect(scope).toBeTruthy();
  // 凍結 SW は clients.claim() を呼ばない → 初回ロードのこのページは非制御のまま
  const firstLoadControlled = await page.evaluate(() => navigator.serviceWorker.controller !== null);
  expect(firstLoadControlled).toBe(false);
  // 再読込後のページは制御下に入る
  await page.reload();
  await page.waitForFunction(() => navigator.serviceWorker.controller !== null, null, {
    timeout: 10_000,
  });
});

test('SW activate が他アプリの cache を削除しない (M1: prefix 限定削除)', async ({ page }) => {
  // 検証方針: SW activate の前に外部キャッシュを seed し、activate 完了後も生存することを確認する。
  // 凍結 SW は skipWaiting/claim を呼ばないため activate 済みの SW を再発火させることはできない。
  // そこで「SW が activate される前に seed → ready を待って生存確認」という手順を取る。
  // addInitScript で SW register より前に foreign cache を作成し、ready 後に has() で確認する。
  await page.addInitScript(() => {
    // SW が登録される前に外部キャッシュを作成する。
    // activate ハンドラが実行される前にこのキャッシュが存在することを保証するため
    // init script(ページスクリプト実行前)で開いておく。
    void caches.open('foreign-app-cache-test');
  });
  await forceProdEnv(page);
  await page.goto('./');
  const survived = await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
    // activate が完了した後でも外部キャッシュが残っているかを確認する。
    return caches.has('foreign-app-cache-test');
  });
  expect(survived).toBe(true);
});

test('data-env が prod 以外のとき SW は登録されない (M2: 明示 prod のみ登録)', async ({
  page,
}) => {
  // forceProdEnv を使わず test 判定のままロード → serviceWorker registration が存在しない
  await page.goto('./');
  const hasRegistration = await page.evaluate(async () => {
    const regs = await navigator.serviceWorker.getRegistrations();
    return regs.length > 0;
  });
  expect(hasRegistration).toBe(false);
});

test('オフラインでも app shell が起動する（凍結 SW の cache-first）', async ({ page, context }) => {
  await forceProdEnv(page);
  await waitForControlled(page);
  await expect(page.locator(ui('dashboard.view'))).toBeVisible();
  // 制御下ロードでランタイムキャッシュ（assets）が埋まるまで待つ
  await page.waitForFunction(
    async () => {
      const keys = await caches.keys();
      for (const k of keys) {
        const reqs = await (await caches.open(k)).keys();
        if (reqs.some((r) => r.url.includes('/assets/'))) return true;
      }
      return false;
    },
    null,
    { timeout: 10_000 },
  );
  await context.setOffline(true);
  try {
    await page.reload();
    await expect(page.locator(ui('dashboard.view'))).toBeVisible({ timeout: 10_000 });
  } finally {
    await context.setOffline(false);
  }
});
