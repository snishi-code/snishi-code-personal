/*
 * 仕訳の入力シート。
 *
 * 日常入力（収入/支出/振替）は借方/貸方を意識させず、意味のあるフィールド
 * （入金先・カテゴリ・支払元・振替元・振替先）で 2 科目を選ばせる。内部は常に複式。
 *  - 種別(normal/opening)は通常入力から隠す。
 *  - 「詳細入力」で借方/貸方を直接指定する manual モードへ切替できる（主導線ではない）。
 *  - 編集は元の入力モードを推定して開く。取消/返金(reversal)は manual で逆仕訳を見せる。
 */
import { useState } from 'react';
import { Modal } from '../Modal';
import { TextArea, TextInput } from '../Field';
import { AccountPicker } from '../AccountPicker';
import { groupedAccounts } from '../accountOptions';
import { FORM_MODE_TITLE, MODE_ROLES, type FormMode } from '../entryModes';
import { useLedger } from '../../state/store';
import {
  reversalInput,
  toSimpleInput,
  validateSimpleEntry,
  type EntryValidationError,
  type SimpleEntryInput,
} from '../../domain/entry';
import type { EntryMetadata, InputMode, JournalEntry } from '../../domain/types';
import { Icon } from '../Icon';
import { t } from '../../i18n';
import type { MessageKey } from '../../i18n';
import { todayLocal } from '../../util/time';
import { UI } from '../../ui-contract';

export type EntryInit =
  | { kind: 'create'; mode: FormMode }
  | { kind: 'edit'; entry: JournalEntry }
  | { kind: 'reversal'; source: JournalEntry };

function emptyInput(): SimpleEntryInput {
  return {
    date: todayLocal(),
    description: '',
    debitAccountId: '',
    creditAccountId: '',
    amount: 0,
    memo: '',
    kind: 'normal',
  };
}

function initialModeFor(entry: JournalEntry): FormMode {
  const m = entry.metadata?.inputMode;
  if (m === 'income' || m === 'expense' || m === 'transfer') return m;
  return 'manual';
}

function errorText(
  errors: EntryValidationError[],
  field: EntryValidationError,
): string | undefined {
  return errors.includes(field) ? t(`entry.error.${field}` as MessageKey) : undefined;
}

export function EntrySheet({ init, onClose }: { init: EntryInit; onClose: () => void }) {
  const { ledger, saveEntry } = useLedger();
  const accounts = ledger?.accounts ?? [];

  const [mode, setMode] = useState<FormMode>(
    init.kind === 'create'
      ? init.mode
      : init.kind === 'edit'
        ? initialModeFor(init.entry)
        : 'manual',
  );
  const [form, setForm] = useState<SimpleEntryInput>(
    init.kind === 'edit'
      ? toSimpleInput(init.entry)
      : init.kind === 'reversal'
        ? reversalInput(init.source)
        : emptyInput(),
  );
  const [amountText, setAmountText] = useState<string>(
    init.kind === 'create' ? '' : String(form.amount || ''),
  );
  const [errors, setErrors] = useState<EntryValidationError[]>([]);
  const [submitting, setSubmitting] = useState(false);

  const existing =
    init.kind === 'edit' ? { id: init.entry.id, createdAt: init.entry.createdAt } : undefined;

  const title =
    init.kind === 'reversal'
      ? t('entry.reversalTitle')
      : init.kind === 'edit'
        ? t('entry.editTitle')
        : t(FORM_MODE_TITLE[mode]);

  const roles = MODE_ROLES[mode];

  const setSide = (side: 'debit' | 'credit', id: string) =>
    setForm((f) => ({ ...f, [side === 'debit' ? 'debitAccountId' : 'creditAccountId']: id }));

  const onAmountChange = (v: string) => {
    const digits = v.replace(/[^\d]/g, '');
    setAmountText(digits);
    setForm((f) => ({ ...f, amount: digits === '' ? 0 : Number.parseInt(digits, 10) }));
  };

  function resolveInputMode(): InputMode {
    if (init.kind === 'reversal') return 'reversal';
    if (init.kind === 'edit') return init.entry.metadata?.inputMode ?? 'manual';
    return mode; // create
  }

  async function onSave() {
    const found = validateSimpleEntry(form);
    setErrors(found);
    if (found.length > 0) return;
    setSubmitting(true);
    const metadata: EntryMetadata = { ...form.metadata, inputMode: resolveInputMode() };
    try {
      await saveEntry({ ...form, metadata }, existing);
      onClose();
    } catch {
      setSubmitting(false);
    }
  }

  const sameAccount = errorText(errors, 'same-account');

  return (
    <Modal
      title={title}
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
      {init.kind === 'reversal' ? (
        <div className="banner" role="note" style={{ marginBottom: 'var(--space-4)' }}>
          <Icon name="reverse" size={18} />
          {t('entry.reversalNote')}
        </div>
      ) : null}

      <TextInput
        label={t('entry.date')}
        type="date"
        required
        value={form.date}
        onChange={(v) => setForm((f) => ({ ...f, date: v }))}
        error={errorText(errors, 'date-required')}
        dataUi={UI.journal.entry.date}
      />
      <TextInput
        label={t('entry.description')}
        required
        value={form.description}
        placeholder={t('entry.descriptionPlaceholder')}
        onChange={(v) => setForm((f) => ({ ...f, description: v }))}
        error={errorText(errors, 'description-required')}
        dataUi={UI.journal.entry.description}
      />

      {roles.map((role) => {
        const value = role.side === 'debit' ? form.debitAccountId : form.creditAccountId;
        const reqErr = errorText(
          errors,
          role.side === 'debit' ? 'debit-required' : 'credit-required',
        );
        return (
          <AccountPicker
            key={role.side}
            label={t(role.labelKey)}
            required
            value={value}
            groups={groupedAccounts(accounts, role.allowedTypes, value)}
            onChange={(id) => setSide(role.side, id)}
            error={reqErr ?? sameAccount}
            dataUi={
              role.side === 'debit' ? UI.journal.entry.debitAccount : UI.journal.entry.creditAccount
            }
          />
        );
      })}

      <TextInput
        label={t('entry.amount')}
        required
        inputMode="numeric"
        value={amountText}
        onChange={onAmountChange}
        error={errorText(errors, 'amount-invalid')}
        dataUi={UI.journal.entry.amount}
      />

      <TextArea
        label={t('entry.memo')}
        value={form.memo ?? ''}
        onChange={(v) => setForm((f) => ({ ...f, memo: v }))}
        dataUi={UI.journal.entry.memo}
      />

      {init.kind === 'create' && mode !== 'manual' ? (
        <button
          type="button"
          className="collapse-toggle"
          onClick={() => setMode('manual')}
          data-ui={UI.journal.entry.detailToggle}
        >
          <Icon name="chevronDown" size={16} />
          {t('entry.detailToggle')}
        </button>
      ) : null}
    </Modal>
  );
}
