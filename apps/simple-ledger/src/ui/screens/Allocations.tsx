/*
 * 毎月のもの。
 *  - くり返し記帳（定期ルール）: 実仕訳の自動起票（正本は起票された仕訳）。
 *    貸方・借方を簿記編集で直接指定し、「継続コストとして扱う」チェックで台帳経由にできる。
 *  - 継続コスト資産: 項目名・金額・開始日・終了日の4項目。終了日までの月割りは導出で、
 *    終了日を過ぎたら一覧から消える（アーカイブ = 終了日の設定）。
 */
import { useMemo, useState } from 'react';
import { Modal } from '../overlays';
import { SelectInput, TextInput } from '@snishi/foundation/ui/Field';
import { Icon } from '@snishi/foundation/ui/Icon';
import { AccountPicker } from '../AccountPicker';
import { ConfirmDialog } from '../overlays';
import { useLedger } from '../../state/store';
import {
  compareMonthlyCostItems,
  isArchived,
  isEndingSoon,
  monthlyCostForMonth,
  remainingValue,
  representativeMonthlyAmount,
} from '../../domain/monthlyCost';
import { recoveredAmountsByItem } from '../../domain/continuousCost';
import type { AccountRole } from '../../domain/accountRoles';
import { CONTINUOUS_COST_LEDGER_ACCOUNT_ID } from '../../domain/constants';
import { lastExpenseCategoryId, rememberExpenseCategoryId } from '../../data/localFlags';
import { sortAccounts } from '../../domain/accountOrder';
import {
  defaultRecognitionAccountId,
  groupedAccountsByRole,
  recognitionAccountOptions,
} from '../accountOptions';
import { monthlyAmounts, monthOf } from '../../domain/allocation';
import { isValidIsoDate } from '../../domain/calendar';
import { reportBasis, type ReportPeriod } from '../../domain/reportPeriod';
import { nowIso, todayLocal } from '../../util/time';
import {
  CATCH_UP_HARD_CAP_MONTHS,
  RECURRING_POSTABLE_ROLES,
  clampDayToMonth,
  recurringKindOf,
  type RecurringKind,
} from '../../domain/recurring';
import { quickSpanEndDate } from '../ccQuickSpan';
import { Money } from '../money';
import { EntrySheet } from './EntrySheet';
import { errorText, t } from '../../i18n';
import type { MessageKey } from '../../i18n';
import { UI } from '../../ui-contract';
import type { JournalEntry, MonthlyCostItem, RecurringRule } from '../../domain/types';

/** 仕訳一覧から「この行はどこから来たか」で遷移してくるときの対象。 */
export interface AllocationsTarget {
  itemId?: string;
  ruleId?: string;
}

