/*
 * 予定キャッシュフロー（将来の現金の出入り）の投影と実績化。
 *
 * 「いつ費用認識するか」とは独立に、「いつ現金が動くか」を扱う。
 *  - 投影の原資は**「自由に動かせるお金」1 値**（daily-asset かつ movable !== false かつ
 *    非アーカイブの残高合計）。総資金/自由資金という 2 段の概念は持たない。
 *    貸借対照表・資産内訳は従来どおり全資産を出す（資金繰りだけ絞る）。
 *  - planned な CashflowSchedule を期日順に適用し、将来残高・最低残高を投影する。
 *  - 実績化は 1 件の 2 行仕訳を作る（複合仕訳にしない）。保存は repository（単一 transaction）。
 */
import { newId } from './ids';
import { nowIso } from '../util/time';
import { LedgerError } from './errors';
import { addMonths, monthOf } from './allocation';
import type {
  Account,
  AccountBalance,
  CashflowDirection,
  CashflowSchedule,
  JournalEntry,
} from './types';

/**
 * 予定 CF の「源泉 → 行き先」(A → B) から、保存する {現金が動く口座 accountId / 相手 counter /
 * 入金 or 出金 direction} を role から推定する。日常入力と同じ A → B 形にするための変換。
 *  - 収入カテゴリ → 日常資産: 入金(inflow)。現金が動くのは日常資産。
 *  - 日常資産 → 費用カテゴリ: 出金(outflow)。
 *  - 日常資産 → 支払用負債: 返済/支払い(outflow)。
 *  - 日常資産 → 日常資産: 口座間移動(transfer)。自由に動かせるお金の総額は変えない。
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
 * 「自由に動かせるお金」に数える科目か（資金繰りの原資の単一正本）。
 * daily-asset かつ movable !== false かつ非アーカイブ。
 * 継続コスト台帳・投資などの asset や、「自由に動かせない」チェックを外した現預金
 * （Suica・チャージ残高など）は原資に入れない。
 */
export function isFreeAsset(
  account: Pick<Account, 'role' | 'movable' | 'archived'>,
): boolean {
  return account.role === 'daily-asset' && account.movable !== false && !account.archived;
}

/** 資金繰りの原資 = 「自由に動かせるお金」の残高合計。 */
export function freeAssetTotal(assets: AccountBalance[]): number {
  return assets
    .filter((a) => isFreeAsset(a.account))
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
  /** その時点の「自由に動かせるお金」。 */
  free: number;
}

export interface CashflowProjection {
  /** today 時点の「自由に動かせるお金」。 */
  startFree: number;
  points: CashflowPoint[];
  /** 投影期間中の最低額。 */
  minFree: number;
  schedules: CashflowSchedule[];
}

/** 同じ仮想仕訳が複数の投影経路から渡されても、未来 CF では 1 回だけ扱う。 */
export function uniqueEntriesById(entries: JournalEntry[]): JournalEntry[] {
  return [...new Map(entries.map((entry) => [entry.id, entry])).values()];
}

/** 月数ぶん先の期間上限（'YYYY-MM-31' の文字列比較で十分）。 */
export function horizonEnd(today: string, months: number): string {
  return `${addMonths(monthOf(today), months)}-31`;
}

/**
 * 「毎月 day 日」の次回返済日（today より後の最初の該当日）。
 * 31 など月に無い日はその月の月末へ丸める（勘定科目の repaymentDay と同じ約束）。
 */
export function nextRepaymentDate(today: string, day: number): string {
  const clampToMonth = (ym: string): string => {
    const [y, m] = ym.split('-');
    const lastDay = new Date(Number.parseInt(y ?? '0', 10), Number.parseInt(m ?? '0', 10), 0)
      .getDate();
    return `${ym}-${String(Math.min(day, lastDay)).padStart(2, '0')}`;
  };
  const inThisMonth = clampToMonth(monthOf(today));
  if (inThisMonth > today) return inThisMonth;
  return clampToMonth(addMonths(monthOf(today), 1));
}

