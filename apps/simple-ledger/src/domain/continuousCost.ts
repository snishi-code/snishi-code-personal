/*
 * 継続コスト資産の「計算で生まれる仕訳」エンジン（4項目モデル）。
 *
 * 購入の仕訳は**保存される仕訳**（`借方 継続コスト台帳 / 貸方 支払い元`・
 * metadata.monthlyCostId 付き）になったため、ここで生まれるのは
 * **月割りの行（monthly-allocation）だけ**: `借方 月割り先 / 貸方 継続コスト台帳`。
 *
 *  - 終了日が未設定の item からは 1 本も生まれない（monthlyCost.ts の allocationSchedule が正本）。
 *  - 刻み日 = 購入日（startDate）の同日通過（k 番目 = addMonthsToDate(startDate, k)）。
 *    費用は必ず購入日より後に立つ（購入当日の費用 0）ので、購入（startDate）より前に
 *    月割り行が立たない＝どの日付断面でも台帳がマイナスにならない。
 *  - 回収の振替（metadata.monthlyCostRecovery）が保存されていれば、割り振る総額から差し引く
 *    （spreadTotal = amount − 回収額。負になってよい＝過去にわたる費用減・マイナス表示）。
 *  - 計算で生まれる仕訳は保存されない導出専用（metadata.virtual）。`reportEntriesForAsOf` の
 *    結果だけに現れ、実仕訳・保存系・export には混ぜない。
 */
import { monthOf } from './allocation';
import { MAX_LEDGER_DATE } from './calendar';
import { CONTINUOUS_COST_LEDGER_ACCOUNT_ID } from './constants';
import { allocationSchedule } from './monthlyCost';
import type { JournalEntry, MonthlyCostItem } from './types';
import { assertSafeAmount } from './safeSum';

/** 仮想展開の上限（無限ループ防止・極端な未来クエリの安全弁）。保存日付の上限と同じ正本。 */
export const CONTINUOUS_COST_HARD_CAP = MAX_LEDGER_DATE;

/**
 * 1 つの item を upTo までの費用行（計算で生まれる仕訳）に展開する。
 * ID は `{idPrefix}-{itemId}-{YYYY-MM}`（既定 `cc-alloc-…`。ルール投影は `cc-allocp-…`）。
 */
export function continuousCostEntriesForItem(
  item: MonthlyCostItem,
  upTo: string,
  spreadTotal: number = item.amount,
  idPrefix = 'cc-alloc',
): JournalEntry[] {
  const cap = upTo < CONTINUOUS_COST_HARD_CAP ? upTo : CONTINUOUS_COST_HARD_CAP;
  const out: JournalEntry[] = [];
  // 終了日なしは schedule が空 = 何も生まれない。刻み日は単調増加・月内に高々 1 本。
  for (const cut of allocationSchedule(item, spreadTotal)) {
    if (cut.date > cap) break;
    if (cut.amount === 0) continue;
    const { date, amount } = cut;
    const ym = monthOf(date);
    out.push({
      id: `${idPrefix}-${item.id}-${ym}`,
      date,
      description: item.name,
      kind: 'normal',
      lines: [
        { accountId: item.expenseAccountId, side: 'debit', amount },
        { accountId: CONTINUOUS_COST_LEDGER_ACCOUNT_ID, side: 'credit', amount },
      ],
      metadata: { virtual: true, continuousCostId: item.id, ccKind: 'monthly-allocation' },
      createdAt: item.createdAt,
      updatedAt: item.updatedAt,
    });
  }
  return out;
}

/**
 * 保存されている「回収の振替」を item ごとに合計する（貸方 = 台帳の金額）。
 * 割り振る総額 = amount − 回収額 の導出に使う。
 */
export function recoveredAmountsByItem(entries: JournalEntry[]): Map<string, number> {
  const recovered = new Map<string, number>();
  for (const e of entries) {
    if (e.metadata?.monthlyCostRecovery !== true) continue;
    const id = e.metadata.monthlyCostId;
    if (id === undefined) continue;
    const credit = e.lines.find((l) => l.side === 'credit');
    recovered.set(id, assertSafeAmount((recovered.get(id) ?? 0) + (credit?.amount ?? 0)));
  }
  return recovered;
}

/**
 * 割り振る総額 = 取得額 − 回収済み額（負でよい = 過去にわたる費用減）。
 * 導出（continuousCostEntries）と画面（月割り台帳）で同じ式を使うための単一正本。
 */
export function spreadTotalOf(
  item: MonthlyCostItem,
  recovered: ReadonlyMap<string, number>,
): number {
  return assertSafeAmount(item.amount - (recovered.get(item.id) ?? 0));
}

/** 全 item の費用行を upTo まで展開して連結する（回収の振替は real から集計）。 */
export function continuousCostEntries(
  items: MonthlyCostItem[],
  real: JournalEntry[],
  upTo: string,
): JournalEntry[] {
  const recovered = recoveredAmountsByItem(real);
  return items.flatMap((it) =>
    continuousCostEntriesForItem(it, upTo, spreadTotalOf(it, recovered)),
  );
}

/** 実仕訳 + 継続コストの計算で生まれる仕訳（導出専用の単一正本）。 */
export function entriesWithContinuousCost(
  real: JournalEntry[],
  items: MonthlyCostItem[],
  upTo: string,
): JournalEntry[] {
  return [...real, ...continuousCostEntries(items, real, upTo)];
}
