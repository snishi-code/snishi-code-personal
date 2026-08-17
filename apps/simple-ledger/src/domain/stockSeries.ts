/*
 * ストック 4 系列（時間平面の**グラフレンズ**の第 1 段）。
 *
 * 資産 / 負債 / 純資産 / 自由に動かせるお金 の 4 本を、**各バケット末の断面**で切り出す。
 * 値は「その日を終えた時点の残高」＝バケットの `to` を基準日にした断面で、フローの棒や
 * 2 軸は持たない（作者決定 2026-08-18・v13.5 F）。
 *
 * **列ごとに deriveBalanceSheet を回さない**。`displayEntriesForAsOf` で一度だけ展開した
 * 配列を日付順に 1 回走査し、バケット境界を跨ぐたびに現在の累積残高を焼き付ける
 * （`periodMatrix` の snapshotThrough と同じ規則。断面の本数が増えても走査は 1 回）。
 *
 * 符号の規約:
 *  - 資産・自由に動かせるお金 = 自然残高（借方正）。
 *  - **負債は debit-signed**（貸方残高を負で描く。C-2 / periodMatrix の子ソートと同じ規約）。
 *    0 の線をまたいで下へ伸びるので、資産と重ならずに読める。
 *  - 純資産 = 資産 − 負債（自然残高どうしの差）。上の 2 本の符号規約と足し合わせが一致する。
 *
 * 「自由に動かせるお金」の判定は `domain/cashflow` の `isFreeAsset` が単一正本
 * （資金繰りの原資と同じ集合。ここで role/movable を書き直さない）。
 */
import { debitSignedBalance, naturalDelta } from './accounting';
import { isFreeAsset } from './cashflow';
import { assertSafeAmount } from './safeSum';
import type { Account, JournalEntry } from './types';

/** 4 系列の識別子。 */
export type StockSeriesKey = 'assets' | 'liabilities' | 'netAssets' | 'freeFunds';

/** 凡例と描画の並び（上から）。 */
export const STOCK_SERIES_KEYS: readonly StockSeriesKey[] = [
  'assets',
  'liabilities',
  'netAssets',
  'freeFunds',
];

/**
 * 既定で表示する系列。**純資産**と**自由に動かせるお金**（「いま全体でいくら」と
 * 「いま動かせるのはいくら」の 2 本）。資産・負債は凡例をタップして足す。
 */
export const STOCK_SERIES_DEFAULT_VISIBLE: readonly StockSeriesKey[] = ['netAssets', 'freeFunds'];

/** 断面を切り出す 1 バケット。`to` がそのバケットの基準日（末日）。 */
export interface StockSeriesBucket {
  key: string;
  from: string;
  to: string;
}

export interface StockSeries {
  /** 入力のバケットをそのまま（呼び出し側の窓が正本。ここでは並べ替えない）。 */
  buckets: StockSeriesBucket[];
  /** 各系列の値。配列の添字は buckets と一致する。 */
  values: Record<StockSeriesKey, number[]>;
}

function blank(count: number): number[] {
  return Array.from({ length: count }, () => 0);
}

/**
 * 展開済み仕訳から 4 系列を作る。
 *
 * - `entries` は最終バケットの `to` まで `displayEntriesForAsOf` した結果を渡す。
 * - 入力配列は変更しない。
 * - 最初のバケットより前の仕訳も残高に積む（断面は「その日までの全部」）。
 * - バケットは `to` の昇順で渡す（呼び出し側の窓 = `buildTimelineBuckets` が既に昇順）。
 */
export function buildStockSeries(
  accounts: readonly Account[],
  entries: readonly JournalEntry[],
  buckets: readonly StockSeriesBucket[],
): StockSeries {
  const columns = buckets.map((bucket) => ({ ...bucket }));
  const count = columns.length;
  const values: Record<StockSeriesKey, number[]> = {
    assets: blank(count),
    liabilities: blank(count),
    netAssets: blank(count),
    freeFunds: blank(count),
  };
  if (count === 0) return { buckets: columns, values };

  const accountById = new Map(accounts.map((account) => [account.id, account] as const));
  const freeIds = new Set(accounts.filter((account) => isFreeAsset(account)).map((a) => a.id));

  let assets = 0;
  let liabilities = 0;
  let free = 0;
  let boundary = 0;
  /** `beforeDate` より前に締まるバケットへ、いまの残高を焼き付ける。 */
  const snapshotThrough = (beforeDate?: string) => {
    while (boundary < count) {
      const column = columns[boundary];
      if (!column || (beforeDate !== undefined && column.to >= beforeDate)) break;
      values.assets[boundary] = assets;
      values.liabilities[boundary] = debitSignedBalance('liability', liabilities);
      values.netAssets[boundary] = assertSafeAmount(assets - liabilities);
      values.freeFunds[boundary] = free;
      boundary += 1;
    }
  };

  const maximumTo = columns.at(-1)!.to;
  const ordered = [...entries].sort((a, b) => {
    const date = a.date.localeCompare(b.date);
    return date !== 0 ? date : a.id.localeCompare(b.id);
  });
  for (const entry of ordered) {
    if (entry.date > maximumTo) break;
    snapshotThrough(entry.date);
    for (const line of entry.lines) {
      const account = accountById.get(line.accountId);
      if (!account) continue;
      if (account.type !== 'asset' && account.type !== 'liability') continue;
      const delta = naturalDelta(account, line.side, line.amount);
      if (account.type === 'liability') {
        liabilities = assertSafeAmount(liabilities + delta);
        continue;
      }
      assets = assertSafeAmount(assets + delta);
      if (freeIds.has(account.id)) free = assertSafeAmount(free + delta);
    }
  }
  snapshotThrough();

  return { buckets: columns, values };
}
