/*
 * 勘定科目の表示順。
 * ユーザーが並び替えた順（sortIndex 昇順）を最優先し、未設定は名前順で末尾に続く。
 * 勘定科目画面・入力チップ・ピッカーなど、科目を列挙する場所はこの比較関数を使う（単一正本）。
 */
import type { Account } from './types';

export function compareAccountOrder(a: Account, b: Account): number {
  const ai = a.sortIndex ?? Number.MAX_SAFE_INTEGER;
  const bi = b.sortIndex ?? Number.MAX_SAFE_INTEGER;
  if (ai !== bi) return ai - bi;
  return a.name.localeCompare(b.name, 'ja');
}

export function sortAccounts(accounts: Account[]): Account[] {
  return [...accounts].sort(compareAccountOrder);
}
