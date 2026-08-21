/*
 * ローンの編集シートと終了（一括返済）シート。
 * v13.15 §2.1: Allocations.tsx からの機械的な切り出し（挙動不変）。
 */
/*
 * 月割り台帳。
 *  - くり返し記帳（定期ルール）: 実仕訳の自動起票（正本は起票された仕訳）。
 *    貸方・借方を簿記編集で直接指定し、行き先が費用なら自動で継続コスト台帳を経由する。
 *  - 継続コスト資産: 項目名・金額・開始日・終了日の4項目。終了日までの月割りは導出で、
 *    終了日を過ぎたら一覧から消える（アーカイブ = 終了日の設定）。
 *  - ローン（v13.6 H4）: 専用セクションは持たない。**計上先が負債科目のルール**が
 *    そのままローンで、持ち物・定期と同じ一覧に混在して並ぶ（検索・並び替えが一体で効く）。
 *    ルールを持たない負債（クレカ等）はここに出ない＝区別はルールの有無だけ。
 *    資金繰りの負債行タップ（target.liabilityAccountId）は該当ルール行へ着地する。
 */
import { useEffect, useRef, useState } from 'react';
import { Modal } from '../overlays';
import { TextInput } from '@snishi/foundation/ui/Field';
import { Icon } from '@snishi/foundation/ui/Icon';
import { AccountPicker } from '../AccountPicker';
import { ConfirmDialog } from '../overlays';
import { useLedger } from '../../state/store';
import type {} from '../../domain/accountRoles';
import { sortAccounts } from '../../domain/displayOrder';
import { groupedAccountsByRole } from '../accountOptions';
import { isLedgerDate, MAX_LEDGER_DATE, MIN_LEDGER_DATE } from '../../domain/calendar';
import { nowIso, todayLocal } from '../../util/time';
import { RECURRING_POSTABLE_ROLES } from '../../domain/recurring';
import { LOAN_QUICK_YEARS, loanQuickEndDate, loanRemainingDebt } from '../../domain/loan';
import {
  exactDigitsFor,
  formatMinorForInput,
  parseAmountToMinor,
  sanitizeAmountText,
} from '../amountText';
import { useMoneyDigits } from '../money';
import { moneyText } from '../money';
import { errorText, t } from '../../i18n';
import type {} from '../../i18n';
import type {} from '../../util/format';
import { UI } from '../../ui-contract';
import type {} from '../../data/repository';
import type { JournalEntry, MonthlyCostItem } from '../../domain/types';

/**
 * ローンの編集シート（v13.13）。編集できるのは 名前・金額（借入の仕訳と双方向ミラー）・
 * 完済日・返済元。開始日（購入日）は借入の仕訳の日付のミラーなので読み取り専用
 * （変えるのは仕訳側）。計上先（負債科目）は構造なので出さない。
 */
