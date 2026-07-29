/*
 * 毎月のもの。
 *  - 定期ルール（毎月の支出・収入・振替）: 実仕訳の自動起票（正本は起票された仕訳）。
 *  - 継続コスト（費用の月割り）: 年払い・耐久財などを「月あたりコスト」で見る導出レイヤ。
 * 実際にお金が動くものはルールで起票し、動いたお金の月割り解釈は継続コストが担う。
 */
import { useMemo, useState } from 'react';
import { Modal } from '../overlays';
import { SelectInput, TextInput } from '@snishi/foundation/ui/Field';
import { Icon } from '@snishi/foundation/ui/Icon';
import { ConfirmDialog } from '../overlays';
import { useLedger } from '../../state/store';
import {
  isOverEstimate,
  monthlyCostForMonth,
  representativeMonthlyAmount,
} from '../../domain/monthlyCost';
import { lastExpenseCategoryId, rememberExpenseCategoryId } from '../../data/localFlags';
import { sortAccounts } from '../../domain/accountOrder';
import { defaultRecognitionAccountId, recognitionAccountOptions } from '../accountOptions';
import {
  continuousCostDisposalEndMonth,
  continuousCostDisposalOutcome,
  isContinuingCostItem,
} from '../../domain/continuousCost';
import { addMonths, monthOf } from '../../domain/allocation';
import { currentYearMonth, nowIso, todayLocal } from '../../util/time';
import {
  RECURRING_POSTABLE_ROLES,
  clampDayToMonth,
  recurringKindOf,
  type RecurringKind,
} from '../../domain/recurring';
import { Money } from '../money';
import { MonthField } from '../MonthField';
import { errorText, t } from '../../i18n';
import type { MessageKey } from '../../i18n';
import { UI } from '../../ui-contract';
import type { MonthlyCostItem, MonthlyCostStatus, RecurringRule } from '../../domain/types';

const STATUSES: MonthlyCostStatus[] = ['active', 'paused', 'ended'];

