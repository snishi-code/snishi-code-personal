import { useEffect } from 'react';
import { getEnv } from './env';

/**
 * SW の登録専用フック。本番のみ register し、dev/test では no-op。
 *
 * 登録条件は getEnv() === 'prod' のみ。head の env 判定スクリプトが data-env を設定する前提。
 * 未設定は env.ts が 'test' に倒す = 登録しない側 (test origin に SW を残さない運用を維持)。
 * https fallback は廃止: data-env='test' の .pages.dev でも SW が登録されてしまい、
 * prod のみ登録する運用と矛盾するため。
 *
 * 更新ポリシー (2026-07-07 改訂: 凍結 → 標準ライフサイクル):
 * テンプレート側が navigation network-first のため、デプロイ済みの更新は次回起動時に
 * 反映される。skipWaiting / clients.claim による「使用中の版切り替え」だけを禁止する
 * (不変条件の正本 = sw.template.js のポリシーブロック・歩哨 = pwa/sw.template.test.ts)。
 * registration.update() / updatefound の配線は禁止ではなくなったが、ブラウザ既定の
 * 更新チェックで足りるため現状は足していない。
 */
export function useServiceWorker(swUrl: string = './sw.js'): void {
  useEffect(() => {
    if (!('serviceWorker' in navigator)) return;
    if (getEnv() !== 'prod') return;
    // 登録失敗は握る: SW はオフライン強化の付加機能で、本体動作の前提にしない。
    navigator.serviceWorker.register(swUrl).catch(() => undefined);
  }, [swUrl]);
}
