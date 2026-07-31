/*
 * 継続コスト資産（4項目モデル）の月割り計算の不変条件を固定する。
 *  - 終了日が未設定なら 1 円も割り振らない（残存価値 = 全額）。
 *  - 終了日を入れる/動かすと全期間が新しい月数で再計算される（遡及アルゴリズムは存在しない）。
 *  - 全期間の合計は必ず割り振る総額に一致（monthlyAmounts の端数規則）。
 *  - アーカイブ（終了日を過ぎた）・終了間近（1ヶ月以内）は導出のみ。
 */
import { describe, expect, it } from 'vitest';
import './setup';
import {
  compareMonthlyCostItems,
  isArchived,
  isEndingSoon,
  monthlyCostForMonth,
  recognitionSpan,
  remainingValue,
  representativeMonthlyAmount,
} from '../src/domain/monthlyCost';
import { addMonths } from '../src/domain/allocation';
import type { MonthlyCostItem } from '../src/domain/types';

function item(over: Partial<MonthlyCostItem>): MonthlyCostItem {
  return {
    id: 'm',
    name: 'x',
    amount: 12000,
    startDate: '2026-01-15',
    endDate: '2026-12-31',
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

describe('recognitionSpan', () => {
  it('開始日〜終了日の月バケット（日は配分に使わない）', () => {
    expect(recognitionSpan(item({}))).toEqual({ from: '2026-01', n: 12 });
    expect(recognitionSpan(item({ startDate: '2026-07-20', endDate: '2026-07-25' }))).toEqual({
      from: '2026-07',
      n: 1,
    });
  });
  it('終了日なしは null（配分しない）', () => {
    expect(recognitionSpan(withoutEnd(item({})))).toBeNull();
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
    const closed = { ...open, endDate: '2026-12-31' };
    expect(monthlyCostForMonth(closed, '2026-01')).toBe(1000);
    expect(monthlyCostForMonth(closed, '2026-12')).toBe(1000);
  });
});

describe('monthlyCostForMonth', () => {
  it('年払い 12000 を 12ヶ月で割り振ると毎月 1000・期間外は 0', () => {
    const yr = item({});
    expect(monthlyCostForMonth(yr, '2025-12')).toBe(0);
    expect(monthlyCostForMonth(yr, '2026-01')).toBe(1000);
    expect(monthlyCostForMonth(yr, '2026-12')).toBe(1000);
    expect(monthlyCostForMonth(yr, '2027-01')).toBe(0);
  });
  it('端数は先頭月から 1 ずつ・合計は必ず総額に一致', () => {
    const it3 = item({ amount: 10000, startDate: '2026-01-01', endDate: '2026-03-31' });
    expect(monthlyCostForMonth(it3, '2026-01')).toBe(3334);
    expect(monthlyCostForMonth(it3, '2026-02')).toBe(3333);
    expect(monthlyCostForMonth(it3, '2026-03')).toBe(3333);
  });
  it('終了日変更の遡及: 期間を伸ばすと過去の月あたりが下がり、合計は amount のまま（§13-3）', () => {
    const base = item({ amount: 240000, startDate: '2024-06-01', endDate: '2026-05-31' }); // 24ヶ月
    expect(monthlyCostForMonth(base, '2024-06')).toBe(10000);
    const stretched = { ...base, endDate: '2027-05-31' }; // 36ヶ月へ
    expect(monthlyCostForMonth(stretched, '2024-06')).toBeLessThan(10000);
    const total = (target: MonthlyCostItem, months: number) => {
      let sum = 0;
      for (let k = 0; k < months; k++) sum += monthlyCostForMonth(target, addMonths('2024-06', k));
      return sum;
    };
    expect(total(base, 24)).toBe(240000);
    expect(total(stretched, 36)).toBe(240000);
  });
  it('回収があるときは spreadTotal = amount − 回収額 で配る（負もそのまま配る＝費用減）', () => {
    const insured = item({ amount: 60000, startDate: '2026-01-01', endDate: '2026-06-30' });
    // 30,000 返金 → 30,000 を 6ヶ月 = 5,000/月（解約前と変わらない）
    expect(monthlyCostForMonth(insured, '2026-03', 30000)).toBe(5000);
    // 回収が総額を超えたら月あたりは負（過去にわたる費用減・マイナス表示）
    expect(monthlyCostForMonth(insured, '2026-03', -6000)).toBeLessThan(0);
  });
});

describe('remainingValue', () => {
  it('初月の認識日は startDate（それより前の asOf では減らない）', () => {
    const yr = item({});
    expect(remainingValue(yr, '2026-01-14')).toBe(12000);
    expect(remainingValue(yr, '2026-01-15')).toBe(11000);
    // 2ヶ月目以降は月初
    expect(remainingValue(yr, '2026-02-01')).toBe(10000);
  });
  it('終了日で残存価値 0（§13-4）', () => {
    const yr = item({});
    expect(remainingValue(yr, '2026-12-31')).toBe(0);
    expect(remainingValue(yr, '2030-01-01')).toBe(0);
  });
  it('回収があるとき: 配り切ると残存価値 0（回収の振替は台帳から持ち出し済み・監査 P2-1）', () => {
    // 240,000・2024-06〜2026-06 = 25ヶ月・回収 30,000 → 費用 210,000・認識完了後の残りは 0
    // （台帳残高 = 購入 240,000 − 回収 30,000 − 認識 210,000 = 0 と一致する単一正本）。
    const sold = item({ amount: 240000, startDate: '2024-06-01', endDate: '2026-06-15' });
    expect(remainingValue(sold, '2026-06-15', 210000)).toBe(0);
    // 認識途中: 認識済み 8,400 × 24 = 201,600 → 残り 210,000 − 201,600 = 8,400。
    expect(remainingValue(sold, '2026-05-31', 210000)).toBe(8400);
    // 月あたりは 210,000 / 25 = 8,400（§6-1 の検算）
    expect(representativeMonthlyAmount(sold, 210000)).toBe(8400);
  });
  it('終了日なし + 回収あり: 残存価値 = spreadTotal（認識 0 のまま回収分だけ減る）', () => {
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
