/*
 * 定期ルールの追加・編集シート。
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
import { useEffect, useMemo, useRef, useState } from 'react';
import { Modal } from '../overlays';
import { TextInput } from '@snishi/foundation/ui/Field';
import { Icon } from '@snishi/foundation/ui/Icon';
import { AccountPicker } from '../AccountPicker';
import { FlowField } from '../FlowField';
import { ConfirmDialog } from '../overlays';
import { useLedger } from '../../state/store';
import type {} from '../../domain/accountRoles';
import { sortAccounts } from '../../domain/displayOrder';
import { groupedAccountsByRole } from '../accountOptions';
import { monthOf } from '../../domain/allocation';
import { isValidIsoDate, MAX_LEDGER_DATE, MIN_LEDGER_DATE } from '../../domain/calendar';
import { nowIso, todayLocal } from '../../util/time';
import {
  CATCH_UP_HARD_CAP_MONTHS,
  RECURRING_POSTABLE_ROLES,
  clampDayToMonth,
  deriveRecurringOutputs,
  firstRecurringPostingDate,
  recurringDestinationAccountId,
} from '../../domain/recurring';
import {
  effectiveRecurringRuleStartDate,
  ruleExistsAt as recurringRuleExistsAt,
} from '../../domain/accountLifetime';
import { formatMinorForInput, parseAmountToMinor, sanitizeAmountText } from '../amountText';
import { useMoneyDigits } from '../money';
import { Money } from '../money';
import { errorText, t } from '../../i18n';
import type {} from '../../i18n';
import type {} from '../../util/format';
import { UI } from '../../ui-contract';
import type {} from '../../data/repository';
import type { RecurringRule } from '../../domain/types';

/**
 * 基準日入力から保存する dayOfMonth を決める（submit から移動・挙動は不変）。
 * 日付欄は「元の dayOfMonth をその月へクランプした結果」を表示している。表示どおりのまま
 * なら日を触っていない＝元の値を保つ（2 月のルールを開いて保存しただけで 31 → 28 に
 * 落ち、以後の起票日がずれるのを防ぐ）。日を変えたときだけ入力値を採用する。
 * 新規（existing なし）は入力値そのもの。保存とプレビューが同じ経路でこれを使う。
 */
function resolveRuleDayOfMonth(firstPostingDate: string, existing?: RecurringRule): number {
  const day = Number.parseInt(firstPostingDate.slice(8, 10), 10);
  return existing !== undefined &&
    clampDayToMonth(monthOf(firstPostingDate), existing.dayOfMonth).slice(8, 10) ===
      firstPostingDate.slice(8, 10)
    ? existing.dayOfMonth
    : day;
}

/**
 * 定期ルールの追加・編集シート。周期（everyMonths）付き。
 * 独自の種別 UI は持たず、簿記編集と同じく貸方・借方を直接指定する。
 * 継続コスト台帳を経由して月割りするかは明示トグル（行き先 role は既定の提案だけに使う）。
 */
