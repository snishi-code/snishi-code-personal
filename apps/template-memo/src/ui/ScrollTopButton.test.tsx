/*
 * 一番上へ移動する浮動ボタンのテスト。
 *
 * 固定したいこと:
 *   - しきい値未満では要素ごと出さない（タブ順・支援技術に現れない）。
 *   - scroll イベントの無いマウント（画面切替直後）でも現在位置を読んで判断する。
 *   - 押すと先頭へ戻し、reduced-motion では動きを足さない。
 *   - 押した後のフォーカスが本文の起点へ移り、tabindex を残さない。
 */

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ScrollTopButton, SCROLL_TOP_THRESHOLD_PX } from './ScrollTopButton';

function setScrollY(value: number): void {
  Object.defineProperty(window, 'scrollY', { value, configurable: true, writable: true });
}

let scrollToSpy: ReturnType<typeof vi.fn>;

beforeEach(() => {
  setScrollY(0);
  scrollToSpy = vi.fn();
  Object.defineProperty(window, 'scrollTo', { value: scrollToSpy, configurable: true });
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    value: (query: string) => ({ matches: false, media: query }),
  });
});

afterEach(cleanup);

describe('ScrollTopButton', () => {
  it('しきい値未満では要素ごと描画しない', () => {
    setScrollY(SCROLL_TOP_THRESHOLD_PX);
    render(<ScrollTopButton />);
    expect(screen.queryByRole('button', { name: '一番上へ移動' })).toBeNull();
  });

  it('しきい値を超えていれば、scroll イベントが来ていなくてもマウント時に出る', () => {
    // 画面切替直後は深い位置にいても scroll イベントが発火しない。
    setScrollY(SCROLL_TOP_THRESHOLD_PX + 1);
    render(<ScrollTopButton />);
    expect(screen.getByRole('button', { name: '一番上へ移動' })).toBeInTheDocument();
  });

  it('スクロールに追従して出入りする', () => {
    render(<ScrollTopButton />);
    expect(screen.queryByRole('button', { name: '一番上へ移動' })).toBeNull();

    setScrollY(SCROLL_TOP_THRESHOLD_PX + 100);
    fireEvent.scroll(window);
    expect(screen.getByRole('button', { name: '一番上へ移動' })).toBeInTheDocument();

    setScrollY(0);
    fireEvent.scroll(window);
    expect(screen.queryByRole('button', { name: '一番上へ移動' })).toBeNull();
  });

  it('押すと先頭へ戻す（通常は smooth）', () => {
    setScrollY(SCROLL_TOP_THRESHOLD_PX + 100);
    render(<ScrollTopButton />);
    fireEvent.click(screen.getByRole('button', { name: '一番上へ移動' }));
    expect(scrollToSpy).toHaveBeenCalledWith({ top: 0, behavior: 'smooth' });
  });

  it('reduced-motion では動きを足さない', () => {
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      value: (query: string) => ({ matches: true, media: query }),
    });
    setScrollY(SCROLL_TOP_THRESHOLD_PX + 100);
    render(<ScrollTopButton />);
    fireEvent.click(screen.getByRole('button', { name: '一番上へ移動' }));
    expect(scrollToSpy).toHaveBeenCalledWith({ top: 0, behavior: 'auto' });
  });

  it('押した後は本文の起点へフォーカスを移し、tabindex を残さない', () => {
    const main = document.createElement('main');
    main.id = 'main';
    document.body.appendChild(main);
    try {
      setScrollY(SCROLL_TOP_THRESHOLD_PX + 100);
      render(<ScrollTopButton />);
      fireEvent.click(screen.getByRole('button', { name: '一番上へ移動' }));
      expect(document.activeElement).toBe(main);

      // blur で tabindex を回収する（本文タップのたびに main がフォーカスを受けないため）。
      fireEvent.blur(main);
      expect(main.hasAttribute('tabindex')).toBe(false);
    } finally {
      main.remove();
    }
  });
});
