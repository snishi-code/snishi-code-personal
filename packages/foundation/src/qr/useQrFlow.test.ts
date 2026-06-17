import { describe, it, expect, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useQrFlow, type QrFlowConfig, type ReceiveResult } from './useQrFlow.js';
import { encodePages, decodePage, utf8ByteLength } from './protocol.js';
import { packPayload } from './crypto.js';

// テスト専用鍵 (本物のアプリ鍵は foundation に置かない — 鍵の所有はアプリ側)
const KEY = Uint8Array.from({ length: 32 }, (_, i) => (i * 7 + 3) % 256);
const WRONG_KEY = Uint8Array.from({ length: 32 }, (_, i) => (i * 5 + 1) % 256);

// maxBytes=200 (budget 150B) で 3 ページ以上に割れるサイズにする
const PAYLOAD = '{"v":1,"items":["α","β"]}\n' + 'line|data\n'.repeat(40);

function makeCfg(
  overrides: Partial<QrFlowConfig<unknown>> = {},
): QrFlowConfig<unknown> & { onApply: ReturnType<typeof vi.fn> } {
  return {
    kind: 'TT',
    kindLabel: 'テスト',
    encodePayload: () => PAYLOAD,
    decodePayload: (plain: string) => JSON.parse(plain.split('\n')[0] as string) as unknown,
    shouldEncrypt: () => false,
    keyBytes: KEY,
    onApply: vi.fn(),
    ...overrides,
    // overrides.onApply も常に vi.fn を渡す規約 (mock アサーション用)
  } as QrFlowConfig<unknown> & { onApply: ReturnType<typeof vi.fn> };
}

// 送信側相当のページ列を hook の外で組み立てる (受信テスト用)
async function buildPages(opts: {
  kind?: string;
  payload?: string;
  batchId?: string;
  encrypt?: boolean;
  maxBytes?: number;
}): Promise<string[]> {
  const packed = await packPayload(opts.payload ?? PAYLOAD, {
    encrypt: !!opts.encrypt,
    keyBytes: KEY,
  });
  return encodePages({
    kind: opts.kind ?? 'TT',
    payload: packed,
    batchId: opts.batchId ?? 'batch1',
    maxBytes: opts.maxBytes ?? 200, // 3 ページ以上に割れる小さめ budget
  });
}

async function recv(
  hook: { current: ReturnType<typeof useQrFlow> },
  text: string,
): Promise<ReceiveResult> {
  let r!: ReceiveResult;
  await act(async () => {
    r = await hook.current.receivePage(text);
  });
  return r;
}

