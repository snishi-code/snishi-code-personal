/*
 * 3 レンズ共通の**枠**（v13.7 I1・作者確定 2026-08-18）。
 *
 * 時間平面は「左のラベル列 × 上の目盛り行 × 中の描画部」の 3 部構成で、線分 / 数値 / グラフの
 * どのレンズでも枠の振る舞いは同じ:
 *  - **ラベル列は左に貼る**（横に送っても行の名前が消えない）。
 *  - **目盛り行は上に貼る**（縦に送っても年月日が消えない）。
 *  - **左上の隅は両方に貼る**（ラベル列と目盛り行の交点なので、どちらへ送っても残る）。
 *  - **軸ロック**: 描画部を触ったら横だけ・ラベル列を触ったら縦だけ動く（斜めに逃げない）。
 *
 * ここが持つのは「どの要素がどの役割か」を名乗る class と、窓そのもの（スクロールポート）だけ。
 * 見た目・幾何の規則は CSS の `.lens-frame*` に 1 か所で書く（レンズごとに再実装しない）。
 *
 * **なぜ枠が縦にもスクロールするのか**: `position: sticky` の相手は「最も近いスクロール
 * ポート」で、枠は横スクロールのために既にスクロールポートになっている。枠の中で縦が
 * 閉じていない（＝縦は外のページが送る）と、目盛り行の `top` は効きようがない。
 * そのため枠は縦横 2 次元の窓にし、高さを画面の残りで止める（`--lens-frame-height`）。
 */
import type { CSSProperties, ReactNode, RefObject } from 'react';

/**
 * 枠の中の役割。CSS はこの 4 つだけを見る（レンズ名のセレクタで枠の規則を書かない）。
 *  - `viewport`: 窓そのもの（縦横 2 次元のスクロールポート）
 *  - `head`:     上に貼る目盛り行
 *  - `corner`:   左に貼る隅（`head` と併せ持つと左上の隅になる）
 *  - `pane`:     描画部（横だけ動く）
 */
export const LENS_FRAME = {
  viewport: 'lens-frame',
  head: 'lens-frame__head',
  corner: 'lens-frame__corner',
  pane: 'lens-frame__pane',
} as const;

/**
 * 窓（スクロールポート）。3 レンズはこれを共有し、中身（表 / グリッド / SVG）だけを替える。
 * `role="region"` + `tabIndex` はキーボードで横へ送るための足場で、これもレンズ共通。
 */
export function LensFrame({
  viewportRef,
  className,
  label,
  dataUi,
  style,
  onScroll,
  children,
}: {
  viewportRef: RefObject<HTMLDivElement | null>;
  /** レンズ固有の class（中身の幾何。枠の規則は `.lens-frame` が持つ）。 */
  className: string;
  /** 枠が何の窓かを名乗る（読み上げ）。 */
  label: string;
  dataUi: string;
  style?: CSSProperties;
  /** スクロールのたびに窓の要素を渡す（可視範囲の報告・連続スクロールの継ぎ足し）。 */
  onScroll: (viewport: HTMLDivElement) => void;
  children: ReactNode;
}) {
  return (
    <div
      ref={viewportRef}
      className={`${LENS_FRAME.viewport} ${className}`}
      role="region"
      tabIndex={0}
      aria-label={label}
      data-ui={dataUi}
      {...(style ? { style } : {})}
      onScroll={(event) => onScroll(event.currentTarget)}
    >
      {children}
    </div>
  );
}
