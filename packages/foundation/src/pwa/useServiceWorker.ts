// 移植元: snishi-code-personal/simple-ledger-src/src/pwa/useServiceWorker.ts (※updateReady/skipWaiting 方式は不採用)
import { useEffect } from 'react';
import { getEnv } from './env';

/**
 * 凍結 SW ポリシー (仕様§10) の登録専用フック。本番のみ register し、dev/test では no-op。
 *
 * 登録条件は getEnv() === 'prod' のみ。head の env 判定スクリプトが data-env を設定する前提。
 * 未設定は env.ts が 'test' に倒す = 登録しない側 (凍結 SW が test origin に残ると
 * 更新手段がないため、誤登録の影響が通常 PWA より重い)。
 * https fallback は廃止: data-env='test' の .pages.dev でも SW が登録されてしまい、
 * docs/deployment.md の「prod のみ登録」と矛盾するため (Codex 監査 M2)。
 *
 * ledger 現行 (simple-ledger-src/src/pwa/useServiceWorker.ts) と異なり、
 * update() / skipWaiting / 「更新あり」リロード促しは実装しない:
 * install 後のアプリは origin から配信される内容に影響されない設計
 * (理由と変更禁止事項は sw.template.js 冒頭の不変性ブロックが正本)。
 */
export function useServiceWorker(swUrl: string = './sw.js'): void {
  useEffect(() => {
    if (!('serviceWorker' in navigator)) return;
    if (getEnv() !== 'prod') return;
    // 登録失敗は握る: SW はオフライン強化の付加機能で、本体動作の前提にしない。
    navigator.serviceWorker.register(swUrl).catch(() => undefined);
  }, [swUrl]);
}
