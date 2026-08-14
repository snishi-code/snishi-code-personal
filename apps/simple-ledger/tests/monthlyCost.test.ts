/*
 * 継続コスト資産の同日刻み（day-cut）計算の不変条件を固定する。
 *  - k 番目の刻み日 = addMonthsToDate(startDate, k)（月末クランプ・起点は常に元の startDate）。
 *  - n = 刻み日 <= 終了日 を満たす最大の k。購入日当日の費用は常に 0（費用は翌同日から）。
 *  - n = 0（同日通過なしで終了）は終了日に全額 1 本。
 *  - 終了日が未設定なら 1 円も割り振らない（残存価値 = 全額）。
 *  - 終了日を入れる/動かすと全期間が新しい刻み数で再計算される（遡及アルゴリズムは存在しない）。
 *  - 全期間の合計は必ず割り振る総額に一致（monthlyAmounts の端数規則）。
 *  - アーカイブ（終了日を過ぎた）・終了間近（1ヶ月以内）は導出のみ。
 */
import { describe, expect, it } from 'vitest';
import './setup';
import {
  allocationSchedule,
  compareMonthlyCostItems,
  dayCutCount,
  isArchived,
  isEndingSoon,
  monthlyCostForMonth,
  remainingValue,
  representativeMonthlyAmount,
} from '../src/domain/monthlyCost';
import { addMonths, monthOf } from '../src/domain/allocation';
import type { MonthlyCostItem } from '../src/domain/types';

/** 基準: 12,000 を 2026-01-15 購入・2027-01-15 終了 → 刻み 2/15〜翌1/15 の 12 本・12000/12=1000。 */
function item(over: Partial<MonthlyCostItem>): MonthlyCostItem {
  return {
    id: 'm',
    name: 'x',
    amount: 12000,
    startDate: '2026-01-15',
    endDate: '2027-01-15',
    expenseAccountId: 'exp',
    createdAt: 'x',
    updatedAt: 'x',
    ...over,
  };
}

/** endDate を消した item（exactOptionalPropertyTypes 対応で delete を使う）。 */
function withoutEnd(base: MonthlyCostItem): MonthlyCostItem {
  const next = { ...base };
  delete next.endDate;
  return next;
}

describe('dayCutCount（同日通過カウント）', () => {
  it('刻み日 <= 終了日 を満たす最大の k', () => {
    // 1/15 起点の刻みは 2/15, 3/15, …, 翌1/15 の 12 本。
    expect(dayCutCount('2026-01-15', '2027-01-15')).toBe(12);
    // 4/10 起点・10/20 終了 → 5/10, 6/10, 7/10, 8/10, 9/10, 10/10 の 6 本（11/10 は終了後）。
    expect(dayCutCount('2026-04-10', '2026-10-20')).toBe(6);
  });
  it('同日ちょうどは通過する（前日で 1 本減る）', () => {
    expect(dayCutCount('2026-08-15', '2026-09-15')).toBe(1);
    expect(dayCutCount('2026-08-15', '2026-09-14')).toBe(0);
  });
  it('同日通過が 1 度もなければ 0（終了日 < 開始日 + 1ヶ月）', () => {
    expect(dayCutCount('2026-08-15', '2026-08-20')).toBe(0);
  });
  it('月末は月末へクランプして数える（1/31 → 2/28）', () => {
    expect(dayCutCount('2026-01-31', '2026-02-28')).toBe(1);
    expect(dayCutCount('2026-01-31', '2026-02-27')).toBe(0);
    // 2/28, 3/31, 4/30, 5/31 の 4 本（クランプは日を食い潰さない）。
    expect(dayCutCount('2026-01-31', '2026-05-31')).toBe(4);
  });
});