export function Allocations({
  period,
  onEditEntry,
  target,
}: {
  /** ヘッダーで選んだ断面。「毎月のもの」の一覧・表示額だけがこの日付に追従する。 */
  period: ReportPeriod;
  /** 購入の仕訳を開く（開始日の変更は仕訳側で行う）。 */
  onEditEntry: (entry: JournalEntry) => void;
  /** 仕訳一覧の計算で生まれた行タップからの遷移対象（開くシート。同一オブジェクトは 1 回だけ消費）。 */
  target?: AllocationsTarget | null;
}) {
  const { ledger, removeMonthlyCost, setRecurringRulePaused, removeRecurringRule } = useLedger();
  const [showEnded, setShowEnded] = useState(false);
  const [pendingDelete, setPendingDelete] = useState<MonthlyCostItem | null>(null);
  const [itemSheet, setItemSheet] = useState<{ existing?: MonthlyCostItem } | null>(null);
  const [archiving, setArchiving] = useState<MonthlyCostItem | null>(null);
  const [chooserOpen, setChooserOpen] = useState(false);
  const [ruleSheet, setRuleSheet] = useState<{ existing?: RecurringRule } | null>(null);
  const [pendingRuleDelete, setPendingRuleDelete] = useState<RecurringRule | null>(null);
  // 表示だけはヘッダーの断面へ追従する。シート内の書込日・catch-up は period を受け取らず、
  // 引き続き実際の今日を基準にする（過去/未来表示が durable state を動かさない）。
  const today = todayLocal();
  const asOf = reportBasis(period, today).asOf;
  const currentYm = monthOf(asOf);
  const currency = ledger?.settings.currency ?? 'JPY';

  const accountsMap = useMemo(
    () => new Map((ledger?.accounts ?? []).map((a) => [a.id, a] as const)),
    [ledger],
  );
  const name = (id?: string): string => (id ? (accountsMap.get(id)?.name ?? '—') : '—');

  // 回収の振替を差し引いた「割り振る総額」（負になってよい＝過去にわたる費用減）。
  // 集計は選択日までの保存仕訳に限定する（未来日付の回収を過去の一覧へ先取りしない。
  // reportEntriesForAsOf が実仕訳を asOf で切ってから展開するのと同じ扱い・監査 P2-2）。
  const journalEntries = ledger?.journalEntries ?? [];
  const recoveredAtAsOf = recoveredAmountsByItem(
    journalEntries.filter((e) => e.date <= asOf),
  );
  const recoveredAtToday =
    asOf === today
      ? recoveredAtAsOf
      : recoveredAmountsByItem(journalEntries.filter((e) => e.date <= today));
  const displaySpreadTotalOf = (m: MonthlyCostItem): number =>
    m.amount - (recoveredAtAsOf.get(m.id) ?? 0);
  // ヘッダー日付は表示だけのタイムマシン。アーカイブ/回収の書込導線へは、実際の今日までの
  // 回収額を渡し、過去表示から既存回収を二重計上したり未来回収を先取りしたりしない。
  const operationSpreadTotalOf = (m: MonthlyCostItem): number =>
    m.amount - (recoveredAtToday.get(m.id) ?? 0);
  const purchaseEntryOf = (m: MonthlyCostItem): JournalEntry | undefined =>
    (ledger?.journalEntries ?? []).find(
      (e) => e.metadata?.monthlyCostId === m.id && e.metadata.monthlyCostRecovery !== true,
    );

  const allItems = ledger?.monthlyCostItems ?? [];
  // 開始前の項目はその断面にはまだ存在しない。showEnded は終了済みだけを再表示し、
  // 未来開始の項目まで先取りしない。
  const startedItems = allItems.filter((m) => m.startDate <= asOf);
  // loadLedger は終了が近い順で返すが、編集直後の state 由来でも順序が崩れないよう再ソートする。
  const items = [...startedItems]
    .filter((m) => showEnded || !isArchived(m, asOf))
    .sort(compareMonthlyCostItems);

  const allRules = ledger?.recurringRules ?? [];
  const rules = allRules.filter((r) => r.startMonth <= currentYm);
  // 参照科目が削除/アーカイブ済みのルールは catch-up が起票を止める（fail-soft）。
  // 黙ってスキップしない＝一覧の行で警告する（監査 P1-7）。削除は accountRefs が塞ぐため、
  // 通常ここに出るのはアーカイブ由来だけ。
  const ruleRefBroken = (r: RecurringRule): boolean => {
    const ids = [
      r.creditAccountId,
      ...(r.spreadExpenseAccountId !== undefined
        ? [r.spreadExpenseAccountId]
        : [r.debitAccountId]),
    ];
    return ids.some((id) => {
      const account = accountsMap.get(id);
      return !account || account.archived;
    });
  };
  const ruleKindLabel = (r: RecurringRule): string => {
    const kind = sheetKindForRule(r, (id) => accountsMap.get(id)?.role);
    return t(`recurring.kind.${kind}` as MessageKey);
  };
  const ruleIntervalLabel = (r: RecurringRule): string =>
    r.everyMonths >= 2
      ? t('recurring.everyNMonthsDay', { n: r.everyMonths, day: r.dayOfMonth })
      : t('recurring.everyMonthDay', { day: r.dayOfMonth });

  // 仕訳一覧の計算で生まれた行タップからの遷移: 対象のシートを開く。
  // effect ではなく「render 中の派生調整」パターン（同一 target は 1 回だけ消費する）。
  const [consumedTarget, setConsumedTarget] = useState<AllocationsTarget | null>(null);
  if (target != null && target !== consumedTarget && ledger) {
    setConsumedTarget(target);
    const targetItem =
      target.itemId !== undefined ? allItems.find((m) => m.id === target.itemId) : undefined;
    const targetRule =
      target.ruleId !== undefined ? allRules.find((r) => r.id === target.ruleId) : undefined;
    if (targetItem) setItemSheet({ existing: targetItem });
    else if (targetRule) setRuleSheet({ existing: targetRule });
  }

  return (
    <section aria-labelledby="allocations-title" data-ui={UI.allocations.view}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <h1 className="screen-title" id="allocations-title" style={{ marginBottom: 0 }}>
          {t('monthly.title')}
        </h1>
        <button
          type="button"
          className="btn btn--primary"
          onClick={() => setChooserOpen(true)}
          data-ui={UI.allocations.unifiedAdd}
        >
          <Icon name="add" size={16} />
          {t('monthly.add')}
        </button>
      </div>

      {rules.length === 0 && startedItems.length === 0 ? (
        <div
          className="card card--pad empty"
          style={{ margin: 'var(--space-3) 0 var(--space-4)' }}
        >
          <Icon name="calendar" size={28} />
          <p style={{ marginTop: 'var(--space-3)' }}>{t('monthly.empty')}</p>
        </div>
      ) : null}

      {rules.length === 0 ? null : (
        <>
          <p className="section-label" style={{ marginTop: 'var(--space-3)' }}>
            {t('recurring.sectionTitle')}
          </p>
          <ul
            className="card list"
            style={{ marginBottom: 'var(--space-4)' }}
            data-ui={UI.allocations.recurringList}
          >
            {rules.map((r) => (
              <li key={r.id} className="list__item">
                <div className="list__main">
                  <div className="list__title">
                    {r.name} <span className="tag tag--teal">{ruleKindLabel(r)}</span>{' '}
                    {r.paused ? (
                      <span className="tag tag--neutral">{t('recurring.paused')}</span>
                    ) : null}
                  </div>
                  <div className="list__sub">
                    {ruleIntervalLabel(r)}・{name(r.creditAccountId)} →{' '}
                    {name(r.spreadExpenseAccountId ?? r.debitAccountId)}
                    {r.spreadExpenseAccountId !== undefined ? (
                      <>
                        ・{t('monthlyCost.monthly')}{' '}
                        <Money
                          amount={monthlyAmounts(r.amount, r.everyMonths)[0] ?? 0}
                          currency={currency}
                        />
                      </>
                    ) : null}
                  </div>
                  {ruleRefBroken(r) ? (
                    <div className="field__error" role="alert">
                      {t('recurring.refBroken')}
                    </div>
                  ) : null}
                </div>
                <span className="list__amount">
                  <Money amount={r.amount} currency={currency} />
                </span>
                <div className="row-actions">
                  <button
                    type="button"
                    className="icon-btn"
                    onClick={() => setRuleSheet({ existing: r })}
                    aria-label={`${t('common.edit')}: ${r.name}`}
                    data-ui={UI.allocations.recurringEdit}
                  >
                    <Icon name="edit" size={18} />
                  </button>
                  <button
                    type="button"
                    className="icon-btn"
                    onClick={() =>
                      setRecurringRulePaused(r.id, !r.paused).catch(() => undefined)
                    }
                    aria-label={`${r.paused ? t('recurring.resume') : t('recurring.pause')}: ${r.name}`}
                    data-ui={UI.allocations.recurringPause}
                  >
                    <Icon name={r.paused ? 'restore' : 'archive'} size={18} />
                  </button>
                  <button
                    type="button"
                    className="icon-btn"
                    onClick={() => setPendingRuleDelete(r)}
                    aria-label={`${t('common.delete')}: ${r.name}`}
                    data-ui={UI.allocations.recurringDelete}
                  >
                    <Icon name="delete" size={18} />
                  </button>
                </div>
              </li>
            ))}
          </ul>
        </>
      )}

      {startedItems.length === 0 ? null : (
        <>
          <p className="section-label" style={{ marginBottom: 'var(--space-2)' }}>
            {t('monthlyCost.sectionTitle')}
          </p>
          <label
            style={{
              display: 'inline-flex',
              gap: 8,
              alignItems: 'center',
              margin: '0 0 var(--space-3)',
            }}
          >
            <input
              type="checkbox"
              checked={showEnded}
              onChange={(e) => setShowEnded(e.target.checked)}
              data-ui={UI.allocations.showCompleted}
            />
            {t('monthlyCost.showEnded')}
          </label>

          <div className="stack" data-ui={UI.allocations.list}>
            {items.map((m) => {
              const spreadTotal = displaySpreadTotalOf(m);
              const ending = isEndingSoon(m, asOf);
              const monthly = representativeMonthlyAmount(m, spreadTotal);
              return (
                <div
                  className={`card card--pad${ending ? ' card--ending' : ''}`}
                  key={m.id}
                  data-ui={UI.allocations.item}
                  data-ending={ending ? 'true' : undefined}
                >
                  <div
                    className="list__title"
                    style={{
                      marginBottom: 'var(--space-2)',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                    }}
                  >
                    <span>{m.name}</span>
                    <span className="row-actions">
                      <button
                        type="button"
                        className="icon-btn"
                        onClick={() => setArchiving(m)}
                        aria-label={`${t('ccItem.archiveTitle')}: ${m.name}`}
                        data-ui={UI.allocations.archive}
                      >
                        <Icon name="archive" size={18} />
                      </button>
                      <button
                        type="button"
                        className="icon-btn"
                        onClick={() => setItemSheet({ existing: m })}
                        aria-label={`${t('common.edit')}: ${m.name}`}
                        data-ui={UI.allocations.edit}
                      >
                        <Icon name="edit" size={18} />
                      </button>
                      <button
                        type="button"
                        className="icon-btn"
                        onClick={() => setPendingDelete(m)}
                        aria-label={`${t('common.delete')}: ${m.name}`}
                      >
                        <Icon name="delete" size={18} />
                      </button>
                    </span>
                  </div>
                  <div className="kv">
                    <span className="muted">{t('monthlyCost.amount')}</span>
                    <span>
                      <Money amount={m.amount} currency={currency} />
                    </span>
                  </div>
                  <div className="kv">
                    <span className="muted">{t('monthlyCost.monthly')}</span>
                    <span>
                      {m.endDate === undefined ? '—' : <Money amount={monthly} currency={currency} />}
                    </span>
                  </div>
                  <div className="kv">
                    <span className="muted">{t('ccItem.period')}</span>
                    <span>
                      {m.startDate} 〜 {m.endDate ?? '—'}
                    </span>
                  </div>
                  <div className="kv">
                    <span className="muted">{t('ccItem.remainingValue')}</span>
                    <span>
                      <Money amount={remainingValue(m, asOf, spreadTotal)} currency={currency} />
                    </span>
                  </div>
                  <div className="kv">
                    <span className="muted">{t('monthlyCost.thisMonth')}</span>
                    <span>
                      <Money
                        amount={monthlyCostForMonth(m, currentYm, spreadTotal)}
                        currency={currency}
                      />
                    </span>
                  </div>
                  <div className="kv">
                    <span className="muted">{t('monthlyCost.expenseCategory')}</span>
                    <span>{name(m.expenseAccountId)}</span>
                  </div>
                </div>
              );
            })}
          </div>
        </>
      )}

      {pendingDelete ? (
        <ConfirmDialog
          title={t('monthlyCost.deleteConfirmTitle')}
          body={t('monthlyCost.deleteConfirmBody', { name: pendingDelete.name })}
          confirmLabel={t('common.delete')}
          danger
          onCancel={() => setPendingDelete(null)}
          onConfirm={async () => {
            const m = pendingDelete;
            setPendingDelete(null);
            await removeMonthlyCost(m.id).catch(() => undefined);
          }}
        />
      ) : null}

      {itemSheet ? (
        <ContinuousCostItemSheet
          {...(itemSheet.existing !== undefined ? { existing: itemSheet.existing } : {})}
          {...(itemSheet.existing !== undefined
            ? { purchaseEntry: purchaseEntryOf(itemSheet.existing) }
            : {})}
          onOpenPurchase={onEditEntry}
          onClose={() => setItemSheet(null)}
        />
      ) : null}

      {archiving ? (
        <MonthlyCostArchiveDialog
          item={archiving}
          spreadTotal={operationSpreadTotalOf(archiving)}
          onClose={() => setArchiving(null)}
        />
      ) : null}

      {chooserOpen ? (
        <AddChooserSheet
          onClose={() => setChooserOpen(false)}
          onPick={(pick) => {
            setChooserOpen(false);
            if (pick === 'asset') setItemSheet({});
            else setRuleSheet({});
          }}
        />
      ) : null}

      {ruleSheet ? (
        <RecurringRuleSheet
          {...(ruleSheet.existing !== undefined ? { existing: ruleSheet.existing } : {})}
          onClose={() => setRuleSheet(null)}
        />
      ) : null}

      {pendingRuleDelete ? (
        <ConfirmDialog
          title={t('recurring.deleteConfirmTitle')}
          body={t('recurring.deleteConfirmBody', { name: pendingRuleDelete.name })}
          confirmLabel={t('common.delete')}
          danger
          onCancel={() => setPendingRuleDelete(null)}
          onConfirm={async () => {
            const r = pendingRuleDelete;
            setPendingRuleDelete(null);
            await removeRecurringRule(r.id).catch(() => undefined);
          }}
        />
      ) : null}
    </section>
  );
}

