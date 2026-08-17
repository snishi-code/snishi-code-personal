import { describe, expect, it } from 'vitest';
import {
  buildPeriodMatrix,
  periodMatrixAsOf,
  PERIOD_MATRIX_ROW_KEYS,
  type PeriodMatrix,
  type PeriodMatrixNode,
  type PeriodMatrixRowKey,
  type PeriodMatrixScope,
} from '../src/domain/periodMatrix';
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

function sectionOf(matrix: PeriodMatrix, key: PeriodMatrixRowKey) {
  const section = matrix.sections.find((s) => s.key === key);
  if (!section) throw new Error(`section ${key} not found`);
  return section;
}

/** 展開行の見出し（科目は名前・グループは i18n キー）。 */
function nodeLabel(node: PeriodMatrixNode): string {
  return node.label.kind === 'account' ? node.label.name : node.label.key;
}

function labelsOf(nodes: readonly PeriodMatrixNode[]): string[] {
  return nodes.map(nodeLabel);
}

/** 列ごとの単純合計（親子の整合を確かめる側は checked sum を使わない = 実装と別経路）。 */
function columnSums(nodes: readonly PeriodMatrixNode[], columnCount: number): number[] {
  return Array.from({ length: columnCount }, (_, index) =>
    nodes.reduce((total, node) => total + (node.values[index] ?? 0), 0),
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
    expect(matrix.rows.expense.slice(4, 7)).toEqual([100, 1199, 0]);
    expect(matrix.rows.revenue.slice(4, 7)).toEqual([0, 500, 0]);
    expect(matrix.rows.net.slice(4, 7)).toEqual([-100, -699, 0]);
    expect(matrix.rows.totalAssets.slice(4, 7)).toEqual([900, 201, 201]);
    expect(matrix.rows.netAssets.slice(4, 7)).toEqual([900, 201, 201]);
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
    expect(matrix.rows.expense).toEqual([100, 200, 0]);
    // BS は窓の手前の 1000 から連続する（列が無い月の移動も繰り越す）。
    expect(matrix.rows.totalAssets).toEqual([900, 700, 700]);
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

    expect(matrix.rows.totalAssets.slice(0, 2)).toEqual([1300, 1150]);
    expect(matrix.rows.netAssets.slice(0, 2)).toEqual([900, 900]);
    expect(matrix.rows.netAssets[0]).toBe(matrix.rows.totalAssets[0]! - 400);
    expect(matrix.rows.netAssets[1]).toBe(matrix.rows.totalAssets[1]! - 250);
  });

  it('導出月割りも費用カテゴリへ合算する（「月割り」の独立行は持たない）', () => {
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

    expect(matrix.rows.expense[0]).toBe(170);
    // 「月割り」の独立行は無い（6 分類だけ）。月割り分は費用カテゴリ側へ入る。
    expect(matrix.sections.map((s) => s.key)).toEqual([...PERIOD_MATRIX_ROW_KEYS]);
    const categories = sectionOf(matrix, 'expense').children;
    expect(labelsOf(categories)).toEqual(['fixed', 'food']);
    expect(categories[0]?.values[0]).toBe(120);
    expect(categories[1]?.values[0]).toBe(50);
  });

  it('全表示列が 0 のカテゴリを除外し、月ごとに増減があれば通期純額 0 でも残す', () => {
    const matrix = buildPeriodMatrix(
      accounts,
      [
        entry('cancelled-debit', '2026-01-10', 'cancelled', 'cash', 100),
        entry('cancelled-credit', '2026-02-10', 'cash', 'cancelled', 100),
        entry('zero-debit', '2026-03-10', 'zero', 'cash', 50),
        entry('zero-credit', '2026-03-11', 'cash', 'zero', 50),
      ],
      { mode: 'months', months: monthsOfYear(2026) },
    );

    const categories = sectionOf(matrix, 'expense').children;
    expect(labelsOf(categories)).toEqual(['cancelled']);
    expect(categories[0]?.values.slice(0, 3)).toEqual([100, -100, 0]);
  });

  it('未来年も年末断面として固定行・カテゴリ行を数値で返す', () => {
    const matrix = buildPeriodMatrix(
      accounts,
      [entry('future', '2027-01-01', 'food', 'cash', 100)],
      { mode: 'months', months: monthsOfYear(2027) },
    );

    expect(matrix.columns.every((column) => column.asOf === column.to)).toBe(true);
    expect(matrix.rows.expense[0]).toBe(100);
    expect(matrix.rows.net[0]).toBe(-100);
    expect(matrix.rows.totalAssets.every((value) => value === -100)).toBe(true);
    expect(sectionOf(matrix, 'expense').children[0]?.values[0]).toBe(100);
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

    expect(matrix.rows.revenue[0]).toBe(pl.totalRevenue);
    expect(matrix.rows.expense[0]).toBe(pl.totalExpense);
    expect(matrix.rows.net[0]).toBe(pl.netIncome);
    expect(matrix.rows.totalAssets[0]).toBe(bs.totalAssets);
    expect(matrix.rows.netAssets[0]).toBe(bs.netAssets);
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
    expect(matrix.rows.revenue).toEqual([100, 0, 999]);
    expect(matrix.rows.expense).toEqual([0, 1024, 0]);
    expect(matrix.rows.net).toEqual([100, -1024, 999]);
    expect(matrix.rows.totalAssets).toEqual([1100, 326, 1325]);
    expect(matrix.rows.netAssets).toEqual([1100, 126, 1125]);
    expect(sectionOf(matrix, 'expense').children[0]?.values).toEqual([0, 1024, 0]);
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

    // 月割り分は費用カテゴリ（fixed）へ入る。「月割り」の独立行はもう無いので、
    // 年間表示と全体表示の一致はカテゴリ行で確かめる。
    const monthlyValues = (matrix: PeriodMatrix) =>
      sectionOf(matrix, 'expense').children.find((node) => nodeLabel(node) === 'fixed')?.values ??
      [];

    // 同日刻み: 2025-10-05 起点の刻み日は 2025-11-05〜2026-03-05 の 5 本
    //（6 本目 2026-04-05 は終了日 2026-03-31 超）。割り振る総額 = 60,000 − 回収 30,000 =
    // 30,000 → 1 本 6,000。2025 年に入るのは 11/05・12/05 の 2 本 = 12,000。
    expect(annualTotal(monthlyValues(annual))).toBe(12_000);
    expect(annualTotal(monthlyValues(annual))).toBe(monthlyValues(all)[0]);
    expect(annualTotal(annual.rows.expense)).toBe(all.rows.expense[0]);
    expect(annual.rows.totalAssets[11]).toBe(all.rows.totalAssets[0]);
    expect(annual.rows.netAssets[11]).toBe(all.rows.netAssets[0]);
  });
});

