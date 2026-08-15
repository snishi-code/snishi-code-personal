/*
 * アプリのシェル（App.tsx）が status によらず守る不変則。
 *
 *  1. skip-link のアクセシブル名は**行き先を言う**（#main = 本文）。「ホーム」だと
 *     読み上げ名と実際の着地点が食い違い、支援技術の利用者だけ誤誘導される。
 *
 *  2. 端末 Back の終了確認は **loading / 復旧画面を含む全 status** で描画される。
 *     useAppHistory は台帳が読めたかに関係なく popstate を拾って showExitConfirm を
 *     呼ぶので、ダイアログの描画が早期 return より後ろにあると、その 2 状態だけ
 *     「確認なしで履歴の外へ抜ける」= fail-open になる。
 *     （描画順を早期 return の後ろへ戻すと 2 の loading / 復旧のケースが赤になる。）
 */
import { act } from 'react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { ToastProvider } from '@snishi/foundation/ui/toast';
import { patchDialogIfNeeded } from '@snishi/foundation/ui/test-utils';

// 起動時の読み込みだけを差し替えて loading / error の 2 状態を作る（repository の他は本物）。
const boot = vi.hoisted(() => ({ mode: 'real' as 'real' | 'pending' | 'reject' }));

vi.mock('../src/data/repository', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/data/repository')>();
  return {
    ...actual,
    loadLedger: async () => {
      // pending: 解決しない promise = status が 'loading' のまま留まる。
      if (boot.mode === 'pending') return new Promise<never>(() => {});
      if (boot.mode === 'reject') throw new Error('boom');
      return actual.loadLedger();
    },
  };
});

import { App } from '../src/App';
import { LedgerProvider } from '../src/state/store';
import { clearOnboardingDone, markOnboardingDone } from '../src/data/localFlags';
import { _resetOverlaysForTests } from '../src/ui/overlays';
import { UI } from '../src/ui-contract';
import { t } from '../src/i18n';
import './setup';

beforeAll(() => {
  patchDialogIfNeeded();
});

beforeEach(() => {
  boot.mode = 'real';
  markOnboardingDone();
  vi.spyOn(window.history, 'back').mockImplementation(() => {});
});

afterEach(() => {
  cleanup();
  _resetOverlaysForTests();
  clearOnboardingDone();
  vi.restoreAllMocks();
});

const q = (dataUi: string) => document.querySelector(`[data-ui="${dataUi}"]`);
const qAll = (dataUi: string) => document.querySelectorAll(`[data-ui="${dataUi}"]`);

function renderApp() {
  return render(
    <ToastProvider>
      <LedgerProvider>
        <App />
      </LedgerProvider>
    </ToastProvider>,
  );
}

/** 端末 Back の模擬（exit guard へ落ちた popstate）。 */
function back(): void {
  act(() => {
    window.dispatchEvent(new PopStateEvent('popstate', { state: { __exitGuard: true } }));
  });
}

describe('skip-link', () => {
  it('読み上げ名は行き先（本文）で、ホームではない', async () => {
    renderApp();
    await waitFor(() => expect(q(UI.dashboard.view)).toBeInTheDocument());

    const link = screen.getByRole('link', { name: t('a11y.skipToContent') });
    expect(link).toHaveClass('skip-link');
    // 行き先は本文（#main）。名前と着地点が一致していることが要点。
    expect(link).toHaveAttribute('href', '#main');
    expect(link).not.toHaveTextContent(t('common.home'));
    expect(document.querySelector('#main')).toBeInTheDocument();
  });
});

describe('終了確認は全 status で描画される', () => {
  it('通常（ready）: Back で終了確認が 1 つだけ出る', async () => {
    renderApp();
    await waitFor(() => expect(q(UI.dashboard.view)).toBeInTheDocument());

    back();
    await waitFor(() => expect(q(UI.app.exitConfirm)).toBeInTheDocument());
    // 早期 return 用と本文用で二重に描かない（dialog の重複を作らない）。
    expect(qAll(UI.app.exitConfirm)).toHaveLength(1);
  });

  it('loading（台帳の読み込み中）でも Back で終了確認が出る', async () => {
    boot.mode = 'pending';
    renderApp();
    await waitFor(() => {
      expect(document.querySelector('[aria-busy="true"]')).toBeInTheDocument();
    });
    expect(q(UI.dashboard.view)).not.toBeInTheDocument();

    back();
    await waitFor(() => expect(q(UI.app.exitConfirm)).toBeInTheDocument());
    expect(qAll(UI.app.exitConfirm)).toHaveLength(1);
  });

  it('復旧画面（起動失敗）でも Back で終了確認が出る', async () => {
    boot.mode = 'reject';
    renderApp();
    await waitFor(() => expect(q(UI.app.recovery)).toBeInTheDocument());
    expect(q(UI.dashboard.view)).not.toBeInTheDocument();

    back();
    await waitFor(() => expect(q(UI.app.exitConfirm)).toBeInTheDocument());
    expect(qAll(UI.app.exitConfirm)).toHaveLength(1);
    // 復旧画面は消えない（終了確認は上に重なるだけ）。
    expect(q(UI.app.recovery)).toBeInTheDocument();
  });
});
