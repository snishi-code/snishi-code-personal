/*
 * ローン = 月割り台帳の item（持ち物の負債版・v13.13。作者決定 2026-08-20）。
 *
 * 「一旦負債で受け止めて資金から吐き出す」を、償却資産・給料と同列の **MonthlyCostItem**
 * で表す。専用ストアは作らず `monthlyCostItems` に同居し、既存 4 項目を読み替える:
 *  - `amount` = 借入総額（利息込み。借入の仕訳とミラー）
 *  - `startDate` = 購入日（借入の仕訳の日付とミラー）
 *  - `endDate` = **完済日（最終返済日・inclusive）。ローンでは必須**
 *  - `expenseAccountId` = 計上先 = **負債科目**（role の正本は isLiabilityRole）
 * 新フィールド `repaymentSourceAccountId`（返済元）の**有無がローン item の判別子**
 * （構造による判別。role 分岐のフラグは増やさない）。
 *
 * 返済の導出は**ルールの「台帳経由 2 本・1 刻み遅れ」を廃し**、item から直接 1 本:
 *  - 刻み日 = allocationCuts(startDate, endDate, spreadTotal)（刻み規約の単一正本。
 *    k 番目 = addMonthsToDate(購入日, k) = 旧 loanFirstRepaymentDate「購入日の 1 か月後」と
 *    一致。購入当日の返済 0 も同じ）。
 *  - 各刻みに `借方 負債（expenseAccountId）/ 貸方 返済元（repaymentSourceAccountId）`。
 *    **資金の出と負債の減りが同日**になる（v13.6 の「返済の 1 刻み遅れ」は構造的に解消）。
 *  - 端数は monthlyAmounts（合計厳密一致・先頭刻みから 1 ずつ）。旧「floor 月額 × 回数・
 *    端数は負債残高に残る」は廃止。
 *  - spreadTotal = amount − 一括返済（loanSettlement 仕訳）の合計。一括返済 = item の
 *    「終了」（endDate 設定 + 実仕訳。持ち物のアーカイブ + 回収の振替と完全同型）。
 *  - 縮退: dayCutCount = 0（完済日が購入 1 か月後より前）は完済日に全額 1 本
 *    （allocationCuts の既存規約のまま。特別扱いの分岐を作らない）。
 *
 * 「**ローン item を持つ負債だけが台帳に出る**」（クレカが台帳に出ない区別は不変）。
 */
import { addMonthsToDate, monthOf } from './allocation';
import { allocationCuts, dayCutCount, type AllocationCut } from './monthlyCost';
import { CONTINUOUS_COST_HARD_CAP } from './continuousCost';
import { recurringPostingsDue } from './recurring';
import { recurringRuleLastExistingDate } from './accountLifetime';
import { CATCH_UP_HARD_CAP_MONTHS } from './recurringLimits';
import { assertSafeAmount } from './safeSum';
import type { AccountRole } from './accountRoles';
import type { JournalEntry, MonthlyCostItem, RecurringRule } from './types';

/** 完済日クイックチップの年数（持ち物の [1年][3年][5年] と同じ並び）。 */
export const LOAN_QUICK_YEARS: readonly number[] = [1, 3, 5];

/** 負債の役割（カード・ローン）。 */
export function isLiabilityRole(role: AccountRole | undefined): boolean {
  return role === 'payment-liability' || role === 'other-liability';
}

/**
 * この item はローンか。判定は **repaymentSourceAccountId の有無**の一点だけ
 * （構造による判別の単一正本。wire / 保存境界は「あり ⇔ 計上先が負債」を双方向で固定する）。
 */
export function isLoanItem(item: Pick<MonthlyCostItem, 'repaymentSourceAccountId'>): item is Pick<
  MonthlyCostItem,
  'repaymentSourceAccountId'
> & {
  repaymentSourceAccountId: string;
} {
  return item.repaymentSourceAccountId !== undefined;
}

/**
 * その負債科目を計上先に持つローン item（= 月割り台帳の該当行）。
 * 複数あれば最初の 1 件（資金繰りの行タップの着地点は 1 つでよい）。
 */
export function loanItemForLiability(
  items: readonly MonthlyCostItem[],
  liabilityAccountId: string,
): MonthlyCostItem | undefined {
  return items.find((item) => isLoanItem(item) && item.expenseAccountId === liabilityAccountId);
}

/**
 * 初回返済日 = 購入日の 1 か月後（同日・月末クランプ）= 先頭刻みの日。
 * 購入当日に返済は起きない（持ち物の「購入当日の費用 0」と同じ向き）。
 * 完済日が 1 か月未満の縮退（完済日に全額 1 本）はスケジュール側（loanRepaymentSchedule）が扱う。
 */
