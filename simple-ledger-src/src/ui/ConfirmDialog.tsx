/*
 * 危険操作の明示確認ダイアログ。
 *  - danger=true で確定ボタンを警告色に。
 *  - requireKeyword を渡すと、キーワード入力一致まで確定を無効化（全削除など）。
 *  - dismissMode は既定 'never'（背景タップ/Escape で閉じない＝破壊的操作の既定）。
 */
import { useId, useState } from 'react';
import { Modal } from './Modal';
import type { DismissMode } from './Modal';
import { Icon } from './Icon';
import { t } from '../i18n';
import { UI } from '../ui-contract';

export function ConfirmDialog({
  title,
  body,
  confirmLabel = t('common.proceed'),
  cancelLabel = t('common.cancel'),
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
          <button
            type="button"
            className="btn btn--ghost"
            onClick={onCancel}
            data-ui={UI.dialog.cancel}
          >
            {cancelLabel}
          </button>
          <button
            type="button"
            className={`btn ${danger ? 'btn--danger' : 'btn--primary'}`}
            onClick={onConfirm}
            disabled={!keywordOk}
            data-ui={UI.dialog.confirm}
          >
            {danger ? <Icon name="alert" size={18} /> : null}
            {confirmLabel}
          </button>
        </>
      }
    >
      <p>{body}</p>
      {requireKeyword ? (
        <div className="field" style={{ marginTop: 'var(--space-4)' }}>
          <label className="field__label" htmlFor={inputId}>
            {keywordPrompt ?? t('reset.keywordPrompt', { keyword: requireKeyword })}
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
