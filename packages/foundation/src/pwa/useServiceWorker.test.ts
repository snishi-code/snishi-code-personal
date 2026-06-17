// @vitest-environment jsdom
// useServiceWorker の env 判定テスト (Codex 監査 M2)。
// getEnv() === 'prod' のときのみ register が呼ばれること、
// test / 未設定では呼ばれないことを確認する。
import { renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useServiceWorker } from './useServiceWorker';

// navigator.serviceWorker.register のモック
const registerMock = vi.fn().mockResolvedValue({});

beforeEach(() => {
  registerMock.mockClear();
  Object.defineProperty(navigator, 'serviceWorker', {
    value: { register: registerMock },
    writable: true,
    configurable: true,
  });
});

afterEach(() => {
  // dataset.env をリセット
  delete document.documentElement.dataset.env;
});

describe('useServiceWorker (M2: getEnv() === prod のみ登録)', () => {
  it("data-env='prod' のとき register が呼ばれる", () => {
    document.documentElement.dataset.env = 'prod';
    renderHook(() => useServiceWorker('./sw.js'));
    expect(registerMock).toHaveBeenCalledOnce();
    expect(registerMock).toHaveBeenCalledWith('./sw.js');
  });

  it("data-env='test' のとき register は呼ばれない", () => {
    document.documentElement.dataset.env = 'test';
    renderHook(() => useServiceWorker('./sw.js'));
    expect(registerMock).not.toHaveBeenCalled();
  });

  it('dataset.env 未設定(env.ts が test に倒す)のとき register は呼ばれない', () => {
    // dataset.env を明示的に削除して未設定状態にする
    delete document.documentElement.dataset.env;
    renderHook(() => useServiceWorker('./sw.js'));
    expect(registerMock).not.toHaveBeenCalled();
  });
});
