/*
 * 継続コスト資産（持ち物）シート。
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
import { useState } from 'react';
import { Modal } from '../overlays';
import { SelectInput, TextInput } from '@snishi/foundation/ui/Field';
import { Icon } from '@snishi/foundation/ui/Icon';
import { ConfirmDialog } from '../overlays';
import { useLedger } from '../../state/store';
import type {} from '../../domain/accountRoles';
import { lastExpenseCategoryId, rememberExpenseCategoryId } from '../../data/localFlags';
import {
  defaultMonthlyAllocationAccountId,
  monthlyAllocationAccountOptions,
} from '../accountOptions';
import { MAX_LEDGER_DATE, MIN_LEDGER_DATE } from '../../domain/calendar';
import { nowIso, todayLocal } from '../../util/time';
import { quickSpanEndDate } from '../ccQuickSpan';
import { formatMinorForInput, parseAmountToMinor, sanitizeAmountText } from '../amountText';
import { useMoneyDigits } from '../money';
import { errorText, t } from '../../i18n';
import type {} from '../../i18n';
import type {} from '../../util/format';
import { UI } from '../../ui-contract';
import type {} from '../../data/repository';
import type { JournalEntry, MonthlyCostItem } from '../../domain/types';

/**
 * 継続コスト資産シート（登録＝編集の 1 コンポーネント）。
 *  - 新規 = 持ち込み登録: 金額は購入額。過去日で普通に登録できる（制約なし）。貸方は初期残高。
 *  - 編集 = 名前・金額・終了日・費用の行き先のみ。開始日は購入の仕訳の日付のミラーなので
 *    読み取り専用（タップで購入の仕訳へ）。
 *  - 終了日は空でよい（空なら費用の割り振りをしない）。
 */
