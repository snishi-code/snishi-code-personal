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
import { SelectInput, TextArea, TextInput } from '../Field';
import { AccountPicker } from '../AccountPicker';
import { TagPicker } from '../TagPicker';
import { groupedAccountsByRole } from '../accountOptions';
import { tagsForScope } from '../tagOptions';
import { FORM_MODE_TITLE, MODE_ROLES, type FormMode } from '../entryModes';
import { monthOf } from '../../domain/allocation';
import { useLedger } from '../../state/store';
import {
  reversalInput,
  toSimpleInput,
  validateSimpleEntry,
  type EntryValidationError,
  type SimpleEntryInput,
} from '../../domain/entry';
import type { EntryMetadata, InputMode, JournalEntry, MonthlyCostKind } from '../../domain/types';
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
  const { ledger, saveEntry, createMonthlyCost } = useLedger();
  const accounts = ledger?.accounts ?? [];
  const tags = ledger?.tags ?? [];

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

  // 月額化コスト（expense の create のみ）
  const canAllocate = init.kind === 'create' && mode === 'expense';
  const [allocate, setAllocate] = useState(false);
  // 月額化 ON のときはタグを付けられない（createMonthlyCost はタグを受け取らないため）。
  const allocationActive = canAllocate && allocate;
  const [monthsText, setMonthsText] = useState('');
  const [monthsError, setMonthsError] = useState(false);
  const months = monthsText === '' ? 0 : Number.parseInt(monthsText, 10);
  // 月額化の詳細
  const [costKind, setCostKind] = useState<MonthlyCostKind>('durable-asset');
  const [continueCost, setContinueCost] = useState(false);
  const [repeatText, setRepeatText] = useState('');
  // liability 払いの返済 CF
  const [repayAccountId, setRepayAccountId] = useState('');
  const [repayCountText, setRepayCountText] = useState('');
  // 支払い元(credit)が支払用負債なら返済 CF を入力できる。
  const paymentRole = accounts.find((a) => a.id === form.creditAccountId)?.role;
  const isLiabilityPayment = paymentRole === 'payment-liability';
  // 詳細（メモ・タグ）は折りたたみ。編集時は既存値が見えるよう開いておく。
  const [showDetails, setShowDetails] = useState(init.kind === 'edit');

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
    const useMonthly = canAllocate && allocate;
    // costMonths は 1 以上（サブスクは 1 か月）。
    const monthsBad = useMonthly && (!Number.isInteger(months) || months < 1);
    setMonthsError(monthsBad);
    if (found.length > 0 || monthsBad) return;
    setSubmitting(true);
    try {
      if (useMonthly) {
        const repeat = continueCost
          ? repeatText === ''
            ? months
            : Number.parseInt(repeatText, 10)
          : undefined;
        const repayCount = repayCountText === '' ? 0 : Number.parseInt(repayCountText, 10);
        // 支出フォームの debit=費用カテゴリ / credit=支払い元 をそのまま月額化に渡す。
        await createMonthlyCost({
          name: form.description,
          kind: costKind,
          amount: form.amount,
          costMonths: months,
          ...(repeat !== undefined ? { repeatEveryMonths: repeat } : {}),
          startMonth: monthOf(form.date),
          expenseAccountId: form.debitAccountId,
          paymentAccountId: form.creditAccountId,
          ...(isLiabilityPayment && repayAccountId !== '' && repayCount >= 1
            ? {
                repaymentAccountId: repayAccountId,
                repaymentCount: repayCount,
                repaymentStartDate: form.date,
              }
            : {}),
        });
      } else {
        const metadata: EntryMetadata = { ...form.metadata, inputMode: resolveInputMode() };
        await saveEntry({ ...form, metadata }, existing);
      }
      onClose();
    } catch {
      setSubmitting(false);
    }
  }

  const sameAccount = errorText(errors, 'same-account');
  const isManual = mode === 'manual';

  const dateField = (
    <TextInput
      label={t('entry.date')}
      type="date"
      required
      value={form.date}
      onChange={(v) => setForm((f) => ({ ...f, date: v }))}
      error={errorText(errors, 'date-required')}
      dataUi={UI.journal.entry.date}
    />
  );

  const descriptionField = (
    <TextInput
      label={t('entry.description')}
      required
      value={form.description}
      placeholder={t('entry.descriptionPlaceholder')}
      onChange={(v) => setForm((f) => ({ ...f, description: v }))}
      error={errorText(errors, 'description-required')}
      dataUi={UI.journal.entry.description}
    />
  );

  const amountField = (
    <TextInput
      label={t('entry.amount')}
      required
      inputMode="numeric"
      value={amountText}
      onChange={onAmountChange}
      error={errorText(errors, 'amount-invalid')}
      dataUi={UI.journal.entry.amount}
    />
  );

  const entryTagsField = allocationActive ? null : (
    <TagPicker
      label={t('entry.tags')}
      hint={t('entry.tagsHint')}
      tags={tagsForScope(tags, 'entry', form.tagIds ?? [])}
      value={form.tagIds ?? []}
      onChange={(ids) => setForm((f) => ({ ...f, tagIds: ids }))}
      dataUi={UI.journal.entry.tags}
    />
  );

  const memoField = (
    <TextArea
      label={t('entry.memo')}
      value={form.memo ?? ''}
      onChange={(v) => setForm((f) => ({ ...f, memo: v }))}
      dataUi={UI.journal.entry.memo}
    />
  );

  const renderAccountPicker = (role: (typeof roles)[number]) => {
    const value = role.side === 'debit' ? form.debitAccountId : form.creditAccountId;
    const reqErr = errorText(errors, role.side === 'debit' ? 'debit-required' : 'credit-required');
    return (
      <AccountPicker
        label={t(role.labelKey)}
        required
        value={value}
        groups={groupedAccountsByRole(accounts, [...role.allowedRoles], value)}
        onChange={(id) => setSide(role.side, id)}
        error={reqErr ?? sameAccount}
        dataUi={
          role.side === 'debit' ? UI.journal.entry.debitAccount : UI.journal.entry.creditAccount
        }
      />
    );
  };

  const renderLineTags = (role: (typeof roles)[number]) => {
    if (allocationActive) return null;
    const lineTagValue = (role.side === 'debit' ? form.debitTagIds : form.creditTagIds) ?? [];
    const lineTagLabel =
      mode === 'expense' && role.side === 'credit'
        ? t('entry.paymentTags')
        : role.side === 'debit'
          ? t('entry.debitTags')
          : t('entry.creditTags');
    return (
      <TagPicker
        label={lineTagLabel}
        tags={tagsForScope(tags, 'line', lineTagValue)}
        value={lineTagValue}
        onChange={(ids) =>
          setForm((f) => ({
            ...f,
            [role.side === 'debit' ? 'debitTagIds' : 'creditTagIds']: ids,
          }))
        }
        dataUi={role.side === 'debit' ? UI.journal.entry.debitTags : UI.journal.entry.creditTags}
      />
    );
  };

  const allocateField = canAllocate ? (
    <div className="field">
      <label
        style={{ display: 'inline-flex', gap: 8, alignItems: 'center', minHeight: 'var(--tap)' }}
      >
        <input
          type="checkbox"
          checked={allocate}
          onChange={(e) => setAllocate(e.target.checked)}
          data-ui={UI.journal.entry.allocateToggle}
        />
        {t('entry.monthlyizeToggle')}
      </label>
      {allocate ? (
        <>
          <SelectInput
            label={t('entry.monthlyizeKind')}
            value={costKind}
            onChange={(v) => setCostKind(v as MonthlyCostKind)}
            options={[
              { value: 'subscription', label: t('monthlyCost.kind.subscription') },
              { value: 'prepaid-service', label: t('monthlyCost.kind.prepaid-service') },
              { value: 'durable-asset', label: t('monthlyCost.kind.durable-asset') },
              { value: 'recurring-event', label: t('monthlyCost.kind.recurring-event') },
            ]}
            dataUi={UI.journal.entry.monthlyizeKind}
          />
          <TextInput
            label={t('entry.monthlyizeMonths')}
            required
            inputMode="numeric"
            value={monthsText}
            hint={t('entry.monthlyizeMonthsHint')}
            onChange={(v) => setMonthsText(v.replace(/[^\d]/g, ''))}
            error={monthsError ? t('entry.error.months-invalid') : undefined}
            dataUi={UI.journal.entry.allocateMonths}
          />
          <label
            style={{
              display: 'inline-flex',
              gap: 8,
              alignItems: 'center',
              minHeight: 'var(--tap)',
            }}
          >
            <input
              type="checkbox"
              checked={continueCost}
              onChange={(e) => setContinueCost(e.target.checked)}
              data-ui={UI.journal.entry.monthlyizeContinue}
            />
            {t('entry.monthlyizeContinue')}
          </label>
          {continueCost ? (
            <TextInput
              label={t('entry.monthlyizeRepeat')}
              inputMode="numeric"
              value={repeatText}
              hint={t('entry.monthlyizeRepeatHint')}
              onChange={(v) => setRepeatText(v.replace(/[^\d]/g, ''))}
            />
          ) : null}
          {isLiabilityPayment ? (
            <div className="card card--pad" style={{ marginTop: 'var(--space-2)' }}>
              <p className="field__hint" style={{ marginBottom: 'var(--space-2)' }}>
                {t('entry.monthlyizeRepayNote')}
              </p>
              <AccountPicker
                label={t('entry.monthlyizeRepayAccount')}
                value={repayAccountId}
                groups={groupedAccountsByRole(accounts, ['daily-asset'], repayAccountId)}
                onChange={setRepayAccountId}
                dataUi={UI.journal.entry.monthlyizeRepayAccount}
              />
              <TextInput
                label={t('entry.monthlyizeRepayCount')}
                inputMode="numeric"
                value={repayCountText}
                onChange={(v) => setRepayCountText(v.replace(/[^\d]/g, ''))}
                dataUi={UI.journal.entry.monthlyizeRepayCount}
              />
            </div>
          ) : null}
          <p className="field__hint">{t('entry.monthlyizeNote')}</p>
        </>
      ) : null}
    </div>
  ) : null;

  const manualSwitch =
    init.kind === 'create' && mode !== 'manual' && !allocate ? (
      <button
        type="button"
        className="collapse-toggle"
        onClick={() => setMode('manual')}
        data-ui={UI.journal.entry.manualSwitch}
      >
        <Icon name="chevronDown" size={16} />
        {t('entry.manualSwitch')}
      </button>
    ) : null;

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

      {isManual ? (
        <>
          {dateField}
          {descriptionField}
          {entryTagsField}
          {roles.map((role) => (
            <div key={role.side}>
              {renderAccountPicker(role)}
              {renderLineTags(role)}
            </div>
          ))}
          {amountField}
          {memoField}
        </>
      ) : (
        <>
          {/* 日常入力は自然文の順: 金額 → 科目 → 日付 → 摘要 → 按分 → 詳細 */}
          {amountField}
          {roles.map((role) => (
            <div key={role.side}>{renderAccountPicker(role)}</div>
          ))}
          {dateField}
          {descriptionField}
          {allocateField}

          {allocationActive ? null : (
            <>
              <button
                type="button"
                className="collapse-toggle"
                aria-expanded={showDetails}
                onClick={() => setShowDetails((v) => !v)}
                data-ui={UI.journal.entry.detailToggle}
              >
                <Icon name={showDetails ? 'chevronDown' : 'chevronRight'} size={16} />
                {t('entry.detailToggle')}
              </button>
              {showDetails ? (
                <div className="stack">
                  {memoField}
                  {entryTagsField}
                  {roles.map((role) => (
                    <div key={role.side}>{renderLineTags(role)}</div>
                  ))}
                </div>
              ) : null}
            </>
          )}

          {manualSwitch}
        </>
      )}
    </Modal>
  );
}
