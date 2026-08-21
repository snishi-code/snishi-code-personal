/*
 * 仕訳の入力シート。
 *
 * 日常入力（収入/支出/振替）は借方/貸方を意識させず、「お金の流れ」`源泉 → 行き先` で見せる。
 * 並びは人間の入力順: 日付 → 項目 → 金額 → お金の流れ(A → B) → 詳細。内部は常に複式で、
 * source=貸方(credit) / destination=借方(debit) に対応する（MODE_FLOW）。
 */
import { useState } from 'react';
import { Modal } from '../overlays';
import { ConfirmDialog, useDirtyGuard } from '../overlays';
import { TextInput } from '@snishi/foundation/ui/Field';
import { Icon } from '@snishi/foundation/ui/Icon';
import { AccountPicker } from '../AccountPicker';
import { FlowField } from '../FlowField';
import { groupedAccountsByRole, groupedMonthlyAllocationAccounts } from '../accountOptions';
import {
  FORM_MODE_TITLE,
  MODE_FLOW,
  MODE_ROLES,
  type FlowMode,
  type FormMode,
} from '../entryModes';
import { quickSpanEndDate } from '../ccQuickSpan';
import { EntryLoanStep } from '../sheets/EntryLoanStep';
import { EntryItemStep } from '../sheets/EntryItemStep';
import { EntryRuleStep } from '../sheets/EntryRuleStep';
import { EntrySplitStep } from '../sheets/EntrySplitStep';
import {
  MONTHLY_AMOUNTS_HARD_CAP,
  monthlyAmounts,
  monthOf,
  monthsBetween,
} from '../../domain/allocation';
import { dayCutCount } from '../../domain/monthlyCost';
import {
  LOAN_QUICK_YEARS,
  loanFirstRepaymentDate,
  loanInstallmentPreviewCount,
} from '../../domain/loan';
import { MAX_AMOUNT_MINOR } from '../../domain/schema';
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
import { newId } from '../../domain/ids';
import { t } from '../../i18n';
import type { MessageKey } from '../../i18n';
import { isValidIsoDate, MAX_LEDGER_DATE, MIN_LEDGER_DATE } from '../../domain/calendar';
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

/**
 * 登録のページ（v13.7 I3）。`base` = 支出そのもの（ローン・持ち物は使うかどうかの選択だけ）、
 * `loan` = ローンの入力、`item` = 持ち物の入力。選んだものだけが順に足される。
 */
