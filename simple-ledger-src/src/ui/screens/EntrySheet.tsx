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
import { SelectInput, TextArea, TextInput } from '../Field';
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
    saveEntryWithFixedAssetMonthly,
    createContinuousCost,
    createReserve,
    saveAccount,
  } = useLedger();
  const accounts = ledger?.accounts ?? [];
  const reserves = ledger?.reserves ?? [];
  const tags = ledger?.tags ?? [];
  // 取り置き資金の目的別「擬似候補」。集約口座を直接出さず、目的ごとの選択肢を flow ピッカーに足す。
  // value は `reserve:<reserveId>`。保存時に集約口座 + metadata.reserveId へ解決する。
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
  // `reserve:<id>` 選択を集約口座 + reserveId へ解決する。
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
  // 継続コスト（資産経由）: 支出入力の行き先を「継続コスト対象（資産）」に切り替えて自由入力する。
  // 行き先の役割には依存しない（create × expense なら「継続コスト化」ボタンを出す）。
  const canAllocate = init.kind === 'create' && mode === 'expense';
  // ccMode = 行き先を継続コスト対象に切替え。ccTargetName=台帳に登録する対象名、ccCategoryId=認識先カテゴリ。
  const [ccMode, setCcMode] = useState(false);
  const [ccTargetName, setCcTargetName] = useState('');
  const [ccCategoryId, setCcCategoryId] = useState('');
  const [ccNameError, setCcNameError] = useState(false);
  // 固定資産購入（expense × 固定資産 × create）の旧経路。継続コスト対象（ccMode）が主導線。
  const canFixedMonthly =
    init.kind === 'create' && mode === 'expense' && !ccMode && destRole === 'fixed-asset';
  const [fixedMonthly, setFixedMonthly] = useState(false);
  const [monthlyCategoryId, setMonthlyCategoryId] = useState('');
  const [categoryError, setCategoryError] = useState(false);
  // 継続コスト ON のときはタグを付けられない（createContinuousCost はタグを受け取らないため）。
  const allocationActive = (canAllocate && ccMode) || (canFixedMonthly && fixedMonthly);
  const [monthsText, setMonthsText] = useState('');
  const [monthsError, setMonthsError] = useState(false);
  const months = monthsText === '' ? 0 : Number.parseInt(monthsText, 10);
  // 継続コストの詳細（種類は入力から推定する）
  const [continueCost, setContinueCost] = useState(false);
  // liability 払いの返済 CF（支払い元の近くで入力する）
  const [repayToggle, setRepayToggle] = useState(false);
  const [repayAccountId, setRepayAccountId] = useState('');
  const [repayCountText, setRepayCountText] = useState('');
  const [repayStartDate, setRepayStartDate] = useState('');
  const [repayAccountError, setRepayAccountError] = useState(false);
  const [repayCountError, setRepayCountError] = useState(false);
  // 支払い元(credit)が負債（カード=payment-liability / ローン=other-liability）なら返済 CF を入力できる。
  const paymentRole = accounts.find((a) => a.id === form.creditAccountId)?.role;
  const isLiabilityPayment =
    paymentRole === 'payment-liability' || paymentRole === 'other-liability';
  // 詳細（メモ・タグ）は折りたたみ。編集時は既存値が見えるよう開いておく。
  const [showDetails, setShowDetails] = useState(init.kind === 'edit');

  // 取り置き資金・ローンはチェックボックスで候補を増やす方式を廃止し、継続コスト化(ccMode)と同じ
  // 「フロー片側のピッカーをボタンで切り替える」挙動に寄せる。
  //  - 振替の移動先(右辺): 「取り置き資産を作る」で名称入力へ切替（reserveMode）→ createReserve。
  //  - 支出の支払い元(左辺): 「ローンを組む」で既存ローン選択 + 新規ローン作成へ切替（loanMode）。
  // 既存の取り置き資金は両辺で常時選択できる（MODE_FLOW の allowedRoles に reserve-asset を既定で含める）。
  const canCreateReserve = init.kind === 'create' && mode === 'transfer';
  const [reserveMode, setReserveMode] = useState(false);
  const [reserveName, setReserveName] = useState('');
  const [reserveNameError, setReserveNameError] = useState(false);
  const canArrangeLoan = init.kind === 'create' && mode === 'expense';
  const [loanMode, setLoanMode] = useState(false);
  const [liabilitySheetOpen, setLiabilitySheetOpen] = useState(false);

  // 編集状態の検出: 入力フィールドのスナップショットを初期値と比較する。
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

  // 振替で項目未入力なら「移動元 → 移動先」を自動生成する（取り置きは目的名で表示）。
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

  // 「返済を資金繰りに入れる」ON のとき、返済元口座・回数を必須にする（3 経路共通）。
  // 空のまま保存すると CF 予定が静かに作られず、ユーザーの期待とズレるため fail-closed。
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
    // 保存時は常に「現在有効な管理区分」を明示的に載せる（区分セレクタが出ない単一区分でも
    // 実在する区分 id で保存する）。DEFAULT_MANAGEMENT_SCOPE_ID は最終フォールバックに留める。
    const base = effectiveForm();
    // 取り置き(reserve:)選択を集約口座 + reserveId へ解決する（目的別残高は reserveId 集計で出す）。
    const srcResolved = resolveReserveSide(base.creditAccountId);
    const dstResolved = resolveReserveSide(base.debitAccountId);
    const selectedReserveId = srcResolved.reserveId ?? dstResolved.reserveId;
    const toSave = {
      ...base,
      creditAccountId: srcResolved.accountId,
      debitAccountId: dstResolved.accountId,
      managementScopeId: base.managementScopeId ?? scopes[0]?.id,
    };

    // 継続コスト（資産経由）: 行き先は「継続コスト対象（資産）」を自由入力し、認識先カテゴリは別フィールド。
    // 通常の simple entry は保存せず、createContinuousCost にルールを渡す（funding/recognition は仮想展開）。
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
        // funding: `支払い元 → 継続コスト対象`、recognition: `継続コスト対象 → 認識先カテゴリ`。
        // 支払い元が other-liability（自動車ローン等）でも資産取得の貸方として受ける。
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

    // 取り置き資産の新規作成（振替の移動先を「取り置き資産名入力」に切替えたとき）。
    // 目的名ごとの勘定科目は増やさない（reserve-asset は内部ロール＝聖域化）。createReserve が
    // 取り置き資金枠を作り、その枠の口座を移動先にして通常の振替仕訳を保存する。
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
        // 取り置き元（親口座）= 移動元の資金口座。残高は集約口座へ寄せ、目的は reserveId で識別。
        const reserve = await createReserve({
          name: reserveName.trim(),
          parentAccountId: toSave.creditAccountId,
        });
        const srcName = accounts.find((a) => a.id === toSave.creditAccountId)?.name ?? '—';
        // 自動命名は reserveMode 中の effectiveForm では行き先が空（'—'）になるため、ユーザーが
        // 項目を打っていなければ「移動元 → 取り置き対象名」で作る。
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
    // costMonths は 1 以上（サブスクは 1 か月）。
    const monthsBad = useFixedMonthly && (!Number.isInteger(months) || months < 1);
    setMonthsError(monthsBad);
    // 固定資産の継続コストは、月割り先の費用カテゴリが必須。
    const categoryBad = useFixedMonthly && monthlyCategoryId === '';
    setCategoryError(categoryBad);
    // 返済トグルの必須検証: 固定資産月割りを負債で払うときだけ。
    const { accBad, countBad } = validateRepay(useFixedMonthly && isLiabilityPayment);
    if (found.length > 0 || monthsBad || categoryBad || accBad || countBad) return;
    // 通常の支出でローン（other-liability）を支払い元にはできない（継続コスト化 or 借入の振替に限定）。
    if (mode === 'expense' && !useFixedMonthly) {
      const srcRole = accounts.find((a) => a.id === toSave.creditAccountId)?.role;
      if (srcRole === 'other-liability') {
        setFlowError(t('entry.error.loanNotExpense'));
        return;
      }
    }
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
      if (useFixedMonthly) {
        // 固定資産購入（借方 固定資産 / 貸方 資金 or 負債）+ 継続コストを一括保存。購入仕訳が実体で、
        // 継続コストは支払い仕訳を作らず formula 認識のみ（recognitionCreditAccountId=固定資産）。
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

  // 管理区分は 2 つ以上あるときだけ選ばせる（1 つなら既定で隠す）。
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

  // 明細の支払い手段の細目（その科目・管理区分に細目が登録されているときだけ出す）。
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

  // お金の流れ（源泉 → 行き先）。簿記用語を出さず、左=貸方 / 右=借方。
  // 取り置き資金は両辺で常時選択でき（MODE_FLOW の allowedRoles 既定）、チェックボックスは使わない。
  // 支出の「ローンを組む」(左辺) / 振替の「取り置き資産を作る」(右辺) は継続コスト化と同じ片側切替挙動。
  const flowDef = isManual ? null : MODE_FLOW[mode as FlowMode];
  const renderFlow = () => {
    if (!flowDef) return null;
    // 取り置き資金（目的別の擬似候補）を出す辺: 振替は両辺、支出は支払い元（左辺）。
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
    // 「ローンを組む」切替時の支払い元候補（既存ローン = other-liability）。
    const loanGroups = groupedAccountsByRole(accounts, ['other-liability'], form.creditAccountId);
    return (
      <div className="field" data-ui={UI.journal.entry.flow}>
        <span className="field__hint">{t(flowDef.flowLabelKey)}</span>
        <div className="flow">
          <div className="flow__side">
            {canArrangeLoan && loanMode ? (
              <>
                {/* 左辺を「ローン選択/作成」へ切替。既存ローンを選ぶか、新しいローンを作成する。 */}
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
                  <Icon name="plus" size={16} />
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
                  // 支払い元（左辺）を「ローンを組む」へ切り替える単一導線。
                  <button
                    type="button"
                    className="collapse-toggle"
                    onClick={() => setLoanMode(true)}
                    data-ui={UI.journal.entry.loanArrange}
                  >
                    <Icon name="plus" size={16} />
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
                {/* 行き先を「継続コスト対象（資産）」として自由入力する（台帳に登録する名前）。 */}
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
                {/* 移動先を「取り置き資産名入力」へ切替。保存で createReserve（勘定科目は増やさない）。 */}
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
                  // 行き先を継続コスト対象に切り替える。タップで自由入力欄になる。
                  <button
                    type="button"
                    className="collapse-toggle"
                    onClick={() => {
                      setCcMode(true);
                      if (ccTargetName.trim() === '') setCcTargetName(form.description);
                    }}
                    data-ui={UI.journal.entry.ccToggle}
                  >
                    <Icon name="plus" size={16} />
                    {t('entry.ccToggle')}
                  </button>
                ) : null}
                {canCreateReserve ? (
                  // 移動先を「取り置き資産を作る」へ切り替える。タップで名称入力欄になる。
                  <button
                    type="button"
                    className="collapse-toggle"
                    onClick={() => {
                      setReserveMode(true);
                      if (reserveName.trim() === '') setReserveName(form.description);
                    }}
                    data-ui={UI.journal.entry.reserveCreate}
                  >
                    <Icon name="plus" size={16} />
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

  // 行き先を「継続コスト対象」に切り替えたとき（ccMode）の詳細。
  // 入力順は 対象名（流れの行き先）→ 月数 → 分類先カテゴリ → 継続・買い替え（日付・金額に続く自然な順）。
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

  // 固定資産の購入を「支出として継続コスト」する（購入仕訳とは別に formula 認識）。
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
            {/* 簿記編集も左=貸方 / 右=借方の流れで扱い、金額を主要入力順から落とさない。 */}
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
            {/* 人間が入力する順: 日付 → 金額 → お金の流れ(左辺[+ローン/取り置き] → 右辺) → 項目 → 継続コスト詳細 */}
            {dateField}
            {amountField}
            {renderFlow()}
            {/* 項目は流れの後に置く（金額より前に出さない）。振替は自動命名、継続コスト化中は対象名と
                重複するため出さない（名称は流れの行き先＝継続コスト対象の名前で入力する）。 */}
            {mode === 'transfer' || (canAllocate && ccMode) ? null : itemField}
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
                  <Icon name={showDetails ? 'chevronDown' : 'chevronRight'} size={16} />
                  {t('entry.detailToggle')}
                </button>
                {showDetails ? (
                  <div className="stack">
                    {/* 振替では「項目」を任意としてここに置く。 */}
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

      {/* 「ローンを組む」導線内から新しいローンを作って支払い元に選択する（同じ導線内）。
          既定をローン(other-liability)にする。クレジットカードは勘定科目管理で扱う。 */}
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
