/*
 * 資産・負債科目の終了点残高を検証する単一正本。
 *
 * 費用・収入の累計は過去の記録なので対象外。終了点を持つ資産・負債だけ、全実仕訳と
 * 継続コスト・定期ルールの導出を含めて endDate 時点で 0 でなければならない。
 */
import { accountBalance } from './accounting';
import { monthOf, monthsBetween } from './allocation';
import { recurringRuleLastExistingDate } from './accountLifetime';
import { MAX_LEDGER_DATE } from './calendar';
import { reportEntriesForAsOf } from './reportEntries';
import { assertSafeAmount } from './safeSum';
import type { Account, JournalEntry, MonthlyCostItem, RecurringRule } from './types';

export interface AccountEndingSource {
  accounts: Account[];
  journalEntries: JournalEntry[];
  monthlyCostItems: MonthlyCostItem[];
  recurringRules: RecurringRule[];
}

export interface AccountEndingBalanceViolation {
  account: Account;
  balance: number;
}

export function accountEndingBalanceViolations(
  source: AccountEndingSource,
  accountIds?: ReadonlySet<string>,
): AccountEndingBalanceViolation[] {
  const entriesByDate = new Map<string, JournalEntry[]>();
  const violations: AccountEndingBalanceViolation[] = [];
  for (const account of source.accounts) {
    if (accountIds && !accountIds.has(account.id)) continue;
    if (
      account.endDate === undefined ||
      (account.type !== 'asset' && account.type !== 'liability')
    ) {
      continue;
    }
    let entries = entriesByDate.get(account.endDate);
    if (!entries) {
      entries = reportEntriesForAsOf(source, account.endDate);
      entriesByDate.set(account.endDate, entries);
    }
    const balance = accountBalance(account.id, account.type, entries);
    if (balance !== 0) violations.push({ account, balance });
  }
  return violations;
}

/**
 * 台帳全体の金額容量の上界検査（v13.9 項目 6・監査 #5）。
 *
 * 終了日の無い科目を含むどの断面・どの科目の累計残高も、集計（checked sum = safeSum）が
 * render 中に throw しない = 安全整数域に収まることを、**保存境界で**保証する。
 * 断面ごとに全導出を回す代わりに、導出行が保存金額の再配分・複製であることを使った
 * 上界で判定する（どの部分和も Σ|寄与| を超えないので、上界が安全なら全断面が安全）:
 *  - 実仕訳の各行 ×2（補正 pin は stored を除いて按分スライス（合計 ≤ |delta|）へ
 *    置き換わるため、stored + スライスを重複して数えても ×2 で覆う）
 *  - 持ち物 ×2（月割り行は借方・貸方の 2 行 × 合計 ≤ amount。購入の仕訳は上で計上済み)
 *  - 定期ルール = 起票回数 ×4（購入の仕訳 2 行 + 導出 item の月割り 2 行）。終了なしの
 *    ルールは導出地平の上限（MAX_LEDGER_DATE）までの回数で数える（導出はそこで止まる）
 * 上界なので実際の限界より手前で止まるが、拒否が起きる規模（合計 10^15 minor 級）は
 * 家計の実用域から桁違いに遠い（fail-closed の防御的検査）。
 */
export function ledgerAmountCapacityExceeded(source: AccountEndingSource): boolean {
  try {
    let total = 0;
    for (const entry of source.journalEntries) {
      for (const line of entry.lines) total = assertSafeAmount(total + line.amount * 2);
    }
    for (const item of source.monthlyCostItems) {
      total = assertSafeAmount(total + item.amount * 2);
    }
    for (const rule of source.recurringRules) {
      const horizon = recurringRuleLastExistingDate(rule) ?? MAX_LEDGER_DATE;
      const span = monthsBetween(rule.startMonth, monthOf(horizon));
      if (span < 0) continue;
      const postings = Math.floor(span / Math.max(1, rule.everyMonths)) + 1;
      total = assertSafeAmount(total + assertSafeAmount(postings * rule.amount) * 4);
    }
    return false;
  } catch {
    return true;
  }
}
