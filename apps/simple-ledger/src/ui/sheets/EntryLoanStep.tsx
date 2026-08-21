/*
 * 支出シートの「ローンの入力」ページ部品（名前 → 完済日 → 返済元 → 導出のプレビュー）。
 * v13.15 §2.1: EntrySheet.tsx からの機械的な切り出し（挙動不変）。state は EntrySheet が持ち、
 * ここは表示と入力の受け渡しだけ（導出値も親で計算済みのものを受け取る）。
 */
import { TextInput } from '@snishi/foundation/ui/Field';
import { AccountPicker } from '../AccountPicker';
import { groupedAccountsByRole } from '../accountOptions';
import { MONTHLY_AMOUNTS_HARD_CAP } from '../../domain/allocation';
import { LOAN_QUICK_YEARS, loanQuickEndDate } from '../../domain/loan';
import { MAX_LEDGER_DATE, MIN_LEDGER_DATE } from '../../domain/calendar';
import { RECURRING_POSTABLE_ROLES } from '../../domain/recurring';
import { moneyText } from '../money';
import type { Account } from '../../domain/types';
import type { FractionDigits } from '../../util/format';
import { t } from '../../i18n';
import { UI } from '../../ui-contract';

/** 親（EntrySheet）で計算済みの導出値（保存境界と同じ式・render で投げない検証済み）。 */
export interface EntryLoanDerived {
  /** 初回返済日 = 購入日の 1 か月後（ヒントと返済元ピッカーの存在日判定に使う）。 */
  firstDate: string;
  /** trim 済み完済日（縮退プレビューの表示用）。 */
  end: string;
  count: number;
  /** 縮退（完済日が購入 1 か月後より前）= 完済日に全額 1 本。 */
  lump: boolean;
  /** 月々の額 = 先頭刻み。 */
  firstAmount: number;
  amountValid: boolean;
  termTooLong: boolean;
}

export function EntryLoanStep({
  accounts,
  currency,
  fractionDigits,
  amount,
  purchaseDate,
  name,
  endDate,
  fromAccountId,
  nameError,
  endDateError,
  fromError,
  derived,
  onNameChange,
  onEndDateChange,
  onFromChange,
  onDisable,
}: {
  accounts: Account[];
  currency: string;
  fractionDigits: FractionDigits;
  /** 借入総額（1 ページ目の金額欄の値）。 */
  amount: number;
  /** 購入日（1 ページ目の日付欄の値）。クイックチップの基点。 */
  purchaseDate: string;
  name: string;
  endDate: string;
  fromAccountId: string;
  nameError: boolean;
  endDateError: boolean;
  fromError: boolean;
  derived: EntryLoanDerived;
  onNameChange: (v: string) => void;
  onEndDateChange: (v: string) => void;
  onFromChange: (id: string) => void;
  /** 「ローンをやめる」（選択解除 + 1 ページ目へ戻る）。 */
  onDisable: () => void;
}) {
  return (
    <>
      <TextInput
        label={t('entry.loanName')}
        required
        value={name}
        placeholder={t('entry.loanNamePlaceholder')}
        hint={t('entry.loanNameHint')}
        onChange={onNameChange}
        error={nameError ? t('entry.error.description-required') : undefined}
        dataUi={UI.journal.entry.loanName}
      />
      <button
        type="button"
        className="collapse-toggle"
        onClick={onDisable}
        data-ui={UI.journal.entry.loanArrangeBack}
      >
        {t('entry.loanArrangeBack')}
      </button>
      {/*
       * ローンの 4 項目（持ち物の参照）: 名前（お金の流れの左辺）・借入額（金額欄）・
       * 購入日（仕訳の日付）・完済日（inclusive）。完済日が正で、回数と月々の額は
       * そこから導出する（端数は monthlyAmounts の合計厳密一致 = 差額の明示は不要・v13.13）。
       * 返済元は自由に動かせるお金に限定せず、全科目（RECURRING_POSTABLE_ROLES）から選べる。
       */}
      <div className="field" data-ui={UI.journal.entry.loanPanel}>
        <TextInput
          label={t('entry.loanEndDate')}
          type="date"
          required
          value={endDate}
          min={MIN_LEDGER_DATE}
          max={MAX_LEDGER_DATE}
          hint={t('entry.loanEndDateHint', { date: derived.firstDate })}
          onChange={onEndDateChange}
          error={
            endDateError
              ? derived.termTooLong
                ? // 上限超過は「不正な日付」と別の理由。黙って飽和せず理由を名乗る。
                  t('entry.error.loanTermTooLong', { max: MONTHLY_AMOUNTS_HARD_CAP })
                : t('entry.error.loanEndDate')
              : undefined
          }
          dataUi={UI.journal.entry.loanEndDate}
        />
        <div className="row-actions">
          {LOAN_QUICK_YEARS.map((years) => (
            <button
              key={years}
              type="button"
              className="btn btn--ghost"
              style={{ minHeight: 'var(--tap)' }}
              onClick={() => onEndDateChange(loanQuickEndDate(purchaseDate, years))}
              data-ui={UI.journal.entry.loanQuickSpan}
            >
              {t('ccItem.quickSpan', { years })}
            </button>
          ))}
        </div>
        <AccountPicker
          label={t('entry.loanFrom')}
          required
          value={fromAccountId}
          groups={groupedAccountsByRole(
            accounts,
            [...RECURRING_POSTABLE_ROLES],
            fromAccountId,
            derived.firstDate,
          )}
          onChange={onFromChange}
          error={fromError ? t('entry.error.loanFrom') : undefined}
          dataUi={UI.journal.entry.loanFrom}
        />
        {derived.count >= 1 && derived.amountValid ? (
          <p className="field__hint" data-ui={UI.journal.entry.loanPreview}>
            {derived.lump
              ? t('entry.loanPreviewLump', {
                  date: derived.end,
                  total: moneyText(amount, currency, fractionDigits),
                })
              : t('entry.loanPreview', {
                  amount: moneyText(derived.firstAmount, currency, fractionDigits),
                  count: derived.count,
                  total: moneyText(amount, currency, fractionDigits),
                })}
          </p>
        ) : null}
      </div>
    </>
  );
}
