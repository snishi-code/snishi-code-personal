import { describe, expect, it } from 'vitest';
import {
  aggregateEntryTags,
  aggregateLineTags,
  entryHasTag,
  tagAllowsEntry,
  tagAllowsLine,
} from '../src/domain/tags';
import type { JournalEntry, Tag } from '../src/domain/types';

function tag(id: string, scope: Tag['scope']): Tag {
  return { id, name: id, scope, archived: false, createdAt: 'x', updatedAt: 'x' };
}

const tags: Tag[] = [tag('trip', 'entry'), tag('card', 'line'), tag('bank', 'line')];

const e1: JournalEntry = {
  id: 'e1',
  date: '2026-06-10',
  description: '北海道',
  kind: 'normal',
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
  description: 'カード払い',
  kind: 'normal',
  lines: [
    { accountId: 'food', side: 'debit', amount: 3000, tagIds: ['card'] },
    { accountId: 'cash', side: 'credit', amount: 3000, tagIds: ['bank'] },
  ],
  createdAt: 'x',
  updatedAt: 'x',
};

describe('tag scope helpers', () => {
  it('entry/line/both の許可', () => {
    expect(tagAllowsEntry('entry')).toBe(true);
    expect(tagAllowsEntry('line')).toBe(false);
    expect(tagAllowsEntry('both')).toBe(true);
    expect(tagAllowsLine('line')).toBe(true);
    expect(tagAllowsLine('entry')).toBe(false);
    expect(tagAllowsLine('both')).toBe(true);
  });
});

describe('entryHasTag', () => {
  it('全体タグ・明細タグのどちらでも判定する', () => {
    expect(entryHasTag(e1, 'trip')).toBe(true);
    expect(entryHasTag(e2, 'card')).toBe(true);
    expect(entryHasTag(e2, 'bank')).toBe(true);
    expect(entryHasTag(e1, 'card')).toBe(false);
  });
});

describe('aggregateEntryTags', () => {
  it('全体タグのタグ付き仕訳合計', () => {
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

describe('aggregateLineTags', () => {
  it('明細タグの借方/貸方合計を比較できる', () => {
    const r = aggregateLineTags([e1, e2], tags);
    const card = r.find((x) => x.tag.id === 'card')!;
    const bank = r.find((x) => x.tag.id === 'bank')!;
    expect(card.debit).toBe(3000);
    expect(card.credit).toBe(0);
    expect(bank.debit).toBe(0);
    expect(bank.credit).toBe(3000);
  });
});
