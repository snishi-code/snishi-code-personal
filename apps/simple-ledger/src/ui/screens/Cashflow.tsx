/*
 * 資金繰り（将来CF）。**ヘッダーの日付（基準日）を起点に**「自由に動かせるお金」の推移を
 * 投影し、負債の残高と返済予定を**見る**（確認専用）。
 *
 * v13.6 H4（作者確定 2026-08-18）:
 *  - 負債行は表示オンリーのまま、タップ先を**ルールの有無**で振り分ける:
 *    返済ルールを持つローン → 月割り台帳の該当行 / それ以外（クレカ等）→ 勘定科目。
 *  - 返済の正本は台帳のルール。この画面から返済を書き込む経路は無い（v13.4 ④ の
 *    「支払用負債」セクションと返済シートは v13.6 H4 で撤去した）。
 *
 * v13.4 ③（作者決定 2026-08-17）:
 *  - 起点は today ではなく period（ヘッダーの日付）。資金繰りもタイムスリップに追従する。
 *    この画面に「今日」は残らない。
 *  - 表示終了日の入力欄・設定の既定期間は引退。範囲は右方向の横スクロールで見る
 *    （「さらに先へ」で +12 ヶ月ずつ・上限 = 展開の地平 CONTINUOUS_COST_HARD_CAP）。
 *  - 最低点の金額カードではなく「基準日以降で最初に 0 を下回る日」を出す。
 *  - 負債一覧は基準日断面で残高を持つものだけ（未来に始まるローンは基準日を進めれば現れ、
 *    完済済みは消える）。
 */
import { useMemo, useState } from 'react';
import { Icon } from '@snishi/foundation/ui/Icon';
import { useLedger } from '../../state/store';
import { deriveBalanceSheet, representativeEntryAmount } from '../../domain/accounting';
import {
  cashDeltaOfEntry,
  cashflowWindowEnd,
  firstShortfallPoint,
  foldCashflowPoints,
  freeAssetTotal,
  isFreeAsset,
  liabilityScheduleRows,
  projectCashflow,
  uniqueEntriesById,
  type CashflowPoint,
} from '../../domain/cashflow';
import type { TimelineZoom } from '../../domain/timelineCalendar';
import type { ReportPeriod } from '../../domain/reportPeriod';
import { displayEntriesResultForAsOf } from '../../domain/reportEntries';
import { CONTINUOUS_COST_HARD_CAP } from '../../domain/continuousCost';
import { addMonths, monthOf, monthsBetween } from '../../domain/allocation';
import {
  loanItemForLiability,
  loanItemRemainingInstallments,
  loanRepaymentSchedule,
  loanSettledAmountsByItem,
  loanSpreadTotalOf,
} from '../../domain/loan';
import { todayLocal } from '../../util/time';
import { entryOpenPlan } from '../entryOpen';
import type { AllocationsTarget } from './Allocations';
import type { JournalEntry } from '../../domain/types';
import { Money, moneyText } from '../money';
import { t } from '../../i18n';
import { useMoneyDigits } from '../money';
import { formatMoney } from '../../util/format';
import { UI } from '../../ui-contract';
import { ScrollTopButton } from '../ScrollTopButton';

/** 展開の地平の年（下回り日を探す範囲・グラフを伸ばせる上限）。 */
const HORIZON_YEAR = Number.parseInt(CONTINUOUS_COST_HARD_CAP.slice(0, 4), 10);
/**
 * ズームごとの窓（初期値 = 「さらに先へ」1 回ぶんの伸び・月数）と 1 日ぶんの横幅(px)。
 * どのズームでも窓 1 つぶんが ≒ 730px（実機幅の 2 画面ぶん）になるよう幅を決める:
 * 起伏が潰れず、かつ横に無限に伸びない。
 *  - 日 = 日繰り表（12 ヶ月）/ 月 = 月次資金繰り表（18 ヶ月）/ 年 = 年次計画（10 年）。
 */
