/*
 * Service Worker: 標準ライフサイクル + 使用中乗っ取り防止 (2026-07-17 テンプレート追従)。
 * navigation は network-first なので、デプロイ済みの更新は次回起動時に反映される。
 *
 * キャッシュ prefix: simple-ledger-v2- (旧世代掃除用の名前空間。src/data/constants.ts の
 *   CACHE_NAME_PREFIX と値を合わせること。sw.js は単体配信ファイルなので import はしない)
 * キャッシュ名: simple-ledger-v2-2 (PREFIX + 世代番号。キャッシュを捨てたい時に版数を上げる。
 *   -1 は凍結ポリシー期の世代。標準ライフサイクル移行で世代を上げ、下の activate が掃除する)
 * 正本テンプレート: packages/foundation/src/pwa/sw.template.js
 */

const CACHE_PREFIX = 'simple-ledger-v2-';
const CACHE = 'simple-ledger-v2-2';

const PRECACHE_PATHS = ['./icons/icon-192.png', './icons/icon-512.png', './icons/icon.svg'];

// SW のスコープ (= sw.js が置かれているディレクトリ)。相対 URL は scope を起点に解決し、
// prod/test どちらの base でも同じファイルが動くようにする (特定ドメインを直書きしない)。
const SCOPE = self.registration
  ? self.registration.scope
  : self.location.href.replace(/[^/]*$/, '');

// app shell。オフライン起動用に precache し、以後は navigation のたびに network-first で更新する。
const SHELL = [new URL('./', SCOPE).href, new URL('./index.html', SCOPE).href];

async function precacheAll() {
  const cache = await caches.open(CACHE);
  // best-effort: 一部の追加アセットが落ちてもインストール自体は成功させる
  // (オフライン初回は shell のみ、次のオンライン訪問で埋まる)。
  await Promise.allSettled(SHELL.map((u) => cache.add(u)));
  await Promise.allSettled(PRECACHE_PATHS.map((p) => cache.add(new URL(p, SCOPE).href)));
}

// 更新ポリシー (2026-07-07 改訂: 凍結 → 標準ライフサイクル)。
//   運用前提を「完全オフライン」から「自サイトへは普通に接続」へ転換した:
//     - navigation (アプリ起動/リロード) は network-first。オンラインならデプロイ済みの
//       更新が次回起動時にそのまま反映され、オフラインならキャッシュ済み shell で起動する。
//     - 配信元の乗っ取り対策はデプロイ側のトークン/アカウント管理が担う。
//       アプリコードにその責務は置かない。
//   ⚠️ 使用中乗っ取りの防止だけは引き続きこのコードの責務。【変更厳禁】
//     - skipWaiting() を呼ばない    → 新しい SW は起動中のページを実行中に乗っ取らない
//     - clients.claim() を呼ばない  → 既存ページの制御を実行中に奪わない
//   = 「使用中にアプリの版が切り替わらない」が守るべき唯一の不変条件。更新が反映される
//     境界は常にユーザー自身の起動/リロード操作にする。
self.addEventListener('install', (e) => {
  e.waitUntil(precacheAll());
});

self.addEventListener('activate', (e) => {
  // 旧世代キャッシュの掃除。CacheStorage は origin 単位。同一 origin に他アプリ/旧版が
  // 同居しても消さない(仕様§7)。削除するのは自アプリ prefix の旧世代のみ。
  e.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((k) => k.startsWith(CACHE_PREFIX) && k !== CACHE)
            .map((k) => caches.delete(k)),
        ),
      ),
  );
});

// navigation = network-first (更新反映 + オフライン fallback)。
// その他の同一オリジン GET (ハッシュ付きアセット等) = cache-first + miss 時補充。
self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET') return;
  // 同一オリジン以外は SW を素通し (外部リソースの取得・キャッシュはしない)。
  if (new URL(e.request.url).origin !== self.location.origin) return;

  // アプリ起動/リロード: まずネットワークから最新 shell を取得してキャッシュを更新し、
  // 失敗時 (オフライン) はキャッシュ済み shell へ fallback する。
  if (e.request.mode === 'navigate' || SHELL.includes(e.request.url)) {
    e.respondWith(
      fetch(e.request) // network-ok: 同一オリジンの app shell 取得のみ(上の origin チェック済み)。ユーザーデータ送信なし
        .then((res) => {
          if (res && res.ok && res.status === 200) {
            const clone = res.clone();
            caches.open(CACHE).then((c) => c.put(e.request, clone));
          }
          return res;
        })
        .catch(() =>
          caches
            .match(e.request)
            .then((cached) => cached || caches.match(new URL('./', SCOPE).href)),
        ),
    );
    return;
  }

  e.respondWith(
    caches.match(e.request).then((cached) => {
      if (cached) return cached;
      return fetch(e.request) // network-ok: 同一オリジンのアセットキャッシュ補充のみ(上の origin チェック済み)。ユーザーデータ送信なし
        .then((res) => {
          if (res && res.ok && res.status === 200) {
            const clone = res.clone();
            caches.open(CACHE).then((c) => c.put(e.request, clone));
          }
          return res;
        })
        .catch(() => caches.match(new URL('./', SCOPE).href));
    }),
  );
});
