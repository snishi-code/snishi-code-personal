/*
 * 持ち物のアーカイブ（終了 + 回収）シート。
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
import { useLedger } from '../../state/store';
import { isArchived, remainingValue } from '../../domain/monthlyCost';
import type {} from '../../domain/accountRoles';
import { groupedRecoveryDestinationAccounts } from '../accountOptions';
import { isLedgerDate, MAX_LEDGER_DATE, MIN_LEDGER_DATE } from '../../domain/calendar';
import { todayLocal } from '../../util/time';
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
import type { MonthlyCostItem } from '../../domain/types';

/**
 * アーカイブシート = 終了日と残存価値の始末を **1 枚で決める**（作者決定 2026-08-15）。
 * 旧「終了日ダイアログ →（残存価値が残れば）振替シート」の 2 段構えは撤去した。
 * 状態を変える操作だが、**シートそのものが確認面**なので前置きの確認ダイアログは置かない。
 *
 *  1. **終了日**: 既定 = 今日。終了済みの行だけ現在の終了日（先へ動かせば一覧へ戻る = 復元）。
 *  2. **回収額**: 既定 = その終了日時点の残存価値。編集可・0（回収なし）も超過回収も許す。
 *     終了日を動かすと、まだ手で直していない限り既定が追従する（判定はフラグでなく値）。
 *     0 のときは回収先ピッカーを出さない（作る仕訳が無いので選ばせない）。
 *  3. **残り（残存価値 − 回収額）の扱い**:
 *     - 「期間に割り振る」（既定・現行挙動）= 残りは spreadTotal に残り、全期間へ配り直される。
 *     - 「終了日に全額費用にする」= item の費用の行き先への**第 2 の回収の振替**を足す。
 *       割り振る総額が「終了日までに消費済みの額」へ落ちるので、過去の刻みは元の額のまま
 *       残りが終了日に 1 本だけ立つ（monthlyCost.ts の数学もフィールドも増やさない）。
 *     残りが 0 以下（ちょうど回収・超過回収）なら選ぶ意味が無いので無効化する。
 *
 * 保存は終了日 + 回収の振替（0〜2 本）を同一トランザクションで（archiveMonthlyCost）。
 */
