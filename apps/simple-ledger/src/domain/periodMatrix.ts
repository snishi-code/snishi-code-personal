/*
 * 期間マトリクス（時間平面の数値レンズ）の集計。
 *
 * `displayEntriesForAsOf` で実仕訳と導出仕訳を一度だけ展開した配列を受け取り、
 * 日付順の単一走査でフロー（PL）と列末のストック（BS）を同時に作る。
 * この関数内では導出仕訳を再展開しない。
 *
 * 列は「見せたい窓」を呼び出し側が渡す（月ズーム = 年をまたぐ月の並び / 年ズーム = 年の並び）。
 * 全期間を常に全列 DOM 化しないための可視範囲 + 前後バッファは呼び出し側の責務。
 *
 * 行は**ホームの 6 カードと同じ 6 分類**（収入 / 支出 / 収支 / 資産 / 負債 / 純資産。v13.5 E）。
 * 各分類は段階的開示のための子（インライン木）を持つ:
 *   収入 → 収入カテゴリ / 支出 → 費用カテゴリ / 資産 → 資産の 4 グループ → 科目 /
 *   負債 → 負債科目 / 収支・純資産 → 葉。
 * 「月割り」の独立行は廃止し、資産の 4 グループのうち「月割り台帳」（残存価値の合計）へ移した
 * （内訳画面と同じ 1 行の見せ方）。展開状態は画面ローカルで、ここには持たない。
 *
 * **親子の整合**: 子を持つ行の値は、必ず「表示する子の値の列ごとの合計」に一致する
 * （資産の 4 グループの合計 = 総資産、各グループ = その科目の合計）。値は minor unit の整数で、
 * 途中の丸めを一切しない。
 */
import {
  ASSET_GROUP_KEYS,
  DISPLAY_SECTION_KEYS,
  compareAccountOrder,
  type DisplaySectionKey,
} from './displayOrder';
import { debitSignedBalance, naturalDelta } from './accounting';
import { ASSET_GROUP_LABEL_KEYS, assetGroupOf, type AssetGroupKey } from './assetGroups';
import type { MessageKey } from '../i18n';
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

/**
 * ホームの 6 カードと同じ 6 分類。**種類も並びも `domain/displayOrder` が正本**
 * （ここで並びを書かない = ホームと表がずれない）。
 */
export type PeriodMatrixRowKey = DisplaySectionKey;

/** 固定行。配列の添字は columns と一致する。 */
export type PeriodMatrixRows = Record<PeriodMatrixRowKey, PeriodMatrixValue[]>;

/** 展開行のラベル。科目は名前そのまま、グループは i18n キー（表示は UI 側で解決する）。 */
export type PeriodMatrixLabel =
  | { kind: 'account'; name: string }
  | { kind: 'message'; key: MessageKey };

/** 展開行（インライン木の 1 行）。子を持つ行の値は子の合計に一致する。 */
export interface PeriodMatrixNode {
  /** 行の一意キー（React key・展開状態の識別子）。 */
  key: string;
  label: PeriodMatrixLabel;
  /** 配列の添字は columns と一致する。 */
  values: PeriodMatrixValue[];
  /** さらに下の階層。空 = 葉。 */
  children: PeriodMatrixNode[];
}

/** 6 分類の 1 行。values は `rows` と同じ配列を指す（二重に持たない）。 */
export interface PeriodMatrixSection {
  key: PeriodMatrixRowKey;
  values: PeriodMatrixValue[];
  children: PeriodMatrixNode[];
}

