/*
 * 時間平面の**値**（数値レンズの表・グラフレンズの折れ線が共有する集計）。
 *
 * `displayEntriesForAsOf` で実仕訳と導出仕訳を一度だけ展開した配列を受け取り、
 * 日付順の単一走査でフロー（期間の発生額）と列末のストック（残高の断面）を同時に作る。
 * この関数内では導出仕訳を再展開しない。
 *
 * 列は「見せたい窓」を呼び出し側が渡す:
 *   - 数値レンズ = 月の並び（年をまたぐ）または年の並び
 *   - グラフレンズ = 線分レンズと同じバケット（日 / 月 / 年）
 * 全期間を常に全列 DOM 化しないための可視範囲 + 前後バッファは呼び出し側の責務。
 *
 * 行は**共通ラベル列の木**（`domain/lensRows`）と同じ id で返す（v13.6 H3）。
 * レンズごとの独自の行集合・独自の階層はここには無い:
 *   `box:<箱>` = その箱の科目の合計 / `account:<id>` = 科目単独 /
 *   `identity:net` = 収入 − 支出 / `identity:netAssets` = 資産 − 負債。
 *
 * **親子の整合**: 箱の行の値は、必ず「その箱に属する科目の値の列ごとの合計」に一致する。
 * 値は minor unit の整数で、途中の丸めを一切しない。
 *
 * **符号**: すべて自然符号（負債・純資産は貸方正）。数直線上で反転させたいレンズは
 * `debitSignedBalance` を描画側で掛ける（集計側は 1 つの規約だけを持つ）。
 */
import { DISPLAY_BOX_KEYS, displayBoxIncludes } from './displayOrder';
import { lensRowId } from './lensRows';
import { naturalDelta } from './accounting';
import type { Account, JournalEntry } from './types';
import { assertSafeAmount } from './safeSum';

export type PeriodMatrixScope =
  /** 月ズーム。'YYYY-MM' の並び（年をまたいでよい・順不同/重複は正規化する）。 */
  | { mode: 'months'; months: readonly string[] }
  /** 年ズーム。年の並び（順不同/重複は正規化する）。 */
  | { mode: 'all'; years: readonly number[] }
  /** 任意のバケット（グラフレンズ = 線分レンズと同じ窓。昇順・重ならないこと）。 */
  | { mode: 'buckets'; buckets: readonly { key: string; from: string; to: string }[] };