describe('useQrFlow 送信', () => {
  it('open() でページ生成・isActive・ページナビ', async () => {
    const cfg = makeCfg({ maxBytes: 200 });
    const { result } = renderHook(() => useQrFlow(cfg));
    expect(result.current.isActive).toBe(false);
    expect(result.current.pages).toEqual([]);

    await act(async () => result.current.open());
    expect(result.current.isActive).toBe(true);
    expect(result.current.pages.length).toBeGreaterThan(1);
    const total = result.current.pages.length;
    for (const [i, page] of result.current.pages.entries()) {
      expect(utf8ByteLength(page)).toBeLessThanOrEqual(200);
      const d = decodePage(page);
      expect(d).toMatchObject({ kind: 'TT', pageNum: i + 1, totalPages: total });
    }

    // ページナビは範囲内に clamp される
    expect(result.current.pageIndex).toBe(0);
    act(() => result.current.prev());
    expect(result.current.pageIndex).toBe(0);
    act(() => result.current.next());
    expect(result.current.pageIndex).toBe(1);
    for (let i = 0; i < total + 3; i++) act(() => result.current.next());
    expect(result.current.pageIndex).toBe(total - 1);

    act(() => result.current.close());
    expect(result.current.isActive).toBe(false);
  });

  it('shouldEncrypt=true で content が E2 暗号文になる (平文を QR に乗せない)', async () => {
    const cfg = makeCfg({ shouldEncrypt: () => true });
    const { result } = renderHook(() => useQrFlow(cfg));
    await act(async () => result.current.open());
    expect(result.current.pages.length).toBeGreaterThan(0);
    for (const page of result.current.pages) {
      expect(page).not.toContain('line|data');
    }
    const first = decodePage(result.current.pages[0] as string);
    expect(first?.content.startsWith('E2:')).toBe(true);
  });

  it('encodePayload が空なら QR を出さない', async () => {
    const cfg = makeCfg({ encodePayload: () => '' });
    const { result } = renderHook(() => useQrFlow(cfg));
    await act(async () => result.current.open());
    expect(result.current.pages).toEqual([]);
  });

  it('暗号化が必要なのに鍵が不正なら open() が throw し QR を出さない (fail-closed)', async () => {
    const cfg = makeCfg({ shouldEncrypt: () => true, keyBytes: new Uint8Array(8) });
    const { result } = renderHook(() => useQrFlow(cfg));
    await expect(act(async () => result.current.open())).rejects.toThrow(/32/);
    expect(result.current.pages).toEqual([]);
  });

  it('refresh() は表示中だけ再生成し、batchId が変わる', async () => {
    const cfg = makeCfg();
    const { result } = renderHook(() => useQrFlow(cfg));
    await act(async () => result.current.refresh()); // 非表示中は no-op
    expect(result.current.pages).toEqual([]);

    await act(async () => result.current.open());
    const before = result.current.pages.slice();
    await new Promise((r) => setTimeout(r, 5)); // newBatchId は時刻由来
    await act(async () => result.current.refresh());
    const b1 = decodePage(before[0] as string)?.batchId;
    const b2 = decodePage(result.current.pages[0] as string)?.batchId;
    expect(b1).not.toBe(b2);
  });
});

