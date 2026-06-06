/*
 * 資金繰り（将来CF）。planned な予定から自由資金の推移・最低残高を投影し、
 * 予定の追加・実績化・削除、目的別資金（取り置き枠）の管理を行う。
 * 「いつ費用認識するか(按分)」とは別概念で、「いつ現金が動くか」を扱う。
 */
import { useMemo, useState } from 'react';
import { useLedger } from '../../state/store';
import { deriveBalanceSheet } from '../../domain/accounting';
import { liquidAssetTotal, projectCashflow } from '../../domain/cashflow';
import { addMonths, monthOf, monthlyAmounts } from '../../domain/allocation';
import { goalRequiredMonthly } from '../../domain/fundingGoal';
import { newId } from '../../domain/ids';
import { currentYearMonth, nowIso, todayLocal } from '../../util/time';
import type {
  Account,
  CashflowDirection,
  CashflowSchedule,
  CashflowSource,
  FundingGoal,
  ReserveItem,
  Tag,
} from '../../domain/types';
import type { FundingGoalInput } from '../../data/repository';
import { Modal } from '../Modal';
import { AccountPicker } from '../AccountPicker';
import { TagPicker } from '../TagPicker';
import { SelectInput, TextArea, TextInput } from '../Field';
import { groupedAccounts, groupedAccountsByRole } from '../accountOptions';
import { tagsForScope } from '../tagOptions';
import { ConfirmDialog } from '../ConfirmDialog';
import { Money } from '../money';
import { Icon } from '../Icon';
import { t } from '../../i18n';
import { UI } from '../../ui-contract';

const HORIZONS = [3, 6, 12];

