/*
 * 継続コスト。サブスク・年払い・耐久財・定期イベントを統一して「月あたりコスト」で見る。
 */
import { useMemo, useState } from 'react';
import { Modal } from '@snishi/foundation/ui/Modal';
import { SelectInput, TextInput } from '@snishi/foundation/ui/Field';
import { Icon } from '@snishi/foundation/ui/Icon';
import { ConfirmDialog } from '@snishi/foundation/ui/ConfirmDialog';
import { useLedger } from '../../state/store';
import { monthlyCostForMonth, representativeMonthlyAmount } from '../../domain/monthlyCost';
import { disposalOutcome } from '../../domain/assetDisposal';
import {
  continuousCostDisposalEndMonth,
  continuousCostDisposalOutcome,
  isContinuingCostItem,
} from '../../domain/continuousCost';
import { addMonths, monthOf } from '../../domain/allocation';
import { currentYearMonth, nowIso, todayLocal } from '../../util/time';
import { Money } from '../money';
import { errorText, t } from '../../i18n';
import type { MessageKey } from '../../i18n';
import { UI } from '../../ui-contract';
import type { MonthlyCostItem, MonthlyCostKind, MonthlyCostStatus } from '../../domain/types';

const KINDS: MonthlyCostKind[] = [
  'subscription',
  'prepaid-service',
  'durable-asset',
  'recurring-event',
];
const STATUSES: MonthlyCostStatus[] = ['active', 'paused', 'ended'];

function kindLabel(kind: MonthlyCostKind): string {
  return t(`monthlyCost.kind.${kind}` as MessageKey);
}

