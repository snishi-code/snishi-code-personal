/*
 * ConfirmDialog のテスト。
 * requireKeyword 不一致で確定ボタンが disabled になることを確認する。
 */
import { describe, it, expect, vi, afterEach, beforeAll } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { ConfirmDialog } from './ConfirmDialog';
import { patchDialogIfNeeded } from './test-utils';

beforeAll(() => {
  patchDialogIfNeeded();
});

afterEach(() => {
  cleanup();
});

describe('ConfirmDialog', () => {
  it('基本的なタイトルと本文を表示する', () => {
    render(
      <ConfirmDialog
        title="削除しますか？"
        body="この操作は取り消せません。"
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    expect(screen.getByText('削除しますか？')).toBeInTheDocument();
    expect(screen.getByText('この操作は取り消せません。')).toBeInTheDocument();
  });

  it('requireKeyword が未入力のとき確定ボタンは disabled', () => {
    render(
      <ConfirmDialog
        title="全削除"
        body="確認してください。"
        requireKeyword="DELETE"
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    const confirmBtn = screen.getByRole('button', { name: '実行する' });
    expect(confirmBtn).toBeDisabled();
  });

  it('requireKeyword に一致するテキストを入力すると確定ボタンが enabled になる', () => {
    render(
      <ConfirmDialog
        title="全削除"
        body="確認してください。"
        requireKeyword="DELETE"
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    const input = screen.getByRole('textbox');
    fireEvent.change(input, { target: { value: 'DELETE' } });
    const confirmBtn = screen.getByRole('button', { name: '実行する' });
    expect(confirmBtn).not.toBeDisabled();
  });

  it('requireKeyword と不一致のまま確定ボタンは disabled のまま', () => {
    render(
      <ConfirmDialog
        title="全削除"
        body="確認してください。"
        requireKeyword="DELETE"
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    const input = screen.getByRole('textbox');
    fireEvent.change(input, { target: { value: 'delete' } });
    const confirmBtn = screen.getByRole('button', { name: '実行する' });
    expect(confirmBtn).toBeDisabled();
  });

  it('キャンセルボタンで onCancel を呼ぶ', () => {
    const onCancel = vi.fn();
    render(
      <ConfirmDialog title="確認" body="実行しますか？" onConfirm={vi.fn()} onCancel={onCancel} />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'キャンセル' }));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it('確定ボタンで onConfirm を呼ぶ', () => {
    const onConfirm = vi.fn();
    render(
      <ConfirmDialog title="確認" body="実行しますか？" onConfirm={onConfirm} onCancel={vi.fn()} />,
    );
    fireEvent.click(screen.getByRole('button', { name: '実行する' }));
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });
});
