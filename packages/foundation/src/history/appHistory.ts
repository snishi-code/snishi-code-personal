// 移植元: snishi-code-medical/hospital-rounds/src/features/app-history.js (患者/フォーマット知識を hook 注入に汎用化)

export interface AppHistoryConfig {
  initialView: string;
  renderView: (view: string) => void;
  /** 最前面の一時 overlay を 1 つ閉じたら true */
  closeTopOverlay: () => boolean;
  /** アプリ内編集モード中か */
  isEditing: () => boolean;
  /** 編集モードだけ解除 (view 遷移はしない) */
  exitEdit: () => void;
  /** 終了確認 UI を表示する */
  showExitConfirm: () => void;
  isExitConfirmOpen: () => boolean;
}

export interface AppHistory {
  init(): void;
  pushView(view: string): void;
  currentView(): string | null;
  beginExit(): void;
  dispose(): void;
}

interface HistoryState {
  view?: unknown;
  __exitGuard?: unknown;
}

/**
 * 端末の「戻る」操作を view 遷移・一時 overlay・編集モード・終了確認まで一貫制御する。
 * history 操作はここに集約し、アプリは hook (cfg) で自分の状態だけ答える。
 */
export function createAppHistory(cfg: AppHistoryConfig): AppHistory {
  // 終了確認 OK 後、guard を 1 回だけ通過して履歴の外へ抜けるためのフラグ。
  let exiting = false;
  let current: string | null = null;
  let listening = false;

  // 戻る操作を「消費」して現在 view の履歴エントリを積み直す (画面遷移させない)。
  const reconsume = () => {
    history.pushState({ view: current ?? cfg.initialView }, '', '');
  };

  function onPopState(e: PopStateEvent): void {
    // ① 終了処理中: guard を通過して履歴の外へ抜ける (beginExit 後の 1 回だけ)。
    if (exiting) {
      exiting = false;
      history.back();
      return;
    }
    // ② 終了確認表示中の Back は消費して確認を維持 (連打で guard を素通りさせて
    //    確認なしに離脱させない = HR 修正#2)。
    if (cfg.isExitConfirmOpen()) {
      history.pushState({ view: cfg.initialView }, '', '');
      return;
    }
    // ③ 最前面の一時 overlay を 1 つだけ閉じ、消費した Back の分を積み直す。
    if (cfg.closeTopOverlay()) {
      reconsume();
      return;
    }
    // ④ 編集モードは view 遷移せず編集だけ抜ける (編集が active な間は Back 1 回 = 編集破棄。
    //    遷移と同時に破棄すると未保存ドラフトが黙って消える = HR 修正#3)。
    if (cfg.isEditing()) {
      cfg.exitEdit();
      reconsume();
      return;
    }
    const st = (e.state ?? {}) as HistoryState;
    // ⑤ guard 到達 = initialView で Back。guard 上に留まると次の Back で確認なしに
    //    履歴外へ抜けるため、initialView を積み直してから終了確認を出す (= HR 修正#2)。
    if (st.__exitGuard) {
      history.pushState({ view: cfg.initialView }, '', '');
      current = cfg.initialView;
      cfg.renderView(cfg.initialView);
      cfg.showExitConfirm();
      return;
    }
    // ⑥ 通常 view 遷移。
    const v = typeof st.view === 'string' && st.view ? st.view : cfg.initialView;
    current = v;
    cfg.renderView(v);
  }

  return {
    init(): void {
      // exit-guard 2 層: 最下層 __exitGuard + その上 initialView。initialView で Back
      // すると guard に当たり、⑤ が終了確認を出す。
      history.replaceState({ __exitGuard: true }, '', '');
      history.pushState({ view: cfg.initialView }, '', '');
      current = cfg.initialView;
      if (!listening) {
        window.addEventListener('popstate', onPopState);
        listening = true;
      }
    },
    pushView(view: string): void {
      current = view;
      // 同一 view の連続 push を抑止 (積み増すと Back が同じ画面への「空振り」になる)。
      const st = history.state as HistoryState | null;
      if (st && st.view === view) return;
      history.pushState({ view }, '', '');
    },
    currentView(): string | null {
      return current;
    },
    beginExit(): void {
      // 終了確認で「終了」選択時: Back で guard へ落ち、① が guard を通過して履歴外へ。
      exiting = true;
      history.back();
    },
    dispose(): void {
      if (listening) {
        window.removeEventListener('popstate', onPopState);
        listening = false;
      }
    },
  };
}