export function loanFirstRepaymentDate(purchaseDate: string): string {
  return addMonthsToDate(purchaseDate, 1);
}

/** クイックチップの完済日 = 購入日 + n 年（inclusive。刻みはちょうど 12n 回）。 */
export function loanQuickEndDate(purchaseDate: string, years: number): string {
  return addMonthsToDate(purchaseDate, years * 12);
}

/**
 * 保存されている「一括返済」（metadata.loanSettlement）を item ごとに合計する
 * （借方 = 負債の金額）。spreadTotal = amount − 一括返済合計 の導出に使う。
 * 回収の振替の recoveredAmountsByItem と同型。
 */
export function loanSettledAmountsByItem(entries: readonly JournalEntry[]): Map<string, number> {
  const settled = new Map<string, number>();
  for (const e of entries) {
    if (e.metadata?.loanSettlement !== true) continue;
    const id = e.metadata.loanItemId;
    if (id === undefined) continue;
    const debit = e.lines.find((l) => l.side === 'debit');
    settled.set(id, assertSafeAmount((settled.get(id) ?? 0) + (debit?.amount ?? 0)));
  }
  return settled;
}

/**
 * 按分する返済総額 = 借入総額 − 一括返済合計（spreadTotalOf と同型の単一正本）。
 * 過返済（負）は保存境界が拒否するので、正常データでは常に 0 以上。
 */
export function loanSpreadTotalOf(
  item: MonthlyCostItem,
  settled: ReadonlyMap<string, number>,
): number {
  return assertSafeAmount(item.amount - (settled.get(item.id) ?? 0));
}

/**
 * 返済の予定表（刻み日と金額）。刻み規約は allocationCuts の単一正本をそのまま使う。
 * 完済日なし（ローンとして不正なデータ）は fail-soft に空（1 本も生まれない）。
 */
export function loanRepaymentSchedule(
  item: MonthlyCostItem,
  spreadTotal: number = item.amount,
): AllocationCut[] {
  if (item.endDate === undefined) return [];
  return allocationCuts(item.startDate, item.endDate, spreadTotal);
}

/**
 * 1 つのローン item を upTo までの返済行（計算で生まれる仕訳）に展開する。
 * ID は `loan-pay-{itemId}-{YYYY-MM}`（刻みは月内に高々 1 本なので月で一意）。
 * metadata は継続コストの導出行と同じ軸（virtual + continuousCostId + ccKind）に乗せる
 * — entryOpen / derivedOrigin の分岐がそのまま item へ辿れる。
 */
export function loanRepaymentEntriesForItem(
  item: MonthlyCostItem,
  upTo: string,
  spreadTotal: number = item.amount,
): JournalEntry[] {
  if (!isLoanItem(item)) return [];
  const source = item.repaymentSourceAccountId;
  const cap = upTo < CONTINUOUS_COST_HARD_CAP ? upTo : CONTINUOUS_COST_HARD_CAP;
  const out: JournalEntry[] = [];
  for (const cut of loanRepaymentSchedule(item, spreadTotal)) {
    if (cut.date > cap) break;
    if (cut.amount === 0) continue;
    const { date, amount } = cut;
    out.push({
      id: `loan-pay-${item.id}-${date.slice(0, 7)}`,
      date,
      description: item.name,
      kind: 'normal',
      lines: [
        { accountId: item.expenseAccountId, side: 'debit', amount },
        { accountId: source, side: 'credit', amount },
      ],
      metadata: { virtual: true, continuousCostId: item.id, ccKind: 'loan-repayment' },
      createdAt: item.createdAt,
      updatedAt: item.updatedAt,
    });
  }
  return out;
}

/** 全ローン item の返済行を upTo まで展開して連結する（一括返済は real から集計）。 */
export function loanRepaymentEntries(
  items: readonly MonthlyCostItem[],
  real: readonly JournalEntry[],
  upTo: string,
): JournalEntry[] {
  const settled = loanSettledAmountsByItem(real);
  return items
    .filter((item) => isLoanItem(item))
    .flatMap((item) => loanRepaymentEntriesForItem(item, upTo, loanSpreadTotalOf(item, settled)));
}

/**
 * 理論残債 = spreadTotal − Σ(刻み ≤ asOf)（remainingValue と同型）。
 * 一括返済（終了）シートの既定額と、台帳のローン行の「残り」がこれを使う。
 * 一括返済合計を spreadTotal で織り込むので、二重に引かない。
 */
export function loanRemainingDebt(
  item: MonthlyCostItem,
  asOf: string,
  spreadTotal: number = item.amount,
): number {
  let done = 0;
  for (const cut of loanRepaymentSchedule(item, spreadTotal)) {
    if (cut.date <= asOf) done = assertSafeAmount(done + cut.amount);
  }
  return assertSafeAmount(spreadTotal - done);
}

