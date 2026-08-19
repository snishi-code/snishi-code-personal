/*
 * ローン = 台帳のルール（v13.6 H4・作者確定 2026-08-18）。
 *
 * 持ち物（月割り）の**負債版**: 一旦受け止めて吐き出す。
 *  - 保存形は既存の定期ルールそのもの（wire / schema 非接触）。新しいフラグ・role は作らない。
 *    `計上先 = 負債科目` / `源泉 = 返済元` の月次ルールが返済で、導出は 2 本に分かれる:
 *      1. 購入の仕訳（保存されない・v13 完全導出）= `借方 月割り台帳 / 貸方 返済元`
 *      2. 月割りの行 = `借方 負債科目 / 貸方 月割り台帳`
 *    合成すると `借方 負債 / 貸方 返済元` = 返済そのもの。台帳は 1 周期で必ず 0 に戻る。
 *  - **終了日が正**。残回数・月額はここから導出する（台帳の 4 項目モデルと同型）。
 *  - **区別はルールの有無**: ルールを持つ負債だけが月割り台帳に出る（クレカ = 収集器なので
 *    ルールを持たず、資金繰りと勘定科目にだけ居る）。フラグを増やさないための単一正本。
 */
import { addMonthsToDate, monthOf } from './allocation';
import { recurringPostingsDue } from './recurring';
import { recurringRuleLastExistingDate } from './accountLifetime';
import { CATCH_UP_HARD_CAP_MONTHS } from './recurringLimits';
import type { AccountRole } from './accountRoles';
import type { RecurringRule } from './types';

/** 終了日クイックチップの年数（持ち物の [1年][3年][5年] と同じ並び）。 */
export const LOAN_QUICK_YEARS: readonly number[] = [1, 3, 5];

/** 負債の役割（カード・ローン）。 */
export function isLiabilityRole(role: AccountRole | undefined): boolean {
  return role === 'payment-liability' || role === 'other-liability';
}

/**
 * このルールはローン（返済ルール）か。判定は**計上先が負債科目**の一点だけ
 * （ルールの有無 = 台帳に出るかの区別、の単一正本）。
 */
export function isLoanRule(
  rule: Pick<RecurringRule, 'spreadExpenseAccountId'>,
  roleOf: (id: string) => AccountRole | undefined,
): boolean {
  return isLiabilityRole(roleOf(rule.spreadExpenseAccountId));
}

/**
 * 金額の並び替えに使う符号付きの額（v13.7 I4・作者確定 2026-08-18）。
 * ローン（計上先が負債のルール）の額は**負**として比べる: 数直線の規約
 * （accounting の debitSignedBalance = 負債は借方の逆向き）と概念を揃える。
 * 昇順なら返済 4,167 は 3,300 の支出より前（−4,167）に来る。
 * **表示は変えない**（絶対値 + 負債色のまま。符号は付けない）。持ち物・通常ルールは素の額。
 */
export function loanSortAmount(
  rule: Pick<RecurringRule, 'amount' | 'spreadExpenseAccountId'>,
  roleOf: (id: string) => AccountRole | undefined,
): number {
  return isLoanRule(rule, roleOf) ? -rule.amount : rule.amount;
}

/**
 * その負債科目を計上先に持つルール（= 月割り台帳の該当行）。
 * 複数あれば最初の 1 件（資金繰りの行タップの着地点は 1 つでよい）。
 */
export function loanRuleForLiability(
  rules: readonly RecurringRule[],
  liabilityAccountId: string,
): RecurringRule | undefined {
  return rules.find((rule) => rule.spreadExpenseAccountId === liabilityAccountId);
}

/**
 * 初回返済日 = 購入日の 1 か月後（同日・月末クランプ）。
 * 購入当日に返済は起きない（持ち物の「購入当日の費用 0」と同じ向き）。
 */
export function loanFirstRepaymentDate(purchaseDate: string): string {
  return addMonthsToDate(purchaseDate, 1);
}

/**
 * 返済ルールの排他的終了日 = 初回返済日 + count か月。
 * count 回ちょうど起票して終わる（count 回目 = 初回 +(count−1) か月）。
 */
export function loanRuleEndDate(firstRepaymentDate: string, count: number): string {
  return addMonthsToDate(firstRepaymentDate, count);
}

/**
 * 終了日（排他）から返済回数を導出する。**終了日が正**の側の計算で、UI のプレビューと
 * 保存境界が同じ式を使う（月額の分母を二重実装しない）。
 * 初回返済日が終了日以降なら 0（= 起票ゼロ。保存境界が拒否する）。
 */
export function loanInstallmentCount(firstRepaymentDate: string, endDateExclusive: string): number {
  let count = 0;
  while (count < CATCH_UP_HARD_CAP_MONTHS) {
    if (addMonthsToDate(firstRepaymentDate, count) >= endDateExclusive) break;
    count++;
  }
  return count;
}

/**
 * 1 回あたりの返済額 = 総額 ÷ 回数（四捨五入）。
 * 端数は最後まで割り切れないので**負債の残高に残る**（丸めて消さない・利息を分けないのと同じ
 * 割り切り。作者が手仕訳か補正で始末する）。UI は差額を明示する。
 */
export function loanMonthlyAmount(total: number, count: number): number {
  if (!Number.isInteger(total) || total < 1 || !Number.isInteger(count) || count < 1) return 0;
  return Math.max(1, Math.round(total / count));
}

/** 月額 × 回数（借入額との差 = 最後に残る額）。 */
export function loanScheduledTotal(monthly: number, count: number): number {
  return monthly * count;
}

/**
 * 基準日より後に残っている返済回数（終了日から導出）。
 * 終了日なしのルール（= 終わらない返済）は回数が決まらないので undefined。
 */
export function loanRemainingInstallments(rule: RecurringRule, asOf: string): number | undefined {
  const last = recurringRuleLastExistingDate(rule);
  if (rule.endDate === undefined || last === undefined) return undefined;
  return recurringPostingsDue(rule, last).filter((posting) => posting.date > asOf).length;
}

/** ルールの起票月（位相の基点）。作成時に初回返済日から決める。 */
export function loanStartMonth(firstRepaymentDate: string): string {
  return monthOf(firstRepaymentDate);
}

/** 起票日（毎月の返済日）。初回返済日の日をそのまま使う（31 日は月末クランプ）。 */
export function loanDayOfMonth(firstRepaymentDate: string): number {
  return Number.parseInt(firstRepaymentDate.slice(8, 10), 10);
}
