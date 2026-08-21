/*
 * ルール×ローン併用（RecurringRule.loan・v13.15）の整合検査の**単一正本**（v13.19 監査 #2）。
 * wire（schema の package superRefine）と保存境界（repository の rule 保存検証）が
 * 同じ関数を呼ぶ — 二重実装で将来ずれるのを防ぐのが本題。
 */
import type { AccountRole } from './accountRoles';
import { isLiabilityRole } from './loan';
import { isRecurringPostableRole } from './recurring';
import type { RecurringRule } from './types';

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
