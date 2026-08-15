/*
 * 仕訳の入力シート。
 *
 * 日常入力（収入/支出/振替）は借方/貸方を意識させず、「お金の流れ」`源泉 → 行き先` で見せる。
 * 並びは人間の入力順: 日付 → 項目 → 金額 → お金の流れ(A → B) → 詳細。内部は常に複式で、
 * source=貸方(credit) / destination=借方(debit) に対応する（MODE_FLOW）。
 */
import { useState } from 'react';
import { Modal } from '../overlays';
import { useDirtyGuard } from '../overlays';
import { TextArea, TextInput } from '@snishi/foundation/ui/Field';
import { Icon } from '@snishi/foundation/ui/Icon';
import { AccountPicker } from '../AccountPicker';
import { FlowField } from '../FlowField';
import { LiabilitySheet } from '../LiabilitySheet';
import { groupedAccountsByRole, groupedMonthlyAllocationAccounts } from '../accountOptions';
import {
  FORM_MODE_TITLE,
  MODE_FLOW,
  MODE_ROLES,
  type FlowMode,
  type FormMode,
} from '../entryModes';
import { quickSpanEndDate } from '../ccQuickSpan';
import { MONTHLY_AMOUNTS_HARD_CAP } from '../../domain/allocation';
import {
  exactDigitsFor,
  formatMinorForInput,
  parseAmountToMinor,
  sanitizeAmountText,
} from '../amountText';
import { moneyText, useMoneyDigits } from '../money';
import { useLedger } from '../../state/store';
import { representativeEntryAmount } from '../../domain/accounting';
import {
  reversalInput,
  toSimpleInput,
  transferFlowValid,
  validateSimpleEntry,
  type EntryValidationError,
  type SimpleEntryInput,
} from '../../domain/entry';
import type { EntryMetadata, InputMode, JournalEntry } from '../../domain/types';
import type { AccountRole } from '../../domain/accountRoles';
import { isRecurringPostableRole } from '../../domain/recurring';
import { t } from '../../i18n';
import type { MessageKey } from '../../i18n';
import { todayLocal } from '../../util/time';
import { UI } from '../../ui-contract';

/**
 * 振替モードの「固定側 pass-through」: 呼び出し側から片側の科目を固定で渡す
 * （継続コスト資産・勘定科目のアーカイブ時の振替が、ホームの振替と同じシートを再利用する）。
 * 固定側は候補リストを経由しない（MODE_ROLES.transfer の allowedRoles は広げない）。
 * 保存は onSave に委譲する（アーカイブ処理と同一トランザクションにするため）。
 */
export interface TransferFixed {
  side: 'credit' | 'debit';
  accountId: string;
  date?: string;
  /** 日付を固定表示にする（継続コスト資産のアーカイブ = 終了日固定）。 */
  lockDate?: boolean;
  /** 金額の既定値（編集可・上限なし）。 */
  amount?: number;
  description?: string;
  /** 相手側の候補。未指定なら科目アーカイブ用の資産・負債だけに限定する。 */
  counterpartRoles?: AccountRole[];
  /**
   * 「振替せずに実行」の任意アクション（費用・収入のアーカイブ用）。
   * 残高 0 が必須の資産・負債では渡さない（スキップさせない = fail-closed のまま）。
   */
  skip?: { label: string; run: () => Promise<void> };
  onSave: (input: SimpleEntryInput) => Promise<void>;
}

