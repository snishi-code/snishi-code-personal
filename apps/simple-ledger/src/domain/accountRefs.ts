/*
 * 勘定科目の「使用中」判定。仕訳・補正 pin（metadata）・継続コスト・定期ルールのいずれかから
 * 参照されていれば使用中。UI（科目一覧・編集シート）と repository（区分変更/削除の fail-closed）で
 * 同じ判定を使う。
 */
import type { JournalEntry, MonthlyCostItem, RecurringRule } from './types';

export interface AccountRefCollections {
  entries: JournalEntry[];
  monthlyCostItems: MonthlyCostItem[];
  recurringRules: RecurringRule[];
}

function monthlyCostRefs(m: MonthlyCostItem): (string | undefined)[] {
  // 4項目モデルの参照は費用の行き先と、ローン item の返済元（v13.13 監査 #5・critical）。
  // 返済の導出行は毎回仮想で**保存仕訳が返済元への参照を持たない**ため、ここに入れないと
  // 返済元科目を削除できてしまう（削除ガード・区分変更・使用中バッジが同じ 1 本で追従する）。
  // 支払い元は購入/借入の仕訳（保存される仕訳）が参照する。
  // 継続コスト台帳は定数参照（保護は deleteAccount の role ガード）。
  return [m.expenseAccountId, m.repaymentSourceAccountId];
}

function recurringRuleRefs(r: RecurringRule): (string | undefined)[] {
  // 定期ルールは未起票でも科目を参照する。ここに入れないと、ルールだけが参照する科目を
  // 削除でき、起票不能 + export が schema の参照検証で拒否される（監査 P1-7）。
  // loan ブロックの返済元も同列（v13.15 §2.4 — 返済の導出行は保存されないため、
  // ここに入れないと返済元科目を削除できてしまう。stored loan item の返済元と同じ理由）。
  return [
    r.debitAccountId,
    r.creditAccountId,
    r.spreadExpenseAccountId,
    r.loan?.repaymentSourceAccountId,
  ];
}

/**
 * 補正 pin の参照 = 対象科目 + 記録相手科目（= 実効計上先・v13.14）。
 * pin の正本は metadata（仕訳の行から対象科目を推測しない）なので、lines と独立に数える。
 * lines 走査だけに頼ると、metadata と食い違う破損データで pin の参照先を削除でき、
 * unspread（復旧表示）の新規発生経路になる。UI の紐づき件数（AccountSheet）と
 * 削除の理由付き拒否（repository）も同じ 2 参照を見る。
 */
export function adjustmentRefs(e: JournalEntry): (string | undefined)[] {
  const adj = e.metadata?.adjustment;
  return adj ? [adj.accountId, adj.counterpartAccountId] : [];
}

export function isAccountReferenced(id: string, c: AccountRefCollections): boolean {
  return (
    c.entries.some(
      (e) => e.lines.some((l) => l.accountId === id) || adjustmentRefs(e).includes(id),
    ) ||
    c.monthlyCostItems.some((m) => monthlyCostRefs(m).includes(id)) ||
    c.recurringRules.some((r) => recurringRuleRefs(r).includes(id))
  );
}

/** 参照されている科目 ID の集合（一覧表示の「使用中」バッジ用）。 */
export function referencedAccountIds(c: AccountRefCollections): Set<string> {
  const set = new Set<string>();
  for (const e of c.entries) {
    for (const l of e.lines) set.add(l.accountId);
    for (const ref of adjustmentRefs(e)) if (ref) set.add(ref);
  }
  for (const m of c.monthlyCostItems) {
    for (const ref of monthlyCostRefs(m)) if (ref) set.add(ref);
  }
  for (const r of c.recurringRules) {
    for (const ref of recurringRuleRefs(r)) if (ref) set.add(ref);
  }
  return set;
}
