/*
 * 時間平面の値（数値レンズの表 / グラフレンズの折れ線が共有する集計）。
 *
 * v13.6 H3 で行の集合が変わった: 6 分類の独自木は廃止し、**共通ラベル列と同じ行 id**
 * （box: / account: / identity:）で値を返す。ここで固定するのは
 *  ① 列の切り出し（窓）と残高の累積が分離していること
 *  ② 箱の値 = その箱の科目の合計（親子の整合）
 *  ③ 恒等行 = 式どおり（収支 = 収入 − 支出 / 純資産 = 資産 − 負債）
 *  ④ 月 / 年 / 任意バケットのどれでも同じ規則で動くこと。
 */
import { describe, expect, it } from 'vitest';
import {
  buildPeriodMatrix,
  periodMatrixAsOf,
  periodMatrixRow,
  type PeriodMatrix,
  type PeriodMatrixScope,
} from '../src/domain/periodMatrix';
import { lensRowId } from '../src/domain/lensRows';
import type { DisplayBoxKey, DisplaySectionKey } from '../src/domain/displayOrder';
import { deriveBalanceSheet, deriveProfitAndLoss } from '../src/domain/accounting';
import { reportEntriesForAsOf } from '../src/domain/reportEntries';
import { SCHEMA_VERSION } from '../src/domain/constants';
import type {
  Account,
  EntryMetadata,
  JournalEntry,
  Ledger,
  MonthlyCostItem,
} from '../src/domain/types';
import './setup';
import { LedgerError } from '../src/domain/errors';
import { MAX_AMOUNT_MINOR } from '../src/domain/schema';

/** 月ズームの列は「窓」なので、従来の年間 12 列は 1〜12 月を渡して作る。 */
function monthsOfYear(year: number): string[] {
  return Array.from({ length: 12 }, (_, index) => `${year}-${String(index + 1).padStart(2, '0')}`);
}

function account(
  id: string,
  type: Account['type'],
  role: Account['role'],
  options: { archived?: boolean; sortIndex?: number } = {},
): Account {
  return {
    id,
    name: id,
    type,
    role,
    archived: options.archived ?? false,
    ...(options.sortIndex !== undefined ? { sortIndex: options.sortIndex } : {}),
    createdAt: 'x',
    updatedAt: 'x',
  };
}

function entry(
  id: string,
  date: string,
  debitAccountId: string,
  creditAccountId: string,
  amount: number,
  metadata?: EntryMetadata,
): JournalEntry {
  return {
    id,
    date,
    description: id,
    kind: 'normal',
    lines: [
      { accountId: debitAccountId, side: 'debit', amount },
      { accountId: creditAccountId, side: 'credit', amount },
    ],
    ...(metadata ? { metadata } : {}),
    createdAt: 'x',
    updatedAt: 'x',
  };
}

/** schema 上限内の仕訳だけで、指定した合計を組み立てる。 */
function entriesForTotal(
  prefix: string,
  date: string,
  debitAccountId: string,
  creditAccountId: string,
  total: number,
): JournalEntry[] {
  const result: JournalEntry[] = [];
  let remaining = total;
  for (let index = 0; remaining > 0; index += 1) {
    const amount = Math.min(remaining, MAX_AMOUNT_MINOR);
    result.push(entry(`${prefix}-${index}`, date, debitAccountId, creditAccountId, amount));
    remaining -= amount;
  }
  return result;
}

const boxRow = (matrix: PeriodMatrix, key: DisplayBoxKey) =>
  periodMatrixRow(matrix, lensRowId.box(key));
const accountRow = (matrix: PeriodMatrix, accountId: string) =>
  periodMatrixRow(matrix, lensRowId.account(accountId));
const identityRow = (matrix: PeriodMatrix, key: DisplaySectionKey) =>
  periodMatrixRow(matrix, lensRowId.identity(key));

/** 総資産は箱ではないので、資産の箱を足して作る（表に総資産の行はもう無い）。 */
const ASSET_BOXES: DisplayBoxKey[] = ['assetFree', 'assetFixed', 'continuingCost'];
function totalAssets(matrix: PeriodMatrix): number[] {
  return matrix.columns.map((_column, index) =>
    ASSET_BOXES.reduce((total, key) => total + (boxRow(matrix, key)[index] ?? 0), 0),
  );
}

