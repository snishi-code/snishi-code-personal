/*
 * 支出（= ホームの「支出」）の集計。資産経由モデルの単一正本。
 *
 * 入力は **導出専用 entries（`reportEntriesForAsOf` = 実仕訳 + 継続コスト等の仮想仕訳）**。
 * 継続コストは仮想認識 `借方 費用カテゴリ / 貸方 対象資産`(metadata.ccKind==='recognition') として
 * すでに PL の費用に含まれるため、**formula を別途足さない**（旧モデルの二重計上ハックは廃止）。
 *
 *  - 通常支出 = 期間内の費用 − 継続コストの仮想認識。
 *  - 継続コスト = 期間内の仮想認識の合計（= 各対象資産から費用へ費消した額）。
 *  - 支出合計 = 通常支出 + 継続コスト（= PL の費用合計）。
 * 補正による費用も通常の支出として含める。返済・振替・資産化(funding)は費用ではないので
 * 含まれない。
 */
import { deriveProfitAndLoss } from './accounting';
import type { ReportFlowRange } from './reportPeriod';
import type { Account, JournalEntry } from './types';

export interface LivingCostBreakdown {
  /** 通常支出（費用 − 継続コスト認識）。 */
  normalExpense: number;
  /** 継続コスト（仮想認識の区間合計）。UI 契約上キー名は monthlyCost のまま。 */
  monthlyCost: number;
  /** 支出合計 = 通常支出 + 継続コスト。 */
  total: number;
}

/** 費用カテゴリ1件の支出額（通常支出 + そのカテゴリに認識された継続コスト分を含む）。 */
export interface ExpenseCategoryAmount {
  account: Account;
  amount: number;
}

/**
 * 仕訳一覧で「通常支出」に分類する判定の単一正本。
 *
 * 借方に費用科目を持つ仕訳のうち、継続コストの導出認識だけを除外する。
 * inputMode や adjustment の有無には依存しないため、簿記編集・残高補正も通常支出に含まれる。
 */
export function isNormalExpenseEntry(
  entry: JournalEntry,
  accountById: ReadonlyMap<string, Account>,
): boolean {
  if (entry.metadata?.ccKind === 'recognition') return false;
  return entry.lines.some(
    (line) => line.side === 'debit' && accountById.get(line.accountId)?.type === 'expense',
  );
}

/**
 * 期間（range が undefined のときは全期間）の支出内訳を求める。
 * entries は **導出仕訳**（`reportEntriesForAsOf` = 実仕訳 + 継続コスト仮想仕訳）を渡すこと。
 */
export function livingCostBreakdownForRange(
  accounts: Account[],
  entries: JournalEntry[],
  range: ReportFlowRange | undefined,
): LivingCostBreakdown {
  const accountById = new Map(accounts.map((a) => [a.id, a] as const));
  const within = (e: JournalEntry) =>
    !range || ((!range.from || e.date >= range.from) && e.date <= range.to);
  let continuing = 0;
  for (const e of entries) {
    if (!within(e)) continue;
    const debit = e.lines.find((l) => l.side === 'debit');
    if (e.metadata?.ccKind === 'recognition') {
      // 継続コストの認識先は任意の勘定科目にできる。生活コストとして数えるのは
      // 借方が費用のときだけで、収益減・資産/負債/純資産への振替は支出に含めない。
      if (debit && accountById.get(debit.accountId)?.type === 'expense') {
        continuing += debit.amount;
      }
      continue;
    }
  }
  const pl = deriveProfitAndLoss(accounts, entries, range);
  const normalExpense = pl.totalExpense - continuing;
  return { normalExpense, monthlyCost: continuing, total: normalExpense + continuing };
}

/** 支出合計（= 通常支出 + 継続コスト）。推移グラフ用。entries は導出仕訳。 */
export function livingCostForRange(
  accounts: Account[],
  entries: JournalEntry[],
  range: ReportFlowRange | undefined,
): number {
  return livingCostBreakdownForRange(accounts, entries, range).total;
}

/**
 * 「何へ支出しているか」を費用カテゴリ別に分解する（支出の内訳ページの主表示）。
 *
 * 各カテゴリの金額は PL の費用科目残高そのもの。継続コストは仮想認識
 * （借方 費用カテゴリ）として entries（導出仕訳）に含まれるため、月割り分も
 * 自動的に選ばれた費用カテゴリへ合算される（別途 formula を足さない）。
 * 残高調整費（system-adjustment）も、ざっくり記帳した支出との差額として通常どおり含める。
 *
 * この合計は livingCostBreakdownForRange().total（= ホーム「支出」の金額）と一致する。
 * 残高 0 のカテゴリは表示から外し、金額の大きい順に並べる。
 */
export function expenseCategoryBreakdownForRange(
  accounts: Account[],
  entries: JournalEntry[],
  range: ReportFlowRange | undefined,
): ExpenseCategoryAmount[] {
  const pl = deriveProfitAndLoss(accounts, entries, range);
  return pl.expenses
    .filter((b) => b.balance !== 0)
    .map((b) => ({ account: b.account, amount: b.balance }))
    .sort((a, b) => b.amount - a.amount);
}
