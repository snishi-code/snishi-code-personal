/*
 * 一覧の検索・並び替えの共通規約（純関数）。仕訳一覧と「月割り台帳」が同じものを使う。
 * 比較器・検索対象フィールドは対象の型ごとに違うため呼び出し側が渡す（ここは規約だけ）。
 * 置き場所は src/ui（安定後に foundation 昇格を検討する既存方針）。
 */

/**
 * Journal の検索と同一の正規化: クエリを trim + toLowerCase し、対象文字列群を
 * 空白連結した 1 本に対する部分一致。空クエリは常に一致（絞り込まない）。
 * NFKC・かな正規化は行わない（挙動を変えない。全角/半角ゆれの吸収は別課題）。
 */
export function matchesQuery(parts: (string | undefined)[], query: string): boolean {
  const q = query.trim().toLowerCase();
  if (q === '') return true;
  const hay = parts
    .filter((part): part is string => part !== undefined)
    .join(' ')
    .toLowerCase();
  return hay.includes(q);
}

/** 並び替えの方向。両画面で同じ語彙（軸は画面ごとに違うが方向は共通）。 */
export type SortDirection = 'asc' | 'desc';

/**
 * 昇順 = +1 / 降順 = -1。昇順で書いた比較器の結果に掛けて方向を与える（両画面で同じ規約）。
 * 「未設定は常に最後」のような方向に依らない規則は、掛ける前に決着させる。
 */
export function directionSign(direction: SortDirection): 1 | -1 {
  return direction === 'asc' ? 1 : -1;
}

/**
 * 表示専用の並び替え。compare === null（既定の並び）は入力配列をそのまま返す
 * ＝既定順を 1 バイトも変えない（Journal の早期リターンと同じ規約）。
 * それ以外は安定ソート。入力が基準順に並んでいれば、同値の相対順は必ず基準順を保つ。
 * 破壊的 sort をしない（呼び出し側の配列を変更しない）。
 */
export function applySort<T>(rows: T[], compare: ((a: T, b: T) => number) | null): T[] {
  if (compare === null) return rows;
  return [...rows].sort(compare);
}
