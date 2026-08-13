/** 定期ルール由来 item の wire/storage ID を扱う単一正本。 */

const ISO_MONTH_SUFFIX = '(\\d{4}-(?:0[1-9]|1[0-2]))';
const RULE_ITEM_ID_PATTERN = new RegExp(`^ccr-(.+)-${ISO_MONTH_SUFFIX}$`);
const RULE_ENTRY_ID_PATTERN = new RegExp(`^rec-(.+)-${ISO_MONTH_SUFFIX}$`);

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

/** 由来 metadata を剥がした通常仕訳はこの namespace からも外す。 */
export function parseRuleEntryId(entryId: string): RecurringRuleEntryOrigin | undefined {
  const match = RULE_ENTRY_ID_PATTERN.exec(entryId);
  if (!match) return undefined;
  return { ruleId: match[1]!, month: match[2]! };
}