const accounts: Account[] = [
  account('cash', 'asset', 'daily-asset'),
  account('continuing', 'asset', 'continuing-cost-asset'),
  account('loan', 'liability', 'other-liability'),
  account('equity', 'equity', 'equity'),
  account('salary', 'revenue', 'income-category'),
  account('fixed', 'expense', 'expense-category', { archived: true, sortIndex: 0 }),
  account('food', 'expense', 'expense-category', { sortIndex: 1 }),
  account('cancelled', 'expense', 'expense-category', { sortIndex: 2 }),
  account('zero', 'expense', 'expense-category', { sortIndex: 3 }),
];

describe('buildPeriodMatrix（月ズーム）', () => {
  it('月末・月初を別列へ帰属させ、当月・未来列も列末まで数値化する', () => {
    const input = [
      entry('future-real', '2026-06-16', 'food', 'cash', 999),
      entry('current-income', '2026-06-15', 'cash', 'salary', 500),
      entry('month-start', '2026-06-01', 'food', 'cash', 200),
      entry('month-end', '2026-05-31', 'food', 'cash', 100),
      entry('opening', '2025-12-31', 'cash', 'equity', 1000),
    ];
    const originalOrder = input.map(({ id }) => id);

    const matrix = buildPeriodMatrix(accounts, input, {
      mode: 'months',
      months: monthsOfYear(2026),
    });

    expect(matrix.columns).toHaveLength(12);
    expect(matrix.columns[4]).toMatchObject({
      key: '2026-05',
      from: '2026-05-01',
      to: '2026-05-31',
      asOf: '2026-05-31',
    });
    expect(matrix.columns[5]).toMatchObject({ key: '2026-06', asOf: '2026-06-30' });
    expect(boxRow(matrix, 'expense').slice(4, 7)).toEqual([100, 1199, 0]);
    expect(boxRow(matrix, 'income').slice(4, 7)).toEqual([0, 500, 0]);
    expect(identityRow(matrix, 'net').slice(4, 7)).toEqual([-100, -699, 0]);
    expect(totalAssets(matrix).slice(4, 7)).toEqual([900, 201, 201]);
    expect(identityRow(matrix, 'netAssets').slice(4, 7)).toEqual([900, 201, 201]);
    expect(input.map(({ id }) => id)).toEqual(originalOrder);
  });

  it('年をまたぐ窓を切り出し、窓の外の仕訳はフロー列に載せずBSにだけ積む', () => {
    // 数値レンズは「可視範囲 + 前後バッファ」だけを列にする。窓の外は列を作らないが、
    // 残高は窓の手前から連続していなければならない（列の切り出しと累積の分離）。
    const matrix = buildPeriodMatrix(
      accounts,
      [
        entry('before-window', '2025-06-30', 'cash', 'equity', 1000),
        entry('in-window-dec', '2025-12-10', 'food', 'cash', 100),
        entry('in-window-jan', '2026-01-10', 'food', 'cash', 200),
        entry('after-window', '2026-03-10', 'food', 'cash', 400),
      ],
      { mode: 'months', months: ['2026-01', '2025-12', '2026-02'] },
    );

    // 順不同で渡しても昇順の連続列になる（年またぎ）。
    expect(matrix.columns.map((column) => column.key)).toEqual(['2025-12', '2026-01', '2026-02']);
    expect(matrix.columns.map((column) => column.year)).toEqual([2025, 2026, 2026]);
    expect(matrix.columns.map((column) => column.month)).toEqual([12, 1, 2]);
    // 窓の外（2025-06 / 2026-03）はフロー列に現れない。
    expect(boxRow(matrix, 'expense')).toEqual([100, 200, 0]);
    // BS は窓の手前の 1000 から連続する（列が無い月の移動も繰り越す）。
    expect(totalAssets(matrix)).toEqual([900, 700, 700]);
  });

  it('壊れた月キーは列にしない（窓の指定ミスで空セルを増やさない）', () => {
    const matrix = buildPeriodMatrix(accounts, [], {
      mode: 'months',
      months: ['2026-13', '2026-00', '20260-1', '2026-1', '', '2026-07'],
    });

    expect(matrix.columns.map((column) => column.key)).toEqual(['2026-07']);
  });

  it('資産・負債の自然符号を累積し、各月末の純資産を総資産−総負債で返す', () => {
    const matrix = buildPeriodMatrix(
      accounts,
      [
        entry('opening', '2025-12-31', 'cash', 'equity', 1000),
        entry('borrow', '2026-01-10', 'cash', 'loan', 400),
        entry('spend', '2026-01-31', 'food', 'cash', 100),
        entry('repay', '2026-02-01', 'loan', 'cash', 150),
      ],
      { mode: 'months', months: monthsOfYear(2026) },
    );

    // 負債は自然符号（借金の大きさがそのまま正）。
    expect(boxRow(matrix, 'longTermDebt').slice(0, 2)).toEqual([400, 250]);
    expect(totalAssets(matrix).slice(0, 2)).toEqual([1300, 1150]);
    expect(identityRow(matrix, 'netAssets').slice(0, 2)).toEqual([900, 900]);
    expect(identityRow(matrix, 'netAssets')[0]).toBe(totalAssets(matrix)[0]! - 400);
    expect(identityRow(matrix, 'netAssets')[1]).toBe(totalAssets(matrix)[1]! - 250);
  });

  it('導出月割りも費用カテゴリの科目行へ合算する（「月割り」の独立行は持たない）', () => {
    const matrix = buildPeriodMatrix(
      accounts,
      [
        entry('opening-cash', '2025-12-31', 'cash', 'equity', 1000),
        entry('opening-continuing', '2025-12-31', 'continuing', 'equity', 500),
        entry('derived', '2026-01-31', 'fixed', 'continuing', 120, {
          virtual: true,
          ccKind: 'monthly-allocation',
        }),
        entry('normal', '2026-01-25', 'food', 'cash', 50),
      ],
      { mode: 'months', months: monthsOfYear(2026) },
    );

    expect(boxRow(matrix, 'expense')[0]).toBe(170);
    expect(accountRow(matrix, 'fixed')[0]).toBe(120);
    expect(accountRow(matrix, 'food')[0]).toBe(50);
    // 月割り台帳は資産の箱の 1 つ（独立行ではない）。残存価値がそのまま残高。
    expect(boxRow(matrix, 'continuingCost')[0]).toBe(380);
  });

  it('動きのない科目も 0 の行を持つ（行の集合は共通木が決め、値の有無では決めない）', () => {
    const matrix = buildPeriodMatrix(
      accounts,
      [entry('spend', '2026-01-10', 'food', 'cash', 100)],
      { mode: 'months', months: monthsOfYear(2026) },
    );

    expect(matrix.values.has(lensRowId.account('zero'))).toBe(true);
    expect(accountRow(matrix, 'zero').every((value) => value === 0)).toBe(true);
  });

  it('未来年も年末断面として箱の行・科目の行を数値で返す', () => {
    const matrix = buildPeriodMatrix(
      accounts,
      [entry('future', '2027-01-01', 'food', 'cash', 100)],
      { mode: 'months', months: monthsOfYear(2027) },
    );

    expect(matrix.columns.every((column) => column.asOf === column.to)).toBe(true);
    expect(boxRow(matrix, 'expense')[0]).toBe(100);
    expect(identityRow(matrix, 'net')[0]).toBe(-100);
    expect(totalAssets(matrix).every((value) => value === -100)).toBe(true);
    expect(accountRow(matrix, 'food')[0]).toBe(100);
  });

  it('未来月列はホームが同じ月末断面で出すPL・BSと一致する', () => {
    const entries = [
      entry('opening', '2026-12-31', 'cash', 'equity', 1_000),
      entry('future-income', '2027-01-10', 'cash', 'salary', 500),
      entry('future-expense', '2027-01-20', 'food', 'cash', 120),
    ];
    const matrix = buildPeriodMatrix(accounts, entries, {
      mode: 'months',
      months: monthsOfYear(2027),
    });
    const pl = deriveProfitAndLoss(accounts, entries, {
      from: '2027-01-01',
      to: '2027-01-31',
    });
    const bs = deriveBalanceSheet(accounts, entries, '2027-01-31');

    expect(boxRow(matrix, 'income')[0]).toBe(pl.totalRevenue);
    expect(boxRow(matrix, 'expense')[0]).toBe(pl.totalExpense);
    expect(identityRow(matrix, 'net')[0]).toBe(pl.netIncome);
    expect(totalAssets(matrix)[0]).toBe(bs.totalAssets);
    expect(identityRow(matrix, 'netAssets')[0]).toBe(bs.netAssets);
  });

  it('収入・費用が個別に安全域内でも、純額の最終差引が安全域を出れば fail-closed', () => {
    const overflowEntries = [
      ...entriesForTotal('max-revenue', '2026-01-01', 'ignored', 'salary', Number.MAX_SAFE_INTEGER),
      // expense の貸方は自然増減 -2。MAX_SAFE - (-2) は表現不能。
      entry('contra-expense', '2026-01-02', 'ignored', 'food', 2),
    ];
    expect(() =>
      buildPeriodMatrix(accounts, overflowEntries, { mode: 'months', months: monthsOfYear(2026) }),
    ).toThrow(LedgerError);
  });
});