/** 統一追加フローの2択: くり返し記帳（ルール） / 継続コスト資産の持ち込み。 */
type AddPick = 'rule' | 'asset';

const ADD_CHOICES: { pick: AddPick; labelKey: MessageKey }[] = [
  { pick: 'rule', labelKey: 'monthly.pick.rule' },
  { pick: 'asset', labelKey: 'monthly.pick.asset' },
];

/** 「追加」の種別選択シート（種別の選択はそれぞれのシート内に一本化）。 */
function AddChooserSheet({
  onClose,
  onPick,
}: {
  onClose: () => void;
  onPick: (pick: AddPick) => void;
}) {
  return (
    <Modal
      title={t('monthly.add')}
      onClose={onClose}
      variant="dialog"
      dataUi={UI.allocations.addChooser}
    >
      <div className="stack">
        {ADD_CHOICES.map((c) => (
          <button
            key={c.pick}
            type="button"
            className="list__row-btn"
            onClick={() => onPick(c.pick)}
            data-ui={`${UI.allocations.addChooser}.${c.pick}`}
          >
            <span className="list__row-btn__label" style={{ fontWeight: 600 }}>
              {t(c.labelKey)}
            </span>
            <Icon name="chevronRight" size={16} />
          </button>
        ))}
      </div>
    </Modal>
  );
}

