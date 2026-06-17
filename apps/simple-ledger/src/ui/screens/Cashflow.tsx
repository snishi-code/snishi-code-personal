/*
 * 資金繰り（将来CF）。計画した予定・未来日付の仕訳から自由資金の推移・最低残高を投影し、
 * 取り置き資金（取り置き枠）の管理を行う。
 */
import { useMemo, useState } from 'react';
import { TextInput } from '@snishi/foundation/ui/Field';
import { Icon } from '@snishi/foundation/ui/Icon';
import { ConfirmDialog } from '@snishi/foundation/ui/ConfirmDialog';
import { useLedger } from '../../state/store';
import { deriveBalanceSheet } from '../../domain/accounting';
import { cashDeltaOfEntry, liquidAssetTotal, projectCashflow } from '../../domain/cashflow';
import { continuousCostEntries } from '../../domain/continuousCost';
import { reserveBalances } from '../../domain/reserve';
import { addMonthsToDate } from '../../domain/allocation';
import { todayLocal } from '../../util/time';
import type { CashflowSchedule, ReserveItem } from '../../domain/types';
import { ReserveSheet } from '../ReserveSheet';
import { Money } from '../money';
import { TrendChart, type TrendPoint } from '../components/TrendChart';
import { t } from '../../i18n';
import { UI } from '../../ui-contract';

function shortDateLabel(date: string): string {
  const [, month, day] = date.split('-');
  if (!month || !day) return date;
  return `${Number.parseInt(month, 10)}/${Number.parseInt(day, 10)}`;
}

