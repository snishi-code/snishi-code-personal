/*
 * 資金繰り（将来CF）。planned な予定・未来日付の仕訳から自由資金の推移・最低残高を投影し、
 * 取り置き資金（取り置き枠）の管理を行う。入力はホームに一本化し、この画面は確認専用。
 * 「いつ費用認識するか(按分)」とは別概念で、「いつ現金が動くか」を扱う。
 *
 * 表示終了日（任意の日付）まで投影する。取り置き資金は「資金目標」を統合した枠で、任意の
 * 目標額・目標日から必要な毎月の積立額を出す（現在額は口座残高から自動）。
 */
import { useMemo, useState } from 'react';
import { useLedger } from '../../state/store';
import { deriveBalanceSheet } from '../../domain/accounting';
import { cashDeltaOfEntry, liquidAssetTotal, projectCashflow } from '../../domain/cashflow';
import { continuousCostEntries } from '../../domain/continuousCost';
import { goalRequiredMonthly, reserveRequiredMonthly } from '../../domain/fundingGoal';
import { addMonthsToDate } from '../../domain/allocation';
import { currentYearMonth, todayLocal } from '../../util/time';
import type { CashflowSchedule, FundingGoal, ReserveItem } from '../../domain/types';
import { TextInput } from '../Field';
import { ReserveSheet } from '../ReserveSheet';
import { ConfirmDialog } from '../ConfirmDialog';
import { Money } from '../money';
import { Icon } from '../Icon';
import { TrendChart, type TrendPoint } from '../components/TrendChart';
import { t } from '../../i18n';
import { UI } from '../../ui-contract';

function shortDateLabel(date: string): string {
  const [, month, day] = date.split('-');
  if (!month || !day) return date;
  return `${Number.parseInt(month, 10)}/${Number.parseInt(day, 10)}`;
}

export function Cashflow() {
  const { ledger, postSchedule, removeSchedule, createReserve, removeReserve, removeFundingGoal } =
    useLedger();
  const today = todayLocal();
  const [untilDate, setUntilDate] = useState(() => addMonthsToDate(todayLocal(), 6));
  const [reserveOpen, setReserveOpen] = useState(false);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [pendingSchedule, setPendingSchedule] = useState<CashflowSchedule | null>(null);
  const [pendingReserve, setPendingReserve] = useState<ReserveItem | null>(null);
  const [pendingGoal, setPendingGoal] = useState<FundingGoal | null>(null);

  const { year, month } = currentYearMonth();
  const currentYm = `${year}-${String(month).padStart(2, '0')}`;
  const returnBps = ledger?.settings.expectedAnnualReturnBps ?? 0;
  const goals = ledger?.fundingGoals ?? [];

  const currency = ledger?.settings.currency ?? 'JPY';

  const { projection, balById, liabBalById, futureRows } = useMemo(() => {
    const accounts = ledger?.accounts ?? [];
    // 現在残高は導出専用 entries（実仕訳 + 継続コストの仮想funding/認識）で見る
    // （現金払いの継続コストは funding で資金が減る）。
    const entries = ledger?.derivedEntries ?? [];
    const items = ledger?.monthlyCostItems ?? [];
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
    // 取り置き（reserve-asset）だけの集合。未来日の取り置き移動で自由資金を正しく動かすため。
    const reserveIds = new Set(accounts.filter((a) => a.role === 'reserve-asset').map((a) => a.id));
    const isReserve = (id: string) => reserveIds.has(id);
    // liquidAssetTotal は「除外集合」を取るので、流動でない資産科目を除外として渡す。
    const nonLiquidAssetIds = new Set(
      bs.assets.map((a) => a.account.id).filter((id) => !liquidIds.has(id)),
    );
    const totalAssets = liquidAssetTotal(bs.assets, nonLiquidAssetIds);
    const reserveBalance = reserves.reduce((s, r) => s + (byId.get(r.reserveAccountId) ?? 0), 0);
    // 未来日付（date > today）の仕訳で現金が動くもの = CF に取り込む（ホーム入力が自然に反映される）。
    // delta=総資金の純増減（資金↔資金/資金↔取り置きの振替は 0）、reserveDelta=取り置き残高の純増減
    //（普通預金→取り置き資金 なら +amount で自由資金が減る）、amount=一覧表示用の取引金額（借方合計）。
    const end = untilDate;
    // 未来の継続更新（funding 仮想仕訳・date>today）を untilDate まで投影に取り込む
    //（永続仕訳は作らず、辞書展開で必要範囲だけ）。現金払いの更新は自由資金を減らす。
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
      balById: byId,
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
  const freeTrend: TrendPoint[] = projection.points.map((p, i) => ({
    key: `${p.date}-${i}`,
    label: shortDateLabel(i === 0 ? today : p.date),
    value: p.free,
  }));

  // 支払用負債の集約: 負債ごとに 残高 + 未実績の返済予定（次回支払日・残額・件数）を見せる。
  // 予定が無くても残高がある負債は「返済予定が未登録」として注意表示する。
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

      {/* 自由資金の推移（ストックなので折れ線で俯瞰する） */}
      {freeTrend.length > 1 ? (
        <TrendChart
          title={t('cashflow.freeTrendTitle')}
          data={freeTrend}
          currency={currency}
          variant="line"
          dataUi={UI.cashflow.freeTrend}
        />
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

      {/* 未来の入出金・振替予定（ホーム入力が自然に反映される。CF は確認専用で入力欄は持たない）。 */}
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
                {/* 振替（delta=0）は取引金額 amount を中立表示。入出金は純増減の絶対値を出す。 */}
                <Money amount={f.delta === 0 ? f.amount : Math.abs(f.delta)} currency={currency} />
              </span>
            </li>
          ))}
        </ul>
      )}

      {/* 分割・定期の予定（読み取り専用）。継続コストの負債払い・借入の分割返済から生成される。 */}
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
                <Icon name="trash" size={18} />
              </button>
            </li>
          ))}
        </ul>
      )}

      {/* 取り置き資金・資金目標（補助情報・下部に畳む） */}
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

          {/* 取り置き資金（任意で目標額・目標日。現在額は口座残高から自動・必要月額を表示） */}
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
              {reserves.map((r) => {
                const balance = balById.get(r.reserveAccountId) ?? 0;
                const required = reserveRequiredMonthly(r, balance, currentYm, returnBps);
                return (
                  <li key={r.id} className="list__item">
                    <div className="list__main">
                      <div className="list__title">{r.name}</div>
                      <div className="list__sub">
                        {t('reserves.balance')}: <Money amount={balance} currency={currency} />
                        {r.targetAmount !== undefined
                          ? `（${t('reserves.targetOf', { target: r.targetAmount.toLocaleString('ja-JP') })}${
                              r.targetDate ? `・${r.targetDate}` : ''
                            }）`
                          : ''}
                      </div>
                      {r.targetAmount !== undefined && r.targetDate !== undefined ? (
                        <div className="list__sub">
                          {t('reserves.requiredMonthly')}:{' '}
                          <Money amount={required} currency={currency} />
                        </div>
                      ) : null}
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
                );
              })}
            </ul>
          )}

          {/* 資金目標（旧概念・読み取り専用）。新規は取り置き資金へ統合。残データの確認/削除のみ。 */}
          {goals.length > 0 ? (
            <>
              <p className="section-label">{t('fundingGoal.title')}</p>
              <p className="field__hint" style={{ marginBottom: 'var(--space-2)' }}>
                {t('fundingGoal.legacyHint')}
              </p>
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
            </>
          ) : null}
        </div>
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
