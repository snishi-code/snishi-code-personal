/*
 * 危険操作の明示確認ダイアログ。
 *  - danger=true で確定ボタンを警告色に。
 *  - requireKeyword を渡すと、キーワード入力一致まで確定を無効化(全削除など)。
 *  - dismissMode は既定 'never'(背景タップ/Escape で閉じない = 破壊的操作の既定)。
 *  - onConfirm が Promise を返す間は「確定中」として両ボタンを無効化する
 *    (二重実行防止)。閉じるかどうかは呼び出し側が結果を見て決める =
 *    失敗時はダイアログを開いたままにできる(fail-closed)。
 */
import { useId, useState } from 'react';
import { Modal } from './Modal';
import type { DismissMode } from './ModalBase';
import { Button } from './Button';
import { uiAttr } from './contract';

export function ConfirmDialog({
  title,
  body,
  confirmLabel = '実行する',
  cancelLabel = 'キャンセル',
  danger = false,
  dismissMode = 'never',
  requireKeyword,
  keywordPrompt,
  onConfirm,
  onCancel,
  dataUi,
}: {
  title: string;
  body: string;
  confirmLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
  dismissMode?: DismissMode;
  /** 一致するまで確定を無効化するキーワード(全削除などの最終確認)。 */
  requireKeyword?: string;
  keywordPrompt?: string;
  onConfirm: () => void | Promise<void>;
  onCancel: () => void;
  dataUi?: string;
}) {
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState(false);
  const inputId = useId();
  const keywordOk = !requireKeyword || typed.trim() === requireKeyword;

  function confirm(): void {
    const result = onConfirm();
    if (result instanceof Promise) {
      setBusy(true);
      // 成功時は親が閉じる(unmount = setState は無視される)。失敗して開いたままの
      // ときだけ再試行できるよう busy を戻す。拒否はここで握らない(onConfirm 側の責務)。
      void result.finally(() => setBusy(false));
    }
  }

  return (
    <Modal
      title={title}
      onClose={busy ? () => undefined : onCancel}
      dismissMode={dismissMode}
      variant="dialog"
      dataUi={dataUi}
      footer={
        <>
          <Button variant="ghost" onClick={onCancel} disabled={busy} {...uiAttr('dialog.cancel')}>
            {cancelLabel}
          </Button>
          <Button
            variant={danger ? 'danger' : 'primary'}
            onClick={confirm}
            disabled={!keywordOk || busy}
            {...uiAttr('dialog.confirm')}
          >
            {confirmLabel}
          </Button>
        </>
      }
    >
      <p>{body}</p>
      {requireKeyword ? (
        <div className="field" style={{ marginTop: 'var(--space-4)' }}>
          <label className="field__label" htmlFor={inputId}>
            {keywordPrompt ?? `確認のため「${requireKeyword}」と入力してください`}
          </label>
          <input
            id={inputId}
            className="input"
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            autoComplete="off"
          />
        </div>
      ) : null}
    </Modal>
  );
}