export function LoanItemSheet({
  existing,
  purchaseEntry,
  onOpenPurchase,
  onClose,
}: {
  existing: MonthlyCostItem;
  purchaseEntry?: JournalEntry | undefined;
  onOpenPurchase: (entry: JournalEntry) => void;
  onClose: () => void;
}) {
  const { ledger, saveMonthlyCost, removeMonthlyCost } = useLedger();
  const accounts = sortAccounts(ledger?.accounts ?? []);
  const [pendingDelete, setPendingDelete] = useState(false);

  const [name, setName] = useState(existing.name);
  const fractionDigits = useMoneyDigits();
  const initialAmountText = formatMinorForInput(existing.amount, fractionDigits);
  const [amountText, setAmountText] = useState(initialAmountText);
  // 変更判定はフラグではなく値（初期表示と同じ文字列に戻れば無変更 = 保存済み minor を保持）。
  const amountDirty = amountText !== initialAmountText;
  const [endDate, setEndDate] = useState(existing.endDate ?? '');
  const [sourceAccountId, setSourceAccountId] = useState(existing.repaymentSourceAccountId ?? '');
  const [error, setError] = useState<string | undefined>(undefined);
  const [submitting, setSubmitting] = useState(false);

  const effectiveAmount = amountDirty ? (parseAmountToMinor(amountText) ?? 0) : existing.amount;
  // 過去から再計算される項目の変更予告（破壊的操作の予告なので削らない）。
  const pastFieldsChanged =
    effectiveAmount !== existing.amount ||
    endDate !== (existing.endDate ?? '') ||
    sourceAccountId !== (existing.repaymentSourceAccountId ?? '');

  async function submit() {
    if (submitting) return;
    const amount = effectiveAmount;
    if (!Number.isInteger(amount) || amount < 1) {
      setError(t('error.common.amountInvalid'));
      return;
    }
    if (endDate.trim() === '') {
      setError(t('entry.error.loanEndDate'));
      return;
    }
    setSubmitting(true);
    setError(undefined);
    try {
      await saveMonthlyCost({
        ...existing,
        name: name.trim(),
        amount,
        endDate: endDate.trim(),
        repaymentSourceAccountId: sourceAccountId,
        updatedAt: nowIso(),
      });
      onClose();
    } catch (e) {
      setError(errorText(e));
      setSubmitting(false);
    }
  }

  return (
    <>
      <Modal
        title={t('loan.editTitle')}
        onClose={onClose}
        dismissMode="if-clean"
        dataUi={UI.allocations.loanSheet}
        footer={
          <>
            <button type="button" className="btn btn--ghost" onClick={onClose}>
              {t('common.cancel')}
            </button>
            <button
              type="button"
              className="btn btn--primary"
              onClick={submit}
              disabled={
                submitting ||
                name.trim() === '' ||
                amountText === '' ||
                endDate === '' ||
                sourceAccountId === ''
              }
              data-ui={UI.allocations.loanSheetSave}
            >
              {t('common.save')}
            </button>
          </>
        }
      >
        <div className="stack">
          {error ? (
            <div className="field__error" role="alert">
              <Icon name="alert" size={14} />
              {error}
            </div>
          ) : null}
          {pastFieldsChanged ? (
            <div
              className="field__warning"
              role="status"
              data-ui={UI.allocations.editImpactWarning}
            >
              <Icon name="alert" size={14} />
              {t('loan.pastRecalcWarning')}
            </div>
          ) : null}
          <TextInput
            label={t('monthlyCost.name')}
            required
            value={name}
            onChange={setName}
            dataUi={UI.allocations.loanSheetName}
          />
          <TextInput
            label={t('loan.amount')}
            required
            inputMode={fractionDigits === 0 ? 'numeric' : 'decimal'}
            value={amountText}
            onChange={(v) => {
              setAmountText(sanitizeAmountText(v, fractionDigits, amountText));
            }}
            hint={t('loan.amountHint')}
            dataUi={UI.allocations.loanSheetAmount}
          />
          {/* 開始日（購入日）= 借入の仕訳の日付。変えるときは仕訳側（タップで開く）。 */}
          <div className="kv" data-ui={UI.allocations.editStartDate}>
            <span className="muted">{t('loan.purchaseDate')}</span>
            <span>{existing.startDate}</span>
          </div>
          {purchaseEntry ? (
            <button
              type="button"
              className="collapse-toggle"
              onClick={() => {
                onClose();
                onOpenPurchase(purchaseEntry);
              }}
              data-ui={UI.allocations.loanSheetOpenBorrow}
            >
              <Icon name="chevronRight" size={16} />
              {t('loan.openBorrow')}
            </button>
          ) : null}
          <TextInput
            label={t('entry.loanEndDate')}
            type="date"
            required
            value={endDate}
            onChange={setEndDate}
            min={MIN_LEDGER_DATE}
            max={MAX_LEDGER_DATE}
            dataUi={UI.allocations.loanSheetEndDate}
          />
          <div className="row-actions" data-ui={UI.allocations.editQuickSpan}>
            {LOAN_QUICK_YEARS.map((years) => (
              <button
                key={years}
                type="button"
                className="btn btn--ghost"
                style={{ minHeight: 'var(--tap)' }}
                onClick={() => setEndDate(loanQuickEndDate(existing.startDate, years))}
              >
                {t('ccItem.quickSpan', { years })}
              </button>
            ))}
          </div>
          <AccountPicker
            label={t('loan.repaymentSource')}
            required
            value={sourceAccountId}
            groups={groupedAccountsByRole(accounts, [...RECURRING_POSTABLE_ROLES], sourceAccountId)
              .map((group) => ({
                ...group,
                // 計上先（負債自身）は返済元にできない（自己振替）。
                accounts: group.accounts.filter(
                  (account) => account.id !== existing.expenseAccountId,
                ),
              }))
              .filter((group) => group.accounts.length > 0)}
            onChange={setSourceAccountId}
            dataUi={UI.allocations.loanSheetSource}
          />
          {/* 破壊的なほど下（動詞体系 v13.1）。削除 = 借入の記録を丸ごと消す cascade。 */}
          <div className="stack" style={{ marginTop: 'var(--space-4)' }}>
            <button
              type="button"
              className="btn btn--danger"
              style={{ minHeight: 'var(--tap)' }}
              disabled={submitting}
              onClick={() => setPendingDelete(true)}
              data-ui={UI.allocations.loanSheetDelete}
            >
              {t('loan.deleteAction')}
            </button>
            <p className="field__hint">{t('loan.deleteDangerHint')}</p>
          </div>
        </div>
      </Modal>
      {pendingDelete ? (
        <ConfirmDialog
          title={t('loan.deleteConfirmTitle')}
          body={t('loan.deleteConfirmBody', { name: existing.name })}
          confirmLabel={t('common.delete')}
          danger
          onCancel={() => setPendingDelete(false)}
          onConfirm={async () => {
            try {
              await removeMonthlyCost(existing.id);
            } catch {
              // 失敗 = 未保存: 閉じない（エラーは store が toast 済み）。
              return;
            }
            setPendingDelete(false);
            onClose();
          }}
        />
      ) : null}
    </>
  );
}

