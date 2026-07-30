// 定型文 (textSnippets) の今回メモへの挿入 (純関数) のテスト。

import { describe, expect, it } from 'vitest';
import { appendSnippetToMemo } from './snippets';

describe('appendSnippetToMemo', () => {
  it('メモが空なら本文だけになる', () => {
    expect(appendSnippetToMemo('', '採血: WBC __ / CRP __')).toBe('採血: WBC __ / CRP __');
  });

  it('メモが空白のみでも本文だけになる (空メモ扱い)', () => {
    expect(appendSnippetToMemo('  \n ', '胸部Xp: 明らかな異常なし')).toBe(
      '胸部Xp: 明らかな異常なし',
    );
  });

  it('非空メモには改行 1 つで区切って追記する', () => {
    expect(appendSnippetToMemo('腰痛は軽減。', '採血: WBC __')).toBe('腰痛は軽減。\n採血: WBC __');
  });

  it('メモ末尾の余分な改行はまとめて 1 つに畳む (空行を増やさない)', () => {
    expect(appendSnippetToMemo('腰痛は軽減。\n\n\n', '採血: WBC __')).toBe(
      '腰痛は軽減。\n採血: WBC __',
    );
  });

  it('本文が空ならメモをそのまま返す (末尾改行も触らない)', () => {
    expect(appendSnippetToMemo('腰痛は軽減。\n', '')).toBe('腰痛は軽減。\n');
    expect(appendSnippetToMemo('', '')).toBe('');
  });

  it('改行入りの本文もそのまま追記される (検査所見の複数行定型)', () => {
    expect(appendSnippetToMemo('経過安定。', '採血:\nWBC __\nCRP __')).toBe(
      '経過安定。\n採血:\nWBC __\nCRP __',
    );
  });
});
