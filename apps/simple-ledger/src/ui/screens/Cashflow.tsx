/*
 * 資金繰り（将来CF）。未来日付の仕訳から「自由に動かせるお金」の推移・最低残高を投影し、
 * 負債の返済計画（登録済みの返済仕訳の確認・編集を含む）を扱う。
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { SelectInput, TextInput } from '@snishi/foundation/ui/Field';
import { Icon } from '@snishi/foundation/ui/Icon';
import { ConfirmDialog, Modal } from '../overlays';
import { useLedger } from '../../state/store';
import { deriveBalanceSheet } from '../../domain/accounting';
import {
  cashDeltaOfEntry,
  freeAssetTotal,
  isFreeAsset,
  nextRepaymentDate,
  projectCashflow,
  uniqueEntriesById,
} from '../../domain/cashflow';
import { reportBasis } from '../../domain/reportPeriod';
import { reportEntriesForAsOf } from '../../domain/reportEntries';
import { addMonthsToDate } from '../../domain/allocation';
import { sortAccounts } from '../../domain/accountOrder';
import { todayLocal } from '../../util/time';
import type { Account, CashflowSchedule, JournalEntry } from '../../domain/types';
import { Money } from '../money';
import { TrendChart, type TrendPoint } from '../components/TrendChart';
import { errorText, t } from '../../i18n';
import { UI } from '../../ui-contract';

function shortDateLabel(date: string): string {
  const [, month, day] = date.split('-');
  if (!month || !day) return date;
  return `${Number.parseInt(month, 10)}/${Number.parseInt(day, 10)}`;
}

/** 仕訳がこの負債（借方）へ返す金額（返済仕訳の表示額）。 */
function repaymentAmountOf(entry: JournalEntry, liabilityId: string): number {
  return entry.lines
    .filter((l) => l.side === 'debit' && l.accountId === liabilityId)
    .reduce((s, l) => s + l.amount, 0);
}

