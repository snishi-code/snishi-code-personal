/*
 * 期間マトリクス（時間平面の数値レンズ）の集計。
 *
 * `displayEntriesForAsOf` で実仕訳と導出仕訳を一度だけ展開した配列を受け取り、
 * 日付順の単一走査でフロー（PL）と列末のストック（BS）を同時に作る。
 * この関数内では導出仕訳を再展開しない。
 *
 * 列は「見せたい窓」を呼び出し側が渡す（月ズーム = 年をまたぐ月の並び / 年ズーム = 年の並び）。
 * 全期間を常に全列 DOM 化しないための可視範囲 + 前後バッファは呼び出し側の責務。
 */
import { compareAccountOrder } from './accountOrder';
import { naturalDelta } from './accounting';
import { isContinuousCostMonthlyAllocationEntry } from './livingCost';
import type { Account, JournalEntry } from './types';
import { assertSafeAmount } from './safeSum';

export type PeriodMatrixScope =
  /** 月ズーム。'YYYY-MM' の並び（年をまたいでよい・順不同/重複は正規化する）。 */
  | { mode: 'months'; months: readonly string[] }
  /** 年ズーム。年の並び（順不同/重複は正規化する）。 */
  | { mode: 'all'; years: readonly number[] };

export interface PeriodMatrixColumn {
  /** 月ズームは YYYY-MM、年ズームは YYYY。 */
  key: string;
  year: number;
  /** 月ズームの列だけが持つ 1〜12 の月。 */
  month?: number;
  /** 列の暦上の開始日。 */
  from: string;
  /** 列の暦上の終了日（月末または年末）。 */
  to: string;
  /** 集計基準日。常に列の暦上の終了日。 */
  asOf: string;
}

export type PeriodMatrixValue = number;

export type PeriodMatrixRowKey =
  | 'revenue'
  | 'expense'
  | 'net'
  | 'monthlyCost'
  | 'totalAssets'
  | 'netAssets';

/** 固定行。配列の添字は columns と一致する。 */
export type PeriodMatrixRows = Record<PeriodMatrixRowKey, PeriodMatrixValue[]>;

export interface PeriodMatrixExpenseCategory {
  account: Account;
  /** 配列の添字は columns と一致する。 */
  values: PeriodMatrixValue[];
}

export interface PeriodMatrix {
  columns: PeriodMatrixColumn[];
  rows: PeriodMatrixRows;
  /** 表示列のいずれかが 0 ではない費用科目だけを、科目の正本順で返す。 */
  expenseCategories: PeriodMatrixExpenseCategory[];
}

function pad2(value: number): string {
  return String(value).padStart(2, '0');
}

function monthEnd(year: number, month: number): string {
  const day = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return `${year}-${pad2(month)}-${pad2(day)}`;
}

function validYear(year: number): boolean {
  return Number.isInteger(year) && year > 0 && year <= 9999;
}

/** 'YYYY-MM' を [年, 月] へ。形式・範囲が壊れていれば undefined（列を作らない）。 */
function parseMonthKey(key: string): [number, number] | undefined {
  if (!/^\d{4}-\d{2}$/.test(key)) return undefined;
  const year = Number.parseInt(key.slice(0, 4), 10);
  const month = Number.parseInt(key.slice(5, 7), 10);
  if (!validYear(year) || month < 1 || month > 12) return undefined;
  return [year, month];
}

/** 月ズームの列。順不同・重複を正規化して昇順に並べる（年ズームの years と同じ作法）。 */
function monthColumns(months: readonly string[]): PeriodMatrixColumn[] {
  return Array.from(new Set(months))
    .filter((key) => parseMonthKey(key) !== undefined)
    .sort()
    .map((key) => {
      const [year, month] = parseMonthKey(key)!;
      const to = monthEnd(year, month);
      return { key, year, month, from: `${key}-01`, to, asOf: to };
    });
}

function columnsFor(scope: PeriodMatrixScope): PeriodMatrixColumn[] {
  if (scope.mode === 'months') return monthColumns(scope.months);

  const years = Array.from(new Set(scope.years.filter(validYear))).sort((a, b) => a - b);
  return years.map((year) => {
    const from = `${year}-01-01`;
    const to = `${year}-12-31`;
    return {
      key: String(year),
      year,
      from,
      to,
      asOf: to,
    };
  });
}

/**
 * UI が導出仕訳を一度だけ展開するときの最大基準日 = 最終列の暦上の終了日。
 * 現在・未来も同じ地図として列末まで展開する。
 * 有効な列が 1 つも無ければ、呼び出し側が安全に空表示できるよう today を返す。
 */