export function Cashflow() {
  const {
    ledger,
    saveSchedules,
    postSchedule,
    removeSchedule,
    createReserve,
    removeReserve,
    createFundingGoal,
    removeFundingGoal,
  } = useLedger();
  const [horizon, setHorizon] = useState(6);
  const [scheduleOpen, setScheduleOpen] = useState(false);
  const [reserveOpen, setReserveOpen] = useState(false);
  const [goalOpen, setGoalOpen] = useState(false);
  const [pendingSchedule, setPendingSchedule] = useState<CashflowSchedule | null>(null);
  const [pendingReserve, setPendingReserve] = useState<ReserveItem | null>(null);
  const [pendingGoal, setPendingGoal] = useState<FundingGoal | null>(null);

  const { year, month } = currentYearMonth();
  const currentYm = `${year}-${String(month).padStart(2, '0')}`;
  const returnBps = ledger?.settings.expectedAnnualReturnBps ?? 0;
  const goals = ledger?.fundingGoals ?? [];

  const currency = ledger?.settings.currency ?? 'JPY';
  const today = todayLocal();

  const { projection, balById } = useMemo(() => {
    const accounts = ledger?.accounts ?? [];
    const entries = ledger?.journalEntries ?? [];
    const reserves = ledger?.reserves ?? [];
    const schedules = ledger?.cashflowSchedules ?? [];
    const allocations = ledger?.allocations ?? [];
    const bs = deriveBalanceSheet(accounts, entries, today);
    const byId = new Map(bs.assets.map((a) => [a.account.id, a.balance] as const));
    // 按分中資産（現金ではない繰延資産）は総資金から除外する。
    const excluded = new Set(allocations.map((a) => a.deferredAccountId));
    const totalAssets = liquidAssetTotal(bs.assets, excluded);
    const reserveBalance = reserves.reduce((s, r) => s + (byId.get(r.reserveAccountId) ?? 0), 0);
    return {
      balById: byId,
      projection: projectCashflow({
        totalAssets,
        reserveBalance,
        schedules,
        today,
        months: horizon,
      }),
    };
  }, [ledger, horizon, today]);

  const accountName = (id: string): string =>
    (ledger?.accounts ?? []).find((a) => a.id === id)?.name ?? '—';
  const reserves = ledger?.reserves ?? [];
  const maxFree = Math.max(1, ...projection.points.map((p) => Math.abs(p.free)));

  // 負債・分割払いの集約: 支払用負債ごとに、相手とする未実績の outflow 予定から
  // 次回支払日・残額・件数を見せる（既存 CashflowSchedule と負債科目から導出）。
  const liabilitySummary = useMemo(() => {
    const accounts = ledger?.accounts ?? [];
    const schedules = ledger?.cashflowSchedules ?? [];
    return accounts
      .filter((a) => a.role === 'payment-liability')
      .map((a) => {
        const related = schedules.filter(
          (s) => s.counterAccountId === a.id && s.status === 'planned',
        );
        const remaining = related.reduce((sum, s) => sum + s.amount, 0);
        const nextDue = related.map((s) => s.dueDate).sort()[0];
        return { id: a.id, name: a.name, count: related.length, remaining, nextDue };
      })
      .filter((x) => x.count > 0);
  }, [ledger]);

  return (
    <section aria-labelledby="cashflow-title" data-ui={UI.cashflow.view}>
      <h1 className="screen-title" id="cashflow-title">
        {t('cashflow.title')}
      </h1>
      <p className="field__hint" style={{ marginBottom: 'var(--space-3)' }}>
        {t('cashflow.intro')}
      </p>

      <div
        className="segmented"
        role="tablist"
        aria-label={t('cashflow.horizon')}
        style={{ marginBottom: 'var(--space-4)' }}
      >
        {HORIZONS.map((h) => (
          <button
            key={h}
            type="button"
            role="tab"
            aria-selected={horizon === h}
            className="segmented__btn"
            onClick={() => setHorizon(h)}
          >
            {t('cashflow.months', { count: h })}
          </button>
        ))}
      </div>

      <div className="stat-grid" data-ui={UI.cashflow.summary}>
        <div className="stat">
          <span className="stat__label">{t('cashflow.totalFunds')}</span>
          <span className="stat__value">
            <Money amount={projection.startTotal} currency={currency} />
          </span>
        </div>
        <div className="stat">
          <span className="stat__label">{t('cashflow.reserved')}</span>
          <span className="stat__value">
            <Money amount={projection.reserveBalance} currency={currency} />
          </span>
        </div>
        <div className="stat">
          <span className="stat__label">{t('cashflow.freeFunds')}</span>
          <span className="stat__value">
            <Money amount={projection.startFree} currency={currency} signed />
          </span>
        </div>
      </div>

      <p className="field__hint" style={{ marginTop: 'var(--space-2)' }}>
        {t('cashflow.liquidNote')}
      </p>

      <div className="card card--pad" style={{ marginTop: 'var(--space-3)' }}>
        <div className="kv">
          <span className="muted">{t('cashflow.minFree')}</span>
          <span>
            <Money amount={projection.minFree} currency={currency} signed />
          </span>
        </div>
      </div>

      {projection.minFree < 0 ? (
        <div className="banner" role="alert" style={{ marginTop: 'var(--space-3)' }}>
          <Icon name="alert" size={18} />
          {t('cashflow.depleteWarning')}
        </div>
      ) : null}

      {/* 残高推移（軽量・自由資金のバー） */}
      {projection.points.length > 1 ? (
        <ul className="card list" style={{ marginTop: 'var(--space-3)' }} aria-hidden="true">
          {projection.points.map((p, i) => (
            <li key={`${p.date}-${i}`} className="list__item">
              <span className="list__sub" style={{ width: 90, flex: 'none' }}>
                {i === 0 ? today : p.date}
              </span>
              <span
                style={{
                  flex: 1,
                  height: 10,
                  borderRadius: 999,
                  background: 'var(--bg)',
                  overflow: 'hidden',
                }}
              >
                <span
                  style={{
                    display: 'block',
                    height: '100%',
                    width: `${Math.max(2, (Math.max(0, p.free) / maxFree) * 100)}%`,
                    background: p.free < 0 ? 'var(--neg)' : 'var(--primary)',
                  }}
                />
              </span>
              <span className="list__amount">
                <Money amount={p.free} currency={currency} signed />
              </span>
            </li>
          ))}
        </ul>
      ) : null}

      {/* 入出金予定 */}
      <div
        className="section-label"
        style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}
      >
        <span>{t('cashflow.planned')}</span>
        <button
          type="button"
          className="btn btn--primary"
          style={{ minHeight: 36 }}
          onClick={() => setScheduleOpen(true)}
          data-ui={UI.cashflow.addSchedule}
        >
          <Icon name="plus" size={16} />
          {t('cashflow.addSchedule')}
        </button>
      </div>

      {projection.schedules.length === 0 ? (
        <div className="card card--pad empty">{t('cashflow.emptyPlanned')}</div>
      ) : (
        <ul className="card list" data-ui={UI.cashflow.list}>
          {projection.schedules.map((s) => (
            <li key={s.id} className="list__item">
              <div className="list__main">
                <div className="list__title">{s.title}</div>
                <div className="list__sub">
                  {s.dueDate}・{accountName(s.accountId)}
                  {s.counterAccountId ? ` ↔ ${accountName(s.counterAccountId)}` : ''}
                </div>
              </div>
              <span className={`list__amount amount--${s.direction === 'inflow' ? 'pos' : 'neg'}`}>
                {s.direction === 'inflow' ? '+' : '−'}
                <Money amount={s.amount} currency={currency} />
              </span>
              <button
                type="button"
                className="btn btn--ghost"
                style={{ minHeight: 36 }}
                disabled={!s.counterAccountId}
                title={s.counterAccountId ? undefined : t('cashflow.postNeedsCounter')}
                onClick={() => postSchedule(s.id).catch(() => undefined)}
                data-ui={UI.cashflow.schedulePost}
              >
                <Icon name="check" size={16} />
                {t('cashflow.post')}
              </button>
              <button
                type="button"
                className="icon-btn"
                onClick={() => setPendingSchedule(s)}
                aria-label={`${t('cashflow.deleteSchedule')}: ${s.title}`}
              >
                <Icon name="trash" size={18} />
              </button>
            </li>
          ))}
        </ul>
      )}

      {/* 目的別資金 */}
      <div
        className="section-label"
        style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}
      >
        <span>{t('reserves.title')}</span>
        <button
          type="button"
          className="btn"
          style={{ minHeight: 36 }}
          onClick={() => setReserveOpen(true)}
          data-ui={UI.cashflow.addReserve}
        >
          <Icon name="plus" size={16} />
          {t('reserves.add')}
        </button>
      </div>
      <p className="field__hint" style={{ marginBottom: 'var(--space-2)' }}>
        {t('reserves.intro')}
      </p>

      {reserves.length === 0 ? (
        <div className="card card--pad empty">{t('reserves.empty')}</div>
      ) : (
        <ul className="card list" data-ui={UI.cashflow.reserveList}>
          {reserves.map((r) => (
            <li key={r.id} className="list__item">
              <div className="list__main">
                <div className="list__title">{r.name}</div>
                <div className="list__sub">
                  {t('reserves.balance')}:{' '}
                  <Money amount={balById.get(r.reserveAccountId) ?? 0} currency={currency} />
                  {r.targetAmount !== undefined
                    ? `（${t('reserves.targetOf', { target: r.targetAmount.toLocaleString('ja-JP') })}）`
                    : ''}
                </div>
              </div>
              <button
                type="button"
                className="icon-btn"
                onClick={() => setPendingReserve(r)}
                aria-label={`${t('reserves.delete')}: ${r.name}`}
              >
                <Icon name="trash" size={18} />
              </button>
            </li>
          ))}
        </ul>
      )}

      {/* 負債・分割払い（支払用負債ごとの集約） */}
      {liabilitySummary.length > 0 ? (
        <>
          <p className="section-label">{t('cashflow.liabilitiesTitle')}</p>
          <ul className="card list" data-ui={UI.cashflow.liabilityList}>
            {liabilitySummary.map((l) => (
              <li key={l.id} className="list__item">
                <div className="list__main">
                  <div className="list__title">{l.name}</div>
                  <div className="list__sub">
                    {t('cashflow.nextDue')}: {l.nextDue ?? '—'}・
                    {t('cashflow.installmentsLeft', { count: l.count })}
                  </div>
                </div>
                <span className="list__amount">
                  <Money amount={l.remaining} currency={currency} />
                </span>
              </li>
            ))}
          </ul>
        </>
      ) : null}

      {/* 資金目標（長期の積立計画） */}
      <div
        className="section-label"
        style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}
      >
        <span>{t('fundingGoal.title')}</span>
        <button
          type="button"
          className="btn"
          style={{ minHeight: 36 }}
          onClick={() => setGoalOpen(true)}
          data-ui={UI.cashflow.addGoal}
        >
          <Icon name="plus" size={16} />
          {t('fundingGoal.add')}
        </button>
      </div>
      <p className="field__hint" style={{ marginBottom: 'var(--space-2)' }}>
        {t('fundingGoal.intro')}
      </p>

      {goals.length === 0 ? (
        <div className="card card--pad empty">{t('fundingGoal.empty')}</div>
      ) : (
        <ul className="card list" data-ui={UI.cashflow.goalList}>
          {goals.map((g) => (
            <li key={g.id} className="list__item">
              <div className="list__main">
                <div className="list__title">{g.name}</div>
                <div className="list__sub">
                  {g.targetDate}・{t('fundingGoal.target')}{' '}
                  <Money amount={g.targetAmount} currency={currency} />
                  {g.currentAmount > 0 ? (
                    <>
                      {' '}
                      / {t('fundingGoal.current')}{' '}
                      <Money amount={g.currentAmount} currency={currency} />
                    </>
                  ) : null}
                </div>
                <div className="list__sub">
                  {t('fundingGoal.requiredMonthly')}:{' '}
                  <Money
                    amount={goalRequiredMonthly(g, currentYm, returnBps)}
                    currency={currency}
                  />
                </div>
              </div>
              <button
                type="button"
                className="icon-btn"
                onClick={() => setPendingGoal(g)}
                aria-label={`${t('common.delete')}: ${g.name}`}
              >
                <Icon name="trash" size={18} />
              </button>
            </li>
          ))}
        </ul>
      )}

      {scheduleOpen ? (
        <ScheduleSheet
          accounts={ledger?.accounts ?? []}
          tags={ledger?.tags ?? []}
          onClose={() => setScheduleOpen(false)}
          onSave={async (list) => {
            await saveSchedules(list).catch(() => undefined);
            setScheduleOpen(false);
          }}
        />
      ) : null}

      {goalOpen ? (
        <FundingGoalSheet
          accounts={ledger?.accounts ?? []}
          onClose={() => setGoalOpen(false)}
          onSave={async (input) => {
            await createFundingGoal(input).catch(() => undefined);
            setGoalOpen(false);
          }}
        />
      ) : null}

      {pendingGoal ? (
        <ConfirmDialog
          title={t('fundingGoal.deleteConfirmTitle')}
          body={t('fundingGoal.deleteConfirmBody', { name: pendingGoal.name })}
          confirmLabel={t('common.delete')}
          danger
          onCancel={() => setPendingGoal(null)}
          onConfirm={async () => {
            const g = pendingGoal;
            setPendingGoal(null);
            await removeFundingGoal(g.id).catch(() => undefined);
          }}
        />
      ) : null}

      {reserveOpen ? (
        <ReserveSheet
          onClose={() => setReserveOpen(false)}
          onSave={async (input) => {
            await createReserve(input).catch(() => undefined);
            setReserveOpen(false);
          }}
        />
      ) : null}

      {pendingSchedule ? (
        <ConfirmDialog
          title={t('cashflow.deleteSchedule')}
          body={pendingSchedule.title}
          confirmLabel={t('common.delete')}
          danger
          dismissable
          onCancel={() => setPendingSchedule(null)}
          onConfirm={async () => {
            const s = pendingSchedule;
            setPendingSchedule(null);
            await removeSchedule(s.id).catch(() => undefined);
          }}
        />
      ) : null}

      {pendingReserve ? (
        <ConfirmDialog
          title={t('reserves.deleteConfirmTitle')}
          body={t('reserves.deleteConfirmBody', { name: pendingReserve.name })}
          confirmLabel={t('common.delete')}
          danger
          onCancel={() => setPendingReserve(null)}
          onConfirm={async () => {
            const r = pendingReserve;
            setPendingReserve(null);
            await removeReserve(r.id).catch(() => undefined);
          }}
        />
      ) : null}
    </section>
  );
}