describe('allocationSchedule（費用化の予定表）', () => {
  it('年払い 12,000: 刻み 2/15〜翌1/15 の 12 本・毎回 1,000・合計 = 総額', () => {
    const cuts = allocationSchedule(item({}));
    expect(cuts).toHaveLength(12);
    expect(cuts[0]).toEqual({ date: '2026-02-15', amount: 1000 });
    expect(cuts[1]?.date).toBe('2026-03-15');
    expect(cuts[11]).toEqual({ date: '2027-01-15', amount: 1000 });
    expect(cuts.reduce((s, c) => s + c.amount, 0)).toBe(12000);
  });
  it('刻み日は常に元の startDate 起点（1/31 → 2/28, 3/31, 4/30, 5/31 と日が戻る）', () => {
    // 12,000 を 4 本 = 3,000 ずつ。
    const cuts = allocationSchedule(item({ startDate: '2026-01-31', endDate: '2026-05-31' }));
    expect(cuts.map((c) => c.date)).toEqual([
      '2026-02-28',
      '2026-03-31',
      '2026-04-30',
      '2026-05-31',
    ]);
    expect(cuts.every((c) => c.amount === 3000)).toBe(true);
  });
  it('端数は先頭刻みから 1 ずつ（10,000 を 3 本 → 3334/3333/3333）', () => {
    const cuts = allocationSchedule(
      item({ amount: 10000, startDate: '2026-01-01', endDate: '2026-04-01' }),
    );
    expect(cuts).toEqual([
      { date: '2026-02-01', amount: 3334 },
      { date: '2026-03-01', amount: 3333 },
      { date: '2026-04-01', amount: 3333 },
    ]);
  });
  it('n = 0（同日通過なしで終了）は終了日に全額 1 本', () => {
    // 8/15 購入・8/20 終了 → 9/15 は終了後なので刻み 0 本 → 8/20 に 12,000。
    const short = item({ startDate: '2026-08-15', endDate: '2026-08-20' });
    expect(allocationSchedule(short)).toEqual([{ date: '2026-08-20', amount: 12000 }]);
    expect(monthlyCostForMonth(short, '2026-08')).toBe(12000);
    expect(representativeMonthlyAmount(short)).toBe(12000);
    expect(remainingValue(short, '2026-08-19')).toBe(12000);
    expect(remainingValue(short, '2026-08-20')).toBe(0);
  });
  it('購入日当日の費用は常に 0（費用は翌同日から立つ）', () => {
    for (const start of ['2026-01-15', '2026-01-31', '2026-02-01']) {
      const target = item({ startDate: start, endDate: '2027-06-30' });
      expect(allocationSchedule(target)[0]!.date > start).toBe(true);
      expect(monthlyCostForMonth(target, monthOf(start))).toBe(0);
      expect(remainingValue(target, start)).toBe(12000);
    }
  });
  it('刻みは月内に高々 1 本（導出仕訳 ID {prefix}-{itemId}-{YYYY-MM} が衝突しない）', () => {
    for (const target of [item({}), item({ startDate: '2026-01-31', endDate: '2026-05-31' })]) {
      const cuts = allocationSchedule(target);
      expect(new Set(cuts.map((c) => monthOf(c.date))).size).toBe(cuts.length);
      // 日付は単調増加。
      expect([...cuts].sort((a, b) => (a.date < b.date ? -1 : 1))).toEqual(cuts);
    }
  });
  it('終了日なしは 1 本も生まれない（配分しない）', () => {
    expect(allocationSchedule(withoutEnd(item({})))).toEqual([]);
  });
});

