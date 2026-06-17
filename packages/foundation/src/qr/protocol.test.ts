import { describe, it, expect } from 'vitest';
import {
  MAX_BYTES,
  HEADER_BUDGET,
  utf8ByteLength,
  newBatchId,
  escapeField,
  unescapeField,
  splitEscapedPipe,
  encodePages,
  decodePage,
  assemblePages,
  uniqueName,
  type DecodedPage,
} from './protocol.js';

describe('newBatchId', () => {
  it('now 注入で決定論', () => {
    expect(newBatchId(1234567890)).toBe((1234567890).toString(36));
    expect(newBatchId(0)).toBe('0');
  });
  it('省略時は base36 文字列', () => {
    expect(newBatchId()).toMatch(/^[0-9a-z]+$/);
  });
});

describe('escape helpers', () => {
  const cases = ['a|b', 'a\\b', 'a\nb', '||', '\\\\', '\n\n', 'mix |\\\n end', 'plain', ''];
  it.each(cases)('escape→unescape roundtrip: %j', (s) => {
    expect(unescapeField(escapeField(s))).toBe(s);
  });
  it('splitEscapedPipe はエスケープ済み | を区切りに使わない', () => {
    const fields = ['room|1', 'na\\me', 'line1\nline2', ''];
    const line = fields.map(escapeField).join('|');
    const parts = splitEscapedPipe(line);
    expect(parts.map(unescapeField)).toEqual(fields);
  });
});

describe('encodePages / decodePage', () => {
  it('空 payload は空配列', () => {
    expect(encodePages({ kind: 'HM', payload: '' })).toEqual([]);
    expect(encodePages({ kind: 'HM', payload: '   \n ' })).toEqual([]);
  });

  it('v1 互換歩哨: ページヘッダは RND_<KIND> #<batchId> N/M\\n', () => {
    const pages = encodePages({ kind: 'ST', payload: '{"v":5}', batchId: 'abc123' });
    expect(pages).toEqual(['RND_ST #abc123 1/1\n{"v":5}']);
  });

  it('MAX_BYTES=750 / HEADER_BUDGET=50 (v1 固定値)', () => {
    expect(MAX_BYTES).toBe(750);
    expect(HEADER_BUDGET).toBe(50);
  });

  it('750B 超 payload は複数ページに分割され、各ページ ≤ 750B・ヘッダ ≤ 50B', () => {
    const line = 'x'.repeat(40) + '\n';
    const payload = line.repeat(100); // 4100 bytes
    const pages = encodePages({ kind: 'HM', payload, batchId: 'b1' });
    expect(pages.length).toBeGreaterThan(1);
    for (const [i, page] of pages.entries()) {
      expect(utf8ByteLength(page)).toBeLessThanOrEqual(750);
      const headerEnd = page.indexOf('\n') + 1;
      expect(utf8ByteLength(page.slice(0, headerEnd))).toBeLessThanOrEqual(HEADER_BUDGET);
      expect(page.startsWith(`RND_HM #b1 ${i + 1}/${pages.length}\n`)).toBe(true);
    }
    // "" 連結で元の payload に戻る (境界 \n は content 側に保持)
    const decoded = pages.map((p) => decodePage(p)) as DecodedPage[];
    expect(assemblePages(decoded)).toBe(payload);
  });

  it('改行なしマルチバイト payload もコードポイント境界で分割して復元できる', () => {
    const payload = 'あ漢字🌊'.repeat(300); // 改行なし・3〜4 byte 文字
    const pages = encodePages({ kind: 'SH', payload, batchId: 'mb' });
    expect(pages.length).toBeGreaterThan(1);
    for (const page of pages) {
      expect(utf8ByteLength(page)).toBeLessThanOrEqual(750);
    }
    const decoded = pages.map((p) => decodePage(p)) as DecodedPage[];
    expect(assemblePages(decoded)).toBe(payload);
  });

  it('decodePage はフィールドを解析する', () => {
    const d = decodePage('RND_FMT #k3x 2/9\nbody\nwith\nnewlines');
    expect(d).toEqual({
      kind: 'FMT',
      batchId: 'k3x',
      pageNum: 2,
      totalPages: 9,
      content: 'body\nwith\nnewlines',
    });
  });

  it.each([
    'hello',
    '',
    'RND_hm #x 1/1\nbody', // kind は大文字のみ
    'RND_HM x 1/1\nbody', // # なし
    'RND_HM #x 1\nbody', // N/M でない
    'RND_HM #x 1/1', // 本文区切りの \n なし
    'XND_HM #x 1/1\nbody',
  ])('decodePage 不正形式は null (fail-closed): %j', (text) => {
    expect(decodePage(text)).toBeNull();
  });
});

describe('assemblePages', () => {
  const page = (n: number, total: number, content: string): DecodedPage => ({
    kind: 'ST',
    batchId: 'b',
    pageNum: n,
    totalPages: total,
    content,
  });

  it('順不同・重複を許容して "" 連結する', () => {
    const pages = [page(3, 3, 'C'), page(1, 3, 'A'), page(2, 3, 'B'), page(1, 3, 'A')];
    expect(assemblePages(pages)).toBe('ABC');
  });

  it('欠落は null', () => {
    expect(assemblePages([page(1, 3, 'A'), page(3, 3, 'C')])).toBeNull();
  });

  it('totalPages 不一致 (バッチ混在) は null', () => {
    expect(assemblePages([page(1, 2, 'A'), page(2, 3, 'B')])).toBeNull();
  });

  it('空配列は null', () => {
    expect(assemblePages([])).toBeNull();
  });
});

describe('uniqueName', () => {
  it('衝突なしはそのまま', () => {
    expect(uniqueName('A', ['B', 'C'])).toBe('A');
  });
  it('衝突は "(2)" から採番 (配列 / Set 両対応)', () => {
    expect(uniqueName('A', ['A'])).toBe('A (2)');
    expect(uniqueName('A', new Set(['A', 'A (2)']))).toBe('A (3)');
  });
  it('前後空白は trim される', () => {
    expect(uniqueName('  A ', ['A'])).toBe('A (2)');
  });
});
