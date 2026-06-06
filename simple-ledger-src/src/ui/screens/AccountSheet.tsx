/*
 * 勘定科目の追加/編集シート。
 */
import { useState } from 'react';
import { Modal } from '../Modal';
import { SelectInput, TextArea, TextInput } from '../Field';
import { useLedger } from '../../state/store';
import { ACCOUNT_TYPES, type Account, type AccountType } from '../../domain/types';
import { newId } from '../../domain/ids';
import { nowIso } from '../../util/time';
import { accountTypeLabel } from '../accountOptions';
import { t } from '../../i18n';
import { UI } from '../../ui-contract';

export function AccountSheet({ existing, onClose }: { existing?: Account; onClose: () => void }) {
  const { ledger, saveAccount } = useLedger();
  const [name, setName] = useState(existing?.name ?? '');
  const [type, setType] = useState<AccountType>(existing?.type ?? 'expense');
  const [note, setNote] = useState(existing?.note ?? '');
  const [error, setError] = useState<string | undefined>(undefined);
  const [submitting, setSubmitting] = useState(false);

  // 使用中（仕訳から参照されている）科目は区分(type)を変更できない。
  const inUse =
    !!existing &&
    (ledger?.journalEntries ?? []).some((e) => e.lines.some((l) => l.accountId === existing.id));

  async function onSave() {
    if (name.trim() === '') {
      setError(t('entry.error.description-required'));
      return;
    }
    setSubmitting(true);
    const ts = nowIso();
    const account: Account = {
      id: existing?.id ?? newId(),
      name: name.trim(),
      type,
      archived: existing?.archived ?? false,
      ...(note.trim() !== '' ? { note: note.trim() } : {}),
      createdAt: existing?.createdAt ?? ts,
      updatedAt: ts,
    };
    try {
      await saveAccount(account);
      onClose();
    } catch {
      setSubmitting(false);
    }
  }

  return (
    <Modal
      title={existing ? t('accounts.edit') : t('accounts.add')}
      onClose={onClose}
      dismissable={false}
      dataUi={existing ? undefined : UI.accounts.create}
      footer={
        <>
          <button type="button" className="btn btn--ghost" onClick={onClose}>
            {t('common.cancel')}
          </button>
          <button
            type="button"
            className="btn btn--primary"
            onClick={onSave}
            disabled={submitting}
            data-ui={UI.accounts.save}
          >
            {t('common.save')}
          </button>
        </>
      }
    >
      <TextInput
        label={t('accounts.name')}
        required
        value={name}
        onChange={(v) => {
          setName(v);
          setError(undefined);
        }}
        error={error}
      />
      <SelectInput
        label={t('accounts.type')}
        required
        value={type}
        onChange={(v) => setType(v as AccountType)}
        options={ACCOUNT_TYPES.map((tp) => ({ value: tp, label: accountTypeLabel(tp) }))}
        disabled={inUse}
        hint={inUse ? t('accounts.typeLockedHint') : undefined}
      />
      <TextArea label={t('accounts.note')} value={note} onChange={setNote} />
    </Modal>
  );
}
