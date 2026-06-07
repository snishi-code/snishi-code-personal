/*
 * 目的別資金（取り置き枠）の追加シート。
 *
 * 資金目標を統合した枠なので、任意で「目標額・目標日」を持てる（現在額は口座残高から
 * 自動計算するため入力欄は持たない）。CF の補助セクションと、ホームの振替入力（行き先で
 * 「目的別資金を作成」）の双方から使う共有コンポーネント。
 */
import { useRef, useState } from 'react';
import { Modal } from './Modal';
import { useDirtyGuard } from './useDirtyGuard';
import { TextArea, TextInput } from './Field';
import { t } from '../i18n';
import { UI } from '../ui-contract';

export interface ReserveSheetInput {
  name: string;
  targetAmount?: number;
  targetDate?: string;
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
  const [targetText, setTargetText] = useState('');
  const [targetDate, setTargetDate] = useState('');
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | undefined>(undefined);
  const [submitting, setSubmitting] = useState(false);

  async function submit() {
    if (name.trim() === '') {
      setError(t('reserves.error.name'));
      return;
    }
    setSubmitting(true);
    const target =
      targetText === '' ? undefined : Number.parseInt(targetText.replace(/[^\d]/g, ''), 10);
    try {
      await onSave({
        name: name.trim(),
        ...(target && target > 0 ? { targetAmount: target } : {}),
        ...(/^\d{4}-\d{2}-\d{2}$/.test(targetDate) ? { targetDate } : {}),
        ...(note.trim() !== '' ? { note: note.trim() } : {}),
      });
      onClose(); // 成功時のみ閉じる
    } catch {
      setSubmitting(false); // 保存失敗時は閉じない
    }
  }

  const snapshot = JSON.stringify({ name, targetText, targetDate, note });
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
        <TextInput
          label={t('reserves.target')}
          inputMode="numeric"
          value={targetText}
          onChange={(v) => setTargetText(v.replace(/[^\d]/g, ''))}
          dataUi={UI.cashflow.reserveTarget}
        />
        <TextInput
          label={t('reserves.targetDate')}
          type="date"
          value={targetDate}
          hint={t('reserves.targetDateHint')}
          onChange={setTargetDate}
          dataUi={UI.cashflow.reserveDate}
        />
        <TextArea label={t('reserves.note')} value={note} onChange={setNote} />
      </Modal>
      {discardConfirm}
    </>
  );
}
