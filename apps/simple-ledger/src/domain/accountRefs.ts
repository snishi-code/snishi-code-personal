/*
 * 勘定科目の「使用中」判定。仕訳・予定CF・取り置き・継続コストのいずれかから
 * 参照されていれば使用中。UI（科目一覧・編集シート）と repository（区分変更/削除の fail-closed）で
 * 同じ判定を使う。
 */
import type { CashflowSchedule, JournalEntry, MonthlyCostItem, ReserveItem } from './types';

export interface AccountRefCollections {
  entries: JournalEntry[];
  schedules: CashflowSchedule[];
  reserves: ReserveItem[];
  monthlyCostItems: MonthlyCostItem[];
}

function monthlyCostRefs(m: MonthlyCostItem): (string | undefined)[] {
  // 4項目モデルの参照は費用の行き先だけ。支払い元は購入の仕訳（保存される仕訳）が参照する。
  // 継続コスト台帳は定数参照（保護は deleteAccount の role ガード）。
  return [m.expenseAccountId];
}

export function isAccountReferenced(id: string, c: AccountRefCollections): boolean {
  return (
    c.entries.some((e) => e.lines.some((l) => l.accountId === id)) ||
    c.schedules.some((s) => s.accountId === id || s.counterAccountId === id) ||
    c.reserves.some((r) => r.reserveAccountId === id || r.parentAccountId === id) ||
    c.monthlyCostItems.some((m) => monthlyCostRefs(m).includes(id))
  );
}

/** 参照されている科目 ID の集合（一覧表示の「使用中」バッジ用）。 */
export function referencedAccountIds(c: AccountRefCollections): Set<string> {
  const set = new Set<string>();
  for (const e of c.entries) for (const l of e.lines) set.add(l.accountId);
  for (const s of c.schedules) {
    set.add(s.accountId);
    if (s.counterAccountId) set.add(s.counterAccountId);
  }
  for (const r of c.reserves) {
    set.add(r.reserveAccountId);
    if (r.parentAccountId) set.add(r.parentAccountId);
  }
  for (const m of c.monthlyCostItems) {
    for (const ref of monthlyCostRefs(m)) if (ref) set.add(ref);
  }
  return set;
}
