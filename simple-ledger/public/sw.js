/*
 * simple-ledger Service Worker
 * ---------------------------------------------------------------------------
 * 役割: オフライン動作のための「同一オリジン app shell」キャッシュのみ。
 *
 * 憲法（外部送信ゼロ）との整合:
 *  - キャッシュ対象は **同一オリジン (self.location.origin)** かつ scope 配下の GET だけ。
 *  - 外部オリジンのリクエストは一切横取り・キャッシュしない（そもそも外部読込は無い）。
 *  - ユーザーデータ(IndexedDB)は SW の対象外。更新で消えない。
 *
 * 更新方針:
 *  - 新 SW は自動で有効化しない（waiting で待機）。
 *  - ページから {type:'SKIP_WAITING'} を受け取った時だけ有効化＝ユーザー操作で反映。
 */
const VERSION = 'v1';
const CACHE = `simple-ledger-${VERSION}`;
const SCOPE = new URL(self.registration.scope).pathname; // 例: /simple-ledger/

// 最低限の app shell。ハッシュ付きアセットは fetch 時にランタイムキャッシュする。
const PRECACHE = [SCOPE, `${SCOPE}index.html`, `${SCOPE}manifest.json`, `${SCOPE}icons/icon.svg`];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE).then((cache) =>
      // network-ok: 同一オリジン app shell の precache（外部送信なし）
      cache.addAll(PRECACHE).catch(() => undefined),
    ),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(
        keys
          .filter((k) => k.startsWith('simple-ledger-') && k !== CACHE)
          .map((k) => caches.delete(k)),
      );
      await self.clients.claim();
    })(),
  );
});

self.addEventListener('message', (event) => {
  // ユーザー操作（更新を反映ボタン）からのみ skipWaiting する。
  if (event.data && event.data.type === 'SKIP_WAITING') self.skipWaiting();
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  // 同一オリジン & scope 配下のみ扱う。外部は素通し（キャッシュしない）。
  if (url.origin !== self.location.origin) return;
  if (!url.pathname.startsWith(SCOPE)) return;

  event.respondWith(
    (async () => {
      const cache = await caches.open(CACHE);
      const cached = await cache.match(req);
      if (cached) return cached;
      try {
        const res = await fetch(req); // network-ok: 同一オリジン scope 配下のアセット取得のみ（外部送信なし）
        if (res.ok && res.type === 'basic') cache.put(req, res.clone());
        return res;
      } catch {
        // オフラインかつ未キャッシュ: ナビゲーションなら index.html を返す。
        if (req.mode === 'navigate') {
          const shell = await cache.match(`${SCOPE}index.html`);
          if (shell) return shell;
        }
        return new Response('offline', { status: 503, statusText: 'offline' });
      }
    })(),
  );
});
