/*
 * 実績動的償却の判定と再配分（2026-07 作者決定）:
 *  - 見込み（costMonths）を超えても自動終了しない。isOverEstimate が真になり、
 *    月額は経過月数で過去に遡って再配分される（真の月額へ収束）。
 *  - 終了（ended＝売却/解約/故障）は実使用月数で再配分。売却額は配分総額から控除。
 *  - 一時停止（paused）は遡及しない（見込みレートのまま凍結）。
 */
import { describe, expect, it } from 'vitest';
import {
  cycleSpreadMonths,
  isOverEstimate,
  monthlyCostForMonth,
} from '../src/domain/monthlyCost';
import type { MonthlyCostItem } from '../src/domain/types';

function item(over: Partial<MonthlyCostItem>): MonthlyCostItem {
  return {
    id: 'x',
    name: 'x',
    managementScopeId: 's',
    kind: 'durable-asset',
    amount: 300000,
    costMonths: 60,
    startMonth: '2026-01',
    expenseAccountId: 'e',
    status: 'active',
    createdAt: 't',
    updatedAt: 't',
    ...over,
  };
}

function ymAt(i: number): string {
  return `${2026 + Math.floor(i / 12)}-${String((i % 12) + 1).padStart(2, '0')}`;
}

describe('isOverEstimate（見込み超過）', () => {
  it('償却のみ（repeat なし）は costMonths 経過で超過になる（終了はしない）', () => {
    const m = item({});
    expect(isOverEstimate(m, '2030-12')).toBe(false); // 60 か月目（見込み内）
    expect(isOverEstimate(m, '2031-01')).toBe(true); // 61 か月目 → 超過・再計算中
  });

  it('自動更新あり・終了済み・停止中は超過にならない', () => {
    expect(isOverEstimate(item({ costMonths: 1, repeatEveryMonths: 1 }), '2030-01')).toBe(false);
    expect(isOverEstimate(item({ status: 'ended', endMonth: '2027-06' }), '2031-01')).toBe(false);
    expect(isOverEstimate(item({ status: 'paused', endMonth: '2027-06' }), '2031-01')).toBe(false);
  });
});

describe('実績動的償却の再配分', () => {
  it('見込み超過で経過月数へ延伸し、月額が過去ごと下がる（30万円: 60→84 か月）', () => {
    const m = item({});
    // 見込み内（60 か月目まで）は 300000/60 = 5000。
    expect(monthlyCostForMonth(m, '2026-01', '2030-12')).toBe(5000);
    // 84 か月目時点（2032-12）: 300000/84 ≒ 3571..3572 に過去ごと再配分。
    expect(cycleSpreadMonths(m, '2026-01', '2032-12')).toBe(84);
    const first = monthlyCostForMonth(m, '2026-01', '2032-12');
    expect(first === 3571 || first === 3572).toBe(true);
    // 全期間の合計は必ず総額に一致する。
    let sum = 0;
    for (let i = 0; i < 84; i++) sum += monthlyCostForMonth(m, ymAt(i), '2032-12');
    expect(sum).toBe(300000);
  });

  it('終了（ended）は実使用月数で再配分（3 年で故障 → 過去に遡って増額）', () => {
    const broken = item({ status: 'ended', endMonth: '2028-12' }); // 36 か月使用
    expect(cycleSpreadMonths(broken, '2026-01', '2028-12')).toBe(36);
    const first = monthlyCostForMonth(broken, '2026-01', '2032-01');
    expect(first === 8333 || first === 8334).toBe(true);
    expect(monthlyCostForMonth(broken, '2029-01', '2032-01')).toBe(0); // 終了後は 0
  });

  it('売却額は配分総額から控除される（84 か月使い 50,000 で売却 → 総コスト 250,000）', () => {
    const sold = item({
      status: 'ended',
      endMonth: '2032-12',
      disposalProceedsAmount: 50000,
    });
    let sum = 0;
    for (let i = 0; i < 84; i++) sum += monthlyCostForMonth(sold, ymAt(i), '2033-06');
    expect(sum).toBe(250000);
  });

  it('一時停止（paused）は遡及しない（見込みレートのまま endMonth で止まる）', () => {
    const paused = item({ status: 'paused', endMonth: '2026-06' });
    expect(monthlyCostForMonth(paused, '2026-01', '2031-01')).toBe(5000); // 凍結（再配分しない）
    expect(monthlyCostForMonth(paused, '2026-07', '2031-01')).toBe(0); // 停止後は 0
  });

  it('自動更新ありの最終サイクルは解約時に切り詰め（年払い 12000 を 7 か月使用で解約）', () => {
    const sub = item({
      amount: 12000,
      costMonths: 12,
      repeatEveryMonths: 12,
      status: 'ended',
      endMonth: '2026-07',
    });
    expect(cycleSpreadMonths(sub, '2026-01', '2026-07')).toBe(7);
    const first = monthlyCostForMonth(sub, '2026-01', '2027-01');
    expect(first === 1714 || first === 1715).toBe(true);
    expect(monthlyCostForMonth(sub, '2026-08', '2027-01')).toBe(0);
  });
});
