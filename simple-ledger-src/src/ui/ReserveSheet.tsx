/*
 * 取り置き資金（取り置き枠）の追加シート。
 *
 * 取り置きは「短期の封筒分け」: 預金から近い支払い予定に備えて取り分ける流動性資金。
 * 目標額・目標期限・利回りは持たない（長期の目標/投資前提の資金は将来タスク）。
 * 作成に必要なのは name のみ（任意でメモ）。CF の補助セクションと、ホームの振替入力
 * （右辺「取り置き資産を作る」）の双方から使う共有コンポーネント。
 */
import { useRef, useState } from 'react';
import { Modal } from './Modal';
import { useDirtyGuard } from './useDirtyGuard';
import { TextArea, TextInput } from './Field';
import { t } from '../i18n';
import { UI } from '../ui-contract';

export interface ReserveSheetInput {
  name: string;
  note?: string;
}

export function ReserveSheet({
  onClose,
  onSave,
}: {
  onClose: () => void;
  onSave: (input: ReserveSheetInput) => Promise<unknown> | void;
}) {
  const [name, setName] = useState('');
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | undefined>(undefined);
  const [submitting, setSubmitting] = useState(false);

  async function submit() {
    if (name.trim() === '') {
      setError(t('reserves.error.name'));
      return;
    }
    setSubmitting(true);
    try {
      await onSave({
        name: name.trim(),
        ...(note.trim() !== '' ? { note: note.trim() } : {}),
      });
      onClose(); // 成功時のみ閉じる
    } catch {
      setSubmitting(false); // 保存失敗時は閉じない
    }
  }

  const snapshot = JSON.stringify({ name, note });
  const initialSnapshotRef = useRef<string | null>(null);
  if (initialSnapshotRef.current === null) initialSnapshotRef.current = snapshot;
  const dirty = snapshot !== initialSnapshotRef.current;
  const { requestClose, discardConfirm } = useDirtyGuard(dirty, onClose);

  return (
    <>
      <Modal
        title={t('reserves.form.title')}
        onClose={requestClose}
        dismissMode="if-clean"
        footer={
          <>
            <button type="button" className="btn btn--ghost" onClick={requestClose}>
              {t('common.cancel')}
            </button>
            <button
              type="button"
              className="btn btn--primary"
              onClick={submit}
              disabled={submitting}
              data-ui={UI.cashflow.reserveSave}
            >
              {t('common.save')}
            </button>
          </>
        }
      >
        <TextInput
          label={t('reserves.name')}
          required
          value={name}
          placeholder={t('reserves.namePlaceholder')}
          onChange={(v) => {
            setName(v);
            setError(undefined);
          }}
          error={error}
          dataUi={UI.cashflow.reserveName}
        />
        <p className="field__hint">{t('reserves.intro')}</p>
        <TextArea label={t('reserves.note')} value={note} onChange={setNote} />
      </Modal>
      {discardConfirm}
    </>
  );
}
