/*
 * 資金繰り（将来の現金の見通し）の投影。
 *
 * 「予定」= 未来日付の通常仕訳（v7 で予定キャッシュフローを全廃・一本化）。
 *  - 投影の原資は**「自由に動かせるお金」1 値**（daily-asset かつ movable !== false で、
 *    基準日に存在する科目の残高合計）。総資金/自由資金という 2 段の概念は持たない。
 *    貸借対照表・資産内訳は従来どおり全資産を出す（資金繰りだけ絞る）。
 *  - 投影の入力は導出込み仕訳（displayEntriesForAsOf を地平まで展開した結果）。
 *    未来日付の実仕訳・継続コストの導出行・定期ルールの投影が同じ列で扱われる。
 *  - 起点は **today ではなくヘッダーの日付（基準日 = anchorDate）**（v13.4 ③）。資金繰りは
 *    タイムスリップに追従し、過去の断面でもその日から先を投影する。この層に today は無い。
 */
import { addMonths, addMonthsToDate, monthOf } from './allocation';
import { sortAccounts } from './displayOrder';
import type { TimelineZoom } from './timelineCalendar';
import type { Account, AccountBalance, JournalEntry } from './types';
import { assertSafeAmount, sumAmounts } from './safeSum';

/**
 * 「自由に動かせるお金」に数える科目か（資金繰りの原資の単一正本）。
 * daily-asset かつ movable !== false。有限の終了点を持つ科目は、その終了前後の資金移動を
 * 投影するため候補に残す（終了点残高 0 と期間ガードにより、終了後の残高は増えない）。
 * 旧 archived=true / endDateなしだけは終了点不明のため従来どおり除外する。
 * 継続コスト台帳・投資などの asset や、「自由に動かせない」チェックを外した現預金
 * （Suica・チャージ残高など）は原資に入れない。
 */
export function isFreeAsset(
  account: Pick<Account, 'role' | 'movable' | 'archived' | 'endDate'>,
): boolean {
  return (
    account.role === 'daily-asset' &&
    account.movable !== false &&
    !(account.archived && account.endDate === undefined)
  );
}

/** 資金繰りの原資 = 「自由に動かせるお金」の残高合計。 */
export function freeAssetTotal(assets: AccountBalance[]): number {
  return sumAmounts(assets.filter((a) => isFreeAsset(a.account)).map((a) => a.balance));
}

export interface CashflowPoint {
  date: string;
  /** その時点の「自由に動かせるお金」。 */
  free: number;
}

export interface CashflowProjection {
  /** 基準日（points[0]）時点の「自由に動かせるお金」。 */
  startFree: number;
  /**
   * 基準日から終端までの推移。points[0] は必ず基準日で、以降は「自由に動かせるお金」に
   * ふれる仕訳がある**日ごと**に 1 点（同じ日は 1 点にまとめる）。
   */
  points: CashflowPoint[];
}

/** 同じ仮想仕訳が複数の投影経路から渡されても、未来 CF では 1 回だけ扱う。 */
export function uniqueEntriesById(entries: JournalEntry[]): JournalEntry[] {
  return [...new Map(entries.map((entry) => [entry.id, entry])).values()];
}

/**
 * 「毎月 day 日」の次回返済日（today より後の最初の該当日）。
 * 31 など月に無い日はその月の月末へ丸める（勘定科目の repaymentDay と同じ約束）。
 */
