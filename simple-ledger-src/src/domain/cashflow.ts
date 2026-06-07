/*
 * 予定キャッシュフロー（将来の現金の出入り）の投影と実績化。
 *
 * 「いつ費用認識するか(allocation)」とは独立に、「いつ現金が動くか」を扱う。
 *  - planned な CashflowSchedule を期日順に適用し、将来残高・最低残高を投影する。
 *  - 目的別資金(reserve)の残高は「自由資金」から除外する（総資金は変えない）。
 *  - 実績化は 1 件の 2 行仕訳を作る（複合仕訳にしない）。保存は repository（単一 transaction）。
 */
import { newId } from './ids';
import { nowIso } from '../util/time';
import { LedgerError } from './errors';
import { addMonths, addMonthsToDate, monthOf, monthlyAmounts } from './allocation';
import type {
  Account,
  AccountBalance,
  CashflowDirection,
  CashflowSchedule,
  JournalEntry,
} from './types';

/**
 * 返済予定（分割）を生成する。返済元 daily-asset → 負債（counter）への outflow を回数分。
 * 金額は monthlyAmounts で配分し、合計が total に一致する。初回返済日から毎月 1 件。
 * 借入実行（負債→資金）の振替と一緒に登録するのが主用途。
 *
 * 現状は **元本のみ** の単純配分（利息は考慮しない）。将来的に利息概念を入れる余地を残す:
 *  - `total` を「総返済額（元本+利息）」とし、利息分を利息費用科目へ振り替える実績化に拡張する、
 *    もしくは params に `interestAccountId` / `principalTotal` を足して各回を
 *    `元本→負債 + 利息→費用` の複数行で表現する想定。今は呼び出し側が元本=total を渡す。
 */
export function buildRepaymentSchedules(params: {
  title: string;
  total: number;
  count: number;
  firstDueDate: string;
  /** 返済元（現金が出ていく daily-asset）。 */
  fromAccountId: string;
  /** 返済先の負債科目（counterAccountId）。 */
  liabilityAccountId: string;
  /** どの管理区分の予定か。 */
  managementScopeId: string;
}): CashflowSchedule[] {
  const ts = nowIso();
  const parts = monthlyAmounts(params.total, params.count);
  return Array.from({ length: params.count }, (_, i) => ({
    id: newId(),
    title: `${params.title} 返済 ${i + 1}/${params.count}`,
    dueDate: addMonthsToDate(params.firstDueDate, i),
    amount: parts[i] ?? 0,
    direction: 'outflow' as const,
    accountId: params.fromAccountId,
    counterAccountId: params.liabilityAccountId,
    source: 'installment' as const,
    status: 'planned' as const,
    managementScopeId: params.managementScopeId,
    createdAt: ts,
    updatedAt: ts,
  }));
}

/**
 * 予定 CF の「源泉 → 行き先」(A → B) から、保存する {現金が動く口座 accountId / 相手 counter /
 * 入金 or 出金 direction} を role から推定する。日常入力と同じ A → B 形にするための変換。
 *  - 収入カテゴリ → 日常資産: 入金(inflow)。現金が動くのは日常資産。
 *  - 日常資産 → 費用カテゴリ: 出金(outflow)。
 *  - 日常資産 → 支払用負債: 返済/支払い(outflow)。
 *  - 日常資産 → 日常資産: 口座間移動(transfer)。自由資金の総額は変えない。
 *    accountId=移動元、counterAccountId=移動先。実績化は 借方 移動先 / 貸方 移動元。
 * 上記以外（負債→費用など現金移動が一意でない組み合わせ）は推定不能として null。
 */
export function inferScheduleFlow(
  src: Account,
  dst: Account,
): { accountId: string; counterAccountId: string; direction: CashflowDirection } | null {
  if (src.role === 'income-category' && dst.role === 'daily-asset')
    return { accountId: dst.id, counterAccountId: src.id, direction: 'inflow' };
  if (
    src.role === 'daily-asset' &&
    (dst.role === 'expense-category' || dst.role === 'payment-liability')
  )
    return { accountId: src.id, counterAccountId: dst.id, direction: 'outflow' };
  if (src.role === 'daily-asset' && dst.role === 'daily-asset')
    return { accountId: src.id, counterAccountId: dst.id, direction: 'transfer' };
  return null;
}

/**
 * 資金繰りの「総資金」= 流動資産のみ。按分中資産・固定資産・投資など、現金化を伴わない
 * asset は除外する（excludedAccountIds で指定）。目的別資金は流動なので含める（自由資金で控除）。
 */
export function liquidAssetTotal(
  assets: AccountBalance[],
  excludedAccountIds: Set<string>,
): number {
  return assets
    .filter((a) => !excludedAccountIds.has(a.account.id))
    .reduce((s, a) => s + a.balance, 0);
}

/**
 * 予定 CF を実績化する仕訳。
 *  - outflow（現金が出ていく）/ transfer（口座間移動）: 借方 counter / 貸方 account
 *  - inflow（現金が入る）:                              借方 account / 貸方 counter
 * transfer は accountId=移動元 / counterAccountId=移動先 なので、借方 移動先 / 貸方 移動元 になる。
 */
export function buildScheduleEntry(schedule: CashflowSchedule): JournalEntry {
  if (!schedule.counterAccountId) {
    throw new LedgerError('error.schedule.counterRequired');
  }
  const ts = nowIso();
  const asset = schedule.accountId;
  const counter = schedule.counterAccountId;
  const debit = schedule.direction === 'inflow' ? asset : counter;
  const credit = schedule.direction === 'inflow' ? counter : asset;
  return {
    id: newId(),
    date: schedule.dueDate,
    description: schedule.title,
    kind: 'normal',
    managementScopeId: schedule.managementScopeId,
    lines: [
      { accountId: debit, side: 'debit', amount: schedule.amount },
      { accountId: credit, side: 'credit', amount: schedule.amount },
    ],
    metadata: { inputMode: 'manual' },
    ...(schedule.entryTagIds?.length ? { tagIds: schedule.entryTagIds } : {}),
    createdAt: ts,
    updatedAt: ts,
  };
}

