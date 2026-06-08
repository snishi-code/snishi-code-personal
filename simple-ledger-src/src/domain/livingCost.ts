/*
 * 支出（= ホームの「支出」）の集計。資産経由モデルの単一正本。
 *
 * 入力は **導出専用 entries（`Ledger.derivedEntries` = 実仕訳 + 継続コストの仮想仕訳）**。
 * 継続コストは仮想認識 `借方 費用カテゴリ / 貸方 対象資産`(metadata.ccKind==='recognition') として
 * すでに PL の費用に含まれるため、**formula を別途足さない**（旧モデルの二重計上ハックは廃止）。
 *
 *  - 通常支出 = 期間内の費用 − 投資評価損等(system-adjustment) − 継続コストの仮想認識。
 *  - 継続コスト = 期間内の仮想認識の合計（= 各対象資産から費用へ費消した額）。
 *  - 支出合計 = 通常支出 + 継続コスト（= 費用合計 − system-adjustment）。
 * 固定資産の購入額そのもの・返済・振替・資産化(funding)は費用ではないので含まれない。
 */
import { deriveProfitAndLoss } from './accounting';
import type { DateRange } from './reportPeriod';
import type { Account, JournalEntry } from './types';

export interface LivingCostBreakdown {
  /** 通常支出（費用 − system-adjustment − 継続コスト認識）。 */
  normalExpense: number;
  /** 継続コスト（仮想認識の区間合計）。UI 契約上キー名は monthlyCost のまま。 */
  monthlyCost: number;
  /** 支出合計 = 通常支出 + 継続コスト。 */
  total: number;
}

/**
 * 期間（range が undefined のときは全期間）の支出内訳を求める。
 * entries は **derivedEntries**（実仕訳 + 継続コスト仮想仕訳）を渡すこと。
 */
export function livingCostBreakdownForRange(
  accounts: Account[],
  entries: JournalEntry[],
  range: DateRange | undefined,
): LivingCostBreakdown {
  const roleById = new Map(accounts.map((a) => [a.id, a.role]));
  const within = (e: JournalEntry) => !range || (e.date >= range.from && e.date <= range.to);
  let systemAdj = 0;
  let continuing = 0;
  for (const e of entries) {
    if (!within(e)) continue;
    const debit = e.lines.find((l) => l.side === 'debit');
    if (e.metadata?.ccKind === 'recognition') {
      continuing += debit?.amount ?? 0;
      continue;
    }
    if (debit && roleById.get(debit.accountId) === 'system-adjustment') systemAdj += debit.amount;
  }
  const pl = deriveProfitAndLoss(accounts, entries, range);
  const normalExpense = pl.totalExpense - systemAdj - continuing;
  return { normalExpense, monthlyCost: continuing, total: normalExpense + continuing };
}

/** 支出合計（= 通常支出 + 継続コスト）。推移グラフ用。entries は derivedEntries。 */
export function livingCostForRange(
  accounts: Account[],
  entries: JournalEntry[],
  range: DateRange | undefined,
): number {
  return livingCostBreakdownForRange(accounts, entries, range).total;
}
