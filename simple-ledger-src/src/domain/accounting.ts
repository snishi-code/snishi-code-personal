/*
 * PL / BS の導出ロジック。
 *
 * 重要: PL も BS も「保存しない」。仕訳(JournalEntry)と科目(Account)から毎回計算する。
 * これが単一の正本ルール（導出結果を二重に持たない）。
 */
import type {
  Account,
  AccountBalance,
  AccountType,
  BalanceSheet,
  JournalEntry,
  ProfitAndLoss,
} from './types';

/** asset / expense は借方が正。liability / equity / revenue は貸方が正。 */
export function isDebitNormal(type: AccountType): boolean {
  return type === 'asset' || type === 'expense';
}

/** 1 科目の、自然な符号での残高を計算する。 */
export function accountBalance(
  accountId: string,
  type: AccountType,
  entries: JournalEntry[],
): number {
  let debit = 0;
  let credit = 0;
  for (const entry of entries) {
    for (const line of entry.lines) {
      if (line.accountId !== accountId) continue;
      if (line.side === 'debit') debit += line.amount;
      else credit += line.amount;
    }
  }
  return isDebitNormal(type) ? debit - credit : credit - debit;
}

/** [from, to] の両端を含むフィルタ。未指定の端は無制限。 */
export function filterByDateRange(
  entries: JournalEntry[],
  from?: string,
  to?: string,
): JournalEntry[] {
  return entries.filter((e) => {
    if (from && e.date < from) return false;
    if (to && e.date > to) return false;
    return true;
  });
}

function balancesFor(
  accounts: Account[],
  entries: JournalEntry[],
  type: AccountType,
): AccountBalance[] {
  return (
    accounts
      .filter((a) => a.type === type)
      .map((account) => ({ account, balance: accountBalance(account.id, type, entries) }))
      // 残高 0 かつアーカイブ済みは表示から外す。残高があれば（アーカイブでも）残す。
      .filter((b) => b.balance !== 0 || !b.account.archived)
  );
}

function sum(items: AccountBalance[]): number {
  return items.reduce((s, b) => s + b.balance, 0);
}

/** 損益計算書（revenue / expense から導出）。 */
export function deriveProfitAndLoss(
  accounts: Account[],
  allEntries: JournalEntry[],
  range?: { from?: string; to?: string },
): ProfitAndLoss {
  const entries = filterByDateRange(allEntries, range?.from, range?.to);
  const revenues = balancesFor(accounts, entries, 'revenue');
  const expenses = balancesFor(accounts, entries, 'expense');
  const totalRevenue = sum(revenues);
  const totalExpense = sum(expenses);
  return {
    ...(range?.from !== undefined ? { from: range.from } : {}),
    ...(range?.to !== undefined ? { to: range.to } : {}),
    revenues,
    expenses,
    totalRevenue,
    totalExpense,
    netIncome: totalRevenue - totalExpense,
  };
}

/**
 * 貸借対照表（asset / liability / equity から導出）。
 *
 * MVP は未締めのため、当期純損益(revenue-expense)を retainedEarnings として
 * equity 側に算入し、貸借を一致させる。
 *   純資産 = 資産 - 負債 = equity 科目合計 + 当期純損益
 */
export function deriveBalanceSheet(
  accounts: Account[],
  allEntries: JournalEntry[],
  asOf?: string,
): BalanceSheet {
  const entries = filterByDateRange(allEntries, undefined, asOf);
  const assets = balancesFor(accounts, entries, 'asset');
  const liabilities = balancesFor(accounts, entries, 'liability');
  const equity = balancesFor(accounts, entries, 'equity');

  const totalAssets = sum(assets);
  const totalLiabilities = sum(liabilities);
  const totalEquityAccounts = sum(equity);

  const totalRevenue = accounts
    .filter((a) => a.type === 'revenue')
    .reduce((s, a) => s + accountBalance(a.id, 'revenue', entries), 0);
  const totalExpense = accounts
    .filter((a) => a.type === 'expense')
    .reduce((s, a) => s + accountBalance(a.id, 'expense', entries), 0);
  const retainedEarnings = totalRevenue - totalExpense;

  const netAssets = totalAssets - totalLiabilities;
  const balanced = netAssets === totalEquityAccounts + retainedEarnings;

  return {
    ...(asOf !== undefined ? { asOf } : {}),
    assets,
    liabilities,
    equity,
    totalAssets,
    totalLiabilities,
    totalEquityAccounts,
    retainedEarnings,
    netAssets,
    balanced,
  };
}

/** 月初/月末の ISO 日付 (YYYY-MM-DD) を返す。 */
export function monthRange(year: number, month1to12: number): { from: string; to: string } {
  const mm = String(month1to12).padStart(2, '0');
  const from = `${year}-${mm}-01`;
  // 翌月 0 日 = 当月末日。
  const lastDay = new Date(Date.UTC(year, month1to12, 0)).getUTCDate();
  const to = `${year}-${mm}-${String(lastDay).padStart(2, '0')}`;
  return { from, to };
}