export function RecurringRuleSheet({
  existing,
  asOf,
  onClose,
}: {
  existing?: RecurringRule;
  /** ヘッダー断面。表示（起票数の予告）に使う。書込みの既定日は引き続き実 today。 */
  asOf: string;
  onClose: () => void;
}) {
  const { ledger, createRecurringRule, saveRecurringRule, removeRecurringRule } = useLedger();
  const accounts = sortAccounts(ledger?.accounts ?? []);
  const currency = ledger?.settings.currency ?? '';

  // 計上先から負債を除く（v13.13: 計上先が負債のルール = 旧形ローンは保存境界が拒否する。
  // 選べて保存だけ失敗する袋小路を作らない。源泉は従来どおり全 postable = クレカ払いは合法）。
  const destinationRoles = RECURRING_POSTABLE_ROLES.filter(
    (role) => role !== 'payment-liability' && role !== 'other-liability',
  );
  const initialFromGroups = groupedAccountsByRole(
    accounts,
    [...RECURRING_POSTABLE_ROLES],
    existing?.creditAccountId,
  );
  const firstFromId = initialFromGroups.flatMap((group) => group.accounts)[0]?.id ?? '';
  const [creditAccountId, setCreditAccountId] = useState(existing?.creditAccountId ?? firstFromId);
  // 正規化済みの月割りルールでも内部台帳ではなく、利用者が指定した行き先を見せる。
  const existingDebit = existing ? recurringDestinationAccountId(existing) : undefined;
  const initialToGroups = groupedAccountsByRole(accounts, destinationRoles, existingDebit);
  const firstToId =
    initialToGroups
      .flatMap((group) => group.accounts)
      .find((account) => account.id !== creditAccountId)?.id ?? '';
  const [debitAccountId, setDebitAccountId] = useState(existingDebit ?? firstToId);
  const fromGroups = groupedAccountsByRole(
    accounts,
    [...RECURRING_POSTABLE_ROLES],
    creditAccountId,
  );
  // 行き先は源泉と同一科目を除く（振替の 預金→預金 を防ぐ）。
  const toGroups = groupedAccountsByRole(accounts, destinationRoles, debitAccountId)
    .map((group) => ({
      ...group,
      accounts: group.accounts.filter((account) => account.id !== creditAccountId),
    }))
    .filter((group) => group.accounts.length > 0);

  const [name, setName] = useState(existing?.name ?? '');
  const fractionDigits = useMoneyDigits();
  const initialAmountText =
    existing !== undefined ? formatMinorForInput(existing.amount, fractionDigits) : '';
  const [amountText, setAmountText] = useState(initialAmountText);
  // 変更判定はフラグではなく値（初期表示と同じ文字列に戻れば無変更 = 保存済み minor を保持）。
  const amountDirty = amountText !== initialAmountText;
  const [everyText, setEveryText] = useState(
    existing !== undefined ? String(existing.everyMonths) : '1',
  );
  const [firstPostingDate, setFirstPostingDate] = useState(() =>
    existing ? clampDayToMonth(existing.startMonth, existing.dayOfMonth) : todayLocal(),
  );
  const [startDate, setStartDate] = useState(
    existing ? effectiveRecurringRuleStartDate(existing) : todayLocal(),
  );
  // 新規作成は存在期間を出さない（開始 = 初回の起票日で自動・v13.1 その4）。
  const effectiveStartDate = existing ? startDate : firstPostingDate;
  const [endDate, setEndDate] = useState(existing?.endDate ?? '');
  // 存在期間（開始日・終了日）は詳細の折りたたみへ（編集時のみ・既定は閉じる）。
  const [showDetails, setShowDetails] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  const [pendingAmountChange, setPendingAmountChange] = useState<{
    rule: RecurringRule;
    effectiveDate: string;
  } | null>(null);
  const [amountChangeError, setAmountChangeError] = useState<string | undefined>(undefined);
  const [submitting, setSubmitting] = useState(false);
  const submittingRef = useRef(false);
  // 破壊的操作は編集シート最下部（動詞体系 v13.1）。確認ダイアログとの 2 段防御は従来どおり。
  const [pendingDelete, setPendingDelete] = useState(false);
  // 終了の Undo。削除と違い取り消し可能（解除 ⇄ 終了）だが、状態を変えるので確認は挟む。
  const [pendingClearEnd, setPendingClearEnd] = useState(false);
  // 清算を持つルールは編集ロック（v13.9 項目 2・監査 #2）: 周期・起票日・金額・存在期間・
  // 科目は清算（記録済みの起票月と前倒し終了日）の前提なので、すべて解除するまで変更不可。
  // 保存境界（assertRecurringRuleSavable）も同じ規則で fail-closed に守る。
  const settlementCount = existing?.settlements?.length ?? 0;
  const settlementLocked = settlementCount > 0;
  const [pendingClearSettlements, setPendingClearSettlements] = useState(false);
  // 保存済みルールがヘッダー断面（asOf）までに立てている起票数。編集の引き直し予告と、
  // カスケード削除の確認の両方が同じ数を使う（v13.12: 数える対象 = 断面までに導出される
  // 起票。実 today を挙動境界にしない today 規約に一覧の導出と揃える）。
  const pastPostings = useMemo(
    () =>
      existing !== undefined
        ? deriveRecurringOutputs([existing], ledger?.accounts ?? [], asOf).entries.length
        : 0,
    [existing, ledger, asOf],
  );
  const canSplitAtEffectiveDate =
    pendingAmountChange !== null &&
    existing !== undefined &&
    pendingAmountChange.effectiveDate > effectiveRecurringRuleStartDate(existing) &&
    recurringRuleExistsAt(existing, pendingAmountChange.effectiveDate) &&
    (pendingAmountChange.rule.endDate === undefined ||
      pendingAmountChange.effectiveDate < pendingAmountChange.rule.endDate);

  // 起票プレビュー: いまのフォーム値で最初に起票される実際の日付（保存はしない・読み取り専用）。
  // 周期 >= 2 では基準日の年月が位相を決める（recurringPostingsDue が startMonth 基点で刻む）
  // ため、周期テンプレ文言ではなく日付そのものを出す＝基準日を変えると位相が動くことが画面に
  // 出る。保存値と同じ resolveRuleDayOfMonth / firstRecurringPostingDate を通す。
  // どれかの入力が不正な間は行ごと出さない（fail-closed）。
  const previewEvery = everyText === '' ? Number.NaN : Number.parseInt(everyText, 10);
  const firstPosting =
    Number.isInteger(previewEvery) &&
    previewEvery >= 1 &&
    previewEvery <= CATCH_UP_HARD_CAP_MONTHS &&
    isValidIsoDate(firstPostingDate) &&
    isValidIsoDate(effectiveStartDate) &&
    (endDate === '' || isValidIsoDate(endDate))
      ? firstRecurringPostingDate({
          startMonth: monthOf(firstPostingDate),
          dayOfMonth: resolveRuleDayOfMonth(firstPostingDate, existing),
          everyMonths: previewEvery,
          startDate: effectiveStartDate,
          ...(endDate !== '' ? { endDate } : {}),
        })
      : null;

  // 起票プレビューの読み上げ文。マウント時は '' で、effect が最初の値を入れることで
  // 「変化」として通知される（live region の制約）。値が無くなったときも明示的に伝える。
  const [firstPostingAnnounce, setFirstPostingAnnounce] = useState('');
  useEffect(() => {
    // live region は「マウント後の変化」だけが読み上げられるため、意図的に effect で
    // setState する（初期値を JSX に直接書くと初回が通知されない）。1 値の更新のみで
    // 連鎖レンダーは起きない。
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setFirstPostingAnnounce(
      firstPosting !== null
        ? t('recurring.firstPostingStatus', { date: firstPosting })
        : t('recurring.firstPostingNone'),
    );
  }, [firstPosting]);

  async function persistExisting(
    rule: RecurringRule,
    options?: {
      amountChangeMode?: 'retroactive' | 'split';
      effectiveDate?: string;
    },
  ) {
    if (submittingRef.current) return;
    submittingRef.current = true;
    setSubmitting(true);
    setError(undefined);
    setAmountChangeError(undefined);
    try {
      await saveRecurringRule(rule, options);
      onClose();
    } catch (e) {
      const message = errorText(e);
      if (pendingAmountChange) setAmountChangeError(message);
      else setError(message);
      submittingRef.current = false;
      setSubmitting(false);
    }
  }

  async function submit() {
    if (submittingRef.current) return;
    const amount =
      existing !== undefined && !amountDirty
        ? existing.amount
        : (parseAmountToMinor(amountText) ?? 0);
    if (!Number.isInteger(amount) || amount < 1) {
      setError(t('error.common.amountInvalid'));
      return;
    }
    const everyMonths = everyText === '' ? 0 : Number.parseInt(everyText, 10);
    // 上限は保存境界・schema と同じ（配分月数の上限）。画面でも先に弾いて理由を示す。
    if (
      !Number.isInteger(everyMonths) ||
      everyMonths < 1 ||
      everyMonths > CATCH_UP_HARD_CAP_MONTHS
    ) {
      setError(t('error.recurring.everyMonthsInvalid'));
      return;
    }
    if (!isValidIsoDate(effectiveStartDate)) {
      setError(t('error.recurring.periodInvalid'));
      return;
    }
    if (endDate !== '' && (!isValidIsoDate(endDate) || endDate <= effectiveStartDate)) {
      setError(t('error.recurring.periodInvalid'));
      return;
    }
    const day = Number.parseInt(firstPostingDate.slice(8, 10), 10);
    if (!Number.isInteger(day) || day < 1 || day > 31) {
      setError(t('error.recurring.dayOfMonthInvalid'));
      return;
    }
    const startMonth = monthOf(firstPostingDate);
    // 31日ルールの往復規則（resolveRuleDayOfMonth）。保存とプレビューで同じ関数を通す。
    const dayOfMonth = resolveRuleDayOfMonth(firstPostingDate, existing);
    setError(undefined);
    try {
      if (existing) {
        const next: RecurringRule = {
          ...existing,
          name: name.trim(),
          amount,
          dayOfMonth,
          everyMonths,
          debitAccountId,
          creditAccountId,
          startMonth,
          startDate,
          updatedAt: nowIso(),
        };
        if (endDate !== '') next.endDate = endDate;
        else delete next.endDate;
        // 計上先をそのまま保存形へ写す（debitAccountId は論理的な行き先のまま渡し、
        // 借方 = 台帳への正規化は保存境界が行う）。
        next.spreadExpenseAccountId = debitAccountId;
        if (amount !== existing.amount) {
          setPendingAmountChange({ rule: next, effectiveDate: todayLocal() });
          setAmountChangeError(undefined);
          return;
        }
        await persistExisting(next);
        return;
      } else {
        submittingRef.current = true;
        setSubmitting(true);
        await createRecurringRule({
          name: name.trim(),
          amount,
          dayOfMonth,
          everyMonths,
          debitAccountId,
          creditAccountId,
          startMonth,
          // 新規は開始 = 初回の起票日で自動（存在期間の欄を出さない・v13.1 その4）。
          startDate: effectiveStartDate,
          ...(endDate !== '' ? { endDate } : {}),
        });
      }
      onClose();
    } catch (e) {
      setError(errorText(e));
      submittingRef.current = false;
      setSubmitting(false);
    }
  }

  return (
    <>
      <Modal
        title={existing ? t('recurring.editTitle') : t('recurring.createTitle')}
        onClose={onClose}
        dismissMode="if-clean"
        dataUi={UI.allocations.recurringSheet}
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
                everyText === '' ||
                firstPostingDate === '' ||
                (existing !== undefined && startDate === '') ||
                creditAccountId === '' ||
                debitAccountId === ''
              }
              data-ui={UI.allocations.recurringSave}
            >
              {t('common.save')}
            </button>
          </>
        }
      >
        <div className="stack">
          <p className="field__hint">{t('recurring.sectionIntro')}</p>
          {error ? (
            <div className="field__error" role="alert">
              <Icon name="alert" size={14} />
              {error}
            </div>
          ) : null}
          {/* 並び（v13.1 その4・作者確定）: 初回の起票日 → 周期 → 摘要 → 金額 →
              貸方（支払い元）→ 借方（計上先）→ プレビュー → 詳細（存在期間・編集のみ）。 */}
          {settlementLocked ? (
            <p
              className="field__hint"
              role="note"
              data-ui={UI.allocations.recurringSettlementLockNote}
            >
              {t('recurring.settlementLockNote', { count: settlementCount })}
            </p>
          ) : null}
          <TextInput
            label={t('recurring.firstPostingDate')}
            type="date"
            required
            disabled={settlementLocked}
            value={firstPostingDate}
            min={MIN_LEDGER_DATE}
            max={MAX_LEDGER_DATE}
            onChange={setFirstPostingDate}
            hint={t('recurring.firstPostingDateHint')}
            dataUi={UI.allocations.recurringFirstPostingDate}
          />
          <TextInput
            label={t('recurring.intervalMonths')}
            required
            disabled={settlementLocked}
            inputMode="numeric"
            value={everyText}
            onChange={(v) => setEveryText(v.replace(/[^\d]/g, ''))}
            dataUi={UI.allocations.recurringEvery}
          />
          <TextInput
            label={t('recurring.name')}
            required
            value={name}
            onChange={setName}
            hint={t('recurring.nameHint')}
            dataUi={UI.allocations.recurringName}
          />
          <TextInput
            label={t('recurring.amount')}
            required
            disabled={settlementLocked}
            inputMode={fractionDigits === 0 ? 'numeric' : 'decimal'}
            value={amountText}
            onChange={(v) => {
              setAmountText(sanitizeAmountText(v, fractionDigits, amountText));
            }}
            hint={t('recurring.amountHint')}
            dataUi={UI.allocations.recurringAmount}
          />
          {/* ホームの簿記編集と同じ「貸方 → 借方」の外枠 + flat チップ（作者決定 2026-08-12:
              グループ見出し・色分けは不要・ホームへ揃える）。候補構築は定期ルールの許可 role
              （RECURRING_POSTABLE_ROLES）のまま変えない。 */}
          <FlowField
            dataUi={UI.allocations.recurringFlow}
            source={
              <AccountPicker
                flat
                label={t('recurring.from.manual')}
                required
                disabled={settlementLocked}
                value={creditAccountId}
                onChange={(id) => {
                  setCreditAccountId(id);
                  if (id === debitAccountId) setDebitAccountId('');
                }}
                groups={fromGroups}
                dataUi={UI.allocations.recurringFrom}
              />
            }
            destination={
              <AccountPicker
                flat
                // 全ルールが台帳経由なので行き先の意味は常に「計上先」。
                label={t('monthlyCost.expenseCategory')}
                required
                disabled={settlementLocked}
                value={debitAccountId}
                onChange={setDebitAccountId}
                groups={toGroups}
                hint={t('recurring.manualHint')}
                dataUi={UI.allocations.recurringTo}
              />
            }
          />
          {/* 視覚行は値があるときだけ（空の枠を残さない）。読み上げは下の常設 status が担う。 */}
          {firstPosting !== null ? (
            <div className="kv" data-ui={UI.allocations.recurringFirstPosting}>
              <span className="muted">{t('recurring.firstPosting')}</span>
              <span>{firstPosting}</span>
            </div>
          ) : null}
          {/* 編集 = 全期間の引き直し（宣言モデル）。過去の起票数を添えて「切替」との
              使い分けが学べるようにする（実ユーズレビュー 2026-08-16）。 */}
          {existing !== undefined && pastPostings > 0 ? (
            <p
              className="field__hint"
              data-ui={UI.allocations.recurringEditRetroactiveNote}
              role="note"
            >
              {t('recurring.editRetroactiveNote', { count: pastPostings })}
            </p>
          ) : null}
          {/* live region は「内容が変わる前から存在」して初めて読み上げられるため、
              空でマウントし effect で流し込む（初期値も 1 回の変化として通知される）。
              値が消えたときも「ありません」を明示的に通知する。 */}
          <p className="sr-only" role="status" data-ui={UI.allocations.recurringFirstPostingStatus}>
            {firstPostingAnnounce}
          </p>
          {/* 存在期間（開始日・終了日）は詳細の折りたたみへ。新規作成では出さない
              （開始 = 初回の起票日で自動・v13.1 その4）。 */}
          {existing ? (
            <>
              <button
                type="button"
                className="collapse-toggle"
                aria-expanded={showDetails}
                onClick={() => setShowDetails((v) => !v)}
                data-ui={UI.allocations.recurringDetailsToggle}
              >
                <Icon name={showDetails ? 'expand' : 'chevronRight'} size={16} />
                {t('recurring.detailsToggle')}
              </button>
              {showDetails ? (
                <div className="stack">
                  <TextInput
                    label={t('recurring.ruleStartDate')}
                    type="date"
                    required
                    disabled={settlementLocked}
                    value={startDate}
                    min={MIN_LEDGER_DATE}
                    max={MAX_LEDGER_DATE}
                    onChange={setStartDate}
                    hint={t('recurring.ruleStartDateHint')}
                    dataUi={UI.allocations.recurringStartDate}
                  />
                  <TextInput
                    label={t('recurring.ruleEndDate')}
                    type="date"
                    disabled={settlementLocked}
                    value={endDate}
                    min={MIN_LEDGER_DATE}
                    max={MAX_LEDGER_DATE}
                    onChange={setEndDate}
                    hint={t('recurring.ruleEndDateHint')}
                    dataUi={UI.allocations.recurringEndDate}
                  />
                  {/* iOS の date input には値を空へ戻す手段が無い（継続コスト編集シートと同じ理由の明示ボタン）。 */}
                  {endDate !== '' ? (
                    <div className="row-actions">
                      <button
                        type="button"
                        className="btn btn--ghost"
                        style={{ minHeight: 'var(--tap)' }}
                        disabled={settlementLocked}
                        onClick={() => setEndDate('')}
                        data-ui={UI.allocations.recurringEndDateClear}
                      >
                        {t('ccItem.endDateClear')}
                      </button>
                    </div>
                  ) : null}
                </div>
              ) : null}
            </>
          ) : null}
          {/* 破壊的なほど下（動詞体系 v13.1・HIG の連絡先・カレンダー方式）:
              [終了日を解除（終了済みのみ）] → [このルールを削除…]。 */}
          {existing ? (
            <div className="stack" style={{ marginTop: 'var(--space-4)' }}>
              {settlementLocked ? (
                <button
                  type="button"
                  className="btn btn--ghost"
                  style={{ minHeight: 'var(--tap)' }}
                  disabled={submitting}
                  onClick={() => setPendingClearSettlements(true)}
                  data-ui={UI.allocations.recurringClearSettlements}
                >
                  {t('recurring.clearSettlements')}
                </button>
              ) : null}
              {existing.endDate !== undefined ? (
                <button
                  type="button"
                  className="btn btn--ghost"
                  style={{ minHeight: 'var(--tap)' }}
                  disabled={submitting || settlementLocked}
                  onClick={() => setPendingClearEnd(true)}
                  data-ui={UI.allocations.recurringClearEndDate}
                >
                  {t('recurring.clearEndDate')}
                </button>
              ) : null}
              <button
                type="button"
                className="btn btn--danger"
                style={{ minHeight: 'var(--tap)' }}
                disabled={submitting}
                onClick={() => setPendingDelete(true)}
                data-ui={UI.allocations.recurringDelete}
              >
                {t('recurring.deleteAction')}
              </button>
              <p className="field__hint">{t('recurring.deleteDangerHint')}</p>
            </div>
          ) : null}
        </div>
      </Modal>
      {pendingClearSettlements && existing ? (
        <ConfirmDialog
          title={t('recurring.clearSettlementsConfirmTitle')}
          body={t('recurring.clearSettlementsConfirmBody', {
            name: existing.name,
            count: settlementCount,
          })}
          confirmLabel={t('recurring.clearSettlements')}
          danger
          dataUi={UI.allocations.recurringClearSettlementsConfirm}
          onCancel={() => setPendingClearSettlements(false)}
          onConfirm={async () => {
            setPendingClearSettlements(false);
            // 全解除 = settlements を消して保存（各回の月割りは既定の期間へ戻る）。
            // 回収の振替は実仕訳なので消えない（必要なら仕訳一覧から個別に削除する）。
            const next: RecurringRule = { ...existing, updatedAt: nowIso() };
            delete next.settlements;
            await persistExisting(next);
          }}
        />
      ) : null}
      {pendingClearEnd && existing ? (
        <ConfirmDialog
          title={t('recurring.clearEndDateConfirmTitle')}
          body={t('recurring.clearEndDateConfirmBody', { name: existing.name })}
          confirmLabel={t('recurring.clearEndDate')}
          dataUi={UI.allocations.recurringClearEndDateConfirm}
          onCancel={() => setPendingClearEnd(false)}
          onConfirm={async () => {
            setPendingClearEnd(false);
            // 解除は保存済みルールに対する動詞（フォームの未保存編集は含めない）。
            const next: RecurringRule = { ...existing, updatedAt: nowIso() };
            delete next.endDate;
            await persistExisting(next);
          }}
        />
      ) : null}
      {pendingDelete && existing ? (
        <ConfirmDialog
          title={t('recurring.deleteConfirmTitle')}
          /* カスケード削除（作者決定 2026-08-15）: 積み木の下（ルール）が消えれば上（起票された
             仕訳・持ち物）も消える。何回ぶん消えるかを数で名乗る（0 件なら別文言）。 */
          body={
            pastPostings > 0
              ? t('recurring.deleteConfirmBody', { name: existing.name, count: pastPostings })
              : t('recurring.deleteConfirmNoPostingsBody', { name: existing.name })
          }
          confirmLabel={t('common.delete')}
          danger
          onCancel={() => setPendingDelete(false)}
          onConfirm={async () => {
            try {
              await removeRecurringRule(existing.id);
            } catch {
              // 失敗 = 未保存: 閉じない（エラーは store が toast 済み・確定中状態は ConfirmDialog が解く）。
              return;
            }
            setPendingDelete(false);
            onClose();
          }}
        />
      ) : null}
      {pendingAmountChange && existing ? (
        <Modal
          title={t('recurring.amountChangeTitle')}
          dismissMode="never"
          onClose={() => {
            if (submitting) return;
            setPendingAmountChange(null);
            setAmountChangeError(undefined);
          }}
          dataUi={UI.allocations.recurringAmountChangeDialog}
          footer={
            <button
              type="button"
              className="btn btn--ghost"
              disabled={submitting}
              onClick={() => {
                setPendingAmountChange(null);
                setAmountChangeError(undefined);
              }}
              data-ui={UI.allocations.recurringAmountChangeCancel}
            >
              {t('recurring.amountChangeBack')}
            </button>
          }
        >
          <div className="stack">
            <p>
              {t(
                canSplitAtEffectiveDate
                  ? 'recurring.amountChangeBody'
                  : 'recurring.amountChangeWholeOnlyBody',
                { date: pendingAmountChange.effectiveDate },
              )}
            </p>
            <div className="kv">
              <span className="muted">{t('recurring.amount')}</span>
              <span>
                <Money amount={existing.amount} currency={currency} /> →{' '}
                <Money amount={pendingAmountChange.rule.amount} currency={currency} />
              </span>
            </div>
            {amountChangeError ? (
              <div className="field__error" role="alert">
                <Icon name="alert" size={14} />
                {amountChangeError}
              </div>
            ) : null}
            <button
              type="button"
              className="list__row-btn"
              disabled={submitting}
              onClick={() =>
                persistExisting(pendingAmountChange.rule, {
                  amountChangeMode: 'retroactive',
                })
              }
              data-ui={UI.allocations.recurringAmountChangeAll}
            >
              <div className="list__main">
                <div className="list__title">{t('recurring.amountChangeAll')}</div>
                <div className="list__sub">{t('recurring.amountChangeAllHint')}</div>
              </div>
              <Icon name="chevronRight" size={16} />
            </button>
            {canSplitAtEffectiveDate ? (
              <button
                type="button"
                className="list__row-btn"
                disabled={submitting}
                onClick={() =>
                  persistExisting(pendingAmountChange.rule, {
                    amountChangeMode: 'split',
                    effectiveDate: pendingAmountChange.effectiveDate,
                  })
                }
                data-ui={UI.allocations.recurringAmountChangeFromToday}
              >
                <div className="list__main">
                  <div className="list__title">
                    {t('recurring.amountChangeFromToday', {
                      date: pendingAmountChange.effectiveDate,
                    })}
                  </div>
                  <div className="list__sub">
                    {t('recurring.amountChangeFromTodayHint', {
                      date: pendingAmountChange.effectiveDate,
                    })}
                  </div>
                </div>
                <Icon name="chevronRight" size={16} />
              </button>
            ) : null}
          </div>
        </Modal>
      ) : null}
    </>
  );
}
