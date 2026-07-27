import { describe, expect, it } from 'vitest';
import { isValidIsoDate, isValidIsoMonth } from '../src/domain/calendar';

describe('isValidIsoMonth', () => {
  it.each(['2026-01', '2026-12'])('%s を受け入れる', (month) => {
    expect(isValidIsoMonth(month)).toBe(true);
  });

  it.each(['2026-00', '2026-13', '2026-99', '2026-1', '2026/01'])(
    '%s を拒否する',
    (month) => {
      expect(isValidIsoMonth(month)).toBe(false);
    },
  );
});

describe('isValidIsoDate', () => {
  it.each(['2024-02-29', '2026-01-31', '2000-02-29'])('%s を受け入れる', (date) => {
    expect(isValidIsoDate(date)).toBe(true);
  });

  it.each([
    '2026-02-29',
    '2026-02-31',
    '2026-04-31',
    '2026-13-01',
    '2026-00-01',
    '2026-01-00',
    '1900-02-29',
    '2026/01/01',
  ])('%s を拒否する', (date) => {
    expect(isValidIsoDate(date)).toBe(false);
  });
});