export function MonthlyCostArchiveSheet({
  item,
  spreadTotal,
  onClose,
}: {
  item: MonthlyCostItem;
  spreadTotal: number;
  onClose: () => void;
}) {
  const { ledger, archiveMonthlyCost } = useLedger();
  const accounts = ledger?.accounts ?? [];
  const currency = ledger?.settings.currency ?? '';
  const displayDigits = useMoneyDigits();
  // 既定 = 今日。終了済みの行だけ現在の endDate（先へ動かせば一覧へ戻る = 復元も同じ 1 操作）。
  const [endDate, setEndDate] = useState(() =>
    isArchived(item, todayLocal()) && item.endDate !== undefined ? item.endDate : todayLocal(),
  );
  const [recoveryAccountId, setRecoveryAccountId] = useState('');
  const [remainderMode, setRemainderMode] = useState<'spread' | 'expense'>('spread');
  const [error, setError] = useState<string | undefined>(undefined);
  const [submitting, setSubmitting] = useState(false);
  const submittingRef = useRef(false);

  // 上限（2100 年）超えの終了日で割り振りの走査を伸ばさない（保存境界でも拒否される）。
  const dateValid = isLedgerDate(endDate);
  // 変更前の item の割り振りで「その日までに費用になっていない残り」。
  // remainingValue が回収済みを織り込んだ単一正本（spreadTotal − 月割り済み）なので、
  // ここで回収額をもう一度引かない（一覧と同じ値になる・監査 P2-1）。
  const remaining = remainingValue(item, dateValid ? endDate : todayLocal(), spreadTotal);
  // 表示桁 0 の設定でも、この欄だけは端数を隠さない（見えている値 = 保存される値）。
  const digits = Math.max(displayDigits, exactDigitsFor(remaining)) as typeof displayDigits;

  // 回収額の既定は終了日に追従する。過去に超過回収していて残存価値が負なら既定 0
  //（マイナスは入力欄に載せない。超過をさらに増やしたいなら手で入れる）。
  const defaultRecoveryText = formatMinorForInput(Math.max(remaining, 0), digits);
  const [recoveryText, setRecoveryText] = useState(defaultRecoveryText);
  const autoRecoveryRef = useRef(defaultRecoveryText);
  useEffect(() => {
    if (defaultRecoveryText === autoRecoveryRef.current) return;
    const previousAuto = autoRecoveryRef.current;
    autoRecoveryRef.current = defaultRecoveryText;
    // 既定のままなら追従し、手で直してあればその値を尊重する（判定はフラグではなく値）。
    setRecoveryText((current) => (current === previousAuto ? defaultRecoveryText : current));
  }, [defaultRecoveryText]);

  const recoveryAmount = parseAmountToMinor(recoveryText) ?? 0;
  // 残り = 残存価値 − 回収額。負（超過回収）なら従来どおり spreadTotal が負になり、
  // 過去にわたる費用減として按分される＝「終了日に全額」は選べない。
  const rest = remaining - recoveryAmount;
  const remainderChoosable = dateValid && rest > 0;
  const toExpense = remainderChoosable && remainderMode === 'expense';
  const expenseAccountName =
    accounts.find((a) => a.id === item.expenseAccountId)?.name ?? item.expenseAccountId;
  const recoveryGroups = groupedRecoveryDestinationAccounts(
    accounts,
    recoveryAccountId,
    dateValid ? endDate : undefined,
  );
  const canSave = dateValid && (recoveryAmount === 0 || recoveryAccountId !== '');

  async function submit(): Promise<void> {
    if (submittingRef.current) return;
    submittingRef.current = true;
    setSubmitting(true);
    setError(undefined);
    try {
      const recoveries: { destinationAccountId: string; amount: number }[] = [];
      if (recoveryAmount > 0) {
        recoveries.push({ destinationAccountId: recoveryAccountId, amount: recoveryAmount });
      }
      // 第 2 の回収の振替（借方 = item の費用の行き先 / 貸方 = 継続コスト台帳）。
      if (toExpense) {
        recoveries.push({ destinationAccountId: item.expenseAccountId, amount: rest });
      }
      await archiveMonthlyCost({
        id: item.id,
        endDate,
        ...(recoveries.length > 0 ? { recoveries } : {}),
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
      title={t('ccItem.archiveTitle')}
      onClose={onClose}
      dataUi={UI.allocations.archiveDialog}
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
            data-ui={UI.allocations.archiveConfirm}
          >
            {t('ccItem.archiveConfirm')}
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
        <TextInput
          label={t('ccItem.endDate')}
          type="date"
          required
          value={endDate}
          onChange={setEndDate}
          min={MIN_LEDGER_DATE}
          max={MAX_LEDGER_DATE}
          hint={t('ccItem.archiveDateHint')}
          dataUi={UI.allocations.archiveDate}
        />
        <div className="kv">
          <span className="muted">{t('ccItem.remainingValue')}</span>
          <span>{moneyText(remaining, currency, digits)}</span>
        </div>
        <TextInput
          label={t('ccItem.archiveRecovery')}
          inputMode={digits === 0 ? 'numeric' : 'decimal'}
          value={recoveryText}
          onChange={(v) => setRecoveryText(sanitizeAmountText(v, digits, recoveryText))}
          hint={t('ccItem.archiveRecoveryHint')}
          dataUi={UI.allocations.archiveRecoveryAmount}
        />
        {/* 回収額 0 = 作る仕訳が無い。回収先は出さない（選ばせて捨てない）。 */}
        {recoveryAmount > 0 ? (
          <AccountPicker
            label={t('ccItem.archiveRecoveryTo')}
            required
            value={recoveryAccountId}
            onChange={setRecoveryAccountId}
            groups={recoveryGroups}
            dataUi={UI.allocations.archiveRecoveryTo}
          />
        ) : null}
        <fieldset className="field picker" data-ui={UI.allocations.archiveRemainder}>
          <legend className="field__label">
            {t('ccItem.archiveRemainder', { amount: moneyText(rest, currency, digits) })}
          </legend>
          <span className="field__hint">
            {remainderChoosable
              ? remainderMode === 'expense'
                ? t('ccItem.archiveRemainderExpenseHint', { account: expenseAccountName })
                : t('ccItem.archiveRemainderSpreadHint')
              : t('ccItem.archiveRemainderNoneHint')}
          </span>
          <div className="picker__chips">
            {(
              [
                ['spread', 'ccItem.archiveRemainderSpread', UI.allocations.archiveRemainderSpread],
                [
                  'expense',
                  'ccItem.archiveRemainderExpense',
                  UI.allocations.archiveRemainderExpense,
                ],
              ] as const
            ).map(([mode, labelKey, dataUi]) => (
              <label className="chip" key={mode}>
                <input
                  type="radio"
                  className="sr-only"
                  name="cc-archive-remainder"
                  value={mode}
                  checked={remainderChoosable ? remainderMode === mode : mode === 'spread'}
                  disabled={!remainderChoosable}
                  onChange={() => setRemainderMode(mode)}
                  data-ui={dataUi}
                />
                <span className="chip__check" aria-hidden="true">
                  <Icon name="check" size={14} />
                </span>
                <span className="chip__text">{t(labelKey)}</span>
              </label>
            ))}
          </div>
        </fieldset>
      </div>
    </Modal>
  );
}
