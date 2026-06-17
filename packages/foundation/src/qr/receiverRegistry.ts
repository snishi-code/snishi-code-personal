// 移植元: snishi-code-medical/hospital-rounds/src/features/qr-receive.js
// (registerReceiver / getReceiver / routePage のルーターパターン。DOM 配線・overlay はアプリ側)
import { decodePage } from './protocol.js';

// 統一 QR 受信ルーター: 読み取った 1 ページの kind を見て該当 receiver へ振り分ける。
// 受信入口を kind ごとに増やさないための集約点。
// v1 はルーター内で i18n status を出していたが、foundation は i18n を持たないので
// 失敗理由を reason コードで返し、表示文言はアプリ側に任せる。

export interface ReceiveCtrl {
  setStatus(text: string): void;
  close(): void;
}

export interface ReceiverHandler<R> {
  kindLabel: string;
  receivePage(text: string, ctrl: ReceiveCtrl): R;
}

export interface RouteRejection {
  done: false;
  // consumed:false = 入力欄を消してはいけない (v1 準拠の fail-closed)
  consumed: false;
  // unknown-format: ページ書式不正 / kind-not-allowed: この入口の対象外 kind /
  // no-receiver: 対象 kind だが receiver 未登録
  reason: 'unknown-format' | 'kind-not-allowed' | 'no-receiver';
  kind: string | null;
}

export type RouteResult<R> = RouteRejection | R;

export interface ReceiverRegistry<R> {
  register(kind: string, handler: ReceiverHandler<R>): void;
  get(kind: string): ReceiverHandler<R> | null;
  route(text: string, ctrl: ReceiveCtrl): RouteResult<R>;
}

// allowedKinds: この入口で受け付ける kind の allowlist (v1 の ALLOWED_KINDS=ST/FS/FMT
// に相当するアプリ方針)。省略時は登録済み kind をすべて受け付ける。
export function createReceiverRegistry<R>(allowedKinds?: readonly string[]): ReceiverRegistry<R> {
  const receivers = new Map<string, ReceiverHandler<R>>();
  const allowed = allowedKinds ? new Set(allowedKinds) : null;

  return {
    register(kind, handler) {
      if (!kind || !handler || typeof handler.receivePage !== 'function') return;
      receivers.set(kind, handler);
    },
    get(kind) {
      return receivers.get(kind) ?? null;
    },
    // 生 QR テキスト 1 ページを kind 判定して該当 receiver へ。
    // 形式不正・対象外 kind は consumed:false (入力欄を消さない) で fail-closed。
    route(text, ctrl) {
      const decoded = decodePage(text);
      if (!decoded) {
        return { done: false, consumed: false, reason: 'unknown-format', kind: null };
      }
      if (allowed && !allowed.has(decoded.kind)) {
        return { done: false, consumed: false, reason: 'kind-not-allowed', kind: decoded.kind };
      }
      const receiver = receivers.get(decoded.kind);
      if (!receiver) {
        return { done: false, consumed: false, reason: 'no-receiver', kind: decoded.kind };
      }
      return receiver.receivePage(text, ctrl);
    },
  };
}
