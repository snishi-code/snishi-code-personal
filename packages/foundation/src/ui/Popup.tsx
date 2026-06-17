/*
 * 軽量ポップアップ(現在コンテキストのタップで開く小さな選択リスト用)。
 * Modal(大きなシート/ダイアログ)とは別物で、タイトル・閉じる・完了ボタンを持たない。
 * 土台は native <dialog>(ModalBase): 背景タップ / Escape で閉じる(既定 'always')。
 * アクセシブルネームは aria-label(視覚見出しは出さない)。
 * 開いただけでは自動フォーカスしない(ModalBase が担保)。
 */
import type { ReactNode } from 'react';
import { ModalBase } from './ModalBase';
import type { DismissMode } from './ModalBase';

export function Popup({
  ariaLabel,
  onClose,
  children,
  dismissMode = 'always',
  dataUi,
}: {
  ariaLabel: string;
  onClose: () => void;
  children: ReactNode;
  dismissMode?: DismissMode;
  dataUi?: string;
}) {
  return (
    <ModalBase
      className="popup"
      onClose={onClose}
      dismissMode={dismissMode}
      ariaLabel={ariaLabel}
      dataUi={dataUi}
    >
      {children}
    </ModalBase>
  );
}
