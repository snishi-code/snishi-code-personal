/*
 * タグのドメインヘルパ。タグは PL/BS を変えない分析軸。
 *  - 全体タグ(entry): 仕訳全体に付く（旅行・学会 等）
 *  - 明細タグ(line):  借方/貸方の明細に付く（カード名・銀行名 等）
 */
import type { JournalEntry, Tag, TagScope } from './types';
import { filterByDateRange } from './accounting';

export function tagAllowsEntry(scope: TagScope): boolean {
  return scope === 'entry' || scope === 'both';
}
export function tagAllowsLine(scope: TagScope): boolean {
  return scope === 'line' || scope === 'both';
}

/** 仕訳の代表額（2 行前提なので借方額 = 貸方額）。 */
export function entryAmount(entry: JournalEntry): number {
  return entry.lines.find((l) => l.side === 'debit')?.amount ?? entry.lines[0]?.amount ?? 0;
}

/** 取消/返金（逆仕訳）か。タグ集計では金額を負に扱う。 */
export function isReversalEntry(entry: JournalEntry): boolean {
  return (
    entry.metadata?.inputMode === 'reversal' || entry.metadata?.reversalOfEntryId !== undefined
  );
}

/** タグ集計での符号付き代表額（reversal は負）。 */
export function signedEntryAmount(entry: JournalEntry): number {
  return isReversalEntry(entry) ? -entryAmount(entry) : entryAmount(entry);
}

/** 仕訳が指定タグを（全体 or いずれかの明細で）持つか。 */
export function entryHasTag(entry: JournalEntry, tagId: string): boolean {
  if (entry.tagIds?.includes(tagId)) return true;
  return entry.lines.some((l) => l.tagIds?.includes(tagId));
}

export interface EntryTagTotal {
  tag: Tag;
  count: number;
  total: number;
}

export interface LineTagTotal {
  tag: Tag;
  debit: number;
  credit: number;
}

/** 全体タグ（entry|both）の、期間内のタグ付き仕訳合計。 */
export function aggregateEntryTags(
  entries: JournalEntry[],
  tags: Tag[],
  range?: { from?: string; to?: string },
): EntryTagTotal[] {
  const inRange = filterByDateRange(entries, range?.from, range?.to);
  return tags
    .filter((t) => tagAllowsEntry(t.scope))
    .map((tag) => {
      const tagged = inRange.filter((e) => e.tagIds?.includes(tag.id));
      return {
        tag,
        count: tagged.length,
        // 取消/返金は負で集計（旅行費などから返金が差し引かれる）。
        total: tagged.reduce((s, e) => s + signedEntryAmount(e), 0),
      };
    });
}

/** 明細タグ（line|both）の、期間内の借方/貸方合計。 */
export function aggregateLineTags(
  entries: JournalEntry[],
  tags: Tag[],
  range?: { from?: string; to?: string },
): LineTagTotal[] {
  const inRange = filterByDateRange(entries, range?.from, range?.to);
  return tags
    .filter((t) => tagAllowsLine(t.scope))
    .map((tag) => {
      let debit = 0;
      let credit = 0;
      for (const e of inRange) {
        for (const l of e.lines) {
          if (!l.tagIds?.includes(tag.id)) continue;
          if (l.side === 'debit') debit += l.amount;
          else credit += l.amount;
        }
      }
      return { tag, debit, credit };
    });
}
