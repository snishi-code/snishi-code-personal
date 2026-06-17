import type { Tag } from '../domain/types';

/** 選べる仕訳全体タグ。アーカイブ済みは除外（選択中は残す）。 */
export function tagsForEntry(tags: Tag[], selected: string[] = []): Tag[] {
  return tags.filter((t) => !t.archived || selected.includes(t.id));
}

export function tagNames(tags: Tag[], ids: string[] | undefined): string[] {
  if (!ids) return [];
  const byId = new Map(tags.map((t) => [t.id, t.name] as const));
  return ids.map((id) => byId.get(id) ?? '?');
}
