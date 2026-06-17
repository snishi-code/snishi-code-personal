import { describe, expect, it } from 'vitest';
import './setup';
import { aggregateEntryTags, entryHasTag } from '../src/domain/tags';
import { DEFAULT_MANAGEMENT_SCOPE_ID } from '../src/domain/constants';
import type { JournalEntry, Tag } from '../src/domain/types';

function tag(id: string): Tag {
  return { id, name: id, scope: 'entry', archived: false, createdAt: 'x', updatedAt: 'x' };
}

const tags: Tag[] = [tag('trip'), tag('work')];

const e1: JournalEntry = {
  id: 'e1',
  date: '2026-06-10',
  description: '北海道',
  kind: 'normal',
  managementScopeId: DEFAULT_MANAGEMENT_SCOPE_ID,
  tagIds: ['trip'],
  lines: [
    { accountId: 'food', side: 'debit', amount: 1000 },
    { accountId: 'cash', side: 'credit', amount: 1000 },
  ],
  createdAt: 'x',
  updatedAt: 'x',
};
const e2: JournalEntry = {
  id: 'e2',
  date: '2026-06-20',
  description: '書籍',
  kind: 'normal',
  managementScopeId: DEFAULT_MANAGEMENT_SCOPE_ID,
  tagIds: ['work'],
  lines: [
    { accountId: 'book', side: 'debit', amount: 3000 },
    { accountId: 'cash', side: 'credit', amount: 3000 },
  ],
  createdAt: 'x',
  updatedAt: 'x',
};

describe('entryHasTag', () => {
  it('仕訳全体タグで判定する', () => {
    expect(entryHasTag(e1, 'trip')).toBe(true);
    expect(entryHasTag(e2, 'work')).toBe(true);
    expect(entryHasTag(e1, 'work')).toBe(false);
  });
});

describe('aggregateEntryTags', () => {
  it('仕訳全体タグのタグ付き仕訳合計', () => {
    const r = aggregateEntryTags([e1, e2], tags);
    const trip = r.find((x) => x.tag.id === 'trip')!;
    expect(trip.count).toBe(1);
    expect(trip.total).toBe(1000);
  });
  it('期間外は除外', () => {
    const r = aggregateEntryTags([e1, e2], tags, { from: '2026-07-01', to: '2026-07-31' });
    expect(r.find((x) => x.tag.id === 'trip')?.count).toBe(0);
  });
});

describe('reversal はタグ集計で負に扱う', () => {
  it('取消仕訳が全体タグ合計から差し引かれる', () => {
    const rev: JournalEntry = {
      id: 'r1',
      date: '2026-06-15',
      description: '取消: 北海道',
      kind: 'normal',
      managementScopeId: DEFAULT_MANAGEMENT_SCOPE_ID,
      tagIds: ['trip'],
      metadata: { inputMode: 'reversal', reversalOfEntryId: 'e1' },
      lines: [
        { accountId: 'cash', side: 'debit', amount: 1000 },
        { accountId: 'food', side: 'credit', amount: 1000 },
      ],
      createdAt: 'x',
      updatedAt: 'x',
    };
    const r = aggregateEntryTags([e1, rev], tags);
    expect(r.find((x) => x.tag.id === 'trip')?.total).toBe(0);
  });
});
