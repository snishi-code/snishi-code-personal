/*
 * 仕訳の追加/編集シート。MVP は「1 借方・1 貸方・同額」。
 * 保存/キャンセルは下部の明確なボタン。フォームなので背景タップで閉じない。
 */
import { useState } from 'react';
import { Modal } from '../Modal';
import { SelectInput, TextArea, TextInput } from '../Field';
import { groupedAccountOptions } from '../accountOptions';
import { useLedger } from '../../state/store';
import {
  toSimpleInput,
  validateSimpleEntry,
  type EntryValidationError,
  type SimpleEntryInput,
} from '../../domain/entry';
import type { JournalEntry, JournalEntryKind } from '../../domain/types';
import { t } from '../../i18n';
import type { MessageKey } from '../../i18n';
import { todayLocal } from '../../util/time';
import { UI } from '../../ui-contract';

const EMPTY: SimpleEntryInput = {
  date: todayLocal(),
  description: '',
  debitAccountId: '',
  creditAccountId: '',
  amount: 0,
  memo: '',
  kind: 'normal',
};

function errorText(
  errors: EntryValidationError[],
  field: EntryValidationError,
): string | undefined {
  return errors.includes(field) ? t(`entry.error.${field}` as MessageKey) : undefined;
}

export function EntrySheet({
  existing,
  onClose,
}: {
  existing?: JournalEntry;
  onClose: () => void;
}) {
  const { ledger, saveEntry } = useLedger();
  const accounts = ledger?.accounts ?? [];
  const groups = groupedAccountOptions(accounts);

  const [form, setForm] = useState<SimpleEntryInput>(existing ? toSimpleInput(existing) : EMPTY);
  const [amountText, setAmountText] = useState<string>(
    existing ? String(toSimpleInput(existing).amount) : '',
  );
  const [errors, setErrors] = useState<EntryValidationError[]>([]);
  const [submitting, setSubmitting] = useState(false);

  const set = <K extends keyof SimpleEntryInput>(key: K, val: SimpleEntryInput[K]) =>
    setForm((f) => ({ ...f, [key]: val }));

  const onAmountChange = (v: string) => {
    const digits = v.replace(/[^\d]/g, '');
    setAmountText(digits);
    set('amount', digits === '' ? 0 : Number.parseInt(digits, 10));
  };

  async function onSave() {
    const found = validateSimpleEntry(form);
    setErrors(found);
    if (found.length > 0) return;
    setSubmitting(true);
    try {
      await saveEntry(
        form,
        existing ? { id: existing.id, createdAt: existing.createdAt } : undefined,
      );
      onClose();
    } catch {
      // store 側で error toast 済み。シートは開いたまま（保存失敗で閉じない）。
      setSubmitting(false);
    }
  }

  const sameAccount = errorText(errors, 'same-account');

  return (
    <Modal
      title={existing ? t('entry.editTitle') : t('entry.createTitle')}
      onClose={onClose}
      dismissable={false}
      footer={
        <>
          <button
            type="button"
            className="btn btn--ghost"
            onClick={onClose}
            data-ui={UI.journal.entry.cancel}
          >
            {t('common.cancel')}
          </button>
          <button
            type="button"
            className="btn btn--primary"
            onClick={onSave}
            disabled={submitting}
            data-ui={UI.journal.entry.save}
          >
            {t('common.save')}
          </button>
        </>
      }
    >
      <TextInput
        label={t('entry.date')}
        type="date"
        required
        value={form.date}
        onChange={(v) => set('date', v)}
        error={errorText(errors, 'date-required')}
        dataUi={UI.journal.entry.date}
      />
      <TextInput
        label={t('entry.description')}
        required
        value={form.description}
        placeholder={t('entry.descriptionPlaceholder')}
        onChange={(v) => set('description', v)}
        error={errorText(errors, 'description-required')}
        dataUi={UI.journal.entry.description}
      />
      <SelectInput
        label={t('entry.debitAccount')}
        required
        value={form.debitAccountId}
        groups={groups}
        placeholder={t('entry.selectAccount')}
        onChange={(v) => set('debitAccountId', v)}
        error={errorText(errors, 'debit-required') ?? sameAccount}
        dataUi={UI.journal.entry.debitAccount}
      />
      <SelectInput
        label={t('entry.creditAccount')}
        required
        value={form.creditAccountId}
        groups={groups}
        placeholder={t('entry.selectAccount')}
        hint={t('entry.hint')}
        onChange={(v) => set('creditAccountId', v)}
        error={errorText(errors, 'credit-required') ?? sameAccount}
        dataUi={UI.journal.entry.creditAccount}
      />
      <TextInput
        label={t('entry.amount')}
        required
        inputMode="numeric"
        value={amountText}
        onChange={onAmountChange}
        error={errorText(errors, 'amount-invalid')}
        dataUi={UI.journal.entry.amount}
      />
      <SelectInput
        label={t('entry.kind')}
        value={form.kind ?? 'normal'}
        options={[
          { value: 'normal', label: t('entry.kindNormal') },
          { value: 'opening', label: t('entry.kindOpening') },
        ]}
        hint={form.kind === 'opening' ? t('entry.openingHint') : undefined}
        onChange={(v) => set('kind', v as JournalEntryKind)}
      />
      <TextArea
        label={t('entry.memo')}
        value={form.memo ?? ''}
        onChange={(v) => set('memo', v)}
        dataUi={UI.journal.entry.memo}
      />
    </Modal>
  );
}
