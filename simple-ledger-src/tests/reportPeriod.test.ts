import { describe, expect, it } from 'vitest';
import {
  dataMonthsOf,
  periodAsOf,
  periodBuckets,
  periodLabel,
  periodRange,
  type ReportPeriod,
} from '../src/domain/reportPeriod';

describe('periodRange（フロー期間）', () => {
  it('month は当月の月初〜月末', () => {
    expect(periodRange({ mode: 'month', year: 2026, month: 2 })).toEqual({
      from: '2026-02-01',
      to: '2026-02-28',
    });
  });
  it('year は 1/1〜12/31', () => {
    expect(periodRange({ mode: 'year', year: 2026 })).toEqual({
      from: '2026-01-01',
      to: '2026-12-31',
    });
  });
  it('all は期間制約なし（undefined）', () => {
    expect(periodRange({ mode: 'all' })).toBeUndefined();
  });
});

describe('periodAsOf（BS 基準日）', () => {
  const today = '2026-06-07';
  it('month は月末', () => {
    expect(periodAsOf({ mode: 'month', year: 2026, month: 6 }, today)).toBe('2026-06-30');
  });
  it('year は年末', () => {
    expect(periodAsOf({ mode: 'year', year: 2026 }, today)).toBe('2026-12-31');
  });
  it('all は最終データ日。無ければ今日', () => {
    expect(periodAsOf({ mode: 'all' }, today, '2027-03-10')).toBe('2027-03-10');
    expect(periodAsOf({ mode: 'all' }, today)).toBe(today);
  });
});

describe('periodLabel', () => {
  it('各モードの表示ラベル', () => {
    expect(periodLabel({ mode: 'month', year: 2026, month: 6 })).toBe('2026年6月');
    expect(periodLabel({ mode: 'year', year: 2026 })).toBe('2026年');
    expect(periodLabel({ mode: 'all' })).toBe('全期間');
  });
});

describe('periodBuckets（トレンド月次バケット）', () => {
  it('month は単一バケット', () => {
    const b = periodBuckets({ mode: 'month', year: 2026, month: 6 });
    expect(b).toHaveLength(1);
    expect(b[0]).toMatchObject({ ym: '2026-06', range: { from: '2026-06-01', to: '2026-06-30' } });
  });
  it('year は 12 個（1〜12 月）', () => {
    const b = periodBuckets({ mode: 'year', year: 2026 });
    expect(b).toHaveLength(12);
    expect(b[0]?.ym).toBe('2026-01');
    expect(b[11]?.ym).toBe('2026-12');
    expect(b[11]?.asOf).toBe('2026-12-31');
  });
  it('all はデータのある月だけ（昇順・重複排除）', () => {
    const p: ReportPeriod = { mode: 'all' };
    const b = periodBuckets(p, { dataMonths: ['2026-03', '2026-01', '2026-03'] });
    expect(b.map((x) => x.ym)).toEqual(['2026-01', '2026-03']);
  });
  it('all でデータが無ければ空配列', () => {
    expect(periodBuckets({ mode: 'all' }, { dataMonths: [] })).toEqual([]);
  });
});

describe('dataMonthsOf', () => {
  it('日付配列から月を昇順・重複排除で抽出', () => {
    expect(dataMonthsOf(['2026-03-10', '2026-01-05', '2026-03-22'])).toEqual([
      '2026-01',
      '2026-03',
    ]);
  });
});
