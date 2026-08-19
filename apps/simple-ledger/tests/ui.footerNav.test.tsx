/*
 * 画面下端の固定ナビ（左 = 戻る / 中央 = ホーム / 右 = メニュー）。
 *
 * 要点は 3 つ:
 *  1. **data-ui が画面内で一意**であること。フッターへボタンを増やしたとき、ヘッダーと同じ
 *     data-ui を再利用すると Playwright の strict mode で E2E が全滅する。ここで前倒しに落とす。
 *  2. 戻るは window.history.back() を**呼ぶだけ**。overlay を閉じる → dirty guard → 画面履歴 →
 *     終了確認、の順序は useAppHistory の中央制御が持つ（app 側に分岐を複製しない）。
 *  3. ホーム = フッター中央 / 設定 = メニュー内 / ハンバーガー = フッター右、が**唯一の置き場所**。
 *     ヘッダーは時間（日付 + 日/月/年のズーム）だけに徹する（同じ意味のボタンを 2 つ出さない）。
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

/**
 * 画面内で重複しているナビ系 data-ui（Playwright の strict mode が落ちる条件）。
 * 検査対象を nav.* に絞るのは、一覧の行など**設計上重複してよいキー**があるため
 * （全 data-ui を対象にすると、無関係な画面の変更でこのテストが落ちる）。
 */
function duplicatedNavDataUi(): string[] {
  const keys = [...document.querySelectorAll('[data-ui^="nav."]')].map(
    (e) => e.getAttribute('data-ui')!,
  );
  return [...new Set(keys.filter((k, i) => keys.indexOf(k) !== i))];
}

describe('フッターナビ', () => {
  it('3 ボタンが出て、data-ui は画面内で一意（ヘッダーと値を共有しない）', async () => {
    await renderApp();

    expect(q(UI.nav.footer)).toBeInTheDocument();
    expect(q(UI.nav.footerBack)).toBeInTheDocument();
    expect(q(UI.nav.footerHome)).toBeInTheDocument();
    expect(q(UI.nav.menuButton)).toBeInTheDocument();
    // ホームはフッター中央が唯一。ヘッダー左のホームは撤去済み（重複を作らない）。
    expect(document.querySelector('[data-ui="nav.home"]')).toBeNull();
    expect(duplicatedNavDataUi()).toEqual([]);
  });

  it('メニューを開いても data-ui は一意のまま', async () => {
    await renderApp();
    fireEvent.click(q(UI.nav.menuButton)!);
    await waitFor(() => expect(q(UI.nav.menu)).toBeInTheDocument());

    // 設定はメニュー項目の 'nav.settings' が唯一。ヘッダー右の設定ボタンは撤去済み。
    expect(document.querySelector('[data-ui="nav.settings.button"]')).toBeNull();
    expect(duplicatedNavDataUi()).toEqual([]);
  });

  it('戻るは window.history.back() を呼ぶだけ（app 側で画面を切り替えない）', async () => {
    await renderApp();
    // **ホーム以外**で押す。dashboard で押すと「画面が変わらない」は実装が何をしても真になり、
    // アサーションが原理的に落ちない（＝偽緑）ため。
    fireEvent.click(q(UI.nav.menuButton)!);
    await waitFor(() => expect(q(UI.nav.menu)).toBeInTheDocument());
    fireEvent.click(q('nav.settings')!);
    await waitFor(() => expect(q(UI.settings.view)).toBeInTheDocument());

    fireEvent.click(q(UI.nav.footerBack)!);
    expect(backSpy).toHaveBeenCalledTimes(1);
    // popstate を撃たない限り画面は動かない＝Back の意味論を app 側へ複製していない。
    expect(q(UI.settings.view)).toBeInTheDocument();
    expect(q(UI.dashboard.view)).not.toBeInTheDocument();
  });

  it('戻るは overlay を先に閉じる（画面は変わらない・中央制御に委ねている証拠）', async () => {
    // spy を張らずに本物の history.back() を通し、useAppHistory の順序制御まで見る。
    backSpy.mockRestore();
    await renderApp();
    fireEvent.click(q(UI.nav.menuButton)!);
    await waitFor(() => expect(q(UI.nav.menu)).toBeInTheDocument());

    fireEvent.click(q(UI.nav.footerBack)!);
    await waitFor(() => expect(q(UI.nav.menu)).not.toBeInTheDocument());
    // overlay が閉じただけで画面は据え置き（overlay → 画面履歴 の優先順）。
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

  it('ヘッダーのズームで時間平面へ入れる（設定はメニュー内が唯一）', async () => {
    await renderApp();

    fireEvent.click(q(UI.period.zoomYear)!);
    await waitFor(() => expect(q(UI.timeline.view)).toBeInTheDocument());
    expect(q(UI.period.zoomYear)).toHaveAttribute('aria-pressed', 'true');

    // 既に時間平面なら目盛りだけ替わる（画面は動かない）。
    fireEvent.click(q(UI.period.zoomMonth)!);
    await waitFor(() => expect(q(UI.period.zoomMonth)).toHaveAttribute('aria-pressed', 'true'));
    expect(q(UI.timeline.view)).toBeInTheDocument();
    expect(q(UI.period.zoomYear)).toHaveAttribute('aria-pressed', 'false');

    // ヘッダーにはホームも設定も無い（フッター中央とメニュー内が唯一の置き場所）。
    expect(document.querySelector('[data-ui="nav.settings.button"]')).toBeNull();
    expect(document.querySelector('[data-ui="nav.home"]')).toBeNull();
    // フッターは画面が変わっても出続ける（常設ナビ）。
    expect(q(UI.nav.footer)).toBeInTheDocument();
  });
});
