// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { fmtTimestamp } from './timestamp';

describe('format/timestamp', () => {
  it('YYYY-MM-DD HH:MM (ローカル時刻) に整形する', () => {
    const ms = new Date(2026, 6, 6, 9, 5).getTime(); // 2026-07-06 09:05 local
    expect(fmtTimestamp(ms)).toBe('2026-07-06 09:05');
  });

  it('0 / 欠落は空文字 (未同期表示用)', () => {
    expect(fmtTimestamp(0)).toBe('');
  });
});