describe('buildPeriodMatrix（年ズーム）', () => {
  it('疎な年列でも中間年の移動を次のBSへ繰り越し、全列を年末まで扱う', () => {
    const matrix = buildPeriodMatrix(
      accounts,
      [
        entry('opening', '2023-12-31', 'cash', 'equity', 1000),
        entry('year-end', '2024-12-31', 'cash', 'salary', 100),
        entry('hidden-year', '2025-06-01', 'cash', 'salary', 50),
        entry('year-start', '2026-01-01', 'food', 'cash', 25),
        entry('borrow', '2026-06-15', 'cash', 'loan', 200),
        entry('after-today', '2026-06-16', 'food', 'cash', 999),
        entry('future-year', '2027-01-01', 'cash', 'salary', 999),
      ],
      { mode: 'all', years: [2027, 2024, 2026, 2026] },
    );

    expect(matrix.columns.map(({ key }) => key)).toEqual(['2024', '2026', '2027']);
    expect(matrix.columns.map(({ asOf }) => asOf)).toEqual([
      '2024-12-31',
      '2026-12-31',
      '2027-12-31',
    ]);
    expect(boxRow(matrix, 'income')).toEqual([100, 0, 999]);
    expect(boxRow(matrix, 'expense')).toEqual([0, 1024, 0]);
    expect(identityRow(matrix, 'net')).toEqual([100, -1024, 999]);
    expect(totalAssets(matrix)).toEqual([1100, 326, 1325]);
    expect(identityRow(matrix, 'netAssets')).toEqual([1100, 126, 1125]);
    expect(accountRow(matrix, 'food')).toEqual([0, 1024, 0]);
  });

  it('後年の回収を全知識として使い、年間表示と全体表示の同じ年を一致させる', () => {
    const item: MonthlyCostItem = {
      id: 'cross-year-cost',
      name: '年またぎ費用',
      amount: 60_000,
      startDate: '2025-10-05',
      endDate: '2026-03-31',
      expenseAccountId: 'fixed',
      createdAt: 'x',
      updatedAt: 'x',
    };
    const ledger: Ledger = {
      meta: {
        id: 'ledger',
        schemaVersion: SCHEMA_VERSION,
        revision: 1,
        deviceId: 'device',
        createdAt: 'x',
        updatedAt: 'x',
      },
      settings: { ledgerName: 'test', currency: 'JPY', displayFractionDigits: 0 },
      accounts,
      journalEntries: [
        entry('opening', '2025-01-01', 'cash', 'equity', 500_000),
        entry('purchase', item.startDate, 'continuing', 'cash', item.amount, {
          monthlyCostId: item.id,
        }),
        entry('recovery', '2026-03-31', 'cash', 'continuing', 30_000, {
          monthlyCostId: item.id,
          monthlyCostRecovery: true,
        }),
      ],
      monthlyCostItems: [item],
      recurringRules: [],
    };

    const annualEntries = reportEntriesForAsOf(ledger, '2025-12-31');
    const allEntries = reportEntriesForAsOf(ledger, '2026-12-31');
    const annual = buildPeriodMatrix(accounts, annualEntries, {
      mode: 'months',
      months: monthsOfYear(2025),
    });
    const all = buildPeriodMatrix(accounts, allEntries, {
      mode: 'all',
      years: [2025, 2026],
    });
    const annualTotal = (values: readonly number[]) =>
      values.reduce((sum, value) => sum + value, 0);

    // 同日刻み: 2025-10-05 起点の刻み日は 2025-11-05〜2026-03-05 の 5 本
    //（6 本目 2026-04-05 は終了日 2026-03-31 超）。割り振る総額 = 60,000 − 回収 30,000 =
    // 30,000 → 1 本 6,000。2025 年に入るのは 11/05・12/05 の 2 本 = 12,000。
    expect(annualTotal(accountRow(annual, 'fixed'))).toBe(12_000);
    expect(annualTotal(accountRow(annual, 'fixed'))).toBe(accountRow(all, 'fixed')[0]);
    expect(annualTotal(boxRow(annual, 'expense'))).toBe(boxRow(all, 'expense')[0]);
    expect(totalAssets(annual)[11]).toBe(totalAssets(all)[0]);
    expect(identityRow(annual, 'netAssets')[11]).toBe(identityRow(all, 'netAssets')[0]);
  });
});