/**
 * 残回数 = 基準日より後の刻み数（金額 0 の刻みは導出と同じくスキップ = 数えない）。
 * 旧 loanRemainingInstallments（ルール起票数）の item 版。
 */
export function loanItemRemainingInstallments(
  item: MonthlyCostItem,
  asOf: string,
  spreadTotal: number = item.amount,
): number {
  return loanRepaymentSchedule(item, spreadTotal).filter(
    (cut) => cut.date > asOf && cut.amount !== 0,
  ).length;
}

/**
 * 金額の並び替えに使う符号付きの額（v13.7 I4 の規約を item へ継承）。
 * ローン item の額は**負**として比べる: 数直線の規約（負債は借方の逆向き）と概念を揃える。
 * **表示は変えない**（絶対値 + 負債色のまま。符号は付けない）。持ち物は素の額。
 */
export function loanItemSortAmount(item: MonthlyCostItem): number {
  return isLoanItem(item) ? -item.amount : item.amount;
}

/**
 * 登録・編集プレビュー用の回数（= 実際に立つ返済行の数の上限）。
 * 同日通過 n >= 1 ならその n。n = 0 の縮退は「完済日に全額 1 本」なので 1。
 */
export function loanInstallmentPreviewCount(startDate: string, endDate: string): number {
  const n = dayCutCount(startDate, endDate);
  return n === 0 ? 1 : n;
}

/* ── 旧モデル（ローン = 台帳のルール・v13.6 H4）。v13.13 バッチ内で消費側ごと撤去する ── */

/** @deprecated 旧ルール帰属の判定。ローンは item（isLoanItem）へ移行済み。 */
export function isLoanRule(
  rule: Pick<RecurringRule, 'spreadExpenseAccountId'>,
  roleOf: (id: string) => AccountRole | undefined,
): boolean {
  return isLiabilityRole(roleOf(rule.spreadExpenseAccountId));
}

/** @deprecated 旧ルール帰属。loanItemForLiability へ移行済み。 */
export function loanRuleForLiability(
  rules: readonly RecurringRule[],
  liabilityAccountId: string,
): RecurringRule | undefined {
  return rules.find((rule) => rule.spreadExpenseAccountId === liabilityAccountId);
}

/** @deprecated 旧ルール帰属。loanItemSortAmount へ移行済み。 */
export function loanSortAmount(
  rule: Pick<RecurringRule, 'amount' | 'spreadExpenseAccountId'>,
  roleOf: (id: string) => AccountRole | undefined,
): number {
  return isLoanRule(rule, roleOf) ? -rule.amount : rule.amount;
}

/** @deprecated 排他的終了日はルール帰属の概念。完済日（inclusive）= loanQuickEndDate へ。 */
export function loanRuleEndDate(firstRepaymentDate: string, count: number): string {
  return addMonthsToDate(firstRepaymentDate, count);
}

/** @deprecated 回数は dayCutCount / loanInstallmentPreviewCount から導出する。 */
export function loanInstallmentCount(firstRepaymentDate: string, endDateExclusive: string): number {
  let count = 0;
  while (count <= CATCH_UP_HARD_CAP_MONTHS) {
    if (addMonthsToDate(firstRepaymentDate, count) >= endDateExclusive) break;
    count++;
  }
  return count;
}

/** @deprecated floor 月額は廃止（端数は monthlyAmounts の合計厳密一致で解決）。 */
export function loanMonthlyAmount(total: number, count: number): number {
  if (!Number.isInteger(total) || total < 1 || !Number.isInteger(count) || count < 1) return 0;
  return Math.floor(total / count);
}

/** @deprecated floor 月額 × 回数。廃止予定。 */
export function loanScheduledTotal(monthly: number, count: number): number {
  return monthly * count;
}

/** @deprecated 旧ルール帰属の残回数。item 版 loanItemRemainingInstallments へ移行済み。 */
export function loanRemainingInstallments(rule: RecurringRule, asOf: string): number | undefined {
  const last = recurringRuleLastExistingDate(rule);
  if (rule.endDate === undefined || last === undefined) return undefined;
  return recurringPostingsDue(rule, last).filter((posting) => posting.date > asOf).length;
}

/** @deprecated ルールの位相はローンから消える。 */
export function loanStartMonth(firstRepaymentDate: string): string {
  return monthOf(firstRepaymentDate);
}

/** @deprecated ルールの起票日はローンから消える。 */
export function loanDayOfMonth(firstRepaymentDate: string): number {
  return Number.parseInt(firstRepaymentDate.slice(8, 10), 10);
}
