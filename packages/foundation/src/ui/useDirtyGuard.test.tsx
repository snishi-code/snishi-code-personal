/*
 * useDirtyGuard のテスト。
 * clean→即閉、dirty→確認→「破棄する」で閉 / 「編集を続ける」で残る。
 */
import { describe, it, expect, vi, afterEach, beforeAll } from 'vitest';
import { render, screen, fireEvent, act, cleanup } from '@testing-library/react';
import { useDirtyGuard } from './useDirtyGuard';
import { patchDialogIfNeeded } from './test-utils';

beforeAll(() => {
  patchDialogIfNeeded();
});

afterEach(() => {
  cleanup();
});

function Harness({ dirty, onClose }: { dirty: boolean; onClose: () => void }) {
  const { requestClose, discardConfirm } = useDirtyGuard(dirty, onClose);
  return (
    <>
      <button type="button" onClick={requestClose}>
        閉じる
      </button>
      {discardConfirm}
    </>
  );
}

describe('useDirtyGuard', () => {
  it('dirty=false なら requestClose で即 onClose を呼ぶ', () => {
    const onClose = vi.fn();
    render(<Harness dirty={false} onClose={onClose} />);
    fireEvent.click(screen.getByRole('button', { name: '閉じる' }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('dirty=true なら確認ダイアログを表示し、まだ onClose を呼ばない', () => {
    const onClose = vi.fn();
    render(<Harness dirty={true} onClose={onClose} />);
    fireEvent.click(screen.getByRole('button', { name: '閉じる' }));
    expect(screen.getByText('変更を破棄しますか？')).toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();
  });

  it('確認ダイアログで「破棄する」を押すと onClose を呼ぶ', () => {
    const onClose = vi.fn();
    render(<Harness dirty={true} onClose={onClose} />);
    fireEvent.click(screen.getByRole('button', { name: '閉じる' }));
    // 確認ダイアログの「破棄する」ボタン
    const discardBtn = screen.getByRole('button', { name: '破棄する' });
    act(() => {
      fireEvent.click(discardBtn);
    });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('確認ダイアログで「編集を続ける」を押すとダイアログを閉じて onClose を呼ばない', () => {
    const onClose = vi.fn();
    render(<Harness dirty={true} onClose={onClose} />);
    fireEvent.click(screen.getByRole('button', { name: '閉じる' }));
    const keepBtn = screen.getByRole('button', { name: '編集を続ける' });
    act(() => {
      fireEvent.click(keepBtn);
    });
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.queryByText('変更を破棄しますか？')).not.toBeInTheDocument();
  });
});
