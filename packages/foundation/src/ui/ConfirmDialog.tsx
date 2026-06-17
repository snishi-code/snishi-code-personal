/*
 * 危険操作の明示確認ダイアログ。
 *  - danger=true で確定ボタンを警告色に。
 *  - requireKeyword を渡すと、キーワード入力一致まで確定を無効化(全削除など)。
 *  - dismissMode は既定 'never'(背景タップ/Escape で閉じない = 破壊的操作の既定)。
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
  onConfirm: () => void;
  onCancel: () => void;
  dataUi?: string;
}) {
  const [typed, setTyped] = useState('');
  const inputId = useId();
  const keywordOk = !requireKeyword || typed.trim() === requireKeyword;

  return (
    <Modal
      title={title}
      onClose={onCancel}
      dismissMode={dismissMode}
      variant="dialog"
      dataUi={dataUi}
      footer={
        <>
          <Button variant="ghost" onClick={onCancel} {...uiAttr('dialog.cancel')}>
            {cancelLabel}
          </Button>
          <Button
            variant={danger ? 'danger' : 'primary'}
            onClick={onConfirm}
            disabled={!keywordOk}
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
