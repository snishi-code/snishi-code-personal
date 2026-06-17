/*
 * native <dialog> + top-layer のモーダル土台(Modal / Popup が共有)。
 * フォーカストラップ・Escape(cancel イベント)・重なり順はネイティブに任せ、
 * z-index の手動管理をしない。閉じたときのフォーカス復元だけ自前で行う。
 *
 * dismissMode(閉じ方の統一):
 *  - 'always':   背景タップ / Escape で閉じる(メニュー・ヘルプ・軽い選択)。
 *  - 'if-clean': 機構は always と同じ。「未編集なら閉じる」は呼び出し側が
 *                useDirtyGuard の requestClose を onClose に渡すことで成立する。
 *  - 'never':    破壊的操作。cancel を preventDefault し背景タップでも閉じない。
 *
 * 自動フォーカス抑止(HR popup-behavior.js の方針): 開いただけでは入力欄へ
 * focus しない(モバイルでキーボードが勝手に出るのを防ぐ)。showModal 後に
 * dialog 自体へフォーカスを当て、入力はユーザーの明示タップを待つ。
 */
import { useEffect, useRef } from 'react';
import type { ReactNode } from 'react';

export type DismissMode = 'always' | 'if-clean' | 'never';

export function ModalBase({
  className,
  onClose,
  dismissMode = 'always',
  children,
  ariaLabel,
  ariaLabelledby,
  dataUi,
  scrollKey,
}: {
  className: string;
  onClose: () => void;
  dismissMode?: DismissMode;
  children: ReactNode;
  ariaLabel?: string;
  ariaLabelledby?: string;
  dataUi?: string;
  /** 指定した値が変わるたび、スクロール位置を先頭へ戻す。 */
  scrollKey?: unknown;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const restoreRef = useRef<Element | null>(null);
  const unmountingRef = useRef(false);
  const allowDismiss = dismissMode !== 'never';

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    restoreRef.current = document.activeElement;
    dialog.showModal();
    // 開いただけでは入力欄へ自動フォーカスしない。dialog 自体(tabIndex=-1)に当てる。
    dialog.focus();
    return () => {
      // ここで閉じるのは React の unmount 経由。onClose の二重発火を防ぐ。
      unmountingRef.current = true;
      if (dialog.open) dialog.close();
      const prev = restoreRef.current;
      if (prev instanceof HTMLElement && prev.isConnected) prev.focus();
    };
  }, []);

  useEffect(() => {
    if (scrollKey === undefined) return;
    const dialog = ref.current;
    if (!dialog) return;
    if (typeof dialog.scrollTo === 'function') dialog.scrollTo({ top: 0 });
    else dialog.scrollTop = 0;
  }, [scrollKey]);

  return (
    <dialog
      ref={ref}
      className={className}
      aria-label={ariaLabel}
      aria-labelledby={ariaLabelledby}
      tabIndex={-1}
      data-ui={dataUi}
      onCancel={(e) => {
        // 開閉の正本は React 側(マウント有無)。native close は常に抑止し、
        // 閉じてよいときだけ onClose で unmount してもらう。
        e.preventDefault();
        if (allowDismiss) onClose();
      }}
      onClose={() => {
        // form method="dialog" やブラウザの強制クローズで閉じた場合も状態を同期する。
        if (!unmountingRef.current) onClose();
      }}
      onClick={(e) => {
        if (!allowDismiss) return;
        // backdrop は dialog 自身の click として届く。内部要素からの伝播では閉じない。
        if (e.target !== e.currentTarget) return;
        const r = e.currentTarget.getBoundingClientRect();
        const inside =
          e.clientX >= r.left &&
          e.clientX <= r.right &&
          e.clientY >= r.top &&
          e.clientY <= r.bottom;
        // 矩形内(dialog の余白等)のクリックは背景扱いにしない。
        if (!inside) onClose();
      }}
    >
      {children}
    </dialog>
  );
}