/*
 * v13.5 E: 6 分類 + 段階的開示。
 * ホームの 6 カード（収入 / 支出 / 収支 / 資産 / 負債 / 純資産）と同じ並び・同じ集計正本で、
 * 行タップで開く子（インライン木）を持つ。ここで固定するのは
 *  ① 負債行が BS と同じ集計であること（総資産 − 純資産の引き算で作らない）
 *  ② 子の合計が親と一致すること（丸めで割れない）
 * の 2 系統。
 */
describe('buildPeriodMatrix（6 分類と段階的開示）', () => {
  const drillAccounts: Account[] = [
    account('cash', 'asset', 'daily-asset'),
    { ...account('locked', 'asset', 'daily-asset', { sortIndex: 1 }), movable: false },
    account('invest', 'asset', 'investment-asset'),
    account('continuing', 'asset', 'continuing-cost-asset'),
    account('card', 'liability', 'payment-liability'),
    account('loan', 'liability', 'other-liability'),
    account('equity', 'equity', 'equity'),
    account('salary', 'revenue', 'income-category', { sortIndex: 0 }),
    account('bonus', 'revenue', 'income-category', { sortIndex: 1 }),
    account('food', 'expense', 'expense-category'),
  ];
  const drillEntries: JournalEntry[] = [
    entry('open-cash', '2025-12-31', 'cash', 'equity', 1_000),
    entry('open-locked', '2025-12-31', 'locked', 'equity', 300),
    entry('open-invest', '2025-12-31', 'invest', 'equity', 500),
    entry('open-continuing', '2025-12-31', 'continuing', 'equity', 200),
    entry('card-spend', '2026-01-10', 'food', 'card', 150),
    entry('borrow', '2026-01-15', 'cash', 'loan', 800),
    entry('salary', '2026-01-20', 'cash', 'salary', 400),
    entry('bonus', '2026-02-05', 'cash', 'bonus', 100),
  ];
  const drillMatrix = () =>
    buildPeriodMatrix(drillAccounts, drillEntries, {
      mode: 'months',
      months: monthsOfYear(2026),
    });

  it('行はホームの 6 カードと同じ並び', () => {
    expect(drillMatrix().sections.map((section) => section.key)).toEqual([
      'revenue',
      'expense',
      'net',
      'totalAssets',
      'totalLiabilities',
      'netAssets',
    ]);
  });

  it('負債行は BS と同じ集計（総資産 − 純資産の引き算で作らない）', () => {
    const matrix = drillMatrix();

    matrix.columns.forEach((column, index) => {
      const bs = deriveBalanceSheet(drillAccounts, drillEntries, column.asOf);
      expect(matrix.rows.totalLiabilities[index]).toBe(bs.totalLiabilities);
      expect(matrix.rows.totalAssets[index]).toBe(bs.totalAssets);
      expect(matrix.rows.netAssets[index]).toBe(bs.netAssets);
    });
    // 1 月末 = カード 150 + ローン 800。返済も借入もない 2 月以降は据え置き。
    expect(matrix.rows.totalLiabilities.slice(0, 3)).toEqual([950, 950, 950]);
  });

  it('負債の子は科目・自然符号の昇順（最も大きな負債が先頭）で数字は負債トークン扱い', () => {
    const liabilities = sectionOf(drillMatrix(), 'totalLiabilities');

    // 表示は絶対値のまま（card 150 / loan 800）。比較だけ自然符号 = 昇順で loan が先頭（C-2）。
    expect(labelsOf(liabilities.children)).toEqual(['loan', 'card']);
    expect(liabilities.children.map((node) => node.values[0])).toEqual([800, 150]);
    // 負債科目はそれ以上たたまない（葉）。
    expect(liabilities.children.every((node) => node.children.length === 0)).toBe(true);
  });

  it('資産の子はホームの資産ドリルと同じ 4 グループ、月割り台帳だけは 1 行', () => {
    const assets = sectionOf(drillMatrix(), 'totalAssets');

    expect(labelsOf(assets.children)).toEqual([
      'assets.frame.free',
      'assets.frame.fixed',
      'assets.frame.investment',
      'assets.frame.ledger',
    ]);
    expect(assets.children.map((node) => node.values[0])).toEqual([2_200, 300, 500, 200]);
    expect(assets.children.map((node) => labelsOf(node.children))).toEqual([
      ['cash'],
      ['locked'],
      ['invest'],
      // 月割り台帳は残存価値の合計 1 行（内訳は台帳画面で見る）。
      [],
    ]);
  });

  it('収支・純資産は葉（引き算の結果はそれ以上ばらさない）', () => {
    const matrix = drillMatrix();
    expect(sectionOf(matrix, 'net').children).toEqual([]);
    expect(sectionOf(matrix, 'netAssets').children).toEqual([]);
    expect(labelsOf(sectionOf(matrix, 'revenue').children)).toEqual(['salary', 'bonus']);
    expect(labelsOf(sectionOf(matrix, 'expense').children)).toEqual(['food']);
  });

  it('子の合計は列ごとに親と一致し、丸めで割れない', () => {
    const matrix = drillMatrix();
    const columnCount = matrix.columns.length;
    let checked = 0;

    for (const section of matrix.sections) {
      expect(section.values.every(Number.isInteger)).toBe(true);
      if (section.children.length === 0) continue;
      expect(columnSums(section.children, columnCount)).toEqual(section.values);
      checked += 1;
      for (const child of section.children) {
        expect(child.values.every(Number.isInteger)).toBe(true);
        if (child.children.length === 0) continue;
        expect(columnSums(child.children, columnCount)).toEqual(child.values);
        checked += 1;
      }
    }
    // 収入 / 支出 / 資産 / 負債 + 資産の 3 グループ（月割り台帳は葉）。
    expect(checked).toBe(7);
  });

  it('全列 0 の科目は子に出さないが、親の合計はその科目ぶんも含めて一致したまま', () => {
    const matrix = buildPeriodMatrix(
      [...drillAccounts, account('sleeping', 'asset', 'daily-asset', { sortIndex: 9 })],
      drillEntries,
      { mode: 'months', months: monthsOfYear(2026) },
    );
    const free = sectionOf(matrix, 'totalAssets').children[0];

    expect(labelsOf(free?.children ?? [])).toEqual(['cash']);
    expect(columnSums(sectionOf(matrix, 'totalAssets').children, matrix.columns.length)).toEqual(
      matrix.rows.totalAssets,
    );
  });
});

describe('periodMatrixAsOf', () => {
  it.each([
    [{ mode: 'months', months: monthsOfYear(2025) } as PeriodMatrixScope, '2025-12-31'],
    [{ mode: 'months', months: monthsOfYear(2026) } as PeriodMatrixScope, '2026-12-31'],
    [{ mode: 'months', months: monthsOfYear(2027) } as PeriodMatrixScope, '2027-12-31'],
    [{ mode: 'months', months: ['2026-01', '2025-11'] } as PeriodMatrixScope, '2026-01-31'],
    [{ mode: 'months', months: [] } as PeriodMatrixScope, '2026-06-15'],
    [{ mode: 'all', years: [2026, 2024, 2026] } as PeriodMatrixScope, '2026-12-31'],
    [{ mode: 'all', years: [] } as PeriodMatrixScope, '2026-06-15'],
  ])('%j の最大展開日を返す', (scope, expected) => {
    expect(periodMatrixAsOf(scope, '2026-06-15')).toBe(expected);
  });
});