export interface PeriodMatrix {
  columns: PeriodMatrixColumn[];
  rows: PeriodMatrixRows;
  /** 6 分類を表示順で。行タップの段階的開示はこの木をそのまま辿る。 */
  sections: PeriodMatrixSection[];
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

/** 列ごとの合計（親の値は必ずこれで作る = 子の合計と一致させる）。 */
function sumValues(
  columns: PeriodMatrixColumn[],
  rows: readonly PeriodMatrixValue[][],
): PeriodMatrixValue[] {
  const total = blankValues(columns);
  for (const values of rows) {
    values.forEach((value, index) => addValue(total, index, value));
  }
  return total;
}

/** 表示列のどれかが 0 ではない = その行を出す（全列 0 の科目は展開しても無意味）。 */
function hasAnyValue(values: readonly PeriodMatrixValue[]): boolean {
  return values.some((value) => value !== 0);
}

function accountNode(
  prefix: string,
  account: Account,
  values: PeriodMatrixValue[],
): PeriodMatrixNode {
  return {
    key: `${prefix}.${account.id}`,
    label: { kind: 'account', name: account.name },
    values,
    children: [],
  };
}

/**
 * 展開済み仕訳から月列または年列のマトリクスを作る。
 *
 * - entries は最大基準日まで `displayEntriesForAsOf` した結果を渡す。
 * - 入力配列は変更しない。
 * - 現在・未来を問わず、列末時点の投影値を数値で返す。
 * - PL、カテゴリ、BS、科目別残高のために仕訳を複数回走査しない。
 */
export function buildPeriodMatrix(
  accounts: readonly Account[],
  entries: readonly JournalEntry[],
  scope: PeriodMatrixScope,
): PeriodMatrix {
  const columns = columnsFor(scope);
  const revenue = blankValues(columns);
  const expense = blankValues(columns);
  const totalAssets = blankValues(columns);
  const totalLiabilities = blankValues(columns);
  const netAssets = blankValues(columns);
  const accountById = new Map(accounts.map((account) => [account.id, account] as const));
  // フロー（収入・費用カテゴリ）は列バケットへ加算、ストック（資産・負債科目）は列末を焼き付ける。
  const flowValuesById = new Map<string, PeriodMatrixValue[]>(
    accounts
      .filter((account) => account.type === 'revenue' || account.type === 'expense')
      .map((account) => [account.id, blankValues(columns)]),
  );
  const stockAccounts = accounts.filter(
    (account) => account.type === 'asset' || account.type === 'liability',
  );
  const stockValuesById = new Map<string, PeriodMatrixValue[]>(
    stockAccounts.map((account) => [account.id, blankValues(columns)]),
  );
  const stockBalanceById = new Map<string, number>(stockAccounts.map((account) => [account.id, 0]));

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
      totalLiabilities[boundary.index] = liabilitiesBalance;
      netAssets[boundary.index] = assertSafeAmount(assetsBalance - liabilitiesBalance);
      for (const [accountId, values] of stockValuesById) {
        values[boundary.index] = stockBalanceById.get(accountId) ?? 0;
      }
      boundaryIndex += 1;
    }
  };

  if (maximumAsOf !== undefined) {
    for (const entry of orderedEntries) {
      if (entry.date > maximumAsOf) break;
      snapshotThrough(entry.date);

      const flowKey = scope.mode === 'months' ? entry.date.slice(0, 7) : entry.date.slice(0, 4);
      const flowColumnIndex = flowColumnByKey.get(flowKey);

      for (const line of entry.lines) {
        const account = accountById.get(line.accountId);
        if (!account) continue;
        const delta = naturalDelta(account, line.side, line.amount);

        if (account.type === 'asset' || account.type === 'liability') {
          const balance = assertSafeAmount((stockBalanceById.get(account.id) ?? 0) + delta);
          stockBalanceById.set(account.id, balance);
          if (account.type === 'asset') assetsBalance = assertSafeAmount(assetsBalance + delta);
          else liabilitiesBalance = assertSafeAmount(liabilitiesBalance + delta);
        }
        if (flowColumnIndex === undefined) continue;

        if (account.type === 'revenue') addValue(revenue, flowColumnIndex, delta);
        if (account.type === 'expense') addValue(expense, flowColumnIndex, delta);
        if (account.type === 'revenue' || account.type === 'expense') {
          const categoryValues = flowValuesById.get(account.id);
          if (categoryValues) addValue(categoryValues, flowColumnIndex, delta);
        }
      }
    }
    snapshotThrough();
  }

  const net = revenue.map((value, index) => {
    const expenseValue = expense[index];
    return assertSafeAmount(value - (expenseValue ?? 0));
  });

  /** フロー分類（収入 / 支出）の子 = 表示列のどれかが 0 ではないカテゴリを科目の正本順で。 */
  const flowChildren = (type: 'revenue' | 'expense', prefix: string): PeriodMatrixNode[] =>
    accounts
      .filter((account) => account.type === type)
      .filter((account) => hasAnyValue(flowValuesById.get(account.id) ?? []))
      .sort(compareAccountOrder)
      .map((account) => accountNode(prefix, account, flowValuesById.get(account.id)!));

  const stockValuesOf = (account: Account): PeriodMatrixValue[] =>
    stockValuesById.get(account.id) ?? blankValues(columns);

  // 資産 → 4 グループ → 科目。グループ分けの正本は domain/assetGroups（内訳画面と共有）。
  // 「月割り台帳」だけは内訳画面と同じく 1 行（残存価値の合計）で、科目へは展開しない。
  const assetGroupNode = (groupKey: AssetGroupKey): PeriodMatrixNode | null => {
    const members = accounts
      .filter((account) => assetGroupOf(account) === groupKey)
      .filter((account) => hasAnyValue(stockValuesOf(account)))
      .sort(compareAccountOrder);
    if (members.length === 0) return null;
    const prefix = `totalAssets.${groupKey}`;
    const children =
      groupKey === 'ledger'
        ? []
        : members.map((account) => accountNode(prefix, account, stockValuesOf(account)));
    return {
      key: prefix,
      label: { kind: 'message', key: ASSET_GROUP_LABEL_KEYS[groupKey] },
      values: sumValues(columns, members.map(stockValuesOf)),
      children,
    };
  };

  // 負債 → 負債科目。C-2 の規約に合わせ、比較だけ自然符号（貸方残高は負）で行う
  // = 昇順で最も大きな負債が先頭。基準は窓の最終列（一番新しい断面）の残高。
  const liabilityChildren = accounts
    .filter((account) => account.type === 'liability')
    .filter((account) => hasAnyValue(stockValuesOf(account)))
    .sort((a, b) => {
      const latest = (account: Account) => stockValuesOf(account).at(-1) ?? 0;
      const diff = debitSignedBalance(a.type, latest(a)) - debitSignedBalance(b.type, latest(b));
      return diff !== 0 ? diff : compareAccountOrder(a, b);
    })
    .map((account) => accountNode('totalLiabilities', account, stockValuesOf(account)));

  const childrenByRow: Record<PeriodMatrixRowKey, PeriodMatrixNode[]> = {
    revenue: flowChildren('revenue', 'revenue'),
    expense: flowChildren('expense', 'expense'),
    net: [],
    totalAssets: ASSET_GROUP_KEYS.map(assetGroupNode).filter(
      (node): node is PeriodMatrixNode => node !== null,
    ),
    totalLiabilities: liabilityChildren,
    netAssets: [],
  };
  const rows: PeriodMatrixRows = {
    revenue,
    expense,
    net,
    totalAssets,
    totalLiabilities,
    netAssets,
  };

  return {
    columns,
    rows,
    sections: DISPLAY_SECTION_KEYS.map((key) => ({
      key,
      values: rows[key],
      children: childrenByRow[key],
    })),
  };
}