export function Allocations() {
  const { ledger, saveMonthlyCost, removeMonthlyCost, saveRecurringRule, removeRecurringRule } =
    useLedger();
  const [showInactive, setShowInactive] = useState(false);
  const [pendingDelete, setPendingDelete] = useState<MonthlyCostItem | null>(null);
  const [editing, setEditing] = useState<MonthlyCostItem | null>(null);
  const [disposing, setDisposing] = useState<MonthlyCostItem | null>(null);
  const [migrating, setMigrating] = useState(false);
  const [chooserOpen, setChooserOpen] = useState(false);
  const [subMigrating, setSubMigrating] = useState(false);
  const [ruleSheet, setRuleSheet] = useState<{
    existing?: RecurringRule;
    initialKind?: RecurringKind;
  } | null>(null);
  const [pendingRuleDelete, setPendingRuleDelete] = useState<RecurringRule | null>(null);
  const { year, month } = currentYearMonth();
  const currentYm = `${year}-${String(month).padStart(2, '0')}`;
  const currency = ledger?.settings.currency ?? 'JPY';

  const accountsMap = useMemo(
    () => new Map((ledger?.accounts ?? []).map((a) => [a.id, a] as const)),
    [ledger],
  );
  const disposedItemIds = useMemo(
    () => new Set((ledger?.assetDisposals ?? []).map((disposal) => disposal.monthlyCostId)),
    [ledger],
  );
  const name = (id?: string): string => (id ? (accountsMap.get(id)?.name ?? '—') : '—');
  const isDisposed = (item: MonthlyCostItem): boolean => disposedItemIds.has(item.id);

  // 実績動的償却: 見込みを超えても自動終了しない（月額を実績で再計算しながら生き続ける）。
  // 終了は売却 / 0円売却（解約・故障）の明示操作のみ。停止・終了分は showInactive で表示。
  const items = useMemo(
    () => (ledger?.monthlyCostItems ?? []).filter((m) => showInactive || m.status === 'active'),
    [ledger, showInactive],
  );

  async function togglePause(item: MonthlyCostItem) {
    if (isDisposed(item)) return;
    if (item.status === 'active') {
      await saveMonthlyCost({
        ...item,
        status: 'paused',
        endMonth: addMonths(currentYm, -1),
        updatedAt: nowIso(),
      }).catch(() => undefined);
    } else {
      const next: MonthlyCostItem = { ...item, status: 'active', updatedAt: nowIso() };
      delete next.endMonth;
      await saveMonthlyCost(next).catch(() => undefined);
    }
  }

  // 資産経由モデルの継続コスト対象。サブスク解約・返金なし終了も「0円で売却」で同じ導線から終了する。
  const isContinuingItem = (m: MonthlyCostItem): boolean => isContinuingCostItem(m, accountsMap);
  const canDispose = (m: MonthlyCostItem): boolean =>
    !isDisposed(m) && m.status !== 'ended' && isContinuingItem(m);

  const rules = ledger?.recurringRules ?? [];
  const ruleKindLabel = (r: RecurringRule): string => {
    const kind = recurringKindOf(
      accountsMap.get(r.debitAccountId)?.role,
      accountsMap.get(r.creditAccountId)?.role,
    );
    // 定型に当てはまらない組み合わせは簿記編集ルール。
    return t(`recurring.kind.${kind ?? 'manual'}` as MessageKey);
  };
  async function toggleRulePause(rule: RecurringRule) {
    // 再開は今月から（停止中の月を遡って起票しない）。startMonth を現在月へ更新する。
    const next: RecurringRule = rule.paused
      ? { ...rule, paused: false, startMonth: currentYm, updatedAt: nowIso() }
      : { ...rule, paused: true, updatedAt: nowIso() };
    await saveRecurringRule(next).catch(() => undefined);
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
          style={{ minHeight: 36 }}
          onClick={() => setChooserOpen(true)}
          data-ui={UI.allocations.unifiedAdd}
        >
          <Icon name="add" size={16} />
          {t('monthly.add')}
        </button>
      </div>
      <p className="field__hint" style={{ margin: 'var(--space-2) 0 var(--space-3)' }}>
        {t('monthly.intro')}
      </p>

      {rules.length === 0 && items.length === 0 ? (
        <div className="card card--pad empty" style={{ marginBottom: 'var(--space-4)' }}>
          <Icon name="calendar" size={28} />
          <p style={{ marginTop: 'var(--space-3)' }}>{t('monthly.empty')}</p>
        </div>
      ) : rules.length === 0 ? null : (
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
                  {t('recurring.everyMonthDay', { day: r.dayOfMonth })}・{name(r.creditAccountId)} →{' '}
                  {name(r.debitAccountId)}
                </div>
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
                  onClick={() => toggleRulePause(r)}
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
      )}

      <label
        style={{
          display: 'inline-flex',
          gap: 8,
          alignItems: 'center',
          margin: '0 0 var(--space-4)',
        }}
      >
        <input
          type="checkbox"
          checked={showInactive}
          onChange={(e) => setShowInactive(e.target.checked)}
          data-ui={UI.allocations.showCompleted}
        />
        {t('monthlyCost.showInactive')}
      </label>

      {items.length === 0 ? null : (
        <div className="stack" data-ui={UI.allocations.list}>
          {items.map((m) => {
            const thisMonth = monthlyCostForMonth(m, currentYm);
            return (
              <div className="card card--pad" key={m.id}>
                <div
                  className="list__title"
                  style={{
                    marginBottom: 'var(--space-2)',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                  }}
                >
                  <span>
                    {m.name}{' '}
                    <span className={`tag ${m.status === 'active' ? 'tag--teal' : 'tag--neutral'}`}>
                      {t(`monthlyCost.status.${m.status}` as MessageKey)}
                    </span>{' '}
                    {isOverEstimate(m, currentYm) ? (
                      <span className="tag tag--warning" data-ui={UI.allocations.overEstimateBadge}>
                        {t('monthlyCost.overEstimateBadge')}
                      </span>
                    ) : null}{' '}
                    <span className="tag tag--neutral" style={{ fontSize: '0.75em' }}>
                      {m.repeatEveryMonths !== undefined
                        ? t('monthlyCost.recurringBadge')
                        : t('monthlyCost.oneTimeBadge')}
                    </span>
                  </span>
                  <span className="row-actions">
                    {canDispose(m) ? (
                      <button
                        type="button"
                        className="icon-btn"
                        onClick={() => setDisposing(m)}
                        aria-label={`${t('disposal.action')}: ${m.name}`}
                        data-ui={UI.allocations.dispose}
                      >
                        <Icon name="transfer" size={18} />
                      </button>
                    ) : null}
                    <button
                      type="button"
                      className="icon-btn"
                      onClick={() => setEditing(m)}
                      aria-label={`${t('monthlyCost.edit')}: ${m.name}`}
                      data-ui={UI.allocations.edit}
                    >
                      <Icon name="edit" size={18} />
                    </button>
                    {!isDisposed(m) ? (
                      <button
                        type="button"
                        className="icon-btn"
                        onClick={() => togglePause(m)}
                        aria-label={`${m.status === 'active' ? t('monthlyCost.pause') : t('monthlyCost.resume')}: ${m.name}`}
                        data-ui={UI.allocations.pauseToggle}
                      >
                        <Icon name={m.status === 'active' ? 'archive' : 'restore'} size={18} />
                      </button>
                    ) : null}
                    {isDisposed(m) ? null : (
                      <button
                        type="button"
                        className="icon-btn"
                        onClick={() => setPendingDelete(m)}
                        aria-label={`${t('common.delete')}: ${m.name}`}
                      >
                        <Icon name="delete" size={18} />
                      </button>
                    )}
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
                    <Money amount={representativeMonthlyAmount(m, currentYm)} currency={currency} />
                  </span>
                </div>
                <div className="kv">
                  <span className="muted">{t('monthlyCost.costMonths')}</span>
                  <span>{t('monthlyCost.monthsUnit', { count: m.costMonths })}</span>
                </div>
                {m.repeatEveryMonths !== undefined ? (
                  <div className="kv">
                    <span className="muted">{t('monthlyCost.repeat')}</span>
                    <span>{t('monthlyCost.repeatUnit', { count: m.repeatEveryMonths })}</span>
                  </div>
                ) : null}
                <div className="kv">
                  <span className="muted">{t('monthlyCost.thisMonth')}</span>
                  <span>
                    <Money amount={thisMonth} currency={currency} />
                  </span>
                </div>
                <div className="kv">
                  <span className="muted">{t('monthlyCost.expenseCategory')}</span>
                  <span>{name(m.expenseAccountId)}</span>
                </div>
                <div className="kv">
                  <span className="muted">{t('monthlyCost.payment')}</span>
                  <span>{name(m.paymentSourceAccountId ?? m.paymentAccountId)}</span>
                </div>
              </div>
            );
          })}
        </div>
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

      {editing ? (
        <MonthlyCostEditSheet
          item={editing}
          disposed={isDisposed(editing)}
          onClose={() => setEditing(null)}
        />
      ) : null}

      {migrating ? <ContinuousCostMigrateSheet onClose={() => setMigrating(false)} /> : null}

      {subMigrating ? <SubscriptionMigrationSheet onClose={() => setSubMigrating(false)} /> : null}

      {chooserOpen ? (
        <AddChooserSheet
          onClose={() => setChooserOpen(false)}
          onPick={(pick) => {
            setChooserOpen(false);
            if (pick === 'sub-migration') setSubMigrating(true);
            else if (pick === 'asset') setMigrating(true);
            else setRuleSheet({ initialKind: pick });
          }}
        />
      ) : null}

      {ruleSheet ? (
        <RecurringRuleSheet
          {...(ruleSheet.existing !== undefined ? { existing: ruleSheet.existing } : {})}
          {...(ruleSheet.initialKind !== undefined ? { initialKind: ruleSheet.initialKind } : {})}
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

      {disposing ? (
        <MonthlyCostDisposeSheet item={disposing} onClose={() => setDisposing(null)} />
      ) : null}
    </section>
  );
}

/** 統一追加フローの選択肢。定期ルール3種 + 契約持ち込み + 持ち物（償却）。 */
type AddPick = RecurringKind | 'sub-migration' | 'asset';

const ADD_CHOICES: { pick: AddPick; labelKey: MessageKey; hintKey: MessageKey }[] = [
  { pick: 'expense', labelKey: 'monthly.pick.expense', hintKey: 'monthly.pick.expenseHint' },
  { pick: 'income', labelKey: 'monthly.pick.income', hintKey: 'monthly.pick.incomeHint' },
  { pick: 'transfer', labelKey: 'monthly.pick.transfer', hintKey: 'monthly.pick.transferHint' },
  {
    pick: 'sub-migration',
    labelKey: 'monthly.pick.subMigration',
    hintKey: 'monthly.pick.subMigrationHint',
  },
  { pick: 'asset', labelKey: 'monthly.pick.asset', hintKey: 'monthly.pick.assetHint' },
];

/** 「追加」の種別選択シート（登録の一本化。ここから各シートへ分岐する）。 */
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
        <p className="field__hint">{t('monthly.pickIntro')}</p>
        {ADD_CHOICES.map((c) => (
          <button
            key={c.pick}
            type="button"
            className="list__row-btn"
            onClick={() => onPick(c.pick)}
            data-ui={`${UI.allocations.addChooser}.${c.pick}`}
          >
            <span className="list__row-btn__label" style={{ display: 'block' }}>
              <span style={{ display: 'block', fontWeight: 600 }}>{t(c.labelKey)}</span>
              <span className="field__hint">{t(c.hintKey)}</span>
            </span>
            <Icon name="chevronRight" size={16} />
          </button>
        ))}
      </div>
    </Modal>
  );
}

/**
 * 自動更新される契約（年払いサブスク等）の途中持ち込みシート。
 * 残り（初期残高扱い・残り月数で認識し切って終了）+ 更新分（更新周期で自動継続・支払い元 funding）
 * の 2 項目を一度に作る。解約は有効な項目の 0 円売却 1 操作。
 */
function SubscriptionMigrationSheet({ onClose }: { onClose: () => void }) {
  const { ledger, createSubscriptionMigration } = useLedger();
  const accounts = sortAccounts(ledger?.accounts ?? []);

  const recognitionOptions = recognitionAccountOptions(accounts);
  const paymentOptions = accounts
    .filter(
      (a) =>
        (a.role === 'daily-asset' ||
          a.role === 'payment-liability' ||
          a.role === 'other-liability') &&
        !a.archived,
    )
    .map((a) => ({ value: a.id, label: a.name }));

  const [name, setName] = useState('');
  const [remainingAmountText, setRemainingAmountText] = useState('');
  const [remainingMonthsText, setRemainingMonthsText] = useState('');
  const [renewalAmountText, setRenewalAmountText] = useState('');
  const [renewalEveryText, setRenewalEveryText] = useState('12');
  const [paymentSourceAccountId, setPaymentSourceAccountId] = useState(
    paymentOptions[0]?.value ?? '',
  );
  const storedCategory = lastExpenseCategoryId();
  const [expenseAccountId, setExpenseAccountId] = useState(
    (storedCategory !== null && recognitionOptions.some((o) => o.value === storedCategory)
      ? storedCategory
      : null) ?? defaultRecognitionAccountId(accounts),
  );
  const [fieldErrors, setFieldErrors] = useState<{
    remainingAmount?: string;
    remainingMonths?: string;
    renewalAmount?: string;
    renewalEvery?: string;
  }>({});
  const [error, setError] = useState<string | undefined>(undefined);
  const [submitting, setSubmitting] = useState(false);

  const parse = (v: string) => (v === '' ? 0 : Number.parseInt(v, 10));

  async function submit() {
    if (submitting) return;
    const remainingAmount = parse(remainingAmountText);
    const remainingMonths = parse(remainingMonthsText);
    const renewalAmount = parse(renewalAmountText);
    const renewalEveryMonths = parse(renewalEveryText);
    const nextFieldErrors: typeof fieldErrors = {};
    if (!Number.isInteger(remainingAmount) || remainingAmount < 1) {
      nextFieldErrors.remainingAmount = t('error.subMigration.remainingAmountInvalid');
    }
    if (!Number.isInteger(remainingMonths) || remainingMonths < 1) {
      nextFieldErrors.remainingMonths = t('error.subMigration.remainingMonthsInvalid');
    }
    if (!Number.isInteger(renewalAmount) || renewalAmount < 1) {
      nextFieldErrors.renewalAmount = t('error.subMigration.renewalAmountInvalid');
    }
    if (!Number.isInteger(renewalEveryMonths) || renewalEveryMonths < 1) {
      nextFieldErrors.renewalEvery = t('error.subMigration.renewalEveryInvalid');
    }
    if (Object.keys(nextFieldErrors).length > 0) {
      setFieldErrors(nextFieldErrors);
      setError(undefined);
      return;
    }
    setSubmitting(true);
    setFieldErrors({});
    setError(undefined);
    try {
      await createSubscriptionMigration({
        name: name.trim(),
        remainingAmount,
        remainingMonths,
        renewalAmount,
        renewalEveryMonths,
        paymentSourceAccountId,
        expenseAccountId,
      });
      rememberExpenseCategoryId(expenseAccountId);
      onClose();
    } catch (e) {
      setError(errorText(e));
      setSubmitting(false);
    }
  }

  return (
    <Modal
      title={t('subMigration.title')}
      onClose={onClose}
      dismissMode="if-clean"
      dataUi={UI.allocations.subMigrationSheet}
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
              remainingAmountText === '' ||
              remainingMonthsText === '' ||
              renewalAmountText === '' ||
              renewalEveryText === '' ||
              paymentSourceAccountId === '' ||
              expenseAccountId === ''
            }
            data-ui={UI.allocations.subMigrationSave}
          >
            {t('common.save')}
          </button>
        </>
      }
    >
      <div className="stack">
        <p className="field__hint">{t('subMigration.intro')}</p>
        {error ? (
          <div className="field__error" role="alert">
            <Icon name="alert" size={14} />
            {error}
          </div>
        ) : null}
        <TextInput
          label={t('monthlyCost.migrateName')}
          required
          value={name}
          onChange={setName}
          dataUi={UI.allocations.subMigrationName}
        />
        <TextInput
          label={t('subMigration.remainingAmount')}
          required
          inputMode="numeric"
          value={remainingAmountText}
          onChange={(v) => {
            setRemainingAmountText(v.replace(/[^\d]/g, ''));
            setFieldErrors((current) => ({ ...current, remainingAmount: undefined }));
          }}
          hint={t('subMigration.remainingAmountHint')}
          error={fieldErrors.remainingAmount}
          dataUi={UI.allocations.subMigrationRemaining}
        />
        <TextInput
          label={t('subMigration.remainingMonths')}
          required
          inputMode="numeric"
          value={remainingMonthsText}
          onChange={(v) => {
            setRemainingMonthsText(v.replace(/[^\d]/g, ''));
            setFieldErrors((current) => ({ ...current, remainingMonths: undefined }));
          }}
          hint={t('subMigration.remainingMonthsHint')}
          error={fieldErrors.remainingMonths}
          dataUi={UI.allocations.subMigrationMonths}
        />
        <TextInput
          label={t('subMigration.renewalAmount')}
          required
          inputMode="numeric"
          value={renewalAmountText}
          onChange={(v) => {
            setRenewalAmountText(v.replace(/[^\d]/g, ''));
            setFieldErrors((current) => ({ ...current, renewalAmount: undefined }));
          }}
          error={fieldErrors.renewalAmount}
          dataUi={UI.allocations.subMigrationRenewal}
        />
        <TextInput
          label={t('subMigration.renewalEvery')}
          required
          inputMode="numeric"
          value={renewalEveryText}
          onChange={(v) => {
            setRenewalEveryText(v.replace(/[^\d]/g, ''));
            setFieldErrors((current) => ({ ...current, renewalEvery: undefined }));
          }}
          hint={t('subMigration.renewalEveryHint')}
          error={fieldErrors.renewalEvery}
        />
        <SelectInput
          label={t('subMigration.paymentSource')}
          value={paymentSourceAccountId}
          onChange={setPaymentSourceAccountId}
          options={paymentOptions}
          hint={t('subMigration.paymentSourceHint')}
        />
        <SelectInput
          label={t('monthlyCost.expenseCategory')}
          value={expenseAccountId}
          onChange={setExpenseAccountId}
          options={recognitionOptions}
        />
        <p className="field__hint">{t('subMigration.cancelHint')}</p>
      </div>
    </Modal>
  );
}

