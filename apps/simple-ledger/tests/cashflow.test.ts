import { describe, expect, it } from 'vitest';
import './setup';
import {
  buildRepaymentSchedules,
  buildScheduleEntry,
  cashDeltaOfEntry,
  horizonEnd,
  inferScheduleFlow,
  liquidAssetTotal,
  projectCashflow,
} from '../src/domain/cashflow';
import { DEFAULT_MANAGEMENT_SCOPE_ID } from '../src/domain/constants';

describe('buildRepaymentSchedules（分割返済の予定生成）', () => {
  it('200万円 / 60回 で 60 件、合計一致、各 daily→liability の outflow', () => {
    const list = buildRepaymentSchedules({
      title: '自動車ローン',
      total: 2_000_000,
      count: 60,
      firstDueDate: '2031-07-10',
      fromAccountId: 'cash',
      liabilityAccountId: 'loan',
      managementScopeId: DEFAULT_MANAGEMENT_SCOPE_ID,
    });
    expect(list).toHaveLength(60);
    expect(list.reduce((s, x) => s + x.amount, 0)).toBe(2_000_000);
    expect(list.every((x) => x.direction === 'outflow')).toBe(true);
    expect(list.every((x) => x.accountId === 'cash' && x.counterAccountId === 'loan')).toBe(true);
    expect(list.every((x) => x.source === 'installment' && x.status === 'planned')).toBe(true);
    expect(list[0]?.dueDate).toBe('2031-07-10');
    expect(list[1]?.dueDate).toBe('2031-08-10');
    expect(list[11]?.dueDate).toBe('2032-06-10');
  });
});
import type { Account, AccountBalance, CashflowSchedule, JournalEntry } from '../src/domain/types';
import type { AccountRole } from '../src/domain/accountRoles';

function acc(id: string, role: AccountRole, type: Account['type']): Account {
  return { id, name: id, type, role, archived: false, createdAt: 'x', updatedAt: 'x' };
}

describe('inferScheduleFlow（A → B から入金/出金を推定）', () => {
  it('収入カテゴリ → 日常資産 = inflow（現金が動くのは資産）', () => {
    const r = inferScheduleFlow(
      acc('salary', 'income-category', 'revenue'),
      acc('bank', 'daily-asset', 'asset'),
    );
    expect(r).toEqual({ accountId: 'bank', counterAccountId: 'salary', direction: 'inflow' });
  });
  it('日常資産 → 費用カテゴリ = outflow', () => {
    const r = inferScheduleFlow(
      acc('cash', 'daily-asset', 'asset'),
      acc('food', 'expense-category', 'expense'),
    );
    expect(r).toEqual({ accountId: 'cash', counterAccountId: 'food', direction: 'outflow' });
  });
  it('日常資産 → 支払用負債 = outflow（返済）', () => {
    const r = inferScheduleFlow(
      acc('cash', 'daily-asset', 'asset'),
      acc('card', 'payment-liability', 'liability'),
    );
    expect(r).toEqual({ accountId: 'cash', counterAccountId: 'card', direction: 'outflow' });
  });
  it('日常資産 → 日常資産 = transfer（口座間移動。accountId=移動元）', () => {
    const r = inferScheduleFlow(
      acc('bank', 'daily-asset', 'asset'),
      acc('cash', 'daily-asset', 'asset'),
    );
    expect(r).toEqual({ accountId: 'bank', counterAccountId: 'cash', direction: 'transfer' });
  });
  it('推定不能な組み合わせは null（負債→費用）', () => {
    expect(
      inferScheduleFlow(
        acc('card', 'payment-liability', 'liability'),
        acc('food', 'expense-category', 'expense'),
      ),
    ).toBeNull();
  });
});

