import { describe, it, expect, vi, afterEach } from 'vitest';
import { packPayload, unpackPayload, isEncrypted } from './crypto.js';

// テスト専用鍵 (本物のアプリ鍵は foundation に置かない — 鍵の所有はアプリ側)
const KEY = Uint8Array.from({ length: 32 }, (_, i) => (i * 7 + 3) % 256);
const WRONG_KEY = Uint8Array.from({ length: 32 }, (_, i) => (i * 5 + 1) % 256);

// 実装と独立した base64url ヘルパ (改ざんテスト・E1 手組み用)
function b64UrlToBytes(str: string): Uint8Array {
  let s = str.replace(/-/g, '+').replace(/_/g, '/');
  while (s.length % 4) s += '=';
  const bin = atob(s);
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}
function bytesToB64Url(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

const PLAIN = '{"v":5,"p":[{"r":"301","n":"テスト 患者","t":[1,2]}]}\n'.repeat(8);

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('plain (prefix なし)', () => {
  it('encrypt/compress なしは素通し', async () => {
    expect(await packPayload('hello|world\n', {})).toBe('hello|world\n');
    expect(await unpackPayload('hello|world\n')).toBe('hello|world\n');
  });
  it('plain は鍵なしで unpack できる (後方互換)', async () => {
    expect(await unpackPayload(PLAIN)).toBe(PLAIN);
  });
});

describe('C1 (圧縮のみ・非暗号)', () => {
  it('pack→unpack roundtrip (鍵不要)', async () => {
    const packed = await packPayload(PLAIN, { compress: true });
    expect(packed.startsWith('C1:')).toBe(true);
    expect(packed.length).toBeLessThan(PLAIN.length);
    expect(await unpackPayload(packed)).toBe(PLAIN);
  });
  it('圧縮で伸びる短文は平文を返す', async () => {
    const packed = await packPayload('abc', { compress: true });
    expect(packed).toBe('abc');
  });
  it('isEncrypted は C1 を暗号扱いしない', async () => {
    const packed = await packPayload(PLAIN, { compress: true });
    expect(isEncrypted(packed)).toBe(false);
  });
});

describe('E2 (圧縮+暗号)', () => {
  it('pack→unpack roundtrip', async () => {
    const packed = await packPayload(PLAIN, { encrypt: true, keyBytes: KEY });
    expect(packed.startsWith('E2:')).toBe(true);
    expect(isEncrypted(packed)).toBe(true);
    expect(await unpackPayload(packed, { keyBytes: KEY })).toBe(PLAIN);
  });

  it('v1 互換歩哨: "E2:" prefix + base64url + iv 12B + GCM tag 16B', async () => {
    const packed = await packPayload(PLAIN, { encrypt: true, keyBytes: KEY });
    expect(packed.slice(0, 3)).toBe('E2:');
    const body = packed.slice(3);
    expect(body).toMatch(/^[A-Za-z0-9_-]+$/); // base64url (padding なし)
    const blob = b64UrlToBytes(body);
    expect(blob.length).toBeGreaterThanOrEqual(12 + 16); // iv ‖ ct(+tag)
    // iv はメッセージ毎にランダム (先頭 12B が毎回変わる)
    const packed2 = await packPayload(PLAIN, { encrypt: true, keyBytes: KEY });
    const iv1 = b64UrlToBytes(packed.slice(3)).slice(0, 12);
    const iv2 = b64UrlToBytes(packed2.slice(3)).slice(0, 12);
    expect(Array.from(iv1)).not.toEqual(Array.from(iv2));
  });

  it('wrong key で unpack が throw (fail-closed)', async () => {
    const packed = await packPayload(PLAIN, { encrypt: true, keyBytes: KEY });
    await expect(unpackPayload(packed, { keyBytes: WRONG_KEY })).rejects.toThrow();
  });

  it('改ざん (1 byte 反転) で throw', async () => {
    const packed = await packPayload(PLAIN, { encrypt: true, keyBytes: KEY });
    const blob = b64UrlToBytes(packed.slice(3));
    const last = blob.length - 1;
    blob[last] = (blob[last] as number) ^ 0x01; // GCM tag 末尾を反転
    await expect(unpackPayload('E2:' + bytesToB64Url(blob), { keyBytes: KEY })).rejects.toThrow();
    const mid = Math.floor(blob.length / 2);
    const blob2 = b64UrlToBytes(packed.slice(3));
    blob2[mid] = (blob2[mid] as number) ^ 0x80; // 暗号文中央を反転
    await expect(unpackPayload('E2:' + bytesToB64Url(blob2), { keyBytes: KEY })).rejects.toThrow();
  });

  it('鍵なしの encrypt は throw (平文 QR を出させない)', async () => {
    await expect(packPayload(PLAIN, { encrypt: true })).rejects.toThrow(/keyBytes/);
  });

  it('鍵長 32B 以外は throw', async () => {
    await expect(
      packPayload(PLAIN, { encrypt: true, keyBytes: new Uint8Array(16) }),
    ).rejects.toThrow(/32/);
  });

  it('鍵なしで暗号文を unpack すると throw', async () => {
    const packed = await packPayload(PLAIN, { encrypt: true, keyBytes: KEY });
    await expect(unpackPayload(packed)).rejects.toThrow();
  });
});

describe('E1 (暗号のみ・v1 受信互換)', () => {
  it('CompressionStream 不可なら packPayload は E1 に fallback し、roundtrip する', async () => {
    vi.stubGlobal('CompressionStream', undefined);
    const packed = await packPayload(PLAIN, { encrypt: true, keyBytes: KEY });
    expect(packed.startsWith('E1:')).toBe(true);
    expect(isEncrypted(packed)).toBe(true);
    vi.unstubAllGlobals();
    expect(await unpackPayload(packed, { keyBytes: KEY })).toBe(PLAIN);
  });

  it('手組みした E1 (iv ‖ AES-GCM(plain)) を復号できる — v1 端末との互換', async () => {
    const key = await crypto.subtle.importKey('raw', KEY, { name: 'AES-GCM' }, false, ['encrypt']);
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = new Uint8Array(
      await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(PLAIN)),
    );
    const combined = new Uint8Array(iv.length + ct.length);
    combined.set(iv, 0);
    combined.set(ct, iv.length);
    const e1 = 'E1:' + bytesToB64Url(combined);
    expect(await unpackPayload(e1, { keyBytes: KEY })).toBe(PLAIN);
  });

  it('E1 も wrong key で throw', async () => {
    vi.stubGlobal('CompressionStream', undefined);
    const packed = await packPayload(PLAIN, { encrypt: true, keyBytes: KEY });
    vi.unstubAllGlobals();
    await expect(unpackPayload(packed, { keyBytes: WRONG_KEY })).rejects.toThrow();
  });
});

describe('isEncrypted', () => {
  it('E1/E2 のみ true', () => {
    expect(isEncrypted('E1:abc')).toBe(true);
    expect(isEncrypted('E2:abc')).toBe(true);
    expect(isEncrypted('C1:abc')).toBe(false);
    expect(isEncrypted('plain')).toBe(false);
    expect(isEncrypted(42)).toBe(false);
    expect(isEncrypted(null)).toBe(false);
  });
});
