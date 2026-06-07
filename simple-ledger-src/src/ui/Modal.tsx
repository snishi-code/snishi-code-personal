/*
 * Sheet/Modal の共通土台。
 * 閉じ方は dismissMode で統一する:
 *  - 'always': メニュー/ヘルプ/軽い選択。背景タップ/Escape で閉じる。
 *  - 'if-clean': 入力フォーム。未編集なら閉じ、編集済みは破棄確認（onClose を useDirtyGuard で包む）。
 *  - 'never':   削除/全削除/import/復元など破壊的操作。背景タップ/Escape で閉じない。
 * 背景タップ判定は onPointerDown かつ target===currentTarget のときだけ（内部タップでは閉じない）。
 * Escape はキャンセル相当（onClose）。フォーカストラップと復帰を行う。
 */
import { useCallback, useEffect, useId, useRef } from 'react';
import type { ReactNode } from 'react';
import { Icon } from './Icon';
import { t } from '../i18n';

const FOCUSABLE =
  'a[href],button:not([disabled]),textarea,input,select,[tabindex]:not([tabindex="-1"])';

export type DismissMode = 'always' | 'if-clean' | 'never';

export function Modal({
  title,
  onClose,
  children,
  footer,
  dismissable,
  dismissMode,
  variant = 'sheet',
  titleVariant = 'visible',
  dataUi,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  /** @deprecated dismissMode を使う。false は 'never' 相当（後方互換）。 */
  dismissable?: boolean;
  dismissMode?: DismissMode;
  variant?: 'sheet' | 'dialog';
  /**
   * 見出しの見せ方。'sr-only' は視覚的に隠しつつ aria 上の名前（aria-labelledby）は維持する。
   * 入力フォームやメニューなど自明な非破壊ポップアップで使う。判断が要るダイアログは 'visible'。
   */
  titleVariant?: 'visible' | 'sr-only';
  dataUi?: string;
}) {
  // 後方互換: dismissMode 未指定なら dismissable から導出（既定は 'always'）。
  const mode: DismissMode = dismissMode ?? (dismissable === false ? 'never' : 'always');
  const allowOutsideClose = mode !== 'never';
  const ref = useRef<HTMLDivElement>(null);
  const titleId = useId();
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
        if (allowOutsideClose) onClose();
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
    [onClose, allowOutsideClose],
  );

  return (
    <div
      className="sheet-overlay"
      onPointerDown={(e) => {
        // 背景（オーバーレイ自身）を直接押したときだけ閉じる。内部要素からの伝播では閉じない。
        if (allowOutsideClose && e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={ref}
        className={`sheet ${variant === 'dialog' ? 'dialog' : ''}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        onKeyDown={onKeyDown}
        data-ui={dataUi}
      >
        <div className="sheet__header">
          <h2
            className={`sheet__title${titleVariant === 'sr-only' ? ' sr-only' : ''}`}
            id={titleId}
          >
            {title}
          </h2>
          <button
            type="button"
            className="icon-btn"
            onClick={onClose}
            aria-label={t('a11y.closeDialog')}
            // 見出しを視覚的に隠したときは閉じるボタンを右端へ寄せる。
            style={titleVariant === 'sr-only' ? { marginLeft: 'auto' } : undefined}
          >
            <Icon name="close" />
          </button>
        </div>
        <div className="sheet__body">{children}</div>
        {footer ? <div className="sheet__footer">{footer}</div> : null}
      </div>
    </div>
  );
}