/** 一覧で導出表示する種別。保存フィールドではない。 */
type SheetKind = RecurringKind | 'manual';

/**
 * ルールの表示・編集用の種別（保存しない）。月割りするルール（借方=台帳）は、
 * 費用の行き先と源泉が支出の定型（資金/カード → 費用カテゴリ）なら支出、
 * それ以外（例: 健康保険 = 銀行 → 給与）は簿記編集（継続コスト化 ON）として扱う。
 */
function sheetKindForRule(
  rule: RecurringRule,
  roleOf: (id: string) => AccountRole | undefined,
): SheetKind {
  if (rule.spreadExpenseAccountId !== undefined) {
    const creditRole = roleOf(rule.creditAccountId);
    return roleOf(rule.spreadExpenseAccountId) === 'expense-category' &&
      (creditRole === 'daily-asset' || creditRole === 'payment-liability')
      ? 'expense'
      : 'manual';
  }
  return (
    recurringKindOf(roleOf(rule.debitAccountId), roleOf(rule.creditAccountId)) ?? 'manual'
  );
}

/**
 * 定期ルールの追加・編集シート。周期（everyMonths）付き。
 * 独自の種別 UI は持たず、簿記編集と同じく貸方・借方を直接指定する。
 * 「継続コストとして扱う」ON のときだけ、画面上の借方を費用の行き先として
 * 継続コスト台帳経由にする。
 */