export function Cashflow({
  onEditEntry,
  targetScheduleId,
}: {
  onEditEntry: (entry: JournalEntry) => void;
  /** タイムラインから開いた旧形式の予定 CF。該当行へ移動して強調する。 */
  targetScheduleId?: string | null;
}) {
  const { ledger, postSchedule, removeSchedule } = useLedger();
  const today = todayLocal();
  const basis = useMemo(() => reportBasis({ mode: 'all' }, today), [today]);
  const reportEntries = useMemo(
    () => (ledger ? reportEntriesForAsOf(ledger, basis.asOf) : []),
    [basis.asOf, ledger],
  );
  const [untilDate, setUntilDate] = useState(() => addMonthsToDate(todayLocal(), 6));
  const [pendingSchedule, setPendingSchedule] = useState<CashflowSchedule | null>(null);
  const [repayFor, setRepayFor] = useState<{ account: Account; balance: number } | null>(null);
  // 負債行の展開（登録済みの返済リスト）。行タップ = 新規返済シートとは独立に開閉する。
  const [openRepayments, setOpenRepayments] = useState<ReadonlySet<string>>(new Set());
  const targetScheduleRef = useRef<HTMLLIElement | null>(null);

  useEffect(() => {
    const row = targetScheduleRef.current;
    if (!targetScheduleId || !row || typeof row.scrollIntoView !== 'function') return;
    row.scrollIntoView({ block: 'center' });
  }, [ledger, targetScheduleId]);

  const currency = ledger?.settings.currency ?? 'JPY';

  const { projection, liabBalById, futureRows } = useMemo(() => {
    const accounts = ledger?.accounts ?? [];
    const entries = reportEntries;
    const schedules = ledger?.cashflowSchedules ?? [];
    const bs = deriveBalanceSheet(accounts, entries, today);
    const liabById = new Map(bs.liabilities.map((l) => [l.account.id, l.balance] as const));
    const freeIds = new Set(accounts.filter((a) => isFreeAsset(a)).map((a) => a.id));
    const isFree = (id: string) => freeIds.has(id);
    const startFree = freeAssetTotal(bs.assets);
    const end = untilDate;
    const futureEntries = ledger ? reportEntriesForAsOf(ledger, end) : [];
    const future = uniqueEntriesById(
      futureEntries.filter(
        (e) => e.date > today && e.date <= end && e.lines.some((l) => isFree(l.accountId)),
      ),
    )
      .map((e) => ({
        id: e.id,
        date: e.date,
        title: e.description,
        delta: cashDeltaOfEntry(e, isFree),
        amount: e.lines.filter((l) => l.side === 'debit').reduce((s, l) => s + l.amount, 0),
      }))
      .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
    return {
      liabBalById: liabById,
      futureRows: future,
      projection: projectCashflow({
        startFree,
        schedules,
        today,
        // 予定 CF も未来仕訳（cashDeltaOfEntry）と同じ free 判定で増減を出す（監査 P2-4）。
        isFree,
        untilDate: end,
        futureEvents: future.map((f) => ({ date: f.date, amount: f.delta })),
      }),
    };
  }, [ledger, reportEntries, untilDate, today]);

  const accountName = (id: string): string =>
    (ledger?.accounts ?? []).find((a) => a.id === id)?.name ?? '—';
  // タイムラインで選んだ予定は、資金繰りの既定期間（今日〜6か月）外でも詳細行を見せる。
  // 投影計算の期間自体は変えず、一覧への補足だけに留める。
  const displayedSchedules = useMemo(() => {
    const target = ledger?.cashflowSchedules.find(
      (schedule) => schedule.id === targetScheduleId && schedule.status === 'planned',
    );
    if (!target || projection.schedules.some((schedule) => schedule.id === target.id)) {
      return projection.schedules;
    }
    return [...projection.schedules, target].sort((left, right) =>
      left.dueDate.localeCompare(right.dueDate),
    );
  }, [ledger, projection.schedules, targetScheduleId]);
  const freeTrend: TrendPoint[] = projection.points.map((p, i) => ({
    key: `${p.date}-${i}`,
    label: shortDateLabel(i === 0 ? today : p.date),
    value: p.free,
  }));

  const liabilitySummary = useMemo(() => {
    const accounts = ledger?.accounts ?? [];
    const schedules = ledger?.cashflowSchedules ?? [];
    const entries = ledger?.journalEntries ?? [];
    return sortAccounts(accounts)
      .filter((a) => a.role === 'payment-liability' || a.role === 'other-liability')
      .map((a) => {
        // 返済予定 = 未実績の予定 CF（旧版レガシー）+ 未来日付の返済実仕訳（借方がこの負債）。
        const planned = schedules.filter(
          (s) => s.counterAccountId === a.id && s.status === 'planned',
        );
        const repayments = entries
          .filter(
            (e) =>
              e.date > today && e.lines.some((l) => l.side === 'debit' && l.accountId === a.id),
          )
          .sort((x, y) => (x.date < y.date ? -1 : x.date > y.date ? 1 : 0));
        const remaining =
          planned.reduce((sum, s) => sum + s.amount, 0) +
          repayments.reduce((sum, e) => sum + repaymentAmountOf(e, a.id), 0);
        const count = planned.length + repayments.length;
        const nextDue = [
          ...planned.map((s) => s.dueDate),
          ...repayments.map((e) => e.date),
        ].sort()[0];
        return {
          id: a.id,
          account: a,
          name: a.name,
          count,
          repayments,
          remaining,
          nextDue,
          balance: liabBalById.get(a.id) ?? 0,
        };
      })
      .filter((x) => x.count > 0 || x.balance !== 0);
  }, [ledger, liabBalById, today]);

  const toggleRepayments = (id: string) =>
    setOpenRepayments((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

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
          <span className="stat__label">{t('cashflow.freeFunds')}</span>
          <span className="stat__value">
            <Money amount={projection.startFree} currency={currency} signed />
          </span>
        </div>
      </div>

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
            <li
              key={l.id}
              className="list__item"
              style={{ flexDirection: 'column', alignItems: 'stretch', gap: 0 }}
            >
              {/* 行タップ = 返済シート（残高を見ながら返済計画を入力する）。 */}
              <button
                type="button"
                className="list__row-btn"
                onClick={() => setRepayFor({ account: l.account, balance: l.balance })}
                aria-label={`${t('cashflow.repayAdd')}: ${l.name}`}
                data-ui={UI.cashflow.liabilityRow}
              >
                <div className="list__main">
                  <div className="list__title">{l.name}</div>
                  <div className="list__sub">
                    {t('cashflow.debtBalance')}: <Money amount={l.balance} currency={currency} />
                  </div>
                  {l.account.repaymentAccountId !== undefined &&
                  l.account.repaymentDay !== undefined ? (
                    <div className="list__sub">
                      {t('cashflow.repaySettingsLine', {
                        account: accountName(l.account.repaymentAccountId),
                        day: l.account.repaymentDay,
                      })}
                    </div>
                  ) : null}
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
                <Icon name="chevronRight" size={18} />
              </button>
              {/* 展開 = 登録済みの返済（未来日付の保存仕訳・借方 = この負債）。タップで編集。 */}
              {l.repayments.length > 0 ? (
                <>
                  <button
                    type="button"
                    className="collapse-toggle"
                    aria-expanded={openRepayments.has(l.id)}
                    onClick={() => toggleRepayments(l.id)}
                    data-ui={UI.cashflow.repaymentsToggle}
                  >
                    <Icon name={openRepayments.has(l.id) ? 'expand' : 'chevronRight'} size={16} />
                    {t('cashflow.repaymentsRegistered')}
                  </button>
                  {openRepayments.has(l.id) ? (
                    <ul className="list" data-ui={UI.cashflow.repaymentsList}>
                      {l.repayments.map((e) => (
                        <li key={e.id}>
                          <button
                            type="button"
                            className="list__row-btn"
                            onClick={() => onEditEntry(e)}
                            aria-label={`${t('common.edit')}: ${e.date} ${e.description}`}
                            data-ui={UI.cashflow.repaymentRow}
                          >
                            <span>{e.date}</span>
                            <span className="list__amount">
                              <Money amount={repaymentAmountOf(e, l.id)} currency={currency} />
                            </span>
                          </button>
                        </li>
                      ))}
                    </ul>
                  ) : null}
                </>
              ) : null}
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

      {/* 旧バージョンで作られた予定 CF（分割返済など）のレガシー表示。新規には作られない
          （返済は未来日付の実仕訳として登録される）ため、残っている時だけセクションごと表示する。 */}
      {displayedSchedules.length === 0 ? null : (
        <>
          <p className="section-label">{t('cashflow.scheduleSecondaryTitle')}</p>
          <p className="field__hint" style={{ marginBottom: 'var(--space-2)' }}>
            {t('cashflow.scheduleSecondaryHint')}
          </p>
          <ul className="card list" data-ui={UI.cashflow.list}>
            {displayedSchedules.map((s) => (
              <li
                key={s.id}
                className={`list__item${s.id === targetScheduleId ? ' cashflow-schedule--targeted' : ''}`}
                ref={s.id === targetScheduleId ? targetScheduleRef : undefined}
                data-targeted={s.id === targetScheduleId ? 'true' : undefined}
              >
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
        </>
      )}

      {repayFor ? (
        <RepaymentScheduleSheet
          account={repayFor.account}
          balance={repayFor.balance}
          onClose={() => setRepayFor(null)}
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
    </section>
  );
}

/**
 * カード・ローンの返済計画を登録するシート（負債の行タップで開く）。
 * 勘定科目の返済設定（返済口座・毎月の返済日）が既定値になる。金額の既定はいまの残高（全額）。
 *  - 回数 1（既定）: カードの次回引落など、支払日の振替仕訳（借方 負債 / 貸方 返済口座）を 1 本。
 *  - 回数 N: 毎月同額のローン。総額を N 回に配分した未来の振替仕訳を一括登録（合計は総額に一致）。
 * どちらも予定 CF は経由しない。未来日付の実仕訳として仕訳一覧・資金繰りの投影に乗る。
 */
function RepaymentScheduleSheet({
  account,
  balance,
  onClose,
}: {
  account: Account;
  balance: number;
  onClose: () => void;
}) {
  const { ledger, createRepaymentEntries } = useLedger();
  const accounts = ledger?.accounts ?? [];
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
  const [amountText, setAmountText] = useState(balance > 0 ? String(balance) : '');
  const [countText, setCountText] = useState('1');
  const [error, setError] = useState<string | undefined>(undefined);
  const [submitting, setSubmitting] = useState(false);

  const amount = amountText === '' ? 0 : Number.parseInt(amountText, 10);
  const count = countText === '' ? 0 : Number.parseInt(countText, 10);
  const perMonth = count >= 2 && amount >= count ? Math.round(amount / count) : null;

  async function submit() {
    if (submitting) return;
    if (!Number.isInteger(amount) || amount < 1 || count < 1 || fromAccountId === '') return;
    setSubmitting(true);
    setError(undefined);
    try {
      await createRepaymentEntries({
        liabilityAccountId: account.id,
        fromAccountId,
        firstDate: date,
        total: amount,
        count,
        title: t('cashflow.repayScheduleTitle', { name: account.name }),
      });
      onClose();
    } catch (e) {
      setError(errorText(e));
      setSubmitting(false);
    }
  }

  return (
    <Modal
      title={t('cashflow.repayTitle')}
      onClose={onClose}
      dismissMode="if-clean"
      dataUi={UI.cashflow.repaySheet}
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
            data-ui={UI.cashflow.repaySave}
          >
            {t('common.save')}
          </button>
        </>
      }
    >
      <div className="stack">
        <p className="field__hint">{t('cashflow.repayIntro', { name: account.name })}</p>
        {account.repaymentAccountId === undefined || account.repaymentDay === undefined ? (
          <p className="field__hint">{t('cashflow.repaySettingsHint')}</p>
        ) : null}
        {error ? (
          <div className="field__error" role="alert">
            <Icon name="alert" size={14} />
            {error}
          </div>
        ) : null}
        <SelectInput
          label={t('cashflow.repayFrom')}
          value={fromAccountId}
          onChange={setFromAccountId}
          options={fromOptions}
          dataUi={UI.cashflow.repayFrom}
        />
        <TextInput
          label={t('cashflow.repayDate')}
          type="date"
          required
          value={date}
          onChange={setDate}
          dataUi={UI.cashflow.repayDate}
        />
        <TextInput
          label={t('cashflow.repayAmount')}
          required
          inputMode="numeric"
          value={amountText}
          onChange={(v) => setAmountText(v.replace(/[^\d]/g, ''))}
          hint={t('cashflow.repayAmountHint')}
          dataUi={UI.cashflow.repayAmount}
        />
        <TextInput
          label={t('cashflow.repayCount')}
          required
          inputMode="numeric"
          value={countText}
          onChange={(v) => setCountText(v.replace(/[^\d]/g, ''))}
          hint={t('cashflow.repayCountHint')}
          dataUi={UI.cashflow.repayCount}
        />
        {perMonth !== null ? (
          <p className="field__hint" data-ui={UI.cashflow.repayPerMonth}>
            {t('cashflow.repayPerMonth', {
              amount: `¥${perMonth.toLocaleString('ja-JP')}`,
              count: String(count),
            })}
          </p>
        ) : null}
      </div>
    </Modal>
  );
}
