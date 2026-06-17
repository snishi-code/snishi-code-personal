/*
 * 勘定科目の「使用中」判定。仕訳・予定CF・目的別資金・按分・月額化コストのいずれかから
 * 参照されていれば使用中。UI（科目一覧・編集シート）と repository（区分変更/削除の fail-closed）で
 * 同じ判定を使う。
 */
import type {
  AllocationItem,
  CashflowSchedule,
  JournalEntry,
  MonthlyCostItem,
  ReserveItem,
} from './types';

export interface AccountRefCollections {
  entries: JournalEntry[];
  schedules: CashflowSchedule[];
  reserves: ReserveItem[];
  allocations: AllocationItem[];
  monthlyCostItems: MonthlyCostItem[];
}

function monthlyCostRefs(m: MonthlyCostItem): (string | undefined)[] {
  // 資産経由モデルの paymentSourceAccountId（支払い元）/ recognitionCreditAccountId（継続コスト対象資産・
  // 固定資産）も参照に含める。これらを参照中の科目は削除/区分変更を fail-closed にする
  // （消すと仮想展開が壊れる）。
  return [
    m.expenseAccountId,
    m.paymentSourceAccountId,
    m.paymentAccountId,
    m.repaymentAccountId,
    m.recognitionCreditAccountId,
  ];
}

export function isAccountReferenced(id: string, c: AccountRefCollections): boolean {
  return (
    c.entries.some((e) => e.lines.some((l) => l.accountId === id)) ||
    c.schedules.some((s) => s.accountId === id || s.counterAccountId === id) ||
    c.reserves.some((r) => r.reserveAccountId === id) ||
    c.allocations.some(
      (a) => a.expenseAccountId === id || a.paymentAccountId === id || a.deferredAccountId === id,
    ) ||
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
  for (const r of c.reserves) set.add(r.reserveAccountId);
  for (const a of c.allocations) {
    set.add(a.expenseAccountId);
    set.add(a.paymentAccountId);
    set.add(a.deferredAccountId);
  }
  for (const m of c.monthlyCostItems) {
    for (const ref of monthlyCostRefs(m)) if (ref) set.add(ref);
  }
  return set;
}