function RecurringRuleSheet({
  existing,
  onClose,
}: {
  existing?: RecurringRule;
  onClose: () => void;
}) {
  const { ledger, createRecurringRule, saveRecurringRule } = useLedger();
  const accounts = sortAccounts(ledger?.accounts ?? []);

  const existingSpread = existing?.spreadExpenseAccountId !== undefined;
  // 「継続コストとして扱う」（既定 OFF・月割りする既存ルールは ON で開く）。
  const [manualSpread, setManualSpread] = useState(existingSpread);
  const initialFromGroups = groupedAccountsByRole(
    accounts,
    [...RECURRING_POSTABLE_ROLES],
    existing?.creditAccountId,
  );
  const firstFromId = initialFromGroups.flatMap((group) => group.accounts)[0]?.id ?? '';
  const [creditAccountId, setCreditAccountId] = useState(
    existing?.creditAccountId ?? firstFromId,
  );
  // 月割りするルールの「行き先」は費用の行き先（spreadExpenseAccountId）を見せる（台帳は見せない）。
  const existingDebit = existing
    ? (existing.spreadExpenseAccountId ?? existing.debitAccountId)
    : undefined;
  const initialToGroups = groupedAccountsByRole(
    accounts,
    [...RECURRING_POSTABLE_ROLES],
    existingDebit,
  );
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
  const toGroups = groupedAccountsByRole(
    accounts,
    [...RECURRING_POSTABLE_ROLES],
    debitAccountId,
  )
    .map((group) => ({
      ...group,
      accounts: group.accounts.filter((account) => account.id !== creditAccountId),
    }))
    .filter((group) => group.accounts.length > 0);

  const [name, setName] = useState(existing?.name ?? '');
  const [amountText, setAmountText] = useState(
    existing !== undefined ? String(existing.amount) : '',
  );
  const [everyText, setEveryText] = useState(
    existing !== undefined ? String(existing.everyMonths) : '1',
  );
  const [firstPostingDate, setFirstPostingDate] = useState(() =>
    existing ? clampDayToMonth(existing.startMonth, existing.dayOfMonth) : todayLocal(),
  );
  const [error, setError] = useState<string | undefined>(undefined);
  const [submitting, setSubmitting] = useState(false);

  async function submit() {
    if (submitting) return;
    const amount = amountText === '' ? 0 : Number.parseInt(amountText, 10);
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
    const day = Number.parseInt(firstPostingDate.slice(8, 10), 10);
    const startMonth = monthOf(firstPostingDate);
    // 日付欄は「元の dayOfMonth をその月へクランプした結果」を表示している。表示どおりのまま
    // なら日を触っていない＝元の値を保つ（2 月のルールを開いて保存しただけで 31 → 28 に
    // 落ち、以後の起票日がずれるのを防ぐ）。日を変えたときだけ入力値を採用する。
    const dayOfMonth =
      existing !== undefined &&
      clampDayToMonth(startMonth, existing.dayOfMonth).slice(8, 10) ===
        firstPostingDate.slice(8, 10)
        ? existing.dayOfMonth
        : day;
    const spread = manualSpread;
    setSubmitting(true);
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
          updatedAt: nowIso(),
        };
        if (spread) next.spreadExpenseAccountId = debitAccountId;
        else delete next.spreadExpenseAccountId;
        await saveRecurringRule(next);
      } else {
        await createRecurringRule({
          name: name.trim(),
          amount,
          dayOfMonth: day,
          everyMonths,
          ...(spread ? { spreadExpenseAccountId: debitAccountId } : {}),
          debitAccountId,
          creditAccountId,
          startMonth,
        });
      }
      onClose();
    } catch (e) {
      setError(errorText(e));
      setSubmitting(false);
    }
  }

  return (
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
        <p className="field__hint">{t('recurring.manualHint')}</p>
        <label
          style={{ display: 'inline-flex', gap: 8, alignItems: 'center', minHeight: 'var(--tap)' }}
        >
          <input
            type="checkbox"
            checked={manualSpread}
            onChange={(e) => setManualSpread(e.target.checked)}
            data-ui={UI.allocations.recurringManualSpread}
          />
          {t('recurring.manualSpread')}
        </label>
        <TextInput
          label={t('recurring.name')}
          required
          value={name}
          onChange={setName}
          hint={t('recurring.nameHint')}
          dataUi={UI.allocations.recurringName}
        />
        <AccountPicker
          label={t('recurring.from.manual')}
          required
          value={creditAccountId}
          onChange={(id) => {
            setCreditAccountId(id);
            if (id === debitAccountId) setDebitAccountId('');
          }}
          groups={fromGroups}
          dataUi={UI.allocations.recurringFrom}
        />
        {/* 継続コストとして扱うルールの借方欄 = 費用の行き先（実仕訳の借方は台帳固定）。 */}
        <AccountPicker
          label={manualSpread ? t('monthlyCost.expenseCategory') : t('recurring.to.manual')}
          required
          value={debitAccountId}
          onChange={setDebitAccountId}
          groups={toGroups}
          dataUi={UI.allocations.recurringTo}
        />
        <TextInput
          label={t('recurring.amount')}
          required
          inputMode="numeric"
          value={amountText}
          onChange={(v) => setAmountText(v.replace(/[^\d]/g, ''))}
          hint={t('recurring.amountHint')}
          dataUi={UI.allocations.recurringAmount}
        />
        <TextInput
          label={t('recurring.intervalMonths')}
          required
          inputMode="numeric"
          value={everyText}
          onChange={(v) => setEveryText(v.replace(/[^\d]/g, ''))}
          dataUi={UI.allocations.recurringEvery}
        />
        <TextInput
          label={t('recurring.firstPostingDate')}
          type="date"
          required
          value={firstPostingDate}
          onChange={setFirstPostingDate}
          dataUi={UI.allocations.recurringFirstPostingDate}
        />
        {existing?.paused ? <p className="field__hint">{t('recurring.resumeNote')}</p> : null}
      </div>
    </Modal>
  );
}

