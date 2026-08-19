/*
 * 確認ダイアログの fail-closed（v13.8 監査 A）:
 *  - 保存境界の失敗 = 「未保存」: ダイアログは**閉じない**（閉じると成功に見える）。
 *    エラーは store の toast で名乗り、そのまま再試行できる。
 *  - 確定中は両ボタンを無効化（二重実行防止・ConfirmDialog の busy）。
 *  - mutation 成功後の refresh 失敗 = 「保存済み・表示が古いだけ」: 失敗扱いに戻さない
 *    （「未保存」に見せると再送 = 二重実行を誘発する）。警告 toast のみで閉じる。
 */
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { ToastProvider } from '@snishi/foundation/ui/toast';
import { patchDialogIfNeeded } from '@snishi/foundation/ui/test-utils';
import { LedgerProvider, useLedger } from '../src/state/store';
import { Accounts } from '../src/ui/screens/Accounts';
import * as repository from '../src/data/repository';
import { loadLedger } from '../src/data/repository';
import { UI } from '../src/ui-contract';
import { _resetOverlaysForTests } from '../src/ui/overlays';
import './setup';

beforeAll(() => {
  patchDialogIfNeeded();
});

afterEach(() => {
  cleanup();
  _resetOverlaysForTests();
  vi.restoreAllMocks();
});

function View() {
  return (
    <ToastProvider>
      <LedgerProvider>
        <ReadyView />
      </LedgerProvider>
    </ToastProvider>
  );
}

function ReadyView() {
  const { status } = useLedger();
  return status === 'ready' ? <Accounts /> : null;
}

function q(dataUi: string): HTMLElement | null {
  return document.querySelector<HTMLElement>(`[data-ui="${dataUi}"]`);
}

async function renderReady() {
  render(<View />);
  await waitFor(() => {
    expect(q(UI.accounts.view)).toBeInTheDocument();
  });
}

/** 残高 0 の既定科目「チャージ残高」の終了確認を開く。 */
async function openArchiveConfirm(): Promise<HTMLElement> {
  fireEvent.click(await screen.findByRole('button', { name: '終了: チャージ残高' }));
  return await waitFor(() => {
    const found = q(UI.accounts.archiveConfirm);
    expect(found).toBeInTheDocument();
    return found!;
  });
}

describe('確認ダイアログの fail-closed（監査 A）', () => {
  it('保存境界の失敗ではダイアログを閉じず、再試行できる', async () => {
    await loadLedger();
    await renderReady();
    vi.spyOn(repository, 'archiveAccount').mockRejectedValueOnce(new Error('保存に失敗'));

    const confirm = await openArchiveConfirm();
    fireEvent.click(confirm.querySelector(`[data-ui="${UI.dialog.confirm}"]`)!);

    // 失敗: エラー toast + ダイアログは開いたまま + 何も保存されていない。
    await screen.findByText('保存に失敗');
    expect(q(UI.accounts.archiveConfirm)).toBeInTheDocument();
    expect((await loadLedger()).accounts.find((a) => a.name === 'チャージ残高')?.archived).toBe(
      false,
    );

    // 再試行（spy は 1 回だけ失敗）: 成功して閉じる。
    fireEvent.click(confirm.querySelector(`[data-ui="${UI.dialog.confirm}"]`)!);
    await waitFor(async () => {
      expect((await loadLedger()).accounts.find((a) => a.name === 'チャージ残高')?.archived).toBe(
        true,
      );
    });
    await waitFor(() => {
      expect(q(UI.accounts.archiveConfirm)).toBeNull();
    });
  });

  it('確定中は確定・キャンセルの両方を無効化する（二重実行防止）', async () => {
    await loadLedger();
    await renderReady();
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const spy = vi
      .spyOn(repository, 'archiveAccount')
      .mockImplementationOnce(async () => await gate);

    const confirm = await openArchiveConfirm();
    const confirmButton = confirm.querySelector<HTMLButtonElement>(
      `[data-ui="${UI.dialog.confirm}"]`,
    )!;
    const cancelButton = confirm.querySelector<HTMLButtonElement>(
      `[data-ui="${UI.dialog.cancel}"]`,
    )!;
    fireEvent.click(confirmButton);
    await waitFor(() => {
      expect(confirmButton).toBeDisabled();
      expect(cancelButton).toBeDisabled();
    });
    // 無効化中の連打は 2 回目の実行にならない。
    fireEvent.click(confirmButton);
    expect(spy).toHaveBeenCalledTimes(1);

    release();
    await waitFor(() => {
      expect(q(UI.accounts.archiveConfirm)).toBeNull();
    });
  });

  it('mutation 成功後の refresh 失敗は「未保存」に戻さない（二重実行を誘発しない）', async () => {
    await loadLedger();
    await renderReady();
    // archiveAccount は実物が成功し、その直後の再読込（loadLedger）だけが 1 回失敗する。
    vi.spyOn(repository, 'loadLedger').mockRejectedValueOnce(new Error('reload failed'));

    const confirm = await openArchiveConfirm();
    fireEvent.click(confirm.querySelector(`[data-ui="${UI.dialog.confirm}"]`)!);

    // 保存済みの警告 toast が出て、ダイアログは**閉じる**（再送させない）。
    await screen.findByText(
      '操作は完了しましたが、画面の再読込に失敗しました。画面を開き直してください。',
    );
    await waitFor(() => {
      expect(q(UI.accounts.archiveConfirm)).toBeNull();
    });
    expect((await loadLedger()).accounts.find((a) => a.name === 'チャージ残高')?.archived).toBe(
      true,
    );
  });
});
