/*
 * 資金繰り（将来CF）。未来日付の仕訳から「自由に動かせるお金」の推移・最低残高を投影し、
 * 負債の返済計画（登録済みの返済仕訳の確認・編集を含む）を扱う。
 */
import { useMemo, useState } from 'react';
import { SelectInput, TextInput } from '@snishi/foundation/ui/Field';
import { Icon } from '@snishi/foundation/ui/Icon';
import { Modal } from '../overlays';
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
import { displayEntriesResultForAsOf } from '../../domain/reportEntries';
import { addMonthsToDate, MONTHLY_AMOUNTS_HARD_CAP, monthlyAmounts } from '../../domain/allocation';
import { sortAccounts } from '../../domain/accountOrder';
import { todayLocal } from '../../util/time';
import { entryOpenPlan } from '../entryOpen';
import type { AllocationsTarget } from './Allocations';
import { cashflowHorizonMonths } from '../../data/localFlags';
import type { Account, JournalEntry } from '../../domain/types';
import { Money } from '../money';
import { TrendChart, type TrendPoint } from '../components/TrendChart';
import { errorText, t } from '../../i18n';
import {
  exactDigitsFor,
  formatMinorForInput,
  parseAmountToMinor,
  sanitizeAmountText,
} from '../amountText';
import { useMoneyDigits } from '../money';
import { formatMoney } from '../../util/format';
import { UI } from '../../ui-contract';
import { ScrollTopButton } from '../ScrollTopButton';
import { sumAmounts } from '../../domain/safeSum';
import { InvestmentProjectionTruncationNotice } from '../components/InvestmentProjectionTruncationNotice';

function shortDateLabel(date: string): string {
  const [, month, day] = date.split('-');
  if (!month || !day) return date;
  return `${Number.parseInt(month, 10)}/${Number.parseInt(day, 10)}`;
}

/** 仕訳がこの負債（借方）へ返す金額（返済仕訳の表示額）。 */
function repaymentAmountOf(entry: JournalEntry, liabilityId: string): number {
  return sumAmounts(
    entry.lines
      .filter((l) => l.side === 'debit' && l.accountId === liabilityId)
      .map((l) => l.amount),
  );
}

