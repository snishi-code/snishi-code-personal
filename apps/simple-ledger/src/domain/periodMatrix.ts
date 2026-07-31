/*
 * 年間・全体マトリクスの集計。
 *
 * `reportEntriesForAsOf` で実仕訳と導出仕訳を一度だけ展開した配列を受け取り、
 * 日付順の単一走査でフロー（PL）と列末のストック（BS）を同時に作る。
 * この関数内では導出仕訳を再展開しない。
 */
import { compareAccountOrder } from './accountOrder';
import { isDebitNormal } from './accounting';
import { isContinuousCostRecognitionEntry } from './livingCost';
import type { Account, JournalEntry } from './types';

export type PeriodMatrixScope =
  | { mode: 'year'; year: number }
  | { mode: 'all'; years: readonly number[] };

export interface PeriodMatrixColumn {
  /** 年間は YYYY-MM、全体は YYYY。 */
  key: string;
  year: number;
  /** 年間列だけが持つ 1〜12 の月。 */
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

function columnsFor(scope: PeriodMatrixScope): PeriodMatrixColumn[] {
  if (scope.mode === 'year') {
    if (!validYear(scope.year)) return [];
    return Array.from({ length: 12 }, (_, index) => {
      const month = index + 1;
      const key = `${scope.year}-${pad2(month)}`;
      const from = `${key}-01`;
      const to = monthEnd(scope.year, month);
      return {
        key,
        year: scope.year,
        month,
        from,
        to,
        asOf: to,
      };
    });
  }

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
 * UI が導出仕訳を一度だけ展開するときの最大基準日。
 * 年間は年末、全体は最終列の年末。現在・未来も同じ地図として列末まで展開する。
 * 全体の有効年が空なら、呼び出し側が安全に空表示できるよう today を返す。
 */
export function periodMatrixAsOf(scope: PeriodMatrixScope, today: string): string {
  if (scope.mode === 'year') {
    return validYear(scope.year) ? `${scope.year}-12-31` : today;
  }
  const years = Array.from(new Set(scope.years.filter(validYear))).sort((a, b) => a - b);
  const last = years.at(-1);
  return last === undefined ? today : `${last}-12-31`;
}

function blankValues(columns: PeriodMatrixColumn[]): PeriodMatrixValue[] {
  return columns.map(() => 0);
}

function addValue(values: PeriodMatrixValue[], index: number, amount: number): void {
  const current = values[index];
  if (current !== undefined) values[index] = current + amount;
}

function naturalDelta(account: Account, side: 'debit' | 'credit', amount: number): number {
  const increases =
    (side === 'debit' && isDebitNormal(account.type)) ||
    (side === 'credit' && !isDebitNormal(account.type));
  return increases ? amount : -amount;
}

/**
 * 展開済み仕訳から年間（月12列）または全体（年列）のマトリクスを作る。
 *
 * - entries は最大基準日まで `reportEntriesForAsOf` した結果を渡す。
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
      netAssets[boundary.index] = assetsBalance - liabilitiesBalance;
      boundaryIndex += 1;
    }
  };

  if (maximumAsOf !== undefined) {
    for (const entry of orderedEntries) {
      if (entry.date > maximumAsOf) break;
      snapshotThrough(entry.date);

      const flowKey = scope.mode === 'year' ? entry.date.slice(0, 7) : entry.date.slice(0, 4);
      const flowColumnIndex = flowColumnByKey.get(flowKey);
      const recognition = isContinuousCostRecognitionEntry(entry);

      for (const line of entry.lines) {
        const account = accountById.get(line.accountId);
        if (!account) continue;
        const delta = naturalDelta(account, line.side, line.amount);

        if (account.type === 'asset') assetsBalance += delta;
        if (account.type === 'liability') liabilitiesBalance += delta;
        if (flowColumnIndex === undefined) continue;

        if (account.type === 'revenue') addValue(revenue, flowColumnIndex, delta);
        if (account.type === 'expense') {
          addValue(expense, flowColumnIndex, delta);
          const categoryValues = expenseValuesById.get(account.id);
          if (categoryValues) addValue(categoryValues, flowColumnIndex, delta);
          if (recognition) addValue(monthlyCost, flowColumnIndex, delta);
        }
      }
    }
    snapshotThrough();
  }

  const net = revenue.map((value, index) => {
    const expenseValue = expense[index];
    return value - (expenseValue ?? 0);
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
