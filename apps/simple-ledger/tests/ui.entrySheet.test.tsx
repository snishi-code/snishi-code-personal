/*
 * EntrySheet: dirty guard テスト。
 * 内容を変更後にキャンセルすると「破棄確認」ダイアログが出て、
 * 未変更ならそのまま onClose を呼ぶことを確認する。
 */
import { describe, it, expect, vi, afterEach, beforeAll } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import { EntrySheet } from '../src/ui/screens/EntrySheet';
import { LedgerProvider } from '../src/state/store';
import { ToastProvider } from '@snishi/foundation/ui/toast';
import { patchDialogIfNeeded } from '@snishi/foundation/ui/test-utils';
import { UI } from '../src/ui-contract';
import './setup';

beforeAll(() => {
  patchDialogIfNeeded();
});

afterEach(() => {
  cleanup();
});

function Providers({ children }: { children: React.ReactNode }) {
  return (
    <ToastProvider>
      <LedgerProvider>{children}</LedgerProvider>
    </ToastProvider>
  );
}

describe('EntrySheet — dirty guard', () => {
  it('未変更でキャンセルすると onClose が即呼ばれる', async () => {
    const onClose = vi.fn();
    render(
      <Providers>
        <EntrySheet init={{ kind: 'create', mode: 'expense' }} onClose={onClose} />
      </Providers>,
    );
    // キャンセルボタンをクリック
    await waitFor(() => {
      expect(document.querySelector(`[data-ui="${UI.journal.entry.cancel}"]`)).toBeInTheDocument();
    });
    fireEvent.click(document.querySelector(`[data-ui="${UI.journal.entry.cancel}"]`)!);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('金額を変更後にキャンセルすると確認ダイアログが出る', async () => {
    const onClose = vi.fn();
    render(
      <Providers>
        <EntrySheet init={{ kind: 'create', mode: 'expense' }} onClose={onClose} />
      </Providers>,
    );
    await waitFor(() => {
      expect(document.querySelector(`[data-ui="${UI.journal.entry.amount}"]`)).toBeInTheDocument();
    });
    // 金額フィールド（data-ui が input 自体に付く）に直接 change イベント
    const amountInput = document.querySelector<HTMLInputElement>(
      `[data-ui="${UI.journal.entry.amount}"]`,
    );
    expect(amountInput).not.toBeNull();
    fireEvent.change(amountInput!, { target: { value: '1000' } });
    // React の state 更新を flush する
    await waitFor(() => {
      expect(amountInput!.value).toBe('1000');
    });
    // キャンセルクリック → dirty = true なので onClose はまだ呼ばれない
    fireEvent.click(document.querySelector(`[data-ui="${UI.journal.entry.cancel}"]`)!);
    expect(onClose).not.toHaveBeenCalled();
    // 確認ダイアログ（dirty guard）が表示されるはず
    await waitFor(() => {
      // ConfirmDialog は role=dialog の2つ目として出る
      const dialogs = screen.getAllByRole('dialog');
      expect(dialogs.length).toBeGreaterThanOrEqual(2);
    });
  });
});
