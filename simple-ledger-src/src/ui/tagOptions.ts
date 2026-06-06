import type { Tag } from '../domain/types';

/** 指定 scope（全体=entry / 明細=line）で選べるタグ。アーカイブ済みは除外（選択中は残す）。 */
export function tagsForScope(tags: Tag[], kind: 'entry' | 'line', selected: string[] = []): Tag[] {
  return tags.filter((t) => {
    const ok =
      kind === 'entry'
        ? t.scope === 'entry' || t.scope === 'both'
        : t.scope === 'line' || t.scope === 'both';
    return ok && (!t.archived || selected.includes(t.id));
  });
}

export function tagNames(tags: Tag[], ids: string[] | undefined): string[] {
  if (!ids) return [];
  const byId = new Map(tags.map((t) => [t.id, t.name] as const));
  return ids.map((id) => byId.get(id) ?? '?');
}
