/*
 * 取り置き資金（取り置き枠）の追加シート。foundation の Modal/Field/useDirtyGuard を使用。
 */
import { useState } from 'react';
import { Modal } from '@snishi/foundation/ui/Modal';
import { useDirtyGuard } from '@snishi/foundation/ui/useDirtyGuard';
import { TextArea, TextInput } from '@snishi/foundation/ui/Field';
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
      onClose();
    } catch {
      setSubmitting(false);
    }
  }

  const snapshot = JSON.stringify({ name, note });
  const [initialSnapshot] = useState(snapshot);
  const dirty = snapshot !== initialSnapshot;
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