export function Cashflow({
  onEditEntry,
  onOpenAllocations,
  onOpenAccount,
  onOpenEntry,
}: {
  onEditEntry: (entry: JournalEntry) => void;
  /** 仕訳タップの行き先（entryOpenPlan の実行先）。仕訳一覧・ホームと同じ resolver。 */
  onOpenAllocations: (target: AllocationsTarget) => void;
  onOpenAccount: (accountId: string) => void;
  onOpenEntry: (entryId: string) => void;
}) {
  const { ledger } = useLedger();
  const today = todayLocal();
  const basis = useMemo(() => reportBasis({ mode: 'all' }, today), [today]);
  const reportDisplay = useMemo(
    () => (ledger ? displayEntriesResultForAsOf(ledger, basis.asOf, today) : null),
    [basis.asOf, ledger, today],
  );
  const reportEntries = useMemo(() => reportDisplay?.entries ?? [], [reportDisplay]);
  // 表示終了日。**開くたびに「今日 + 既定の期間（設定画面・端末設定）」へ戻る**。
  // 画面内の変更はその場限りで持ち帰らない（普段は既定で見たい・一時的に伸ばしても
  // 次回は既定に戻っていてほしい・作者決定 2026-08-14）。
  const [untilDate, setUntilDate] = useState(() =>
    addMonthsToDate(todayLocal(), cashflowHorizonMonths()),
  );
  const [repayFor, setRepayFor] = useState<{ account: Account; balance: number } | null>(null);
  // 負債行の展開（登録済みの返済リスト）。行タップ = 新規返済シートとは独立に開閉する。
  const [openRepayments, setOpenRepayments] = useState<ReadonlySet<string>>(new Set());

  const currency = ledger?.settings.currency ?? '';

  const { projection, liabBalById, futureRows, investmentProjectionTruncations } = useMemo(() => {
    const accounts = ledger?.accounts ?? [];
    const entries = reportEntries;
    const bs = deriveBalanceSheet(accounts, entries, today);
    const liabById = new Map(bs.liabilities.map((l) => [l.account.id, l.balance] as const));
    const freeIds = new Set(accounts.filter((a) => isFreeAsset(a)).map((a) => a.id));
    const isFree = (id: string) => freeIds.has(id);
    const startFree = freeAssetTotal(bs.assets);
    const end = untilDate;
    // 投影の入力 = 導出込み仕訳（displayEntriesForAsOf を表示終了日まで展開した結果）。
    const futureDisplay = ledger ? displayEntriesResultForAsOf(ledger, end, today) : null;
    const futureEntries = futureDisplay?.entries ?? [];
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
        amount: sumAmounts(e.lines.filter((l) => l.side === 'debit').map((l) => l.amount)),
        entry: e,
      }))
      .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
    return {
      liabBalById: liabById,
      futureRows: future,
      projection: projectCashflow({
        startFree,
        entries: futureEntries,
        today,
        isFree,
        untilDate: end,
      }),
      investmentProjectionTruncations: futureDisplay?.investmentProjectionTruncations ?? [],
    };
  }, [ledger, reportEntries, untilDate, today]);

  const accountName = (id: string): string =>
    (ledger?.accounts ?? []).find((a) => a.id === id)?.name ?? '—';
  const freeTrend: TrendPoint[] = projection.points.map((p, i) => ({
    key: `${p.date}-${i}`,
    label: shortDateLabel(i === 0 ? today : p.date),
    value: p.free,
  }));

  const liabilitySummary = useMemo(() => {
    const accounts = ledger?.accounts ?? [];
    const entries = ledger?.journalEntries ?? [];
    return sortAccounts(accounts)
      .filter((a) => a.role === 'payment-liability' || a.role === 'other-liability')
      .map((a) => {
        // 返済予定 = 未来日付の返済実仕訳（借方がこの負債）。
        const repayments = entries
          .filter(
            (e) =>
              e.date > today && e.lines.some((l) => l.side === 'debit' && l.accountId === a.id),
          )
          .sort((x, y) => (x.date < y.date ? -1 : x.date > y.date ? 1 : 0));
        const remaining = sumAmounts(repayments.map((e) => repaymentAmountOf(e, a.id)));
        const count = repayments.length;
        const nextDue = repayments.map((e) => e.date).sort()[0];
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

      <InvestmentProjectionTruncationNotice
        truncations={investmentProjectionTruncations}
        accounts={ledger?.accounts ?? []}
      />

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
          {futureRows.map((f) => {
            {
              /* タップで編集 or 由来へ（entryOpenPlan の単一正本・仕訳一覧/ホームと同じ規則）。 */
            }
            const plan = entryOpenPlan(f.entry);
            const onTap =
              plan.kind === 'none'
                ? undefined
                : plan.kind === 'rule'
                  ? () => onOpenAllocations({ ruleId: plan.ruleId })
                  : plan.kind === 'item'
                    ? () => onOpenAllocations({ itemId: plan.itemId })
                    : plan.kind === 'account'
                      ? () => onOpenAccount(plan.accountId)
                      : plan.kind === 'edit'
                        ? () => onEditEntry(f.entry)
                        : () => onOpenEntry(f.entry.id);
            const body = (
              <>
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
                  <Money
                    amount={f.delta === 0 ? f.amount : Math.abs(f.delta)}
                    currency={currency}
                  />
                </span>
              </>
            );
            return (
              <li key={f.id} className="list__row">
                {onTap ? (
                  <button
                    type="button"
                    className="list__item list__item--button"
                    onClick={onTap}
                    data-ui={UI.cashflow.futureRow}
                  >
                    {body}
                  </button>
                ) : (
                  <div className="list__item">{body}</div>
                )}
              </li>
            );
          })}
        </ul>
      )}

      {repayFor ? (
        <RepaymentScheduleSheet
          account={repayFor.account}
          balance={repayFor.balance}
          onClose={() => setRepayFor(null)}
        />
      ) : null}
      <ScrollTopButton />
    </section>
  );
}