/**
 * ローンの終了 = 一括返済シート（v13.13 §2.4）。持ち物のアーカイブシートと**完全同型**:
 *  1. **終了日 D**: 既定 = 今日（購入日より前にはできない）。
 *  2. **一括返済額**: 既定 = D 時点の理論残債（編集可）。終了日を動かすと、まだ手で
 *     直していない限り既定が追従する（判定はフラグでなく値）。**0 = 単なる短縮**
 *     （全額が [start, D] へ按分し直し = 「編集で完済日を早める」と同じ。編集との違いは
 *     実仕訳が立つかどうか）。
 *  3. **返済元**: 既定 = ローンの返済元・変更可（別口座からの一括返済を許す）。
 * 保存は endDate = D + 一括返済の実仕訳（0〜1 本）を同一トランザクションで（settleLoan）。
 */
export function LoanSettleSheet({
  item,
  spreadTotal,
  onClose,
}: {
  item: MonthlyCostItem;
  spreadTotal: number;
  onClose: () => void;
}) {
  const { ledger, settleLoan } = useLedger();
  const accounts = sortAccounts(ledger?.accounts ?? []);
  const currency = ledger?.settings.currency ?? '';
  const displayDigits = useMoneyDigits();
  const [endDate, setEndDate] = useState(() => {
    const today = todayLocal();
    return today < item.startDate ? item.startDate : today;
  });
  const [sourceAccountId, setSourceAccountId] = useState(item.repaymentSourceAccountId ?? '');
  const [error, setError] = useState<string | undefined>(undefined);
  const [submitting, setSubmitting] = useState(false);
  const submittingRef = useRef(false);

  // 上限（2100 年）超えの終了日で刻みの走査を伸ばさない（保存境界でも拒否される）。
  const dateValid = isLedgerDate(endDate) && endDate >= item.startDate;
  // 理論残債 = 変更前スケジュールでの D 時点の残り（loanRemainingDebt が単一正本。
  // 既存の一括返済は spreadTotal に織り込み済み = 二重に引かない）。
  const remaining = loanRemainingDebt(item, dateValid ? endDate : todayLocal(), spreadTotal);
  // 表示桁 0 の設定でも、この欄だけは端数を隠さない（見えている値 = 保存される値）。
  const digits = Math.max(displayDigits, exactDigitsFor(remaining)) as typeof displayDigits;

  // 一括返済額の既定は終了日に追従する（過返済で負なら 0）。
  const defaultAmountText = formatMinorForInput(Math.max(remaining, 0), digits);
  const [amountText, setAmountText] = useState(defaultAmountText);
  const autoAmountRef = useRef(defaultAmountText);
  useEffect(() => {
    if (defaultAmountText === autoAmountRef.current) return;
    const previousAuto = autoAmountRef.current;
    autoAmountRef.current = defaultAmountText;
    // 既定のままなら追従し、手で直してあればその値を尊重する（判定はフラグではなく値）。
    setAmountText((current) => (current === previousAuto ? defaultAmountText : current));
  }, [defaultAmountText]);

  const settleAmount = parseAmountToMinor(amountText) ?? 0;
  const canSave = dateValid && (settleAmount === 0 || sourceAccountId !== '');

  async function submit(): Promise<void> {
    if (submittingRef.current) return;
    submittingRef.current = true;
    setSubmitting(true);
    setError(undefined);
    try {
      await settleLoan({
        id: item.id,
        endDate,
        ...(settleAmount > 0 ? { settlement: { amount: settleAmount, sourceAccountId } } : {}),
      });
      onClose();
    } catch (e) {
      setError(errorText(e));
      submittingRef.current = false;
      setSubmitting(false);
    }
  }

  return (
    <Modal
      title={t('loan.settleTitle')}
      onClose={onClose}
      dataUi={UI.allocations.loanSettleSheet}
      footer={
        <>
          <button type="button" className="btn btn--ghost" onClick={onClose}>
            {t('common.cancel')}
          </button>
          <button
            type="button"
            className="btn btn--primary"
            onClick={submit}
            disabled={submitting || !canSave}
            data-ui={UI.allocations.loanSettleConfirm}
          >
            {t('loan.settleConfirm')}
          </button>
        </>
      }
    >
      <div className="stack">
        {error ? (
          <div className="field__error" role="alert">
            <Icon name="alert" size={14} />
            {error}
          </div>
        ) : null}
        <div className="list__title">{item.name}</div>
        {/* 「編集（過去も引き直す契約条件の変更）」との違いを学習面として名乗る。 */}
        <p className="field__hint">{t('loan.settleIntro')}</p>
        <TextInput
          label={t('loan.settleDate')}
          type="date"
          required
          value={endDate}
          onChange={setEndDate}
          min={item.startDate}
          max={MAX_LEDGER_DATE}
          dataUi={UI.allocations.loanSettleDate}
        />
        <div className="kv">
          <span className="muted">{t('loan.remainingDebt')}</span>
          <span>{moneyText(remaining, currency, digits)}</span>
        </div>
        <TextInput
          label={t('loan.settleAmount')}
          inputMode={digits === 0 ? 'numeric' : 'decimal'}
          value={amountText}
          onChange={(v) => setAmountText(sanitizeAmountText(v, digits, amountText))}
          hint={t('loan.settleAmountHint')}
          dataUi={UI.allocations.loanSettleAmount}
        />
        {/* 一括返済額 0 = 作る仕訳が無い。返済元は出さない（選ばせて捨てない）。 */}
        {settleAmount > 0 ? (
          <AccountPicker
            label={t('loan.settleSource')}
            required
            value={sourceAccountId}
            onChange={setSourceAccountId}
            groups={groupedAccountsByRole(
              accounts,
              [...RECURRING_POSTABLE_ROLES],
              sourceAccountId,
              dateValid ? endDate : undefined,
            )
              .map((group) => ({
                ...group,
                accounts: group.accounts.filter((account) => account.id !== item.expenseAccountId),
              }))
              .filter((group) => group.accounts.length > 0)}
            dataUi={UI.allocations.loanSettleSource}
          />
        ) : null}
      </div>
    </Modal>
  );
}