export function ContinuousCostItemSheet({
  existing,
  purchaseEntry,
  onOpenPurchase,
  onClose,
}: {
  existing?: MonthlyCostItem;
  purchaseEntry?: JournalEntry | undefined;
  onOpenPurchase: (entry: JournalEntry) => void;
  onClose: () => void;
}) {
  const { ledger, createContinuousCost, saveMonthlyCost, removeMonthlyCost } = useLedger();
  const accounts = ledger?.accounts ?? [];
  const monthlyAllocationOptions = monthlyAllocationAccountOptions(
    accounts,
    existing?.expenseAccountId,
  );
  // 破壊的操作は編集シート最下部（動詞体系 v13.1）。確認ダイアログとの 2 段防御は従来どおり。
  const [pendingDelete, setPendingDelete] = useState(false);

  const [name, setName] = useState(existing?.name ?? '');
  const fractionDigits = useMoneyDigits();
  const initialAmountText =
    existing !== undefined ? formatMinorForInput(existing.amount, fractionDigits) : '';
  const [amountText, setAmountText] = useState(initialAmountText);
  // 変更判定はフラグではなく値（初期表示と同じ文字列に戻れば無変更 = 保存済み minor を保持）。
  const amountDirty = amountText !== initialAmountText;
  const [startDate, setStartDate] = useState(existing?.startDate ?? todayLocal());
  const [endDate, setEndDate] = useState(existing?.endDate ?? '');
  // 費用の行き先の既定値は「前回選んだもの」（連続登録の切り替え手間を減らす）。
  const [expenseAccountId, setExpenseAccountId] = useState(() => {
    if (existing) return existing.expenseAccountId;
    const last = lastExpenseCategoryId();
    if (last && monthlyAllocationOptions.some((o) => o.value === last)) return last;
    return defaultMonthlyAllocationAccountId(accounts);
  });
  const [error, setError] = useState<string | undefined>(undefined);
  const [submitting, setSubmitting] = useState(false);

  // 過去から再計算される項目の変更予告（破壊的操作の予告なので削らない）。
  const effectiveAmount =
    existing !== undefined && !amountDirty
      ? existing.amount
      : (parseAmountToMinor(amountText) ?? 0);
  const pastFieldsChanged =
    existing !== undefined &&
    (effectiveAmount !== existing.amount ||
      endDate !== (existing.endDate ?? '') ||
      expenseAccountId !== existing.expenseAccountId);

  async function submit() {
    if (submitting) return;
    const amount = effectiveAmount;
    if (!Number.isInteger(amount) || amount < 1) {
      setError(t('error.common.amountInvalid'));
      return;
    }
    setSubmitting(true);
    setError(undefined);
    try {
      if (existing) {
        const next: MonthlyCostItem = {
          ...existing,
          name: name.trim(),
          amount,
          expenseAccountId,
          updatedAt: nowIso(),
        };
        if (endDate.trim() === '') delete next.endDate;
        else next.endDate = endDate.trim();
        await saveMonthlyCost(next);
      } else {
        await createContinuousCost({
          name: name.trim(),
          amount,
          startDate,
          ...(endDate.trim() !== '' ? { endDate: endDate.trim() } : {}),
          expenseAccountId,
        });
      }
      rememberExpenseCategoryId(expenseAccountId);
      onClose();
    } catch (e) {
      setError(errorText(e));
      setSubmitting(false);
    }
  }

  return (
    <>
      <Modal
        title={existing ? t('monthlyCost.editTitle') : t('monthly.pick.asset')}
        onClose={onClose}
        dismissMode="if-clean"
        dataUi={UI.allocations.editDialog}
        footer={
          <>
            <button type="button" className="btn btn--ghost" onClick={onClose}>
              {t('common.cancel')}
            </button>
            <button
              type="button"
              className="btn btn--primary"
              onClick={submit}
              disabled={submitting || name.trim() === '' || amountText === '' || startDate === ''}
              data-ui={UI.allocations.editSave}
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
              {t('monthlyCost.pastRecalcWarning')}
            </div>
          ) : null}
          <TextInput
            label={t('monthlyCost.name')}
            required
            value={name}
            onChange={setName}
            dataUi={UI.allocations.editName}
          />
          <TextInput
            label={t('monthlyCost.amount')}
            required
            inputMode={fractionDigits === 0 ? 'numeric' : 'decimal'}
            value={amountText}
            onChange={(v) => {
              setAmountText(sanitizeAmountText(v, fractionDigits, amountText));
            }}
            dataUi={UI.allocations.editAmount}
          />
          {existing ? (
            <>
              {/* 開始日 = 購入の仕訳の日付。変えるときは仕訳側（タップで開く）。 */}
              <div className="kv" data-ui={UI.allocations.editStartDate}>
                <span className="muted">{t('ccItem.startDate')}</span>
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
                  data-ui={UI.allocations.editOpenPurchase}
                >
                  <Icon name="chevronRight" size={16} />
                  {t('ccItem.openPurchase')}
                </button>
              ) : null}
            </>
          ) : (
            <TextInput
              label={t('ccItem.startDate')}
              type="date"
              required
              value={startDate}
              min={MIN_LEDGER_DATE}
              max={MAX_LEDGER_DATE}
              onChange={setStartDate}
              dataUi={UI.allocations.editStartDate}
            />
          )}
          <TextInput
            label={t('ccItem.endDate')}
            type="date"
            value={endDate}
            onChange={setEndDate}
            min={MIN_LEDGER_DATE}
            max={MAX_LEDGER_DATE}
            dataUi={UI.allocations.editEndDate}
          />
          <div className="row-actions" data-ui={UI.allocations.editQuickSpan}>
            {[1, 3, 5].map((years) => (
              <button
                key={years}
                type="button"
                className="btn btn--ghost"
                style={{ minHeight: 'var(--tap)' }}
                onClick={() => setEndDate(quickSpanEndDate(startDate, years))}
              >
                {t('ccItem.quickSpan', { years })}
              </button>
            ))}
            {/* 空で保存 = 終了日の解除は元から許可されている（保存側の仕様）。
              ただし iOS の date input には値を空へ戻す手段が無いため、明示ボタンで到達させる。 */}
            {endDate !== '' ? (
              <button
                type="button"
                className="btn btn--ghost"
                style={{ minHeight: 'var(--tap)' }}
                onClick={() => setEndDate('')}
                data-ui={UI.allocations.editEndDateClear}
              >
                {t('ccItem.endDateClear')}
              </button>
            ) : null}
          </div>
          <SelectInput
            label={t('monthlyCost.expenseCategory')}
            value={expenseAccountId}
            onChange={setExpenseAccountId}
            options={monthlyAllocationOptions}
            dataUi={UI.allocations.editExpense}
          />
          {/* 破壊的なほど下（動詞体系 v13.1）。行アクションには削除を置かない。 */}
          {existing ? (
            <div className="stack" style={{ marginTop: 'var(--space-4)' }}>
              <button
                type="button"
                className="btn btn--danger"
                style={{ minHeight: 'var(--tap)' }}
                disabled={submitting}
                onClick={() => setPendingDelete(true)}
                data-ui={UI.allocations.editDelete}
              >
                {t('monthlyCost.deleteAction')}
              </button>
              <p className="field__hint">{t('monthlyCost.deleteDangerHint')}</p>
            </div>
          ) : null}
        </div>
      </Modal>
      {pendingDelete && existing ? (
        <ConfirmDialog
          title={t('monthlyCost.deleteConfirmTitle')}
          body={t('monthlyCost.deleteConfirmBody', { name: existing.name })}
          confirmLabel={t('common.delete')}
          danger
          onCancel={() => setPendingDelete(false)}
          onConfirm={async () => {
            try {
              await removeMonthlyCost(existing.id);
            } catch {
              // 失敗 = 未保存: 閉じない（エラーは store が toast 済み・確定中状態は ConfirmDialog が解く）。
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
