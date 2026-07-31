/*
 * 資産・負債科目の終了点残高を検証する単一正本。
 *
 * 費用・収入の累計は過去の記録なので対象外。終了点を持つ資産・負債だけ、全実仕訳と
 * 継続コスト・定期ルールの導出を含めて endDate 時点で 0 でなければならない。
 */
import { accountBalance } from './accounting';
import { reportEntriesForAsOf } from './reportEntries';
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
