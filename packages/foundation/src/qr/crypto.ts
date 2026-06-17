// 移植元: snishi-code-medical/hospital-rounds/src/features/crypto-payload.js (鍵注入化)

/**
 * QR transport payload 層 (圧縮 / 暗号化を prefix で明示)
 *
 * transport wire format (v1 と 1 bit も変えない — v1 端末と相互運用するため):
 *   平文:   "<payload-text>"                                  ... prefix なし = plain (後方互換)
 *   C1:     "C1:<base64url(deflate-raw(plain))>"              ... 圧縮のみ (非暗号、v8.11+)
 *   E1:     "E1:<base64url(iv ‖ AES-GCM(plain))>"             ... v7.1.x (圧縮なし・受信互換)
 *   E2:     "E2:<base64url(iv ‖ AES-GCM(deflate-raw(plain)))>"  ... v7.2.0+ (圧縮+暗号)
 *
 * 暗号化: AES-GCM 256bit (WebCrypto)。iv 12 byte をメッセージごとに
 * getRandomValues、認証タグ 16 byte (改ざん検知)。
 * 圧縮: DEFLATE raw via CompressionStream。未対応環境は feature detect で
 * fallback (encrypt は E1、compress は平文)。
 *
 * 鍵は埋め込まない (v1 からの設計変更): keyBytes (Uint8Array 32) を引数で受け、
 * 鍵の所有はアプリ側に置く (HR-v2 は v1 と同一鍵を注入して v1 端末と相互運用)。
 * foundation に鍵を置くと全アプリが同一鍵を共有してしまい、アプリ毎の鍵分離・
 * 差し替えができなくなるため、transport 層は鍵を知らない設計にする。
 *
 * 送信は最新形式のみ生成、受信 (unpackPayload) は過去全 prefix + plain を読む。
 * 復号失敗・改ざんは throw (fail-closed: 握って成功扱いにしない)。
 */

const PREFIX_C1 = 'C1:'; // v8.11+: deflate-raw のみ (非暗号)
const PREFIX_E1 = 'E1:'; // v7.1.x: AES-GCM のみ
const PREFIX_E2 = 'E2:'; // v7.2.0+: AES-GCM(deflate-raw(plain))

const KEY_LENGTH = 32; // AES-256
const IV_LENGTH = 12; // 96 bit (AES-GCM 推奨)
const TAG_LENGTH = 16; // GCM 認証タグ

// importKey は鍵オブジェクト毎に 1 回で足りる (同一 Uint8Array の再 import を避ける)
const _keyCache = new WeakMap<Uint8Array, Promise<CryptoKey>>();

function importAesKey(keyBytes: Uint8Array | undefined): Promise<CryptoKey> {
  if (!(keyBytes instanceof Uint8Array) || keyBytes.length !== KEY_LENGTH) {
    // 鍵なし・鍵長違いで暗号処理を続行しない (fail-closed)
    throw new Error(`keyBytes must be a ${KEY_LENGTH}-byte Uint8Array`);
  }
  let cached = _keyCache.get(keyBytes);
  if (!cached) {
    // WebCrypto は SharedArrayBuffer 背景の view を受けない。コピーで非共有を保証する
    cached = crypto.subtle.importKey('raw', new Uint8Array(keyBytes), { name: 'AES-GCM' }, false, [
      'encrypt',
      'decrypt',
    ]);
    _keyCache.set(keyBytes, cached);
  }
  return cached;
}

// base64url (RFC 4648 §5)
function bytesToB64Url(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i] as number);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function b64UrlToBytes(str: string): Uint8Array<ArrayBuffer> {
  let s = String(str || '')
    .replace(/-/g, '+')
    .replace(/_/g, '/');
  while (s.length % 4) s += '=';
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

// CompressionStream / DecompressionStream による DEFLATE (raw)。
// 未対応環境では throw、呼び出し側で fallback。
// (Blob.stream() 経由にしない: jsdom 等で未実装のため ReadableStream を直接使う)
async function pumpThrough(
  bytes: Uint8Array<ArrayBuffer>,
  transform: {
    readable: ReadableStream<Uint8Array<ArrayBuffer>>;
    writable: WritableStream<BufferSource>;
  },
): Promise<Uint8Array<ArrayBuffer>> {
  const source = new ReadableStream<BufferSource>({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
  const reader = source.pipeThrough(transform).getReader();
  const parts: Uint8Array<ArrayBuffer>[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    parts.push(value);
    size += value.length;
  }
  const out = new Uint8Array(size);
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}

async function deflateRaw(plainBytes: Uint8Array<ArrayBuffer>): Promise<Uint8Array<ArrayBuffer>> {
  if (typeof CompressionStream === 'undefined') {
    throw new Error('CompressionStream unavailable');
  }
  return pumpThrough(plainBytes, new CompressionStream('deflate-raw'));
}

async function inflateRaw(
  compressedBytes: Uint8Array<ArrayBuffer>,
): Promise<Uint8Array<ArrayBuffer>> {
  if (typeof DecompressionStream === 'undefined') {
    throw new Error('DecompressionStream unavailable');
  }
  return pumpThrough(compressedBytes, new DecompressionStream('deflate-raw'));
}

// 共通: AES-GCM 暗号化 → "<prefix><base64url(iv ‖ ct)>"
async function aesGcmEncryptToPrefixed(
  prefix: string,
  plainBytes: Uint8Array<ArrayBuffer>,
  key: CryptoKey,
): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(IV_LENGTH));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, plainBytes);
  const combined = new Uint8Array(iv.length + ct.byteLength);
  combined.set(iv, 0);
  combined.set(new Uint8Array(ct), iv.length);
  return prefix + bytesToB64Url(combined);
}