export interface PeriodMatrixColumn {
  /** 月ズームは YYYY-MM、年ズームは YYYY、バケットは呼び出し側のキー。 */
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

export interface PeriodMatrix {
  columns: PeriodMatrixColumn[];
  /**
   * 共通ラベル列の行 id → 列ごとの値（配列の添字は `columns` と一致する）。
   * 値を持たない行（線分レンズだけの月割り項目など）は入らない。
   */
  values: ReadonlyMap<string, PeriodMatrixValue[]>;
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
  if (scope.mode === 'buckets') {
    return scope.buckets.map((bucket) => ({
      key: bucket.key,
      year: Number.parseInt(bucket.from.slice(0, 4), 10),
      from: bucket.from,
      to: bucket.to,
      asOf: bucket.to,
    }));
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
 * UI が導出仕訳を一度だけ展開するときの最大基準日 = 最終列の暦上の終了日。
 * 現在・未来も同じ地図として列末まで展開する。
 * 有効な列が 1 つも無ければ、呼び出し側が安全に空表示できるよう today を返す。
 */
export function periodMatrixAsOf(scope: PeriodMatrixScope, today: string): string {
  return columnsFor(scope).at(-1)?.asOf ?? today;
}

/** 行 id の列値。値を持たない行は 0 埋め（呼び出し側で `??` を書かないため）。 */
export function periodMatrixRow(matrix: PeriodMatrix, rowId: string): PeriodMatrixValue[] {
  return matrix.values.get(rowId) ?? matrix.columns.map(() => 0);
}

function blankValues(count: number): PeriodMatrixValue[] {
  return Array.from({ length: count }, () => 0);
}

function addValue(values: PeriodMatrixValue[], index: number, amount: number): void {
  const current = values[index];
  // 収入・費用セルの累積も checked（1 行の上限は schema が守るが、合算は守らないため）。
  if (current !== undefined) values[index] = assertSafeAmount(current + amount);
}

/** 列ごとの合計（親の値は必ずこれで作る = 子の合計と一致させる）。 */
function sumValues(count: number, rows: readonly (readonly PeriodMatrixValue[])[]) {
  const total = blankValues(count);
  for (const values of rows) {
    values.forEach((value, index) => addValue(total, index, value));
  }
  return total;
}

/** 列ごとの差（恒等行。収支 = 収入 − 支出 / 純資産 = 資産 − 負債）。 */
function subtractValues(
  left: readonly PeriodMatrixValue[],
  right: readonly PeriodMatrixValue[],
): PeriodMatrixValue[] {
  return left.map((value, index) => assertSafeAmount(value - (right[index] ?? 0)));
}

/** その科目が期間の発生額（フロー）で見るものか。残りは断面の残高（ストック）。 */
function isFlowAccount(account: Account): boolean {
  return account.type === 'revenue' || account.type === 'expense';
}

/**
 * 展開済み仕訳から、共通ラベル列の行 id ごとの列値を作る。
 *
 * - entries は最大基準日まで `displayEntriesForAsOf` した結果を渡す。
 * - 入力配列は変更しない。
 * - 現在・未来を問わず、列末時点の投影値を数値で返す。
 * - フロー・ストック・科目別・箱別のために仕訳を複数回走査しない。
 */
export function buildPeriodMatrix(
  accounts: readonly Account[],
  entries: readonly JournalEntry[],
  scope: PeriodMatrixScope,
): PeriodMatrix {
  const columns = columnsFor(scope);
  const count = columns.length;
  const values = new Map<string, PeriodMatrixValue[]>();
  /** 科目ごとの列値（フローは期間の発生額・ストックは列末の残高）。 */
  const byAccount = new Map<string, PeriodMatrixValue[]>(
    accounts.map((account) => [account.id, blankValues(count)] as const),
  );
  if (count === 0) return { columns, values };

  const accountById = new Map(accounts.map((account) => [account.id, account] as const));
  const stockBalanceById = new Map<string, number>(
    accounts.filter((account) => !isFlowAccount(account)).map((account) => [account.id, 0]),
  );

  /** `beforeDate` より前に締まる列へ、いまの残高を焼き付ける。 */
  let boundary = 0;
  const snapshotThrough = (beforeDate?: string) => {
    while (boundary < count) {
      const column = columns[boundary];
      if (!column || (beforeDate !== undefined && column.asOf >= beforeDate)) break;
      for (const [accountId, balance] of stockBalanceById) {
        byAccount.get(accountId)![boundary] = balance;
      }
      boundary += 1;
    }
  };

  const maximumAsOf = columns.at(-1)!.asOf;
  const ordered = [...entries].sort((a, b) => {
    const date = a.date.localeCompare(b.date);
    return date !== 0 ? date : a.id.localeCompare(b.id);
  });
  /** フローを足す列。列は昇順・重ならないので、日付順の走査で前へ戻らない。 */
  let flowIndex = 0;
  for (const entry of ordered) {
    if (entry.date > maximumAsOf) break;
    snapshotThrough(entry.date);
    while (flowIndex < count && columns[flowIndex]!.to < entry.date) flowIndex += 1;
    // 列と列の隙間（年を飛ばした窓など）に落ちた仕訳はどの列にも足さない。
    const flowColumn =
      flowIndex < count && columns[flowIndex]!.from <= entry.date ? flowIndex : undefined;

    for (const line of entry.lines) {
      const account = accountById.get(line.accountId);
      if (!account) continue;
      const delta = naturalDelta(account, line.side, line.amount);
      if (!isFlowAccount(account)) {
        stockBalanceById.set(
          account.id,
          assertSafeAmount((stockBalanceById.get(account.id) ?? 0) + delta),
        );
        continue;
      }
      if (flowColumn !== undefined) addValue(byAccount.get(account.id)!, flowColumn, delta);
    }
  }
  snapshotThrough();

  for (const [accountId, row] of byAccount) values.set(lensRowId.account(accountId), row);

  // 箱の値 = その箱に属する科目の合計（所属の正本は表示順マスタ）。
  for (const boxKey of DISPLAY_BOX_KEYS) {
    const members = accounts.filter((account) => displayBoxIncludes(boxKey, account));
    values.set(
      lensRowId.box(boxKey),
      sumValues(
        count,
        members.map((account) => byAccount.get(account.id)!),
      ),
    );
  }

  // 恒等行。会計 type で括る（箱の合計ではなく型の合計 = 箱に漏れがあっても式が崩れない）。
  const totalOf = (predicate: (account: Account) => boolean) =>
    sumValues(
      count,
      accounts.filter(predicate).map((account) => byAccount.get(account.id)!),
    );
  values.set(
    lensRowId.identity('net'),
    subtractValues(
      totalOf((account) => account.type === 'revenue'),
      totalOf((account) => account.type === 'expense'),
    ),
  );
  values.set(
    lensRowId.identity('netAssets'),
    subtractValues(
      totalOf((account) => account.type === 'asset'),
      totalOf((account) => account.type === 'liability'),
    ),
  );

  return { columns, values };
}
