/*
 * 支出シートの「持ち物の入力」ページ部品（名前 → 計上先 → 終了日 → まとめカード）。
 * v13.15 §2.2: ページ解剖をローンページ（EntryLoanStep）に揃える —
 * フィールド群 + 自動入力のヒント + 下部のまとめカード、の同一骨格。
 * state は EntrySheet が持ち、ここは表示と入力の受け渡しだけ。
 */
import { TextInput } from '@snishi/foundation/ui/Field';
import { AccountPicker } from '../AccountPicker';
import { groupedMonthlyAllocationAccounts } from '../accountOptions';
import { LOAN_QUICK_YEARS } from '../../domain/loan';
import { quickSpanEndDate } from '../ccQuickSpan';
import { MAX_LEDGER_DATE, MIN_LEDGER_DATE } from '../../domain/calendar';
import { moneyText } from '../money';
import { StepSummaryCard } from './StepSummaryCard';
import type { Account } from '../../domain/types';
import type { FractionDigits } from '../../util/format';
import { t } from '../../i18n';
import { UI } from '../../ui-contract';

/** 親（EntrySheet）で計算済みの導出値（刻み規約の単一正本 = allocationCuts と同じ式）。 */
export interface EntryItemDerived {
  /** trim 済み終了日（縮退表示用。空 = 割り振らない）。 */
  end: string;
  /** 同日通過カウント（dayCutCount）。0 = 終了日に全額 1 本の縮退。 */
  count: number;
  /** 月あたり = 先頭刻み。 */
  firstAmount: number;
  /**
   * 購入額（base の金額欄 = 割り振る総額）が有効か。まとめカードの表示条件
   * （旧名 amountValid — 「この枠の金額」ではなく総額の検証・v13.19 minor③で改名）。
   */
  totalValid: boolean;
}

export function EntryItemStep({
  accounts,
  currency,
  fractionDigits,
  amount,
  purchaseDate,
  name,
  categoryId,
  endDate,
  nameError,
  categoryError,
  derived,
  onNameChange,
  onCategoryChange,
  onEndDateChange,
  onDisable,
}: {
  accounts: Account[];
  currency: string;
  fractionDigits: FractionDigits;
  /** 購入額（1 ページ目の金額欄の値）。 */
  amount: number;
  /** 購入日（1 ページ目の日付欄の値）。クイックチップの基点。 */
  purchaseDate: string;
  name: string;
  categoryId: string;
  endDate: string;
  nameError: boolean;
  categoryError: boolean;
  derived: EntryItemDerived;
  onNameChange: (v: string) => void;
  onCategoryChange: (id: string) => void;
  onEndDateChange: (v: string) => void;
  /** 「持ち物をやめる」（選択解除 + 1 ページ目へ戻る）。 */
  onDisable: () => void;
}) {
  return (
    <>
      <TextInput
        label={t('entry.ccTargetName')}
        required
        value={name}
        placeholder={t('entry.ccTargetName')}
        hint={t('entry.ccTargetNameHint')}
        onChange={onNameChange}
        error={nameError ? t('entry.error.description-required') : undefined}
        dataUi={UI.journal.entry.ccName}
      />
      <button
        type="button"
        className="collapse-toggle"
        onClick={onDisable}
        data-ui={UI.journal.entry.ccBackToCategory}
      >
        {t('entry.ccBackToCategory')}
      </button>
      <div className="field">
        <AccountPicker
          label={t('entry.ccCategory')}
          required
          value={categoryId}
          groups={groupedMonthlyAllocationAccounts(accounts, categoryId, purchaseDate)}
          onChange={onCategoryChange}
          hint={t('entry.ccCategoryHint')}
          error={categoryError ? t('entry.error.category-required') : undefined}
          dataUi={UI.journal.entry.ccCategory}
        />
        <TextInput
          label={t('ccItem.endDate')}
          type="date"
          value={endDate}
          onChange={onEndDateChange}
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
              onClick={() => onEndDateChange(quickSpanEndDate(purchaseDate, years))}
              data-ui={UI.journal.entry.ccQuickSpan}
            >
              {t('ccItem.quickSpan', { years })}
            </button>
          ))}
        </div>
      </div>
      {derived.end !== '' && derived.totalValid ? (
        // 下部まとめカード（月あたり × か月・v13.15 §2.2 = モック正本）。縮退は終了日 1 本を名乗る。
        <StepSummaryCard
          label={t('monthlyCost.monthly')}
          value={
            derived.count === 0
              ? '—'
              : t('entry.ccPreview', {
                  amount: moneyText(derived.firstAmount, currency, fractionDigits),
                  count: derived.count,
                })
          }
          note={
            derived.count === 0
              ? t('entry.ccPreviewLump', {
                  date: derived.end,
                  total: moneyText(amount, currency, fractionDigits),
                })
              : t('entry.previewTotalNote', {
                  total: moneyText(amount, currency, fractionDigits),
                })
          }
          dataUi={UI.journal.entry.ccPreview}
        />
      ) : null}
    </>
  );
}
