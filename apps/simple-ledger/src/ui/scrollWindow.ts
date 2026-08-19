/*
 * 横スクロールの可視範囲（添字）と、端に近づいたかの判定。
 *
 * 時間平面の 3 つのレンズ（線分 = バケット帯 / 数値 = 表の列 / グラフ = 折れ線）が
 * 「いま見えているのはどこか」「そろそろ窓を伸ばすべきか」を同じ規則で出すための単一正本。
 * どちらも**純粋関数**（DOM も React も知らない）ので、決定性はここで固定できる。
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

/** 窓を伸ばしたい側。`start` = 過去（左） / `end` = 未来（右）。 */
export type ScrollEdge = 'start' | 'end';

/**
 * 「もう端が近い = 窓を伸ばしたい」の判定（v13.6 H2-3 の連続スクロール）。
 *
 * スクロール座標だけで決める（ラベル列の固定幅を渡さなくてよい）。ラベル列は枠の中に
 * sticky で乗っているので `scrollWidth` にも `clientWidth` にも同じだけ含まれ、
 * 最大スクロール量 `scrollWidth - clientWidth` からは相殺されて消える。
 *
 * 決定則:
 *  - そもそもスクロールできない（内容が枠に収まっている）なら端の概念が無い → `undefined`。
 *    伸ばすかどうかは左右ボタンの仕事にする（ユーザーの操作なしに窓を育てない）。
 *  - どちらの端からも `threshold` より遠ければ `undefined`。
 *  - 両端が近い（窓が狭い）ときは**近い方**。同距離なら `end`（時間は前へ進む側を既定にする）。
 *
 * @param scrollLeft  現在のスクロール量（px）
 * @param clientWidth 枠の見えている幅（px）
 * @param scrollWidth 枠の内容全体の幅（px）
 * @param threshold   端から何 px 以内に入ったら伸ばすか（px・0 以上）
 */
export function edgeToExtend(
  scrollLeft: number,
  clientWidth: number,
  scrollWidth: number,
  threshold: number,
): ScrollEdge | undefined {
  const maxScroll = scrollWidth - clientWidth;
  if (maxScroll <= 0) return undefined;
  const margin = Math.max(0, threshold);
  const toStart = Math.max(0, Math.min(maxScroll, scrollLeft));
  const toEnd = maxScroll - toStart;
  if (toStart > margin && toEnd > margin) return undefined;
  return toEnd <= toStart ? 'end' : 'start';
}
