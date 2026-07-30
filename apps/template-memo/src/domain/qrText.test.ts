// QR テキストの改行正規化（crlf / lf）とページ分割のテスト。
// 移植元: hospital-workspace/rounds/ui/qrText.test.ts（600B 分割・CRLF ペア非分割）。

import { describe, expect, it } from 'vitest';
import { utf8ByteLength } from '@snishi/foundation/qr/protocol';
import { QR_MAX_BYTES } from '../data/constants';
import { buildQrPages, normalizeNewlines } from './qrText';

describe('normalizeNewlines', () => {
  it('crlf: LF 単独を CRLF へ統一する', () => {
    expect(normalizeNewlines('A\nB\nC', 'crlf')).toBe('A\r\nB\r\nC');
  });

  it('crlf: 既に CRLF の本文は変えない（冪等）', () => {
    const s = 'A\r\nB\r\nC';
    expect(normalizeNewlines(s, 'crlf')).toBe(s);
    expect(normalizeNewlines(normalizeNewlines('A\nB', 'crlf'), 'crlf')).toBe('A\r\nB');
  });

  it('crlf: CR 単独・U+2028/U+2029 も CRLF に揃える', () => {
    expect(normalizeNewlines('A\rB\u2028C\u2029D', 'crlf')).toBe('A\r\nB\r\nC\r\nD');
  });

  it('lf: CRLF・CR 単独・U+2028/U+2029 を LF へ揃え、LF は保持する', () => {
    expect(normalizeNewlines('A\r\nB\rC\u2028D\u2029E\nF', 'lf')).toBe('A\nB\nC\nD\nE\nF');
  });
});

describe('buildQrPages', () => {
  it('600B 以下は正規化した 1 ページを返す', () => {
    expect(buildQrPages('A\nB', 'crlf')).toEqual(['A\r\nB']);
    expect(buildQrPages('A\r\nB', 'lf')).toEqual(['A\nB']);
  });

  it('crlf: 長文は結合すると正規化後の本文と一致し、各ページが上限以下', () => {
    const raw = Array.from({ length: 120 }, (_, i) => `行${i} 経過は安定しています`).join('\n');
    const pages = buildQrPages(raw, 'crlf');
    expect(pages.length).toBeGreaterThan(1);
    expect(pages.join('')).toBe(normalizeNewlines(raw, 'crlf'));
    for (const p of pages) expect(utf8ByteLength(p)).toBeLessThanOrEqual(QR_MAX_BYTES);
  });

  it('lf: 長文も結合すると正規化後の本文と一致し、各ページが上限以下', () => {
    const raw = Array.from({ length: 120 }, (_, i) => `行${i} 経過は安定しています`).join('\r\n');
    const pages = buildQrPages(raw, 'lf');
    expect(pages.length).toBeGreaterThan(1);
    expect(pages.join('')).toBe(normalizeNewlines(raw, 'lf'));
    for (const p of pages) expect(utf8ByteLength(p)).toBeLessThanOrEqual(QR_MAX_BYTES);
  });

  it('ページ境界に来る CRLF ペアを割らない（境界直前に \\r が来る作為入力）', () => {
    // 'a'×599 + '\n' は crlf 正規化後 'a'×599 + '\r\n' = 601B。素朴に 600B で切ると
    // 前ページ末 '\r' / 次ページ頭 '\n' に割れる境界をわざと作る。
    const raw = `${'a'.repeat(QR_MAX_BYTES - 1)}\n${'b'.repeat(50)}`;
    const pages = buildQrPages(raw, 'crlf');
    expect(pages.length).toBeGreaterThan(1);
    // '\r' を前ページへ持ち越さず、CRLF ごと次ページへ送る
    expect(pages[0]).toBe('a'.repeat(QR_MAX_BYTES - 1));
    expect(pages[1] ?? '').toMatch(/^\r\n/);
    expect(pages.join('')).toBe(normalizeNewlines(raw, 'crlf'));
    for (let i = 0; i + 1 < pages.length; i++) {
      const splitPair = (pages[i] ?? '').endsWith('\r') && (pages[i + 1] ?? '').startsWith('\n');
      expect(splitPair).toBe(false);
    }
  });

  it('絵文字（サロゲートペア）をページ境界で割らない', () => {
    const raw = '😀'.repeat(200); // 4B × 200 = 800B > 600B
    const pages = buildQrPages(raw, 'lf');
    expect(pages.length).toBeGreaterThan(1);
    expect(pages.join('')).toBe(raw);
    for (const p of pages) {
      expect(utf8ByteLength(p)).toBeLessThanOrEqual(QR_MAX_BYTES);
      // ページ先頭が孤立 low surrogate / 末尾が孤立 high surrogate なら割れている
      const first = p.charCodeAt(0);
      const last = p.charCodeAt(p.length - 1);
      expect(first >= 0xdc00 && first <= 0xdfff).toBe(false);
      expect(last >= 0xd800 && last <= 0xdbff).toBe(false);
    }
  });
});
