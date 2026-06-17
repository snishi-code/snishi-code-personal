// useAppHistory: createAppHistory と React state の同期を検証する。
import { act } from 'react';
import { renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { useAppHistory } from './useAppHistory';

describe('useAppHistory', () => {
  let backSpy: MockInstance<() => void>;

  beforeEach(() => {
    backSpy = vi.spyOn(window.history, 'back').mockImplementation(() => {});
  });
  afterEach(() => {
    backSpy.mockRestore();
  });

  it('navigate で view state と history.state が同期する', () => {
    const { result, unmount } = renderHook(() => useAppHistory({ initialView: 'home' }));
    expect(result.current.view).toBe('home');
    expect(history.state).toEqual({ view: 'home' });

    act(() => result.current.navigate('settings'));
    expect(result.current.view).toBe('settings');
    expect(history.state).toEqual({ view: 'settings' });
    unmount();
  });

  it('Back (popstate) で view state が復帰する', () => {
    const { result, unmount } = renderHook(() => useAppHistory({ initialView: 'home' }));
    act(() => result.current.navigate('detail'));

    act(() => {
      window.dispatchEvent(new PopStateEvent('popstate', { state: { view: 'home' } }));
    });
    expect(result.current.view).toBe('home');
    unmount();
  });

  it('callback prop は最新の値で呼ばれる (ref 渡し)', () => {
    const showExitConfirm = vi.fn();
    let closable = true;
    const { result, unmount } = renderHook(() =>
      useAppHistory({
        initialView: 'home',
        closeTopOverlay: () => {
          if (closable) {
            closable = false;
            return true;
          }
          return false;
        },
        showExitConfirm,
      }),
    );

    // 1 回目: overlay を閉じるだけで view は変わらない。
    act(() => {
      window.dispatchEvent(new PopStateEvent('popstate', { state: { __exitGuard: true } }));
    });
    expect(showExitConfirm).not.toHaveBeenCalled();
    expect(result.current.view).toBe('home');

    // 2 回目: overlay が無いので guard 処理 → 終了確認。
    act(() => {
      window.dispatchEvent(new PopStateEvent('popstate', { state: { __exitGuard: true } }));
    });
    expect(showExitConfirm).toHaveBeenCalledTimes(1);
    unmount();
  });

  it('beginExit は history.back を呼ぶ', () => {
    const { result, unmount } = renderHook(() => useAppHistory({ initialView: 'home' }));
    act(() => result.current.beginExit());
    expect(backSpy).toHaveBeenCalledTimes(1);
    unmount();
  });
});
