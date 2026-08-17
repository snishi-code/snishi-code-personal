/*
 * ストック 4 系列（グラフレンズの第 1 段・v13.5 F）。
 *
 * 固定するのは 3 つ:
 *  - **バケット末断面の切り出し**（値はバケットの `to` 時点で、`from` でも中間でもない）。
 *  - 符号の規約（負債は debit-signed の負・純資産 = 資産 − 負債）。
 *  - deriveBalanceSheet を列ごとに回した結果と**一致する**こと（単一走査の最適化が
 *    答えを変えていない = 速いだけ、を保証する）。
 */
import { describe, expect, it } from 'vitest';
import {
  buildStockSeries,
  STOCK_SERIES_DEFAULT_VISIBLE,
  STOCK_SERIES_KEYS,
  type StockSeriesBucket,
} from '../src/domain/stockSeries';
import { deriveBalanceSheet } from '../src/domain/accounting';
import { freeAssetTotal } from '../src/domain/cashflow';
import { buildTimelineBuckets } from '../src/domain/timelineCalendar';
import type { Account, JournalEntry } from '../src/domain/types';
import './setup';

function account(
  id: string,
  type: Account['type'],
  role: Account['role'],
  options: { movable?: boolean } = {},
): Account {
  return {
    id,
    name: id,
    type,
    role,
    archived: false,
    ...(options.movable !== undefined ? { movable: options.movable } : {}),
    createdAt: 'x',
    updatedAt: 'x',
  };
}

function entry(
  id: string,
  date: string,
  debitAccountId: string,
  creditAccountId: string,
  amount: number,
): JournalEntry {
  return {
    id,
    date,
    description: id,
    kind: 'normal',
    lines: [
      { accountId: debitAccountId, side: 'debit', amount },
      { accountId: creditAccountId, side: 'credit', amount },
    ],
    createdAt: 'x',
    updatedAt: 'x',
  };
}

const cash = account('cash', 'asset', 'daily-asset');
const suica = account('suica', 'asset', 'daily-asset', { movable: false });
const fund = account('fund', 'asset', 'investment-asset');
const loan = account('loan', 'liability', 'other-liability');
const revenue = account('revenue', 'revenue', 'income-category');
const expense = account('expense', 'expense', 'expense-category');
const accounts = [cash, suica, fund, loan, revenue, expense];

function monthBuckets(months: readonly string[]): StockSeriesBucket[] {
  return buildTimelineBuckets(
    { start: `${months[0]}-01`, end: `${months.at(-1)}-31` },
    'month',
  ).map((bucket) => ({ key: bucket.key, from: bucket.startDate, to: bucket.endDate }));
}

