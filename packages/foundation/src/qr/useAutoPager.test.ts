import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useAutoPager } from './useAutoPager';

describe('useAutoPager', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('複数ページは intervalMs ごとにループで進む', () => {
    const { result } = renderHook(() => useAutoPager(3, { intervalMs: 100 }));
    expect(result.current.index).toBe(0);
    expect(result.current.playing).toBe(true);
    act(() => void vi.advanceTimersByTime(100));
    expect(result.current.index).toBe(1);
    act(() => void vi.advanceTimersByTime(100));
    expect(result.current.index).toBe(2);
    act(() => void vi.advanceTimersByTime(100));
    expect(result.current.index).toBe(0); // ループ
  });

  it('1 ページ以下では自動送りしない', () => {
    const { result } = renderHook(() => useAutoPager(1, { intervalMs: 100 }));
    act(() => void vi.advanceTimersByTime(500));
    expect(result.current.index).toBe(0);
  });

  it('active=false ではタイマーが回らない', () => {
    const { result } = renderHook(() => useAutoPager(3, { intervalMs: 100, active: false }));
    act(() => void vi.advanceTimersByTime(500));
    expect(result.current.index).toBe(0);
  });

  it('手動 next/prev は自動送りを止める', () => {
    const { result } = renderHook(() => useAutoPager(3, { intervalMs: 100 }));
    act(() => result.current.next());
    expect(result.current.index).toBe(1);
    expect(result.current.playing).toBe(false);
    act(() => void vi.advanceTimersByTime(300));
    expect(result.current.index).toBe(1); // 止まっている
    act(() => result.current.prev());
    expect(result.current.index).toBe(0);
  });

  it('toggle で再生/一時停止できる', () => {
    const { result } = renderHook(() => useAutoPager(3, { intervalMs: 100 }));
    act(() => result.current.toggle());
    expect(result.current.playing).toBe(false);
    act(() => void vi.advanceTimersByTime(300));
    expect(result.current.index).toBe(0);
    act(() => result.current.toggle());
    expect(result.current.playing).toBe(true);
    act(() => void vi.advanceTimersByTime(100));
    expect(result.current.index).toBe(1);
  });

  it('next は末尾で止まる (手動はループしない)', () => {
    const { result } = renderHook(() => useAutoPager(2, { intervalMs: 100 }));
    act(() => result.current.next());
    act(() => result.current.next());
    act(() => result.current.next());
    expect(result.current.index).toBe(1);
  });

  it('pageCount が変わると先頭に戻り自動送り再開', () => {
    const { result, rerender } = renderHook(({ n }) => useAutoPager(n, { intervalMs: 100 }), {
      initialProps: { n: 3 },
    });
    act(() => result.current.toggle()); // 一時停止
    act(() => void vi.advanceTimersByTime(100));
    expect(result.current.playing).toBe(false);
    rerender({ n: 5 });
    expect(result.current.index).toBe(0);
    expect(result.current.playing).toBe(true);
  });

  it('initialPlaying:false は止まったまま開き、toggle で再生できる (static QR)', () => {
    const { result } = renderHook(() =>
      useAutoPager(3, { intervalMs: 100, initialPlaying: false }),
    );
    expect(result.current.playing).toBe(false);
    act(() => void vi.advanceTimersByTime(500));
    expect(result.current.index).toBe(0); // 自動送りしない
    act(() => result.current.toggle());
    expect(result.current.playing).toBe(true);
    act(() => void vi.advanceTimersByTime(100));
    expect(result.current.index).toBe(1);
  });

  it('initialPlaying:false は pageCount 変化後も止まったまま (static 維持)', () => {
    const { result, rerender } = renderHook(
      ({ n }) => useAutoPager(n, { intervalMs: 100, initialPlaying: false }),
      { initialProps: { n: 2 } },
    );
    expect(result.current.playing).toBe(false);
    rerender({ n: 4 });
    expect(result.current.index).toBe(0);
    expect(result.current.playing).toBe(false); // dynamic のように再開しない
  });

  it('pageCount 縮小時も index は範囲内に丸まる', () => {
    const { result, rerender } = renderHook(
      ({ n }) => useAutoPager(n, { intervalMs: 100, active: false }),
      {
        initialProps: { n: 5 },
      },
    );
    act(() => result.current.next());
    act(() => result.current.next());
    expect(result.current.index).toBe(2);
    rerender({ n: 1 });
    expect(result.current.index).toBe(0);
  });
});