/*
 * v13.6 H3: 行は共通ラベル列と同じ id。ここで固定するのは
 *  ① 箱の値 = その箱の科目の合計（親子の整合。丸めで割れない）
 *  ② 恒等行が式どおり（引き算で作った行が、箱の合計から独立に壊れない）
 *  ③ 任意バケット（グラフレンズ）でも同じ規則で動く。
 */
describe('buildPeriodMatrix（共通ラベル列の行）', () => {
  const drillAccounts: Account[] = [
    account('cash', 'asset', 'daily-asset', { sortIndex: 0 }),
    account('wallet', 'asset', 'daily-asset', { sortIndex: 1 }),
    account('card', 'liability', 'payment-liability'),
    account('loan', 'liability', 'other-liability'),
    account('equity', 'equity', 'equity'),
    account('salary', 'revenue', 'income-category'),
    account('food', 'expense', 'expense-category'),
  ];
  const scope: PeriodMatrixScope = { mode: 'months', months: ['2026-01', '2026-02', '2026-03'] };
  const drillEntries = [
    entry('opening-cash', '2026-01-05', 'cash', 'equity', 3_333),
    entry('opening-wallet', '2026-01-06', 'wallet', 'equity', 1_111),
    entry('card', '2026-01-10', 'food', 'card', 777),
    entry('loan', '2026-02-01', 'cash', 'loan', 2_222),
    entry('income', '2026-02-10', 'cash', 'salary', 4_444),
    entry('repay', '2026-03-01', 'card', 'cash', 300),
  ];

  it('箱の値は列ごとに科目の合計と一致する（丸めで割れない）', () => {
    const matrix = buildPeriodMatrix(drillAccounts, drillEntries, scope);
    const columnCount = matrix.columns.length;
    const sumOf = (ids: string[]) =>
      Array.from({ length: columnCount }, (_unused, index) =>
        ids.reduce((total, id) => total + (accountRow(matrix, id)[index] ?? 0), 0),
      );

    expect(boxRow(matrix, 'assetFree')).toEqual(sumOf(['cash', 'wallet']));
    expect(boxRow(matrix, 'shortTermDebt')).toEqual(sumOf(['card']));
    expect(boxRow(matrix, 'longTermDebt')).toEqual(sumOf(['loan']));
    expect(boxRow(matrix, 'income')).toEqual(sumOf(['salary']));
    expect(boxRow(matrix, 'expense')).toEqual(sumOf(['food']));
  });

  it('恒等行は式どおり（収支 = 収入 − 支出 / 純資産 = 資産 − 負債）', () => {
    const matrix = buildPeriodMatrix(drillAccounts, drillEntries, scope);
    const income = boxRow(matrix, 'income');
    const expense = boxRow(matrix, 'expense');
    const liabilities = matrix.columns.map(
      (_column, index) =>
        (boxRow(matrix, 'shortTermDebt')[index] ?? 0) +
        (boxRow(matrix, 'longTermDebt')[index] ?? 0),
    );

    expect(identityRow(matrix, 'net')).toEqual(income.map((value, i) => value - expense[i]!));
    expect(identityRow(matrix, 'netAssets')).toEqual(
      totalAssets(matrix).map((value, i) => value - liabilities[i]!),
    );
  });

  it('任意バケット（グラフレンズの窓）でも同じ行 id・同じ断面を返す', () => {
    const matrix = buildPeriodMatrix(drillAccounts, drillEntries, {
      mode: 'buckets',
      buckets: [
        { key: 'd1', from: '2026-01-05', to: '2026-01-05' },
        { key: 'd2', from: '2026-01-06', to: '2026-01-06' },
        { key: 'd3', from: '2026-01-10', to: '2026-01-10' },
      ],
    });

    expect(matrix.columns.map((column) => column.key)).toEqual(['d1', 'd2', 'd3']);
    // ストックは各バケット末の断面。
    expect(boxRow(matrix, 'assetFree')).toEqual([3_333, 4_444, 4_444]);
    // フローはそのバケットの発生額。
    expect(boxRow(matrix, 'expense')).toEqual([0, 0, 777]);
    expect(identityRow(matrix, 'netAssets')).toEqual([3_333, 4_444, 3_667]);
  });
});

describe('periodMatrixAsOf', () => {
  it('最終列の暦上の終了日を返す（有効な列が無ければ today）', () => {
    expect(periodMatrixAsOf({ mode: 'months', months: ['2026-02', '2026-01'] }, '2026-06-15')).toBe(
      '2026-02-28',
    );
    expect(periodMatrixAsOf({ mode: 'all', years: [2026, 2030] }, '2026-06-15')).toBe('2030-12-31');
    expect(periodMatrixAsOf({ mode: 'months', months: ['bad'] }, '2026-06-15')).toBe('2026-06-15');
  });
});
