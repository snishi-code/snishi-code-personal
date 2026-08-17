/*
 * 資金繰り（将来CF）。**ヘッダーの日付（基準日）を起点に**「自由に動かせるお金」の推移を
 * 投影し、負債の残高と返済予定を**見る**（確認専用）。
 *
 * v13.4 ④（作者決定 2026-08-17）:
 *  - 返済予定の登録・編集（RepaymentScheduleSheet と「返済を登録」導線）は**月割り台帳の
 *    「支払用負債」セクションへ移設**した。この画面の負債行は表示オンリーで、タップは
 *    台帳の該当負債へ遷移するだけ（onOpenAllocations({ liabilityAccountId })）。
 *
 * v13.4 ③（作者決定 2026-08-17）:
 *  - 起点は today ではなく period（ヘッダーの日付）。資金繰りもタイムスリップに追従する。
 *    この画面に「今日」は残らない（返済シートの日付**既定値**だけが today 規約 (a) の例外）。
 *  - 表示終了日の入力欄・設定の既定期間は引退。範囲は右方向の横スクロールで見る
 *    （「さらに先へ」で +12 ヶ月ずつ・上限 = 展開の地平 CONTINUOUS_COST_HARD_CAP）。
 *  - 最低点の金額カードではなく「基準日以降で最初に 0 を下回る日」を出す。
 *  - 負債一覧は基準日断面で残高を持つものだけ（未来に始まるローンは基準日を進めれば現れ、
 *    完済済みは消える）。台帳の「支払用負債」も同じ断面・同じ絞り込みで並ぶ。
 */
import { useMemo, useState } from 'react';
import { Icon } from '@snishi/foundation/ui/Icon';
import { useLedger } from '../../state/store';
import { deriveBalanceSheet, representativeEntryAmount } from '../../domain/accounting';
import {
  cashDeltaOfEntry,
  firstShortfallPoint,
  freeAssetTotal,
  isFreeAsset,
  liabilityScheduleRows,
  projectCashflow,
  uniqueEntriesById,
  type CashflowPoint,
} from '../../domain/cashflow';
import type { ReportPeriod } from '../../domain/reportPeriod';
import { displayEntriesResultForAsOf } from '../../domain/reportEntries';
import { CONTINUOUS_COST_HARD_CAP } from '../../domain/continuousCost';
import { addMonths, addMonthsToDate, monthOf, monthsBetween } from '../../domain/allocation';
import { todayLocal } from '../../util/time';
import { entryOpenPlan } from '../entryOpen';
import type { AllocationsTarget } from './Allocations';
import type { JournalEntry } from '../../domain/types';
import { Money } from '../money';
import { t } from '../../i18n';
import { useMoneyDigits } from '../money';
import { formatMoney } from '../../util/format';
import { UI } from '../../ui-contract';
import { ScrollTopButton } from '../ScrollTopButton';
import { InvestmentProjectionTruncationNotice } from '../components/InvestmentProjectionTruncationNotice';

/** 展開の地平の年（下回り日を探す範囲・グラフを伸ばせる上限）。 */
const HORIZON_YEAR = Number.parseInt(CONTINUOUS_COST_HARD_CAP.slice(0, 4), 10);
/** グラフの窓の初期値と、「さらに先へ」1 回ぶんの伸び（月）。 */
const CHART_STEP_MONTHS = 12;
/** 1 日ぶんの横幅(px)。12 ヶ月 ≒ 730px = 実機幅の 2 画面ぶんで、日次の起伏が潰れない。 */
const CHART_DAY_WIDTH = 2;
const CHART_HEIGHT = 168;
const CHART_PAD_X = 8;
const CHART_PLOT_TOP = 12;
/** これより下は月目盛りのラベル帯。 */
const CHART_PLOT_BOTTOM = 132;

function utcMs(date: string): number {
  const [year, month, day] = date.split('-').map(Number);
  return Date.UTC(year ?? 1970, (month ?? 1) - 1, day ?? 1);
}

