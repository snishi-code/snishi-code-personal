// createAppHistory の popstate 優先順位 ①〜⑥ を jsdom で検証する。
// popstate は dispatchEvent で駆動し、history.back は spy で観測する。
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { createAppHistory, type AppHistory, type AppHistoryConfig } from './appHistory';

describe('createAppHistory', () => {
  let overlays: number;
  let editing: boolean;
  let exitConfirmOpen: boolean;
  let cfg: AppHistoryConfig & {
    renderView: ReturnType<typeof vi.fn>;
    closeTopOverlay: ReturnType<typeof vi.fn>;
    exitEdit: ReturnType<typeof vi.fn>;
    showExitConfirm: ReturnType<typeof vi.fn>;
  };
  let app: AppHistory;
  let backSpy: MockInstance<() => void>;

  const fire = (state: unknown) => window.dispatchEvent(new PopStateEvent('popstate', { state }));

  beforeEach(() => {
    overlays = 0;
    editing = false;
    exitConfirmOpen = false;
    backSpy = vi.spyOn(window.history, 'back').mockImplementation(() => {});
    cfg = {
      initialView: 'home',
      renderView: vi.fn<(view: string) => void>(),
      closeTopOverlay: vi.fn(() => {
        if (overlays > 0) {
          overlays--;
          return true;
        }
        return false;
      }),
      isEditing: () => editing,
      exitEdit: vi.fn(() => {
        editing = false;
      }),
      showExitConfirm: vi.fn(() => {
        exitConfirmOpen = true;
      }),
      isExitConfirmOpen: () => exitConfirmOpen,
    };
    app = createAppHistory(cfg);
    app.init();
  });

  afterEach(() => {
    app.dispose();
    backSpy.mockRestore();
  });

  it('init: guard の上に initialView を積む 2 層構成になる', () => {
    expect(history.state).toEqual({ view: 'home' });
    expect(app.currentView()).toBe('home');
  });

  it('pushView: 同一 view の連続 push を抑止する', () => {
    const len = history.length;
    app.pushView('detail');
    expect(history.length).toBe(len + 1);
    expect(history.state).toEqual({ view: 'detail' });
    app.pushView('detail');
    expect(history.length).toBe(len + 1); // dedup: 積み増さない
    expect(app.currentView()).toBe('detail');
  });

  it('優先順位 ③→④→⑥: overlay → 編集解除 → view 遷移 の順で Back を消費する', () => {
    app.pushView('detail');
    overlays = 1;
    editing = true;

    // Back 1 回目 (③): overlay を 1 つ閉じるだけ。view は detail のまま積み直し。
    fire({ view: 'home' });
    expect(cfg.closeTopOverlay).toHaveBeenCalledTimes(1);
    expect(cfg.exitEdit).not.toHaveBeenCalled();
    expect(cfg.renderView).not.toHaveBeenCalled();
    expect(history.state).toEqual({ view: 'detail' });
    expect(app.currentView()).toBe('detail');

    // Back 2 回目 (④): 編集だけ解除。view 遷移しない。
    fire({ view: 'home' });
    expect(cfg.exitEdit).toHaveBeenCalledTimes(1);
    expect(cfg.renderView).not.toHaveBeenCalled();
    expect(history.state).toEqual({ view: 'detail' });

    // Back 3 回目 (⑥): 通常 view 遷移。
    fire({ view: 'home' });
    expect(cfg.renderView).toHaveBeenCalledTimes(1);
    expect(cfg.renderView).toHaveBeenCalledWith('home');
    expect(app.currentView()).toBe('home');
  });

  it('⑤ guard 到達: initialView を積み直してから終了確認を出す', () => {
    fire({ __exitGuard: true });
    expect(history.state).toEqual({ view: 'home' }); // guard 上に留まらない
    expect(cfg.renderView).toHaveBeenCalledWith('home');
    expect(cfg.showExitConfirm).toHaveBeenCalledTimes(1);
    expect(exitConfirmOpen).toBe(true);
  });

  it('② 終了確認表示中の Back 連打は消費して確認を維持する (bypass 防止)', () => {
    fire({ __exitGuard: true }); // 終了確認を開く
    cfg.renderView.mockClear();

    fire({ __exitGuard: true }); // 連打で再び guard に落ちた状況
    fire({ __exitGuard: true });
    expect(cfg.showExitConfirm).toHaveBeenCalledTimes(1); // 再表示しない
    expect(cfg.renderView).not.toHaveBeenCalled();
    expect(history.state).toEqual({ view: 'home' }); // 積み直しのみ
    expect(backSpy).not.toHaveBeenCalled(); // 履歴外へ素通りしない
  });

  it('① beginExit: guard を 1 回だけ通過して履歴外へ抜ける', () => {
    fire({ __exitGuard: true }); // 終了確認を開く
    exitConfirmOpen = false; // アプリが確認 UI を閉じて「終了」を選んだ

    app.beginExit();
    expect(backSpy).toHaveBeenCalledTimes(1); // home → guard へ落ちる Back

    fire({ __exitGuard: true }); // back() の結果 guard に落ちた popstate
    expect(backSpy).toHaveBeenCalledTimes(2); // ① が guard を通過してさらに外へ
    expect(cfg.showExitConfirm).toHaveBeenCalledTimes(1); // 終了確認は再表示しない

    // フラグは 1 回で消える: 次の popstate は通常処理に戻る。
    fire({ view: 'home' });
    expect(backSpy).toHaveBeenCalledTimes(2);
    expect(cfg.renderView).toHaveBeenLastCalledWith('home');
  });

  it('⑥ state に view が無い popstate は initialView へフォールバックする', () => {
    fire(null);
    expect(cfg.renderView).toHaveBeenCalledWith('home');
  });

  it('dispose 後は popstate を処理しない', () => {
    app.dispose();
    fire({ view: 'memo' });
    expect(cfg.renderView).not.toHaveBeenCalled();
  });
});