export type EntryInit =
  | { kind: 'create'; mode: FormMode }
  | { kind: 'edit'; entry: JournalEntry }
  | { kind: 'reversal'; source: JournalEntry }
  | { kind: 'transfer-fixed'; fixed: TransferFixed };

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
  const { ledger, saveEntry, createContinuousCost, saveAccount } = useLedger();
  const accounts = ledger?.accounts ?? [];
  const currency = ledger?.settings.currency ?? '';

  const fixed = init.kind === 'transfer-fixed' ? init.fixed : null;
  /*
   * 「ぴったり相殺する額」は表示桁で丸めない。丸めると相殺しきれず端数が残る:
   *  - 固定額の振替（科目の終了・継続コスト台帳の引き上げ）は残高／残存価値をちょうど 0 にする額。
   *    丸めると科目の終了が error.account.archiveBalance で保存できなくなり、
   *    回収では残存価値を超える仕訳が保存されうる。
   *  - 逆仕訳は元の仕訳と 1 minor まで同額でなければ打ち消しにならない。
   * どちらも form.amount は丸めず、**欄の表示側をその額が表せる桁まで上げて**
   * 「見えている値 = 保存される値」を保つ。新規入力と、利用者が金額欄を実際に変更した
   * 編集だけが表示桁へ丸められる。金額欄に触れない編集は保存済み minor を保持する。
   */
  const exactAmount =
    init.kind === 'reversal' ? reversalInput(init.source).amount : (fixed?.amount ?? undefined);
  const displayDigits = useMoneyDigits();
  const fractionDigits =
    exactAmount === undefined
      ? displayDigits
      : (Math.max(displayDigits, exactDigitsFor(exactAmount)) as typeof displayDigits);
  const [mode, setMode] = useState<FormMode>(
    init.kind === 'create'
      ? init.mode
      : init.kind === 'edit'
        ? initialModeFor(init.entry)
        : init.kind === 'transfer-fixed'
          ? 'transfer'
          : 'manual',
  );
  // 編集時の form.amount は保存済み raw minor のまま保持する。amountText は表示桁で丸めて
  // 見せるだけで、利用者が金額欄を変更した onAmountChange のときに初めて form.amount を更新する。
  const [form, setForm] = useState<SimpleEntryInput>(
    init.kind === 'edit'
      ? toSimpleInput(init.entry)
      : init.kind === 'reversal'
        ? reversalInput(init.source) // 丸めない（打ち消しの定義）。
        : init.kind === 'transfer-fixed'
          ? {
              date: init.fixed.date ?? todayLocal(),
              description: init.fixed.description ?? '',
              debitAccountId: init.fixed.side === 'debit' ? init.fixed.accountId : '',
              creditAccountId: init.fixed.side === 'credit' ? init.fixed.accountId : '',
              amount: init.fixed.amount ?? 0,
              memo: '',
              kind: 'normal',
            }
          : emptyInput(),
  );
  // 変更判定の基準（mount 時の form.amount とその表示文字列）。編集で欄が初期表示と同じ
  // 文字列の間は保存済み minor を保持する = onChange の発火をもって「変更」としない。
  const [initialAmount] = useState(() => ({
    amount: form.amount,
    text:
      init.kind === 'create' || form.amount === 0
        ? ''
        : formatMinorForInput(form.amount, fractionDigits),
  }));
  const [amountText, setAmountText] = useState<string>(initialAmount.text);
  const [errors, setErrors] = useState<EntryValidationError[]>([]);
  const [flowError, setFlowError] = useState<string | undefined>(undefined);
  const [submitting, setSubmitting] = useState(false);

  const paymentRole = accounts.find((a) => a.id === form.creditAccountId)?.role;
  const [skipping, setSkipping] = useState(false);
  const runSkip = async () => {
    if (!fixed?.skip || skipping) return;
    setSkipping(true);
    try {
      await fixed.skip.run();
      onClose();
    } catch {
      setSkipping(false);
    }
  };
  const isLiabilityPayment =
    paymentRole === 'payment-liability' || paymentRole === 'other-liability';
  // 継続コスト化は支出フローと簿記編集（manual）の新規作成で常に選べる。
  // 支払い元（貸方）の役割は絞らない（保存境界 = RECURRING_POSTABLE_ROLES + equity が正）。
  const canCreateContinuousCost =
    init.kind === 'create' && (mode === 'expense' || mode === 'manual');
  const [ccMode, setCcMode] = useState(false);
  // 継続コスト化を ON にする共通処理。ON 前に選んでいた貸方が支払い元に使えない役割
  // （残高調整など）なら選択を外す（候補から消えても選択だけ残って保存時に失敗する袋小路を
  // 作らない・再監査 P2 対応）。
  const enableCcMode = () => {
    setCcMode(true);
    if (ccTargetName.trim() === '') setCcTargetName(form.description);
    const creditAccountRole = accounts.find((a) => a.id === form.creditAccountId)?.role;
    if (creditAccountRole !== undefined && !isRecurringPostableRole(creditAccountRole)) {
      setForm((f) => ({ ...f, creditAccountId: '' }));
    }
  };
  const [ccTargetName, setCcTargetName] = useState('');
  const [ccCategoryId, setCcCategoryId] = useState('');
  const [ccNameError, setCcNameError] = useState(false);
  const [categoryError, setCategoryError] = useState(false);
  const continuousCostActive = canCreateContinuousCost && ccMode;
  // 終了日は空でよい（空なら費用の割り振りをしない。後から「毎月のもの」で入れられる）。
  const [ccEndDate, setCcEndDate] = useState('');
  const [repayToggle, setRepayToggle] = useState(false);
  const [repayAccountId, setRepayAccountId] = useState('');
  const [repayCountText, setRepayCountText] = useState('');
  const [repayStartDate, setRepayStartDate] = useState('');
  const [repayAccountError, setRepayAccountError] = useState(false);
  const [repayCountError, setRepayCountError] = useState(false);
  const [showDetails, setShowDetails] = useState(init.kind === 'edit');

  const canArrangeLoan = init.kind === 'create' && mode === 'expense';
  const [loanMode, setLoanMode] = useState(false);
  const [liabilitySheetOpen, setLiabilitySheetOpen] = useState(false);

  const snapshot = JSON.stringify({
    form,
    amountText,
    ccMode,
    ccTargetName,
    ccCategoryId,
    loanMode,
    ccEndDate,
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
    const text = sanitizeAmountText(v, fractionDigits, amountText);
    setAmountText(text);
    // 初期表示へ戻った（1 文字打って消した等）ら保存済み minor を復元する。
    setForm((f) => ({
      ...f,
      amount: text === initialAmount.text ? initialAmount.amount : (parseAmountToMinor(text) ?? 0),
    }));
  };

  function resolveInputMode(): InputMode {
    if (init.kind === 'reversal') return 'reversal';
    if (init.kind === 'edit') return init.entry.metadata?.inputMode ?? 'manual';
    return mode;
  }

  function nameOfSide(id: string): string {
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
    // 回数 > 金額は 0 の回を作る（保存境界 buildRepaymentEntries と同じ条件で先に弾く）。
    const countBad =
      active &&
      (!Number.isInteger(count) ||
        count < 1 ||
        count > MONTHLY_AMOUNTS_HARD_CAP ||
        (form.amount >= 1 && count > form.amount));
    setRepayAccountError(accBad);
    setRepayCountError(countBad);
    return { accBad, countBad };
  }

  async function onSave() {
    const toSave = effectiveForm();

    // 固定側 pass-through の振替: 検証後、保存は呼び出し側（アーカイブ処理）へ委譲する。
    // 固定側は候補リストを経由しない科目（台帳・アーカイブ対象）のため transferFlowValid は通さない。
    if (fixed) {
      const found: EntryValidationError[] = [];
      if (toSave.date.trim() === '') found.push('date-required');
      if (!Number.isInteger(toSave.amount) || toSave.amount < 1) found.push('amount-invalid');
      if (toSave.debitAccountId === '') found.push('debit-required');
      if (toSave.creditAccountId === '') found.push('credit-required');
      if (toSave.debitAccountId !== '' && toSave.debitAccountId === toSave.creditAccountId) {
        found.push('same-account');
      }
      setErrors(found);
      setFlowError(undefined);
      if (found.length > 0) return;
      setSubmitting(true);
      try {
        await fixed.onSave({
          ...toSave,
          metadata: { ...toSave.metadata, inputMode: 'transfer' },
        });
        onClose();
      } catch {
        // エラーは store 側が toast 済み。シートは開いたままにする。
        setSubmitting(false);
      }
      return;
    }

    const ccActive = canCreateContinuousCost && ccMode;
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
      const { accBad, countBad } = validateRepay(isLiabilityPayment);
      setFlowError(undefined);
      if (found.length > 0 || nameBad || categoryBad || accBad || countBad) return;
      setSubmitting(true);
      try {
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
        // 購入の仕訳（保存される仕訳）+ item を 1 トランザクションで登録する。
        // 開始日 = 仕訳の日付・支払い元 = ユーザーが選んだ貸方。終了日は空でよい。
        await createContinuousCost({
          name: ccTargetName.trim(),
          amount: toSave.amount,
          startDate: toSave.date,
          ...(ccEndDate.trim() !== '' ? { endDate: ccEndDate.trim() } : {}),
          expenseAccountId: ccCategoryId,
          creditAccountId: toSave.creditAccountId,
          ...repayFields,
        });
        onClose();
      } catch {
        setSubmitting(false);
      }
      return;
    }

    const found = validateSimpleEntry(toSave);
    setErrors(found);
    if (found.length > 0) return;
    if (mode === 'expense') {
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
      const metadata: EntryMetadata = {
        ...toSave.metadata,
        inputMode: resolveInputMode(),
      };
      await saveEntry({ ...toSave, metadata }, existing);
      onClose();
    } catch {
      setSubmitting(false);
    }
  }

  const sameAccount = errorText(errors, 'same-account');
  const isManual = mode === 'manual';
  // 購入の仕訳（継続コスト資産と 1:1）の編集: 借方は継続コスト台帳に固定（読み取り専用）。
  const lockedDebit =
    init.kind === 'edit' &&
    init.entry.metadata?.monthlyCostId !== undefined &&
    init.entry.metadata.monthlyCostRecovery !== true;
  const accountNameOf = (id: string): string => accounts.find((a) => a.id === id)?.name ?? '—';
  const readOnlyAccount = (labelKey: MessageKey, id: string) => (
    <div className="field">
      <span className="field__label">{t(labelKey)}</span>
      <div className="list__title">{accountNameOf(id)}</div>
    </div>
  );

  const dateField =
    fixed?.lockDate === true ? (
      <div className="kv" data-ui={UI.journal.entry.date}>
        <span className="muted">{t('entry.date')}</span>
        <span>{form.date}</span>
      </div>
    ) : (
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
      inputMode={fractionDigits === 0 ? 'numeric' : 'decimal'}
      value={amountText}
      onChange={onAmountChange}
      error={errorText(errors, 'amount-invalid')}
      dataUi={UI.journal.entry.amount}
    />
  );

  /*
   * 反対仕訳（取消/返金）の「この仕訳への取消済み合計 / 残り」。
   * 元仕訳を指す既存の反対仕訳（metadata.reversalOfEntryId）だけを数える。
   * 集計に domain の checked sum（assertSafeAmount）は使わない: render で投げると
   * root の ErrorBoundary がアプリ全体を復旧画面へ落とす。fail-closed は保存境界の役目。
   */
  const reversalStatus = (() => {
    if (init.kind !== 'reversal') return null;
    const sourceId = init.source.id;
    const done = (ledger?.journalEntries ?? []).filter(
      (e) => e.metadata?.reversalOfEntryId === sourceId,
    );
    const reversed = done.reduce((sum, e) => sum + representativeEntryAmount(e), 0);
    // 残りは負になり得る（過剰返金・元仕訳の後からの減額編集）。負のまま見せる。
    return {
      count: done.length,
      reversed,
      remaining: representativeEntryAmount(init.source) - reversed,
    };
  })();
  /*
   * 入力額が残りを超えたときの注意。**警告だけで保存はブロックしない**（作者合意 2026-08-15）。
   * ハードブロックは過去編集モデルと両立しない: 元仕訳を後から減額編集すると保存済みの取消が
   * 超過側へ回るため、保存境界に入れると編集のたびに壊れる台帳になる。
   * 現実にも過剰返金・補償はありうるので、記録は止めず気づかせるだけにする。
   */
  const reversalOverRemaining = reversalStatus !== null && form.amount > reversalStatus.remaining;
  /*
   * 表示桁は金額欄と同じ（fractionDigits）。ただし取消済み・残りがその桁で表せないときだけ
   * 桁を上げる: 丸めた「残り」と、丸めない値どうしで判定する上の警告が食い違って見えるのを防ぐ。
   */
  const summaryDigits = (
    reversalStatus === null
      ? fractionDigits
      : Math.max(
          fractionDigits,
          exactDigitsFor(reversalStatus.reversed),
          exactDigitsFor(reversalStatus.remaining),
        )
  ) as typeof displayDigits;
  // 取消済みが 0 件のときは行ごと出さない（初回の取消で画面を汚さない）。
  const reversalSummary =
    reversalStatus !== null && reversalStatus.count > 0 ? (
      <p
        className="field__hint"
        style={{ marginBottom: 'var(--space-4)' }}
        data-ui={UI.journal.entry.reversalSummary}
      >
        {t('entry.reversal.reversedSoFar', {
          reversed: moneyText(reversalStatus.reversed, currency, summaryDigits),
          remaining: moneyText(reversalStatus.remaining, currency, summaryDigits),
        })}
      </p>
    ) : null;
  const reversalOverWarning = reversalOverRemaining ? (
    <div className="field__warning" role="status" data-ui={UI.journal.entry.reversalOverWarning}>
      <Icon name="alert" size={14} />
      {t('entry.reversal.overWarning')}
    </div>
  ) : null;

  const memoField = (
    <TextArea
      label={t('entry.memo')}
      value={form.memo ?? ''}
      onChange={(v) => setForm((f) => ({ ...f, memo: v }))}
      dataUi={UI.journal.entry.memo}
    />
  );

  // 継続コスト化中の行き先側: 継続コスト資産の名前 + 戻すボタン（支出フロー・簿記編集で共用）。
  const ccNameField = (
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
  );

  const flowDef = isManual ? null : MODE_FLOW[mode as FlowMode];
  // 固定側 pass-through: 相手側の候補（振替先/振替元）。台帳・アーカイブ対象は候補に出さない。
  const FIXED_COUNTERPART_ROLES = ['daily-asset', 'payment-liability', 'other-liability'] as const;
  const renderFlow = () => {
    if (!flowDef) return null;
    if (fixed) {
      const counterpartSide = fixed.side === 'credit' ? 'debit' : 'credit';
      const counterpartGroups = groupedAccountsByRole(
        accounts,
        fixed.counterpartRoles ?? [...FIXED_COUNTERPART_ROLES],
        counterpartSide === 'debit' ? form.debitAccountId : form.creditAccountId,
        form.date,
      )
        .map((group) => ({
          ...group,
          accounts: group.accounts.filter((account) => account.id !== fixed.accountId),
        }))
        .filter((group) => group.accounts.length > 0);
      const counterpartPicker = (
        <AccountPicker
          flat
          label={t(counterpartSide === 'debit' ? 'entry.transfer.to' : 'entry.transfer.from')}
          required
          value={counterpartSide === 'debit' ? form.debitAccountId : form.creditAccountId}
          groups={counterpartGroups}
          onChange={(id) => setSide(counterpartSide, id)}
          error={
            errorText(errors, counterpartSide === 'debit' ? 'debit-required' : 'credit-required') ??
            sameAccount
          }
          dataUi={
            counterpartSide === 'debit'
              ? UI.journal.entry.flowDestination
              : UI.journal.entry.flowSource
          }
        />
      );
      return (
        <FlowField
          hint={t(flowDef.flowLabelKey)}
          dataUi={UI.journal.entry.flow}
          source={
            fixed.side === 'credit'
              ? readOnlyAccount('entry.transfer.from', fixed.accountId)
              : counterpartPicker
          }
          destination={
            fixed.side === 'debit'
              ? readOnlyAccount('entry.transfer.to', fixed.accountId)
              : counterpartPicker
          }
        />
      );
    }
    const srcGroups = groupedAccountsByRole(
      accounts,
      [...flowDef.source.allowedRoles],
      form.creditAccountId,
      form.date,
    );
    const dstGroups = groupedAccountsByRole(
      accounts,
      [...flowDef.destination.allowedRoles],
      form.debitAccountId,
      form.date,
    );
    const loanGroups = groupedAccountsByRole(
      accounts,
      ['other-liability'],
      form.creditAccountId,
      form.date,
    );
    return (
      <FlowField
        hint={t(flowDef.flowLabelKey)}
        dataUi={UI.journal.entry.flow}
        source={
          canArrangeLoan && loanMode ? (
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
              <button type="button" className="collapse-toggle" onClick={() => setLoanMode(false)}>
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
          )
        }
        destination={
          canCreateContinuousCost && ccMode ? (
            ccNameField
          ) : lockedDebit ? (
            // 購入の仕訳の借方 = 継続コスト台帳（固定）。日付・金額・貸方だけ編集できる。
            readOnlyAccount(flowDef.destination.labelKey, form.debitAccountId)
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
              {canCreateContinuousCost ? (
                <button
                  type="button"
                  className="collapse-toggle"
                  onClick={enableCcMode}
                  data-ui={UI.journal.entry.ccToggle}
                >
                  <Icon name="add" size={16} />
                  {t('entry.ccToggle')}
                </button>
              ) : null}
            </>
          )
        }
      />
    );
  };

  const renderManualFlow = () => {
    const creditRole = roles.find((role) => role.side === 'credit');
    const debitRole = roles.find((role) => role.side === 'debit');
    if (!creditRole || !debitRole) return null;
    // 継続コスト化中の貸方 = 購入の仕訳の支払い元。保存境界と同じ RECURRING_POSTABLE_ROLES に
    // 絞る（残高調整科目を選べて保存だけ失敗する袋小路を作らない・監査 P2-6）。
    const srcRoles = continuousCostActive
      ? creditRole.allowedRoles.filter((r) => isRecurringPostableRole(r))
      : [...creditRole.allowedRoles];
    const srcGroups = groupedAccountsByRole(accounts, srcRoles, form.creditAccountId, form.date);
    const dstGroups = groupedAccountsByRole(
      accounts,
      [...debitRole.allowedRoles],
      form.debitAccountId,
      form.date,
    );
    return (
      <FlowField
        hint={t('entry.flow.manual')}
        dataUi={UI.journal.entry.flow}
        source={
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
        }
        destination={
          continuousCostActive ? (
            // 継続コスト化中の借方 = 継続コスト資産の名前（実際の借方は台帳に固定される）。
            ccNameField
          ) : lockedDebit ? (
            readOnlyAccount('entry.destination.manual', form.debitAccountId)
          ) : (
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
          )
        }
      />
    );
  };

  const ccDetailField =
    canCreateContinuousCost && ccMode ? (
      <div className="field">
        <TextInput
          label={t('ccItem.endDate')}
          type="date"
          value={ccEndDate}
          onChange={setCcEndDate}
          dataUi={UI.journal.entry.ccEndDate}
        />
        <div className="row-actions">
          {[1, 3, 5].map((years) => (
            <button
              key={years}
              type="button"
              className="btn btn--ghost"
              style={{ minHeight: 'var(--tap)' }}
              onClick={() => setCcEndDate(quickSpanEndDate(form.date, years))}
            >
              {t('ccItem.quickSpan', { years })}
            </button>
          ))}
        </div>
        <AccountPicker
          label={t('entry.ccCategory')}
          required
          value={ccCategoryId}
          groups={groupedMonthlyAllocationAccounts(accounts, ccCategoryId, form.date)}
          onChange={setCcCategoryId}
          error={categoryError ? t('entry.error.category-required') : undefined}
          dataUi={UI.journal.entry.ccCategory}
        />
      </div>
    ) : null;

  const repaymentField =
    continuousCostActive && isLiabilityPayment ? (
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
              groups={groupedAccountsByRole(accounts, ['daily-asset'], repayAccountId, form.date)}
              onChange={setRepayAccountId}
              error={repayAccountError ? t('entry.error.repayAccount') : undefined}
              dataUi={UI.journal.entry.monthlyizeRepayAccount}
            />
            <TextInput
              label={t('entry.monthlyizeRepayCount')}
              inputMode="numeric"
              value={repayCountText}
              onChange={(v) => setRepayCountText(v.replace(/[^\d]/g, ''))}
              hint={t('entry.monthlyizeRepayCountHint', {
                max: MONTHLY_AMOUNTS_HARD_CAP,
              })}
              error={
                repayCountError
                  ? t('entry.error.repayCount', { max: MONTHLY_AMOUNTS_HARD_CAP })
                  : undefined
              }
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
        {reversalSummary}

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
            {canCreateContinuousCost && ccMode ? null : descriptionField}
            {amountField}
            {reversalOverWarning}
            {renderManualFlow()}
            {/* 簿記編集でも、貸方が資金/負債なら継続コスト化できる（支出フローと同じパネル）。 */}
            {canCreateContinuousCost && !ccMode ? (
              <button
                type="button"
                className="collapse-toggle"
                onClick={enableCcMode}
                data-ui={UI.journal.entry.ccToggle}
              >
                <Icon name="add" size={16} />
                {t('entry.ccToggle')}
              </button>
            ) : null}
            {ccDetailField}
            {repaymentField}
            {canCreateContinuousCost && ccMode ? null : memoField}
          </>
        ) : (
          <>
            {/* 費用・収入のアーカイブでは「振替せず終了」も正当な選択（残高 0 は必須でない）。
                入力を始める前に選べるよう最上部に置く（作者決定 2026-08-14）。 */}
            {fixed?.skip ? (
              <button
                type="button"
                className="btn btn--block"
                onClick={runSkip}
                disabled={skipping}
                data-ui={UI.journal.entry.transferSkip}
              >
                {fixed.skip.label}
              </button>
            ) : null}
            {dateField}
            {mode === 'transfer' || (canCreateContinuousCost && ccMode) ? null : itemField}
            {amountField}
            {/* 反対仕訳は常に簿記編集（上の分岐）だが、日常入力側にも同じ位置で置いておく。 */}
            {reversalOverWarning}
            {renderFlow()}
            {ccDetailField}
            {repaymentField}

            {continuousCostActive || fixed ? null : (
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
