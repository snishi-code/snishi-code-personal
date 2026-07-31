import { describe, expect, it } from 'vitest';
import './setup';
import {
  buildScheduleEntry,
  cashDeltaOfEntry,
  freeAssetTotal,
  horizonEnd,
  inferScheduleFlow,
  isFreeAsset,
  projectCashflow,
  uniqueEntriesById,
} from '../src/domain/cashflow';
import type { Account, AccountBalance, CashflowSchedule, JournalEntry } from '../src/domain/types';
import type { AccountRole } from '../src/domain/accountRoles';

function acc(
  id: string,
  role: AccountRole,
  type: Account['type'],
  over: Partial<Account> = {},
): Account {
  return { id, name: id, type, role, archived: false, createdAt: 'x', updatedAt: 'x', ...over };
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

function bal(id: string, balance: number, over: Partial<Account> = {}): AccountBalance {
  return {
    account: {
      id,
      name: id,
      type: 'asset',
      role: 'daily-asset',
      archived: false,
      createdAt: 'x',
      updatedAt: 'x',
      ...over,
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

describe('isFreeAsset / freeAssetTotal（資金繰りの原資 = 自由に動かせるお金）', () => {
  it('有限の終了点は投影対象に残し、終了点不明の旧アーカイブだけを除外する', () => {
    expect(isFreeAsset(acc('cash', 'daily-asset', 'asset'))).toBe(true);
    // movable: false = 「自由に動かせない」チェックを外したもの（Suica・チャージ残高など）。
    expect(isFreeAsset(acc('suica', 'daily-asset', 'asset', { movable: false }))).toBe(false);
    // undefined = 既定 ON（true と同義）。
    expect(isFreeAsset(acc('bank', 'daily-asset', 'asset', { movable: true }))).toBe(true);
    expect(isFreeAsset(acc('old', 'daily-asset', 'asset', { archived: true }))).toBe(false);
    expect(
      isFreeAsset(
        acc('future-end', 'daily-asset', 'asset', {
          archived: true,
          endDate: '2026-12-31',
        }),
      ),
    ).toBe(true);
    expect(isFreeAsset(acc('nisa', 'investment-asset', 'asset'))).toBe(false);
    expect(isFreeAsset(acc('ledger', 'continuing-cost-asset', 'asset'))).toBe(false);
  });

  it('freeAssetTotal は自由に動かせる現預金だけの残高合計', () => {
    const assets = [
      bal('cash', 100000),
      bal('bank', 50000),
      bal('suica', 30000, { movable: false }),
      bal('nisa', 200000, { role: 'investment-asset' }),
      bal('archived', 0, { archived: true }),
      bal('future-end', 25000, { archived: true, endDate: '2026-12-31' }),
    ];
    // 100,000 + 50,000 + 25,000（有限線分は終了前後の予定まで投影する）。
    expect(freeAssetTotal(assets)).toBe(175000);
  });
});

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
  it('transfer は 借方 移動先(counter) / 貸方 移動元(account)', () => {
    const e = buildScheduleEntry(
      sched({ accountId: 'bank', counterAccountId: 'cash', direction: 'transfer' }),
    );
    expect(e.lines.find((l) => l.side === 'debit')).toMatchObject({ accountId: 'cash' });
    expect(e.lines.find((l) => l.side === 'credit')).toMatchObject({ accountId: 'bank' });
  });
  it('相手科目が無いと実績化できない（throw）', () => {
    expect(() => buildScheduleEntry(sched({}))).toThrow();
  });
});

describe('projectCashflow', () => {
  const today = '2026-06-15';
  // 自由に動かせるお金 = bank / cash。suica は movable=false 相当（原資に入れない）。
  const freeIds = new Set(['bank', 'cash']);
  const isFree = (id: string) => freeIds.has(id);

  it('未来の出金予定で自由に動かせるお金が減る', () => {
    const proj = projectCashflow({
      startFree: 200000,
      schedules: [sched({ dueDate: '2026-07-10', amount: 50000, direction: 'outflow' })],
      today,
      isFree,
      months: 3,
    });
    expect(proj.startFree).toBe(200000);
    expect(proj.points.at(-1)?.free).toBe(150000);
    expect(proj.minFree).toBe(150000);
  });

  it('transfer 予定（自由 → 自由）は自由に動かせるお金を変えない', () => {
    const proj = projectCashflow({
      startFree: 100000,
      schedules: [
        sched({
          dueDate: '2026-06-20',
          amount: 30000,
          direction: 'transfer',
          counterAccountId: 'cash',
        }),
      ],
      today,
      isFree,
      months: 3,
    });
    expect(proj.points.at(-1)?.free).toBe(100000);
    expect(proj.minFree).toBe(100000);
  });

  it('transfer 予定（自由 → movable=false）は自由に動かせるお金が減る（監査 P2-4）', () => {
    const proj = projectCashflow({
      startFree: 100000,
      schedules: [
        sched({
          dueDate: '2026-06-20',
          amount: 10000,
          direction: 'transfer',
          counterAccountId: 'suica',
        }),
      ],
      today,
      isFree,
      months: 3,
    });
    expect(proj.points.at(-1)?.free).toBe(90000);
    expect(proj.minFree).toBe(90000);
  });

  it('movable=false の口座への入金予定・そこからの出金予定は自由に動かせるお金を変えない（監査 P2-4）', () => {
    const proj = projectCashflow({
      startFree: 100000,
      schedules: [
        sched({
          id: 'in',
          accountId: 'suica',
          counterAccountId: 'salary',
          dueDate: '2026-06-20',
          amount: 5000,
          direction: 'inflow',
        }),
        sched({
          id: 'out',
          accountId: 'suica',
          counterAccountId: 'food',
          dueDate: '2026-06-25',
          amount: 3000,
          direction: 'outflow',
        }),
      ],
      today,
      isFree,
      months: 3,
    });
    expect(proj.points.at(-1)?.free).toBe(100000);
    expect(proj.minFree).toBe(100000);
  });

  it('表示期間より先の予定は含めない', () => {
    const proj = projectCashflow({
      startFree: 100000,
      schedules: [sched({ dueDate: '2027-01-10', amount: 1000 })],
      today,
      isFree,
      months: 3,
    });
    expect(proj.schedules).toHaveLength(0);
    expect(proj.points).toHaveLength(1);
  });

  it('入金予定で増える / minFree は最小', () => {
    const proj = projectCashflow({
      startFree: 10000,
      schedules: [
        sched({ id: 'a', dueDate: '2026-06-20', amount: 8000, direction: 'outflow' }),
        sched({ id: 'b', dueDate: '2026-06-25', amount: 30000, direction: 'inflow' }),
      ],
      today,
      isFree,
      months: 3,
    });
    // 10000 → 2000 → 32000。最低額は 2000。
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
    metadata: { inputMode: 'manual' },
    createdAt: 'x',
    updatedAt: 'x',
    ...over,
  };
}

describe('cashDeltaOfEntry（未来仕訳の現金デルタ）', () => {
  const free = new Set(['cash']);
  const isFree = (id: string) => free.has(id);
  it('支出（借方 費用 / 貸方 現金）は −amount', () => {
    const e = entry({
      lines: [
        { accountId: 'food', side: 'debit', amount: 1000 },
        { accountId: 'cash', side: 'credit', amount: 1000 },
      ],
    });
    expect(cashDeltaOfEntry(e, isFree)).toBe(-1000);
  });
  it('収入（借方 現金 / 貸方 収入）は +amount', () => {
    const e = entry({
      lines: [
        { accountId: 'cash', side: 'debit', amount: 5000 },
        { accountId: 'salary', side: 'credit', amount: 5000 },
      ],
    });
    expect(cashDeltaOfEntry(e, isFree)).toBe(5000);
  });
  it('振替（自由→自由）は 0、対象外だけの仕訳も 0', () => {
    const transfer = entry({
      lines: [
        { accountId: 'cash', side: 'debit', amount: 3000 },
        { accountId: 'cash', side: 'credit', amount: 3000 },
      ],
    });
    expect(cashDeltaOfEntry(transfer, isFree)).toBe(0);
    const noncash = entry({
      lines: [
        { accountId: 'food', side: 'debit', amount: 2000 },
        { accountId: 'deferred', side: 'credit', amount: 2000 },
      ],
    });
    expect(cashDeltaOfEntry(noncash, isFree)).toBe(0);
  });
  it('自由 → 自由に動かせない現預金（チャージ）は −amount（原資が減る）', () => {
    // Suica は isFree に含めない（movable=false）。銀行 → Suica のチャージ振替。
    const charge = entry({
      lines: [
        { accountId: 'suica', side: 'debit', amount: 5000 },
        { accountId: 'cash', side: 'credit', amount: 5000 },
      ],
    });
    expect(cashDeltaOfEntry(charge, isFree)).toBe(-5000);
  });
});

describe('uniqueEntriesById', () => {
  it('同じ仮想仕訳が複数経路から渡されても未来行は 1 件だけになる', () => {
    const a = entry({
      id: 'cc-fund-item-2026-08',
      lines: [
        { accountId: 'asset', side: 'debit', amount: 12000 },
        { accountId: 'cash', side: 'credit', amount: 12000 },
      ],
    });
    const b = entry({
      id: 'repayment-1',
      lines: [
        { accountId: 'loan', side: 'debit', amount: 10000 },
        { accountId: 'cash', side: 'credit', amount: 10000 },
      ],
    });
    const unique = uniqueEntriesById([a, { ...a }, b]);
    expect(unique).toHaveLength(2);
    expect(new Set(unique.map((candidate) => candidate.id)).size).toBe(2);
  });
});

describe('projectCashflow + 未来仕訳(futureEvents)', () => {
  it('未来日付の支出仕訳が原資を減らす（予定 CF と統合・二重計上なし）', () => {
    const proj = projectCashflow({
      startFree: 100000,
      schedules: [],
      today: '2026-06-15',
      isFree: (id) => id === 'bank',
      months: 3,
      futureEvents: [{ date: '2026-07-10', amount: -30000 }],
    });
    expect(proj.points.at(-1)?.free).toBe(70000);
    expect(proj.minFree).toBe(70000);
  });
  it('today 以前 / 期間外の未来仕訳は無視する', () => {
    const proj = projectCashflow({
      startFree: 100000,
      schedules: [],
      today: '2026-06-15',
      isFree: (id) => id === 'bank',
      months: 3,
      futureEvents: [
        { date: '2026-06-15', amount: -1000 }, // today は startFree に含み済み
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
  const isFree = (id: string) => id === 'bank';
  it('untilDate までの予定だけを取り込む（境界含む）', () => {
    const proj = projectCashflow({
      startFree: 100000,
      schedules: [
        sched({ id: 'a', dueDate: '2026-07-31', amount: 10000, direction: 'outflow' }),
        sched({ id: 'b', dueDate: '2026-08-01', amount: 20000, direction: 'outflow' }),
      ],
      today,
      isFree,
      untilDate: '2026-07-31',
    });
    // 7-31 は含み、8-01 は範囲外。
    expect(proj.schedules.map((s) => s.id)).toEqual(['a']);
    expect(proj.points.at(-1)?.free).toBe(90000);
  });
  it('untilDate は months より優先される', () => {
    const proj = projectCashflow({
      startFree: 100000,
      schedules: [sched({ dueDate: '2027-01-10', amount: 5000, direction: 'outflow' })],
      today,
      isFree,
      months: 3, // この月数だと 2027-01 は範囲外だが、untilDate で含める。
      untilDate: '2027-03-31',
    });
    expect(proj.schedules).toHaveLength(1);
    expect(proj.points.at(-1)?.free).toBe(95000);
  });
  it('未指定なら既定 6 か月で投影する', () => {
    const proj = projectCashflow({
      startFree: 100000,
      schedules: [sched({ dueDate: '2026-09-10', amount: 1000, direction: 'outflow' })],
      today,
      isFree,
    });
    // 既定 6 か月（2026-12-31 まで）に含まれる。
    expect(proj.schedules).toHaveLength(1);
  });
});
