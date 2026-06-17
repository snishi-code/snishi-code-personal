/*
 * Sheet / Modal(タイトル付きの標準モーダル)。土台は native <dialog>(ModalBase)。
 * 閉じ方は dismissMode で統一する(always / if-clean / never。詳細は ModalBase)。
 */
import { useId } from 'react';
import type { ReactNode } from 'react';
import { ModalBase } from './ModalBase';
import type { DismissMode } from './ModalBase';
import { Icon } from './Icon';
import { IconButton } from './IconButton';

export type { DismissMode };

export function Modal({
  title,
  onClose,
  children,
  footer,
  dismissMode = 'always',
  variant = 'sheet',
  titleVariant = 'visible',
  scrollKey,
  dataUi,
  closeLabel = '閉じる',
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  dismissMode?: DismissMode;
  /** sheet=モバイルは下部シート / dialog=常に中央カード(メニュー・確認・フォーム)。 */
  variant?: 'sheet' | 'dialog';
  /**
   * 見出しの見せ方。'sr-only' は視覚的に隠しつつ aria 上の名前(aria-labelledby)は
   * 維持する。自明な非破壊ポップアップで使う。判断が要るダイアログは 'visible'。
   */
  titleVariant?: 'visible' | 'sr-only';
  /** 指定した値が変わるたび、シート本体のスクロールを先頭へ戻す。 */
  scrollKey?: unknown;
  dataUi?: string;
  /** 閉じるボタンの aria-label(i18n はアプリ側の責務)。 */
  closeLabel?: string;
}) {
  const titleId = useId();
  return (
    <ModalBase
      className={`sheet${variant === 'dialog' ? ' dialog' : ''}`}
      onClose={onClose}
      dismissMode={dismissMode}
      ariaLabelledby={titleId}
      dataUi={dataUi}
      scrollKey={scrollKey}
    >
      <div className="sheet__header">
        <h2 className={`sheet__title${titleVariant === 'sr-only' ? ' sr-only' : ''}`} id={titleId}>
          {title}
        </h2>
        <IconButton
          label={closeLabel}
          onClick={onClose}
          // 見出しを視覚的に隠したときは閉じるボタンを右端へ寄せる。
          style={titleVariant === 'sr-only' ? { marginLeft: 'auto' } : undefined}
        >
          <Icon name="close" size={20} />
        </IconButton>
      </div>
      <div className="sheet__body">{children}</div>
      {footer ? <div className="sheet__footer">{footer}</div> : null}
    </ModalBase>
  );
}
