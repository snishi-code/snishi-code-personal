/*
 * 横スクロールの可視範囲（添字）。
 *
 * 時間平面の 2 つのレンズ（線分 = バケット帯 / 数値 = 表の列）が「いま見えているのはどこか」を
 * 同じ規則で出すための単一正本。等幅の並びに対して、スクロール位置から先頭・末尾の添字を返す。
 */
export interface VisibleIndexRange {
  first: number;
  last: number;
}

/**
 * @param scrollLeft スクロール量（px）
 * @param trackWidth ラベル列を除いた実際に見えている幅（px・負なら 0 として扱う）
 * @param itemWidth  1 要素の幅（px）
 * @param count      要素数
 */
export function visibleIndexRange(
  scrollLeft: number,
  trackWidth: number,
  itemWidth: number,
  count: number,
): VisibleIndexRange | undefined {
  if (count <= 0 || itemWidth <= 0) return undefined;
  const width = Math.max(0, trackWidth);
  const first = Math.max(0, Math.min(count - 1, Math.floor(scrollLeft / itemWidth)));
  const last = Math.max(
    first,
    Math.min(count - 1, Math.ceil((scrollLeft + width) / itemWidth) - 1),
  );
  return { first, last };
}