/* ── 予定の追加シート ── */

function ScheduleSheet({
  accounts,
  tags,
  onClose,
  onSave,
}: {
  accounts: { id: string; name: string; type: string; archived: boolean }[];
  tags: Tag[];
  onClose: () => void;
  onSave: (list: CashflowSchedule[]) => void;
}) {
  const [title, setTitle] = useState('');
  const [dueDate, setDueDate] = useState(todayLocal());
  const [amountText, setAmountText] = useState('');
  const [direction, setDirection] = useState<CashflowDirection>('outflow');
  const [accountId, setAccountId] = useState('');
  const [counterAccountId, setCounterAccountId] = useState('');
  const [source, setSource] = useState<CashflowSource>('manual');
  const [installmentsText, setInstallmentsText] = useState('2');
  const [entryTagIds, setEntryTagIds] = useState<string[]>([]);
  const [accountTagIds, setAccountTagIds] = useState<string[]>([]);
  const [counterTagIds, setCounterTagIds] = useState<string[]>([]);
  const [errors, setErrors] = useState<string[]>([]);
  const [submitting, setSubmitting] = useState(false);

  const allAccounts = accounts as unknown as Parameters<typeof groupedAccounts>[0];
  const assetGroups = groupedAccounts(allAccounts, ['asset'], accountId);
  const counterGroups = groupedAccounts(allAccounts, undefined, counterAccountId);

  const amount = amountText === '' ? 0 : Number.parseInt(amountText.replace(/[^\d]/g, ''), 10);
  const installments =
    source === 'installment'
      ? Number.parseInt(installmentsText.replace(/[^\d]/g, '') || '0', 10)
      : 1;

  function validate(): string[] {
    const e: string[] = [];
    if (title.trim() === '') e.push(t('cashflow.error.name'));
    if (!Number.isInteger(amount) || amount <= 0) e.push(t('cashflow.error.amount'));
    if (!accountId) e.push(t('cashflow.error.account'));
    if (source === 'installment' && (!Number.isInteger(installments) || installments < 2))
      e.push(t('cashflow.error.installments'));
    return e;
  }

  function build(): CashflowSchedule[] {
    const ts = nowIso();
    const counter = counterAccountId ? { counterAccountId } : {};
    const tagFields = {
      ...(entryTagIds.length ? { entryTagIds } : {}),
      ...(accountTagIds.length ? { accountLineTagIds: accountTagIds } : {}),
      ...(counterTagIds.length ? { counterLineTagIds: counterTagIds } : {}),
    };
    if (source === 'installment' && installments >= 2) {
      const amts = monthlyAmounts(amount, installments);
      const day = dueDate.slice(8, 10);
      const startYm = monthOf(dueDate);
      return amts.map((amt, i) => ({
        id: newId(),
        title: `${title.trim()}（${i + 1}/${installments}）`,
        dueDate: `${addMonths(startYm, i)}-${day}`,
        amount: amt,
        direction,
        accountId,
        ...counter,
        ...tagFields,
        source: 'installment',
        status: 'planned',
        createdAt: ts,
        updatedAt: ts,
      }));
    }
    return [
      {
        id: newId(),
        title: title.trim(),
        dueDate,
        amount,
        direction,
        accountId,
        ...counter,
        ...tagFields,
        source,
        status: 'planned',
        createdAt: ts,
        updatedAt: ts,
      },
    ];
  }

  async function submit() {
    const found = validate();
    setErrors(found);
    if (found.length > 0) return;
    setSubmitting(true);
    onSave(build());
  }

  return (
    <Modal
      title={t('cashflow.form.title')}
      onClose={onClose}
      dismissable={false}
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
            data-ui={UI.cashflow.scheduleSave}
          >
            {t('common.save')}
          </button>
        </>
      }
    >
      {errors.length > 0 ? (
        <div className="field__error" role="alert" style={{ marginBottom: 'var(--space-3)' }}>
          <Icon name="alert" size={14} />
          {errors[0]}
        </div>
      ) : null}

      <TextInput
        label={t('cashflow.form.name')}
        required
        value={title}
        placeholder={t('cashflow.form.namePlaceholder')}
        onChange={setTitle}
        dataUi={UI.cashflow.scheduleName}
      />
      <SelectInput
        label={t('cashflow.form.direction')}
        value={direction}
        onChange={(v) => setDirection(v as CashflowDirection)}
        options={[
          { value: 'outflow', label: t('cashflow.dir.outflow') },
          { value: 'inflow', label: t('cashflow.dir.inflow') },
        ]}
      />
      <TextInput
        label={t('cashflow.form.dueDate')}
        type="date"
        value={dueDate}
        onChange={setDueDate}
      />
      <TextInput
        label={t('cashflow.form.amount')}
        required
        inputMode="numeric"
        value={amountText}
        onChange={(v) => setAmountText(v.replace(/[^\d]/g, ''))}
        dataUi={UI.cashflow.scheduleAmount}
      />
      <AccountPicker
        label={t('cashflow.form.account')}
        required
        value={accountId}
        groups={assetGroups}
        onChange={setAccountId}
        dataUi={UI.cashflow.scheduleAccount}
      />
      <AccountPicker
        label={t('cashflow.form.counter')}
        value={counterAccountId}
        groups={counterGroups}
        onChange={setCounterAccountId}
        dataUi={UI.cashflow.scheduleCounter}
      />
      <TagPicker
        label={t('cashflow.form.entryTags')}
        tags={tagsForScope(tags, 'entry', entryTagIds)}
        value={entryTagIds}
        onChange={setEntryTagIds}
        dataUi={UI.cashflow.scheduleEntryTags}
      />
      <TagPicker
        label={t('cashflow.form.accountTags')}
        tags={tagsForScope(tags, 'line', accountTagIds)}
        value={accountTagIds}
        onChange={setAccountTagIds}
        dataUi={UI.cashflow.scheduleAccountTags}
      />
      <TagPicker
        label={t('cashflow.form.counterTags')}
        tags={tagsForScope(tags, 'line', counterTagIds)}
        value={counterTagIds}
        onChange={setCounterTagIds}
        dataUi={UI.cashflow.scheduleCounterTags}
      />
      <SelectInput
        label={t('cashflow.form.source')}
        value={source}
        onChange={(v) => setSource(v as CashflowSource)}
        options={[
          { value: 'manual', label: t('cashflow.src.manual') },
          { value: 'credit-card', label: t('cashflow.src.creditCard') },
          { value: 'installment', label: t('cashflow.src.installment') },
        ]}
      />
      {source === 'installment' ? (
        <TextInput
          label={t('cashflow.form.installments')}
          required
          inputMode="numeric"
          value={installmentsText}
          onChange={(v) => setInstallmentsText(v.replace(/[^\d]/g, ''))}
          dataUi={UI.cashflow.scheduleInstallments}
        />
      ) : null}
    </Modal>
  );
}

