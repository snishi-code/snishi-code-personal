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
  Side,
} from './types';
import { compareAccountOrder } from './accountOrder';
import { assertSafeAmount } from './safeSum';

/** asset / expense は借方が正。liability / equity / revenue は貸方が正。 */
export function isDebitNormal(type: AccountType): boolean {
  return type === 'asset' || type === 'expense';
}

/**
 * 1 行の金額を、その科目の自然な符号（増加 = 正）の増減へ変換する。
 * asset/expense は借方が増、liability/equity/revenue は貸方が増（isDebitNormal が正本）。
 * periodMatrix・抽出→合計エンジンが共有する符号規則の単一正本。
 */
export function naturalDelta(account: Account, side: Side, amount: number): number {
  const increases =
    (side === 'debit' && isDebitNormal(account.type)) ||
    (side === 'credit' && !isDebitNormal(account.type));
  return increases ? amount : -amount;
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
      if (line.side === 'debit') debit = assertSafeAmount(debit + line.amount);
      else credit = assertSafeAmount(credit + line.amount);
    }
  }
  return assertSafeAmount(isDebitNormal(type) ? debit - credit : credit - debit);
}

/** [from, to] の両端を含むフィルタ。未指定の端は無制限。 */
/**
 * 実仕訳にこの科目の行が 1 つでもあるか。
 * 「補正」導線の分岐に使う: 履歴が全く無い科目への実残高入力は、補正（差分が収入/費用扱い）
 * ではなく初期残高として登録する。残高がたまたま 0 の科目（履歴あり）は補正のまま。
 */
export function accountHasEntries(entries: JournalEntry[], accountId: string): boolean {
  return entries.some((e) => e.lines.some((l) => l.accountId === accountId));
}

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
      .sort((a, b) => compareAccountOrder(a.account, b.account))
  );
}

function sum(items: AccountBalance[]): number {
  return assertSafeAmount(items.reduce((s, b) => assertSafeAmount(s + b.balance), 0));
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
    netIncome: assertSafeAmount(totalRevenue - totalExpense),
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
    .reduce((s, a) => assertSafeAmount(s + accountBalance(a.id, 'revenue', entries)), 0);
  const totalExpense = accounts
    .filter((a) => a.type === 'expense')
    .reduce((s, a) => assertSafeAmount(s + accountBalance(a.id, 'expense', entries)), 0);
  const retainedEarnings = assertSafeAmount(totalRevenue - totalExpense);

  const netAssets = assertSafeAmount(totalAssets - totalLiabilities);
  const totalEquity = assertSafeAmount(totalEquityAccounts + retainedEarnings);
  const balanced = netAssets === totalEquity;

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

/* ── 抽出 → 合計の統一エンジン ──
 *
 * 「導出込み仕訳列（reportEntriesForAsOf の結果）→ 条件（述語）→ 件数と合計」を
 * 1 箇所で定義する。合計規則は 2 モード:
 *  - 方向つき和（科目視点・summarizeEntriesForAccount）: 指定科目の行だけを naturalDelta で合算。
 *  - 単純和（テキスト抽出視点・summarizeEntries）: 仕訳ごとに金額を 1 回だけ数える
 *    （= 各仕訳の借方合計。現行は 1 借 1 貸同額なので仕訳の金額そのもの。
 *     借方行と貸方行を両方足す二重計上をしない。将来複合仕訳が入っても
 *     「借方合計を 1 回」の定義は変わらない）。
 */

/** 抽出結果の件数と合計。 */
export interface EntrySummary {
  /** 条件に一致した仕訳の件数。 */
  count: number;
  /** 合計。規則は呼び出したモード（方向つき和 / 単純和）で決まる。 */
  total: number;
}

/** 仕訳 1 件の金額 = 借方合計（単純和の単位。現行の 1 借 1 貸では仕訳の金額そのもの）。 */
export function entryAmount(entry: JournalEntry): number {
  let total = 0;
  for (const line of entry.lines) {
    if (line.side === 'debit') total = assertSafeAmount(total + line.amount);
  }
  return total;
}

/**
 * 仕訳の代表額（2 行前提なので借方額 = 貸方額）。**checked sum を通さない**のが上の
 * entryAmount との唯一の違い: React の render / useMemo から呼ぶ表示用の値で、
 * assertSafeAmount が投げると root の ErrorBoundary がアプリ全体を復旧画面へ落とす。
 * 集計・保存境界の正本は entryAmount（fail-closed）。表示だけがこちらを使う。
 */
export function representativeEntryAmount(entry: JournalEntry): number {
  return entry.lines.find((l) => l.side === 'debit')?.amount ?? entry.lines[0]?.amount ?? 0;
}

/** 単純和（テキスト抽出視点）: 条件に一致した仕訳の件数と、仕訳ごとの金額（借方合計）の合計。 */
export function summarizeEntries(
  entries: JournalEntry[],
  predicate: (entry: JournalEntry) => boolean,
): EntrySummary {
  let count = 0;
  let total = 0;
  for (const entry of entries) {
    if (!predicate(entry)) continue;
    count += 1;
    total = assertSafeAmount(total + entryAmount(entry));
  }
  return { count, total };
}

/**
 * 方向つき和（科目視点）: 条件に一致し、かつ指定科目の行を持つ仕訳の件数と、
 * その科目の行だけを naturalDelta（自然な符号）で合算した合計。
 * 指定科目の行を持たない仕訳は件数にも合計にも入れない。
 */
export function summarizeEntriesForAccount(
  account: Account,
  entries: JournalEntry[],
  predicate: (entry: JournalEntry) => boolean,
): EntrySummary {
  let count = 0;
  let total = 0;
  for (const entry of entries) {
    if (!predicate(entry)) continue;
    let matched = false;
    for (const line of entry.lines) {
      if (line.accountId !== account.id) continue;
      matched = true;
      total = assertSafeAmount(total + naturalDelta(account, line.side, line.amount));
    }
    if (matched) count += 1;
  }
  return { count, total };
}

/* ── equity の集計上の定義（正本） ──
 *
 * equity は損益（収支）に含めない。純資産の変動を説明する独立項である。恒等式:
 *   年末純資産 − 前年末純資産 = 当年の収支（収益 − 費用） + 当年の equity 自然増減
 * （自然増減 = 貸方正）。periodMatrix・accounting 系はこの定義を共有し、
 * equity を収益・費用のどちらにも算入しない（deriveProfitAndLoss / buildPeriodMatrix の
 * revenue・expense に equity 行は入らない）。
 */

/** 期間内（両端を含む・未指定の端は無制限）の equity 自然増減（貸方正）。恒等式の右辺第 2 項。 */
export function equityNaturalDelta(
  accounts: Account[],
  allEntries: JournalEntry[],
  range?: { from?: string; to?: string },
): number {
  const equityById = new Map(
    accounts.filter((a) => a.type === 'equity').map((a) => [a.id, a] as const),
  );
  let total = 0;
  for (const entry of filterByDateRange(allEntries, range?.from, range?.to)) {
    for (const line of entry.lines) {
      const account = equityById.get(line.accountId);
      if (account) total = assertSafeAmount(total + naturalDelta(account, line.side, line.amount));
    }
  }
  return total;
}
