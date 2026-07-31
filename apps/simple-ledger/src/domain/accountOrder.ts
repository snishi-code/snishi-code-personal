/*
 * 勘定科目の表示順。
 * role の表示優先順を最優先し、同じ role の中ではユーザーが並び替えた順
 * （sortIndex 昇順）→名前順で並べる。
 * 勘定科目画面・入力チップ・ピッカーなど、科目を列挙する場所はこの比較関数を使う（単一正本）。
 */
import type { Account } from './types';

const TYPE_ORDER: Record<Account['type'], number> = {
  asset: 0,
  liability: 1,
  equity: 2,
  revenue: 3,
  expense: 4,
};

const ROLE_ORDER: Partial<Record<Account['role'], number>> = {
  'daily-asset': 0,
  'continuing-cost-asset': 2,
  'investment-asset': 3,
  'payment-liability': 0,
  'other-liability': 1,
  equity: 0,
  'income-category': 0,
  'expense-category': 0,
  // type が revenue/expense のどちらでも、そのセクションの末尾に置く。
  'system-adjustment': 1,
};

export function compareAccountOrder(a: Account, b: Account): number {
  const typeDiff = TYPE_ORDER[a.type] - TYPE_ORDER[b.type];
  if (typeDiff !== 0) return typeDiff;
  const roleDiff =
    (ROLE_ORDER[a.role] ?? Number.MAX_SAFE_INTEGER) -
    (ROLE_ORDER[b.role] ?? Number.MAX_SAFE_INTEGER);
  if (roleDiff !== 0) return roleDiff;
  const ai = a.sortIndex ?? Number.MAX_SAFE_INTEGER;
  const bi = b.sortIndex ?? Number.MAX_SAFE_INTEGER;
  if (ai !== bi) return ai - bi;
  return a.name.localeCompare(b.name, 'ja');
}

export function sortAccounts(accounts: Account[]): Account[] {
  return [...accounts].sort(compareAccountOrder);
}
