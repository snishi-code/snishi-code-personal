/*
 * toast のテスト: variant 表示と自動消去（vi.useFakeTimers）。
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, fireEvent, act, cleanup } from '@testing-library/react';
import { ToastProvider, useToast } from './toast';

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

function ToastTrigger({
  message,
  variant,
}: {
  message: string;
  variant?: 'success' | 'error' | 'info';
}) {
  const { show } = useToast();
  return (
    <button type="button" onClick={() => show(message, variant)}>
      toast
    </button>
  );
}

function setup(message: string, variant?: 'success' | 'error' | 'info') {
  return render(
    <ToastProvider>
      <ToastTrigger message={message} variant={variant} />
    </ToastProvider>,
  );
}

describe('toast — variant 表示', () => {
  it('success メッセージを表示する', () => {
    setup('保存しました', 'success');
    fireEvent.click(screen.getByRole('button', { name: 'toast' }));
    expect(screen.getByText('保存しました')).toBeInTheDocument();
  });

  it('error メッセージを表示する', () => {
    setup('エラーが発生しました', 'error');
    fireEvent.click(screen.getByRole('button', { name: 'toast' }));
    expect(screen.getByText('エラーが発生しました')).toBeInTheDocument();
  });

  it('info バリアントでも表示する', () => {
    setup('情報です', 'info');
    fireEvent.click(screen.getByRole('button', { name: 'toast' }));
    expect(screen.getByText('情報です')).toBeInTheDocument();
  });
});

describe('toast — 自動消去', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  it('success は 3500ms 後に自動消去される', async () => {
    setup('保存しました', 'success');
    fireEvent.click(screen.getByRole('button', { name: 'toast' }));
    expect(screen.getByText('保存しました')).toBeInTheDocument();

    act(() => {
      vi.advanceTimersByTime(3500);
    });
    expect(screen.queryByText('保存しました')).not.toBeInTheDocument();
  });

  it('error は 6000ms 後に自動消去される', async () => {
    setup('エラーが発生しました', 'error');
    fireEvent.click(screen.getByRole('button', { name: 'toast' }));
    expect(screen.getByText('エラーが発生しました')).toBeInTheDocument();

    act(() => {
      vi.advanceTimersByTime(3500);
    });
    // まだ残っている
    expect(screen.getByText('エラーが発生しました')).toBeInTheDocument();

    act(() => {
      vi.advanceTimersByTime(2500); // 合計 6000ms
    });
    expect(screen.queryByText('エラーが発生しました')).not.toBeInTheDocument();
  });

  it('クリックで即消去される', () => {
    setup('保存しました', 'success');
    fireEvent.click(screen.getByRole('button', { name: 'toast' }));
    const toast = screen.getByText('保存しました');
    // role="presentation" の親要素をクリック
    fireEvent.click(toast.closest('[role="presentation"]') ?? toast);
    expect(screen.queryByText('保存しました')).not.toBeInTheDocument();
  });
});

describe('toast — aria', () => {
  it('role=status aria-live=polite を持つ領域がある', () => {
    render(
      <ToastProvider>
        <span>child</span>
      </ToastProvider>,
    );
    const region = document.querySelector('[role="status"]');
    expect(region).toBeTruthy();
    expect(region?.getAttribute('aria-live')).toBe('polite');
  });
});
