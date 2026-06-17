import { describe, expect, it } from 'vitest';
import './setup';
import {
  inferMonthlyCostKind,
  monthlyCostForMonth,
  representativeMonthlyAmount,
  totalMonthlyCostForMonth,
} from '../src/domain/monthlyCost';
import type { MonthlyCostItem } from '../src/domain/types';
import { DEFAULT_MANAGEMENT_SCOPE_ID } from '../src/domain/constants';

function item(over: Partial<MonthlyCostItem>): MonthlyCostItem {
  return {
    id: 'm',
    name: 'x',
    managementScopeId: DEFAULT_MANAGEMENT_SCOPE_ID,
    kind: 'subscription',
    amount: 1500,
    costMonths: 1,
    startMonth: '2026-01',
    expenseAccountId: 'exp',
    status: 'active',
    createdAt: 'x',
    updatedAt: 'x',
    ...over,
  };
}

describe('monthlyCostForMonth', () => {
  it('サブスク（costMonths=1, repeat=1）は毎月 amount', () => {
    const sub = item({ amount: 1500, costMonths: 1, repeatEveryMonths: 1 });
    expect(monthlyCostForMonth(sub, '2026-01')).toBe(1500);
    expect(monthlyCostForMonth(sub, '2026-12')).toBe(1500);
    expect(monthlyCostForMonth(sub, '2025-12')).toBe(0); // 開始前
  });
  it('年払い（12000/12, repeat=12）は毎月 1000（連続）', () => {
    const yr = item({
      kind: 'prepaid-service',
      amount: 12000,
      costMonths: 12,
      repeatEveryMonths: 12,
    });
    expect(monthlyCostForMonth(yr, '2026-01')).toBe(1000);
    expect(monthlyCostForMonth(yr, '2026-12')).toBe(1000);
    expect(monthlyCostForMonth(yr, '2027-01')).toBe(1000); // 次の周期も連続
  });
  it('耐久財（210000/84, 1 回限り）は 84 か月だけ、その後 0', () => {
    const dur = item({
      kind: 'durable-asset',
      amount: 210000,
      costMonths: 84,
      startMonth: '2026-01',
    });
    expect(monthlyCostForMonth(dur, '2026-01')).toBe(2500);
    expect(monthlyCostForMonth(dur, '2032-12')).toBe(2500); // 84 か月目(2032-12)
    expect(monthlyCostForMonth(dur, '2033-01')).toBe(0); // 85 か月目
  });
  it('repeat > costMonths は周期内の隙間が 0', () => {
    // 24 か月ごとに 2 か月だけ計上（例: 何かの一時費用）
    const ev = item({ amount: 200, costMonths: 2, repeatEveryMonths: 24, startMonth: '2026-01' });
    expect(monthlyCostForMonth(ev, '2026-01')).toBe(100);
    expect(monthlyCostForMonth(ev, '2026-02')).toBe(100);
    expect(monthlyCostForMonth(ev, '2026-03')).toBe(0); // 隙間
    expect(monthlyCostForMonth(ev, '2028-01')).toBe(100); // 次周期の先頭
  });
  it('認識は endMonth で止める（status だけでは過去を消さない）', () => {
    // 一時停止/終了は endMonth を立てて未来だけ止める＝過去（<= endMonth）は保持する。
    const paused = item({ status: 'paused', repeatEveryMonths: 1, endMonth: '2026-03' });
    expect(monthlyCostForMonth(paused, '2026-03')).toBe(1500); // endMonth まで（過去保持）
    expect(monthlyCostForMonth(paused, '2026-04')).toBe(0); // endMonth 超過で停止
    const ended = item({ repeatEveryMonths: 1, endMonth: '2026-03' });
    expect(monthlyCostForMonth(ended, '2026-03')).toBe(1500);
    expect(monthlyCostForMonth(ended, '2026-04')).toBe(0);
  });
});

describe('totalMonthlyCostForMonth / representativeMonthlyAmount', () => {
  it('複数項目を合算する', () => {
    const items = [
      item({ id: 'a', amount: 1500, costMonths: 1, repeatEveryMonths: 1 }),
      item({ id: 'b', amount: 12000, costMonths: 12, repeatEveryMonths: 12 }),
    ];
    expect(totalMonthlyCostForMonth(items, '2026-06')).toBe(2500);
  });
  it('representativeMonthlyAmount は端数調整の先頭月額', () => {
    expect(representativeMonthlyAmount(item({ amount: 1000, costMonths: 3 }))).toBe(334);
  });
});

describe('inferMonthlyCostKind', () => {
  it('入力から種類を推定する', () => {
    expect(inferMonthlyCostKind(1, 1)).toBe('subscription');
    expect(inferMonthlyCostKind(12, 12)).toBe('prepaid-service');
    expect(inferMonthlyCostKind(12, undefined)).toBe('prepaid-service');
    expect(inferMonthlyCostKind(84, 84)).toBe('durable-asset');
    expect(inferMonthlyCostKind(6, undefined)).toBe('recurring-event');
    expect(inferMonthlyCostKind(1, undefined)).toBe('recurring-event'); // 1回限りの単月
  });
});