/* ── 目的別資金の追加シート ── */

function ReserveSheet({
  onClose,
  onSave,
}: {
  onClose: () => void;
  onSave: (input: { name: string; targetAmount?: number; note?: string }) => void;
}) {
  const [name, setName] = useState('');
  const [targetText, setTargetText] = useState('');
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | undefined>(undefined);
  const [submitting, setSubmitting] = useState(false);

  function submit() {
    if (name.trim() === '') {
      setError(t('reserves.error.name'));
      return;
    }
    setSubmitting(true);
    const target =
      targetText === '' ? undefined : Number.parseInt(targetText.replace(/[^\d]/g, ''), 10);
    onSave({
      name: name.trim(),
      ...(target && target > 0 ? { targetAmount: target } : {}),
      ...(note.trim() !== '' ? { note: note.trim() } : {}),
    });
  }

  return (
    <Modal
      title={t('reserves.form.title')}
      onClose={onClose}
      dismissable={false}
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
            data-ui={UI.cashflow.reserveSave}
          >
            {t('common.save')}
          </button>
        </>
      }
    >
      <TextInput
        label={t('reserves.name')}
        required
        value={name}
        placeholder={t('reserves.namePlaceholder')}
        onChange={(v) => {
          setName(v);
          setError(undefined);
        }}
        error={error}
        dataUi={UI.cashflow.reserveName}
      />
      <TextInput
        label={t('reserves.target')}
        inputMode="numeric"
        value={targetText}
        onChange={(v) => setTargetText(v.replace(/[^\d]/g, ''))}
      />
      <TextArea label={t('reserves.note')} value={note} onChange={setNote} />
    </Modal>
  );
}