/**
 * カード・ローンの返済計画を登録するシート（負債の行タップで開く）。
 * 勘定科目の返済設定（返済口座・毎月の返済日）が既定値になる。金額の既定はいまの残高（全額）。
 *  - 回数 1（既定）: カードの次回引落など、支払日の振替仕訳（借方 負債 / 貸方 返済口座）を 1 本。
 *  - 回数 N: 毎月同額のローン。総額を N 回に配分した未来の振替仕訳を一括登録（合計は総額に一致）。
 * どちらも未来日付の実仕訳として仕訳一覧・資金繰りの投影に乗る。
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
  const currency = ledger?.settings.currency ?? '';
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
  const digits = useMoneyDigits();
  // 既定は「残高全額」なので、表示桁が粗くても端数を落とさず全額を見せる。
  const amountDigits =
    balance > 0 ? (Math.max(digits, exactDigitsFor(balance)) as typeof digits) : digits;
  const [amountText, setAmountText] = useState(
    balance > 0 ? formatMinorForInput(balance, amountDigits) : '',
  );
  const [countText, setCountText] = useState('1');
  const [error, setError] = useState<string | undefined>(undefined);
  const [submitting, setSubmitting] = useState(false);

  const amount = parseAmountToMinor(amountText) ?? 0;
  const count = countText === '' ? 0 : Number.parseInt(countText, 10);
  // プレビューは保存側と同じ monthlyAmounts の先頭額（独自の丸めを持たない・指示書v3 §A-2）。
  // 表示条件 = 最終回 > 0（プレビューが出た = 保存できる、が成立。§R-1 と同条件）。
  const repayParts =
    count >= 2 && count <= MONTHLY_AMOUNTS_HARD_CAP && amount >= count
      ? monthlyAmounts(amount, count)
      : null;
  const perMonth = repayParts !== null && repayParts.at(-1)! > 0 ? repayParts[0]! : null;

  async function submit() {
    if (submitting) return;
    if (!Number.isInteger(amount) || amount < 1 || fromAccountId === '') return;
    if (!Number.isInteger(count) || count < 1 || count > MONTHLY_AMOUNTS_HARD_CAP) {
      setError(t('error.repay.countInvalid', { max: MONTHLY_AMOUNTS_HARD_CAP }));
      return;
    }
    // 保存境界（buildRepaymentEntries）と同じ条件を先に検証して理由を示す（0 金額の回の防止）。
    if (amount < count) {
      setError(t('error.repay.totalTooSmall'));
      return;
    }
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
          inputMode={amountDigits === 0 ? 'numeric' : 'decimal'}
          value={amountText}
          onChange={(v) => setAmountText(sanitizeAmountText(v, amountDigits, amountText))}
          hint={t('cashflow.repayAmountHint')}
          dataUi={UI.cashflow.repayAmount}
        />
        <TextInput
          label={t('cashflow.repayCount')}
          required
          inputMode="numeric"
          value={countText}
          onChange={(v) => setCountText(v.replace(/[^\d]/g, ''))}
          hint={t('cashflow.repayCountHint', { max: MONTHLY_AMOUNTS_HARD_CAP })}
          dataUi={UI.cashflow.repayCount}
        />
        {perMonth !== null ? (
          <p className="field__hint" data-ui={UI.cashflow.repayPerMonth}>
            {t('cashflow.repayPerMonth', {
              amount: formatMoney(perMonth, currency, digits),
              count: String(count),
            })}
          </p>
        ) : null}
      </div>
    </Modal>
  );
}