/** to − from（日数）。グラフの横位置は「日」で決まる（点の個数では決まらない）。 */
function daysBetween(from: string, to: string): number {
  return Math.round((utcMs(to) - utcMs(from)) / 86_400_000);
}

export function Cashflow({
  period,
  onEditEntry,
  onOpenAllocations,
  onOpenAccount,
  onOpenEntry,
}: {
  /** ヘッダーの日付（基準日の正本）。 */
  period: ReportPeriod;
  onEditEntry: (entry: JournalEntry) => void;
  /** 仕訳タップの行き先（entryOpenPlan の実行先）。仕訳一覧・ホームと同じ resolver。 */
  onOpenAllocations: (target: AllocationsTarget) => void;
  onOpenAccount: (accountId: string) => void;
  onOpenEntry: (entryId: string) => void;
}) {
  const { ledger } = useLedger();

  /*
   * 基準日 = ヘッダーの日付。year / all はヘッダーから選べない休眠モードなので、
   * 期間末 / todayLocal() を**デフォルト値**として置くだけ（today 規約 (a)。表示のアンカーを
   * today にする経路はここには無い）。
   */
  const anchorDate = useMemo(() => {
    const raw =
      period.mode === 'date'
        ? period.date
        : period.mode === 'year'
          ? `${String(period.year).padStart(4, '0')}-12-31`
          : todayLocal();
    return raw < CONTINUOUS_COST_HARD_CAP ? raw : CONTINUOUS_COST_HARD_CAP;
  }, [period]);

  // グラフの窓（基準日から何ヶ月ぶん描くか）。「さらに先へ」で +12 ヶ月・地平で止まる。
  const [windowMonths, setWindowMonths] = useState(CHART_STEP_MONTHS);
  const windowEnd = useMemo(() => {
    const raw = addMonthsToDate(anchorDate, windowMonths);
    return raw < CONTINUOUS_COST_HARD_CAP ? raw : CONTINUOUS_COST_HARD_CAP;
  }, [anchorDate, windowMonths]);
  const canExtend = windowEnd < CONTINUOUS_COST_HARD_CAP;

  const currency = ledger?.settings.currency ?? '';

  /*
   * 導出は**地平まで 1 回だけ**。ここから (a) 基準日断面の残高 (b) 下回り日 (c) グラフの点列
   * (d) 未来の入出金一覧、をすべて派生させる（画面が展開を何度も走らせない）。
   * 展開は保存データだけで決まるので、地平を伸ばしても過去の断面は変わらない
   * （reportEntries.ts の不変則）。
   */
  const display = useMemo(
    () => (ledger ? displayEntriesResultForAsOf(ledger, CONTINUOUS_COST_HARD_CAP) : null),
    [ledger],
  );
  const entries = useMemo(() => display?.entries ?? [], [display]);

  const { projection, liabBalById, freeIds } = useMemo(() => {
    const accounts = ledger?.accounts ?? [];
    const bs = deriveBalanceSheet(accounts, entries, anchorDate);
    const ids = new Set(accounts.filter((a) => isFreeAsset(a)).map((a) => a.id));
    const isFree = (id: string) => ids.has(id);
    const startFree = freeAssetTotal(bs.assets);
    return {
      freeIds: ids,
      liabBalById: new Map(bs.liabilities.map((l) => [l.account.id, l.balance] as const)),
      // 下回り日は地平まで探す（遠い未来の枯渇も見つける）。グラフは窓で切って描く。
      projection: projectCashflow({
        startFree,
        entries,
        anchorDate,
        end: CONTINUOUS_COST_HARD_CAP,
        isFree,
      }),
    };
  }, [ledger, entries, anchorDate]);

  const shortfall = useMemo(() => firstShortfallPoint(projection), [projection]);
  const windowPoints = useMemo(
    () => projection.points.filter((p) => p.date <= windowEnd),
    [projection, windowEnd],
  );

  // 未来の入出金一覧の範囲 = いまグラフを開いている範囲。
  const futureRows = useMemo(() => {
    const isFree = (id: string) => freeIds.has(id);
    return uniqueEntriesById(
      entries.filter(
        (e) =>
          e.date > anchorDate && e.date <= windowEnd && e.lines.some((l) => isFree(l.accountId)),
      ),
    )
      .map((e) => ({
        id: e.id,
        date: e.date,
        title: e.description,
        delta: cashDeltaOfEntry(e, isFree),
        // 仕訳の代表額は domain が正本。useMemo = render 相当なので、投げない方を使う。
        amount: representativeEntryAmount(e),
        entry: e,
      }))
      .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  }, [entries, anchorDate, windowEnd, freeIds]);

  /*
   * 負債一覧は**基準日断面**で導出残高 ≠ 0 のものだけ（domain の単一正本
   * liabilityScheduleRows。月割り台帳の「支払用負債」と同じ行集合が並ぶ）。
   */
  const liabilitySummary = useMemo(
    () =>
      liabilityScheduleRows({
        accounts: ledger?.accounts ?? [],
        storedEntries: ledger?.journalEntries ?? [],
        balanceById: liabBalById,
        asOf: anchorDate,
      }),
    [ledger, liabBalById, anchorDate],
  );

  return (
    <section aria-labelledby="cashflow-title" data-ui={UI.cashflow.view}>
      <h1 className="screen-title" id="cashflow-title">
        {t('cashflow.title')}
      </h1>
      <p className="field__hint" style={{ marginBottom: 'var(--space-3)' }}>
        {t('cashflow.intro')}
      </p>

      <InvestmentProjectionTruncationNotice
        truncations={display?.investmentProjectionTruncations ?? []}
        accounts={ledger?.accounts ?? []}
      />

      <div className="stat-grid stat-grid--single" data-ui={UI.cashflow.summary}>
        <div className="stat">
          <span className="stat__label">{t('cashflow.freeFundsAsOf', { date: anchorDate })}</span>
          <span className="stat__value">
            <Money amount={projection.startFree} currency={currency} signed />
          </span>
        </div>
      </div>

      {/*
       * 最低点の金額ではなく「いつ足りなくなるか」を出す。下回りが無いときは静かな 1 行
       * （警告色を使わない）＝ 警告灯が常時点いている画面にしない。
       */}
      {shortfall ? (
        <div className="banner" role="alert" data-ui={UI.cashflow.shortfall}>
          <Icon name="alert" size={18} />
          {t('cashflow.shortfallOn', { date: shortfall.date })}
        </div>
      ) : (
        <p className="field__hint" data-ui={UI.cashflow.shortfall}>
          {t('cashflow.shortfallNone', { year: HORIZON_YEAR })}
        </p>
      )}

      <FreeFundsChart
        anchorDate={anchorDate}
        endDate={windowEnd}
        points={windowPoints}
        shortfall={shortfall}
        currency={currency}
      />
      {canExtend ? (
        <button
          type="button"
          className="btn"
          onClick={() => setWindowMonths((m) => m + CHART_STEP_MONTHS)}
          data-ui={UI.cashflow.chartExtend}
        >
          {t('cashflow.chartExtend', { months: CHART_STEP_MONTHS })}
        </button>
      ) : (
        <p className="field__hint">{t('cashflow.chartAtHorizon', { year: HORIZON_YEAR })}</p>
      )}

      <p className="section-label">{t('cashflow.debtTitle')}</p>
      <p className="field__hint" style={{ marginBottom: 'var(--space-2)' }}>
        {t('cashflow.debtIntro')}
      </p>
      {liabilitySummary.length === 0 ? (
        <div className="card card--pad empty">{t('repay.none')}</div>
      ) : (
        <ul className="card list" data-ui={UI.cashflow.liabilityList}>
          {liabilitySummary.map((l) => (
            <li key={l.id} className="list__row">
              {/*
               * 行は**表示オンリー**（v13.4 ④）。タップ = 月割り台帳の同じ負債へ移動するだけで、
               * この画面から返済を書き込む経路は無い（読み上げ名も行き先を名乗る）。
               * 高さは .list__row-btn の min-height = var(--tap)（44px）。
               */}
              <button
                type="button"
                className="list__row-btn"
                onClick={() => onOpenAllocations({ liabilityAccountId: l.id })}
                aria-label={t('cashflow.debtOpenInAllocations', { name: l.name })}
                data-ui={UI.cashflow.liabilityRow}
              >
                <div className="list__main">
                  <div className="list__title">{l.name}</div>
                  <div className="list__sub">
                    {/* 負債残高は専用トークンの色（C-2）。絶対値表示のままで符号は付けない。 */}
                    {t('repay.balance')}:{' '}
                    <Money amount={l.balance} currency={currency} tone="liability" />
                  </div>
                  {l.count > 0 ? (
                    <div className="list__sub">
                      {t('repay.nextDue')}: {l.nextDue ?? '—'}・
                      {t('repay.installmentsLeft', { count: l.count })}・{t('repay.balance')}{' '}
                      <Money amount={l.remaining} currency={currency} />
                    </div>
                  ) : (
                    <div className="list__sub amount--neg">{t('cashflow.debtNoPlan')}</div>
                  )}
                </div>
                <Icon name="chevronRight" size={18} />
              </button>
            </li>
          ))}
        </ul>
      )}

      <p className="section-label">{t('cashflow.futureTitle')}</p>
      <p className="field__hint" style={{ marginBottom: 'var(--space-2)' }}>
        {t('cashflow.futureIntro', { from: anchorDate, to: windowEnd })}
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
                        : // 補正は按分スライスなので、開くのは宣言した stored の pin。
                          plan.kind === 'adjustment'
                          ? () => onOpenEntry(plan.entryId)
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

      <ScrollTopButton />
    </section>
  );
}