/** 定期ルールの種別ごとの科目役割（源泉=貸方 / 行き先=借方）。 */
/** シート内だけの種別。定型3種 + 簿記編集（任意の科目ペアを直接指定）。 */
type SheetKind = RecurringKind | 'manual';

const RULE_ROLES: Record<
  SheetKind,
  { from: readonly string[]; to: readonly string[]; fromKey: MessageKey; toKey: MessageKey }
> = {
  expense: {
    from: ['daily-asset', 'payment-liability'],
    to: ['expense-category'],
    fromKey: 'recurring.from.expense',
    toKey: 'recurring.to.expense',
  },
  income: {
    from: ['income-category'],
    to: ['daily-asset'],
    fromKey: 'recurring.from.income',
    toKey: 'recurring.to.income',
  },
  transfer: {
    from: ['daily-asset'],
    to: ['daily-asset', 'investment-asset'],
    fromKey: 'recurring.from.transfer',
    toKey: 'recurring.to.transfer',
  },
  // 簿記編集: ホームの簿記編集と同じく任意の科目ペアを直接指定する（内部集約・調整科目は除外）。
  manual: {
    from: [...RECURRING_POSTABLE_ROLES],
    to: [...RECURRING_POSTABLE_ROLES],
    fromKey: 'recurring.from.manual',
    toKey: 'recurring.to.manual',
  },
};