export interface CashflowPoint {
  date: string;
  /** その時点の総資金（asset 合計）。 */
  total: number;
  /** 自由資金 = 総資金 − 目的別資金残高。 */
  free: number;
}

export interface CashflowProjection {
  startTotal: number;
  startFree: number;
  reserveBalance: number;
  points: CashflowPoint[];
  minTotal: number;
  minFree: number;
  schedules: CashflowSchedule[];
}

/** 月数ぶん先の期間上限（'YYYY-MM-31' の文字列比較で十分）。 */
export function horizonEnd(today: string, months: number): string {
  return `${addMonths(monthOf(today), months)}-31`;
}

/**
 * 1 件の仕訳が「流動資産（現金など）」に与える純増減を求める。
 * 借方で流動資産が増えれば +、貸方で減れば −。流動でない明細（費用/収入/負債/按分中資産）は 0。
 * これにより、未来日付の通常仕訳（ホームの収入/支出/振替）をそのまま CF 投影に取り込める。
 *  - 収入: 借方 現金 / 貸方 収入 → +amount（inflow）
 *  - 支出: 借方 費用 / 貸方 現金 → −amount（outflow）
 *  - 返済: 借方 負債 / 貸方 現金 → −amount（負債は流動資産でない）
 *  - 振替(日常→日常): 借方 現金A / 貸方 現金B → 0（自由資金は変わらない）
 *  - 認識/按分(現金が動かない) → 0
 */
export function cashDeltaOfEntry(
  entry: JournalEntry,
  isLiquid: (accountId: string) => boolean,
): number {
  let delta = 0;
  for (const line of entry.lines) {
    if (!isLiquid(line.accountId)) continue;
    delta += line.side === 'debit' ? line.amount : -line.amount;
  }
  return delta;
}

/** 投影に積む将来の現金イベント（予定 CF と未来仕訳を統一して扱う）。 */
export interface FutureCashEvent {
  date: string;
  /** 総資金（流動資産＝daily-asset + reserve-asset）の符号つき増減。 */
  amount: number;
  /**
   * 取り置き（reserve-asset）残高の符号つき増減（任意・既定 0）。
   * 自由資金 = 総資金 − 取り置き残高 なので、未来日の `普通預金 → 目的別資金` 振替のように
   * 総資金は不変でも取り置きが増えるイベントは、これにより自由資金を正しく減らす。
   */
  reserveAmount?: number;
}

/**
 * planned な予定 + 未来日付の通常仕訳を期日順に適用して将来残高を投影する。
 * reserveBalance（目的別資金の現在残高）は自由資金から差し引く（投影中は一定とみなす）。
 *
 * futureEvents は「未来日付仕訳（date > today）の現金デルタ」。startTotal は today 時点の残高なので、
 * 未来仕訳はまだ含まれておらず、予定 CF と二重計上にならない（予定は status==='planned' で未実績）。
 *
 * 終端は `untilDate`（表示終了日）を指定すればそこまで、無ければ `months` ぶん先（既定 6 か月）。
 */
export function projectCashflow(params: {
  totalAssets: number;
  reserveBalance: number;
  schedules: CashflowSchedule[];
  today: string;
  /** 月数ぶん先を終端にする（後方互換）。`untilDate` 指定時は無視される。 */
  months?: number;
  /** 表示終了日 'YYYY-MM-DD'。指定時はこの日までを投影する（months より優先）。 */
  untilDate?: string;
  futureEvents?: FutureCashEvent[];
}): CashflowProjection {
  const { totalAssets, reserveBalance, schedules, today, futureEvents = [] } = params;
  const end = params.untilDate ?? horizonEnd(today, params.months ?? 6);
  const planned = schedules
    .filter((s) => s.status === 'planned' && s.dueDate >= today && s.dueDate <= end)
    .slice()
    .sort((a, b) => (a.dueDate < b.dueDate ? -1 : a.dueDate > b.dueDate ? 1 : 0));

  // 予定 CF と未来仕訳を 1 本のイベント列に統合し、期日順に積む。
  // 予定 CF（planned）は資金↔資金/資金↔負債が主で取り置き残高を動かさない（reserveAmount=0）。
  // 取り置き移動は未来日付の振替仕訳（futureEvents.reserveAmount）として入ってくる。
  const events: FutureCashEvent[] = [
    ...planned.map((s) => ({
      date: s.dueDate,
      // transfer（口座間移動）は総資金を変えない。
      amount: s.direction === 'inflow' ? s.amount : s.direction === 'outflow' ? -s.amount : 0,
    })),
    ...futureEvents.filter((e) => e.date > today && e.date <= end),
  ].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));

  const startTotal = totalAssets;
  const startFree = totalAssets - reserveBalance;
  const points: CashflowPoint[] = [{ date: today, total: startTotal, free: startFree }];

  // 総資金と取り置き残高を時系列で更新し、各時点の自由資金 = 総資金 − 取り置き を出す。
  let total = startTotal;
  let reserve = reserveBalance;
  for (const e of events) {
    total += e.amount;
    reserve += e.reserveAmount ?? 0;
    points.push({ date: e.date, total, free: total - reserve });
  }

  const minTotal = points.reduce((m, p) => Math.min(m, p.total), startTotal);
  const minFree = points.reduce((m, p) => Math.min(m, p.free), startFree);

  return { startTotal, startFree, reserveBalance, points, minTotal, minFree, schedules: planned };
}
