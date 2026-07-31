import { describe, expect, it } from 'vitest';
import { extractJsonText } from './templateBuilder';

describe('extractJsonText', () => {
  it('JSON 全文をそのまま返す', () => {
    expect(extractJsonText('{"ok":true}')).toBe('{"ok":true}');
  });

  it('json 指定あり・なしのコードフェンスから取り出す', () => {
    expect(extractJsonText('```json\n{"a":1}\n```')).toBe('{"a":1}');
    expect(extractJsonText('```\n{"b":2}\n```')).toBe('{"b":2}');
  });

  it('複数フェンスでは最初に読める JSON を選ぶ', () => {
    expect(extractJsonText('```json\n{broken}\n```\n説明\n```json\n{"valid":3}\n```')).toBe(
      '{"valid":3}',
    );
  });

  it('前後の散文から文字列内の波括弧を壊さず object を切り出す', () => {
    expect(extractJsonText('結果です。\n{"message":"{中括弧}","nested":{"x":1}}\n以上です。')).toBe(
      '{"message":"{中括弧}","nested":{"x":1}}',
    );
  });

  it('途中で切れた object は閉じ波括弧なしのまま返す', () => {
    expect(extractJsonText('返答:\n{"frame":{"name":"途中"')).toBe('{"frame":{"name":"途中"');
  });

  it('空文字列は空のまま返す', () => {
    expect(extractJsonText('  ')).toBe('');
  });
});
