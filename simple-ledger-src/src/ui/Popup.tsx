/*
 * 軽量ポップアップ（現在コンテキストのタップで開く小さな選択リスト用）。
 * Modal（大きなシート/ダイアログ）とは別物で、タイトル・閉じる・完了ボタンを持たない。
 *  - 背景タップ / Escape で閉じる。
 *  - 開いたら最初の要素へフォーカス、閉じたら呼び出し元へフォーカスを戻す。
 *  - アクセシブルネームは aria-label（視覚見出しは出さない）。
 * 用途: 期間の年/月ピッカーなど「現在の抽出条件を小さく出し、タップで切替」。
 */
import { useCallback, useEffect, useRef } from 'react';
import type { ReactNode } from 'react';

const FOCUSABLE =
  'a[href],button:not([disabled]),textarea,input,select,[tabindex]:not([tabindex="-1"])';

export function Popup({
  ariaLabel,
  onClose,
  children,
  dataUi,
}: {
  ariaLabel: string;
  onClose: () => void;
  children: ReactNode;
  dataUi?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const restoreRef = useRef<Element | null>(null);

  useEffect(() => {
    restoreRef.current = document.activeElement;
    const node = ref.current;
    const first = node?.querySelector<HTMLElement>(FOCUSABLE);
    (first ?? node)?.focus();
    return () => {
      if (restoreRef.current instanceof HTMLElement) restoreRef.current.focus();
    };
  }, []);

  const onKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
        return;
      }
      if (e.key !== 'Tab') return;
      const node = ref.current;
      if (!node) return;
      const items = Array.from(node.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
        (el) => el.offsetParent !== null || el === document.activeElement,
      );
      if (items.length === 0) return;
      const firstEl = items[0]!;
      const lastEl = items[items.length - 1]!;
      if (e.shiftKey && document.activeElement === firstEl) {
        e.preventDefault();
        lastEl.focus();
      } else if (!e.shiftKey && document.activeElement === lastEl) {
        e.preventDefault();
        firstEl.focus();
      }
    },
    [onClose],
  );

  return (
    <div
      className="popup-overlay"
      onPointerDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={ref}
        className="popup"
        role="dialog"
        aria-modal="true"
        aria-label={ariaLabel}
        tabIndex={-1}
        onKeyDown={onKeyDown}
        data-ui={dataUi}
      >
        {children}
      </div>
    </div>
  );
}