describe('buildScheduleEntry transfer / projectCashflow transfer', () => {
  it('transfer は 借方 移動先(counter) / 貸方 移動元(account)', () => {
    const e = buildScheduleEntry(
      sched({ accountId: 'bank', counterAccountId: 'cash', direction: 'transfer' }),
    );
    expect(e.lines.find((l) => l.side === 'debit')).toMatchObject({ accountId: 'cash' });
    expect(e.lines.find((l) => l.side === 'credit')).toMatchObject({ accountId: 'bank' });
  });
  it('transfer は自由資金の総額を変えない', () => {
    const proj = projectCashflow({
      totalAssets: 100000,
      reserveBalance: 0,
      schedules: [
        sched({
          dueDate: '2026-06-20',
          amount: 30000,
          direction: 'transfer',
          counterAccountId: 'cash',
        }),
      ],
      today: '2026-06-15',
      months: 3,
    });
    expect(proj.points.at(-1)?.free).toBe(100000);
    expect(proj.minFree).toBe(100000);
  });
});

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
    managementScopeId: DEFAULT_MANAGEMENT_SCOPE_ID,
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

function entry(over: Partial<JournalEntry> & { lines: JournalEntry['lines'] }): JournalEntry {
  return {
    id: 'e',
    date: '2026-07-01',
    description: 'x',
    kind: 'normal',
    managementScopeId: DEFAULT_MANAGEMENT_SCOPE_ID,
    metadata: { inputMode: 'manual' },
    createdAt: 'x',
    updatedAt: 'x',
    ...over,
  };
}

describe('cashDeltaOfEntry（未来仕訳の現金デルタ）', () => {
  const liquid = new Set(['cash']);
  const isLiquid = (id: string) => liquid.has(id);
  it('支出（借方 費用 / 貸方 現金）は −amount', () => {
    const e = entry({
      lines: [
        { accountId: 'food', side: 'debit', amount: 1000 },
        { accountId: 'cash', side: 'credit', amount: 1000 },
      ],
    });
    expect(cashDeltaOfEntry(e, isLiquid)).toBe(-1000);
  });
  it('収入（借方 現金 / 貸方 収入）は +amount', () => {
    const e = entry({
      lines: [
        { accountId: 'cash', side: 'debit', amount: 5000 },
        { accountId: 'salary', side: 'credit', amount: 5000 },
      ],
    });
    expect(cashDeltaOfEntry(e, isLiquid)).toBe(5000);
  });
  it('振替（現金A→現金B）は 0、現金が動かない仕訳も 0', () => {
    const transfer = entry({
      lines: [
        { accountId: 'cash', side: 'debit', amount: 3000 },
        { accountId: 'cash', side: 'credit', amount: 3000 },
      ],
    });
    expect(cashDeltaOfEntry(transfer, isLiquid)).toBe(0);
    const noncash = entry({
      lines: [
        { accountId: 'food', side: 'debit', amount: 2000 },
        { accountId: 'deferred', side: 'credit', amount: 2000 },
      ],
    });
    expect(cashDeltaOfEntry(noncash, isLiquid)).toBe(0);
  });
});

describe('projectCashflow + 未来仕訳(futureEvents)', () => {
  it('未来日付の支出仕訳が自由資金を減らす（予定 CF と統合・二重計上なし）', () => {
    const proj = projectCashflow({
      totalAssets: 100000,
      reserveBalance: 0,
      schedules: [],
      today: '2026-06-15',
      months: 3,
      futureEvents: [{ date: '2026-07-10', amount: -30000 }],
    });
    expect(proj.points.at(-1)?.free).toBe(70000);
    expect(proj.minFree).toBe(70000);
  });
  it('today 以前 / 期間外の未来仕訳は無視する', () => {
    const proj = projectCashflow({
      totalAssets: 100000,
      reserveBalance: 0,
      schedules: [],
      today: '2026-06-15',
      months: 3,
      futureEvents: [
        { date: '2026-06-15', amount: -1000 }, // today は startTotal に含み済み
        { date: '2027-01-10', amount: -1000 }, // 期間外
      ],
    });
    expect(proj.points).toHaveLength(1);
    expect(proj.points.at(-1)?.free).toBe(100000);
  });
});

