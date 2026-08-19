/*
 * 時間平面の横スクロール機構（v13.6 H2-3・作者確定 2026-08-18）。
 *
 * 3 つのレンズ（線分 / 数値 / グラフ）はそれぞれ別の DOM を描くが、横方向の振る舞いは同じ:
 *  1. 窓を送り直したとき（ズーム変更・左右ボタン・年列ドリル）は、中心の日付が見える位置へ置く。
 *  2. スクロールが端に近づいたら窓を伸ばす（= 連続スクロール。左右ボタンは
 *     アクセシビリティのフォールバックとして残る）。
 *  3. 左へ伸びたぶんは `scrollLeft` を足して打ち消す。**見えているものを動かさない**のが
 *     連続スクロールの条件で、これを忘れると窓が伸びるたび画面が右へ飛ぶ。
 *
 * この 3 つをここへ集約し、各レンズは「列の key の並び」と「1 列の幅」を渡すだけにする。
 * 左への伸びは px の差分ではなく**前回の先頭 key が何番目へ動いたか**で測る（列の幅は
 * ズームで変わるが、key は窓を伸ばしても不変。丸め誤差も溜まらない）。
 *
 * 端の判定そのものは `scrollWindow.ts` の純粋関数 `edgeToExtend` が正本。
 */
import { useCallback, useLayoutEffect, useRef, type RefObject } from 'react';
import { edgeToExtend, type ScrollEdge } from './scrollWindow';

/**
 * 端から何 px 以内に入ったら窓を伸ばすか。実機幅（375px）の 2/3 ほど = 指を 1 回滑らせた
 * 先で継ぎ足しが済んでいる距離。小さすぎると端に触れてから伸びて「引っかかり」に見え、
 * 大きすぎると開いた直後から伸び続ける。
 */
export const EXTEND_THRESHOLD_PX = 240;

export interface HorizonScrollOptions {
  /** 横スクロールする枠。 */
  viewportRef: RefObject<HTMLDivElement | null>;
  /** 並んでいる列（バケット / 表の列）の key。窓を伸ばしても既存の key は変わらないこと。 */
  keys: readonly string[];
  /** 1 列の幅（px）。 */
  itemWidth: number;
  /**
   * 窓の同一性。**伸ばしただけでは変えない**（変えると中央へ戻ってしまう）。
   * ズーム変更・左右ボタン・ドリルのように「送り直した」ときだけ変える。
   */
  windowKey: string;
  /** windowKey が変わったときに置くスクロール量（px）を返す。 */
  focusScrollLeft: (viewport: HTMLDivElement) => number;
  /** スクロール後・レイアウト後に呼ぶ（可視範囲の報告など）。 */
  onSettle?: (viewport: HTMLDivElement) => void;
  /** 端に近づいた = 窓を伸ばしたい。伸ばせない（上限・下限）ときは何もしなくてよい。 */
  onExtend?: (edge: ScrollEdge) => void;
}

/**
 * @returns スクロールのたびに呼ぶハンドラ（`onScroll` から枠の要素を渡す）。
 */
export function useHorizonScroll({
  viewportRef,
  keys,
  itemWidth,
  windowKey,
  focusScrollLeft,
  onSettle,
  onExtend,
}: HorizonScrollOptions): (viewport: HTMLDivElement) => void {
  // 効果 / ハンドラの中から呼ぶだけのものは ref に latch する（呼び出し元が毎 render
  // 新しい関数を渡しても、中央寄せや補正が余計に走らないようにする）。
  // 差し替えは commit 後に行う（render 中に ref を書かない）。この効果を**本体より先に
  // 宣言している**ので必ず先に走る = 本体は常に最新の関数を読む。
  const focusRef = useRef(focusScrollLeft);
  const settleRef = useRef(onSettle);
  const extendRef = useRef(onExtend);
  useLayoutEffect(() => {
    focusRef.current = focusScrollLeft;
    settleRef.current = onSettle;
    extendRef.current = onExtend;
  });

  /** 直前の render で先頭にあった列の key（左への伸び縮みを測る基準）。 */
  const firstKeyRef = useRef<string | undefined>(undefined);
  /** 中央寄せを済ませた窓。null = まだ一度も置いていない（初回マウント）。 */
  const placedWindowRef = useRef<string | null>(null);

  useLayoutEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    const first = keys[0];

    if (placedWindowRef.current !== windowKey) {
      // 送り直し = 中心へ置く。ここだけがスクロール位置を「決め打ち」してよい場所。
      placedWindowRef.current = windowKey;
      viewport.scrollLeft = focusRef.current(viewport);
    } else if (first !== undefined && firstKeyRef.current !== undefined) {
      // 同じ窓のまま先頭が変わった = 左へ伸びた（または縮んだ）。
      // 旧先頭の新しい添字ぶんだけ scrollLeft を足すと、見えている列がその場に留まる。
      const shift = keys.indexOf(firstKeyRef.current);
      if (shift > 0) viewport.scrollLeft = viewport.scrollLeft + shift * itemWidth;
    }

    firstKeyRef.current = first;
    settleRef.current?.(viewport);
    // keys / itemWidth / windowKey が変わった render の直後だけ走ればよい
    // （行の開閉など横方向に関係のない再描画でスクロール位置を触らない）。
  }, [itemWidth, keys, viewportRef, windowKey]);

  return useCallback((viewport: HTMLDivElement) => {
    settleRef.current?.(viewport);
    const edge = edgeToExtend(
      viewport.scrollLeft,
      viewport.clientWidth,
      viewport.scrollWidth,
      EXTEND_THRESHOLD_PX,
    );
    if (edge !== undefined) extendRef.current?.(edge);
  }, []);
}