// 共通: prefix 剥がして AES-GCM 復号 → plainBytes。改ざん・鍵違いは throw
async function aesGcmDecryptFromPrefixed(
  prefix: string,
  ciphertext: string,
  key: CryptoKey,
): Promise<Uint8Array<ArrayBuffer>> {
  const blob = b64UrlToBytes(ciphertext.slice(prefix.length));
  if (blob.length < IV_LENGTH + TAG_LENGTH) throw new Error('encrypted payload too short');
  const iv = blob.slice(0, IV_LENGTH);
  const ct = blob.slice(IV_LENGTH);
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ct);
  return new Uint8Array(pt);
}

export interface PackOptions {
  encrypt?: boolean;
  compress?: boolean;
  keyBytes?: Uint8Array;
}

export interface UnpackOptions {
  keyBytes?: Uint8Array;
}

// plain → transport payload。
//   encrypt:true  → E2 (圧縮+暗号、CompressionStream 不可なら E1)。keyBytes 必須 (無ければ throw)
//   compress:true → C1 (圧縮のみ、不可なら平文)
//   どちらも false → 平文 (prefix なし)
// 圧縮で短くならない (むしろ伸びる) 場合は平文を返す (QR を無駄に大きくしない)。
export async function packPayload(plain: string, opts: PackOptions = {}): Promise<string> {
  if (plain == null) return '';
  const s = String(plain);
  if (opts.encrypt) {
    // 暗号化が要るのに鍵がない場合はここで throw し、平文 QR を出させない (fail-closed)
    const key = await importAesKey(opts.keyBytes);
    const plainBytes = new TextEncoder().encode(s);
    let compressed: Uint8Array<ArrayBuffer> | null;
    try {
      compressed = await deflateRaw(plainBytes);
    } catch {
      compressed = null; // CompressionStream 未対応 → E1 (暗号のみ) に fallback
    }
    return compressed
      ? aesGcmEncryptToPrefixed(PREFIX_E2, compressed, key)
      : aesGcmEncryptToPrefixed(PREFIX_E1, plainBytes, key);
  }
  if (opts.compress) {
    try {
      const compressed = await deflateRaw(new TextEncoder().encode(s));
      const packed = PREFIX_C1 + bytesToB64Url(compressed);
      // C1 化で base64 オーバーヘッドの方が大きいなら平文の方が短い
      return packed.length < s.length ? packed : s;
    } catch {
      return s; // CompressionStream 未対応 → 平文
    }
  }
  return s;
}

// transport payload → plain。E2/E1/C1/平文 をすべて読む (送信側バージョン非依存)。
// 復号失敗・改ざん・鍵なしの暗号文は throw (fail-closed、呼び出し側が通知する)。
export async function unpackPayload(text: string, opts: UnpackOptions = {}): Promise<string> {
  const s = String(text || '');
  if (s.startsWith(PREFIX_C1)) {
    const compressed = b64UrlToBytes(s.slice(PREFIX_C1.length));
    const plainBytes = await inflateRaw(compressed);
    return new TextDecoder().decode(plainBytes);
  }
  if (s.startsWith(PREFIX_E2)) {
    const key = await importAesKey(opts.keyBytes);
    const compressed = await aesGcmDecryptFromPrefixed(PREFIX_E2, s, key);
    const plainBytes = await inflateRaw(compressed);
    return new TextDecoder().decode(plainBytes);
  }
  if (s.startsWith(PREFIX_E1)) {
    const key = await importAesKey(opts.keyBytes);
    const plainBytes = await aesGcmDecryptFromPrefixed(PREFIX_E1, s, key);
    return new TextDecoder().decode(plainBytes);
  }
  return s; // 平文の透過処理 (後方互換)
}

export function isEncrypted(text: unknown): boolean {
  if (typeof text !== 'string') return false;
  return text.startsWith(PREFIX_E1) || text.startsWith(PREFIX_E2);
}
