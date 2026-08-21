/*
 * ルール×ローン併用（RecurringRule.loan・v13.15）の整合検査の**単一正本**（v13.19 監査 #2）。
 * wire（schema の package superRefine）と保存境界（repository の rule 保存検証）が
 * 同じ関数を呼ぶ — 二重実装で将来ずれるのを防ぐのが本題。
 */
import { monthsBetween } from './allocation';
import type { AccountRole } from './accountRoles';
import { ruleExistsAt } from './accountLifetime';
import { isLiabilityRole } from './loan';
import { clampDayToMonth, isRecurringPostableRole } from './recurring';
import { parseRuleLoanItemId } from './recurringIds';
import type { JournalEntry, RecurringRule } from './types';

/** loan ブロックの違反種別（undefined = 整合）。 */
export type LoanBlockViolation =
  | 'credit-not-liability'
  | 'source-missing'
  | 'source-not-postable'
  | 'source-same-as-credit';

/**
 * loan ブロックの検証: ①源泉が負債（片方向 — loan 無しで源泉 = 負債のクレカ定期支出は
 * 合法のまま）②返済元が存在 ③postable role ④源泉と非同一。
 * `roleOf` は科目 ID → role（存在しなければ undefined）。
 */
export function loanBlockViolation(
  rule: Pick<RecurringRule, 'creditAccountId' | 'loan'>,
  roleOf: (accountId: string) => AccountRole | undefined,
): LoanBlockViolation | undefined {
  if (rule.loan === undefined) return undefined;
  if (!isLiabilityRole(roleOf(rule.creditAccountId))) return 'credit-not-liability';
  const sourceRole = roleOf(rule.loan.repaymentSourceAccountId);
  if (sourceRole === undefined) return 'source-missing';
  if (!isRecurringPostableRole(sourceRole)) return 'source-not-postable';
  if (rule.loan.repaymentSourceAccountId === rule.creditAccountId) return 'source-same-as-credit';
  return undefined;
}

/** ルール由来ローン item（ccl-）の参照解決の形（保存されないため導出条件から作る）。 */
export interface DerivedRuleLoanItemRef {
  /** その月の起票日 = ローン item の startDate（一括返済の日付下限）。 */
  postingDate: string;
  /** 負債 = ルールの源泉（一括返済の借方）。 */
  liabilityAccountId: string;
  /** 借入総額 = rule.amount（過返済の上限）。 */
  amount: number;
}

/**
 * loan ブロック付きルールが month を実際に導出するときだけ形を返す
 * （位相・存在期間・loan の有無 — wire の derivedLoanItemOf と保存境界の
 * 参照解決が共有する単一正本・v13.19 監査 #4）。
 */
export function derivedRuleLoanItemRef(
  rule: RecurringRule,
  month: string,
): DerivedRuleLoanItemRef | undefined {
  if (rule.loan === undefined) return undefined;
  const span = monthsBetween(rule.startMonth, month);
  if (span < 0 || span % Math.max(1, rule.everyMonths) !== 0) return undefined;
  const date = clampDayToMonth(month, rule.dayOfMonth);
  if (!ruleExistsAt(rule, date)) return undefined;
  return { postingDate: date, liabilityAccountId: rule.creditAccountId, amount: rule.amount };
}

/** ルール由来ローンへの一括返済実仕訳の違反種別（undefined = 整合）。 */
export type RuleLoanSettlementViolation =
  | 'orphan' // 参照先の月がもう導出されない（周期・存在期間・loan の変更で宙に浮いた）
  | 'debit-mismatch' // 借方が負債（源泉）でない（源泉の付け替えで不一致になった）
  | 'before-posting' // 日付が起票日より前
  | 'over-settled'; // ccl ごとの合計 > 借入総額（rule.amount）

/**
 * このルールの導出 ccl- を参照する既存の一括返済実仕訳（loanSettlement）が、
 * **現在のルール条件で**整合しているか（v13.19 監査 #4 — retroactive 変更の保存時に
 * 呼ぶ。wire の per-entry 検査・Σ 過返済検査と同じ規則の単一正本）。
 */
export function ruleLoanSettlementViolation(
  rule: RecurringRule,
  entries: readonly JournalEntry[],
): RuleLoanSettlementViolation | undefined {
  const totals = new Map<string, number>();
  for (const entry of entries) {
    if (entry.metadata?.loanSettlement !== true) continue;
    const loanId = entry.metadata.loanItemId;
    const ref = loanId !== undefined ? parseRuleLoanItemId(loanId) : undefined;
    if (ref === undefined || ref.ruleId !== rule.id) continue;
    const derived = derivedRuleLoanItemRef(rule, ref.month);
    if (derived === undefined) return 'orphan';
    const debit = entry.lines.find((line) => line.side === 'debit');
    if (debit?.accountId !== derived.liabilityAccountId) return 'debit-mismatch';
    if (entry.date < derived.postingDate) return 'before-posting';
    totals.set(loanId!, (totals.get(loanId!) ?? 0) + (debit?.amount ?? 0));
  }
  for (const total of totals.values()) {
    if (total > rule.amount) return 'over-settled';
  }
  return undefined;
}