/**
 * 継続コスト資産シート（登録＝編集の 1 コンポーネント）。
 *  - 新規 = 持ち込み登録: 金額は購入額。過去日で普通に登録できる（制約なし）。貸方は初期残高。
 *  - 編集 = 名前・金額・終了日・費用の行き先のみ。開始日は購入の仕訳の日付のミラーなので
 *    読み取り専用（タップで購入の仕訳へ）。
 *  - 終了日は空でよい（空なら費用の割り振りをしない）。
 */
function ContinuousCostItemSheet({
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
  const { ledger, createContinuousCost, saveMonthlyCost } = useLedger();
  const accounts = ledger?.accounts ?? [];
  const recognitionOptions = recognitionAccountOptions(accounts, existing?.expenseAccountId);

  const [name, setName] = useState(existing?.name ?? '');
  const [amountText, setAmountText] = useState(
    existing !== undefined ? String(existing.amount) : '',
  );
  const [startDate, setStartDate] = useState(existing?.startDate ?? todayLocal());
  const [endDate, setEndDate] = useState(existing?.endDate ?? '');
  // 費用の行き先の既定値は「前回選んだもの」（連続登録の切り替え手間を減らす）。
  const [expenseAccountId, setExpenseAccountId] = useState(() => {
    if (existing) return existing.expenseAccountId;
    const last = lastExpenseCategoryId();
    if (last && recognitionOptions.some((o) => o.value === last)) return last;
    return defaultRecognitionAccountId(accounts);
  });
  const [error, setError] = useState<string | undefined>(undefined);
  const [submitting, setSubmitting] = useState(false);

  // 過去から再計算される項目の変更予告（破壊的操作の予告なので削らない）。
  const pastFieldsChanged =
    existing !== undefined &&
    (amountText !== String(existing.amount) ||
      endDate !== (existing.endDate ?? '') ||
      expenseAccountId !== existing.expenseAccountId);

  async function submit() {
    if (submitting) return;
    const amount = amountText === '' ? 0 : Number.parseInt(amountText, 10);
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
          <div className="field__warning" role="status" data-ui={UI.allocations.editImpactWarning}>
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
          inputMode="numeric"
          value={amountText}
          onChange={(v) => setAmountText(v.replace(/[^\d]/g, ''))}
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
            onChange={setStartDate}
            dataUi={UI.allocations.editStartDate}
          />
        )}
        <TextInput
          label={t('ccItem.endDate')}
          type="date"
          value={endDate}
          onChange={setEndDate}
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
        </div>
        <SelectInput
          label={t('monthlyCost.expenseCategory')}
          value={expenseAccountId}
          onChange={setExpenseAccountId}
          options={recognitionOptions}
          dataUi={UI.allocations.editExpense}
        />
      </div>
    </Modal>
  );
}

