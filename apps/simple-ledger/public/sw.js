/*
 * 移植元: packages/foundation/src/pwa/sw.template.js (凍結更新ポリシーをセマンティクス完全維持で移植)
 *
 * キャッシュ prefix: simple-ledger-v2- (CACHE_NAME_PREFIX と一致。src/data/constants.ts)
 * キャッシュ名: simple-ledger-v2-1 (CACHE_NAME_PREFIX + '1')
 * CACHE_NAME_PREFIX = 'simple-ledger-v2-' (src/data/constants.ts)
 * ※ sw.js は単体配信ファイルなので import はしない。CACHE_PREFIX の値は constants.ts の
 *    CACHE_NAME_PREFIX と一致させること。
 */
// CacheStorage は origin 単位。同一 origin に他アプリ/旧版が同居しても消さない(仕様§7)。
// 削除するのは自アプリ prefix の旧世代のみ。
// CACHE_PREFIX は src/data/constants.ts の CACHE_NAME_PREFIX と値を合わせている。
const CACHE_PREFIX = 'simple-ledger-v2-';
const CACHE = 'simple-ledger-v2-1';

const PRECACHE_PATHS = [];

// SW のスコープ (= sw.js が置かれているディレクトリ)。相対 URL は scope を起点に解決し、
// prod/test どちらの base でも同じファイルが動くようにする (特定ドメインを直書きしない)。
const SCOPE = self.registration
  ? self.registration.scope
  : self.location.href.replace(/[^/]*$/, '');

// app shell。アプリ本体 (index.html) は SW インストール時点の内容で凍結される。
const SHELL = [new URL('./', SCOPE).href, new URL('./index.html', SCOPE).href];

async function precacheAll() {
  const cache = await caches.open(CACHE);
  // best-effort: 一部の追加アセットが落ちてもインストール自体は成功させる
  // (オフライン初回は shell のみ、次のオンライン訪問で埋まる)。
  await Promise.allSettled(SHELL.map((u) => cache.add(u)));
  await Promise.allSettled(PRECACHE_PATHS.map((p) => cache.add(new URL(p, SCOPE).href)));
}

// 自動更新の無効化 = 意図的な「不変性 (immutability)」設計。【セキュリティ要件・変更厳禁】
//   一度インストールされた PWA は、その後 origin から配信される内容に一切影響されない:
//     - skipWaiting() を呼ばない    → 新しい SW は 'waiting' に留まり発火しない
//     - clients.claim() を呼ばない  → 既存インストールは古い SW を使い続ける
//     - index.html は cache-first    → アプリ本体コードは install 時点で凍結される
//     - 登録側 (pwa/useServiceWorker.ts) も registration.update() / updatefound を配線していない
//   狙い: 配信元が信用できるのは「install の瞬間」だけ、と割り切る。install 後に
//     (a) コードの瑕疵が後から「勝手に直って」端末の挙動が変わる、
//     (b) デプロイ環境やアカウントが乗っ取られ悪性コードが既存インストールへ波及する、
//     のどちらも起こさない。可搬性(patchability)より完全性(integrity)を優先する設計。
//   トレードオフ: 正規の修正も既存端末には届かない。更新は「アンインストール →
//     再インストール」のみ (= ユーザーが明示的に再信頼する操作を要求する)。
//   ⚠️ skipWaiting / clients.claim / registration.update / 自動更新プロンプトを
//      足すと、この保証が壊れる。追加しないこと。
self.addEventListener('install', (e) => {
  e.waitUntil(precacheAll());
});

self.addEventListener('activate', (e) => {
  // 旧キャッシュ名の掃除のみ (凍結ポリシー下で新 SW が発火するのは新規インストール時だけ)。
  // CacheStorage は origin 単位。同一 origin に他アプリ/旧版が同居しても消さない(仕様§7)。
  // 削除するのは自アプリ prefix の旧世代のみ。
  e.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys.filter((k) => k.startsWith(CACHE_PREFIX) && k !== CACHE).map((k) => caches.delete(k)),
        ),
      ),
  );
});

// cache-first。miss 時のみ同一オリジン GET を取得してキャッシュへ補充し、
// 全失敗時 (オフラインで未キャッシュ) は SPA shell を返す。
self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET') return;
  // 同一オリジン以外は SW を素通し (外部リソースの取得・キャッシュはしない)。
  if (!e.request.url.startsWith(self.location.origin)) return;

  e.respondWith(
    caches.match(e.request).then((cached) => {
      if (cached) return cached;
      return fetch(e.request) // network-ok: 同一オリジンの app shell キャッシュ取得のみ(上の origin チェック済み)。ユーザーデータ送信なし
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