describe('useQrFlow 受信 (v1 ingestPage 準拠の状態遷移)', () => {
  it('形式不正は unknownFormat / consumed:false', async () => {
    const cfg = makeCfg();
    const { result } = renderHook(() => useQrFlow(cfg));
    const r = await recv(result, 'ただのテキスト');
    expect(r).toMatchObject({ done: false, consumed: false, status: 'unknownFormat' });
    expect(cfg.onApply).not.toHaveBeenCalled();
  });

  it('kind 違いは wrongKind / consumed:false (gotKind 付き)', async () => {
    const cfg = makeCfg();
    const { result } = renderHook(() => useQrFlow(cfg));
    const [page] = await buildPages({ kind: 'XX' });
    const r = await recv(result, page as string);
    expect(r).toMatchObject({ done: false, consumed: false, status: 'wrongKind', gotKind: 'XX' });
    expect(cfg.onApply).not.toHaveBeenCalled();
  });

  it('2/3 受信は progress、欠落のままでは complete しない', async () => {
    const cfg = makeCfg();
    const { result } = renderHook(() => useQrFlow(cfg));
    const pages = await buildPages({});
    expect(pages.length).toBeGreaterThanOrEqual(3);

    const r1 = await recv(result, pages[0] as string);
    expect(r1).toMatchObject({ done: false, consumed: true, status: 'progress', got: 1 });
    const r2 = await recv(result, pages[2] as string); // 順不同 OK
    expect(r2).toMatchObject({ done: false, consumed: true, status: 'progress', got: 2 });
    expect(result.current.recv).toEqual({ batchId: 'batch1', total: pages.length, got: 2 });
    expect(cfg.onApply).not.toHaveBeenCalled();
  });

  it('重複ページは duplicate で進捗を進めない (無害)', async () => {
    const cfg = makeCfg();
    const { result } = renderHook(() => useQrFlow(cfg));
    const pages = await buildPages({});
    await recv(result, pages[0] as string);
    const r = await recv(result, pages[0] as string);
    expect(r).toMatchObject({ done: false, consumed: true, status: 'duplicate', got: 1 });
    expect(result.current.recv.got).toBe(1);
  });

  it('別 batchId が来たら古い断片を破棄して新バッチ開始 (newBatch:true)', async () => {
    const cfg = makeCfg();
    const { result } = renderHook(() => useQrFlow(cfg));
    const pagesA = await buildPages({ batchId: 'aaa' });
    const pagesB = await buildPages({ batchId: 'bbb' });
    await recv(result, pagesA[0] as string);
    await recv(result, pagesA[1] as string);
    const r = await recv(result, pagesB[0] as string);
    expect(r).toMatchObject({
      done: false,
      consumed: true,
      status: 'progress',
      newBatch: true,
      got: 1,
    });
    expect(result.current.recv).toEqual({ batchId: 'bbb', total: pagesB.length, got: 1 });
  });

  it('全ページ揃ったら unpack→decode→onApply され、受信状態がリセットされる', async () => {
    const cfg = makeCfg({ shouldEncrypt: () => true });
    const { result } = renderHook(() => useQrFlow(cfg));
    const pages = await buildPages({ encrypt: true });
    for (const page of pages.slice(0, -1)) {
      expect((await recv(result, page)).done).toBe(false);
    }
    const r = await recv(result, pages[pages.length - 1] as string);
    expect(r).toMatchObject({
      done: true,
      consumed: true,
      status: 'complete',
      total: pages.length,
    });
    expect(cfg.onApply).toHaveBeenCalledTimes(1);
    expect(cfg.onApply.mock.calls[0]?.[0]).toEqual({ v: 1, items: ['α', 'β'] });
    expect(result.current.recv).toEqual({ batchId: null, total: 0, got: 0 });
  });

  it('onApply の ctrl.close() で送信カードが閉じる', async () => {
    const cfg = makeCfg({
      onApply: vi.fn((_decoded: unknown, ctrl: { close(): void }) => ctrl.close()),
    });
    const { result } = renderHook(() => useQrFlow(cfg));
    await act(async () => result.current.open());
    expect(result.current.isActive).toBe(true);
    const pages = await buildPages({ maxBytes: 5000 }); // 1 ページで完了
    expect(pages).toHaveLength(1);
    const r = await recv(result, pages[0] as string);
    expect(r.status).toBe('complete');
    expect(result.current.isActive).toBe(false);
  });

  it('復号失敗 (wrong key) は throw し onApply に到達しない (fail-closed)', async () => {
    const cfg = makeCfg({ keyBytes: WRONG_KEY });
    const { result } = renderHook(() => useQrFlow(cfg));
    const pages = await buildPages({ encrypt: true, maxBytes: 5000 });
    await expect(recv(result, pages[0] as string)).rejects.toThrow();
    expect(cfg.onApply).not.toHaveBeenCalled();
    // 状態は complete 時点で破棄済み → 読み直しでやり直せる
    expect(result.current.recv).toEqual({ batchId: null, total: 0, got: 0 });
  });

  it('decodePayload の throw は onApply に到達しない (fail-closed)', async () => {
    const cfg = makeCfg({
      decodePayload: () => {
        throw new Error('parse failed');
      },
    });
    const { result } = renderHook(() => useQrFlow(cfg));
    const pages = await buildPages({ maxBytes: 5000 });
    await expect(recv(result, pages[0] as string)).rejects.toThrow('parse failed');
    expect(cfg.onApply).not.toHaveBeenCalled();
  });

  it('ヘッダ矛盾 (pageNum > totalPages) は拒否して組み立て不能に陥らない', async () => {
    const cfg = makeCfg();
    const { result } = renderHook(() => useQrFlow(cfg));
    const pages = await buildPages({});
    await recv(result, pages[0] as string);
    const bogus = `RND_TT #batch1 ${pages.length + 5}/${pages.length}\njunk`;
    const r = await recv(result, bogus);
    expect(r).toMatchObject({ done: false, consumed: false, status: 'unknownFormat', got: 1 });
  });
});
