/*
 * 復旧画面（ErrorBoundary / RecoveryScreen）:
 *  - 「設定」への導線に加えて「DB を初期化して再起動」がある（VersionError 詰み対策・§10-0）
 *  - 初期化は確認ダイアログを挟み、確認後に deleteDatabase → reload
 */
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { patchDialogIfNeeded } from '@snishi/foundation/ui/test-utils';
import { RecoveryScreen } from '../src/ui/ErrorBoundary';
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

describe('復旧画面', () => {
  it('設定と「DB を初期化して再起動」の 2 導線を出す', () => {
    render(<RecoveryScreen message="boom" />);
    expect(document.querySelector(`[data-ui="${UI.app.recovery}"]`)).toBeInTheDocument();
    expect(document.querySelector(`[data-ui="${UI.app.recoverySettings}"]`)).toBeInTheDocument();
    expect(document.querySelector(`[data-ui="${UI.app.recoveryWipe}"]`)).toBeInTheDocument();
    expect(screen.getByText('boom')).toBeInTheDocument();
  });

  it('初期化は確認ダイアログを挟み、確認すると DB 削除後に再起動する', async () => {
    const reload = vi.fn();
    const original = window.location;
    Object.defineProperty(window, 'location', {
      configurable: true,
      value: { ...original, reload },
    });
    try {
      render(<RecoveryScreen />);
      fireEvent.click(document.querySelector(`[data-ui="${UI.app.recoveryWipe}"]`)!);
      const confirm = await waitFor(() => {
        const found = document.querySelector(`[data-ui="${UI.dialog.confirm}"]`);
        expect(found).toBeInTheDocument();
        return found!;
      });
      fireEvent.click(confirm);
      await waitFor(() => {
        expect(reload).toHaveBeenCalledTimes(1);
      });
    } finally {
      Object.defineProperty(window, 'location', { configurable: true, value: original });
    }
  });

  it('キャンセルすると何も起きない', async () => {
    const reload = vi.fn();
    const original = window.location;
    Object.defineProperty(window, 'location', {
      configurable: true,
      value: { ...original, reload },
    });
    try {
      render(<RecoveryScreen />);
      fireEvent.click(document.querySelector(`[data-ui="${UI.app.recoveryWipe}"]`)!);
      const cancel = await waitFor(() => {
        const found = document.querySelector(`[data-ui="${UI.dialog.cancel}"]`);
        expect(found).toBeInTheDocument();
        return found!;
      });
      fireEvent.click(cancel);
      expect(reload).not.toHaveBeenCalled();
    } finally {
      Object.defineProperty(window, 'location', { configurable: true, value: original });
    }
  });
});