function FundingGoalSheet({
  accounts,
  onClose,
  onSave,
}: {
  accounts: Account[];
  onClose: () => void;
  onSave: (input: FundingGoalInput) => void;
}) {
  const [name, setName] = useState('');
  const [targetText, setTargetText] = useState('');
  const [targetDate, setTargetDate] = useState('');
  const [currentText, setCurrentText] = useState('');
  const [sourceId, setSourceId] = useState('');
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | undefined>(undefined);
  const [submitting, setSubmitting] = useState(false);

  function submit() {
    if (name.trim() === '') {
      setError(t('fundingGoal.error.name'));
      return;
    }
    const target = targetText === '' ? 0 : Number.parseInt(targetText, 10);
    if (target <= 0 || !/^\d{4}-\d{2}-\d{2}$/.test(targetDate)) {
      setError(t('fundingGoal.error.target'));
      return;
    }
    setSubmitting(true);
    const current = currentText === '' ? 0 : Number.parseInt(currentText, 10);
    onSave({
      name: name.trim(),
      targetAmount: target,
      targetDate,
      currentAmount: current,
      ...(sourceId !== '' ? { sourceAccountId: sourceId } : {}),
      ...(note.trim() !== '' ? { note: note.trim() } : {}),
    });
  }

  return (
    <Modal
      title={t('fundingGoal.form.title')}
      onClose={onClose}
      dismissable={false}
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
            data-ui={UI.cashflow.goalSave}
          >
            {t('common.save')}
          </button>
        </>
      }
    >
      <TextInput
        label={t('fundingGoal.name')}
        required
        value={name}
        placeholder={t('fundingGoal.namePlaceholder')}
        onChange={(v) => {
          setName(v);
          setError(undefined);
        }}
        error={error}
        dataUi={UI.cashflow.goalName}
      />
      <TextInput
        label={t('fundingGoal.targetAmount')}
        required
        inputMode="numeric"
        value={targetText}
        onChange={(v) => setTargetText(v.replace(/[^\d]/g, ''))}
        dataUi={UI.cashflow.goalAmount}
      />
      <TextInput
        label={t('fundingGoal.targetDate')}
        required
        type="date"
        value={targetDate}
        onChange={setTargetDate}
        dataUi={UI.cashflow.goalDate}
      />
      <TextInput
        label={t('fundingGoal.currentAmount')}
        inputMode="numeric"
        value={currentText}
        hint={t('fundingGoal.currentHint')}
        onChange={(v) => setCurrentText(v.replace(/[^\d]/g, ''))}
      />
      <AccountPicker
        label={t('fundingGoal.source')}
        value={sourceId}
        groups={groupedAccountsByRole(accounts, ['daily-asset', 'reserve-asset'], sourceId)}
        onChange={setSourceId}
      />
      <TextArea label={t('fundingGoal.note')} value={note} onChange={setNote} />
    </Modal>
  );
}
