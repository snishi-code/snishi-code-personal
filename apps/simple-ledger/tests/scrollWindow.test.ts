/*
 * 横スクロールの単一正本（src/ui/scrollWindow.ts）。
 *  - `visibleIndexRange`: いま見えているのは何番目から何番目か。
 *  - `edgeToExtend`: 端に近づいたので窓を伸ばしたいか（v13.6 H2-3 の連続スクロール）。
 *
 * どちらも純粋関数なので、決定性（同じ入力なら同じ答え・境界の扱い）はここで固定する。
 * 3 レンズのどれもこの答えに従うことは ui.timelineContinuousScroll.mutation で見る。
 */
import { describe, expect, it } from 'vitest';
import { edgeToExtend, visibleIndexRange } from '../src/ui/scrollWindow';

describe('visibleIndexRange', () => {
  it('スクロール 0 なら先頭から、枠に入る最後の要素まで', () => {
    expect(visibleIndexRange(0, 300, 100, 10)).toEqual({ first: 0, last: 2 });
  });

  it('半端な位置では両端の切れかけも「見えている」に数える', () => {
    expect(visibleIndexRange(150, 300, 100, 10)).toEqual({ first: 1, last: 4 });
  });

  it('末尾を超えて数えない（要素数でクランプする）', () => {
    expect(visibleIndexRange(9_999, 300, 100, 10)).toEqual({ first: 9, last: 9 });
  });

  it('要素が無い / 幅が 0 なら答えない（呼び出し側が壊れた値で描かないように）', () => {
    expect(visibleIndexRange(0, 300, 100, 0)).toBeUndefined();
    expect(visibleIndexRange(0, 300, 0, 10)).toBeUndefined();
  });
});

describe('edgeToExtend（連続スクロールの端判定）', () => {
  // 枠 400px・内容 2000px = 最大スクロール量 1600px。しきい値 240px。
  const call = (scrollLeft: number) => edgeToExtend(scrollLeft, 400, 2000, 240);

  it('真ん中にいるうちは伸ばさない', () => {
    expect(call(800)).toBeUndefined();
  });

  it('左端に近づいたら過去側へ伸ばす', () => {
    expect(call(0)).toBe('start');
    expect(call(239)).toBe('start');
  });

  it('右端に近づいたら未来側へ伸ばす', () => {
    expect(call(1_600)).toBe('end');
    expect(call(1_361)).toBe('end');
  });

  it('しきい値ちょうどは「近い」に入れる（境界を跨いでから伸ばすと引っかかって見える）', () => {
    expect(call(240)).toBe('start');
    expect(call(1_360)).toBe('end');
    // その 1px 外は伸ばさない。
    expect(call(241)).toBeUndefined();
    expect(call(1_359)).toBeUndefined();
  });

  it('内容が枠に収まっていれば端の概念が無い（ユーザー操作なしに窓を育てない）', () => {
    expect(edgeToExtend(0, 400, 400, 240)).toBeUndefined();
    expect(edgeToExtend(0, 400, 300, 240)).toBeUndefined();
  });

  it('窓が狭くて両端が近いときは近い方・同距離なら未来側（時間は前へ進む）', () => {
    // 最大スクロール 100px。両端ともしきい値の中。
    expect(edgeToExtend(10, 400, 500, 240)).toBe('start');
    expect(edgeToExtend(90, 400, 500, 240)).toBe('end');
    expect(edgeToExtend(50, 400, 500, 240)).toBe('end');
  });

  it('スクロール量が範囲外（ゴムバンド等）でも端として扱う', () => {
    expect(call(-50)).toBe('start');
    expect(call(9_999)).toBe('end');
  });
});
