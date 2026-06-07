/*
 * 仕訳の入力シート。
 *
 * 日常入力（収入/支出/振替）は借方/貸方を意識させず、「お金の流れ」`源泉 → 行き先` で見せる。
 * 並びは人間の入力順: 日付 → 項目 → 金額 → お金の流れ(A → B) → 詳細。内部は常に複式で、
 * source=貸方(credit) / destination=借方(debit) に対応する（MODE_FLOW）。
 *  - 種別(normal/opening)・資産/負債/収益/費用の分類見出しは通常入力に出さない。
 *  - 「詳細入力」で借方/貸方を直接指定する manual モードへ切替できる（主導線ではない）。
 *  - 編集は元の入力モードを推定して開く。取消/返金(reversal)は manual で逆仕訳を見せる。
 */
import { useRef, useState } from 'react';
import { Modal } from '../Modal';
import { useDirtyGuard } from '../useDirtyGuard';
import { TextArea, TextInput } from '../Field';
import { AccountPicker } from '../AccountPicker';
import { TagPicker } from '../TagPicker';
import { ReserveSheet } from '../ReserveSheet';
import { LiabilitySheet } from '../LiabilitySheet';
import { groupedAccountsByRole } from '../accountOptions';
import type { AccountRole } from '../../domain/accountRoles';
import { tagsForScope } from '../tagOptions';
import {
  FORM_MODE_TITLE,
  MODE_FLOW,
  MODE_ROLES,
  type FlowMode,
  type FormMode,
} from '../entryModes';
import { monthOf } from '../../domain/allocation';
import { inferMonthlyCostKind } from '../../domain/monthlyCost';
import { buildRepaymentSchedules } from '../../domain/cashflow';
import { useLedger } from '../../state/store';
import {
  reversalInput,
  toSimpleInput,
  transferFlowValid,
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
  const {
    ledger,
    saveEntry,
    saveEntryWithSchedules,
    saveEntryWithFixedAssetMonthly,
    createMonthlyCost,
    createReserve,
    saveAccount,
  } = useLedger();
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
  const [flowError, setFlowError] = useState<string | undefined>(undefined);
  const [submitting, setSubmitting] = useState(false);

  // 行き先(debit)の役割。費用カテゴリのときだけ「月額化」（通常費用版）を出す。
  const destRole = accounts.find((a) => a.id === form.debitAccountId)?.role;
  // 月額化コスト（expense × 費用カテゴリ × create のみ）。固定資産購入の月額化は別扱い（P7）。
  const canAllocate =
    init.kind === 'create' && mode === 'expense' && destRole === 'expense-category';
  const [allocate, setAllocate] = useState(false);
  // 固定資産購入（expense × 固定資産 × create）は「生活コストとして月額化」できる（別トグル）。
  const canFixedMonthly =
    init.kind === 'create' && mode === 'expense' && destRole === 'fixed-asset';
  const [fixedMonthly, setFixedMonthly] = useState(false);
  const [monthlyCategoryId, setMonthlyCategoryId] = useState('');
  const [categoryError, setCategoryError] = useState(false);
  // 月額化 ON のときはタグを付けられない（createMonthlyCost はタグを受け取らないため）。
  const allocationActive = (canAllocate && allocate) || (canFixedMonthly && fixedMonthly);
  const [monthsText, setMonthsText] = useState('');
  const [monthsError, setMonthsError] = useState(false);
  const months = monthsText === '' ? 0 : Number.parseInt(monthsText, 10);
  // 月額化の詳細（種類は入力から推定する）
  const [continueCost, setContinueCost] = useState(false);
  // liability 払いの返済 CF（支払い元の近くで入力する）
  const [repayToggle, setRepayToggle] = useState(false);
  const [repayAccountId, setRepayAccountId] = useState('');
  const [repayCountText, setRepayCountText] = useState('');
  const [repayStartDate, setRepayStartDate] = useState('');
  // 支払い元(credit)が支払用負債なら返済 CF を入力できる。
  const paymentRole = accounts.find((a) => a.id === form.creditAccountId)?.role;
  const isLiabilityPayment = paymentRole === 'payment-liability';
  // 振替で源泉(credit)が負債 = 借入・ローン実行。任意で分割返済予定を一緒に登録できる。
  const isLoanDraw =
    init.kind === 'create' &&
    mode === 'transfer' &&
    (paymentRole === 'payment-liability' || paymentRole === 'other-liability');
  // 詳細（メモ・タグ）は折りたたみ。編集時は既存値が見えるよう開いておく。
  const [showDetails, setShowDetails] = useState(init.kind === 'edit');

  // 支出/振替で目的別資金・負債は既定で候補に出さない。必要時だけトグルで表示し、その場で作る。
  // 編集時に既選択が reserve/liability なら初期表示（includeId で常に見えるが状態も合わせる）。
  const roleOf = (id: string) => accounts.find((a) => a.id === id)?.role;
  const [showReserve, setShowReserve] = useState(() =>
    [form.creditAccountId, form.debitAccountId].map(roleOf).includes('reserve-asset'),
  );
  const [showLiability, setShowLiability] = useState(() =>
    [form.creditAccountId, form.debitAccountId]
      .map(roleOf)
      .some((r) => r === 'payment-liability' || r === 'other-liability'),
  );
  const [reserveSheetOpen, setReserveSheetOpen] = useState(false);
  const [liabilitySheetOpen, setLiabilitySheetOpen] = useState(false);

  // 編集状態の検出: 入力フィールドのスナップショットを初期値と比較する。
  const snapshot = JSON.stringify({
    form,
    amountText,
    allocate,
    fixedMonthly,
    monthlyCategoryId,
    monthsText,
    continueCost,
    repayToggle,
    repayAccountId,
    repayCountText,
    repayStartDate,
  });
  const initialSnapshotRef = useRef<string | null>(null);
  if (initialSnapshotRef.current === null) initialSnapshotRef.current = snapshot;
  const dirty = snapshot !== initialSnapshotRef.current;
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
    return mode; // create
  }

  // 振替で項目未入力なら「移動元 → 移動先」を自動生成する。
  function effectiveForm(): SimpleEntryInput {
    if (mode !== 'transfer' || form.description.trim() !== '') return form;
    const nameOf = (id: string) => accounts.find((a) => a.id === id)?.name ?? '—';
    const auto = `${nameOf(form.creditAccountId)} → ${nameOf(form.debitAccountId)}`;
    return { ...form, description: auto };
  }

  async function onSave() {
    const toSave = effectiveForm();
    const found = validateSimpleEntry(toSave);
    setErrors(found);
    const useMonthly = canAllocate && allocate;
    const useFixedMonthly = canFixedMonthly && fixedMonthly;
    // costMonths は 1 以上（サブスクは 1 か月）。
    const monthsBad = (useMonthly || useFixedMonthly) && (!Number.isInteger(months) || months < 1);
    setMonthsError(monthsBad);
    // 固定資産の月額化は、月割り先の費用カテゴリが必須。
    const categoryBad = useFixedMonthly && monthlyCategoryId === '';
    setCategoryError(categoryBad);
    if (found.length > 0 || monthsBad || categoryBad) return;
    // 振替は役割の組み合わせを検証する（資金↔資金 / 資金→負債返済 / 負債→資金借入のみ）。
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
      if (useMonthly) {
        // 「継続・買い替えする」= 周期更新（repeatEveryMonths = costMonths）。
        const repeat = continueCost ? months : undefined;
        const repayCount = repayCountText === '' ? 0 : Number.parseInt(repayCountText, 10);
        const useRepay =
          isLiabilityPayment && repayToggle && repayAccountId !== '' && repayCount >= 1;
        // 支出フォームの debit=費用カテゴリ / credit=支払い元 をそのまま月額化に渡す。
        await createMonthlyCost({
          name: toSave.description,
          kind: inferMonthlyCostKind(months, repeat),
          amount: toSave.amount,
          costMonths: months,
          ...(repeat !== undefined ? { repeatEveryMonths: repeat } : {}),
          startMonth: monthOf(toSave.date),
          date: toSave.date,
          expenseAccountId: toSave.debitAccountId,
          paymentAccountId: toSave.creditAccountId,
          ...(useRepay
            ? {
                repaymentAccountId: repayAccountId,
                repaymentCount: repayCount,
                // 購入日(form.date)とは別に、初回引落日を使う。
                repaymentStartDate: repayStartDate || form.date,
              }
            : {}),
        });
      } else if (useFixedMonthly) {
        // 固定資産購入（借方 固定資産 / 貸方 資金 or 負債）+ 月額化コストを一括保存。購入仕訳が実体で、
        // 月額化は支払い仕訳を作らず formula 認識のみ（recognitionCreditAccountId=固定資産）。
        // 負債払いで返済入力があれば、購入仕訳の貸方負債を取り崩す返済予定 CF も同時に作る。
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
                  // 購入日(form.date)とは別に、初回引落日を使う。
                  repaymentStartDate: repayStartDate || form.date,
                }
              : {}),
          },
        );
      } else {
        const metadata: EntryMetadata = { ...toSave.metadata, inputMode: resolveInputMode() };
        const entryInput = { ...toSave, metadata };
        const repayCount = repayCountText === '' ? 0 : Number.parseInt(repayCountText, 10);
        const useLoanRepay = isLoanDraw && repayToggle && repayAccountId !== '' && repayCount >= 1;
        if (useLoanRepay) {
          // 借入実行（借方 資金 / 貸方 負債）+ 分割返済予定（返済元 → 負債 の outflow）を一括保存。
          const schedules = buildRepaymentSchedules({
            title: toSave.description,
            total: toSave.amount,
            count: repayCount,
            firstDueDate: repayStartDate || toSave.date,
            fromAccountId: repayAccountId,
            liabilityAccountId: toSave.creditAccountId,
          });
          await saveEntryWithSchedules(entryInput, schedules);
        } else {
          await saveEntry(entryInput, existing);
        }
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

  // 日常入力では「摘要」をユーザー向けに「項目」と呼ぶ。振替は任意。
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

  // お金の流れ（源泉 → 行き先）。簿記用語を出さず、左=貸方 / 右=借方。
  const flowDef = isManual ? null : MODE_FLOW[mode as FlowMode];
  const renderFlow = () => {
    if (!flowDef) return null;
    // トグルで明示したときだけ目的別資金・負債を候補に足す（既選択は includeId で常に表示）。
    const extras: AccountRole[] = [];
    if (showReserve) extras.push('reserve-asset');
    if (showLiability) extras.push('payment-liability', 'other-liability');
    // 支出は支払い方法(source)のみ拡張。振替は源泉/行き先の両方を拡張。
    const srcExtra = mode === 'expense' || mode === 'transfer' ? extras : [];
    const dstExtra = mode === 'transfer' ? extras : [];
    const srcGroups = groupedAccountsByRole(
      accounts,
      [...flowDef.source.allowedRoles, ...srcExtra],
      form.creditAccountId,
    );
    const dstGroups = groupedAccountsByRole(
      accounts,
      [...flowDef.destination.allowedRoles, ...dstExtra],
      form.debitAccountId,
    );
    return (
      <div className="field" data-ui={UI.journal.entry.flow}>
        <span className="field__hint">{t(flowDef.flowLabelKey)}</span>
        <div className="flow">
          <div className="flow__side">
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
          </div>
          <div className="flow__arrow" aria-hidden="true">
            →
          </div>
          <div className="flow__side">
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
          </div>
        </div>
      </div>
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
          <p className="field__hint">{t('entry.monthlyizeNote')}</p>
        </>
      ) : null}
    </div>
  ) : null;

  // 固定資産の購入を「生活コストとして月額化」する（購入仕訳とは別に formula 認識）。
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

  // 支払い元が負債のときだけ、支払い元の近くに「分割/後日引落を資金繰りに入れる」を出す。
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
              dataUi={UI.journal.entry.monthlyizeRepayAccount}
            />
            <TextInput
              label={t('entry.monthlyizeRepayCount')}
              inputMode="numeric"
              value={repayCountText}
              onChange={(v) => setRepayCountText(v.replace(/[^\d]/g, ''))}
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

  // 借入・ローン実行（振替で源泉が負債）のとき、任意で分割返済予定を一緒に登録できる。
  const loanRepaymentField = isLoanDraw ? (
    <div className="field" data-ui={UI.journal.entry.loanRepayToggle}>
      <label
        style={{ display: 'inline-flex', gap: 8, alignItems: 'center', minHeight: 'var(--tap)' }}
      >
        <input
          type="checkbox"
          checked={repayToggle}
          onChange={(e) => setRepayToggle(e.target.checked)}
        />
        {t('entry.loanRepayToggle')}
      </label>
      {repayToggle ? (
        <div className="card card--pad" style={{ marginTop: 'var(--space-2)' }}>
          <p className="field__hint" style={{ marginBottom: 'var(--space-2)' }}>
            {t('entry.loanRepayNote')}
          </p>
          <AccountPicker
            label={t('entry.loanRepayAccount')}
            value={repayAccountId}
            groups={groupedAccountsByRole(accounts, ['daily-asset'], repayAccountId)}
            onChange={setRepayAccountId}
            dataUi={UI.journal.entry.loanRepayAccount}
          />
          <TextInput
            label={t('entry.loanRepayCount')}
            inputMode="numeric"
            value={repayCountText}
            onChange={(v) => setRepayCountText(v.replace(/[^\d]/g, ''))}
            dataUi={UI.journal.entry.loanRepayCount}
          />
          <TextInput
            label={t('entry.loanRepayStart')}
            type="date"
            value={repayStartDate}
            hint={t('entry.loanRepayStartHint')}
            onChange={setRepayStartDate}
            dataUi={UI.journal.entry.loanRepayStart}
          />
        </div>
      ) : null}
    </div>
  ) : null;

  // 支出/振替で、目的別資金・負債を候補に出すトグルと、その場で作る導線。
  // 既定では daily-asset 中心。目的別資金が増えても通常入力を軽く保つ。
  const flowExtras =
    mode === 'expense' || mode === 'transfer' ? (
      <div className="field stack" style={{ gap: 'var(--space-2)' }}>
        <div
          style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)', flexWrap: 'wrap' }}
        >
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
              checked={showReserve}
              onChange={(e) => setShowReserve(e.target.checked)}
              data-ui={UI.journal.entry.reserveToggle}
            />
            {t('entry.reserveToggle')}
          </label>
          {mode === 'transfer' ? (
            <button
              type="button"
              className="btn btn--ghost"
              style={{ minHeight: 36 }}
              onClick={() => setReserveSheetOpen(true)}
              data-ui={UI.journal.entry.reserveCreate}
            >
              <Icon name="plus" size={16} />
              {t('entry.reserveCreate')}
            </button>
          ) : null}
        </div>
        <div
          style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)', flexWrap: 'wrap' }}
        >
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
              checked={showLiability}
              onChange={(e) => setShowLiability(e.target.checked)}
              data-ui={UI.journal.entry.liabilityToggle}
            />
            {t('entry.liabilityToggle')}
          </label>
          <button
            type="button"
            className="btn btn--ghost"
            style={{ minHeight: 36 }}
            onClick={() => setLiabilitySheetOpen(true)}
            data-ui={UI.journal.entry.liabilityCreate}
          >
            <Icon name="plus" size={16} />
            {t('entry.liabilityCreate')}
          </button>
        </div>
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
    <>
      <Modal
        title={title}
        onClose={requestClose}
        dismissMode="if-clean"
        titleVariant="sr-only"
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
            {/* 人間が入力する順: 日付 → 項目 → 金額 → お金の流れ(A → B) → 詳細 */}
            {dateField}
            {/* 振替は「項目」を必須にしない（未入力なら自動で「移動元 → 移動先」を付ける）。 */}
            {mode === 'transfer' ? null : itemField}
            {amountField}
            {renderFlow()}
            {flowExtras}
            {allocateField}
            {fixedMonthlyField}
            {repaymentField}
            {loanRepaymentField}

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
                    {/* 振替では「項目」を任意としてここに置く。 */}
                    {mode === 'transfer' ? itemField : null}
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
      {discardConfirm}

      {/* 入力を中断せず、目的別資金（振替の行き先）を作って選択する。 */}
      {reserveSheetOpen ? (
        <ReserveSheet
          onClose={() => setReserveSheetOpen(false)}
          onSave={async (input) => {
            const reserve = await createReserve(input);
            setSide('debit', reserve.reserveAccountId);
            setShowReserve(true);
          }}
        />
      ) : null}

      {/* 入力を中断せず、新しい負債（支払い方法 / 借入の源泉）を作って選択する。 */}
      {liabilitySheetOpen ? (
        <LiabilitySheet
          defaultRole={mode === 'expense' ? 'payment-liability' : 'other-liability'}
          onClose={() => setLiabilitySheetOpen(false)}
          onSave={async (account) => {
            await saveAccount(account);
            setSide('credit', account.id);
            setShowLiability(true);
          }}
        />
      ) : null}
    </>
  );
}