const CHART_ZOOM: Record<TimelineZoom, { stepMonths: number; dayWidth: number }> = {
  day: { stepMonths: 12, dayWidth: 2 },
  month: { stepMonths: 18, dayWidth: 1.3 },
  year: { stepMonths: 120, dayWidth: 0.2 },
};
/** 月次純増減の副表示を出す上限（これを超えると数字が重なって読めない）。 */
const CHART_DELTA_MAX_POINTS = 24;
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
  zoom,
  onEditEntry,
  onOpenAllocations,
  onOpenAccount,
  onOpenEntry,
}: {
  /** ヘッダーの日付（基準日の正本）。 */
  period: ReportPeriod;
  /**
   * ヘッダーのズーム（日/月/年）。資金繰りもウィンドウ世界なので**グラフの粒度が追従する**
   * （v13.5 F）。投影と下回り日の探索は常に日次のままで、変わるのは描く点だけ。
   */
  zoom: TimelineZoom;
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

  // グラフの窓（基準日から何ヶ月ぶん描くか）。「さらに先へ」で 1 段ぶん伸び、地平で止まる。
  // ズームが変わると窓の尺そのものが変わるので、そのズームの 1 段へ戻す
  // （render 中の派生調整パターン。effect での setState を避ける）。
  const step = CHART_ZOOM[zoom];
  const [windowMonths, setWindowMonths] = useState(step.stepMonths);
  const [trackedZoom, setTrackedZoom] = useState(zoom);
  if (trackedZoom !== zoom) {
    setTrackedZoom(zoom);
    setWindowMonths(step.stepMonths);
  }
  const windowEnd = useMemo(
    () =>
      cashflowWindowEnd({
        anchorDate,
        months: windowMonths,
        zoom,
        cap: CONTINUOUS_COST_HARD_CAP,
      }),
    [anchorDate, windowMonths, zoom],
  );
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

  // 下回り日は**日次の投影**から出す（グラフをどの粒度で描いても探索の精度は落とさない）。
  const shortfall = useMemo(() => firstShortfallPoint(projection), [projection]);
  // グラフに描く点だけをズームの粒度へ畳む（日 = 日次 / 月 = 月末 / 年 = 年末）。
  const windowPoints = useMemo(
    () => foldCashflowPoints({ projection, anchorDate, endDate: windowEnd, zoom }),
    [projection, anchorDate, windowEnd, zoom],
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
   * liabilityScheduleRows）。ここには**ルールを持たない負債も出る**（クレカ・手動返済
   * だけの既存ローン）。台帳に出るのはルールを持つものだけ、という区別との違いが要点。
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
        zoom={zoom}
      />
      {canExtend ? (
        <button
          type="button"
          className="btn"
          onClick={() => setWindowMonths((m) => m + step.stepMonths)}
          data-ui={UI.cashflow.chartExtend}
        >
          {t('cashflow.chartExtend', { months: step.stepMonths })}
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
          {liabilitySummary.map((l) => {
            /*
             * 行は**表示オンリー**（v13.4 ④）。タップ先は**ローン item の有無**で振り分ける
             * （v13.13: 区別はルールの有無 → item の有無へ）:
             *  - ローン item を持つ負債 → 月割り台帳の**そのカード**（返済の正本は item）
             *  - item を持たない負債（クレカ等）→ **勘定科目**のその科目
             *    （台帳に居ないものを台帳へ送らない = 空振りする導線を作らない）
             * 高さは .list__row-btn の min-height = var(--tap)（44px）。
             */
            const loanItem = loanItemForLiability(ledger?.monthlyCostItems ?? [], l.id);
            // 次回支払日・残回数は item の刻みから引く（返済は導出 = 保存仕訳に無い・§2.3）。
            const loanSpread = loanItem
              ? loanSpreadTotalOf(loanItem, loanSettledAmountsByItem(ledger?.journalEntries ?? []))
              : 0;
            const loanNextDue = loanItem
              ? loanRepaymentSchedule(loanItem, loanSpread).find(
                  (cut) => cut.date > anchorDate && cut.amount !== 0,
                )?.date
              : undefined;
            const loanCount = loanItem
              ? loanItemRemainingInstallments(loanItem, anchorDate, loanSpread)
              : 0;
            return (
              <li key={l.id} className="list__row">
                <button
                  type="button"
                  className="list__row-btn"
                  onClick={() =>
                    loanItem ? onOpenAllocations({ liabilityAccountId: l.id }) : onOpenAccount(l.id)
                  }
                  aria-label={t(
                    loanItem ? 'cashflow.debtOpenInAllocations' : 'cashflow.debtOpenInAccounts',
                    { name: l.name },
                  )}
                  data-ui={UI.cashflow.liabilityRow}
                  data-account-id={l.id}
                >
                  <div className="list__main">
                    <div className="list__title">{l.name}</div>
                    <div className="list__sub">
                      {/* 負債残高は専用トークンの色（C-2）。絶対値表示のままで符号は付けない。 */}
                      {t('repay.balance')}:{' '}
                      <Money amount={l.balance} currency={currency} tone="liability" />
                    </div>
                    {loanItem ? (
                      loanCount > 0 ? (
                        <div className="list__sub">
                          {t('repay.nextDue')}: {loanNextDue ?? '—'}・
                          {t('repay.installmentsLeft', { count: loanCount })}
                        </div>
                      ) : null
                    ) : l.count > 0 ? (
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
            );
          })}
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
                {/*
                 * 方向は**色 + 言葉**で言う（v13.6 H2-2・作者確定 2026-08-18）。
                 * 数字は絶対値のままで、+ / − の符号は付けない: 符号は「フローが負の量である」
                 * という別の主張になり、赤 = 出金の色の意味論と二重に方向を語るため。
                 * 色だけに頼らないぶんは sr-only の「入金 / 出金 / 増減なし」が引き受ける
                 * （仕訳一覧・月割り台帳と同じ作法。docs/dev/ledger-ui-ux.md）。
                 * 上部の残高（自由に動かせるお金）はストックなので signed のまま = ここだけの規約。
                 */}
                <span
                  className={`list__amount ${
                    f.delta > 0 ? 'amount--pos' : f.delta < 0 ? 'amount--neg' : 'muted'
                  }`}
                >
                  <span className="sr-only">
                    {f.delta > 0
                      ? t('cashflow.futureInflow')
                      : f.delta < 0
                        ? t('cashflow.futureOutflow')
                        : t('cashflow.futureNoChange')}
                  </span>
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
 * 「自由に動かせるお金」の折れ線（基準日起点・右方向へ横スクロール）。
 *
 * 残高は**階段関数**（動いた日だけ変わる）なので、点と点を斜めに結ばず次の点まで
 * 水平に引く。横位置は日数に比例させる（点の個数では決めない）ので、間隔の空いた区間が
 * 詰まって見えない。基準日より過去へは遡らない（過去はヘッダーの日付を戻して見る）。
 *
 * 点の粒度はヘッダーのズームが決める（日 = 日次 / 月 = 月末 / 年 = 年末。畳むのは
 * `foldCashflowPoints`）。月ズームでは**月次純増減**を副表示する（2 軸は持たない。
 * 前の点との差を各点に添えるだけ）。下回り日の縦線は畳んだ点ではなく日次の探索結果なので、
 * どのズームでも同じ日を指す。
 *
 * v13.5 で時間平面へ統合する予定なので、TimelineCalendar との共通化はまだしない。
 */
function FreeFundsChart({
  anchorDate,
  endDate,
  points,
  shortfall,
  currency,
  zoom,
}: {
  anchorDate: string;
  endDate: string;
  points: CashflowPoint[];
  shortfall: CashflowPoint | null;
  currency: string;
  zoom: TimelineZoom;
}) {
  const digits = useMoneyDigits();
  const dayWidth = CHART_ZOOM[zoom].dayWidth;
  const span = Math.max(1, daysBetween(anchorDate, endDate));
  const width = CHART_PAD_X * 2 + span * dayWidth;
  const xOf = (date: string): number =>
    CHART_PAD_X + Math.min(span, Math.max(0, daysBetween(anchorDate, date))) * dayWidth;

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

  /*
   * 月次純増減の副表示（月ズームのみ）。前の点との差なので、月末残高の列だけで完結する
   * （軸を増やさない）。点が多すぎると数字が重なって読めないので上限を置く。
   */
  const deltas =
    zoom === 'month' && points.length <= CHART_DELTA_MAX_POINTS
      ? points.slice(1).map((point, index) => ({
          date: point.date,
          amount: point.free - (points[index]?.free ?? 0),
          x: xOf(point.date),
          y: yOf(point.free),
        }))
      : [];

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
          {deltas.map((delta) => (
            <text
              key={delta.date}
              className={`cashflow-chart__delta ${
                delta.amount > 0
                  ? 'cashflow-chart__delta--pos'
                  : delta.amount < 0
                    ? 'cashflow-chart__delta--neg'
                    : ''
              }`}
              x={delta.x}
              y={Math.max(9, delta.y - 6)}
              textAnchor="middle"
            >
              {moneyText(delta.amount, currency, digits, true)}
            </text>
          ))}
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
      <p className="sr-only" data-ui={UI.cashflow.chartSummary}>
        {t('cashflow.chartSummary', {
          from: anchorDate,
          start: formatMoney(points[0]?.free ?? 0, currency, digits),
          to: endDate,
          end: formatMoney(points.at(-1)?.free ?? 0, currency, digits),
          low: formatMoney(lowest, currency, digits),
        })}
        {/* SVG は aria-hidden なので、副表示の数字も読み上げに出す（見える情報と揃える）。 */}
        {deltas.map((delta) => (
          <span key={delta.date}>
            {t('cashflow.chartMonthlyDelta', {
              date: delta.date,
              amount: moneyText(delta.amount, currency, digits, true),
            })}
          </span>
        ))}
      </p>
      <p className="cashflow-chart__end muted">
        {t('cashflow.chartEnd', { date: endDate })}
        <Money amount={points.at(-1)?.free ?? 0} currency={currency} signed />
      </p>
    </figure>
  );
}