/**
 * 1 件の仕訳が「自由に動かせるお金」に与える純増減を求める。
 * 借方で自由に動かせる科目が増えれば +、貸方で減れば −。対象外の明細
 * （費用/収入/負債/継続コスト台帳/movable=false の現預金）は 0。
 * これにより、未来日付の通常仕訳（ホームの収入/支出/振替）をそのまま CF 投影に取り込める。
 *  - 収入: 借方 現金 / 貸方 収入 → +amount（inflow）
 *  - 支出: 借方 費用 / 貸方 現金 → −amount（outflow）
 *  - 返済: 借方 負債 / 貸方 現金 → −amount（負債は原資でない）
 *  - 振替(自由→自由): 借方 現金A / 貸方 現金B → 0
 *  - 振替(自由→movable=false): 借方 Suica / 貸方 現金 → −amount（自由に動かせるお金が減る）
 *  - 月次認識（現金が動かない）→ 0
 */
export function cashDeltaOfEntry(
  entry: JournalEntry,
  isFree: (accountId: string) => boolean,
): number {
  let delta = 0;
  for (const line of entry.lines) {
    if (!isFree(line.accountId)) continue;
    delta += line.side === 'debit' ? line.amount : -line.amount;
  }
  return delta;
}

/** 投影に積む将来の現金イベント（予定 CF と未来仕訳を統一して扱う）。 */
export interface FutureCashEvent {
  date: string;
  /** 「自由に動かせるお金」の符号つき増減。 */
  amount: number;
}

/**
 * planned な予定 + 未来日付の通常仕訳を期日順に適用して将来残高を投影する。
 *
 * futureEvents は「未来日付仕訳（date > today）の現金デルタ」。startFree は today 時点の残高なので、
 * 未来仕訳はまだ含まれておらず、予定 CF と二重計上にならない（予定は status==='planned' で未実績）。
 *
 * 終端は `untilDate`（表示終了日）を指定すればそこまで、無ければ `months` ぶん先（既定 6 か月）。
 */
export function projectCashflow(params: {
  /** today 時点の「自由に動かせるお金」（freeAssetTotal の結果）。 */
  startFree: number;
  schedules: CashflowSchedule[];
  today: string;
  /** 月数ぶん先を終端にする（後方互換）。`untilDate` 指定時は無視される。 */
  months?: number;
  /** 表示終了日 'YYYY-MM-DD'。指定時はこの日までを投影する（months より優先）。 */
  untilDate?: string;
  futureEvents?: FutureCashEvent[];
}): CashflowProjection {
  const { startFree, schedules, today, futureEvents = [] } = params;
  const end = params.untilDate ?? horizonEnd(today, params.months ?? 6);
  const planned = schedules
    .filter((s) => s.status === 'planned' && s.dueDate >= today && s.dueDate <= end)
    .slice()
    .sort((a, b) => (a.dueDate < b.dueDate ? -1 : a.dueDate > b.dueDate ? 1 : 0));

  // 予定 CF と未来仕訳を 1 本のイベント列に統合し、期日順に積む。
  const events: FutureCashEvent[] = [
    ...planned.map((s) => ({
      date: s.dueDate,
      // transfer（口座間移動）は自由に動かせるお金を変えない。
      amount: s.direction === 'inflow' ? s.amount : s.direction === 'outflow' ? -s.amount : 0,
    })),
    ...futureEvents.filter((e) => e.date > today && e.date <= end),
  ].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));

  const points: CashflowPoint[] = [{ date: today, free: startFree }];
  let free = startFree;
  for (const e of events) {
    free += e.amount;
    points.push({ date: e.date, free });
  }

  const minFree = points.reduce((m, p) => Math.min(m, p.free), startFree);

  return { startFree, points, minFree, schedules: planned };
}
