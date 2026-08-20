import { describe, expect, it } from 'vitest';
import {
  isLedgerDate,
  isValidIsoDate,
  isValidIsoMonth,
  MAX_LEDGER_DATE,
  MIN_LEDGER_DATE,
} from '../src/domain/calendar';

describe('isValidIsoMonth', () => {
  it.each(['2026-01', '2026-12'])('%s を受け入れる', (month) => {
    expect(isValidIsoMonth(month)).toBe(true);
  });

  it.each(['2026-00', '2026-13', '2026-99', '2026-1', '2026/01'])('%s を拒否する', (month) => {
    expect(isValidIsoMonth(month)).toBe(false);
  });
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

describe('isLedgerDate（暦 + 上限 2100-12-31・v13.8 監査 E）', () => {
  it('上限と同じ日付までを受け入れる', () => {
    expect(MAX_LEDGER_DATE).toBe('2100-12-31');
    expect(isLedgerDate('2100-12-31')).toBe(true);
    expect(isLedgerDate('2026-08-19')).toBe(true);
  });

  it.each(['2101-01-01', '9999-12-31', '2026-02-31', '2026/01/01'])('%s を拒否する', (date) => {
    expect(isLedgerDate(date)).toBe(false);
  });
});

describe('isLedgerDate の下限（MIN_LEDGER_DATE = 2000-01-01・v13.9 項目 8）', () => {
  it('下限と同じ日付から受け入れる', () => {
    expect(MIN_LEDGER_DATE).toBe('2000-01-01');
    expect(isLedgerDate('2000-01-01')).toBe(true);
  });

  it.each(['1999-12-31', '1900-01-01', '0001-01-01'])('%s を拒否する', (date) => {
    expect(isLedgerDate(date)).toBe(false);
  });
});