export function Allocations() {
  const { ledger, saveMonthlyCost, removeMonthlyCost } = useLedger();
  const [showInactive, setShowInactive] = useState(false);
  const [pendingDelete, setPendingDelete] = useState<MonthlyCostItem | null>(null);
  const [editing, setEditing] = useState<MonthlyCostItem | null>(null);
  const [disposing, setDisposing] = useState<MonthlyCostItem | null>(null);
  const { year, month } = currentYearMonth();
  const currentYm = `${year}-${String(month).padStart(2, '0')}`;
  const currency = ledger?.settings.currency ?? 'JPY';

  const accountsMap = useMemo(
    () => new Map((ledger?.accounts ?? []).map((a) => [a.id, a] as const)),
    [ledger],
  );
  const name = (id?: string): string => (id ? (accountsMap.get(id)?.name ?? '—') : '—');

  const items = useMemo(
    () => (ledger?.monthlyCostItems ?? []).filter((m) => showInactive || m.status === 'active'),
    [ledger, showInactive],
  );

  async function togglePause(item: MonthlyCostItem) {
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

  const isFixedAssetItem = (m: MonthlyCostItem): boolean =>
    m.sourceEntryId !== undefined &&
    m.recognitionCreditAccountId !== undefined &&
    accountsMap.get(m.recognitionCreditAccountId)?.role === 'fixed-asset';
  // 資産経由モデルの継続コスト対象。サブスク解約・返金なし終了も「0円で売却」で同じ導線から終了する。
  const isContinuingItem = (m: MonthlyCostItem): boolean => isContinuingCostItem(m, accountsMap);
  const canDispose = (m: MonthlyCostItem): boolean =>
    m.status !== 'ended' && (isFixedAssetItem(m) || isContinuingItem(m));

  return (
    <section aria-labelledby="allocations-title" data-ui={UI.allocations.view}>
      <h1 className="screen-title" id="allocations-title">
        {t('monthlyCost.title')}
      </h1>

      <p className="field__hint" style={{ marginBottom: 'var(--space-3)' }}>
        {t('monthlyCost.intro')}
      </p>

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

      {items.length === 0 ? (
        <div className="card card--pad empty">
          <Icon name="calendar" size={28} />
          <p style={{ marginTop: 'var(--space-3)' }}>{t('monthlyCost.empty')}</p>
        </div>
      ) : (
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
                    <button
                      type="button"
                      className="icon-btn"
                      onClick={() => togglePause(m)}
                      aria-label={`${m.status === 'active' ? t('monthlyCost.pause') : t('monthlyCost.resume')}: ${m.name}`}
                    >
                      <Icon name={m.status === 'active' ? 'archive' : 'restore'} size={18} />
                    </button>
                    {isFixedAssetItem(m) ? null : (
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
                  <span className="muted">{t('monthlyCost.kindLabel')}</span>
                  <span>{kindLabel(m.kind)}</span>
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
                    <Money amount={representativeMonthlyAmount(m)} currency={currency} />
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

      {editing ? <MonthlyCostEditSheet item={editing} onClose={() => setEditing(null)} /> : null}

      {disposing ? (
        <MonthlyCostDisposeSheet
          item={disposing}
          continuous={isContinuingItem(disposing)}
          onClose={() => setDisposing(null)}
        />
      ) : null}
    </section>
  );
}

function MonthlyCostDisposeSheet({
  item,
  continuous,
  onClose,
}: {
  item: MonthlyCostItem;
  /** 資産経由モデルの継続コスト対象（サブスク等）。false なら固定資産由来。 */
  continuous: boolean;
  onClose: () => void;
}) {
  const { ledger, disposeFixedAsset, disposeContinuousCost } = useLedger();
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
  const accountsById = useMemo(
    () => new Map((ledger?.accounts ?? []).map((a) => [a.id, a] as const)),
    [ledger],
  );
  const outcome = continuous
    ? continuousCostDisposalOutcome(item, accountsById, disposalMonth, proceeds)
    : disposalOutcome(item, disposalMonth, proceeds);
  const endMonth = continuous
    ? continuousCostDisposalEndMonth(item, disposalMonth)
    : addMonths(disposalMonth, -1);

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
      if (continuous) await disposeContinuousCost(input);
      else await disposeFixedAsset(input);
      onClose();
    } catch (e) {
      setError(errorText(e));
      setSubmitting(false);
    }
  }

  return (
    <Modal
      title={continuous ? t('disposal.ccTitle') : t('disposal.title')}
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
        <p className="field__hint">{continuous ? t('disposal.ccIntro') : t('disposal.intro')}</p>
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

        <div className="kv">
          <span className="muted">{t('disposal.recognized')}</span>
          <span>
            <Money amount={outcome.recognizedAmount} currency={currency} />
          </span>
        </div>
        <div className="kv">
          <span className="muted">{t('disposal.remaining')}</span>
          <span>
            <Money amount={outcome.remainingAmount} currency={currency} />
          </span>
        </div>
        <div className="kv">
          <span className="muted">{t('disposal.gain')}</span>
          <span>
            {outcome.gain > 0 ? (
              <Money amount={outcome.gain} currency={currency} />
            ) : (
              t('disposal.none')
            )}
          </span>
        </div>
        <div className="kv">
          <span className="muted">{t('disposal.loss')}</span>
          <span>
            {outcome.loss > 0 ? (
              <Money amount={outcome.loss} currency={currency} />
            ) : (
              t('disposal.none')
            )}
          </span>
        </div>
        <div className="kv">
          <span className="muted">{t('disposal.endsAt')}</span>
          <span>{endMonth}</span>
        </div>
      </div>
    </Modal>
  );
}

function MonthlyCostEditSheet({ item, onClose }: { item: MonthlyCostItem; onClose: () => void }) {
  const { ledger, saveMonthlyCost } = useLedger();
  const accounts = ledger?.accounts ?? [];
  const accountName = (id?: string) =>
    id ? (accounts.find((a) => a.id === id)?.name ?? '—') : '—';

  const linked = item.sourceEntryId !== undefined || item.sourceAllocationId !== undefined;
  const hasPosted = (ledger?.cashflowSchedules ?? []).some(
    (s) => s.monthlyCostId === item.id && s.status === 'posted',
  );
  const amountEditable = !linked && !hasPosted;

  const [name, setName] = useState(item.name);
  const [kind, setKind] = useState<MonthlyCostKind>(item.kind);
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

  const expenseOptions = accounts
    .filter((a) => a.role === 'expense-category' && (!a.archived || a.id === item.expenseAccountId))
    .map((a) => ({ value: a.id, label: a.name }));

  const pastFieldsChanged =
    (amountEditable && amountText !== String(item.amount)) ||
    costMonthsText !== String(item.costMonths) ||
    repeatText !== (item.repeatEveryMonths !== undefined ? String(item.repeatEveryMonths) : '') ||
    startMonth.trim() !== item.startMonth ||
    endMonth.trim() !== (item.endMonth ?? '') ||
    expenseAccountId !== item.expenseAccountId;

  async function submit() {
    setSubmitting(true);
    setError(undefined);
    const next: MonthlyCostItem = {
      ...item,
      name: name.trim(),
      kind,
      amount: amountEditable && amountText !== '' ? Number.parseInt(amountText, 10) : item.amount,
      costMonths: costMonthsText === '' ? item.costMonths : Number.parseInt(costMonthsText, 10),
      startMonth: startMonth.trim(),
      expenseAccountId,
      status,
      updatedAt: nowIso(),
    };
    if (repeatText.trim() === '') delete next.repeatEveryMonths;
    else next.repeatEveryMonths = Number.parseInt(repeatText, 10);
    if (endMonth.trim() === '') delete next.endMonth;
    else next.endMonth = endMonth.trim();
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
        <SelectInput
          label={t('monthlyCost.kindLabel')}
          value={kind}
          onChange={(v) => setKind(v as MonthlyCostKind)}
          options={KINDS.map((k) => ({ value: k, label: kindLabel(k) }))}
          dataUi={UI.allocations.editKind}
        />
        <TextInput
          label={t('monthlyCost.amount')}
          required
          inputMode="numeric"
          value={amountText}
          onChange={(v) => {
            if (amountEditable) setAmountText(v.replace(/[^\d]/g, ''));
          }}
          hint={
            amountEditable
              ? undefined
              : linked
                ? t('monthlyCost.amountLockedFixed')
                : t('monthlyCost.amountLockedPosted')
          }
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
        <TextInput
          label={t('monthlyCost.repeatField')}
          inputMode="numeric"
          value={repeatText}
          hint={t('monthlyCost.repeatFieldHint')}
          onChange={(v) => setRepeatText(v.replace(/[^\d]/g, ''))}
          dataUi={UI.allocations.editRepeat}
        />
        <TextInput
          label={t('monthlyCost.startMonth')}
          required
          value={startMonth}
          placeholder="YYYY-MM"
          onChange={setStartMonth}
          dataUi={UI.allocations.editStartMonth}
        />
        <TextInput
          label={t('monthlyCost.endMonth')}
          value={endMonth}
          placeholder="YYYY-MM"
          hint={t('monthlyCost.endMonthHint')}
          onChange={setEndMonth}
          dataUi={UI.allocations.editEndMonth}
        />
        <SelectInput
          label={t('monthlyCost.expenseCategory')}
          value={expenseAccountId}
          onChange={setExpenseAccountId}
          options={expenseOptions}
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
        <div className="kv">
          <span className="muted">{t('monthlyCost.payment')}</span>
          <span>{accountName(item.paymentSourceAccountId ?? item.paymentAccountId)}</span>
        </div>
        <p className="field__hint">{t('monthlyCost.paymentLocked')}</p>
      </div>
    </Modal>
  );
}
