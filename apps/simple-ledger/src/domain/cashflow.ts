/*
 * 資金繰り（将来の現金の見通し）の投影。
 *
 * 「予定」= 未来日付の通常仕訳（v7 で予定キャッシュフローを全廃・一本化）。
 *  - 投影の原資は**「自由に動かせるお金」1 値**（daily-asset かつ movable !== false で、
 *    基準日に存在する科目の残高合計）。総資金/自由資金という 2 段の概念は持たない。
 *    貸借対照表・資産内訳は従来どおり全資産を出す（資金繰りだけ絞る）。
 *  - 投影の入力は導出込み仕訳（displayEntriesForAsOf を表示終了日まで展開した結果）。
 *    未来日付の実仕訳・継続コストの導出行・定期ルールの投影が同じ列で扱われる。
 */
import { addMonths, monthOf } from './allocation';
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
  /** today 時点の「自由に動かせるお金」。 */
  startFree: number;
  points: CashflowPoint[];
  /** 投影期間中の最低額。 */
  minFree: number;
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

/**
 * 未来日付の導出込み仕訳を期日順に適用して将来残高を投影する。
 *
 * `entries` は displayEntriesForAsOf を表示終了日まで展開した結果を渡す（導出込み仕訳が
 * 投影の唯一の入力）。startFree は today 時点の残高なので、today より後の仕訳だけを積む。
 * 同一 ID の重複（複数の投影経路から来た仮想仕訳）は 1 回だけ数え、
 * 「自由に動かせるお金」にふれない仕訳は点を作らない。
 *
 * 終端は `untilDate`（表示終了日）を指定すればそこまで、無ければ `months` ぶん先（既定 6 か月）。
 */
export function projectCashflow(params: {
  /** today 時点の「自由に動かせるお金」（freeAssetTotal の結果）。 */
  startFree: number;
  /** 導出込み仕訳（displayEntriesForAsOf を表示終了日まで展開した結果）。 */
  entries: JournalEntry[];
  today: string;
  /** 「自由に動かせるお金」に数える科目か（cashDeltaOfEntry と同じ判定を渡す）。 */
  isFree: (accountId: string) => boolean;
  /** 月数ぶん先を終端にする（後方互換）。`untilDate` 指定時は無視される。 */
  months?: number;
  /** 表示終了日 'YYYY-MM-DD'。指定時はこの日までを投影する（months より優先）。 */
  untilDate?: string;
}): CashflowProjection {
  const { startFree, entries, today, isFree } = params;
  const end = params.untilDate ?? horizonEnd(today, params.months ?? 6);
  const events = uniqueEntriesById(entries)
    .filter(
      (entry) =>
        entry.date > today &&
        entry.date <= end &&
        entry.lines.some((line) => isFree(line.accountId)),
    )
    .map((entry) => ({ date: entry.date, amount: cashDeltaOfEntry(entry, isFree) }))
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));

  const checkedStartFree = assertSafeAmount(startFree);
  const points: CashflowPoint[] = [{ date: today, free: checkedStartFree }];
  let free = checkedStartFree;
  for (const e of events) {
    free = assertSafeAmount(free + e.amount);
    points.push({ date: e.date, free });
  }

  const minFree = points.reduce((m, p) => Math.min(m, p.free), checkedStartFree);

  return { startFree: checkedStartFree, points, minFree };
}
