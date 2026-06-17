import { describe, expect, it } from 'vitest';
import './setup';
import {
  availableYears,
  dataMonthsOf,
  dataYearsOf,
  periodAsOf,
  periodBuckets,
  periodLabel,
  periodRange,
  trendBuckets,
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
  it('all は最初〜最後のデータ月を連続で（空白月も埋める・年跨ぎ）', () => {
    const p: ReportPeriod = { mode: 'all' };
    const b = periodBuckets(p, { dataMonths: ['2026-03', '2026-01', '2026-03'] });
    expect(b.map((x) => x.ym)).toEqual(['2026-01', '2026-02', '2026-03']);
    const cross = periodBuckets(p, { dataMonths: ['2025-11', '2026-02'] });
    expect(cross.map((x) => x.ym)).toEqual(['2025-11', '2025-12', '2026-01', '2026-02']);
  });
  it('all でデータが無ければ空配列', () => {
    expect(periodBuckets({ mode: 'all' }, { dataMonths: [] })).toEqual([]);
  });
});

describe('availableYears（年別セレクトの選択肢）', () => {
  it('データが無くても現在年と翌年は含む（降順）', () => {
    expect(availableYears([], 2026)).toEqual([2027, 2026]);
  });
  it('データのある年〜翌年を連続・降順で返す', () => {
    const ys = availableYears(['2024-05-01', '2026-03-10'], 2026);
    expect(ys).toEqual([2027, 2026, 2025, 2024]);
  });
  it('長期の資金目標（数十年先）にも追従する', () => {
    const ys = availableYears(['2026-01-01', '2056-12-31'], 2026);
    expect(ys[0]).toBe(2056);
    expect(ys.at(-1)).toBe(2026);
    expect(ys).toContain(2040);
  });
  it('異常値は現在年±50 にクランプする（選択中の年は必ず含む）', () => {
    const ys = availableYears(['9999-01-01'], 2026, 2026);
    expect(ys[0]).toBe(2076); // 2026 + 50
    expect(ys).toContain(2026);
  });
});

describe('trendBuckets（グラフ用バケット）', () => {
  it('month は推移を出さない（空配列）', () => {
    expect(trendBuckets({ mode: 'month', year: 2026, month: 6 })).toEqual([]);
  });
  it('year は 12 本の月次バー', () => {
    const b = trendBuckets({ mode: 'year', year: 2026 });
    expect(b).toHaveLength(12);
    expect(b[0]).toMatchObject({ key: '2026-01', label: '1月', year: 2026 });
    expect(b[11]?.asOf).toBe('2026-12-31');
  });
  it('all はデータ年を最小〜最大で連続の年次バー（空白年も埋める）', () => {
    const b = trendBuckets({ mode: 'all' }, { dataYears: [2024, 2026] });
    expect(b.map((x) => x.key)).toEqual(['2024', '2025', '2026']);
    expect(b[0]).toMatchObject({ label: '2024年', year: 2024, asOf: '2024-12-31' });
    expect(b[0]?.range).toEqual({ from: '2024-01-01', to: '2024-12-31' });
  });
  it('all でデータが無ければ空配列', () => {
    expect(trendBuckets({ mode: 'all' }, { dataYears: [] })).toEqual([]);
  });
});

describe('dataYearsOf', () => {
  it('日付配列から年を昇順・重複排除で抽出', () => {
    expect(dataYearsOf(['2026-03-10', '2024-01-05', '2026-12-22'])).toEqual([2024, 2026]);
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
