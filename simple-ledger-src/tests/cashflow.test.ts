import { describe, expect, it } from 'vitest';
import {
  buildScheduleEntry,
  horizonEnd,
  liquidAssetTotal,
  projectCashflow,
} from '../src/domain/cashflow';
import type { AccountBalance, CashflowSchedule } from '../src/domain/types';

function bal(id: string, balance: number): AccountBalance {
  return {
    account: {
      id,
      name: id,
      type: 'asset',
      role: 'daily-asset',
      archived: false,
      createdAt: 'x',
      updatedAt: 'x',
    },
    balance,
  };
}

function sched(over: Partial<CashflowSchedule>): CashflowSchedule {
  return {
    id: 's',
    title: '予定',
    dueDate: '2026-07-10',
    amount: 50000,
    direction: 'outflow',
    accountId: 'bank',
    source: 'manual',
    status: 'planned',
    createdAt: 'x',
    updatedAt: 'x',
    ...over,
  };
}

describe('buildScheduleEntry', () => {
  it('outflow は 借方 counter / 貸方 account', () => {
    const e = buildScheduleEntry(sched({ counterAccountId: 'card', direction: 'outflow' }));
    expect(e.lines.find((l) => l.side === 'debit')).toMatchObject({ accountId: 'card' });
    expect(e.lines.find((l) => l.side === 'credit')).toMatchObject({ accountId: 'bank' });
  });
  it('inflow は 借方 account / 貸方 counter', () => {
    const e = buildScheduleEntry(sched({ counterAccountId: 'salary', direction: 'inflow' }));
    expect(e.lines.find((l) => l.side === 'debit')).toMatchObject({ accountId: 'bank' });
    expect(e.lines.find((l) => l.side === 'credit')).toMatchObject({ accountId: 'salary' });
  });
  it('相手科目が無いと実績化できない（throw）', () => {
    expect(() => buildScheduleEntry(sched({}))).toThrow();
  });
});

describe('projectCashflow', () => {
  const today = '2026-06-15';

  it('未来の出金予定で自由資金が減る', () => {
    const proj = projectCashflow({
      totalAssets: 200000,
      reserveBalance: 0,
      schedules: [sched({ dueDate: '2026-07-10', amount: 50000, direction: 'outflow' })],
      today,
      months: 3,
    });
    expect(proj.startFree).toBe(200000);
    expect(proj.points.at(-1)?.free).toBe(150000);
    expect(proj.minFree).toBe(150000);
  });

  it('目的別資金は自由資金から除外され、総資金は変わらない', () => {
    const proj = projectCashflow({
      totalAssets: 1_000_000,
      reserveBalance: 700_000,
      schedules: [],
      today,
      months: 6,
    });
    expect(proj.startTotal).toBe(1_000_000);
    expect(proj.startFree).toBe(300_000);
  });

  it('表示期間より先の予定は含めない', () => {
    const proj = projectCashflow({
      totalAssets: 100000,
      reserveBalance: 0,
      schedules: [sched({ dueDate: '2027-01-10', amount: 1000 })],
      today,
      months: 3,
    });
    expect(proj.schedules).toHaveLength(0);
    expect(proj.points).toHaveLength(1);
  });

  it('入金予定で自由資金が増える / minFree は最小', () => {
    const proj = projectCashflow({
      totalAssets: 10000,
      reserveBalance: 0,
      schedules: [
        sched({ id: 'a', dueDate: '2026-06-20', amount: 8000, direction: 'outflow' }),
        sched({ id: 'b', dueDate: '2026-06-25', amount: 30000, direction: 'inflow' }),
      ],
      today,
      months: 3,
    });
    // 10000 → 2000 → 32000。最低自由資金は 2000。
    expect(proj.minFree).toBe(2000);
    expect(proj.points.at(-1)?.free).toBe(32000);
  });
});

describe('horizonEnd', () => {
  it('月数ぶん先の上限', () => {
    expect(horizonEnd('2026-06-15', 3)).toBe('2026-09-31');
    expect(horizonEnd('2026-11-01', 3)).toBe('2027-02-31');
  });
});

describe('liquidAssetTotal', () => {
  it('除外指定した資産（按分中資産など）を総資金から外す', () => {
    const assets = [bal('cash', 100000), bal('bank', 50000), bal('def', 30000)];
    expect(liquidAssetTotal(assets, new Set())).toBe(180000);
    expect(liquidAssetTotal(assets, new Set(['def']))).toBe(150000);
  });
});