describe('終了日が未設定のとき（§3-2）', () => {
  const open = withoutEnd(item({}));
  it('どの月にも 1 円も割り振られない', () => {
    expect(monthlyCostForMonth(open, '2026-01')).toBe(0);
    expect(monthlyCostForMonth(open, '2030-01')).toBe(0);
  });
  it('月あたり（代表値）も 0', () => {
    expect(representativeMonthlyAmount(open)).toBe(0);
  });
  it('残存価値は全額（どの asOf でも）', () => {
    expect(remainingValue(open, '2026-01-01')).toBe(12000);
    expect(remainingValue(open, '2100-12-31')).toBe(12000);
  });
  it('終了日を後から入れると過去に遡って費用が現れる', () => {
    // 刻み 2/15〜翌1/15 の 12 本・1,000 ずつ（購入月 2026-01 には立たない）。
    const closed = { ...open, endDate: '2027-01-15' };
    expect(monthlyCostForMonth(closed, '2026-01')).toBe(0);
    expect(monthlyCostForMonth(closed, '2026-02')).toBe(1000);
    expect(monthlyCostForMonth(closed, '2027-01')).toBe(1000);
  });
});

describe('monthlyCostForMonth', () => {
  it('年払い 12,000 を 12 刻みで割り振ると毎回 1,000・期間外は 0', () => {
    const yr = item({});
    expect(monthlyCostForMonth(yr, '2025-12')).toBe(0);
    expect(monthlyCostForMonth(yr, '2026-01')).toBe(0); // 購入月（刻みは 2/15 から）
    expect(monthlyCostForMonth(yr, '2026-02')).toBe(1000);
    expect(monthlyCostForMonth(yr, '2027-01')).toBe(1000);
    expect(monthlyCostForMonth(yr, '2027-02')).toBe(0);
  });
  it('端数は先頭刻みから 1 ずつ・合計は必ず総額に一致', () => {
    // 刻み 2/1, 3/1, 4/1 の 3 本・10000/3 = 3333 余り 1 → 先頭だけ 3334。
    const it3 = item({ amount: 10000, startDate: '2026-01-01', endDate: '2026-04-01' });
    expect(monthlyCostForMonth(it3, '2026-01')).toBe(0);
    expect(monthlyCostForMonth(it3, '2026-02')).toBe(3334);
    expect(monthlyCostForMonth(it3, '2026-03')).toBe(3333);
    expect(monthlyCostForMonth(it3, '2026-04')).toBe(3333);
  });
  it('終了日変更の遡及: 期間を伸ばすと過去の刻み額が下がり、合計は amount のまま（§13-3）', () => {
    // 2024-06-01 購入・2026-06-01 終了 → 刻み 2024-07-01〜2026-06-01 の 24 本・240000/24 = 10,000。
    const base = item({ amount: 240000, startDate: '2024-06-01', endDate: '2026-06-01' });
    expect(monthlyCostForMonth(base, '2024-07')).toBe(10000);
    // 2027-06-01 終了へ → 36 本・240000/36 = 6666 余り 24 → 先頭 24 本だけ 6,667。
    const stretched = { ...base, endDate: '2027-06-01' };
    expect(monthlyCostForMonth(stretched, '2024-07')).toBe(6667);
    expect(monthlyCostForMonth(stretched, '2024-07')).toBeLessThan(10000);
    const total = (target: MonthlyCostItem, months: number) => {
      let sum = 0;
      for (let k = 0; k < months; k++) sum += monthlyCostForMonth(target, addMonths('2024-07', k));
      return sum;
    };
    expect(total(base, 24)).toBe(240000);
    expect(total(stretched, 36)).toBe(240000);
  });
  it('回収があるときは spreadTotal = amount − 回収額 で配る（負もそのまま配る＝費用減）', () => {
    // 刻み 2/1, 3/1, 4/1, 5/1, 6/1 の 5 本（7/1 は終了後）。
    const insured = item({ amount: 60000, startDate: '2026-01-01', endDate: '2026-06-30' });
    // 30,000 返金 → 30,000 を 5 本 = 6,000/回。
    expect(monthlyCostForMonth(insured, '2026-03', 30000)).toBe(6000);
    // 回収が総額を超えたら刻み額は負（過去にわたる費用減・マイナス表示）。
    expect(monthlyCostForMonth(insured, '2026-03', -6000)).toBeLessThan(0);
  });
});

