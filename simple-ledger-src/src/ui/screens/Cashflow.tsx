/*
 * 資金繰り（将来CF）。planned な予定から自由資金の推移・最低残高を投影し、
 * 予定の追加・実績化・削除、目的別資金（取り置き枠）の管理を行う。
 * 「いつ費用認識するか(按分)」とは別概念で、「いつ現金が動くか」を扱う。
 */
import { useMemo, useRef, useState } from 'react';
import { useLedger } from '../../state/store';
import { useDirtyGuard } from '../useDirtyGuard';
import { deriveBalanceSheet } from '../../domain/accounting';
import {
  cashDeltaOfEntry,
  horizonEnd,
  inferScheduleFlow,
  liquidAssetTotal,
  projectCashflow,
} from '../../domain/cashflow';
import { addMonths, monthOf, monthlyAmounts } from '../../domain/allocation';
import { goalRequiredMonthly } from '../../domain/fundingGoal';
import { newId } from '../../domain/ids';
import { currentYearMonth, nowIso, todayLocal } from '../../util/time';
import type {
  Account,
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
import { groupedAccountsByRole } from '../accountOptions';
import { tagsForScope } from '../tagOptions';
import type { FormMode } from '../entryModes';
import { ConfirmDialog } from '../ConfirmDialog';
import { Money } from '../money';
import { Icon } from '../Icon';
import { t } from '../../i18n';
import { UI } from '../../ui-contract';

const HORIZONS = [3, 6, 12, 24];

export function Cashflow({ onAddEntry }: { onAddEntry?: (mode: FormMode) => void }) {
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
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [pendingSchedule, setPendingSchedule] = useState<CashflowSchedule | null>(null);
  const [pendingReserve, setPendingReserve] = useState<ReserveItem | null>(null);
  const [pendingGoal, setPendingGoal] = useState<FundingGoal | null>(null);

  const { year, month } = currentYearMonth();
  const currentYm = `${year}-${String(month).padStart(2, '0')}`;
  const returnBps = ledger?.settings.expectedAnnualReturnBps ?? 0;
  const goals = ledger?.fundingGoals ?? [];

  const currency = ledger?.settings.currency ?? 'JPY';
  const today = todayLocal();

  const { projection, balById, liabBalById, futureRows } = useMemo(() => {
    const accounts = ledger?.accounts ?? [];
    const entries = ledger?.journalEntries ?? [];
    const reserves = ledger?.reserves ?? [];
    const schedules = ledger?.cashflowSchedules ?? [];
    const bs = deriveBalanceSheet(accounts, entries, today);
    const byId = new Map(bs.assets.map((a) => [a.account.id, a.balance] as const));
    const liabById = new Map(bs.liabilities.map((l) => [l.account.id, l.balance] as const));
    // 「総資金」= 流動資金のみ（現金・預金=daily-asset と取り置き=reserve-asset）。
    // 投資資産・按分中資産・固定資産など非流動の asset は総資金に含めない（文言と一致させる）。
    const liquidIds = new Set(
      accounts
        .filter((a) => a.role === 'daily-asset' || a.role === 'reserve-asset')
        .map((a) => a.id),
    );
    const isLiquid = (id: string) => liquidIds.has(id);
    // liquidAssetTotal は「除外集合」を取るので、流動でない資産科目を除外として渡す。
    const nonLiquidAssetIds = new Set(
      bs.assets.map((a) => a.account.id).filter((id) => !liquidIds.has(id)),
    );
    const totalAssets = liquidAssetTotal(bs.assets, nonLiquidAssetIds);
    const reserveBalance = reserves.reduce((s, r) => s + (byId.get(r.reserveAccountId) ?? 0), 0);
    // 未来日付（date > today）の仕訳で現金が動くもの = CF に取り込む（ホーム入力が自然に反映される）。
    // delta=投影用の現金純増減（振替は 0）、amount=一覧表示用の取引金額（借方合計）。
    const end = horizonEnd(today, horizon);
    const future = entries
      .filter((e) => e.date > today && e.date <= end && e.lines.some((l) => isLiquid(l.accountId)))
      .map((e) => ({
        id: e.id,
        date: e.date,
        title: e.description,
        delta: cashDeltaOfEntry(e, isLiquid),
        amount: e.lines.filter((l) => l.side === 'debit').reduce((s, l) => s + l.amount, 0),
      }))
      .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
    return {
      balById: byId,
      liabBalById: liabById,
      futureRows: future,
      projection: projectCashflow({
        totalAssets,
        reserveBalance,
        schedules,
        today,
        months: horizon,
        futureEvents: future.map((f) => ({ date: f.date, amount: f.delta })),
      }),
    };
  }, [ledger, horizon, today]);

  const accountName = (id: string): string =>
    (ledger?.accounts ?? []).find((a) => a.id === id)?.name ?? '—';
  const reserves = ledger?.reserves ?? [];
  const maxFree = Math.max(1, ...projection.points.map((p) => Math.abs(p.free)));

  // 支払用負債の集約: 負債ごとに 残高 + 未実績の返済予定（次回支払日・残額・件数）を見せる。
  // 予定が無くても残高がある負債は「返済予定が未登録」として注意表示する。
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

      {/* 自由資金の推移（軽量・自由資金のバー） */}
      {projection.points.length > 1 ? (
        <>
          <p className="section-label">{t('cashflow.freeTrendTitle')}</p>
          <ul
            className="card list"
            data-ui={UI.cashflow.freeTrend}
            style={{ marginTop: 'var(--space-2)' }}
          >
            {projection.points.map((p, i) => (
              <li key={`${p.date}-${i}`} className="list__item">
                <span className="list__sub" style={{ width: 90, flex: 'none' }}>
                  {i === 0 ? today : p.date}
                </span>
                <span
                  aria-hidden="true"
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
        </>
      ) : null}

      {/* 支払用負債・返済予定（CF の主役その2） */}
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

      {/* 未来の入出金・振替予定（ホーム入力が自然に反映される） */}
      <p className="section-label">{t('cashflow.futureTitle')}</p>
      <p className="field__hint" style={{ marginBottom: 'var(--space-2)' }}>
        {t('cashflow.futureIntro')}
      </p>
      {onAddEntry ? (
        <div className="entry-types" style={{ marginBottom: 'var(--space-3)' }}>
          <button
            type="button"
            className="entry-type-btn"
            onClick={() => onAddEntry('income')}
            data-ui={UI.dashboard.income}
          >
            <span className="entry-type-btn__icon">
              <Icon name="income" size={20} />
            </span>
            {t('entry.type.income')}
          </button>
          <button
            type="button"
            className="entry-type-btn"
            onClick={() => onAddEntry('expense')}
            data-ui={UI.dashboard.expense}
          >
            <span className="entry-type-btn__icon">
              <Icon name="expense" size={20} />
            </span>
            {t('entry.type.expense')}
          </button>
          <button
            type="button"
            className="entry-type-btn"
            onClick={() => onAddEntry('transfer')}
            data-ui={UI.dashboard.transfer}
          >
            <span className="entry-type-btn__icon">
              <Icon name="transfer" size={20} />
            </span>
            {t('entry.type.transfer')}
          </button>
        </div>
      ) : null}
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
                {/* 振替（delta=0）は取引金額 amount を中立表示。入出金は純増減の絶対値を出す。 */}
                <Money amount={f.delta === 0 ? f.amount : Math.abs(f.delta)} currency={currency} />
              </span>
            </li>
          ))}
        </ul>
      )}

      {/* 分割・定期の予定（任意・控えめ）。回数のある予定だけここで登録する。 */}
      <div
        className="section-label"
        style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}
      >
        <span>{t('cashflow.scheduleSecondaryTitle')}</span>
        <button
          type="button"
          className="btn btn--ghost"
          style={{ minHeight: 36 }}
          onClick={() => setScheduleOpen(true)}
          data-ui={UI.cashflow.addSchedule}
        >
          <Icon name="plus" size={16} />
          {t('cashflow.addScheduleSecondary')}
        </button>
      </div>
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
                <Icon name="trash" size={18} />
              </button>
            </li>
          ))}
        </ul>
      )}

      {/* 目的別資金・資金目標（補助情報・下部に畳む） */}
      <button
        type="button"
        className="collapse-toggle"
        aria-expanded={showAdvanced}
        onClick={() => setShowAdvanced((v) => !v)}
        data-ui={UI.cashflow.advancedToggle}
        style={{ marginTop: 'var(--space-4)' }}
      >
        <Icon name={showAdvanced ? 'chevronDown' : 'chevronRight'} size={16} />
        {t('cashflow.advancedTitle')}
      </button>
      {showAdvanced ? (
        <div className="stack">
          <p className="field__hint">{t('cashflow.advancedHint')}</p>

          {/* 目的別資金 */}
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
              <Icon name="plus" size={16} />
              {t('reserves.add')}
            </button>
          </div>
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

          {/* 資金目標 */}
          <div
            className="section-label"
            style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}
          >
            <span>{t('fundingGoal.title')}</span>
            <button
              type="button"
              className="btn btn--ghost"
              style={{ minHeight: 36 }}
              onClick={() => setGoalOpen(true)}
              data-ui={UI.cashflow.addGoal}
            >
              <Icon name="plus" size={16} />
              {t('fundingGoal.add')}
            </button>
          </div>
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
        </div>
      ) : null}

      {scheduleOpen ? (
        <ScheduleSheet
          accounts={ledger?.accounts ?? []}
          tags={ledger?.tags ?? []}
          onClose={() => setScheduleOpen(false)}
          onSave={(list) => saveSchedules(list)}
        />
      ) : null}

      {goalOpen ? (
        <FundingGoalSheet
          accounts={ledger?.accounts ?? []}
          onClose={() => setGoalOpen(false)}
          onSave={(input) => createFundingGoal(input)}
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

/* ── 予定の追加シート ── */

function ScheduleSheet({
  accounts,
  tags,
  onClose,
  onSave,
}: {
  accounts: Account[];
  tags: Tag[];
  onClose: () => void;
  onSave: (list: CashflowSchedule[]) => Promise<void> | void;
}) {
  const [title, setTitle] = useState('');
  const [dueDate, setDueDate] = useState(todayLocal());
  const [amountText, setAmountText] = useState('');
  // 日常入力と同じ「源泉 → 行き先」(A → B)。入金/出金はロールから推定する。
  const [srcId, setSrcId] = useState('');
  const [dstId, setDstId] = useState('');
  const [source, setSource] = useState<CashflowSource>('manual');
  const [installmentsText, setInstallmentsText] = useState('2');
  const [entryTagIds, setEntryTagIds] = useState<string[]>([]);
  const [accountTagIds, setAccountTagIds] = useState<string[]>([]);
  const [counterTagIds, setCounterTagIds] = useState<string[]>([]);
  const [errors, setErrors] = useState<string[]>([]);
  const [submitting, setSubmitting] = useState(false);

  // 左=源泉（収入カテゴリ / 日常資産）、右=行き先（日常資産 / 費用カテゴリ / 支払用負債）。
  const srcGroups = groupedAccountsByRole(accounts, ['income-category', 'daily-asset'], srcId);
  const dstGroups = groupedAccountsByRole(
    accounts,
    ['daily-asset', 'expense-category', 'payment-liability'],
    dstId,
  );

  const amount = amountText === '' ? 0 : Number.parseInt(amountText.replace(/[^\d]/g, ''), 10);
  const installments =
    source === 'installment'
      ? Number.parseInt(installmentsText.replace(/[^\d]/g, '') || '0', 10)
      : 1;

  const src = accounts.find((a) => a.id === srcId);
  const dst = accounts.find((a) => a.id === dstId);
  const flow = src && dst ? inferScheduleFlow(src, dst) : null;

  function validate(): string[] {
    const e: string[] = [];
    if (title.trim() === '') e.push(t('cashflow.error.name'));
    if (!Number.isInteger(amount) || amount <= 0) e.push(t('cashflow.error.amount'));
    if (!srcId || !dstId) e.push(t('cashflow.error.flow'));
    else if (!flow) e.push(t('cashflow.error.flowInvalid'));
    if (source === 'installment' && (!Number.isInteger(installments) || installments < 2))
      e.push(t('cashflow.error.installments'));
    return e;
  }

  function build(): CashflowSchedule[] {
    const ts = nowIso();
    // validate 済みなので flow は非 null。
    const { accountId, counterAccountId, direction } = flow!;
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
        counterAccountId,
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
        counterAccountId,
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
    try {
      await onSave(build());
      onClose(); // 成功時のみ閉じる
    } catch {
      // 保存失敗時は閉じない（store 層が error toast）。再入力できるよう戻す。
      setSubmitting(false);
    }
  }

  const snapshot = JSON.stringify({
    title,
    dueDate,
    amountText,
    srcId,
    dstId,
    source,
    installmentsText,
    entryTagIds,
    accountTagIds,
    counterTagIds,
  });
  const initialSnapshotRef = useRef<string | null>(null);
  if (initialSnapshotRef.current === null) initialSnapshotRef.current = snapshot;
  const dirty = snapshot !== initialSnapshotRef.current;
  const { requestClose, discardConfirm } = useDirtyGuard(dirty, onClose);

  return (
    <>
      <Modal
        title={t('cashflow.form.title')}
        onClose={requestClose}
        dismissMode="if-clean"
        footer={
          <>
            <button type="button" className="btn btn--ghost" onClick={requestClose}>
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

        {/* 日常入力と同じ並び: 日付 → 項目 → 金額 → お金の流れ(A → B) */}
        <TextInput
          label={t('cashflow.form.dueDate')}
          type="date"
          value={dueDate}
          onChange={setDueDate}
        />
        <TextInput
          label={t('cashflow.form.name')}
          required
          value={title}
          placeholder={t('cashflow.form.namePlaceholder')}
          onChange={setTitle}
          dataUi={UI.cashflow.scheduleName}
        />
        <TextInput
          label={t('cashflow.form.amount')}
          required
          inputMode="numeric"
          value={amountText}
          onChange={(v) => setAmountText(v.replace(/[^\d]/g, ''))}
          dataUi={UI.cashflow.scheduleAmount}
        />
        <div className="field">
          <span className="field__hint">{t('cashflow.form.flowHint')}</span>
          <div className="flow">
            <div className="flow__side">
              <AccountPicker
                flat
                label={t('cashflow.form.flowSource')}
                required
                value={srcId}
                groups={srcGroups}
                onChange={setSrcId}
                dataUi={UI.cashflow.scheduleFlowSource}
              />
            </div>
            <div className="flow__arrow" aria-hidden="true">
              →
            </div>
            <div className="flow__side">
              <AccountPicker
                flat
                label={t('cashflow.form.flowDestination')}
                required
                value={dstId}
                groups={dstGroups}
                onChange={setDstId}
                dataUi={UI.cashflow.scheduleFlowDestination}
              />
            </div>
          </div>
        </div>
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
      {discardConfirm}
    </>
  );
}

/* ── 目的別資金の追加シート ── */

function ReserveSheet({
  onClose,
  onSave,
}: {
  onClose: () => void;
  onSave: (input: { name: string; targetAmount?: number; note?: string }) => Promise<void> | void;
}) {
  const [name, setName] = useState('');
  const [targetText, setTargetText] = useState('');
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | undefined>(undefined);
  const [submitting, setSubmitting] = useState(false);

  async function submit() {
    if (name.trim() === '') {
      setError(t('reserves.error.name'));
      return;
    }
    setSubmitting(true);
    const target =
      targetText === '' ? undefined : Number.parseInt(targetText.replace(/[^\d]/g, ''), 10);
    try {
      await onSave({
        name: name.trim(),
        ...(target && target > 0 ? { targetAmount: target } : {}),
        ...(note.trim() !== '' ? { note: note.trim() } : {}),
      });
      onClose(); // 成功時のみ閉じる
    } catch {
      setSubmitting(false); // 保存失敗時は閉じない
    }
  }

  const snapshot = JSON.stringify({ name, targetText, note });
  const initialSnapshotRef = useRef<string | null>(null);
  if (initialSnapshotRef.current === null) initialSnapshotRef.current = snapshot;
  const dirty = snapshot !== initialSnapshotRef.current;
  const { requestClose, discardConfirm } = useDirtyGuard(dirty, onClose);

  return (
    <>
      <Modal
        title={t('reserves.form.title')}
        onClose={requestClose}
        dismissMode="if-clean"
        footer={
          <>
            <button type="button" className="btn btn--ghost" onClick={requestClose}>
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
      {discardConfirm}
    </>
  );
}

function FundingGoalSheet({
  accounts,
  onClose,
  onSave,
}: {
  accounts: Account[];
  onClose: () => void;
  onSave: (input: FundingGoalInput) => Promise<void> | void;
}) {
  const [name, setName] = useState('');
  const [targetText, setTargetText] = useState('');
  const [targetDate, setTargetDate] = useState('');
  const [currentText, setCurrentText] = useState('');
  const [sourceId, setSourceId] = useState('');
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | undefined>(undefined);
  const [submitting, setSubmitting] = useState(false);

  async function submit() {
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
    try {
      await onSave({
        name: name.trim(),
        targetAmount: target,
        targetDate,
        currentAmount: current,
        ...(sourceId !== '' ? { sourceAccountId: sourceId } : {}),
        ...(note.trim() !== '' ? { note: note.trim() } : {}),
      });
      onClose(); // 成功時のみ閉じる
    } catch {
      setSubmitting(false); // 保存失敗時は閉じない
    }
  }

  const snapshot = JSON.stringify({
    name,
    targetText,
    targetDate,
    currentText,
    sourceId,
    note,
  });
  const initialSnapshotRef = useRef<string | null>(null);
  if (initialSnapshotRef.current === null) initialSnapshotRef.current = snapshot;
  const dirty = snapshot !== initialSnapshotRef.current;
  const { requestClose, discardConfirm } = useDirtyGuard(dirty, onClose);

  return (
    <>
      <Modal
        title={t('fundingGoal.form.title')}
        onClose={requestClose}
        dismissMode="if-clean"
        footer={
          <>
            <button type="button" className="btn btn--ghost" onClick={requestClose}>
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
      {discardConfirm}
    </>
  );
}