describe('buildStockSeries', () => {
  it('値は各バケット末の断面（月中の動きはその月末に現れ、前月には出ない）', () => {
    const entries = [
      entry('e1', '2026-01-10', cash.id, revenue.id, 10_000),
      // 2 月の途中で増えた分は 2 月末の断面に入り、1 月末には入らない。
      entry('e2', '2026-02-20', cash.id, revenue.id, 5_000),
      // 3 月末**より後**の動きは、3 月末の断面には入らない。
      entry('e3', '2026-04-01', cash.id, revenue.id, 900_000),
    ];
    const series = buildStockSeries(
      accounts,
      entries,
      monthBuckets(['2026-01', '2026-02', '2026-03']),
    );

    expect(series.buckets.map((bucket) => bucket.to)).toEqual([
      '2026-01-31',
      '2026-02-28',
      '2026-03-31',
    ]);
    expect(series.values.assets).toEqual([10_000, 15_000, 15_000]);
  });

  it('バケット末**当日**の仕訳はその断面に含まれる（境界は末日を含む）', () => {
    const onTheEdge = [entry('e1', '2026-01-31', cash.id, revenue.id, 7_000)];
    const series = buildStockSeries(accounts, onTheEdge, monthBuckets(['2026-01', '2026-02']));
    expect(series.values.assets).toEqual([7_000, 7_000]);
  });

  it('最初のバケットより前の仕訳も残高に積む（断面は「その日までの全部」）', () => {
    const entries = [entry('e0', '2020-05-05', cash.id, revenue.id, 3_000)];
    const series = buildStockSeries(accounts, entries, monthBuckets(['2026-01']));
    expect(series.values.assets).toEqual([3_000]);
  });

  it('負債は debit-signed（負）で、純資産 = 資産 − 負債になる', () => {
    const entries = [
      entry('e1', '2026-01-05', cash.id, loan.id, 100_000), // 借入: 資産 +10万 / 負債 +10万
      entry('e2', '2026-01-20', loan.id, cash.id, 30_000), // 返済: 資産 −3万 / 負債 −3万
    ];
    const series = buildStockSeries(accounts, entries, monthBuckets(['2026-01']));
    expect(series.values.assets).toEqual([70_000]);
    // 貸方残高 70,000 は負で描く（0 線をまたいで下へ伸びる）。
    expect(series.values.liabilities).toEqual([-70_000]);
    expect(series.values.netAssets).toEqual([0]);
  });

  it('「自由に動かせるお金」は cashflow の isFreeAsset と同じ集合（投資・movable=false は除く）', () => {
    const entries = [
      entry('e1', '2026-01-05', cash.id, revenue.id, 50_000),
      entry('e2', '2026-01-06', suica.id, cash.id, 5_000), // 自由 → 自由でない への振替
      entry('e3', '2026-01-07', fund.id, cash.id, 20_000), // 自由 → 投資 への振替
    ];
    const series = buildStockSeries(accounts, entries, monthBuckets(['2026-01']));
    expect(series.values.assets).toEqual([50_000]);
    expect(series.values.freeFunds).toEqual([25_000]);
  });

  it('列ごとに deriveBalanceSheet を回した結果と一致する（単一走査は答えを変えない）', () => {
    const entries = [
      entry('e1', '2026-01-05', cash.id, revenue.id, 50_000),
      entry('e2', '2026-02-11', expense.id, cash.id, 12_000),
      entry('e3', '2026-02-12', cash.id, loan.id, 200_000),
      entry('e4', '2026-03-01', fund.id, cash.id, 40_000),
      entry('e5', '2026-03-31', loan.id, cash.id, 15_000),
    ];
    const buckets = monthBuckets(['2026-01', '2026-02', '2026-03', '2026-04']);
    const series = buildStockSeries(accounts, entries, buckets);

    buckets.forEach((bucket, index) => {
      const bs = deriveBalanceSheet(accounts, entries, bucket.to);
      expect(series.values.assets[index]).toBe(bs.totalAssets);
      expect(series.values.liabilities[index]).toBe(-bs.totalLiabilities);
      expect(series.values.netAssets[index]).toBe(bs.totalAssets - bs.totalLiabilities);
      expect(series.values.freeFunds[index]).toBe(freeAssetTotal(bs.assets));
    });
  });

  it('日ズーム・年ズームのバケットでも同じ規則（末日の断面）で切り出す', () => {
    const entries = [entry('e1', '2026-01-02', cash.id, revenue.id, 1_000)];
    const days = buildTimelineBuckets({ start: '2026-01-01', end: '2026-01-03' }, 'day').map(
      (bucket) => ({ key: bucket.key, from: bucket.startDate, to: bucket.endDate }),
    );
    expect(buildStockSeries(accounts, entries, days).values.assets).toEqual([0, 1_000, 1_000]);

    const years = buildTimelineBuckets({ start: '2025-01-01', end: '2026-12-31' }, 'year').map(
      (bucket) => ({ key: bucket.key, from: bucket.startDate, to: bucket.endDate }),
    );
    expect(buildStockSeries(accounts, entries, years).values.assets).toEqual([0, 1_000]);
  });

  it('バケットが空なら 4 系列とも空（呼び出し側が安全に空表示できる）', () => {
    const series = buildStockSeries(accounts, [], []);
    expect(series.buckets).toEqual([]);
    for (const key of STOCK_SERIES_KEYS) expect(series.values[key]).toEqual([]);
  });

  it('入力の仕訳配列を書き換えない（並べ替えは内部のコピーで行う）', () => {
    const entries = [
      entry('e2', '2026-02-01', cash.id, revenue.id, 1),
      entry('e1', '2026-01-01', cash.id, revenue.id, 1),
    ];
    const order = entries.map((e) => e.id);
    buildStockSeries(accounts, entries, monthBuckets(['2026-01', '2026-02']));
    expect(entries.map((e) => e.id)).toEqual(order);
  });

  it('既定 ON は純資産と自由に動かせるお金の 2 本', () => {
    expect([...STOCK_SERIES_DEFAULT_VISIBLE]).toEqual(['netAssets', 'freeFunds']);
    expect([...STOCK_SERIES_KEYS]).toEqual(['assets', 'liabilities', 'netAssets', 'freeFunds']);
  });
});
