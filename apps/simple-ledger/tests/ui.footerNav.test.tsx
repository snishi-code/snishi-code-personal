/*
 * 画面下端の固定ナビ（左 = 戻る / 中央 = ホーム / 右 = メニュー）。
 *
 * 要点は 3 つ:
 *  1. **data-ui が画面内で一意**であること。フッターへボタンを増やしたとき、ヘッダーと同じ
 *     data-ui を再利用すると Playwright の strict mode で E2E が全滅する。ここで前倒しに落とす。
 *  2. 戻るは window.history.back() を**呼ぶだけ**。overlay を閉じる → dirty guard → 画面履歴 →
 *     終了確認、の順序は useAppHistory の中央制御が持つ（app 側に分岐を複製しない）。
 *  3. ヘッダー右はハンバーガーから設定へ替わり、ハンバーガーはフッターへ**移設**された
 *     （複製ではない = 同じ data-ui が 2 つ出ない）。
 */
import { describe, it, expect, afterEach, beforeAll, beforeEach, vi } from 'vitest';
import type { MockInstance } from 'vitest';
import { render, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { ToastProvider } from '@snishi/foundation/ui/toast';
import { patchDialogIfNeeded } from '@snishi/foundation/ui/test-utils';
import { App } from '../src/App';
import { LedgerProvider } from '../src/state/store';
import { clearOnboardingDone, markOnboardingDone } from '../src/data/localFlags';
import { _resetOverlaysForTests } from '../src/ui/overlays';
import { UI } from '../src/ui-contract';
import './setup';

beforeAll(() => {
  patchDialogIfNeeded();
});

let backSpy: MockInstance<() => void>;

beforeEach(() => {
  markOnboardingDone();
  backSpy = vi.spyOn(window.history, 'back').mockImplementation(() => {});
});

afterEach(() => {
  cleanup();
  _resetOverlaysForTests();
  clearOnboardingDone();
  backSpy.mockRestore();
});

const q = (dataUi: string) => document.querySelector(`[data-ui="${dataUi}"]`);

async function renderApp() {
  const view = render(
    <ToastProvider>
      <LedgerProvider>
        <App />
      </LedgerProvider>
    </ToastProvider>,
  );
  await waitFor(() => {
    expect(q(UI.dashboard.view)).toBeInTheDocument();
  });
  return view;
}

/** 画面内で重複している data-ui（Playwright の strict mode が落ちる条件）。 */
function duplicatedDataUi(): string[] {
  const keys = [...document.querySelectorAll('[data-ui]')].map((e) => e.getAttribute('data-ui')!);
  return [...new Set(keys.filter((k, i) => keys.indexOf(k) !== i))];
}

describe('フッターナビ', () => {
  it('3 ボタンが出て、data-ui は画面内で一意（ヘッダーと値を共有しない）', async () => {
    await renderApp();

    expect(q(UI.nav.footer)).toBeInTheDocument();
    expect(q(UI.nav.footerBack)).toBeInTheDocument();
    expect(q(UI.nav.footerHome)).toBeInTheDocument();
    expect(q(UI.nav.menuButton)).toBeInTheDocument();
    // ヘッダー左のホームとフッター中央のホームは別キー（重複させない）。
    expect(UI.nav.home).not.toBe(UI.nav.footerHome);
    expect(duplicatedDataUi()).toEqual([]);
  });

  it('メニューを開いても data-ui は一意のまま（ヘッダー右の設定とメニュー項目が衝突しない）', async () => {
    await renderApp();
    fireEvent.click(q(UI.nav.menuButton)!);
    await waitFor(() => expect(q(UI.nav.menu)).toBeInTheDocument());

    // メニュー項目の 'nav.settings' とヘッダー右の 'nav.settings.button' は別キー。
    expect(UI.nav.settingsButton).not.toBe('nav.settings');
    expect(duplicatedDataUi()).toEqual([]);
  });

  it('戻るは window.history.back() を呼ぶだけ（app 側で画面を切り替えない）', async () => {
    await renderApp();
    fireEvent.click(q(UI.nav.footerBack)!);

    expect(backSpy).toHaveBeenCalledTimes(1);
    // 端末ジェスチャと同じ経路に委ねる＝この時点では画面は変わらない（popstate で変わる）。
    expect(q(UI.dashboard.view)).toBeInTheDocument();
  });

  it('ホームで戻るを押しても disabled にせず、同じ経路へ委ねる（ジェスチャと意味を割らない）', async () => {
    await renderApp();
    const back = q(UI.nav.footerBack) as HTMLButtonElement;
    expect(back).not.toBeDisabled();
    fireEvent.click(back);
    expect(backSpy).toHaveBeenCalledTimes(1);
  });

  it('中央のホームは他画面から dashboard へ戻し、現在地には aria-current が付く', async () => {
    await renderApp();
    expect(q(UI.nav.footerHome)).toHaveAttribute('aria-current', 'page');

    fireEvent.click(q(UI.nav.menuButton)!);
    await waitFor(() => expect(q(UI.nav.menu)).toBeInTheDocument());
    fireEvent.click(q('nav.accounts')!);
    await waitFor(() => expect(q(UI.accounts.view)).toBeInTheDocument());
    // 他画面では現在地マークが外れる。
    expect(q(UI.nav.footerHome)).not.toHaveAttribute('aria-current');

    fireEvent.click(q(UI.nav.footerHome)!);
    await waitFor(() => expect(q(UI.dashboard.view)).toBeInTheDocument());
  });

  it('ヘッダー右は設定へ直行する（ハンバーガーはフッターへ移設済み）', async () => {
    await renderApp();
    const settings = q(UI.nav.settingsButton) as HTMLButtonElement;
    expect(settings).toHaveAccessibleName('設定');

    fireEvent.click(settings);
    await waitFor(() => expect(q(UI.settings.view)).toBeInTheDocument());
    // フッターは画面が変わっても出続ける（常設ナビ）。
    expect(q(UI.nav.footer)).toBeInTheDocument();
  });
});