const RULE_KINDS: SheetKind[] = ['expense', 'income', 'transfer', 'manual'];

/**
 * 定期ルールの追加・編集シート。毎月の支払日に実仕訳が自動起票される
 * （登録直後に経過分も起票される。金額が違う月は起票された仕訳を編集）。
 */
function RecurringRuleSheet({
  existing,
  initialKind,
  onClose,
}: {
  existing?: RecurringRule;
  /** 統一追加フローからの種別プリセット。 */
  initialKind?: RecurringKind;
  onClose: () => void;
}) {
  const { ledger, createRecurringRule, saveRecurringRule } = useLedger();
  const accounts = sortAccounts(ledger?.accounts ?? []);
  const roleOf = (id: string) => accounts.find((a) => a.id === id)?.role;

  const [kind, setKind] = useState<SheetKind>(() => {
    if (!existing) return initialKind ?? 'expense';
    // 定型に当てはまらない既存ルール（簿記編集で作ったもの）は簿記編集モードで開く。
    return (
      recurringKindOf(roleOf(existing.debitAccountId), roleOf(existing.creditAccountId)) ?? 'manual'
    );
  });
  const optionsFor = (roles: readonly string[], includeId?: string) =>
    accounts
      .filter((a) => (roles.includes(a.role) && !a.archived) || a.id === includeId)
      .map((a) => ({ value: a.id, label: a.name }));
  const fromOptions = optionsFor(RULE_ROLES[kind].from, existing?.creditAccountId);
  const [creditAccountId, setCreditAccountId] = useState(
    existing?.creditAccountId ?? fromOptions[0]?.value ?? '',
  );
  // 行き先は源泉と同一科目を除く（振替の 預金→預金 を防ぐ）。
  const toOptions = optionsFor(RULE_ROLES[kind].to, existing?.debitAccountId).filter(
    (o) => o.value !== creditAccountId,
  );
  const [debitAccountId, setDebitAccountId] = useState(
    existing?.debitAccountId ?? toOptions[0]?.value ?? '',
  );

  const [name, setName] = useState(existing?.name ?? '');
  const [amountText, setAmountText] = useState(
    existing !== undefined ? String(existing.amount) : '',
  );
  const [firstPostingDate, setFirstPostingDate] = useState(() =>
    existing ? clampDayToMonth(existing.startMonth, existing.dayOfMonth) : todayLocal(),
  );
  const [error, setError] = useState<string | undefined>(undefined);
  const [submitting, setSubmitting] = useState(false);

  function switchKind(next: SheetKind) {
    setKind(next);
    const from = optionsFor(RULE_ROLES[next].from);
    const fromId = from[0]?.value ?? '';
    setCreditAccountId(fromId);
    const to = optionsFor(RULE_ROLES[next].to).filter((o) => o.value !== fromId);
    setDebitAccountId(to[0]?.value ?? '');
  }

  async function submit() {
    if (submitting) return;
    const amount = amountText === '' ? 0 : Number.parseInt(amountText, 10);
    if (!Number.isInteger(amount) || amount < 1) {
      setError(t('error.common.amountInvalid'));
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
    setSubmitting(true);
    setError(undefined);
    try {
      if (existing) {
        await saveRecurringRule({
          ...existing,
          name: name.trim(),
          amount,
          dayOfMonth,
          debitAccountId,
          creditAccountId,
          startMonth,
          updatedAt: nowIso(),
        });
      } else {
        await createRecurringRule({
          name: name.trim(),
          amount,
          dayOfMonth: day,
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
        <SelectInput
          label={t('recurring.kindLabel')}
          value={kind}
          onChange={(v) => switchKind(v as SheetKind)}
          options={RULE_KINDS.map((k) => ({
            value: k,
            label: t(`recurring.kind.${k}` as MessageKey),
          }))}
          dataUi={UI.allocations.recurringKind}
        />
        {kind === 'manual' ? <p className="field__hint">{t('recurring.manualHint')}</p> : null}
        <TextInput
          label={t('recurring.name')}
          required
          value={name}
          onChange={setName}
          hint={t('recurring.nameHint')}
          dataUi={UI.allocations.recurringName}
        />
        <SelectInput
          label={t(RULE_ROLES[kind].fromKey)}
          value={creditAccountId}
          onChange={(v) => {
            setCreditAccountId(v);
            if (v === debitAccountId) setDebitAccountId('');
          }}
          options={fromOptions}
          dataUi={UI.allocations.recurringFrom}
        />
        <SelectInput
          label={t(RULE_ROLES[kind].toKey)}
          value={debitAccountId}
          onChange={setDebitAccountId}
          options={toOptions}
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
 * 移行登録（初期残高）シート。すでに持っている継続コスト対象を「残存価値 + 残り月数」で
 * 登録する。残存価値は初期残高(equity)を貸方にした funding 仮想仕訳で計上され、
 * 収入・支出・資金移動にはならない（通常の勘定科目の初期残高と同じ会計意味）。
 */
function ContinuousCostMigrateSheet({ onClose }: { onClose: () => void }) {
  const { ledger, createContinuousCostOpening } = useLedger();
  const accounts = ledger?.accounts ?? [];

  const recognitionOptions = recognitionAccountOptions(accounts);

  const [name, setName] = useState('');
  const [amountText, setAmountText] = useState('');
  const [monthsText, setMonthsText] = useState('');
  const [startMonth, setStartMonth] = useState(() => {
    const { year, month } = currentYearMonth();
    return `${year}-${String(month).padStart(2, '0')}`;
  });
  // 認識先の既定値は「前回選んだもの」（連続登録の切り替え手間を減らす）。
  const [expenseAccountId, setExpenseAccountId] = useState(() => {
    const last = lastExpenseCategoryId();
    if (last && recognitionOptions.some((o) => o.value === last)) return last;
    return defaultRecognitionAccountId(accounts);
  });
  const [error, setError] = useState<string | undefined>(undefined);
  const [submitting, setSubmitting] = useState(false);

  async function submit() {
    if (submitting) return;
    const amount = amountText === '' ? 0 : Number.parseInt(amountText, 10);
    const costMonths = monthsText === '' ? 0 : Number.parseInt(monthsText, 10);
    if (!Number.isInteger(amount) || amount < 1) {
      setError(t('error.common.amountInvalid'));
      return;
    }
    if (!Number.isInteger(costMonths) || costMonths < 1) {
      setError(t('error.monthlyCost.monthsInvalid'));
      return;
    }
    setSubmitting(true);
    setError(undefined);
    try {
      await createContinuousCostOpening({
        name: name.trim(),
        amount,
        costMonths,
        startMonth: startMonth.trim(),
        expenseAccountId,
      });
      rememberExpenseCategoryId(expenseAccountId);
      onClose();
    } catch (e) {
      setError(errorText(e));
      setSubmitting(false);
    }
  }

  return (
    <Modal
      title={t('monthlyCost.migrateTitle')}
      onClose={onClose}
      dismissMode="if-clean"
      dataUi={UI.allocations.migrateSheet}
      footer={
        <>
          <button type="button" className="btn btn--ghost" onClick={onClose}>
            {t('common.cancel')}
          </button>
          <button
            type="button"
            className="btn btn--primary"
            onClick={submit}
            disabled={submitting || name.trim() === '' || amountText === '' || monthsText === ''}
            data-ui={UI.allocations.migrateSave}
          >
            {t('common.save')}
          </button>
        </>
      }
    >
      <div className="stack">
        <p className="field__hint">{t('monthlyCost.migrateIntro')}</p>
        {error ? (
          <div className="field__error" role="alert">
            <Icon name="alert" size={14} />
            {error}
          </div>
        ) : null}
        <TextInput
          label={t('monthlyCost.migrateName')}
          required
          value={name}
          onChange={setName}
          dataUi={UI.allocations.migrateName}
        />
        <TextInput
          label={t('monthlyCost.migrateAmount')}
          required
          inputMode="numeric"
          value={amountText}
          onChange={(v) => setAmountText(v.replace(/[^\d]/g, ''))}
          hint={t('monthlyCost.migrateAmountHint')}
          dataUi={UI.allocations.migrateAmount}
        />
        <TextInput
          label={t('monthlyCost.migrateMonths')}
          required
          inputMode="numeric"
          value={monthsText}
          onChange={(v) => setMonthsText(v.replace(/[^\d]/g, ''))}
          hint={t('monthlyCost.migrateMonthsHint')}
          dataUi={UI.allocations.migrateMonths}
        />
        <MonthField
          label={t('monthlyCost.migrateStartMonth')}
          required
          value={startMonth}
          onChange={setStartMonth}
        />
        <SelectInput
          label={t('monthlyCost.expenseCategory')}
          value={expenseAccountId}
          onChange={setExpenseAccountId}
          options={recognitionOptions}
        />
        <p className="field__hint">{t('monthlyCost.migrateRenewHint')}</p>
      </div>
    </Modal>
  );
}

function MonthlyCostDisposeSheet({
  item,
  onClose,
}: {
  item: MonthlyCostItem;
  onClose: () => void;
}) {
  const { ledger, disposeContinuousCost } = useLedger();
  const accounts = ledger?.accounts ?? [];
  const currency = ledger?.settings.currency ?? 'JPY';

  const [date, setDate] = useState(todayLocal());
  const [proceedsText, setProceedsText] = useState('0');
  const destinationOptions = accounts
    .filter((a) => (a.role === 'daily-asset' || a.role === 'reserve-asset') && !a.archived)
    .map((a) => ({ value: a.id, label: a.name }));
  const [destinationAccountId, setDestinationAccountId] = useState(
    destinationOptions[0]?.value ?? '',
  );
  const [error, setError] = useState<string | undefined>(undefined);
  const [submitting, setSubmitting] = useState(false);

  const proceeds = proceedsText === '' ? 0 : Number.parseInt(proceedsText, 10);
  const disposalMonth = /^\d{4}-\d{2}-\d{2}$/.test(date) ? monthOf(date) : item.startMonth;
  // 継続コスト（実績動的償却）: 実使用月数への遡及再配分プレビュー。
  const outcome = continuousCostDisposalOutcome(item, disposalMonth, proceeds);
  const endMonth = continuousCostDisposalEndMonth(item, disposalMonth);

  async function submit() {
    setSubmitting(true);
    setError(undefined);
    try {
      const input = {
        monthlyCostId: item.id,
        disposalDate: date,
        proceedsAmount: proceeds,
        ...(proceeds > 0 ? { destinationAccountId } : {}),
      };
      await disposeContinuousCost(input);
      onClose();
    } catch (e) {
      setError(errorText(e));
      setSubmitting(false);
    }
  }

  return (
    <Modal
      title={t('disposal.ccTitle')}
      onClose={onClose}
      dismissMode="if-clean"
      footer={
        <>
          <button type="button" className="btn btn--ghost" onClick={onClose}>
            {t('common.cancel')}
          </button>
          <button
            type="button"
            className="btn btn--primary"
            onClick={submit}
            disabled={submitting}
            data-ui={UI.allocations.disposeConfirm}
          >
            {t('disposal.confirm')}
          </button>
        </>
      }
    >
      <div className="stack" data-ui={UI.allocations.disposeDialog}>
        <p className="field__hint">{t('disposal.ccIntro')}</p>
        {error ? (
          <div className="field__error" role="alert">
            <Icon name="alert" size={14} />
            {error}
          </div>
        ) : null}
        <div className="list__title">{item.name}</div>
        <TextInput
          label={t('disposal.date')}
          type="date"
          required
          value={date}
          onChange={setDate}
          dataUi={UI.allocations.disposeDate}
        />
        <TextInput
          label={t('disposal.proceeds')}
          inputMode="numeric"
          value={proceedsText}
          onChange={(v) => setProceedsText(v.replace(/[^\d]/g, ''))}
          dataUi={UI.allocations.disposeProceeds}
        />
        {proceeds > 0 ? (
          <SelectInput
            label={t('disposal.destination')}
            value={destinationAccountId}
            onChange={setDestinationAccountId}
            options={destinationOptions}
            dataUi={UI.allocations.disposeDestination}
          />
        ) : null}

        {/* 実績動的償却: 損益の一括計上ではなく、実使用月数へ遡って月額が再計算される。 */}
        <div className="kv">
          <span className="muted">{t('disposal.usedMonths')}</span>
          <span>{t('monthlyCost.monthsUnit', { count: outcome.usedMonths })}</span>
        </div>
        <div className="kv">
          <span className="muted">{t('disposal.monthlyAfter')}</span>
          <span>
            <Money amount={outcome.monthlyAfter} currency={currency} />
          </span>
        </div>
        {outcome.gain > 0 ? (
          <div className="kv">
            <span className="muted">{t('disposal.gain')}</span>
            <span>
              <Money amount={outcome.gain} currency={currency} />
            </span>
          </div>
        ) : null}
        <p className="field__hint">{t('disposal.retroNote')}</p>
        <div className="kv">
          <span className="muted">{t('disposal.endsAt')}</span>
          <span>{endMonth}</span>
        </div>
      </div>
    </Modal>
  );
}

function MonthlyCostEditSheet({
  item,
  disposed,
  onClose,
}: {
  item: MonthlyCostItem;
  disposed: boolean;
  onClose: () => void;
}) {
  const { ledger, saveMonthlyCost } = useLedger();
  const accounts = ledger?.accounts ?? [];
  const currency = ledger?.settings.currency ?? 'JPY';
  const accountName = (id?: string) =>
    id ? (accounts.find((a) => a.id === id)?.name ?? '—') : '—';

  const hasPosted = (ledger?.cashflowSchedules ?? []).some(
    (s) => s.monthlyCostId === item.id && s.status === 'posted',
  );
  const amountEditable = !disposed && !hasPosted;
  // 移行登録（初期残高 funding）の項目は継続購入を設定できない（更新のたびに初期残高から
  // 資金が湧いてしまう）。毎月払いは定期ルールで扱う。
  const openingFunded =
    item.paymentSourceAccountId !== undefined &&
    accounts.find((a) => a.id === item.paymentSourceAccountId)?.role === 'equity';

  const [name, setName] = useState(item.name);
  const [amountText, setAmountText] = useState(String(item.amount));
  const [costMonthsText, setCostMonthsText] = useState(String(item.costMonths));
  const [repeatText, setRepeatText] = useState(
    item.repeatEveryMonths !== undefined ? String(item.repeatEveryMonths) : '',
  );
  const [startMonth, setStartMonth] = useState(item.startMonth);
  const [endMonth, setEndMonth] = useState(item.endMonth ?? '');
  const [expenseAccountId, setExpenseAccountId] = useState(item.expenseAccountId);
  const [status, setStatus] = useState<MonthlyCostStatus>(item.status);
  const [error, setError] = useState<string | undefined>(undefined);
  const [submitting, setSubmitting] = useState(false);

  const recognitionOptions = recognitionAccountOptions(accounts, item.expenseAccountId);

  const pastFieldsChanged =
    !disposed &&
    ((amountEditable && amountText !== String(item.amount)) ||
      costMonthsText !== String(item.costMonths) ||
      repeatText !== (item.repeatEveryMonths !== undefined ? String(item.repeatEveryMonths) : '') ||
      startMonth.trim() !== item.startMonth ||
      endMonth.trim() !== (item.endMonth ?? '') ||
      expenseAccountId !== item.expenseAccountId);

  async function submit() {
    if (!disposed) {
      const nextAmount =
        amountEditable && amountText !== '' ? Number.parseInt(amountText, 10) : item.amount;
      const nextCostMonths =
        costMonthsText === '' ? Number.NaN : Number.parseInt(costMonthsText, 10);
      const nextRepeat = repeatText.trim() === '' ? undefined : Number.parseInt(repeatText, 10);
      if (!Number.isInteger(nextAmount) || nextAmount < 1) {
        setError(t('error.common.amountInvalid'));
        return;
      }
      if (!Number.isInteger(nextCostMonths) || nextCostMonths < 1) {
        setError(t('error.monthlyCost.monthsInvalid'));
        return;
      }
      if (
        nextRepeat !== undefined &&
        (!Number.isInteger(nextRepeat) || nextRepeat < nextCostMonths)
      ) {
        setError(t('error.monthlyCost.repeatInvalid'));
        return;
      }
    }
    setSubmitting(true);
    setError(undefined);
    const next: MonthlyCostItem = disposed
      ? { ...item, name: name.trim(), updatedAt: nowIso() }
      : {
          ...item,
          name: name.trim(),
          amount:
            amountEditable && amountText !== '' ? Number.parseInt(amountText, 10) : item.amount,
          costMonths: costMonthsText === '' ? item.costMonths : Number.parseInt(costMonthsText, 10),
          startMonth: startMonth.trim(),
          expenseAccountId,
          status,
          updatedAt: nowIso(),
        };
    if (!disposed) {
      if (repeatText.trim() === '') delete next.repeatEveryMonths;
      else next.repeatEveryMonths = Number.parseInt(repeatText, 10);
      if (endMonth.trim() === '') delete next.endMonth;
      else next.endMonth = endMonth.trim();
    }
    try {
      await saveMonthlyCost(next);
      onClose();
    } catch (e) {
      setError(errorText(e));
      setSubmitting(false);
    }
  }

  return (
    <Modal
      title={t('monthlyCost.editTitle')}
      onClose={onClose}
      dismissMode="if-clean"
      footer={
        <>
          <button type="button" className="btn btn--ghost" onClick={onClose}>
            {t('common.cancel')}
          </button>
          <button
            type="button"
            className="btn btn--primary"
            onClick={submit}
            disabled={submitting}
            data-ui={UI.allocations.editSave}
          >
            {t('common.save')}
          </button>
        </>
      }
    >
      <div className="stack" data-ui={UI.allocations.editDialog}>
        {error ? (
          <div className="field__error" role="alert">
            <Icon name="alert" size={14} />
            {error}
          </div>
        ) : null}
        {disposed ? (
          <div className="field__hint" role="status">
            {t('error.monthlyCost.disposedLocked')}
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
        {disposed ? (
          <>
            <div className="kv" data-ui={UI.allocations.editAmount}>
              <span className="muted">{t('monthlyCost.amount')}</span>
              <span>
                <Money amount={item.amount} currency={currency} />
              </span>
            </div>
            <div className="kv" data-ui={UI.allocations.editCostMonths}>
              <span className="muted">{t('monthlyCost.costMonths')}</span>
              <span>{t('monthlyCost.monthsUnit', { count: item.costMonths })}</span>
            </div>
            <div className="kv" data-ui={UI.allocations.editRepeat}>
              <span className="muted">{t('monthlyCost.repeatField')}</span>
              <span>
                {item.repeatEveryMonths === undefined
                  ? '—'
                  : t('monthlyCost.repeatUnit', { count: item.repeatEveryMonths })}
              </span>
            </div>
            <div className="kv" data-ui={UI.allocations.editStartMonth}>
              <span className="muted">{t('monthlyCost.startMonth')}</span>
              <span>{item.startMonth}</span>
            </div>
            <div className="kv" data-ui={UI.allocations.editEndMonth}>
              <span className="muted">{t('monthlyCost.endMonth')}</span>
              <span>{item.endMonth ?? '—'}</span>
            </div>
            <div className="kv" data-ui={UI.allocations.editExpense}>
              <span className="muted">{t('monthlyCost.expenseCategory')}</span>
              <span>{accountName(item.expenseAccountId)}</span>
            </div>
            <div className="kv" data-ui={UI.allocations.editStatus}>
              <span className="muted">{t('monthlyCost.statusLabel')}</span>
              <span>{t(`monthlyCost.status.${item.status}` as MessageKey)}</span>
            </div>
          </>
        ) : (
          <>
            <TextInput
              label={t('monthlyCost.amount')}
              required
              inputMode="numeric"
              value={amountText}
              onChange={(v) => {
                if (amountEditable) setAmountText(v.replace(/[^\d]/g, ''));
              }}
              hint={amountEditable ? undefined : t('monthlyCost.amountLockedPosted')}
              dataUi={UI.allocations.editAmount}
            />
            <TextInput
              label={t('monthlyCost.costMonths')}
              required
              inputMode="numeric"
              value={costMonthsText}
              onChange={(v) => setCostMonthsText(v.replace(/[^\d]/g, ''))}
              dataUi={UI.allocations.editCostMonths}
            />
            {openingFunded ? (
              <p className="field__hint">{t('monthlyCost.repeatLockedOpening')}</p>
            ) : (
              <TextInput
                label={t('monthlyCost.repeatField')}
                inputMode="numeric"
                value={repeatText}
                hint={t('monthlyCost.repeatFieldHint')}
                onChange={(v) => setRepeatText(v.replace(/[^\d]/g, ''))}
                dataUi={UI.allocations.editRepeat}
              />
            )}
            <MonthField
              label={t('monthlyCost.startMonth')}
              required
              value={startMonth}
              onChange={setStartMonth}
              dataUi={UI.allocations.editStartMonth}
            />
            <MonthField
              label={t('monthlyCost.endMonth')}
              value={endMonth}
              hint={t('monthlyCost.endMonthHint')}
              onChange={setEndMonth}
              dataUi={UI.allocations.editEndMonth}
              clearLabel={t('common.clear')}
            />
            <SelectInput
              label={t('monthlyCost.expenseCategory')}
              value={expenseAccountId}
              onChange={setExpenseAccountId}
              options={recognitionOptions}
              dataUi={UI.allocations.editExpense}
            />
            <SelectInput
              label={t('monthlyCost.statusLabel')}
              value={status}
              onChange={(v) => setStatus(v as MonthlyCostStatus)}
              options={STATUSES.map((s) => ({
                value: s,
                label: t(`monthlyCost.status.${s}` as MessageKey),
              }))}
              dataUi={UI.allocations.editStatus}
            />
          </>
        )}
        <div className="kv">
          <span className="muted">{t('monthlyCost.payment')}</span>
          <span>{accountName(item.paymentSourceAccountId ?? item.paymentAccountId)}</span>
        </div>
        <p className="field__hint">{t('monthlyCost.paymentLocked')}</p>
      </div>
    </Modal>
  );
}
