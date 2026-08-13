/*
 * タグ色の意味（= ラウンド開始で外れるか）の純関数テスト。
 *
 * 規則は否定形（青以外は外れる）。あとから色を足したときに自動で「外れる側」へ入ることを
 * 縛っておく（残る色を増やすには KEEP_TAG_COLOR を明示的に直す必要がある）。
 */

import { describe, expect, it } from 'vitest';
import {
  DEFAULT_TAG_COLOR,
  isTagColor,
  KEEP_TAG_COLOR,
  roundStartClearTagNames,
  tagClearsOnRoundStart,
} from './tags';
import { TAG_COLORS, type TagColor, type TagDef } from './types';

describe('タグ色の意味', () => {
  it('青は残り、それ以外の色（amber）は外れる', () => {
    expect(tagClearsOnRoundStart('blue')).toBe(false);
    expect(tagClearsOnRoundStart('amber')).toBe(true);
  });

  it('「残る」色は青ちょうど 1 色（他の登録色はすべて外れる側）', () => {
    expect(KEEP_TAG_COLOR).toBe('blue');
    const keep = TAG_COLORS.filter((c) => !tagClearsOnRoundStart(c));
    expect(keep).toEqual(['blue']);
  });

  it('未知の新色は自動で「外れる側」に入る（規則が否定形であること）', () => {
    // TAG_COLORS に将来足される色の代理。型上は TagColor へキャストして規則だけを見る。
    const futureColor = 'teal' as TagColor;
    expect(tagClearsOnRoundStart(futureColor)).toBe(true);
  });

  it('新規タグの既定色は「残る」側（付け忘れで黙って消えない）', () => {
    expect(tagClearsOnRoundStart(DEFAULT_TAG_COLOR)).toBe(false);
  });

  it('isTagColor は登録色だけを通す', () => {
    for (const c of TAG_COLORS) expect(isTagColor(c)).toBe(true);
    expect(isTagColor('gray')).toBe(false); // 旧色
    expect(isTagColor(undefined)).toBe(false);
    expect(isTagColor(1)).toBe(false);
  });
});

describe('roundStartClearTagNames（外すタグ名の集合）', () => {
  const tags: TagDef[] = [
    { name: '継続', color: 'blue' },
    { name: '今回', color: 'amber' },
    { name: '要注意', color: 'blue' },
  ];

  it('青以外の色のタグ名だけを集める', () => {
    const set = roundStartClearTagNames(tags);
    expect([...set]).toEqual(['今回']);
  });

  it('未定義 / 非配列は空集合（何も外さない）', () => {
    expect(roundStartClearTagNames(undefined).size).toBe(0);
    expect(roundStartClearTagNames([]).size).toBe(0);
    expect(roundStartClearTagNames(null as unknown as TagDef[]).size).toBe(0);
  });

  it('色が未知値の定義は外す側に入れない（fail-safe）', () => {
    const broken = [{ name: '壊れ', color: 'gray' }] as unknown as TagDef[];
    expect(roundStartClearTagNames(broken).size).toBe(0);
  });
});
