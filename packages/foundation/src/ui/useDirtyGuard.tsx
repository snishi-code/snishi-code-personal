/*
 * 入力フォームの「閉じる」を一元化するフック。
 *  - dirty=false（未編集）なら即 close。
 *  - dirty=true（編集済み）なら破棄確認ダイアログを表示し、
 *    破棄を選んだときだけ close する。
 * 破棄確認ダイアログ自身は dismissMode='never'（背景タップ/Escape で閉じない）。
 *
 * 使い方:
 *   const { requestClose, discardConfirm } = useDirtyGuard(dirty, onClose);
 *   <Modal onClose={requestClose} dismissMode="if-clean" ...>
 *     ...（フッターのキャンセルも onClick={requestClose}）
 *   </Modal>
 *   {discardConfirm}
 */
import { useCallback, useState } from 'react';
import type { ReactNode } from 'react';
import { ConfirmDialog } from './ConfirmDialog';

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
      title="変更を破棄しますか？"
      body="入力した内容は保存されません。"
      confirmLabel="破棄する"
      cancelLabel="編集を続ける"
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
