import { describe, expect, it } from 'vitest';
import './setup';
import {
  cashDeltaOfEntry,
  cashflowDayDeltas,
  firstShortfallPoint,
  freeAssetTotal,
  isFreeAsset,
  projectCashflow,
  uniqueEntriesById,
} from '../src/domain/cashflow';
import { CONTINUOUS_COST_HARD_CAP } from '../src/domain/continuousCost';
import type { Account, AccountBalance, JournalEntry } from '../src/domain/types';
import type { AccountRole } from '../src/domain/accountRoles';
import { LedgerError } from '../src/domain/errors';

function acc(
  id: string,
  role: AccountRole,
  type: Account['type'],
  over: Partial<Account> = {},
): Account {
  return { id, name: id, type, role, archived: false, createdAt: 'x', updatedAt: 'x', ...over };
}

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

/** 未来日付の支出（借方 費用 / 貸方 現金）。 */
function expenseEntry(id: string, date: string, amount: number, cashId = 'bank'): JournalEntry {
  return entry({
    id,
    date,
    lines: [
      { accountId: 'food', side: 'debit', amount },
      { accountId: cashId, side: 'credit', amount },
    ],
  });
}

/** 未来日付の収入（借方 現金 / 貸方 収入）。 */
function incomeEntry(id: string, date: string, amount: number, cashId = 'bank'): JournalEntry {
  return entry({
    id,
    date,
    lines: [
      { accountId: cashId, side: 'debit', amount },
      { accountId: 'salary', side: 'credit', amount },
    ],
  });
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

  it('同一仕訳内の自由資金デルタが安全整数域を出れば fail-closed', () => {
    const overflow = entry({
      lines: [
        { accountId: 'cash', side: 'debit', amount: Number.MAX_SAFE_INTEGER },
        { accountId: 'cash', side: 'debit', amount: 1 },
      ],
    });
    expect(() => cashDeltaOfEntry(overflow, isFree)).toThrow(LedgerError);
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

describe('projectCashflow（基準日起点・終端は明示引数）', () => {
  // 基準日 = ヘッダーの日付。today ではない（過去日でも同じ規則で先を投影する）。
  const anchorDate = '2026-06-15';
  const end = '2026-12-31';
  // 自由に動かせるお金 = bank / cash。suica は movable=false 相当（原資に入れない）。
  const freeIds = new Set(['bank', 'cash']);
  const isFree = (id: string) => freeIds.has(id);

  it('points[0] は必ず基準日（起点は today ではない）', () => {
    const proj = projectCashflow({
      startFree: 200000,
      entries: [expenseEntry('out', '2026-07-10', 50000)],
      anchorDate,
      end,
      isFree,
    });
    expect(proj.startFree).toBe(200000);
    expect(proj.points[0]).toEqual({ date: anchorDate, free: 200000 });
    expect(proj.points.at(-1)?.free).toBe(150000);
  });

  it('振替仕訳（自由 → 自由）は自由に動かせるお金を変えない（点は残る）', () => {
    const proj = projectCashflow({
      startFree: 100000,
      entries: [
        entry({
          id: 'move',
          date: '2026-06-20',
          lines: [
            { accountId: 'cash', side: 'debit', amount: 30000 },
            { accountId: 'bank', side: 'credit', amount: 30000 },
          ],
        }),
      ],
      anchorDate,
      end,
      isFree,
    });
    expect(proj.points).toHaveLength(2);
    expect(proj.points.at(-1)?.free).toBe(100000);
  });

  it('振替仕訳（自由 → movable=false）は自由に動かせるお金が減る', () => {
    const proj = projectCashflow({
      startFree: 100000,
      entries: [
        entry({
          id: 'charge',
          date: '2026-06-20',
          lines: [
            { accountId: 'suica', side: 'debit', amount: 10000 },
            { accountId: 'bank', side: 'credit', amount: 10000 },
          ],
        }),
      ],
      anchorDate,
      end,
      isFree,
    });
    expect(proj.points.at(-1)?.free).toBe(90000);
  });

  it('movable=false の口座だけにふれる仕訳は投影に乗らない', () => {
    const proj = projectCashflow({
      startFree: 100000,
      entries: [
        incomeEntry('in', '2026-06-20', 5000, 'suica'),
        expenseEntry('out', '2026-06-25', 3000, 'suica'),
      ],
      anchorDate,
      end,
      isFree,
    });
    expect(proj.points).toHaveLength(1);
    expect(proj.points.at(-1)?.free).toBe(100000);
  });

  it('終端 end までを含み、その先は含めない（境界は含む）', () => {
    const proj = projectCashflow({
      startFree: 100000,
      entries: [expenseEntry('a', '2026-07-31', 10000), expenseEntry('b', '2026-08-01', 20000)],
      anchorDate,
      end: '2026-07-31',
      isFree,
    });
    expect(proj.points).toHaveLength(2);
    expect(proj.points.at(-1)?.free).toBe(90000);
  });

  it('基準日当日までの仕訳は startFree に含み済みとして無視する', () => {
    const proj = projectCashflow({
      startFree: 100000,
      entries: [expenseEntry('past', anchorDate, 1000), expenseEntry('older', '2026-01-05', 5000)],
      anchorDate,
      end,
      isFree,
    });
    expect(proj.points).toHaveLength(1);
    expect(proj.points.at(-1)?.free).toBe(100000);
  });

  it('同一 ID の重複仕訳（複数の投影経路）は 1 回だけ数える', () => {
    const e = expenseEntry('dup', '2026-07-10', 30000);
    const proj = projectCashflow({
      startFree: 100000,
      entries: [e, { ...e }],
      anchorDate,
      end,
      isFree,
    });
    expect(proj.points).toHaveLength(2);
    expect(proj.points.at(-1)?.free).toBe(70000);
  });

  it('同じ日の仕訳は 1 点にまとめる（日中の並び順で谷を作らない）', () => {
    const proj = projectCashflow({
      startFree: 10000,
      entries: [
        expenseEntry('out', '2026-07-10', 8000),
        incomeEntry('in', '2026-07-10', 30000),
        expenseEntry('later', '2026-08-10', 2000),
      ],
      anchorDate,
      end,
      isFree,
    });
    // 7/10 は 1 点（+22,000 の合算）・8/10 で 1 点。基準日を入れて 3 点。
    expect(proj.points).toHaveLength(3);
    expect(proj.points[1]).toEqual({ date: '2026-07-10', free: 32000 });
    expect(proj.points.at(-1)?.free).toBe(30000);
  });
});

describe('cashflowDayDeltas（日ごとの純増減）', () => {
  const isFree = (id: string) => id === 'bank';
  it('基準日より後・until までを日付昇順で合算する', () => {
    const deltas = cashflowDayDeltas({
      entries: [
        expenseEntry('b', '2026-07-10', 3000),
        expenseEntry('a', '2026-06-20', 1000),
        incomeEntry('c', '2026-07-10', 5000),
        expenseEntry('tooLate', '2027-01-01', 9000),
        expenseEntry('tooEarly', '2026-06-15', 9000),
      ],
      after: '2026-06-15',
      until: '2026-12-31',
      isFree,
    });
    expect(deltas).toEqual([
      { date: '2026-06-20', amount: -1000 },
      { date: '2026-07-10', amount: 2000 },
    ]);
  });
});

describe('firstShortfallPoint（基準日以降で最初に 0 を下回る日）', () => {
  const anchorDate = '2026-06-15';
  const isFree = (id: string) => id === 'bank';
  const horizon = CONTINUOUS_COST_HARD_CAP;

  const shortfallOf = (startFree: number, entries: JournalEntry[], end = horizon) =>
    firstShortfallPoint(projectCashflow({ startFree, entries, anchorDate, end, isFree }));

  it('基準日当日に負なら基準日そのものを返す', () => {
    expect(shortfallOf(-500, [])).toEqual({ date: anchorDate, free: -500 });
  });

  it('ちょうど 0 は下回りではない（払えている）', () => {
    expect(shortfallOf(0, [])).toBeNull();
    // 途中でちょうど 0 になるだけの列も下回りではない。
    expect(shortfallOf(10000, [expenseEntry('exact', '2026-07-01', 10000)])).toBeNull();
    // 1 円でも足りなければ下回り。
    expect(shortfallOf(10000, [expenseEntry('over', '2026-07-01', 10001)])).toEqual({
      date: '2026-07-01',
      free: -1,
    });
  });

  it('基準日より前の下回りはスルーする（過去の谷は startFree に織り込み済み）', () => {
    // 2026-03 に大きな出金があっても、基準日時点の残高が正なら下回りとして出さない。
    expect(shortfallOf(50000, [expenseEntry('past', '2026-03-01', 900000)])).toBeNull();
  });

  it('下回りが無ければ null', () => {
    expect(
      shortfallOf(100000, [
        expenseEntry('a', '2026-07-01', 20000),
        incomeEntry('b', '2026-08-01', 30000),
      ]),
    ).toBeNull();
  });

  it('最初に下回った日を返す（その後に持ち直しても最初の日）', () => {
    expect(
      shortfallOf(10000, [
        expenseEntry('a', '2026-07-01', 12000),
        incomeEntry('b', '2026-08-01', 50000),
        expenseEntry('c', '2026-09-01', 60000),
      ]),
    ).toEqual({ date: '2026-07-01', free: -2000 });
  });

  it('遠い未来（2050 年）の下回りも地平まで探して見つける', () => {
    expect(shortfallOf(100000, [expenseEntry('far', '2050-04-30', 100001)])).toEqual({
      date: '2050-04-30',
      free: -1,
    });
    // 地平の最終日でも見つかる（探索範囲の端）。
    expect(shortfallOf(1000, [expenseEntry('edge', CONTINUOUS_COST_HARD_CAP, 2000)])).toEqual({
      date: CONTINUOUS_COST_HARD_CAP,
      free: -1000,
    });
  });

  it('同じ日に出て入るだけなら下回らない（日次で合算して判定する）', () => {
    expect(
      shortfallOf(1000, [
        expenseEntry('out', '2026-07-01', 5000),
        incomeEntry('in', '2026-07-01', 5000),
      ]),
    ).toBeNull();
  });

  it('探索範囲（projection の終端）より先の下回りは見つけない', () => {
    expect(shortfallOf(1000, [expenseEntry('far', '2027-01-10', 5000)], '2026-12-31')).toBeNull();
  });
});
