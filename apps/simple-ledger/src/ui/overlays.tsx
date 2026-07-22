/*
 * 戻る (popstate) 制御のためのオーバーレイ登録簿と、登録を内蔵した foundation UI ラッパー。
 *
 * hospital-workspace の registries.ts と同型のモジュールレベル登録簿。foundation
 * history/useAppHistory の closeTopOverlay に配線するため、開いている一時 overlay を
 * ここで一元追跡する（最前面 = 最後に開いたもの を 1 つだけ閉じる）。
 *
 * アプリ内の Modal / Popup / Menu / ConfirmDialog / useDirtyGuard は foundation から
 * 直接ではなく本ファイルの同名ラッパーを import する（マウント中だけ自動登録される）。
 * 例外は App.tsx の終了確認ダイアログのみ: appHistory が isExitConfirmOpen で先に
 * 消費するため、登録簿に載せない（foundation ConfirmDialog を直接使う）。
 *
 * simple-ledger は単一ユーザー・インライン編集モードなしのため、medical 版にある
 * editing 登録簿は持たない（EntrySheet 等の編集は overlay + dirty guard で完結する）。
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { ComponentProps, ReactNode } from 'react';
import { Modal as FoundationModal } from '@snishi/foundation/ui/Modal';
import { Popup as FoundationPopup } from '@snishi/foundation/ui/Popup';
import { Menu as FoundationMenu } from '@snishi/foundation/ui/Menu';
import { ConfirmDialog as FoundationConfirmDialog } from '@snishi/foundation/ui/ConfirmDialog';
import { t } from '../i18n';

export type { DismissMode } from '@snishi/foundation/ui/Modal';
export type { MenuItem } from '@snishi/foundation/ui/Menu';

interface OverlayEntry {
  close: () => void;
}

const overlays: OverlayEntry[] = [];

/** 最前面の一時 overlay を 1 つ閉じる。閉じたら true (useAppHistory の契約)。 */
export function closeTopOverlay(): boolean {
  const top = overlays[overlays.length - 1];
  if (!top) return false;
  top.close();
  return true;
}

/** テスト間の残留防止 (unmount 漏れがあっても次のテストを壊さない)。 */
export function _resetOverlaysForTests(): void {
  overlays.length = 0;
}

/**
 * 一時 overlay のマウント中だけ登録する。close は最新を参照 (stale closure 回避)。
 * 条件レンダリングしている overlay コンポーネントの内側で呼ぶ。
 */
export function useRegisterOverlay(close: () => void): void {
  const ref = useRef(close);
  useEffect(() => {
    ref.current = close;
  });
  useEffect(() => {
    const entry: OverlayEntry = { close: () => ref.current() };
    overlays.push(entry);
    return () => {
      const i = overlays.indexOf(entry);
      if (i >= 0) overlays.splice(i, 1);
    };
  }, []);
}

/**
 * overlay 登録だけを行う null コンポーネント。ラッパーを経由できない overlay の
 * 隣に置く (`<OverlayBinding onClose={...} />`)。
 */
export function OverlayBinding({ onClose }: { onClose: () => void }): null {
  useRegisterOverlay(onClose);
  return null;
}

/** Modal + 登録。Back は onClose (dirty guard 併用時は requestClose) を呼ぶ。 */
export function Modal(props: ComponentProps<typeof FoundationModal>) {
  useRegisterOverlay(props.onClose);
  return <FoundationModal {...props} />;
}

/** Popup + 登録。 */
export function Popup(props: ComponentProps<typeof FoundationPopup>) {
  useRegisterOverlay(props.onClose);
  return <FoundationPopup {...props} />;
}

/** Menu + 登録。 */
export function Menu(props: ComponentProps<typeof FoundationMenu>) {
  useRegisterOverlay(props.onClose);
  return <FoundationMenu {...props} />;
}

/** ConfirmDialog + 登録。Back = キャンセル (非破壊側) として扱う。 */
export function ConfirmDialog(props: ComponentProps<typeof FoundationConfirmDialog>) {
  useRegisterOverlay(props.onCancel);
  return <FoundationConfirmDialog {...props} />;
}

/**
 * foundation useDirtyGuard の登録簿対応版（文言は i18n 経由・確認ダイアログも登録される）。
 *  - dirty=false（未編集）なら即 close。
 *  - dirty=true なら破棄確認を表示。Back は「編集を続ける」と同じ（確認だけ閉じる）。
 */
export function useDirtyGuard(
  dirty: boolean,
  close: () => void,
): { requestClose: () => void; discardConfirm: ReactNode } {
  const [confirming, setConfirming] = useState(false);

  const requestClose = useCallback(() => {
    if (dirty) setConfirming(true);
    else close();
  }, [dirty, close]);

  const discardConfirm = confirming ? (
    <ConfirmDialog
      title={t('guard.discardTitle')}
      body={t('guard.discardBody')}
      confirmLabel={t('guard.discardConfirm')}
      cancelLabel={t('guard.discardCancel')}
      danger
      dismissMode="never"
      onCancel={() => setConfirming(false)}
      onConfirm={() => {
        setConfirming(false);
        close();
      }}
    />
  ) : null;

  return { requestClose, discardConfirm };
}
