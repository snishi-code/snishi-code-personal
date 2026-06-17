/*
 * 仕訳の入力シート。
 *
 * 日常入力（収入/支出/振替）は借方/貸方を意識させず、「お金の流れ」`源泉 → 行き先` で見せる。
 * 並びは人間の入力順: 日付 → 項目 → 金額 → お金の流れ(A → B) → 詳細。内部は常に複式で、
 * source=貸方(credit) / destination=借方(debit) に対応する（MODE_FLOW）。
 */
import { useState } from 'react';
import { Modal } from '@snishi/foundation/ui/Modal';
import { useDirtyGuard } from '@snishi/foundation/ui/useDirtyGuard';
import { SelectInput, TextArea, TextInput } from '@snishi/foundation/ui/Field';
import { Icon } from '@snishi/foundation/ui/Icon';
import { AccountPicker } from '../AccountPicker';
import { TagPicker } from '../TagPicker';
import { LiabilitySheet } from '../LiabilitySheet';
import { groupedAccountsByRole } from '../accountOptions';
import { tagsForEntry } from '../tagOptions';
import {
  FORM_MODE_TITLE,
  MODE_FLOW,
  MODE_ROLES,
  type FlowMode,
  type FormMode,
} from '../entryModes';
import { monthOf } from '../../domain/allocation';
import { inferMonthlyCostKind } from '../../domain/monthlyCost';
import { useLedger } from '../../state/store';
import {
  reversalInput,
  toSimpleInput,
  transferFlowValid,
  validateSimpleEntry,
  type EntryValidationError,
  type SimpleEntryInput,
} from '../../domain/entry';
import type { Account, EntryMetadata, InputMode, JournalEntry } from '../../domain/types';
import { RESERVE_LEDGER_ACCOUNT_ID } from '../../domain/constants';
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
  const {
    ledger,
    saveEntry,
    saveEntryWithFixedAssetMonthly,
    createContinuousCost,
    createReserve,
    saveAccount,
  } = useLedger();
  const accounts = ledger?.accounts ?? [];
  const reserves = ledger?.reserves ?? [];
  const tags = ledger?.tags ?? [];
  const reserveOptionGroup = (): { type: 'asset'; label: string; accounts: Account[] } | null => {
    if (reserves.length === 0) return null;
    return {
      type: 'asset',
      label: t('reserves.title'),
      accounts: reserves.map((r) => ({
        id: `reserve:${r.id}`,
        name: r.name,
        type: 'asset' as const,
        role: 'reserve-asset' as const,
        archived: false,
        createdAt: r.createdAt,
        updatedAt: r.updatedAt,
      })),
    };
  };
  const resolveReserveSide = (id: string): { accountId: string; reserveId?: string } =>
    id.startsWith('reserve:')
      ? { accountId: RESERVE_LEDGER_ACCOUNT_ID, reserveId: id.slice('reserve:'.length) }
      : { accountId: id };
  const scopes = ledger?.managementScopes ?? [];
  const instruments = ledger?.accountInstruments ?? [];

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
  const [flowError, setFlowError] = useState<string | undefined>(undefined);
  const [submitting, setSubmitting] = useState(false);

  const destRole = accounts.find((a) => a.id === form.debitAccountId)?.role;
  const canAllocate = init.kind === 'create' && mode === 'expense';
  const [ccMode, setCcMode] = useState(false);
  const [ccTargetName, setCcTargetName] = useState('');
  const [ccCategoryId, setCcCategoryId] = useState('');
  const [ccNameError, setCcNameError] = useState(false);
  const canFixedMonthly =
    init.kind === 'create' && mode === 'expense' && !ccMode && destRole === 'fixed-asset';
  const [fixedMonthly, setFixedMonthly] = useState(false);
  const [monthlyCategoryId, setMonthlyCategoryId] = useState('');
  const [categoryError, setCategoryError] = useState(false);
  const allocationActive = (canAllocate && ccMode) || (canFixedMonthly && fixedMonthly);
  const [monthsText, setMonthsText] = useState('');
  const [monthsError, setMonthsError] = useState(false);
  const months = monthsText === '' ? 0 : Number.parseInt(monthsText, 10);
  const [continueCost, setContinueCost] = useState(false);
  const [repayToggle, setRepayToggle] = useState(false);
  const [repayAccountId, setRepayAccountId] = useState('');
  const [repayCountText, setRepayCountText] = useState('');
  const [repayStartDate, setRepayStartDate] = useState('');
  const [repayAccountError, setRepayAccountError] = useState(false);
  const [repayCountError, setRepayCountError] = useState(false);
  const paymentRole = accounts.find((a) => a.id === form.creditAccountId)?.role;
  const isLiabilityPayment =
    paymentRole === 'payment-liability' || paymentRole === 'other-liability';
  const [showDetails, setShowDetails] = useState(init.kind === 'edit');

  const canCreateReserve = init.kind === 'create' && mode === 'transfer';
  const [reserveMode, setReserveMode] = useState(false);
  const [reserveName, setReserveName] = useState('');
  const [reserveNameError, setReserveNameError] = useState(false);
  const canArrangeLoan = init.kind === 'create' && mode === 'expense';
  const [loanMode, setLoanMode] = useState(false);
  const [liabilitySheetOpen, setLiabilitySheetOpen] = useState(false);

  const snapshot = JSON.stringify({
    form,
    amountText,
    ccMode,
    ccTargetName,
    ccCategoryId,
    reserveMode,
    reserveName,
    loanMode,
    fixedMonthly,
    monthlyCategoryId,
    monthsText,
    continueCost,
    repayToggle,
    repayAccountId,
    repayCountText,
    repayStartDate,
  });
  const [initialSnapshot] = useState(snapshot);
  const dirty = snapshot !== initialSnapshot;
  const { requestClose, discardConfirm } = useDirtyGuard(dirty, onClose);

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
    return mode;
  }

  function nameOfSide(id: string): string {
    if (id.startsWith('reserve:'))
      return reserves.find((r) => r.id === id.slice('reserve:'.length))?.name ?? '—';
    return accounts.find((a) => a.id === id)?.name ?? '—';
  }
  function effectiveForm(): SimpleEntryInput {
    if (mode !== 'transfer' || form.description.trim() !== '') return form;
    const auto = `${nameOfSide(form.creditAccountId)} → ${nameOfSide(form.debitAccountId)}`;
    return { ...form, description: auto };
  }

  function validateRepay(blockActive: boolean): { accBad: boolean; countBad: boolean } {
    const active = blockActive && repayToggle;
    const count = repayCountText === '' ? 0 : Number.parseInt(repayCountText, 10);
    const accBad = active && repayAccountId === '';
    const countBad = active && (!Number.isInteger(count) || count < 1);
    setRepayAccountError(accBad);
    setRepayCountError(countBad);
    return { accBad, countBad };
  }

  async function onSave() {
    const base = effectiveForm();
    const srcResolved = resolveReserveSide(base.creditAccountId);
    const dstResolved = resolveReserveSide(base.debitAccountId);
    const selectedReserveId = srcResolved.reserveId ?? dstResolved.reserveId;
    const toSave = {
      ...base,
      creditAccountId: srcResolved.accountId,
      debitAccountId: dstResolved.accountId,
      managementScopeId: base.managementScopeId ?? scopes[0]?.id,
    };

    const ccActive = canAllocate && ccMode;
    if (ccActive) {
      const found: EntryValidationError[] = [];
      if (toSave.date.trim() === '') found.push('date-required');
      if (!Number.isInteger(toSave.amount) || toSave.amount < 1) found.push('amount-invalid');
      if (toSave.creditAccountId === '') found.push('credit-required');
      setErrors(found);
      const nameBad = ccTargetName.trim() === '';
      setCcNameError(nameBad);
      const categoryBad = ccCategoryId === '';
      setCategoryError(categoryBad);
      const monthsBad = !Number.isInteger(months) || months < 1;
      setMonthsError(monthsBad);
      const { accBad, countBad } = validateRepay(isLiabilityPayment);
      setFlowError(undefined);
      if (found.length > 0 || nameBad || categoryBad || monthsBad || accBad || countBad) return;
      setSubmitting(true);
      try {
        const repeat = continueCost ? months : undefined;
        const repayCount = repayCountText === '' ? 0 : Number.parseInt(repayCountText, 10);
        const useRepay =
          isLiabilityPayment && repayToggle && repayAccountId !== '' && repayCount >= 1;
        const repayFields = useRepay
          ? {
              repaymentAccountId: repayAccountId,
              repaymentCount: repayCount,
              repaymentStartDate: repayStartDate || toSave.date,
            }
          : {};
        const scopeField =
          toSave.managementScopeId !== undefined
            ? { managementScopeId: toSave.managementScopeId }
            : {};
        await createContinuousCost({
          name: ccTargetName.trim(),
          ...scopeField,
          kind: inferMonthlyCostKind(months, repeat),
          amount: toSave.amount,
          costMonths: months,
          ...(repeat !== undefined ? { repeatEveryMonths: repeat } : {}),
          startMonth: monthOf(toSave.date),
          expenseAccountId: ccCategoryId,
          paymentSourceAccountId: toSave.creditAccountId,
          ...repayFields,
        });
        onClose();
      } catch {
        setSubmitting(false);
      }
      return;
    }

    const reserveActive = canCreateReserve && reserveMode;
    if (reserveActive) {
      const found: EntryValidationError[] = [];
      if (toSave.date.trim() === '') found.push('date-required');
      if (!Number.isInteger(toSave.amount) || toSave.amount < 1) found.push('amount-invalid');
      if (toSave.creditAccountId === '') found.push('credit-required');
      setErrors(found);
      const nameBad = reserveName.trim() === '';
      setReserveNameError(nameBad);
      setFlowError(undefined);
      if (found.length > 0 || nameBad) return;
      setSubmitting(true);
      try {
        const reserve = await createReserve({
          name: reserveName.trim(),
          parentAccountId: toSave.creditAccountId,
        });
        const srcName = accounts.find((a) => a.id === toSave.creditAccountId)?.name ?? '—';
        const description =
          form.description.trim() !== '' ? form.description : `${srcName} → ${reserveName.trim()}`;
        const metadata: EntryMetadata = {
          ...toSave.metadata,
          inputMode: 'transfer',
          reserveId: reserve.id,
        };
        await saveEntry({
          ...toSave,
          description,
          debitAccountId: reserve.reserveAccountId,
          metadata,
        });
        onClose();
      } catch {
        setSubmitting(false);
      }
      return;
    }

    const found = validateSimpleEntry(toSave);
    setErrors(found);
    const useFixedMonthly = canFixedMonthly && fixedMonthly;
    const monthsBad = useFixedMonthly && (!Number.isInteger(months) || months < 1);
    setMonthsError(monthsBad);
    const categoryBad = useFixedMonthly && monthlyCategoryId === '';
    setCategoryError(categoryBad);
    const { accBad, countBad } = validateRepay(useFixedMonthly && isLiabilityPayment);
    if (found.length > 0 || monthsBad || categoryBad || accBad || countBad) return;
    if (mode === 'expense' && !useFixedMonthly) {
      const srcRole = accounts.find((a) => a.id === toSave.creditAccountId)?.role;
      if (srcRole === 'other-liability') {
        setFlowError(t('entry.error.loanNotExpense'));
        return;
      }
    }
    if (mode === 'transfer') {
      const srcRole = accounts.find((a) => a.id === toSave.creditAccountId)?.role;
      const dstRole = accounts.find((a) => a.id === toSave.debitAccountId)?.role;
      const ok = !!srcRole && !!dstRole && transferFlowValid(srcRole, dstRole);
      setFlowError(ok ? undefined : t('entry.error.invalid-transfer'));
      if (!ok) return;
    } else {
      setFlowError(undefined);
    }
    setSubmitting(true);
    try {
      if (useFixedMonthly) {
        const repeat = continueCost ? months : undefined;
        const repayCount = repayCountText === '' ? 0 : Number.parseInt(repayCountText, 10);
        const useRepay =
          isLiabilityPayment && repayToggle && repayAccountId !== '' && repayCount >= 1;
        const metadata: EntryMetadata = { ...toSave.metadata, inputMode: 'expense' };
        await saveEntryWithFixedAssetMonthly(
          { ...toSave, metadata },
          {
            name: toSave.description,
            kind: inferMonthlyCostKind(months, repeat),
            amount: toSave.amount,
            costMonths: months,
            ...(repeat !== undefined ? { repeatEveryMonths: repeat } : {}),
            startMonth: monthOf(toSave.date),
            expenseAccountId: monthlyCategoryId,
            recognitionCreditAccountId: toSave.debitAccountId,
            ...(useRepay
              ? {
                  repaymentAccountId: repayAccountId,
                  repaymentCount: repayCount,
                  repaymentStartDate: repayStartDate || form.date,
                }
              : {}),
          },
        );
      } else {
        const metadata: EntryMetadata = {
          ...toSave.metadata,
          inputMode: resolveInputMode(),
          ...(selectedReserveId ? { reserveId: selectedReserveId } : {}),
        };
        await saveEntry({ ...toSave, metadata }, existing);
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

  const itemField = (
    <TextInput
      label={t('entry.item')}
      required={mode !== 'transfer'}
      value={form.description}
      placeholder={t('entry.itemPlaceholder')}
      onChange={(v) => setForm((f) => ({ ...f, description: v }))}
      error={errorText(errors, 'description-required')}
      dataUi={UI.journal.entry.item}
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
      tags={tagsForEntry(tags, form.tagIds ?? [])}
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

  const currentScopeId = form.managementScopeId ?? scopes[0]?.id;
  const scopeField =
    scopes.length > 1 ? (
      <SelectInput
        label={t('entry.managementScope')}
        value={currentScopeId ?? ''}
        onChange={(id) => setForm((f) => ({ ...f, managementScopeId: id }))}
        options={scopes.map((s) => ({ value: s.id, label: s.name }))}
      />
    ) : null;

  const renderInstrument = (side: 'debit' | 'credit') => {
    const accId = side === 'debit' ? form.debitAccountId : form.creditAccountId;
    if (!accId) return null;
    const opts = instruments.filter(
      (i) => i.accountId === accId && i.managementScopeId === currentScopeId && !i.archived,
    );
    if (opts.length === 0) return null;
    const accName = accounts.find((a) => a.id === accId)?.name ?? '';
    const value = (side === 'debit' ? form.debitInstrumentId : form.creditInstrumentId) ?? '';
    return (
      <SelectInput
        label={`${t('entry.instrument')}: ${accName}`}
        value={value}
        onChange={(id) =>
          setForm((f) => ({
            ...f,
            [side === 'debit' ? 'debitInstrumentId' : 'creditInstrumentId']: id || undefined,
          }))
        }
        options={[
          { value: '', label: t('entry.instrumentNone') },
          ...opts.map((i) => ({ value: i.id, label: i.name })),
        ]}
      />
    );
  };

  const flowDef = isManual ? null : MODE_FLOW[mode as FlowMode];
  const renderFlow = () => {
    if (!flowDef) return null;
    const resGroup = reserveOptionGroup();
    const srcReserve = resGroup && (mode === 'transfer' || mode === 'expense') ? [resGroup] : [];
    const dstReserve = resGroup && mode === 'transfer' ? [resGroup] : [];
    const srcGroups = [
      ...groupedAccountsByRole(accounts, [...flowDef.source.allowedRoles], form.creditAccountId),
      ...srcReserve,
    ];
    const dstGroups = [
      ...groupedAccountsByRole(
        accounts,
        [...flowDef.destination.allowedRoles],
        form.debitAccountId,
      ),
      ...dstReserve,
    ];
    const loanGroups = groupedAccountsByRole(accounts, ['other-liability'], form.creditAccountId);
    return (
      <div className="field" data-ui={UI.journal.entry.flow}>
        <span className="field__hint">{t(flowDef.flowLabelKey)}</span>
        <div className="flow">
          <div className="flow__side">
            {canArrangeLoan && loanMode ? (
              <>
                <AccountPicker
                  flat
                  label={t('entry.loanArrangePick')}
                  required
                  value={form.creditAccountId}
                  groups={loanGroups}
                  onChange={(id) => setSide('credit', id)}
                  emptyText={t('entry.loanArrangeEmpty')}
                  error={errorText(errors, 'credit-required') ?? sameAccount}
                  dataUi={UI.journal.entry.flowSource}
                />
                <button
                  type="button"
                  className="collapse-toggle"
                  onClick={() => setLiabilitySheetOpen(true)}
                  data-ui={UI.journal.entry.liabilityCreate}
                >
                  <Icon name="add" size={16} />
                  {t('entry.loanArrangeCreate')}
                </button>
                <button
                  type="button"
                  className="collapse-toggle"
                  onClick={() => setLoanMode(false)}
                >
                  {t('entry.loanArrangeBack')}
                </button>
              </>
            ) : (
              <>
                <AccountPicker
                  flat
                  label={t(flowDef.source.labelKey)}
                  required
                  value={form.creditAccountId}
                  groups={srcGroups}
                  onChange={(id) => setSide('credit', id)}
                  error={errorText(errors, 'credit-required') ?? sameAccount}
                  dataUi={UI.journal.entry.flowSource}
                />
                {canArrangeLoan ? (
                  <button
                    type="button"
                    className="collapse-toggle"
                    onClick={() => setLoanMode(true)}
                    data-ui={UI.journal.entry.loanArrange}
                  >
                    <Icon name="add" size={16} />
                    {t('entry.loanArrange')}
                  </button>
                ) : null}
              </>
            )}
          </div>
          <div className="flow__arrow" aria-hidden="true">
            →
          </div>
          <div className="flow__side">
            {canAllocate && ccMode ? (
              <>
                <TextInput
                  label={t('entry.ccTargetName')}
                  required
                  value={ccTargetName}
                  placeholder={t('entry.ccTargetName')}
                  hint={t('entry.ccTargetNameHint')}
                  onChange={setCcTargetName}
                  error={ccNameError ? t('entry.error.description-required') : undefined}
                  dataUi={UI.journal.entry.ccName}
                />
                <button type="button" className="collapse-toggle" onClick={() => setCcMode(false)}>
                  {t('entry.ccBackToCategory')}
                </button>
              </>
            ) : canCreateReserve && reserveMode ? (
              <>
                <TextInput
                  label={t('entry.reserveTargetName')}
                  required
                  value={reserveName}
                  placeholder={t('entry.reserveTargetName')}
                  hint={t('entry.reserveTargetNameHint')}
                  onChange={setReserveName}
                  error={reserveNameError ? t('entry.error.description-required') : undefined}
                  dataUi={UI.journal.entry.reserveName}
                />
                <button
                  type="button"
                  className="collapse-toggle"
                  onClick={() => setReserveMode(false)}
                >
                  {t('entry.reserveBack')}
                </button>
              </>
            ) : (
              <>
                <AccountPicker
                  flat
                  label={t(flowDef.destination.labelKey)}
                  required
                  value={form.debitAccountId}
                  groups={dstGroups}
                  onChange={(id) => setSide('debit', id)}
                  error={errorText(errors, 'debit-required')}
                  dataUi={UI.journal.entry.flowDestination}
                />
                {canAllocate ? (
                  <button
                    type="button"
                    className="collapse-toggle"
                    onClick={() => {
                      setCcMode(true);
                      if (ccTargetName.trim() === '') setCcTargetName(form.description);
                    }}
                    data-ui={UI.journal.entry.ccToggle}
                  >
                    <Icon name="add" size={16} />
                    {t('entry.ccToggle')}
                  </button>
                ) : null}
                {canCreateReserve ? (
                  <button
                    type="button"
                    className="collapse-toggle"
                    onClick={() => {
                      setReserveMode(true);
                      if (reserveName.trim() === '') setReserveName(form.description);
                    }}
                    data-ui={UI.journal.entry.reserveCreate}
                  >
                    <Icon name="add" size={16} />
                    {t('entry.reserveCreate')}
                  </button>
                ) : null}
              </>
            )}
          </div>
        </div>
      </div>
    );
  };

  const renderManualFlow = () => {
    const creditRole = roles.find((role) => role.side === 'credit');
    const debitRole = roles.find((role) => role.side === 'debit');
    if (!creditRole || !debitRole) return null;
    const srcGroups = groupedAccountsByRole(
      accounts,
      [...creditRole.allowedRoles],
      form.creditAccountId,
    );
    const dstGroups = groupedAccountsByRole(
      accounts,
      [...debitRole.allowedRoles],
      form.debitAccountId,
    );
    return (
      <div className="field" data-ui={UI.journal.entry.flow}>
        <span className="field__hint">{t('entry.flow.manual')}</span>
        <div className="flow">
          <div className="flow__side">
            <AccountPicker
              flat
              label={t('entry.source.manual')}
              required
              value={form.creditAccountId}
              groups={srcGroups}
              onChange={(id) => setSide('credit', id)}
              error={errorText(errors, 'credit-required') ?? sameAccount}
              dataUi={UI.journal.entry.flowSource}
            />
            {renderInstrument('credit')}
          </div>
          <div className="flow__arrow" aria-hidden="true">
            →
          </div>
          <div className="flow__side">
            <AccountPicker
              flat
              label={t('entry.destination.manual')}
              required
              value={form.debitAccountId}
              groups={dstGroups}
              onChange={(id) => setSide('debit', id)}
              error={errorText(errors, 'debit-required')}
              dataUi={UI.journal.entry.flowDestination}
            />
            {renderInstrument('debit')}
          </div>
        </div>
      </div>
    );
  };

  const ccDetailField =
    canAllocate && ccMode ? (
      <div className="field">
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
        <AccountPicker
          label={t('entry.ccCategory')}
          required
          value={ccCategoryId}
          groups={groupedAccountsByRole(accounts, ['expense-category'], ccCategoryId)}
          onChange={setCcCategoryId}
          error={categoryError ? t('entry.error.category-required') : undefined}
          dataUi={UI.journal.entry.ccCategory}
        />
        <label
          style={{ display: 'inline-flex', gap: 8, alignItems: 'center', minHeight: 'var(--tap)' }}
        >
          <input
            type="checkbox"
            checked={continueCost}
            onChange={(e) => setContinueCost(e.target.checked)}
            data-ui={UI.journal.entry.monthlyizeContinue}
          />
          {t('entry.monthlyizeContinue')}
        </label>
        <p className="field__hint">{t('entry.ccNote')}</p>
      </div>
    ) : null;

  const fixedMonthlyField = canFixedMonthly ? (
    <div className="field">
      <label
        style={{ display: 'inline-flex', gap: 8, alignItems: 'center', minHeight: 'var(--tap)' }}
      >
        <input
          type="checkbox"
          checked={fixedMonthly}
          onChange={(e) => setFixedMonthly(e.target.checked)}
          data-ui={UI.journal.entry.fixedMonthlyToggle}
        />
        {t('entry.fixedMonthlyToggle')}
      </label>
      {fixedMonthly ? (
        <div className="card card--pad" style={{ marginTop: 'var(--space-2)' }}>
          <p className="field__hint" style={{ marginBottom: 'var(--space-2)' }}>
            {t('entry.fixedMonthlyNote')}
          </p>
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
          <AccountPicker
            label={t('entry.fixedMonthlyCategory')}
            required
            value={monthlyCategoryId}
            groups={groupedAccountsByRole(accounts, ['expense-category'], monthlyCategoryId)}
            onChange={setMonthlyCategoryId}
            error={categoryError ? t('entry.error.category-required') : undefined}
            dataUi={UI.journal.entry.fixedMonthlyCategory}
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
            />
            {t('entry.monthlyizeContinue')}
          </label>
        </div>
      ) : null}
    </div>
  ) : null;

  const repaymentField =
    allocationActive && isLiabilityPayment ? (
      <div className="field">
        <label
          style={{ display: 'inline-flex', gap: 8, alignItems: 'center', minHeight: 'var(--tap)' }}
        >
          <input
            type="checkbox"
            checked={repayToggle}
            onChange={(e) => setRepayToggle(e.target.checked)}
            data-ui={UI.journal.entry.monthlyizeRepayToggle}
          />
          {t('entry.monthlyizeRepayToggle')}
        </label>
        {repayToggle ? (
          <div className="card card--pad" style={{ marginTop: 'var(--space-2)' }}>
            <p className="field__hint" style={{ marginBottom: 'var(--space-2)' }}>
              {t('entry.monthlyizeRepayNote')}
            </p>
            <AccountPicker
              label={t('entry.monthlyizeRepayAccount')}
              value={repayAccountId}
              groups={groupedAccountsByRole(accounts, ['daily-asset'], repayAccountId)}
              onChange={setRepayAccountId}
              error={repayAccountError ? t('entry.error.repayAccount') : undefined}
              dataUi={UI.journal.entry.monthlyizeRepayAccount}
            />
            <TextInput
              label={t('entry.monthlyizeRepayCount')}
              inputMode="numeric"
              value={repayCountText}
              onChange={(v) => setRepayCountText(v.replace(/[^\d]/g, ''))}
              error={repayCountError ? t('entry.error.repayCount') : undefined}
              dataUi={UI.journal.entry.monthlyizeRepayCount}
            />
            <TextInput
              label={t('entry.monthlyizeRepayStart')}
              type="date"
              value={repayStartDate}
              hint={t('entry.monthlyizeRepayStartHint')}
              onChange={setRepayStartDate}
              dataUi={UI.journal.entry.monthlyizeRepayStart}
            />
          </div>
        ) : null}
      </div>
    ) : null;

  const manualSwitch =
    init.kind === 'create' && mode !== 'manual' && !ccMode ? (
      <button
        type="button"
        className="collapse-toggle"
        onClick={() => setMode('manual')}
        data-ui={UI.journal.entry.manualSwitch}
      >
        <Icon name="expand" size={16} />
        {t('entry.manualSwitch')}
      </button>
    ) : null;

  return (
    <>
      <Modal
        title={title}
        onClose={requestClose}
        dismissMode="if-clean"
        variant="dialog"
        titleVariant="sr-only"
        scrollKey={mode}
        footer={
          <>
            <button
              type="button"
              className="btn btn--ghost"
              onClick={requestClose}
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

        {flowError ? (
          <div
            className="field__error"
            role="alert"
            style={{ marginBottom: 'var(--space-3)' }}
            data-ui={UI.journal.entry.flowError}
          >
            <Icon name="alert" size={14} />
            {flowError}
          </div>
        ) : null}

        {isManual ? (
          <>
            {dateField}
            {descriptionField}
            {amountField}
            {renderManualFlow()}
            {memoField}
            {scopeField}
            {entryTagsField}
          </>
        ) : (
          <>
            {dateField}
            {mode === 'transfer' || (canAllocate && ccMode) ? null : itemField}
            {amountField}
            {renderFlow()}
            {ccDetailField}
            {fixedMonthlyField}
            {repaymentField}

            {allocationActive ? null : (
              <>
                <button
                  type="button"
                  className="collapse-toggle"
                  aria-expanded={showDetails}
                  onClick={() => setShowDetails((v) => !v)}
                  data-ui={UI.journal.entry.detailToggle}
                >
                  <Icon name={showDetails ? 'expand' : 'chevronRight'} size={16} />
                  {t('entry.detailToggle')}
                </button>
                {showDetails ? (
                  <div className="stack">
                    {mode === 'transfer' ? itemField : null}
                    {memoField}
                    {scopeField}
                    {entryTagsField}
                    {roles.map((role) => (
                      <div key={role.side}>{renderInstrument(role.side)}</div>
                    ))}
                  </div>
                ) : null}
              </>
            )}

            {manualSwitch}
          </>
        )}
      </Modal>
      {discardConfirm}

      {liabilitySheetOpen ? (
        <LiabilitySheet
          defaultRole="other-liability"
          onClose={() => setLiabilitySheetOpen(false)}
          onSave={async (account) => {
            await saveAccount(account);
            setSide('credit', account.id);
            setLoanMode(true);
          }}
        />
      ) : null}
    </>
  );
}