/**
 * 「自由に動かせるお金」の日次折れ線（基準日起点・右方向へ横スクロール）。
 *
 * 残高は**階段関数**（動いた日だけ変わる）なので、点と点を斜めに結ばず次の変化日まで
 * 水平に引く。横位置は日数に比例させる（点の個数では決めない）ので、間隔の空いた区間が
 * 詰まって見えない。基準日より過去へは遡らない（過去はヘッダーの日付を戻して見る）。
 *
 * v13.5 で時間平面へ統合する予定なので、TimelineCalendar との共通化はまだしない。
 */
function FreeFundsChart({
  anchorDate,
  endDate,
  points,
  shortfall,
  currency,
}: {
  anchorDate: string;
  endDate: string;
  points: CashflowPoint[];
  shortfall: CashflowPoint | null;
  currency: string;
}) {
  const digits = useMoneyDigits();
  const span = Math.max(1, daysBetween(anchorDate, endDate));
  const width = CHART_PAD_X * 2 + span * CHART_DAY_WIDTH;
  const xOf = (date: string): number =>
    CHART_PAD_X + Math.min(span, Math.max(0, daysBetween(anchorDate, date))) * CHART_DAY_WIDTH;

  const values = points.map((p) => p.free);
  const lowest = values.reduce((m, v) => Math.min(m, v), values[0] ?? 0);
  const highest = values.reduce((m, v) => Math.max(m, v), values[0] ?? 0);
  // 0 は必ず目盛りに入れる（「足りているか」が読み取れる縦軸にする）。
  const top = Math.max(0, highest);
  const bottom = Math.min(0, lowest);
  const range = top - bottom || 1;
  const plotH = CHART_PLOT_BOTTOM - CHART_PLOT_TOP;
  const yOf = (value: number): number => CHART_PLOT_TOP + ((top - value) / range) * plotH;

  const line: string[] = [];
  let previousY = yOf(points[0]?.free ?? 0);
  line.push(`${xOf(anchorDate)},${previousY}`);
  for (const point of points.slice(1)) {
    const x = xOf(point.date);
    line.push(`${x},${previousY}`);
    previousY = yOf(point.free);
    line.push(`${x},${previousY}`);
  }
  line.push(`${width - CHART_PAD_X},${previousY}`);

  // 月目盛り。窓が長いほど間引く（74 年ぶんのラベルを全部描かない）。
  const totalMonths = monthsBetween(monthOf(anchorDate), monthOf(endDate));
  const tickStep = totalMonths <= 18 ? 1 : totalMonths <= 60 ? 3 : totalMonths <= 240 ? 12 : 60;
  const ticks: { key: string; x: number; label: string }[] = [];
  for (let i = 0; i <= totalMonths; i += tickStep) {
    const month = addMonths(monthOf(anchorDate), i);
    const date = `${month}-01`;
    if (date < anchorDate || date > endDate) continue;
    const [year, mm] = month.split('-');
    ticks.push({
      key: month,
      x: xOf(date),
      label:
        tickStep >= 12 || mm === '01'
          ? t('cashflow.chartTickYear', { year: Number.parseInt(year ?? '0', 10) })
          : t('cashflow.chartTickMonth', { month: Number.parseInt(mm ?? '0', 10) }),
    });
  }

  const marker = shortfall !== null && shortfall.date >= anchorDate && shortfall.date <= endDate;

  return (
    <figure className="cashflow-chart" data-ui={UI.cashflow.freeTrend}>
      <figcaption className="section-label">
        {t('cashflow.chartTitle', { from: anchorDate, to: endDate })}
      </figcaption>
      <div className="cashflow-chart__viewport" data-ui={UI.cashflow.chartViewport}>
        <svg
          className="cashflow-chart__svg"
          width={width}
          height={CHART_HEIGHT}
          viewBox={`0 0 ${width} ${CHART_HEIGHT}`}
          aria-hidden="true"
          focusable="false"
        >
          <line
            className="cashflow-chart__zero"
            x1={CHART_PAD_X}
            x2={width - CHART_PAD_X}
            y1={yOf(0)}
            y2={yOf(0)}
          />
          {ticks.map((tick) => (
            <g key={tick.key}>
              <line
                className="cashflow-chart__gridline"
                x1={tick.x}
                x2={tick.x}
                y1={CHART_PLOT_TOP}
                y2={CHART_PLOT_BOTTOM}
              />
              <text className="cashflow-chart__tick" x={tick.x + 2} y={CHART_HEIGHT - 8}>
                {tick.label}
              </text>
            </g>
          ))}
          <polyline className="cashflow-chart__line" points={line.join(' ')} />
          {marker ? (
            <>
              <line
                className="cashflow-chart__shortfall"
                x1={xOf(shortfall.date)}
                x2={xOf(shortfall.date)}
                y1={CHART_PLOT_TOP}
                y2={CHART_PLOT_BOTTOM}
              />
              <circle
                className="cashflow-chart__shortfall-dot"
                cx={xOf(shortfall.date)}
                cy={yOf(shortfall.free)}
                r={3.5}
              />
            </>
          ) : null}
        </svg>
      </div>
      <p className="sr-only">
        {t('cashflow.chartSummary', {
          from: anchorDate,
          start: formatMoney(points[0]?.free ?? 0, currency, digits),
          to: endDate,
          end: formatMoney(points.at(-1)?.free ?? 0, currency, digits),
          low: formatMoney(lowest, currency, digits),
        })}
      </p>
      <p className="cashflow-chart__end muted">
        {t('cashflow.chartEnd', { date: endDate })}
        <Money amount={points.at(-1)?.free ?? 0} currency={currency} signed />
      </p>
    </figure>
  );
}
