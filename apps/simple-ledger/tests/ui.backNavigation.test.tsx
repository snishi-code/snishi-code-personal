/*
 * 端末/ブラウザ Back の中央制御（App + useAppHistory + overlays 登録簿）の統合テスト。
 * popstate は foundation useAppHistory.test.ts と同じく PopStateEvent を直接 dispatch して模擬する。
 * 優先順位: 最前面 overlay → 画面履歴 → dashboard の終了確認。
 */
import { act } from 'react';
import { describe, it, expect, afterEach, beforeAll, beforeEach, vi } from 'vitest';
import type { MockInstance } from 'vitest';
import { render, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { ToastProvider } from '@snishi/foundation/ui/toast';
import { patchDialogIfNeeded } from '@snishi/foundation/ui/test-utils';
import { App } from '../src/App';
import { LedgerProvider } from '../src/state/store';
import { clearOnboardingDone, markOnboardingDone } from '../src/data/localFlags';
import { _resetOverlaysForTests } from '../src/ui/overlays';
import './setup';

beforeAll(() => {
  patchDialogIfNeeded();
});

let backSpy: MockInstance<() => void>;

beforeEach(() => {
  // オンボーディング自動表示を止める（onboarding 専用テストは ui.onboarding 側）。
  markOnboardingDone();
  backSpy = vi.spyOn(window.history, 'back').mockImplementation(() => {});
});

afterEach(() => {
  cleanup();
  _resetOverlaysForTests();
  clearOnboardingDone();
  backSpy.mockRestore();
});

function q(dataUi: string): Element | null {
  return document.querySelector(`[data-ui="${dataUi}"]`);
}

async function renderApp() {
  const view = render(
    <ToastProvider>
      <LedgerProvider>
        <App />
      </LedgerProvider>
    </ToastProvider>,
  );
  await waitFor(() => {
    expect(q('dashboard.view')).toBeInTheDocument();
  });
  return view;
}

function back(state: unknown): void {
  act(() => {
    window.dispatchEvent(new PopStateEvent('popstate', { state }));
  });
}

describe('Back の中央制御', () => {
  it('開いている overlay（メニュー）を Back が 1 つ閉じ、画面は変わらない', async () => {
    await renderApp();
    fireEvent.click(q('nav.menu.button')!);
    expect(q('nav.menu')).toBeInTheDocument();

    back({ __exitGuard: true }); // 履歴上どこへ落ちても overlay が先に拾う
    await waitFor(() => {
      expect(q('nav.menu')).not.toBeInTheDocument();
    });
    expect(q('dashboard.view')).toBeInTheDocument();
    expect(q('app.exitConfirm')).not.toBeInTheDocument();
  });

  it('画面遷移後の Back は前の画面へ戻る', async () => {
    await renderApp();
    fireEvent.click(q('nav.menu.button')!);
    fireEvent.click(q('nav.settings')!);
    await waitFor(() => {
      expect(q('settings.view')).toBeInTheDocument();
    });

    back({ view: 'dashboard' });
    await waitFor(() => {
      expect(q('dashboard.view')).toBeInTheDocument();
    });
    expect(q('settings.view')).not.toBeInTheDocument();
  });

  it('dashboard で overlay なしの Back は終了確認を出し、キャンセルで留まる', async () => {
    await renderApp();
    back({ __exitGuard: true });
    await waitFor(() => {
      expect(q('app.exitConfirm')).toBeInTheDocument();
    });

    fireEvent.click(q('app.exitConfirm')!.querySelector('[data-ui="dialog.cancel"]')!);
    await waitFor(() => {
      expect(q('app.exitConfirm')).not.toBeInTheDocument();
    });
    expect(q('dashboard.view')).toBeInTheDocument();
    expect(backSpy).not.toHaveBeenCalled();
  });

  it('終了確認で「終了する」を選ぶと beginExit（history.back）が走る', async () => {
    await renderApp();
    back({ __exitGuard: true });
    await waitFor(() => {
      expect(q('app.exitConfirm')).toBeInTheDocument();
    });

    fireEvent.click(q('app.exitConfirm')!.querySelector('[data-ui="dialog.confirm"]')!);
    await waitFor(() => {
      expect(q('app.exitConfirm')).not.toBeInTheDocument();
    });
    expect(backSpy).toHaveBeenCalled();
  });
});
