/*
 * カード・ローンの返済計画を登録するシート。
 *
 * v13.4 ④（作者確定 2026-08-17）: 資金繰り（Cashflow.tsx）から**月割り台帳の「支払用負債」
 * セクション**へ移設した（資金繰り = 表示・台帳 = 編集）。画面から切り離した独立ファイルなので、
 * 開く側は「負債の科目 + その断面の残高」だけを渡す。
 *
 * 勘定科目の返済設定（返済口座・毎月の返済日）が既定値になる。金額の既定はいまの残高（全額）。
 *  - 回数 1（既定）: カードの次回引落など、支払日の振替仕訳（借方 負債 / 貸方 返済口座）を 1 本。
 *  - 回数 N: 毎月同額のローン。総額を N 回に配分した未来の振替仕訳を一括登録（合計は総額に一致）。
 * どちらも未来日付の実仕訳として仕訳一覧・資金繰りの投影に乗る。
 */
import { useState } from 'react';
import { SelectInput, TextInput } from '@snishi/foundation/ui/Field';
import { Icon } from '@snishi/foundation/ui/Icon';
import { Modal } from './overlays';
import { useLedger } from '../state/store';
import { nextRepaymentDate } from '../domain/cashflow';
import { MONTHLY_AMOUNTS_HARD_CAP, monthlyAmounts } from '../domain/allocation';
import { sortAccounts } from '../domain/displayOrder';
import { todayLocal } from '../util/time';
import type { Account } from '../domain/types';
import { errorText, t } from '../i18n';
import {
  exactDigitsFor,
  formatMinorForInput,
  parseAmountToMinor,
  sanitizeAmountText,
} from './amountText';
import { useMoneyDigits } from './money';
import { formatMoney } from '../util/format';
import { UI } from '../ui-contract';

export function RepaymentScheduleSheet({
  account,
  balance,
  onClose,
}: {
  account: Account;
  /** 開いた画面の断面での導出残高（金額の既定 = 全額）。 */
  balance: number;
  onClose: () => void;
}) {
  const { ledger, createRepaymentEntries } = useLedger();
  const accounts = ledger?.accounts ?? [];
  const currency = ledger?.settings.currency ?? '';
  // 書込フォームの**日付の既定値**（today 規約 (a)）。表示の導出には使わない。
  const today = todayLocal();

  const fromOptions = sortAccounts(accounts)
    .filter((a) => a.role === 'daily-asset' && (!a.archived || a.id === account.repaymentAccountId))
    .map((a) => ({ value: a.id, label: a.name }));
  const [fromAccountId, setFromAccountId] = useState(
    account.repaymentAccountId ?? fromOptions[0]?.value ?? '',
  );
  const [date, setDate] = useState(
    account.repaymentDay !== undefined ? nextRepaymentDate(today, account.repaymentDay) : today,
  );
  const digits = useMoneyDigits();
  // 既定は「残高全額」なので、表示桁が粗くても端数を落とさず全額を見せる。
  const amountDigits =
    balance > 0 ? (Math.max(digits, exactDigitsFor(balance)) as typeof digits) : digits;
  const [amountText, setAmountText] = useState(
    balance > 0 ? formatMinorForInput(balance, amountDigits) : '',
  );
  const [countText, setCountText] = useState('1');
  const [error, setError] = useState<string | undefined>(undefined);
  const [submitting, setSubmitting] = useState(false);

  const amount = parseAmountToMinor(amountText) ?? 0;
  const count = countText === '' ? 0 : Number.parseInt(countText, 10);
  // プレビューは保存側と同じ monthlyAmounts の先頭額（独自の丸めを持たない・指示書v3 §A-2）。
  // 表示条件 = 最終回 > 0（プレビューが出た = 保存できる、が成立。§R-1 と同条件）。
  const repayParts =
    count >= 2 && count <= MONTHLY_AMOUNTS_HARD_CAP && amount >= count
      ? monthlyAmounts(amount, count)
      : null;
  const perMonth = repayParts !== null && repayParts.at(-1)! > 0 ? repayParts[0]! : null;

  async function submit() {
    if (submitting) return;
    if (!Number.isInteger(amount) || amount < 1 || fromAccountId === '') return;
    if (!Number.isInteger(count) || count < 1 || count > MONTHLY_AMOUNTS_HARD_CAP) {
      setError(t('error.repay.countInvalid', { max: MONTHLY_AMOUNTS_HARD_CAP }));
      return;
    }
    // 保存境界（buildRepaymentEntries）と同じ条件を先に検証して理由を示す（0 金額の回の防止）。
    if (amount < count) {
      setError(t('error.repay.totalTooSmall'));
      return;
    }
    setSubmitting(true);
    setError(undefined);
    try {
      await createRepaymentEntries({
        liabilityAccountId: account.id,
        fromAccountId,
        firstDate: date,
        total: amount,
        count,
        title: t('repay.scheduleTitle', { name: account.name }),
      });
      onClose();
    } catch (e) {
      setError(errorText(e));
      setSubmitting(false);
    }
  }

  return (
    <Modal
      title={t('repay.title')}
      onClose={onClose}
      dismissMode="if-clean"
      dataUi={UI.allocations.repaySheet}
      footer={
        <>
          <button type="button" className="btn btn--ghost" onClick={onClose}>
            {t('common.cancel')}
          </button>
          <button
            type="button"
            className="btn btn--primary"
            onClick={submit}
            disabled={submitting || amountText === '' || countText === '' || fromAccountId === ''}
            data-ui={UI.allocations.repaySave}
          >
            {t('common.save')}
          </button>
        </>
      }
    >
      <div className="stack">
        <p className="field__hint">{t('repay.intro', { name: account.name })}</p>
        {account.repaymentAccountId === undefined || account.repaymentDay === undefined ? (
          <p className="field__hint">{t('repay.settingsHint')}</p>
        ) : null}
        {error ? (
          <div className="field__error" role="alert">
            <Icon name="alert" size={14} />
            {error}
          </div>
        ) : null}
        <SelectInput
          label={t('repay.from')}
          value={fromAccountId}
          onChange={setFromAccountId}
          options={fromOptions}
          dataUi={UI.allocations.repayFrom}
        />
        <TextInput
          label={t('repay.date')}
          type="date"
          required
          value={date}
          onChange={setDate}
          dataUi={UI.allocations.repayDate}
        />
        <TextInput
          label={t('repay.amount')}
          required
          inputMode={amountDigits === 0 ? 'numeric' : 'decimal'}
          value={amountText}
          onChange={(v) => setAmountText(sanitizeAmountText(v, amountDigits, amountText))}
          hint={t('repay.amountHint')}
          dataUi={UI.allocations.repayAmount}
        />
        <TextInput
          label={t('repay.count')}
          required
          inputMode="numeric"
          value={countText}
          onChange={(v) => setCountText(v.replace(/[^\d]/g, ''))}
          hint={t('repay.countHint', { max: MONTHLY_AMOUNTS_HARD_CAP })}
          dataUi={UI.allocations.repayCount}
        />
        {perMonth !== null ? (
          <p className="field__hint" data-ui={UI.allocations.repayPerMonth}>
            {t('repay.perMonth', {
              amount: formatMoney(perMonth, currency, digits),
              count: String(count),
            })}
          </p>
        ) : null}
      </div>
    </Modal>
  );
}