export function nextRepaymentDate(today: string, day: number): string {
  const clampToMonth = (ym: string): string => {
    const [y, m] = ym.split('-');
    const lastDay = new Date(
      Number.parseInt(y ?? '0', 10),
      Number.parseInt(m ?? '0', 10),
      0,
    ).getDate();
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
 *  - 月割り（現金が動かない）→ 0
 */
export function cashDeltaOfEntry(
  entry: JournalEntry,
  isFree: (accountId: string) => boolean,
): number {
  let delta = 0;
  for (const line of entry.lines) {
    if (!isFree(line.accountId)) continue;
    delta = assertSafeAmount(delta + (line.side === 'debit' ? line.amount : -line.amount));
  }
  return delta;
}

/** 1 日ぶんの「自由に動かせるお金」の純増減。 */
export interface CashflowDayDelta {
  date: string;
  amount: number;
}

/**
 * 基準日より後・`until` までの、日ごとの「自由に動かせるお金」の純増減（日付昇順）。
 *
 * 同じ日に複数の仕訳があっても 1 点にまとめる。台帳は日の中の順序を持たないので、
 * 日中の並べ方次第で一瞬だけマイナスに見える谷を作らない（「その日を終えた時点」で見る）。
 * これで折れ線の点と下回り日の判定が同じ粒度に揃う。
 *
 * 同一 ID の重複（複数の投影経路から来た仮想仕訳）は 1 回だけ数え、
 * 「自由に動かせるお金」にふれない仕訳は点を作らない。
 */
export function cashflowDayDeltas(params: {
  /** 導出込み仕訳（displayEntriesForAsOf を地平まで展開した結果）。 */
  entries: JournalEntry[];
  /** 基準日。この日**より後**の仕訳だけを積む（基準日までは startFree に含み済み）。 */
  after: string;
  /** 終端 'YYYY-MM-DD'。この日**まで**を含む。 */
  until: string;
  /** 「自由に動かせるお金」に数える科目か（cashDeltaOfEntry と同じ判定を渡す）。 */
  isFree: (accountId: string) => boolean;
}): CashflowDayDelta[] {
  const { entries, after, until, isFree } = params;
  const byDate = new Map<string, number>();
  for (const entry of uniqueEntriesById(entries)) {
    if (entry.date <= after || entry.date > until) continue;
    if (!entry.lines.some((line) => isFree(line.accountId))) continue;
    byDate.set(
      entry.date,
      assertSafeAmount((byDate.get(entry.date) ?? 0) + cashDeltaOfEntry(entry, isFree)),
    );
  }
  return [...byDate]
    .map(([date, amount]) => ({ date, amount }))
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
}

/**
 * 基準日以降の導出込み仕訳を日付順に適用して残高の推移を投影する。
 *
 * `entries` は displayEntriesForAsOf を地平まで展開した結果を渡す（導出込み仕訳が投影の
 * 唯一の入力）。`startFree` は**基準日時点**の残高なので、基準日より後の仕訳だけを積む。
 * 終端 `end` は呼び出し側が明示する（画面の窓 = 基準日 + N ヶ月、下回り日の探索 = 地平）。
 */
export function projectCashflow(params: {
  /** 基準日時点の「自由に動かせるお金」（freeAssetTotal の結果）。 */
  startFree: number;
  /** 導出込み仕訳（displayEntriesForAsOf を地平まで展開した結果）。 */
  entries: JournalEntry[];
  /** 起点 = ヘッダーの日付（基準日）。points[0] はこの日になる。 */
  anchorDate: string;
  /** 終端 'YYYY-MM-DD'（境界を含む）。既定は持たない。 */
  end: string;
  /** 「自由に動かせるお金」に数える科目か（cashDeltaOfEntry と同じ判定を渡す）。 */
  isFree: (accountId: string) => boolean;
}): CashflowProjection {
  const { startFree, entries, anchorDate, end, isFree } = params;
  const checkedStartFree = assertSafeAmount(startFree);
  const points: CashflowPoint[] = [{ date: anchorDate, free: checkedStartFree }];
  let free = checkedStartFree;
  for (const delta of cashflowDayDeltas({ entries, after: anchorDate, until: end, isFree })) {
    free = assertSafeAmount(free + delta.amount);
    points.push({ date: delta.date, free });
  }
  return { startFree: checkedStartFree, points };
}

/**
 * 基準日以降で「自由に動かせるお金」が**最初に 0 を下回る**点。無ければ null。
 *
 *  - ちょうど 0 は下回りではない（払えている）。厳密に負のときだけ拾う。
 *  - 基準日当日に負なら基準日そのものを返す（points[0] = 基準日）。
 *  - **基準日より前**の下回りは見ない。points は基準日から始まる＝過去の谷は startFree に
 *    織り込み済みで、そこへ戻る手段は「ヘッダーの日付を戻す」しかない。
 *  - どこまで探すかは projection の終端が決める（画面は地平まで投影して渡す）。
 */
export function firstShortfallPoint(projection: CashflowProjection): CashflowPoint | null {
  return projection.points.find((point) => point.free < 0) ?? null;
}

/*
 * ── ヘッダーズームへの追従（v13.5 F・作者決定 2026-08-18）──────────────────
 *
 * 会計実務の 日繰り表 / 月次資金繰り表 / 年次計画 の 3 粒度に対応する。**投影も下回り日の
 * 探索も常に日次のまま**で、ここで畳むのは「グラフに描く点」だけ（表示だけバケット）。
 * 下回り日・負債一覧・未来一覧は畳んだ結果を見ない。
 */

/** バケット末の本数の歯止め（壊れた日付から無限に点を作らない）。 */
const CASHFLOW_BUCKET_CAP = 400;

function monthEndOf(ym: string): string {
  const [year, month] = ym.split('-').map(Number);
  const day = new Date(Date.UTC(year ?? 1970, month ?? 1, 0)).getUTCDate();
  return `${ym}-${String(day).padStart(2, '0')}`;
}

/**
 * グラフの窓の終端。**バケットの末日に揃える**（月ズームなら月末・年ズームなら年末）ので、
 * 最後のバケットが半端に切れず「窓の終端の値 = 最後のバケット末の値」が一致する。
 * 上限 `cap`（展開の地平）を越えない。
 */
export function cashflowWindowEnd(params: {
  anchorDate: string;
  months: number;
  zoom: TimelineZoom;
  cap: string;
}): string {
  const raw = addMonthsToDate(params.anchorDate, params.months);
  const snapped =
    params.zoom === 'month'
      ? monthEndOf(monthOf(raw))
      : params.zoom === 'year'
        ? `${raw.slice(0, 4)}-12-31`
        : raw;
  return snapped < params.cap ? snapped : params.cap;
}

/**
 * 基準日より後・`endDate` までのバケット末（月末 / 年末）の並び。日ズームは空
 * （日次の点をそのまま使う＝畳まない）。
 */
export function cashflowBucketEnds(
  anchorDate: string,
  endDate: string,
  zoom: TimelineZoom,
): string[] {
  if (zoom === 'day' || endDate <= anchorDate) return [];
  const ends: string[] = [];
  if (zoom === 'month') {
    const lastMonth = monthOf(endDate);
    for (
      let month = monthOf(anchorDate);
      month <= lastMonth && ends.length < CASHFLOW_BUCKET_CAP;
      month = addMonths(month, 1)
    ) {
      const end = monthEndOf(month);
      if (end > anchorDate && end <= endDate) ends.push(end);
    }
    return ends;
  }
  const lastYear = Number.parseInt(endDate.slice(0, 4), 10);
  for (
    let year = Number.parseInt(anchorDate.slice(0, 4), 10);
    year <= lastYear && ends.length < CASHFLOW_BUCKET_CAP;
    year += 1
  ) {
    const end = `${String(year).padStart(4, '0')}-12-31`;
    if (end > anchorDate && end <= endDate) ends.push(end);
  }
  return ends;
}

/**
 * 日次の投影を、グラフに描く粒度へ畳む。
 *
 *  - 日ズーム: 窓に入る日次の点をそのまま（現行の見え方は変えない）。
 *  - 月 / 年ズーム: **バケット末の断面**（その日を終えた時点の残高）を 1 点ずつ。
 *    途中の動きは畳まれるので、バケットの中で一瞬だけ 0 を割る谷は**線には出ない**
 *    （下回り日は日次の projection から別に出す＝探索の精度は落とさない）。
 *  - 先頭は必ず基準日（線の起点をズームで動かさない）。
 */
export function foldCashflowPoints(params: {
  projection: CashflowProjection;
  anchorDate: string;
  endDate: string;
  zoom: TimelineZoom;
}): CashflowPoint[] {
  const { projection, anchorDate, endDate, zoom } = params;
  const within = projection.points.filter((point) => point.date <= endDate);
  if (zoom === 'day') return within;
  const folded: CashflowPoint[] = [{ date: anchorDate, free: projection.startFree }];
  let index = 0;
  let free = projection.startFree;
  for (const end of cashflowBucketEnds(anchorDate, endDate, zoom)) {
    while (index < within.length && (within[index]?.date ?? '') <= end) {
      free = within[index]?.free ?? free;
      index += 1;
    }
    folded.push({ date: end, free });
  }
  return folded;
}

/** 返済予定つきの負債 1 行（資金繰りの表示・月割り台帳の編集が同じ行集合を見る）。 */
export interface LiabilityScheduleRow {
  id: string;
  account: Account;
  name: string;
  /** 基準日より後に登録済みの返済（日付昇順）。 */
  repayments: JournalEntry[];
  /** 残回数 = repayments.length。 */
  count: number;
  /** 登録済みの返済の合計（この負債への借方額の合計）。 */
  remaining: number;
  /** 次回支払日（登録済みの返済が無ければ undefined）。 */
  nextDue?: string;
  /** 基準日断面の導出残高。 */
  balance: number;
}

/** 仕訳がこの負債（借方）へ返す金額（返済仕訳の表示額）。 */
function repaymentAmountOf(entry: JournalEntry, liabilityId: string): number {
  return sumAmounts(
    entry.lines
      .filter((l) => l.side === 'debit' && l.accountId === liabilityId)
      .map((l) => l.amount),
  );
}

/**
 * 支払用負債の一覧（**単一正本**。資金繰り = 表示・月割り台帳 = 編集で同じ行が並ぶ）。
 *
 *  - 対象は payment-liability / other-liability のうち、**基準日断面で導出残高 ≠ 0** のものだけ
 *    （未来に始まるローンは基準日を進めれば現れ、完済済みは消える。「残高 0 だが返済予定だけ
 *    残っている」行は作らない）。
 *  - 返済予定は**保存された実仕訳**（借方 = その負債・基準日より後）から引く。導出行は数えない。
 *  - 残高は呼び出し側が渡す（画面が既に持っている貸借対照表を二度作らせない）。
 */
export function liabilityScheduleRows(params: {
  accounts: Account[];
  /** 保存された仕訳（導出行を含めない）。 */
  storedEntries: JournalEntry[];
  /** 基準日断面の負債残高（deriveBalanceSheet の liabilities から作る）。 */
  balanceById: ReadonlyMap<string, number>;
  /** 基準日（この日より後の返済を「予定」とする）。 */
  asOf: string;
}): LiabilityScheduleRow[] {
  // 並びは画面共通の勘定科目順（sortAccounts が単一正本）。
  return sortAccounts(params.accounts)
    .filter((a) => a.role === 'payment-liability' || a.role === 'other-liability')
    .map((a) => {
      const repayments = params.storedEntries
        .filter(
          (e) =>
            e.date > params.asOf && e.lines.some((l) => l.side === 'debit' && l.accountId === a.id),
        )
        .sort((x, y) => (x.date < y.date ? -1 : x.date > y.date ? 1 : 0));
      const nextDue = repayments[0]?.date;
      return {
        id: a.id,
        account: a,
        name: a.name,
        repayments,
        count: repayments.length,
        remaining: sumAmounts(repayments.map((e) => repaymentAmountOf(e, a.id))),
        ...(nextDue !== undefined ? { nextDue } : {}),
        balance: params.balanceById.get(a.id) ?? 0,
      };
    })
    .filter((row) => row.balance !== 0);
}

/** 返済仕訳の表示額（行の展開で 1 件ずつ出す金額）。行集合と同じ規則を UI へ渡す。 */
export function repaymentEntryAmount(entry: JournalEntry, liabilityId: string): number {
  return repaymentAmountOf(entry, liabilityId);
}