/**
 * アーカイブ = 終了日の設定。残存価値が残るなら「振替先を選ぶ」でホームの振替と同じシートを
 * 開き、回収の振替（借方 振替先 / 貸方 継続コスト台帳）を同一トランザクションで保存する。
 * 振替せずアーカイブ = 残存価値は全額その月までの費用になる（捨てた・使い切った）。
 * 終了済みの行にも同じボタンを出す（終了日を先へ動かせば一覧に戻る＝復元も同じ 1 操作）。
 */
function MonthlyCostArchiveDialog({
  item,
  spreadTotal,
  onClose,
}: {
  item: MonthlyCostItem;
  spreadTotal: number;
  onClose: () => void;
}) {
  const { ledger, archiveMonthlyCost } = useLedger();
  const currency = ledger?.settings.currency ?? 'JPY';
  // 既定 = 今日。終了済みの行だけ現在の endDate（先へ動かせば一覧へ戻る = 復元も同じ 1 操作）。
  const [endDate, setEndDate] = useState(() =>
    isArchived(item, todayLocal()) && item.endDate !== undefined ? item.endDate : todayLocal(),
  );
  const [transferOpen, setTransferOpen] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  const [submitting, setSubmitting] = useState(false);

  // 変更前の item の割り振りで「その日までに費用になっていない残り」。
  // remainingValue が回収済みを織り込んだ単一正本（spreadTotal − 認識済み）なので、
  // ここで回収額をもう一度引かない（一覧と同じ値になる・監査 P2-1）。
  const remaining = isValidIsoDate(endDate)
    ? remainingValue(item, endDate, spreadTotal)
    : remainingValue(item, todayLocal(), spreadTotal);

  async function archiveWithoutTransfer() {
    if (submitting) return;
    setSubmitting(true);
    setError(undefined);
    try {
      await archiveMonthlyCost({ id: item.id, endDate });
      onClose();
    } catch (e) {
      setError(errorText(e));
      setSubmitting(false);
    }
  }

  return (
    <>
      <Modal
        title={t('ccItem.archiveTitle')}
        onClose={onClose}
        variant="dialog"
        dataUi={UI.allocations.archiveDialog}
        footer={
          <>
            <button type="button" className="btn btn--ghost" onClick={onClose}>
              {t('common.cancel')}
            </button>
            <button
              type="button"
              className="btn btn--primary"
              onClick={archiveWithoutTransfer}
              disabled={submitting || endDate === ''}
              data-ui={UI.allocations.archiveConfirm}
            >
              {t('ccItem.archiveTitle')}
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
            dataUi={UI.allocations.archiveDate}
          />
          <div className="kv">
            <span className="muted">{t('ccItem.remainingValue')}</span>
            <span>
              <Money amount={remaining} currency={currency} />
            </span>
          </div>
          {remaining > 0 ? (
            <button
              type="button"
              className="btn btn--block"
              onClick={() => setTransferOpen(true)}
              disabled={endDate === ''}
              data-ui={UI.allocations.archiveTransfer}
            >
              <Icon name="transfer" size={16} />
              {t('ccItem.transferTarget')}
            </button>
          ) : null}
        </div>
      </Modal>

      {transferOpen ? (
        <EntrySheet
          init={{
            kind: 'transfer-fixed',
            fixed: {
              side: 'credit',
              accountId: CONTINUOUS_COST_LEDGER_ACCOUNT_ID,
              counterpartRoles: [...RECURRING_POSTABLE_ROLES],
              date: endDate,
              lockDate: true,
              amount: remaining,
              description: item.name,
              onSave: async (input) => {
                await archiveMonthlyCost({
                  id: item.id,
                  endDate,
                  recovery: {
                    destinationAccountId: input.debitAccountId,
                    amount: input.amount,
                  },
                });
                onClose();
              },
            },
          }}
          onClose={() => setTransferOpen(false)}
        />
      ) : null}
    </>
  );
}
