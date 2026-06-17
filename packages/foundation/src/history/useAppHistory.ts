// 移植元: snishi-code-medical/hospital-rounds/src/features/app-history.js (createAppHistory の React アダプタ)
import { useCallback, useEffect, useRef, useState } from 'react';
import { createAppHistory, type AppHistory } from './appHistory';

export interface UseAppHistoryOptions {
  initialView: string;
  closeTopOverlay?: () => boolean;
  isEditing?: () => boolean;
  exitEdit?: () => void;
  showExitConfirm?: () => void;
  isExitConfirmOpen?: () => boolean;
}

export interface UseAppHistoryResult {
  view: string;
  navigate: (view: string) => void;
  beginExit: () => void;
}

/**
 * createAppHistory を React state と同期させる。Back での view 復帰は
 * renderView → setState 経由で反映される。
 */
export function useAppHistory(opts: UseAppHistoryOptions): UseAppHistoryResult {
  const [view, setView] = useState(opts.initialView);
  const optsRef = useRef(opts);
  const historyRef = useRef<AppHistory | null>(null);

  // popstate は render 外で発火するため、callback は毎 render ref へ反映して
  // stale closure を避ける (依存配列での再 init は履歴 stack を壊すので不可)。
  useEffect(() => {
    optsRef.current = opts;
  });

  useEffect(() => {
    const h = createAppHistory({
      initialView: optsRef.current.initialView,
      renderView: (v) => setView(v),
      closeTopOverlay: () => optsRef.current.closeTopOverlay?.() ?? false,
      isEditing: () => optsRef.current.isEditing?.() ?? false,
      exitEdit: () => optsRef.current.exitEdit?.(),
      showExitConfirm: () => optsRef.current.showExitConfirm?.(),
      isExitConfirmOpen: () => optsRef.current.isExitConfirmOpen?.() ?? false,
    });
    h.init();
    historyRef.current = h;
    return () => {
      h.dispose();
      historyRef.current = null;
    };
  }, []);

  const navigate = useCallback((v: string) => {
    historyRef.current?.pushView(v);
    setView(v);
  }, []);

  const beginExit = useCallback(() => {
    historyRef.current?.beginExit();
  }, []);

  return { view, navigate, beginExit };
}
