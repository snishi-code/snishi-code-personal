/** 定期ルール由来 item の wire/storage ID を扱う単一正本。 */
import type { JournalEntry, MonthlyCostItem } from './types';

const ISO_MONTH_SUFFIX = '(\\d{4}-(?:0[1-9]|1[0-2]))';
const RULE_ITEM_ID_PATTERN = new RegExp(`^ccr-(.+)-${ISO_MONTH_SUFFIX}$`);
const RULE_ENTRY_ID_PATTERN = new RegExp(`^rec-(.+)-${ISO_MONTH_SUFFIX}$`);
const RULE_LOAN_ITEM_ID_PATTERN = new RegExp(`^ccl-(.+)-${ISO_MONTH_SUFFIX}$`);

export interface RecurringRuleItemOrigin {
  ruleId: string;
  month: string;
}

export type RecurringRuleEntryOrigin = RecurringRuleItemOrigin;

export function ruleEntryId(ruleId: string, month: string): string {
  return `rec-${ruleId}-${month}`;
}

export function ruleItemId(ruleId: string, month: string): string {
  return `ccr-${ruleId}-${month}`;
}

/** ruleId 自体にハイフンを含めても、末尾の起票月だけを分離する。 */
export function parseRuleItemId(itemId: string): RecurringRuleItemOrigin | undefined {
  const match = RULE_ITEM_ID_PATTERN.exec(itemId);
  if (!match) return undefined;
  return { ruleId: match[1]!, month: match[2]! };
}

/**
 * ルール×ローン併用（v13.15 §2.4）: loan ブロック付きルールが起票ごとに導出する
 * ローン item の決定的 ID。ccr-（持ち物 item）と同じ規約の別 namespace。
 */
export function ruleLoanItemId(ruleId: string, month: string): string {
  return `ccl-${ruleId}-${month}`;
}

export function parseRuleLoanItemId(itemId: string): RecurringRuleItemOrigin | undefined {
  const match = RULE_LOAN_ITEM_ID_PATTERN.exec(itemId);
  if (!match) return undefined;
  return { ruleId: match[1]!, month: match[2]! };
}

/** ルールが起票した仕訳だけがこの namespace を名乗る（ルール削除では仕訳ごと消える）。 */
export function parseRuleEntryId(entryId: string): RecurringRuleEntryOrigin | undefined {
  const match = RULE_ENTRY_ID_PATTERN.exec(entryId);
  if (!match) return undefined;
  return { ruleId: match[1]!, month: match[2]! };
}

/*
 * 「ルールから生まれた保存済みの記録か」の単一正本（作者決定 2026-08-15）。
 *
 * ルールは定期起票するだけの軽い道具で、生まれたもの（仕訳・item）への個別操作は一切できない。
 * 調整はルール側の編集・終了・再開で行う。読み取り専用の判定を画面や保存境界へ手書きすると
 * 「一覧では消せないのに保存境界は通る」という穴ができるため、判定はこの 2 本に集約する。
 *
 * 由来メタ（recurringRuleId）と決定的 ID（rec- / ccr-）の**どちらか一方**でも名乗っていれば
 * 由来ありとする＝片側だけ壊れたデータでも読み取り専用側へ倒す（fail-closed）。
 */

/** ルールが起票した保存済み仕訳の由来ルール ID。回収の振替は独立した実仕訳なので対象外。 */
export function generatedEntryRuleId(entry: JournalEntry): string | undefined {
  // 導出行（保存されない計算値）は derivedEntryOrigin の担当。ここは保存済みだけを見る。
  if (entry.metadata?.virtual === true) return undefined;
  if (entry.metadata?.monthlyCostRecovery === true) return undefined;
  return entry.metadata?.recurringRuleId ?? parseRuleEntryId(entry.id)?.ruleId;
}

/** ルールが起票した保存済み item の由来ルール ID（持ち物 ccr- とローン ccl- の両 namespace）。 */
export function generatedItemRuleId(item: MonthlyCostItem): string | undefined {
  return parseRuleItemId(item.id)?.ruleId ?? parseRuleLoanItemId(item.id)?.ruleId;
}