export function periodMatrixAsOf(scope: PeriodMatrixScope, today: string): string {
  return columnsFor(scope).at(-1)?.asOf ?? today;
}

function blankValues(columns: PeriodMatrixColumn[]): PeriodMatrixValue[] {
  return columns.map(() => 0);
}

function addValue(values: PeriodMatrixValue[], index: number, amount: number): void {
  const current = values[index];
  // 収入・費用セルの累積も checked（1 行の上限は schema が守るが、合算は守らないため）。
  if (current !== undefined) values[index] = assertSafeAmount(current + amount);
}

/**
 * 展開済み仕訳から月列または年列のマトリクスを作る。
 *
 * - entries は最大基準日まで `displayEntriesForAsOf` した結果を渡す。
 * - 入力配列は変更しない。
 * - 現在・未来を問わず、列末時点の投影値を数値で返す。
 * - PL、継続コスト、費用カテゴリ、BS のために仕訳を複数回走査しない。
 */
export function buildPeriodMatrix(
  accounts: readonly Account[],
  entries: readonly JournalEntry[],
  scope: PeriodMatrixScope,
): PeriodMatrix {
  const columns = columnsFor(scope);
  const revenue = blankValues(columns);
  const expense = blankValues(columns);
  const monthlyCost = blankValues(columns);
  const totalAssets = blankValues(columns);
  const netAssets = blankValues(columns);
  const accountById = new Map(accounts.map((account) => [account.id, account] as const));
  const expenseValuesById = new Map<string, PeriodMatrixValue[]>(
    accounts
      .filter((account) => account.type === 'expense')
      .map((account) => [account.id, blankValues(columns)]),
  );

  const flowColumnByKey = new Map(columns.map((column, index) => [column.key, index] as const));
  const orderedEntries = [...entries].sort((a, b) => {
    const date = a.date.localeCompare(b.date);
    return date !== 0 ? date : a.id.localeCompare(b.id);
  });
  const activeBoundaries = columns.map((column, index) => ({ index, asOf: column.asOf }));
  const maximumAsOf = activeBoundaries.at(-1)?.asOf;

  let boundaryIndex = 0;
  let assetsBalance = 0;
  let liabilitiesBalance = 0;
  const snapshotThrough = (beforeDate?: string) => {
    while (boundaryIndex < activeBoundaries.length) {
      const boundary = activeBoundaries[boundaryIndex];
      if (!boundary || (beforeDate !== undefined && boundary.asOf >= beforeDate)) break;
      totalAssets[boundary.index] = assetsBalance;
      netAssets[boundary.index] = assertSafeAmount(assetsBalance - liabilitiesBalance);
      boundaryIndex += 1;
    }
  };

  if (maximumAsOf !== undefined) {
    for (const entry of orderedEntries) {
      if (entry.date > maximumAsOf) break;
      snapshotThrough(entry.date);

      const flowKey = scope.mode === 'months' ? entry.date.slice(0, 7) : entry.date.slice(0, 4);
      const flowColumnIndex = flowColumnByKey.get(flowKey);
      const monthlyAllocation = isContinuousCostMonthlyAllocationEntry(entry);

      for (const line of entry.lines) {
        const account = accountById.get(line.accountId);
        if (!account) continue;
        const delta = naturalDelta(account, line.side, line.amount);

        if (account.type === 'asset') assetsBalance = assertSafeAmount(assetsBalance + delta);
        if (account.type === 'liability')
          liabilitiesBalance = assertSafeAmount(liabilitiesBalance + delta);
        if (flowColumnIndex === undefined) continue;

        if (account.type === 'revenue') addValue(revenue, flowColumnIndex, delta);
        if (account.type === 'expense') {
          addValue(expense, flowColumnIndex, delta);
          const categoryValues = expenseValuesById.get(account.id);
          if (categoryValues) addValue(categoryValues, flowColumnIndex, delta);
          if (monthlyAllocation) addValue(monthlyCost, flowColumnIndex, delta);
        }
      }
    }
    snapshotThrough();
  }

  const net = revenue.map((value, index) => {
    const expenseValue = expense[index];
    return assertSafeAmount(value - (expenseValue ?? 0));
  });
  const expenseCategories = accounts
    .filter((account) => account.type === 'expense')
    .filter((account) => {
      const values = expenseValuesById.get(account.id);
      return values?.some((value) => value !== 0) === true;
    })
    .sort(compareAccountOrder)
    .map((account) => ({
      account,
      values: expenseValuesById.get(account.id) ?? blankValues(columns),
    }));

  return {
    columns,
    rows: { revenue, expense, net, monthlyCost, totalAssets, netAssets },
    expenseCategories,
  };
}
