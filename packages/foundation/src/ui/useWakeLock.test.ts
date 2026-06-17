import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useWakeLock } from './useWakeLock';

interface FakeSentinel {
  release: ReturnType<typeof vi.fn>;
  addEventListener: (type: 'release', l: () => void) => void;
  fireRelease(): void;
}

function makeSentinel(): FakeSentinel {
  let listener: (() => void) | null = null;
  return {
    release: vi.fn(async () => {}),
    addEventListener: (_t, l) => {
      listener = l;
    },
    fireRelease: () => listener?.(),
  };
}

const flush = async (): Promise<void> => {
  await Promise.resolve();
  await Promise.resolve();
};

const setVisibility = (state: 'visible' | 'hidden'): void => {
  Object.defineProperty(document, 'visibilityState', { value: state, configurable: true });
  document.dispatchEvent(new Event('visibilitychange'));
};

describe('useWakeLock', () => {
  let sentinels: FakeSentinel[];
  let request: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    sentinels = [];
    request = vi.fn(async () => {
      const s = makeSentinel();
      sentinels.push(s);
      return s;
    });
    (navigator as unknown as { wakeLock: unknown }).wakeLock = { request };
  });

  afterEach(() => {
    delete (navigator as unknown as { wakeLock?: unknown }).wakeLock;
    Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
  });

  it('active=true で取得し、unmount で解放する', async () => {
    const { unmount } = renderHook(() => useWakeLock(true));
    await flush();
    expect(request).toHaveBeenCalledTimes(1);
    unmount();
    await flush();
    expect(sentinels[0]!.release).toHaveBeenCalledTimes(1);
  });

  it('active=false では取得しない', async () => {
    renderHook(() => useWakeLock(false));
    await flush();
    expect(request).not.toHaveBeenCalled();
  });

  it('背面化で自動解放されたら visible 復帰で再取得する', async () => {
    renderHook(() => useWakeLock(true));
    await flush();
    expect(request).toHaveBeenCalledTimes(1);

    // OS が背面化で解放 → sentinel の release イベント発火 (ref が null になる)
    sentinels[0]!.fireRelease();
    setVisibility('hidden');
    await flush();

    // visible 復帰で再取得される (修正前は !sentinel ガードでスキップしていた)
    setVisibility('visible');
    await flush();
    expect(request).toHaveBeenCalledTimes(2);
  });

  it('取得中に visible が来ても request は二重に走らない (sentinel リーク防止)', async () => {
    // 初回 request を保留 (pending) にして、解決前に visible を発火させる
    let resolveFirst: (() => void) | null = null;
    request.mockImplementationOnce(
      () =>
        new Promise<FakeSentinel>((res) => {
          resolveFirst = () => {
            const s = makeSentinel();
            sentinels.push(s);
            res(s);
          };
        }),
    );
    renderHook(() => useWakeLock(true));
    // 初回 request は pending。requesting ガードにより 2 本目は wl.request を呼ばない
    setVisibility('visible');
    expect(request).toHaveBeenCalledTimes(1);

    // 初回を解決 → sentinel は 1 本だけ
    resolveFirst!();
    await flush();
    expect(request).toHaveBeenCalledTimes(1);
    expect(sentinels.length).toBe(1);
  });

  it('wakeLock 非対応環境では何もしない (no-op)', async () => {
    delete (navigator as unknown as { wakeLock?: unknown }).wakeLock;
    const { unmount } = renderHook(() => useWakeLock(true));
    await flush();
    unmount();
    // 例外を投げないこと
    expect(true).toBe(true);
  });
});
