/*
 * 一番上へ移動する浮動ボタン（実ユーズレビュー 2026-08-12 ③）:
 *  - scrollY がしきい値以下では DOM に存在しない（タブ順・支援技術にも出ない）
 *  - しきい値超えで出現し、押すと window.scrollTo({top:0}) + #main へ一時 tabindex でフォーカス
 *  - prefers-reduced-motion では behavior:'auto'（動きを足さない）
 */
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, waitFor, within } from '@testing-library/react';
import { ToastProvider } from '@snishi/foundation/ui/toast';
import { patchDialogIfNeeded } from '@snishi/foundation/ui/test-utils';
import { LedgerProvider, useLedger } from '../src/state/store';
import { Journal } from '../src/ui/screens/Journal';
import { ScrollTopButton, SCROLL_TOP_THRESHOLD_PX } from '../src/ui/ScrollTopButton';
import { UI } from '../src/ui-contract';
import { _resetOverlaysForTests } from '../src/ui/overlays';
import { t } from '../src/i18n';
import './setup';

beforeAll(() => {
  patchDialogIfNeeded();
});

afterEach(() => {
  cleanup();
  _resetOverlaysForTests();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function setScrollY(y: number) {
  // jsdom の window.scrollY は 0 固定の getter。spyOn で差し替え、restoreAllMocks で戻す。
  vi.spyOn(window, 'scrollY', 'get').mockReturnValue(y);
}

const label = () => t('a11y.scrollTop');

describe('ScrollTopButton 単体', () => {
  it('しきい値以下では描画されない', () => {
    setScrollY(SCROLL_TOP_THRESHOLD_PX);
    const view = render(<ScrollTopButton />);
    expect(view.queryByRole('button', { name: label() })).toBeNull();
  });

  it('スクロールで出現し、マウント時点で深い位置なら初回から表示される', () => {
    setScrollY(0);
    const view = render(<ScrollTopButton />);
    expect(view.queryByRole('button', { name: label() })).toBeNull();
    setScrollY(SCROLL_TOP_THRESHOLD_PX + 1);
    fireEvent.scroll(window);
    expect(view.getByRole('button', { name: label() })).toBeInTheDocument();

    cleanup();
    // マウント時 1 回読み（scroll イベント無し）。
    setScrollY(SCROLL_TOP_THRESHOLD_PX + 100);
    const second = render(<ScrollTopButton />);
    expect(second.getByRole('button', { name: label() })).toBeInTheDocument();
  });

  it('押すと scrollTo({top:0, behavior:smooth}) が 1 回呼ばれ、#main へフォーカスが移る', () => {
    setScrollY(500);
    const scrollTo = vi.fn();
    vi.stubGlobal('scrollTo', scrollTo);
    vi.stubGlobal(
      'matchMedia',
      vi.fn().mockReturnValue({ matches: false, addEventListener: vi.fn() }),
    );
    const main = document.createElement('main');
    main.id = 'main';
    document.body.appendChild(main);

    const view = render(<ScrollTopButton />);
    fireEvent.click(view.getByRole('button', { name: label() }));
    expect(scrollTo).toHaveBeenCalledTimes(1);
    expect(scrollTo).toHaveBeenCalledWith({ top: 0, behavior: 'smooth' });
    expect(document.activeElement).toBe(main);
    // tabindex は blur で回収される（恒久付与しない）。
    expect(main.getAttribute('tabindex')).toBe('-1');
    fireEvent.blur(main);
    expect(main.hasAttribute('tabindex')).toBe(false);
    main.remove();
  });

  it('prefers-reduced-motion では behavior:auto（matchMedia 不在も auto 側へ倒す）', () => {
    setScrollY(500);
    const scrollTo = vi.fn();
    vi.stubGlobal('scrollTo', scrollTo);
    vi.stubGlobal(
      'matchMedia',
      vi.fn().mockReturnValue({ matches: true, addEventListener: vi.fn() }),
    );
    const view = render(<ScrollTopButton />);
    fireEvent.click(view.getByRole('button', { name: label() }));
    expect(scrollTo).toHaveBeenCalledWith({ top: 0, behavior: 'auto' });
  });

  it('44px を CSS で担保する .icon-btn クラスを持つ', () => {
    setScrollY(500);
    const view = render(<ScrollTopButton />);
    const button = view.getByRole('button', { name: label() });
    expect(button.className).toContain('icon-btn');
    expect(button.className).toContain('scroll-top');
  });
});

describe('画面への配置', () => {
  it('仕訳一覧の section 子孫として現れる（--scroll-top-bottom の継承が成立する位置）', async () => {
    setScrollY(500);
    render(
      <ToastProvider>
        <LedgerProvider>
          <JournalWhenReady />
        </LedgerProvider>
      </ToastProvider>,
    );
    await waitFor(() => {
      expect(document.querySelector(`[data-ui="${UI.journal.view}"]`)).toBeInTheDocument();
    });
    const view = document.querySelector<HTMLElement>(`[data-ui="${UI.journal.view}"]`);
    expect(view).not.toBeNull();
    expect(within(view!).getByRole('button', { name: label() })).toBeInTheDocument();
  });
});

function JournalWhenReady() {
  const { status } = useLedger();
  return status === 'ready' ? (
    <Journal
      onEditEntry={() => undefined}
      onReverse={() => undefined}
      onOpenAllocations={() => undefined}
      filter={null}
      period={{ mode: 'all' }}
      onClearFilter={() => undefined}
    />
  ) : null;
}
