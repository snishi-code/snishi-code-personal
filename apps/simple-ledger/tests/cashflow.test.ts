import { describe, expect, it } from 'vitest';
import './setup';
import {
  cashDeltaOfEntry,
  freeAssetTotal,
  horizonEnd,
  isFreeAsset,
  projectCashflow,
  uniqueEntriesById,
} from '../src/domain/cashflow';
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

describe('projectCashflow（未来日付の導出込み仕訳が唯一の入力）', () => {
  const today = '2026-06-15';
  // 自由に動かせるお金 = bank / cash。suica は movable=false 相当（原資に入れない）。
  const freeIds = new Set(['bank', 'cash']);
  const isFree = (id: string) => freeIds.has(id);

  it('未来の支出仕訳で自由に動かせるお金が減る', () => {
    const proj = projectCashflow({
      startFree: 200000,
      entries: [expenseEntry('out', '2026-07-10', 50000)],
      today,
      isFree,
      months: 3,
    });
    expect(proj.startFree).toBe(200000);
    expect(proj.points.at(-1)?.free).toBe(150000);
    expect(proj.minFree).toBe(150000);
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
      today,
      isFree,
      months: 3,
    });
    expect(proj.points.at(-1)?.free).toBe(100000);
    expect(proj.minFree).toBe(100000);
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
      today,
      isFree,
      months: 3,
    });
    expect(proj.points.at(-1)?.free).toBe(90000);
    expect(proj.minFree).toBe(90000);
  });

  it('movable=false の口座だけにふれる仕訳は投影に乗らない', () => {
    const proj = projectCashflow({
      startFree: 100000,
      entries: [
        incomeEntry('in', '2026-06-20', 5000, 'suica'),
        expenseEntry('out', '2026-06-25', 3000, 'suica'),
      ],
      today,
      isFree,
      months: 3,
    });
    expect(proj.points).toHaveLength(1);
    expect(proj.points.at(-1)?.free).toBe(100000);
    expect(proj.minFree).toBe(100000);
  });

  it('表示期間より先の仕訳は含めない', () => {
    const proj = projectCashflow({
      startFree: 100000,
      entries: [expenseEntry('far', '2027-01-10', 1000)],
      today,
      isFree,
      months: 3,
    });
    expect(proj.points).toHaveLength(1);
  });

  it('today 以前の仕訳は startFree に含み済みとして無視する', () => {
    const proj = projectCashflow({
      startFree: 100000,
      entries: [expenseEntry('past', '2026-06-15', 1000)],
      today,
      isFree,
      months: 3,
    });
    expect(proj.points).toHaveLength(1);
    expect(proj.points.at(-1)?.free).toBe(100000);
  });

  it('同一 ID の重複仕訳（複数の投影経路）は 1 回だけ数える', () => {
    const e = expenseEntry('dup', '2026-07-10', 30000);
    const proj = projectCashflow({
      startFree: 100000,
      entries: [e, { ...e }],
      today,
      isFree,
      months: 3,
    });
    expect(proj.points).toHaveLength(2);
    expect(proj.points.at(-1)?.free).toBe(70000);
  });

  it('入金仕訳で増える / minFree は最小', () => {
    const proj = projectCashflow({
      startFree: 10000,
      entries: [expenseEntry('a', '2026-06-20', 8000), incomeEntry('b', '2026-06-25', 30000)],
      today,
      isFree,
      months: 3,
    });
    // 10000 → 2000 → 32000。最低額は 2000。
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

describe('projectCashflow（表示終了日 untilDate）', () => {
  const today = '2026-06-15';
  const isFree = (id: string) => id === 'bank';
  it('untilDate までの仕訳だけを取り込む（境界含む）', () => {
    const proj = projectCashflow({
      startFree: 100000,
      entries: [expenseEntry('a', '2026-07-31', 10000), expenseEntry('b', '2026-08-01', 20000)],
      today,
      isFree,
      untilDate: '2026-07-31',
    });
    // 7-31 は含み、8-01 は範囲外。
    expect(proj.points).toHaveLength(2);
    expect(proj.points.at(-1)?.free).toBe(90000);
  });
  it('untilDate は months より優先される', () => {
    const proj = projectCashflow({
      startFree: 100000,
      entries: [expenseEntry('far', '2027-01-10', 5000)],
      today,
      isFree,
      months: 3, // この月数だと 2027-01 は範囲外だが、untilDate で含める。
      untilDate: '2027-03-31',
    });
    expect(proj.points).toHaveLength(2);
    expect(proj.points.at(-1)?.free).toBe(95000);
  });
  it('未指定なら既定 6 か月で投影する', () => {
    const proj = projectCashflow({
      startFree: 100000,
      entries: [expenseEntry('c', '2026-09-10', 1000)],
      today,
      isFree,
    });
    // 既定 6 か月（2026-12-31 まで）に含まれる。
    expect(proj.points).toHaveLength(2);
    expect(proj.points.at(-1)?.free).toBe(99000);
  });
});
