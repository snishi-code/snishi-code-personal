/*
 * Modal の閉じ方（dismissMode）と useDirtyGuard（破棄確認）。
 *  - always: 背景タップ / Escape で閉じる
 *  - never:  背景タップ / Escape で閉じない（破壊的操作）
 *  - if-clean + dirty: 背景タップで即閉じず破棄確認を出す
 */
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { Modal } from '../src/ui/Modal';
import { useDirtyGuard } from '../src/ui/useDirtyGuard';

function overlay(container: HTMLElement): HTMLElement {
  const el = container.querySelector('.sheet-overlay');
  if (!el) throw new Error('overlay not found');
  return el as HTMLElement;
}

describe('Modal dismissMode', () => {
  it('always: 背景タップで閉じる', () => {
    const onClose = vi.fn();
    const { container } = render(
      <Modal title="メニュー" onClose={onClose} dismissMode="always">
        <p>body</p>
      </Modal>,
    );
    fireEvent.pointerDown(overlay(container));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('always: Escape で閉じる', () => {
    const onClose = vi.fn();
    render(
      <Modal title="メニュー" onClose={onClose} dismissMode="always">
        <p>body</p>
      </Modal>,
    );
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('never: 背景タップ / Escape で閉じない', () => {
    const onClose = vi.fn();
    const { container } = render(
      <Modal title="全削除" onClose={onClose} dismissMode="never">
        <p>body</p>
      </Modal>,
    );
    fireEvent.pointerDown(overlay(container));
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    expect(onClose).not.toHaveBeenCalled();
  });

  it('never: 内部要素のタップでは閉じない（target!==currentTarget）', () => {
    const onClose = vi.fn();
    render(
      <Modal title="フォーム" onClose={onClose} dismissMode="always">
        <p>body</p>
      </Modal>,
    );
    // ダイアログ本体（内部）を押しても閉じない。
    fireEvent.pointerDown(screen.getByRole('dialog'));
    expect(onClose).not.toHaveBeenCalled();
  });

  it('後方互換: dismissable=false は never 相当', () => {
    const onClose = vi.fn();
    const { container } = render(
      <Modal title="復元" onClose={onClose} dismissable={false}>
        <p>body</p>
      </Modal>,
    );
    fireEvent.pointerDown(overlay(container));
    expect(onClose).not.toHaveBeenCalled();
  });
});

function DirtyHarness({ dirty }: { dirty: boolean }) {
  const [closed, setClosed] = useState(false);
  const { requestClose, discardConfirm } = useDirtyGuard(dirty, () => setClosed(true));
  if (closed) return <div>closed</div>;
  return (
    <>
      <Modal title="入力" onClose={requestClose} dismissMode="if-clean">
        <button type="button" onClick={requestClose}>
          キャンセル
        </button>
      </Modal>
      {discardConfirm}
    </>
  );
}

describe('useDirtyGuard 破棄確認', () => {
  it('未編集（clean）は確認なしで閉じる', async () => {
    const user = userEvent.setup();
    render(<DirtyHarness dirty={false} />);
    await user.click(screen.getByRole('button', { name: 'キャンセル' }));
    expect(screen.getByText('closed')).toBeInTheDocument();
  });

  it('編集済み（dirty）は破棄確認を出し、破棄で閉じる', async () => {
    const user = userEvent.setup();
    render(<DirtyHarness dirty />);
    await user.click(screen.getByRole('button', { name: 'キャンセル' }));
    // まだ閉じない。確認が出る。
    expect(screen.queryByText('closed')).not.toBeInTheDocument();
    expect(screen.getByText('入力を破棄しますか？')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '破棄する' }));
    expect(screen.getByText('closed')).toBeInTheDocument();
  });

  it('編集済みでも「編集を続ける」で閉じない', async () => {
    const user = userEvent.setup();
    render(<DirtyHarness dirty />);
    await user.click(screen.getByRole('button', { name: 'キャンセル' }));
    await user.click(screen.getByRole('button', { name: '編集を続ける' }));
    expect(screen.queryByText('closed')).not.toBeInTheDocument();
    expect(screen.queryByText('入力を破棄しますか？')).not.toBeInTheDocument();
  });
});