describe('remainingValue', () => {
  it('最初の刻み日（購入の翌同日）まで減らない', () => {
    const yr = item({});
    expect(remainingValue(yr, '2026-01-15')).toBe(12000); // 購入当日
    expect(remainingValue(yr, '2026-02-14')).toBe(12000);
    expect(remainingValue(yr, '2026-02-15')).toBe(11000); // 1 本目
    expect(remainingValue(yr, '2026-03-15')).toBe(10000); // 2 本目
  });
  it('終了日で残存価値 0（§13-4）', () => {
    const yr = item({});
    expect(remainingValue(yr, '2027-01-15')).toBe(0);
    expect(remainingValue(yr, '2030-01-01')).toBe(0);
  });
  it('回収があるとき: 配り切ると残存価値 0（回収の振替は台帳から持ち出し済み・監査 P2-1）', () => {
    // 240,000・2024-06-01 購入・2026-06-15 終了 → 刻み 2024-07-01〜2026-06-01 の 24 本。
    // 回収 30,000 → 費用 210,000・210000/24 = 8,400 ではなく 8,750（同日刻み）。
    // （台帳残高 = 購入 240,000 − 回収 30,000 − 月割り 210,000 = 0 と一致する単一正本）。
    const sold = item({ amount: 240000, startDate: '2024-06-01', endDate: '2026-06-15' });
    expect(remainingValue(sold, '2026-06-15', 210000)).toBe(0);
    // 途中: 2026-05-31 時点は 23 本ぶん 8,750 × 23 = 201,250 → 残り 8,750。
    expect(remainingValue(sold, '2026-05-31', 210000)).toBe(8750);
    expect(representativeMonthlyAmount(sold, 210000)).toBe(8750);
  });
  it('終了日なし + 回収あり: 残存価値 = spreadTotal（月割り 0 のまま回収分だけ減る）', () => {
    const held = withoutEnd(item({ amount: 12000 }));
    expect(remainingValue(held, '2026-06-15', 9000)).toBe(9000);
    expect(remainingValue(held, '2026-06-15')).toBe(12000);
  });
});

describe('isArchived / isEndingSoon（§3-6・猶予なし）', () => {
  const today = '2026-07-15';
  it('終了日を過ぎたらアーカイブ（当日はまだ・翌日から）', () => {
    expect(isArchived(item({ endDate: '2026-07-15' }), today)).toBe(false);
    expect(isArchived(item({ endDate: '2026-07-14' }), today)).toBe(true);
  });
  it('終了日なしは永久にアーカイブされない', () => {
    expect(isArchived(withoutEnd(item({})), today)).toBe(false);
    expect(isEndingSoon(withoutEnd(item({})), today)).toBe(false);
  });
  it('終了まで1ヶ月以内の境界（ちょうど1ヶ月後 = 対象・1ヶ月+1日後 = 対象外）', () => {
    expect(isEndingSoon(item({ endDate: '2026-08-15' }), today)).toBe(true);
    expect(isEndingSoon(item({ endDate: '2026-08-16' }), today)).toBe(false);
    // アーカイブ済みは対象外
    expect(isEndingSoon(item({ endDate: '2026-07-01' }), today)).toBe(false);
  });
});

describe('compareMonthlyCostItems（終了が近い順）', () => {
  it('endDate 昇順・未設定は最後・同着は名前', () => {
    const a = item({ id: 'a', name: 'あ', endDate: '2026-03-31' });
    const b = item({ id: 'b', name: 'い', endDate: '2026-01-31' });
    const c = withoutEnd(item({ id: 'c', name: 'う' }));
    const d = item({ id: 'd', name: 'い', endDate: '2026-03-31' });
    const sorted = [a, b, c, d].sort(compareMonthlyCostItems);
    expect(sorted.map((x) => x.id)).toEqual(['b', 'a', 'd', 'c']);
  });
});