type EntryStep = 'base' | 'loan' | 'item' | 'rule' | 'split';

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
    createContinuousCost,
    createLoanPurchase,
    createRecurringRule,
    createEntries,
    removeEntry,
  } = useLedger();
  const accounts = ledger?.accounts ?? [];
  const currency = ledger?.settings.currency ?? '';
  // 破壊的操作は編集シート最下部（動詞体系 v13.1）。確認ダイアログとの 2 段防御は従来どおり。
  const [pendingDelete, setPendingDelete] = useState(false);

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
  // 終了日は空でよい（空なら費用の割り振りをしない。後から「月割り台帳」で入れられる）。
  const [ccEndDate, setCcEndDate] = useState('');
  const [showDetails, setShowDetails] = useState(init.kind === 'edit');

  /*
   * ローンで払う（v13.6 H4）。持ち物の「持ち物として登録する」と同じ片側切替で、
   * 名前は摘要から自動・終了日は 1/3/5 年チップ・返済元は全科目から選ぶ。
   * **既存ローンへ足す導線は作らない**（押すたびに新しいローンを 1 本組む）。
   */
  const canArrangeLoan = init.kind === 'create' && mode === 'expense';
  const [loanMode, setLoanMode] = useState(false);
  const [loanName, setLoanName] = useState('');
  const [loanEndDate, setLoanEndDate] = useState('');
  const [loanFromAccountId, setLoanFromAccountId] = useState('');
  const [loanNameError, setLoanNameError] = useState(false);
  const [loanEndDateError, setLoanEndDateError] = useState(false);
  const [loanFromError, setLoanFromError] = useState(false);
  const loanActive = canArrangeLoan && loanMode;
  const enableLoanMode = () => {
    setLoanMode(true);
    if (loanName.trim() === '') setLoanName(form.description);
    // 支払い元は「新しいローン」に決まる = 選択済みの貸方は意味を失う。
    setForm((f) => ({ ...f, creditAccountId: '' }));
  };

  /*
   * 「ルールにする」（v13.15 §2.2）: 勘定科目の箱・入力種別に依存しない**直交トグル**。
   * 収入・支出・振替の全モードで出す（簿記編集 = manual は 1 枚のまま扱うので出さない）。
   * ON で steps に 'rule' ページが足され、保存はルール保存 API だけになる（完全導出 —
   * 単発仕訳は保存されない）。写像は全モード単一規則: 計上先 = base の借方 / 源泉 = base の貸方。
   */
  const canMakeRule =
    init.kind === 'create' && (mode === 'income' || mode === 'expense' || mode === 'transfer');
  const [ruleMode, setRuleMode] = useState(false);
  const ruleActive = canMakeRule && ruleMode;
  const [ruleEveryText, setRuleEveryText] = useState('1');
  const [rulePostingDate, setRulePostingDate] = useState('');
  const [ruleEveryError, setRuleEveryError] = useState(false);
  const [rulePostingDateError, setRulePostingDateError] = useState(false);
  // ルール ON は持ち物トグルを畳む（§2.3: 毎周期の item は台帳経由で自動 = 個別指定は不要）。
  const enableRuleMode = () => {
    setRuleMode(true);
    setCcMode(false);
  };
  const disableRuleMode = () => {
    setRuleMode(false);
    setStep('base');
  };

  /*
   * 諸口（v13.16）: 片側のみ複数選択。配列 = 選択順（末尾 = 振り分けページの自動計算枠）。
   * form の該当側は常に配列の先頭をミラーする（単一経路の検証・保存がそのまま生きる）。
   * 有効なのは新規作成の flow ピッカーだけ（編集 = 個別行の通常編集・全モード共通）。
   */
  const [creditIds, setCreditIds] = useState<string[]>([]);
  const [debitIds, setDebitIds] = useState<string[]>([]);
  const [splitTexts, setSplitTexts] = useState<Record<string, string>>({});
  const [splitAmountsInvalid, setSplitAmountsInvalid] = useState(false);
  const [splitAutoInvalid, setSplitAutoInvalid] = useState(false);
  const setSideIds = (side: 'debit' | 'credit', ids: string[]) => {
    (side === 'credit' ? setCreditIds : setDebitIds)(ids);
    setSide(side, ids[0] ?? '');
    setSplitAmountsInvalid(false);
    setSplitAutoInvalid(false);
  };
  const setSideSingle = (side: 'debit' | 'credit', id: string) => setSideIds(side, [id]);
  /*
   * 完済日（inclusive）から回数・月々の額を導出する（v13.13: 端数は monthlyAmounts の
   * 合計厳密一致に乗るので「差額の明示」は不要になった）。プレビューは保存境界と同じ式
   * （allocationCuts 系の正本）を通し、render で投げないよう入力を先に検証する。
   */
  const loanFirstDate = loanFirstRepaymentDate(form.date);
  const loanEnd = loanEndDate.trim();
  const loanEndValid = loanEnd !== '' && isValidIsoDate(loanEnd) && loanEnd >= form.date;
  const loanMonths = loanEndValid ? monthsBetween(monthOf(form.date), monthOf(loanEnd)) + 1 : 0;
  const loanTermTooLong = loanEndValid && loanMonths > MONTHLY_AMOUNTS_HARD_CAP;
  // 縮退（完済日が購入 1 か月後より前）は「完済日に全額 1 本」。
  const loanLump = loanEndValid && !loanTermTooLong && dayCutCount(form.date, loanEnd) === 0;
  const loanCount =
    loanEndValid && !loanTermTooLong ? loanInstallmentPreviewCount(form.date, loanEnd) : 0;
  const loanAmountValid =
    Number.isInteger(form.amount) && form.amount >= 1 && form.amount <= MAX_AMOUNT_MINOR;
  // 月々の額 = 先頭刻み（monthlyAmounts の先頭）。ガード済み入力なので投げない。
  const loanFirstAmount =
    loanCount >= 1 && loanAmountValid ? (monthlyAmounts(form.amount, loanCount)[0] ?? 0) : 0;

  /*
   * 持ち物ページのまとめカード用導出（ローンページと同一解剖・v13.15 §2.2）。
   * 刻み規約は allocationCuts の単一正本と同じ: n = dayCutCount・n = 0 は終了日に全額 1 本。
   * 終了日は空でよい（空なら割り振らない = カードも出さない）。
   */
  const ccEnd = ccEndDate.trim();
  const ccEndValid = ccEnd !== '' && isValidIsoDate(ccEnd) && ccEnd >= form.date;
  const ccCount = ccEndValid ? dayCutCount(form.date, ccEnd) : 0;
  const ccFirstAmount =
    ccEndValid && ccCount >= 1 && loanAmountValid
      ? (monthlyAmounts(form.amount, ccCount)[0] ?? 0)
      : 0;

  /*
   * rule ページのまとめカード用導出（v13.15 §2.2）。起票日の既定 = base の日付。
   * ローン併用時の月々の返済は保存形と同じ相対月数（起票日 → 完済日）で出す。
   */
  const ruleEveryValue = ruleEveryText === '' ? Number.NaN : Number.parseInt(ruleEveryText, 10);
  const ruleEveryValid =
    Number.isInteger(ruleEveryValue) &&
    ruleEveryValue >= 1 &&
    ruleEveryValue <= MONTHLY_AMOUNTS_HARD_CAP;
  const rulePd = rulePostingDate.trim() === '' ? form.date : rulePostingDate.trim();
  const ruleLoanMonths =
    loanActive && loanEndValid ? monthsBetween(monthOf(rulePd), monthOf(loanEnd)) : 0;
  const ruleLoanMonthly =
    ruleLoanMonths >= 1 && ruleLoanMonths <= MONTHLY_AMOUNTS_HARD_CAP && loanAmountValid
      ? (monthlyAmounts(form.amount, ruleLoanMonths)[0] ?? 0)
      : 0;

  /*
   * マルチステップ登録（v13.7 I3・作者決定 2026-08-18）。1 画面 1 決定にする:
   * 支出の画面ではローン・持ち物を**使うかどうかだけ**選び、入力そのものは次のページへ送る
   * （選ぶと保存ボタンが「ローンを入力する」「持ち物を入力する」に変わる）。
   * どちらも選ばなければページは 1 枚のまま = 従来どおりその場で保存する（挙動不変）。
   * 簿記編集（manual）は 1 枚のまま扱う（貸借を直に指定する画面の力を割らない）。
   */
  const [step, setStep] = useState<EntryStep>('base');
  /*
   * 諸口の活性（v13.16）: トグルが 1 つでも ON の間は複数選択を出さない（購入仕訳は item と
   * 1:1 ミラー・ルールは単一フローの宣言 — 排他は作者承認 2026-08-21）。
   * 片側ロック: 一方で 2 件以上選んだ瞬間にもう一方は単一選択へロックする（UI 層の fail-closed）。
   */
  const splitPickersEnabled =
    init.kind === 'create' && !loanActive && !continuousCostActive && !ruleActive;
  const splitActive = splitPickersEnabled && (creditIds.length >= 2 || debitIds.length >= 2);
  const splitSide: 'debit' | 'credit' = creditIds.length >= 2 ? 'credit' : 'debit';
  const splitIds = splitSide === 'credit' ? creditIds : debitIds;
  // 自動計算枠（末尾）= 合計 − Σ手入力。検証と表示が同じ式を使う。
  const splitManualAmounts = splitIds
    .slice(0, -1)
    .map((id) => parseAmountToMinor(splitTexts[id] ?? '') ?? 0);
  const splitAutoAmount = splitManualAmounts.reduce((sum, a) => sum - a, form.amount);

  const steps: EntryStep[] =
    mode === 'manual'
      ? ['base', ...(splitActive ? (['split'] as const) : [])]
      : [
          'base',
          ...(canArrangeLoan && loanMode ? (['loan'] as const) : []),
          ...(canCreateContinuousCost && ccMode && !ruleActive ? (['item'] as const) : []),
          ...(ruleActive ? (['rule'] as const) : []),
          ...(splitActive ? (['split'] as const) : []),
        ];
  // 選択を外したページに留まらない（steps から消えたら基本の画面へ戻る）。
  const activeStep: EntryStep = steps.includes(step) ? step : 'base';
  const stepIndex = steps.indexOf(activeStep);
  const nextStep: EntryStep | undefined = steps[stepIndex + 1];
  const goBackStep = () => setStep(steps[stepIndex - 1] ?? 'base');
  const disableLoanMode = () => {
    setLoanMode(false);
    setStep('base');
  };
  const disableCcMode = () => {
    setCcMode(false);
    setStep('base');
  };

  const snapshot = JSON.stringify({
    form,
    amountText,
    ccMode,
    ccTargetName,
    ccCategoryId,
    loanMode,
    loanName,
    loanEndDate,
    loanFromAccountId,
    ccEndDate,
    ruleMode,
    ruleEveryText,
    rulePostingDate,
    creditIds,
    debitIds,
    splitTexts,
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

  /**
   * ローンの入力検証（保存境界 createLoanPurchase と同じ式で先に理由を示す）。
   * 完済日が正: 回数・月々の額は完済日から導出する。1 回も刻みが立たない完済日は
   * 「完済日に全額 1 本」の縮退なので拒否しない（旧・起票ゼロ拒否は廃止・v13.13）。
   */
  function validateLoan(): boolean {
    const nameBad = loanName.trim() === '';
    const fromBad = loanFromAccountId === '';
    const endBad = !loanEndValid || loanTermTooLong;
    setLoanNameError(nameBad);
    setLoanFromError(fromBad);
    setLoanEndDateError(endBad);
    return !nameBad && !fromBad && !endBad;
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

    const ccActive = canCreateContinuousCost && ccMode && !ruleActive;

    /*
     * 諸口（v13.16 §2.3）: 複数側の科目 × 振り分け額で**通常の 2 行仕訳 N 本 + 同一 groupId**
     * を単一トランザクションで保存する（経路 = createEntries・新しい保存 API は作らない）。
     * 自動枠（末尾）= 合計 − Σ手入力。負・0 はエラーで保存不可（0 円の行は作らない）。
     */
    if (splitActive) {
      const amountsBad = splitManualAmounts.some((a) => !Number.isInteger(a) || a < 1);
      const autoBad = !Number.isInteger(splitAutoAmount) || splitAutoAmount < 1;
      setSplitAmountsInvalid(amountsBad);
      setSplitAutoInvalid(!amountsBad && autoBad);
      if (amountsBad || autoBad) return;
      // 振替は各ペアの流れも通常保存と同じ規則で検証する（picker の role 制限 + 二重防御）。
      if (mode === 'transfer') {
        for (const id of splitIds) {
          const srcRole = accounts.find(
            (a) => a.id === (splitSide === 'credit' ? id : toSave.creditAccountId),
          )?.role;
          const dstRole = accounts.find(
            (a) => a.id === (splitSide === 'debit' ? id : toSave.debitAccountId),
          )?.role;
          if (!srcRole || !dstRole || !transferFlowValid(srcRole, dstRole)) {
            setFlowError(t('entry.error.invalid-transfer'));
            setStep('base');
            return;
          }
        }
      }
      const amounts = [...splitManualAmounts, splitAutoAmount];
      const groupId = newId();
      setSubmitting(true);
      try {
        await createEntries(
          splitIds.map((id, i) => ({
            date: toSave.date,
            description: toSave.description,
            amount: amounts[i]!,
            debitAccountId: splitSide === 'debit' ? id : toSave.debitAccountId,
            creditAccountId: splitSide === 'credit' ? id : toSave.creditAccountId,
            kind: 'normal' as const,
            metadata: { inputMode: resolveInputMode() },
            groupId,
          })),
        );
        onClose();
      } catch {
        setSubmitting(false);
      }
      return;
    }

    /*
     * ルールにする（v13.15 §2.2）: **ルールだけが保存される**（完全導出 — 単発仕訳は
     * 保存されず、初回起票日 = base の日付なら導出行が即日並ぶ）。
     * 写像は全モード単一規則: 計上先（spread）= base の借方 / 源泉 = base の貸方。
     * ローン併用（§2.4）は「新しいローン」の負債 + loan ブロック付きルールを 1 tx で作る。
     */
    if (ruleActive) {
      const every = ruleEveryText === '' ? Number.NaN : Number.parseInt(ruleEveryText, 10);
      const everyBad = !Number.isInteger(every) || every < 1 || every > MONTHLY_AMOUNTS_HARD_CAP;
      const pd = rulePostingDate.trim() === '' ? toSave.date : rulePostingDate.trim();
      const pdBad = !isValidIsoDate(pd);
      setRuleEveryError(everyBad);
      setRulePostingDateError(pdBad);
      if (everyBad || pdBad) return;
      let loanBlock: { repaymentSourceAccountId: string; repaymentMonths: number } | undefined;
      if (loanActive) {
        // 完済日（絶対日付の入力）→ repaymentMonths（相対月数）。相対にするのは
        // 周期ごとに完済日がずれるため（§2.4 の保存形）。
        const months = monthsBetween(monthOf(pd), monthOf(loanEndDate.trim()));
        if (months < 1 || months > MONTHLY_AMOUNTS_HARD_CAP) {
          setLoanEndDateError(true);
          setStep('loan');
          return;
        }
        loanBlock = { repaymentSourceAccountId: loanFromAccountId, repaymentMonths: months };
      }
      setSubmitting(true);
      try {
        await createRecurringRule({
          name: toSave.description.trim(),
          amount: toSave.amount,
          dayOfMonth: Number.parseInt(pd.slice(8, 10), 10),
          everyMonths: every,
          debitAccountId: toSave.debitAccountId,
          creditAccountId: loanBlock !== undefined ? '' : toSave.creditAccountId,
          ...(loanBlock !== undefined
            ? { newLoanAccount: { name: loanName.trim() }, loan: loanBlock }
            : {}),
          startMonth: monthOf(pd),
          startDate: pd,
        });
        onClose();
      } catch {
        setSubmitting(false);
      }
      return;
    }

    // ローンで払う: 負債科目 + 購入の仕訳 + 返済ルール（+ 持ち物）を 1 tx で作る。
    if (loanActive) {
      const found: EntryValidationError[] = [];
      if (toSave.date.trim() === '') found.push('date-required');
      if (!Number.isInteger(toSave.amount) || toSave.amount < 1) found.push('amount-invalid');
      if (!ccActive && toSave.debitAccountId === '') found.push('debit-required');
      setErrors(found);
      const ccNameBad = ccActive && ccTargetName.trim() === '';
      const categoryBad = ccActive && ccCategoryId === '';
      setCcNameError(ccNameBad);
      setCategoryError(categoryBad);
      const loanOk = validateLoan();
      setFlowError(undefined);
      if (found.length > 0 || ccNameBad || categoryBad || !loanOk) return;
      setSubmitting(true);
      try {
        await createLoanPurchase({
          loanName: loanName.trim(),
          date: toSave.date,
          description: toSave.description,
          amount: toSave.amount,
          expenseAccountId: ccActive ? ccCategoryId : toSave.debitAccountId,
          repaymentSourceAccountId: loanFromAccountId,
          repaymentEndDate: loanEndDate.trim(),
          ...(ccActive
            ? {
                continuousCost: {
                  name: ccTargetName.trim(),
                  ...(ccEndDate.trim() !== '' ? { endDate: ccEndDate.trim() } : {}),
                },
              }
            : {}),
        });
        onClose();
      } catch {
        setSubmitting(false);
      }
      return;
    }

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
      setFlowError(undefined);
      if (found.length > 0 || nameBad || categoryBad) return;
      setSubmitting(true);
      try {
        // 購入の仕訳（保存される仕訳）+ item を 1 トランザクションで登録する。
        // 開始日 = 仕訳の日付・支払い元 = ユーザーが選んだ貸方。終了日は空でよい。
        await createContinuousCost({
          name: ccTargetName.trim(),
          amount: toSave.amount,
          startDate: toSave.date,
          ...(ccEndDate.trim() !== '' ? { endDate: ccEndDate.trim() } : {}),
          expenseAccountId: ccCategoryId,
          creditAccountId: toSave.creditAccountId,
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

  /**
   * 基本の画面（1 ページ目）で決着させる検証。**そのページが持つ欄だけ**を見る
   * （エラーは必ずその欄が見えているページに出す）。条件は最終的な保存境界と同じ:
   *  - ローンを選んだら支払い元は「新しいローン」に決まる = 貸方は要らない
   *  - 持ち物を選んだら使い道は持ち物の計上先（次のページ）に決まる = 借方は要らない
   */
  function validateBaseStep(): boolean {
    const toSave = effectiveForm();
    const found: EntryValidationError[] = [];
    if (toSave.date.trim() === '') found.push('date-required');
    if (mode !== 'transfer' && toSave.description.trim() === '') found.push('description-required');
    if (!Number.isInteger(toSave.amount) || toSave.amount < 1) found.push('amount-invalid');
    if (!loanActive && toSave.creditAccountId === '') found.push('credit-required');
    if (!continuousCostActive && toSave.debitAccountId === '') found.push('debit-required');
    setErrors(found);
    setFlowError(undefined);
    return found.length === 0;
  }

  /**
   * 主ボタン。最後のページだけが「保存」で、手前のページは次のページへ進む。
   * 進むときに今のページを検証する（後のページで前のページのエラーを出さない）。
   */
  async function onPrimary() {
    if (nextStep === undefined) {
      await onSave();
      return;
    }
    if (activeStep === 'base' && !validateBaseStep()) return;
    if (activeStep === 'loan' && !validateLoan()) return;
    // 名前は摘要から引き継ぐ（ページを分けても一度書いた語を書き直させない）。
    if (nextStep === 'loan' && loanName.trim() === '') setLoanName(form.description);
    if (nextStep === 'item' && ccTargetName.trim() === '') setCcTargetName(form.description);
    // 初回の起票日は base の日付から引き継ぐ（モックの「日付欄から自動」）。
    if (nextStep === 'rule' && rulePostingDate.trim() === '') setRulePostingDate(form.date);
    // 計上先は base の使い道から引き継ぐ（v13.15 §2.2・モックの「使い道から自動」）。
    // 引き継げるのは月割りの計上先に使える役割のときだけ（袋小路を作らない）。
    if (nextStep === 'item' && ccCategoryId === '' && form.debitAccountId !== '') {
      const role = accounts.find((a) => a.id === form.debitAccountId)?.role;
      if (role !== undefined && isRecurringPostableRole(role)) setCcCategoryId(form.debitAccountId);
    }
    setStep(nextStep);
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
        min={MIN_LEDGER_DATE}
        max={MAX_LEDGER_DATE}
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
      <button
        type="button"
        className="collapse-toggle"
        onClick={disableCcMode}
        data-ui={UI.journal.entry.ccBackToCategory}
      >
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
    return (
      <FlowField
        hint={t(flowDef.flowLabelKey)}
        dataUi={UI.journal.entry.flow}
        source={
          loanActive ? (
            // 選んだ状態だけを名乗る。ローンの中身（名前・終了日・返済元）は次のページ。
            <div className="field">
              <span className="field__label">{t(flowDef.source.labelKey)}</span>
              <div className="list__title" data-ui={UI.journal.entry.loanSelected}>
                {t('entry.loanSelected')}
              </div>
              <button
                type="button"
                className="collapse-toggle"
                onClick={disableLoanMode}
                data-ui={UI.journal.entry.loanArrangeBack}
              >
                {t('entry.loanArrangeBack')}
              </button>
            </div>
          ) : (
            <AccountPicker
              flat
              label={t(flowDef.source.labelKey)}
              required
              {...(splitPickersEnabled && debitIds.length <= 1
                ? {
                    multi: {
                      values: creditIds,
                      onValuesChange: (ids) => setSideIds('credit', ids),
                    },
                  }
                : {
                    value: form.creditAccountId,
                    onChange: (id) => setSideSingle('credit', id),
                    ...(splitPickersEnabled && debitIds.length >= 2
                      ? { hint: t('entry.splitLockedHint') }
                      : {}),
                  })}
              groups={srcGroups}
              error={errorText(errors, 'credit-required') ?? sameAccount}
              dataUi={UI.journal.entry.flowSource}
            />
          )
        }
        destination={
          canCreateContinuousCost && ccMode ? (
            // 同じく選択だけ。持ち物の名前・計上先・終了日は次のページ。
            <div className="field">
              <span className="field__label">{t(flowDef.destination.labelKey)}</span>
              <div className="list__title" data-ui={UI.journal.entry.ccSelected}>
                {t('entry.ccSelected')}
              </div>
              <button
                type="button"
                className="collapse-toggle"
                onClick={disableCcMode}
                data-ui={UI.journal.entry.ccBackToCategory}
              >
                {t('entry.ccBackToCategory')}
              </button>
            </div>
          ) : lockedDebit ? (
            // 購入の仕訳の借方 = 継続コスト台帳（固定）。日付・金額・貸方だけ編集できる。
            readOnlyAccount(flowDef.destination.labelKey, form.debitAccountId)
          ) : (
            <AccountPicker
              flat
              label={t(flowDef.destination.labelKey)}
              required
              {...(splitPickersEnabled && creditIds.length <= 1
                ? { multi: { values: debitIds, onValuesChange: (ids) => setSideIds('debit', ids) } }
                : {
                    value: form.debitAccountId,
                    onChange: (id) => setSideSingle('debit', id),
                    ...(splitPickersEnabled && creditIds.length >= 2
                      ? { hint: t('entry.splitLockedHint') }
                      : {}),
                  })}
              groups={dstGroups}
              error={errorText(errors, 'debit-required')}
              dataUi={UI.journal.entry.flowDestination}
            />
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
            {...(splitPickersEnabled && debitIds.length <= 1
              ? { multi: { values: creditIds, onValuesChange: (ids) => setSideIds('credit', ids) } }
              : {
                  value: form.creditAccountId,
                  onChange: (id) => setSideSingle('credit', id),
                  ...(splitPickersEnabled && debitIds.length >= 2
                    ? { hint: t('entry.splitLockedHint') }
                    : {}),
                })}
            groups={srcGroups}
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
              {...(splitPickersEnabled && creditIds.length <= 1
                ? { multi: { values: debitIds, onValuesChange: (ids) => setSideIds('debit', ids) } }
                : {
                    value: form.debitAccountId,
                    onChange: (id) => setSideSingle('debit', id),
                    ...(splitPickersEnabled && creditIds.length >= 2
                      ? { hint: t('entry.splitLockedHint') }
                      : {}),
                  })}
              groups={dstGroups}
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
          min={MIN_LEDGER_DATE}
          max={MAX_LEDGER_DATE}
          dataUi={UI.journal.entry.ccEndDate}
        />
        <div className="row-actions">
          {LOAN_QUICK_YEARS.map((years) => (
            <button
              key={years}
              type="button"
              className="btn btn--ghost"
              style={{ minHeight: 'var(--tap)' }}
              onClick={() => setCcEndDate(quickSpanEndDate(form.date, years))}
              data-ui={UI.journal.entry.ccQuickSpan}
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

  /*
   * 削除セクション（編集時のみ・最下部）。購入の仕訳は item と 1:1 なので削除できない
   * （持ち物側の削除に同乗する）: 理由ごと見せて不活性にする（fail-closed の理由開示）。
   * 実取引の取り消しは反対仕訳（行アクション側の動詞）— 注意文で誘導する。
   */
  const deleteSection =
    init.kind === 'edit' ? (
      <div className="stack" style={{ marginTop: 'var(--space-4)' }}>
        <button
          type="button"
          className="btn btn--danger"
          style={{ minHeight: 'var(--tap)' }}
          disabled={submitting || lockedDebit}
          onClick={() => setPendingDelete(true)}
          data-ui={UI.journal.entry.delete}
        >
          {t('entry.deleteAction')}
        </button>
        <p className="field__hint">
          {lockedDebit ? t('error.entry.monthlyCost') : t('entry.deleteDangerHint')}
        </p>
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

  /*
   * 性質トグル列（v13.15 §2.2・モック正本）: base ページ下部に ローン → 持ち物 → ルール の順。
   * 「ルールにする」は全モード直交（ローンは支出のみ）。ルール ON は持ち物トグルを畳み、
   * 理由はヒント 1 行で名乗る（説明帯は置かない・§2.3）。
   */
  const natureToggle = (checked: boolean, onToggle: () => void, label: string, dataUi: string) => (
    <label className="chip">
      <input
        type="checkbox"
        className="sr-only"
        checked={checked}
        onChange={onToggle}
        data-ui={dataUi}
      />
      <span className="chip__check" aria-hidden="true">
        <Icon name="check" size={14} />
      </span>
      <span className="chip__text">{label}</span>
    </label>
  );
  /*
   * 性質トグルの相互排他表（宣言的・v13.16 §6-3）。値 = 畳む理由（undefined = 出す）:
   *  - 'split' = 複数選択（諸口）中は 3 トグルとも畳む（購入仕訳は item と 1:1 ミラー・
   *    ルールは単一フローの宣言 — 排他は作者承認 2026-08-21）
   *  - 'rule' = ルール ON は持ち物を畳む（毎周期の item は台帳経由で自動・§2.3）
   */
  const toggleFolds: Record<'loan' | 'item' | 'rule', 'split' | 'rule' | undefined> = {
    loan: splitActive ? 'split' : undefined,
    item: splitActive ? 'split' : ruleActive ? 'rule' : undefined,
    rule: splitActive ? 'split' : undefined,
  };
  const natureSection =
    init.kind === 'create' && !isManual ? (
      <div className="field" data-ui={UI.journal.entry.nature}>
        <span className="field__label">{t('entry.natureLabel')}</span>
        <div className="picker__chips">
          {canArrangeLoan && toggleFolds.loan === undefined
            ? natureToggle(
                loanMode,
                () => (loanMode ? disableLoanMode() : enableLoanMode()),
                t('entry.loanArrange'),
                UI.journal.entry.loanArrange,
              )
            : null}
          {canCreateContinuousCost && toggleFolds.item === undefined
            ? natureToggle(
                ccMode,
                () => (ccMode ? disableCcMode() : enableCcMode()),
                t('entry.ccToggle'),
                UI.journal.entry.ccToggle,
              )
            : null}
          {canMakeRule && toggleFolds.rule === undefined
            ? natureToggle(
                ruleMode,
                () => (ruleMode ? disableRuleMode() : enableRuleMode()),
                t('entry.ruleToggle'),
                UI.journal.entry.ruleToggle,
              )
            : null}
        </div>
        {toggleFolds.item === 'rule' && canCreateContinuousCost ? (
          <p className="field__hint" data-ui={UI.journal.entry.ccFoldedByRule}>
            {t('entry.ccFoldedByRule')}
          </p>
        ) : null}
        {splitActive ? (
          <p className="field__hint" data-ui={UI.journal.entry.natureFoldedBySplit}>
            {t('entry.natureFoldedBySplit')}
          </p>
        ) : (
          <p className="field__hint">{t('entry.natureHint')}</p>
        )}
      </div>
    ) : null;

  // ページの名前（1 枚しかないときは出さない = 従来の見た目を変えない）。
  const stepTitle =
    activeStep === 'loan'
      ? t('entry.stepTitleLoan')
      : activeStep === 'item'
        ? t('entry.stepTitleItem')
        : activeStep === 'rule'
          ? t('entry.stepTitleRule')
          : activeStep === 'split'
            ? t('entry.stepTitleSplit')
            : title;
  const stepIndicator =
    steps.length > 1 ? (
      <p className="field__hint" data-ui={UI.journal.entry.step}>
        {t('entry.stepIndicator', {
          current: stepIndex + 1,
          total: steps.length,
          title: stepTitle,
        })}
      </p>
    ) : null;

  return (
    <>
      <Modal
        // 見出しは sr-only。ページを分けたときは読み上げにも今のページ名を載せる。
        title={activeStep === 'base' ? title : `${title} — ${stepTitle}`}
        onClose={requestClose}
        dismissMode="if-clean"
        titleVariant="sr-only"
        scrollKey={`${mode}:${activeStep}`}
        footer={
          <>
            {/* 手前のページがあれば「戻る」（入力は保持する）。無ければ従来のキャンセル。
                × と端末の戻るは常に「シートを閉じる」= dirty guard の破棄確認を経由する。 */}
            <button
              type="button"
              className="btn btn--ghost"
              onClick={activeStep === 'base' ? requestClose : goBackStep}
              data-ui={activeStep === 'base' ? UI.journal.entry.cancel : UI.journal.entry.stepBack}
            >
              {activeStep === 'base' ? t('common.cancel') : t('entry.stepBack')}
            </button>
            <button
              type="button"
              className="btn btn--primary"
              onClick={onPrimary}
              disabled={submitting}
              data-ui={nextStep === undefined ? UI.journal.entry.save : UI.journal.entry.next}
            >
              {nextStep === 'loan'
                ? t('entry.stepNextLoan')
                : nextStep === 'item'
                  ? t('entry.stepNextItem')
                  : nextStep === 'rule'
                    ? t('entry.stepNextRule')
                    : nextStep === 'split'
                      ? t('entry.stepNextSplit')
                      : ruleActive
                        ? t('entry.saveRule')
                        : t('common.save')}
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

        {isManual && activeStep === 'base' ? (
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
            {deleteSection}
          </>
        ) : activeStep === 'loan' ? (
          // 2 ページ目: ローンだけの画面（名前 → 完済日 → 返済元 → 導出のプレビュー）。
          <>
            {stepIndicator}
            <EntryLoanStep
              accounts={accounts}
              currency={currency}
              fractionDigits={fractionDigits}
              amount={form.amount}
              purchaseDate={form.date}
              name={loanName}
              endDate={loanEndDate}
              fromAccountId={loanFromAccountId}
              nameError={loanNameError}
              endDateError={loanEndDateError}
              fromError={loanFromError}
              derived={{
                firstDate: loanFirstDate,
                end: loanEnd,
                count: loanCount,
                lump: loanLump,
                firstAmount: loanFirstAmount,
                amountValid: loanAmountValid,
                termTooLong: loanTermTooLong,
              }}
              onNameChange={(v) => {
                setLoanName(v);
                setLoanNameError(false);
              }}
              onEndDateChange={(v) => {
                setLoanEndDate(v);
                setLoanEndDateError(false);
              }}
              onFromChange={(id) => {
                setLoanFromAccountId(id);
                setLoanFromError(false);
              }}
              onDisable={disableLoanMode}
            />
          </>
        ) : activeStep === 'item' ? (
          // 持ち物だけの画面（名前 → 計上先 → 終了日 → まとめカード・ローンページと同一解剖）。
          <>
            {stepIndicator}
            <EntryItemStep
              accounts={accounts}
              currency={currency}
              fractionDigits={fractionDigits}
              amount={form.amount}
              purchaseDate={form.date}
              name={ccTargetName}
              categoryId={ccCategoryId}
              endDate={ccEndDate}
              nameError={ccNameError}
              categoryError={categoryError}
              derived={{
                end: ccEndValid ? ccEnd : '',
                count: ccCount,
                firstAmount: ccFirstAmount,
                amountValid: loanAmountValid,
              }}
              onNameChange={(v) => {
                setCcTargetName(v);
                setCcNameError(false);
              }}
              onCategoryChange={(id) => {
                setCcCategoryId(id);
                setCategoryError(false);
              }}
              onEndDateChange={setCcEndDate}
              onDisable={disableCcMode}
            />
          </>
        ) : activeStep === 'rule' ? (
          // 最後のページ: ルールだけの画面（周期 → 起票日 → まとめカード・モック正本の並び）。
          <>
            {stepIndicator}
            <EntryRuleStep
              everyText={ruleEveryText}
              postingDate={rulePd}
              everyError={ruleEveryError}
              postingDateError={rulePostingDateError}
              summary={
                ruleEveryValid && isValidIsoDate(rulePd) && loanAmountValid
                  ? {
                      firstPostingDate: rulePd,
                      sentence:
                        loanActive && ruleLoanMonths >= 1
                          ? t('entry.rulePreviewLoan', {
                              every: ruleEveryValue,
                              name: effectiveForm().description,
                              amount: moneyText(form.amount, currency, fractionDigits),
                              monthly: moneyText(ruleLoanMonthly, currency, fractionDigits),
                            })
                          : t('entry.rulePreview', {
                              every: ruleEveryValue,
                              name: effectiveForm().description,
                              amount: moneyText(form.amount, currency, fractionDigits),
                            }),
                    }
                  : null
              }
              onEveryTextChange={(v) => {
                setRuleEveryText(v);
                setRuleEveryError(false);
              }}
              onPostingDateChange={(v) => {
                setRulePostingDate(v);
                setRulePostingDateError(false);
              }}
              onDisable={disableRuleMode}
            />
          </>
        ) : activeStep === 'split' ? (
          // 振り分けページ（v13.16 諸口）: 選択順の枠 + 末尾は自動計算 + まとめカード。
          <>
            {stepIndicator}
            <EntrySplitStep
              accounts={accounts}
              currency={currency}
              fractionDigits={fractionDigits}
              total={form.amount}
              ids={splitIds}
              texts={splitTexts}
              autoAmount={splitAutoAmount}
              amountsInvalid={splitAmountsInvalid}
              autoInvalid={splitAutoInvalid}
              onTextChange={(id, v) => {
                setSplitTexts((cur) => ({
                  ...cur,
                  [id]: sanitizeAmountText(v, fractionDigits, cur[id] ?? ''),
                }));
                setSplitAmountsInvalid(false);
                setSplitAutoInvalid(false);
              }}
            />
          </>
        ) : (
          <>
            {stepIndicator}
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
            {mode === 'transfer' ? null : itemField}
            {amountField}
            {/* 反対仕訳は常に簿記編集（上の分岐）だが、日常入力側にも同じ位置で置いておく。 */}
            {reversalOverWarning}
            {renderFlow()}
            {natureSection}

            {/* メモ欄は v14 で全廃（作者決定 2026-08-21）。詳細の折りたたみは
                振替の任意の項目名だけが残る（他のモードでは畳むものが無い）。 */}
            {fixed || mode !== 'transfer' ? null : (
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
                {showDetails ? <div className="stack">{itemField}</div> : null}
              </>
            )}

            {deleteSection}
            {manualSwitch}
          </>
        )}
      </Modal>
      {pendingDelete && init.kind === 'edit' ? (
        <ConfirmDialog
          title={t('journal.deleteConfirmTitle')}
          body={t('journal.deleteConfirmBody', { description: init.entry.description })}
          confirmLabel={t('common.delete')}
          danger
          onCancel={() => setPendingDelete(false)}
          onConfirm={async () => {
            try {
              await removeEntry(init.entry.id, init.entry.description);
            } catch {
              // 失敗 = 未保存: 閉じない（エラーは store が toast 済み・確定中状態は ConfirmDialog が解く）。
              return;
            }
            setPendingDelete(false);
            onClose();
          }}
        />
      ) : null}
      {discardConfirm}
    </>
  );
}
