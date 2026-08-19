/*
 * 資金繰りのズーム追従（v13.5 F）。
 *
 * 固定するのは「畳むのは**描く点だけ**」という境界:
 *  - 日 = 日次のまま / 月 = 月末断面 / 年 = 年末断面。
 *  - 窓の終端はバケット末に揃う（最後のバケットが半端に切れない）。
 *  - **下回り日の探索は日次のまま**（バケットの中で 0 を割る谷を、畳んだせいで見落とさない）。
 */
import { describe, expect, it } from 'vitest';
import {
  cashflowBucketEnds,
  cashflowWindowEnd,
  firstShortfallPoint,
  foldCashflowPoints,
  projectCashflow,
} from '../src/domain/cashflow';
import type { JournalEntry } from '../src/domain/types';
import './setup';

const CAP = '2100-12-31';

function entry(id: string, date: string, debit: string, credit: string, amount: number) {
  return {
    id,
    date,
    description: id,
    kind: 'normal',
    lines: [
      { accountId: debit, side: 'debit', amount },
      { accountId: credit, side: 'credit', amount },
    ],
    createdAt: 'x',
    updatedAt: 'x',
  } satisfies JournalEntry;
}

const isFree = (id: string) => id === 'cash';

describe('cashflowWindowEnd', () => {
  it('日ズームはそのまま・月ズームは月末・年ズームは年末へ揃える', () => {
    const anchorDate = '2026-08-18';
    expect(cashflowWindowEnd({ anchorDate, months: 12, zoom: 'day', cap: CAP })).toBe('2027-08-18');
    expect(cashflowWindowEnd({ anchorDate, months: 18, zoom: 'month', cap: CAP })).toBe(
      '2028-02-29',
    );
    expect(cashflowWindowEnd({ anchorDate, months: 120, zoom: 'year', cap: CAP })).toBe(
      '2036-12-31',
    );
  });

  it('地平（cap）を越えない', () => {
    const anchorDate = '2099-01-01';
    expect(cashflowWindowEnd({ anchorDate, months: 1200, zoom: 'month', cap: CAP })).toBe(CAP);
  });
});

describe('cashflowBucketEnds', () => {
  it('基準日より後・終端までのバケット末だけを昇順で返す', () => {
    expect(cashflowBucketEnds('2026-01-31', '2026-04-30', 'month')).toEqual([
      '2026-02-28',
      '2026-03-31',
      '2026-04-30',
    ]);
    // 基準日と同じ日（= 1 月末）は「基準日より後」ではないので入らない。
    expect(cashflowBucketEnds('2026-01-15', '2026-02-28', 'month')).toEqual([
      '2026-01-31',
      '2026-02-28',
    ]);
    expect(cashflowBucketEnds('2026-06-01', '2028-12-31', 'year')).toEqual([
      '2026-12-31',
      '2027-12-31',
      '2028-12-31',
    ]);
  });

  it('日ズームは畳まない（バケット末を作らない）', () => {
    expect(cashflowBucketEnds('2026-01-01', '2026-12-31', 'day')).toEqual([]);
  });
});

describe('foldCashflowPoints', () => {
  const entries = [
    entry('e1', '2026-01-10', 'cash', 'revenue', 30_000),
    entry('e2', '2026-01-20', 'expense', 'cash', 50_000),
    entry('e3', '2026-02-10', 'cash', 'revenue', 40_000),
    entry('e4', '2026-03-05', 'expense', 'cash', 10_000),
  ];
  const projection = projectCashflow({
    startFree: 100_000,
    entries,
    anchorDate: '2026-01-01',
    end: CAP,
    isFree,
  });

  it('日ズームは窓に入る日次の点をそのまま返す', () => {
    const folded = foldCashflowPoints({
      projection,
      anchorDate: '2026-01-01',
      endDate: '2026-02-28',
      zoom: 'day',
    });
    expect(folded.map((point) => point.date)).toEqual([
      '2026-01-01',
      '2026-01-10',
      '2026-01-20',
      '2026-02-10',
    ]);
  });

  it('月ズームは基準日 + 月末断面（その月を終えた時点の残高）だけになる', () => {
    const folded = foldCashflowPoints({
      projection,
      anchorDate: '2026-01-01',
      endDate: '2026-03-31',
      zoom: 'month',
    });
    expect(folded).toEqual([
      { date: '2026-01-01', free: 100_000 },
      // 1 月: +30,000 −50,000
      { date: '2026-01-31', free: 80_000 },
      { date: '2026-02-28', free: 120_000 },
      { date: '2026-03-31', free: 110_000 },
    ]);
  });

  it('年ズームは年末断面だけになる', () => {
    expect(
      foldCashflowPoints({
        projection,
        anchorDate: '2026-01-01',
        endDate: '2027-12-31',
        zoom: 'year',
      }),
    ).toEqual([
      { date: '2026-01-01', free: 100_000 },
      { date: '2026-12-31', free: 110_000 },
      { date: '2027-12-31', free: 110_000 },
    ]);
  });

  it('動きの無いバケットは直前の残高を持ち越す（点を落とさない）', () => {
    const quiet = projectCashflow({
      startFree: 1_000,
      entries: [entry('e1', '2026-01-10', 'cash', 'revenue', 500)],
      anchorDate: '2026-01-01',
      end: CAP,
      isFree,
    });
    expect(
      foldCashflowPoints({
        projection: quiet,
        anchorDate: '2026-01-01',
        endDate: '2026-03-31',
        zoom: 'month',
      }).map((point) => point.free),
    ).toEqual([1_000, 1_500, 1_500, 1_500]);
  });

  it('月の途中で 0 を割る谷は畳んだ線から消えるが、下回り日は日次のまま見つかる', () => {
    const dip = projectCashflow({
      startFree: 10_000,
      entries: [
        entry('e1', '2026-01-10', 'expense', 'cash', 30_000), // ここで −20,000
        entry('e2', '2026-01-25', 'cash', 'revenue', 50_000), // 月末には +30,000 へ戻る
      ],
      anchorDate: '2026-01-01',
      end: CAP,
      isFree,
    });
    const folded = foldCashflowPoints({
      projection: dip,
      anchorDate: '2026-01-01',
      endDate: '2026-01-31',
      zoom: 'month',
    });
    // 月末残高は正なので、線だけでは谷が見えない。
    expect(folded.every((point) => point.free >= 0)).toBe(true);
    // 探索は日次の projection を見るので、下回り日は落ちない。
    expect(firstShortfallPoint(dip)?.date).toBe('2026-01-10');
  });

  it('終端より後の点は入らない', () => {
    const folded = foldCashflowPoints({
      projection,
      anchorDate: '2026-01-01',
      endDate: '2026-01-31',
      zoom: 'month',
    });
    expect(folded.at(-1)?.date).toBe('2026-01-31');
  });
});
