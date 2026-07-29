/*
 * 継続コスト資産の「計算で生まれる仕訳」エンジン（4項目モデル）。
 *
 * 購入の仕訳は**保存される仕訳**（`借方 継続コスト台帳 / 貸方 支払い元`・
 * metadata.monthlyCostId 付き）になったため、ここで生まれるのは
 * **費用の行（recognition）だけ**: `借方 費用の行き先 / 貸方 継続コスト台帳`。
 *
 *  - 終了日が未設定の item からは 1 本も生まれない（monthlyCost.ts の recognitionSpan が正本）。
 *  - 初月の認識日は startDate、2ヶ月目以降は月初。購入（startDate）より前に費用が立たない
 *    ＝どの日付断面でも台帳がマイナスにならない。
 *  - 回収の振替（metadata.monthlyCostRecovery）が保存されていれば、割り振る総額から差し引く
 *    （spreadTotal = amount − 回収額。負になってよい＝過去にわたる費用減・マイナス表示）。
 *  - 計算で生まれる仕訳は保存されない導出専用（metadata.virtual）。`reportEntriesForAsOf` の
 *    結果だけに現れ、実仕訳・保存系・export には混ぜない。
 */
import { addMonths, monthlyAmounts } from './allocation';
import { CONTINUOUS_COST_LEDGER_ACCOUNT_ID } from './constants';
import { recognitionDate, recognitionSpan } from './monthlyCost';
import type { JournalEntry, MonthlyCostItem } from './types';

/** 仮想展開の上限（無限ループ防止・極端な未来クエリの安全弁）。 */
export const CONTINUOUS_COST_HARD_CAP = '2100-12-31';

/**
 * 1 つの item を upTo までの費用行（計算で生まれる仕訳）に展開する。
 * ID は `{idPrefix}-{itemId}-{YYYY-MM}`（既定 `cc-recog-…`。ルール投影は `cc-recogp-…`）。
 */
export function continuousCostEntriesForItem(
  item: MonthlyCostItem,
  upTo: string,
  spreadTotal: number = item.amount,
  idPrefix = 'cc-recog',
): JournalEntry[] {
  const span = recognitionSpan(item);
  if (!span) return []; // 終了日なし = 何も生まれない
  const cap = upTo < CONTINUOUS_COST_HARD_CAP ? upTo : CONTINUOUS_COST_HARD_CAP;
  const amounts = monthlyAmounts(spreadTotal, span.n);
  const out: JournalEntry[] = [];
  for (let k = 0; k < span.n; k++) {
    const ym = addMonths(span.from, k);
    const date = recognitionDate(item, span.from, k);
    if (date > cap) break;
    const amount = amounts[k] ?? 0;
    if (amount === 0) continue;
    out.push({
      id: `${idPrefix}-${item.id}-${ym}`,
      date,
      description: item.name,
      kind: 'normal',
      lines: [
        { accountId: item.expenseAccountId, side: 'debit', amount },
        { accountId: CONTINUOUS_COST_LEDGER_ACCOUNT_ID, side: 'credit', amount },
      ],
      metadata: { virtual: true, continuousCostId: item.id, ccKind: 'recognition' },
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
    recovered.set(id, (recovered.get(id) ?? 0) + (credit?.amount ?? 0));
  }
  return recovered;
}

/** 全 item の費用行を upTo まで展開して連結する（回収の振替は real から集計）。 */
export function continuousCostEntries(
  items: MonthlyCostItem[],
  real: JournalEntry[],
  upTo: string,
): JournalEntry[] {
  const recovered = recoveredAmountsByItem(real);
  return items.flatMap((it) =>
    continuousCostEntriesForItem(it, upTo, it.amount - (recovered.get(it.id) ?? 0)),
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
