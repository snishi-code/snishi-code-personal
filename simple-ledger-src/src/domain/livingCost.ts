/*
 * 生活コスト（= ホームの「支出」）の計算。ホームの上段カード・支出の内訳画面・推移グラフが
 * すべて同じ定義を使うための単一の正本。
 *
 * 生活コスト = 通常支出 + 月額化コスト。
 *  - 通常支出 = 期間内の費用 − 既存按分の認識 − 調整用費用(system-adjustment) − 月額化の実支払い
 *    （月額化は formula で別途足すため、実支払い仕訳を二重計上しない）。
 *  - 月額化コスト = MonthlyCostItem の formula を区間内の各月で合算。
 * 固定資産の購入額そのもの・返済・振替は費用科目ではない/別概念なので含まれない。
 */
import { deriveProfitAndLoss } from './accounting';
import { totalMonthlyCostForMonth } from './monthlyCost';
import type { DateRange } from './reportPeriod';
import type { Account, JournalEntry, MonthlyCostItem } from './types';

export interface LivingCostBreakdown {
  /** 通常支出（費用 − 認識 − 調整 − 月額化の実支払い）。 */
  normalExpense: number;
  /** 月額化コスト（formula の区間合計）。 */
  monthlyCost: number;
  /** 支出合計 = 通常支出 + 月額化コスト。 */
  total: number;
}

/**
 * 期間（range が undefined のときは全期間）の生活コスト内訳を求める。
 * months は月額化 formula を合算する対象月（'YYYY-MM'）の一覧。
 */
export function livingCostBreakdownForRange(
  accounts: Account[],
  entries: JournalEntry[],
  items: MonthlyCostItem[],
  range: DateRange | undefined,
  months: string[],
): LivingCostBreakdown {
  const roleById = new Map(accounts.map((a) => [a.id, a.role]));
  const expenseIds = new Set(accounts.filter((a) => a.type === 'expense').map((a) => a.id));
  const within = (e: JournalEntry) => !range || (e.date >= range.from && e.date <= range.to);
  let recognition = 0;
  let systemAdj = 0;
  let monthlyCostPaid = 0;
  for (const e of entries) {
    if (!within(e)) continue;
    const debit = e.lines.find((l) => l.side === 'debit');
    if (e.metadata?.allocationRole === 'recognition') recognition += debit?.amount ?? 0;
    if (debit && roleById.get(debit.accountId) === 'system-adjustment') systemAdj += debit.amount;
    if (e.metadata?.monthlyCostId && debit && expenseIds.has(debit.accountId))
      monthlyCostPaid += debit.amount;
  }
  const pl = deriveProfitAndLoss(accounts, entries, range);
  const normalExpense = pl.totalExpense - recognition - systemAdj - monthlyCostPaid;
  const monthlyCost = months.reduce((s, ym) => s + totalMonthlyCostForMonth(items, ym), 0);
  return { normalExpense, monthlyCost, total: normalExpense + monthlyCost };
}

/** 生活コスト合計（= 支出）。推移グラフ用。 */
export function livingCostForRange(
  accounts: Account[],
  entries: JournalEntry[],
  items: MonthlyCostItem[],
  range: DateRange | undefined,
  months: string[],
): number {
  return livingCostBreakdownForRange(accounts, entries, items, range, months).total;
}
