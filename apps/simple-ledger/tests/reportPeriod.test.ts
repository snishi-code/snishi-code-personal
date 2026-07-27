import { describe, expect, it } from 'vitest';
import './setup';
import {
  availableYears,
  dataYearsOf,
  periodLabel,
  periodRange,
  reportBasis,
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

describe('reportBasis（フロー期間と BS 基準日の単一正本）', () => {
  const today = '2026-06-07';

  it.each([
    [
      '過去月',
      { mode: 'month', year: 2026, month: 5 } as ReportPeriod,
      { flowRange: { from: '2026-05-01', to: '2026-05-31' }, asOf: '2026-05-31' },
    ],
    [
      '現在月',
      { mode: 'month', year: 2026, month: 6 } as ReportPeriod,
      { flowRange: { from: '2026-06-01', to: today }, asOf: today },
    ],
    [
      '未来月',
      { mode: 'month', year: 2026, month: 7 } as ReportPeriod,
      { flowRange: { from: '2026-07-01', to: '2026-07-31' }, asOf: '2026-07-31' },
    ],
    [
      '過去年',
      { mode: 'year', year: 2025 } as ReportPeriod,
      { flowRange: { from: '2025-01-01', to: '2025-12-31' }, asOf: '2025-12-31' },
    ],
    [
      '現在年',
      { mode: 'year', year: 2026 } as ReportPeriod,
      { flowRange: { from: '2026-01-01', to: today }, asOf: today },
    ],
    [
      '未来年',
      { mode: 'year', year: 2027 } as ReportPeriod,
      { flowRange: { from: '2027-01-01', to: '2027-12-31' }, asOf: '2027-12-31' },
    ],
    ['全期間', { mode: 'all' } as ReportPeriod, { flowRange: { to: today }, asOf: today }],
  ])('%s', (_label, period, expected) => {
    expect(reportBasis(period, today)).toEqual(expected);
  });
});

describe('periodLabel', () => {
  it('各モードの表示ラベル', () => {
    expect(periodLabel({ mode: 'month', year: 2026, month: 6 })).toBe('2026年6月');
    expect(periodLabel({ mode: 'year', year: 2026 })).toBe('2026年');
    expect(periodLabel({ mode: 'all' })).toBe('全期間');
  });
});

describe('availableYears（年別セレクトの選択肢）', () => {
  it('データが無くても現在年と翌年は含む（降順）', () => {
    expect(availableYears([], 2026)).toEqual([2027, 2026]);
  });
  it('選択中の翌年を常に含み、継続ルールの未来へ1年ずつ進める', () => {
    expect(availableYears([], 2026, 2027)).toEqual([2028, 2027, 2026]);
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
  const today = '2026-06-07';

  it('month は推移を出さない（空配列）', () => {
    expect(trendBuckets({ mode: 'month', year: 2026, month: 6 }, today)).toEqual([]);
  });
  it('year は 12 本の月次バー', () => {
    const b = trendBuckets({ mode: 'year', year: 2026 }, today);
    expect(b).toHaveLength(12);
    expect(b[0]).toMatchObject({ key: '2026-01', label: '1月', year: 2026 });
    expect(b[5]).toMatchObject({ range: { from: '2026-06-01', to: today }, asOf: today });
    expect(b[11]?.asOf).toBe('2026-12-31');
  });
  it('all はデータ年を最小〜最大で連続の年次バー（空白年も埋める）', () => {
    const b = trendBuckets({ mode: 'all' }, today, { dataYears: [2024, 2026, 2027] });
    expect(b.map((x) => x.key)).toEqual(['2024', '2025', '2026']);
    expect(b[0]).toMatchObject({ label: '2024年', year: 2024, asOf: '2024-12-31' });
    expect(b[0]?.range).toEqual({ from: '2024-01-01', to: '2024-12-31' });
    expect(b[2]).toMatchObject({ range: { from: '2026-01-01', to: today }, asOf: today });
  });
  it('all でデータが無ければ空配列', () => {
    expect(trendBuckets({ mode: 'all' }, today, { dataYears: [] })).toEqual([]);
  });
});

describe('dataYearsOf', () => {
  it('日付配列から年を昇順・重複排除で抽出', () => {
    expect(dataYearsOf(['2026-03-10', '2024-01-05', '2026-12-22'])).toEqual([2024, 2026]);
  });
});