export function Cashflow() {
  const { ledger, postSchedule, removeSchedule, createReserve, removeReserve } = useLedger();
  const today = todayLocal();
  const [untilDate, setUntilDate] = useState(() => addMonthsToDate(todayLocal(), 6));
  const [reserveOpen, setReserveOpen] = useState(false);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [pendingSchedule, setPendingSchedule] = useState<CashflowSchedule | null>(null);
  const [pendingReserve, setPendingReserve] = useState<ReserveItem | null>(null);

  const currency = ledger?.settings.currency ?? 'JPY';

  const { projection, liabBalById, futureRows } = useMemo(() => {
    const accounts = ledger?.accounts ?? [];
    const entries = ledger?.derivedEntries ?? [];
    const items = ledger?.monthlyCostItems ?? [];
    const schedules = ledger?.cashflowSchedules ?? [];
    const bs = deriveBalanceSheet(accounts, entries, today);
    const byId = new Map(bs.assets.map((a) => [a.account.id, a.balance] as const));
    const liabById = new Map(bs.liabilities.map((l) => [l.account.id, l.balance] as const));
    const liquidIds = new Set(
      accounts
        .filter((a) => a.role === 'daily-asset' || a.role === 'reserve-asset')
        .map((a) => a.id),
    );
    const isLiquid = (id: string) => liquidIds.has(id);
    const reserveIds = new Set(accounts.filter((a) => a.role === 'reserve-asset').map((a) => a.id));
    const isReserve = (id: string) => reserveIds.has(id);
    const nonLiquidAssetIds = new Set(
      bs.assets.map((a) => a.account.id).filter((id) => !liquidIds.has(id)),
    );
    const totalAssets = liquidAssetTotal(bs.assets, nonLiquidAssetIds);
    const reserveBalance = [...reserveIds].reduce((s, id) => s + (byId.get(id) ?? 0), 0);
    const end = untilDate;
    const futureFunding = continuousCostEntries(items, accounts, end).filter(
      (e) => e.metadata?.ccKind === 'funding' && e.date > today && e.date <= end,
    );
    const future = [
      ...entries.filter(
        (e) => e.date > today && e.date <= end && e.lines.some((l) => isLiquid(l.accountId)),
      ),
      ...futureFunding,
    ]
      .map((e) => ({
        id: e.id,
        date: e.date,
        title: e.description,
        delta: cashDeltaOfEntry(e, isLiquid),
        reserveDelta: cashDeltaOfEntry(e, isReserve),
        amount: e.lines.filter((l) => l.side === 'debit').reduce((s, l) => s + l.amount, 0),
      }))
      .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
    return {
      liabBalById: liabById,
      futureRows: future,
      projection: projectCashflow({
        totalAssets,
        reserveBalance,
        schedules,
        today,
        untilDate: end,
        futureEvents: future.map((f) => ({
          date: f.date,
          amount: f.delta,
          reserveAmount: f.reserveDelta,
        })),
      }),
    };
  }, [ledger, untilDate, today]);

  const accountName = (id: string): string =>
    (ledger?.accounts ?? []).find((a) => a.id === id)?.name ?? '—';
  const reserves = ledger?.reserves ?? [];
  const resBalById = useMemo(() => reserveBalances(ledger?.journalEntries ?? []), [ledger]);
  const freeTrend: TrendPoint[] = projection.points.map((p, i) => ({
    key: `${p.date}-${i}`,
    label: shortDateLabel(i === 0 ? today : p.date),
    value: p.free,
  }));

  const liabilitySummary = useMemo(() => {
    const accounts = ledger?.accounts ?? [];
    const schedules = ledger?.cashflowSchedules ?? [];
    return accounts
      .filter((a) => a.role === 'payment-liability' || a.role === 'other-liability')
      .map((a) => {
        const related = schedules.filter(
          (s) => s.counterAccountId === a.id && s.status === 'planned',
        );
        const remaining = related.reduce((sum, s) => sum + s.amount, 0);
        const nextDue = related.map((s) => s.dueDate).sort()[0];
        return {
          id: a.id,
          name: a.name,
          count: related.length,
          remaining,
          nextDue,
          balance: liabBalById.get(a.id) ?? 0,
        };
      })
      .filter((x) => x.count > 0 || x.balance !== 0);
  }, [ledger, liabBalById]);

  return (
    <section aria-labelledby="cashflow-title" data-ui={UI.cashflow.view}>
      <h1 className="screen-title" id="cashflow-title">
        {t('cashflow.title')}
      </h1>
      <p className="field__hint" style={{ marginBottom: 'var(--space-3)' }}>
        {t('cashflow.intro')}
      </p>

      <TextInput
        label={t('cashflow.until')}
        type="date"
        value={untilDate}
        hint={t('cashflow.untilHint')}
        onChange={setUntilDate}
        dataUi={UI.cashflow.until}
      />

      <div
        className="stat-grid"
        data-ui={UI.cashflow.summary}
        style={{ marginTop: 'var(--space-3)' }}
      >
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

      {freeTrend.length > 1 ? (
        <TrendChart
          title={t('cashflow.freeTrendTitle')}
          data={freeTrend}
          currency={currency}
          variant="line"
          dataUi={UI.cashflow.freeTrend}
        />
      ) : null}

      <p className="section-label">{t('cashflow.debtTitle')}</p>
      <p className="field__hint" style={{ marginBottom: 'var(--space-2)' }}>
        {t('cashflow.debtIntro')}
      </p>
      {liabilitySummary.length === 0 ? (
        <div className="card card--pad empty">{t('cashflow.debtNoPlan')}</div>
      ) : (
        <ul className="card list" data-ui={UI.cashflow.liabilityList}>
          {liabilitySummary.map((l) => (
            <li key={l.id} className="list__item">
              <div className="list__main">
                <div className="list__title">{l.name}</div>
                <div className="list__sub">
                  {t('cashflow.debtBalance')}: <Money amount={l.balance} currency={currency} />
                </div>
                {l.count > 0 ? (
                  <div className="list__sub">
                    {t('cashflow.nextDue')}: {l.nextDue ?? '—'}・
                    {t('cashflow.installmentsLeft', { count: l.count })}・
                    {t('cashflow.debtBalance')} <Money amount={l.remaining} currency={currency} />
                  </div>
                ) : (
                  <div className="list__sub amount--neg">{t('cashflow.debtNoPlanHint')}</div>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}

      <p className="section-label">{t('cashflow.futureTitle')}</p>
      <p className="field__hint" style={{ marginBottom: 'var(--space-2)' }}>
        {t('cashflow.futureIntro')}
      </p>
      {futureRows.length === 0 ? (
        <div className="card card--pad empty">{t('cashflow.futureEmpty')}</div>
      ) : (
        <ul className="card list" data-ui={UI.cashflow.futureList}>
          {futureRows.map((f) => (
            <li key={f.id} className="list__item">
              <div className="list__main">
                <div className="list__title">{f.title}</div>
                <div className="list__sub">{f.date}</div>
              </div>
              <span
                className={`list__amount ${
                  f.delta > 0 ? 'amount--pos' : f.delta < 0 ? 'amount--neg' : 'muted'
                }`}
              >
                {f.delta > 0 ? '+' : f.delta < 0 ? '−' : '→ '}
                <Money amount={f.delta === 0 ? f.amount : Math.abs(f.delta)} currency={currency} />
              </span>
            </li>
          ))}
        </ul>
      )}

      <p className="section-label">{t('cashflow.scheduleSecondaryTitle')}</p>
      <p className="field__hint" style={{ marginBottom: 'var(--space-2)' }}>
        {t('cashflow.scheduleSecondaryHint')}
      </p>
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
              <span
                className={`list__amount ${
                  s.direction === 'inflow'
                    ? 'amount--pos'
                    : s.direction === 'transfer'
                      ? 'muted'
                      : 'amount--neg'
                }`}
              >
                {s.direction === 'inflow' ? '+' : s.direction === 'transfer' ? '→ ' : '−'}
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
                <Icon name="delete" size={18} />
              </button>
            </li>
          ))}
        </ul>
      )}

      <button
        type="button"
        className="collapse-toggle"
        aria-expanded={showAdvanced}
        onClick={() => setShowAdvanced((v) => !v)}
        data-ui={UI.cashflow.advancedToggle}
        style={{ marginTop: 'var(--space-4)' }}
      >
        <Icon name={showAdvanced ? 'expand' : 'chevronRight'} size={16} />
        {t('cashflow.advancedTitle')}
      </button>
      {showAdvanced ? (
        <div className="stack">
          <p className="field__hint">{t('cashflow.advancedHint')}</p>

          <div
            className="section-label"
            style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}
          >
            <span>{t('reserves.title')}</span>
            <button
              type="button"
              className="btn btn--ghost"
              style={{ minHeight: 36 }}
              onClick={() => setReserveOpen(true)}
              data-ui={UI.cashflow.addReserve}
            >
              <Icon name="add" size={16} />
              {t('reserves.add')}
            </button>
          </div>
          {reserves.length === 0 ? (
            <div className="card card--pad empty">{t('reserves.empty')}</div>
          ) : (
            <ul className="card list" data-ui={UI.cashflow.reserveList}>
              {reserves.map((r) => {
                const balance = resBalById.get(r.id) ?? 0;
                return (
                  <li key={r.id} className="list__item">
                    <div className="list__main">
                      <div className="list__title">{r.name}</div>
                      <div className="list__sub">
                        {t('reserves.balance')}: <Money amount={balance} currency={currency} />
                      </div>
                    </div>
                    <button
                      type="button"
                      className="icon-btn"
                      onClick={() => setPendingReserve(r)}
                      aria-label={`${t('reserves.delete')}: ${r.name}`}
                    >
                      <Icon name="delete" size={18} />
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      ) : null}

      {reserveOpen ? (
        <ReserveSheet
          onClose={() => setReserveOpen(false)}
          onSave={(input) => createReserve(input)}
        />
      ) : null}

      {pendingSchedule ? (
        <ConfirmDialog
          title={t('cashflow.deleteSchedule')}
          body={pendingSchedule.title}
          confirmLabel={t('common.delete')}
          danger
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
