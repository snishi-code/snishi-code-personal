/*
 * タグのドメインヘルパ。タグは PL/BS を変えない分析軸。
 * タグは常に「仕訳全体（entry）」に付く（旅行・帰省・学会 等のイベント/目的ラベル）。
 * カード名・銀行名・Pay 系名はタグにしない（支払い手段の細目 = AccountInstrument で扱う）。
 */
import type { CashflowSchedule, JournalEntry, Tag } from './types';
import type { MessageKey } from '../i18n';
import { filterByDateRange } from './accounting';

/* ── 使用状況・代入検証（UI と repository で共通の不変条件を使う） ── */

/** タグが仕訳または予定CFから参照されているか（削除可否の判定に使う）。 */
export function isTagReferenced(
  tagId: string,
  entries: JournalEntry[],
  schedules: CashflowSchedule[],
): boolean {
  return (
    entries.some((e) => e.tagIds?.includes(tagId)) ||
    schedules.some((s) => s.entryTagIds?.includes(tagId))
  );
}

/**
 * タグ代入（tagIds）が存在の不変条件を満たすか検証する。
 * 違反があれば i18n エラーコード、無ければ null。import 検証と同じルールを保存時にも使う。
 * 文言は持たず code を返す（呼び出し側が LedgerError 化して UI で表示する）。
 */
export function tagAssignmentError(
  tagIds: string[] | undefined,
  tagById: Map<string, Tag>,
): MessageKey | null {
  for (const id of tagIds ?? []) {
    if (!tagById.has(id)) return 'error.tag.unknown';
  }
  return null;
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

/** 仕訳が指定タグ（仕訳全体タグ）を持つか。 */
export function entryHasTag(entry: JournalEntry, tagId: string): boolean {
  return entry.tagIds?.includes(tagId) ?? false;
}

export interface EntryTagTotal {
  tag: Tag;
  count: number;
  total: number;
}

/** 仕訳全体タグの、期間内のタグ付き仕訳合計。 */
export function aggregateEntryTags(
  entries: JournalEntry[],
  tags: Tag[],
  range?: { from?: string; to?: string },
): EntryTagTotal[] {
  const inRange = filterByDateRange(entries, range?.from, range?.to);
  return tags.map((tag) => {
    const tagged = inRange.filter((e) => e.tagIds?.includes(tag.id));
    return {
      tag,
      count: tagged.length,
      // 取消/返金は負で集計（旅行費などから返金が差し引かれる）。
      total: tagged.reduce((s, e) => s + signedEntryAmount(e), 0),
    };
  });
}
