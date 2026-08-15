/*
 * カードタップ = 編集（2026-08-15 作者合意）の単一正本。
 *
 * 一覧の 1 件（仕訳・くり返し記帳のルール・継続コスト item・勘定科目）は「カード/行そのものを
 * 押す = その 1 件の編集シートが開く」に統一し、行の編集アイコンは置かない。
 *
 * カード/行の中にはアーカイブ・削除・スキップ・終了・再開・補正といった別の操作ボタンが残る。
 * そのためタップ対象そのものを <button> にはできない（button の入れ子は不正）ので、
 * role="button" + tabIndex + Enter/Space でボタン相当にする。中の操作ボタンは
 * rowActionClick で包み、押した操作だけが起きる（カードタップ = 編集へ伝播させない）。
 *
 * タップとスクロールの区別はブラウザ任せ（click はスクロールジェスチャでは発火しない）。
 * 押下時間の独自制御は持たない。
 */
import type { KeyboardEvent, MouseEvent } from 'react';

export interface CardTapProps {
  role: 'button';
  tabIndex: 0;
  'aria-label': string;
  onClick: () => void;
  onKeyDown: (event: KeyboardEvent<HTMLElement>) => void;
}

/**
 * カード/行そのものをタップ = 編集にする props。
 * label は撤去した編集アイコンが持っていたアクセシブル名（「編集: 名前」）をそのまま移す。
 */
export function cardTapProps(label: string, open: () => void): CardTapProps {
  return {
    role: 'button',
    tabIndex: 0,
    'aria-label': label,
    onClick: open,
    onKeyDown: (event) => {
      // カード内の操作ボタンにフォーカスしたままの Enter/Space はそのボタンの操作
      // （キーボードでもカードタップへ二重に効かせない。クリック側は rowActionClick が担う）。
      if (event.target !== event.currentTarget) return;
      if (event.key !== 'Enter' && event.key !== ' ') return;
      event.preventDefault();
      open();
    },
  };
}

/** カード内に残る操作ボタンの onClick。押した操作だけを起こし、カードタップ（編集）は開かせない。 */
export function rowActionClick(run: () => void): (event: MouseEvent<HTMLElement>) => void {
  return (event) => {
    event.stopPropagation();
    run();
  };
}