describe('horizonEnd', () => {
  it('月数ぶん先の上限', () => {
    expect(horizonEnd('2026-06-15', 3)).toBe('2026-09-31');
    expect(horizonEnd('2026-11-01', 3)).toBe('2027-02-31');
  });
});

describe('projectCashflow（表示終了日 untilDate）', () => {
  const today = '2026-06-15';
  it('untilDate までの予定だけを取り込む（境界含む）', () => {
    const proj = projectCashflow({
      totalAssets: 100000,
      reserveBalance: 0,
      schedules: [
        sched({ id: 'a', dueDate: '2026-07-31', amount: 10000, direction: 'outflow' }),
        sched({ id: 'b', dueDate: '2026-08-01', amount: 20000, direction: 'outflow' }),
      ],
      today,
      untilDate: '2026-07-31',
    });
    // 7-31 は含み、8-01 は範囲外。
    expect(proj.schedules.map((s) => s.id)).toEqual(['a']);
    expect(proj.points.at(-1)?.free).toBe(90000);
  });
  it('untilDate は months より優先される', () => {
    const proj = projectCashflow({
      totalAssets: 100000,
      reserveBalance: 0,
      schedules: [sched({ dueDate: '2027-01-10', amount: 5000, direction: 'outflow' })],
      today,
      months: 3, // この月数だと 2027-01 は範囲外だが、untilDate で含める。
      untilDate: '2027-03-31',
    });
    expect(proj.schedules).toHaveLength(1);
    expect(proj.points.at(-1)?.free).toBe(95000);
  });
  it('未指定なら既定 6 か月で投影する', () => {
    const proj = projectCashflow({
      totalAssets: 100000,
      reserveBalance: 0,
      schedules: [sched({ dueDate: '2026-09-10', amount: 1000, direction: 'outflow' })],
      today,
    });
    // 既定 6 か月（2026-12-31 まで）に含まれる。
    expect(proj.schedules).toHaveLength(1);
  });
});

describe('projectCashflow（取り置き移動が自由資金に反映される）', () => {
  const today = '2026-06-15';
  it('未来日の 普通預金→目的別資金（reserveAmount>0）は総資金を保ち自由資金を減らす', () => {
    const proj = projectCashflow({
      totalAssets: 100000,
      reserveBalance: 0,
      schedules: [],
      today,
      untilDate: '2026-12-31',
      futureEvents: [{ date: '2026-07-01', amount: 0, reserveAmount: 30000 }],
    });
    expect(proj.startFree).toBe(100000);
    expect(proj.points.at(-1)?.total).toBe(100000); // 総資金は不変
    expect(proj.points.at(-1)?.free).toBe(70000); // 取り置き増で自由資金が減る
    expect(proj.minFree).toBe(70000);
  });
  it('目的別資金→普通預金（reserveAmount<0）は自由資金を増やす', () => {
    const proj = projectCashflow({
      totalAssets: 100000,
      reserveBalance: 40000,
      schedules: [],
      today,
      untilDate: '2026-12-31',
      futureEvents: [{ date: '2026-07-01', amount: 0, reserveAmount: -40000 }],
    });
    expect(proj.startFree).toBe(60000);
    expect(proj.points.at(-1)?.free).toBe(100000);
  });
  it('reserveAmount 未指定は従来どおり自由資金一定（後方互換）', () => {
    const proj = projectCashflow({
      totalAssets: 100000,
      reserveBalance: 0,
      schedules: [],
      today,
      untilDate: '2026-12-31',
      futureEvents: [{ date: '2026-07-01', amount: 0 }],
    });
    expect(proj.points.at(-1)?.free).toBe(100000);
  });
});

describe('liquidAssetTotal', () => {
  it('除外指定した資産（按分中資産など）を総資金から外す', () => {
    const assets = [bal('cash', 100000), bal('bank', 50000), bal('def', 30000)];
    expect(liquidAssetTotal(assets, new Set())).toBe(180000);
    expect(liquidAssetTotal(assets, new Set(['def']))).toBe(150000);
  });
});
