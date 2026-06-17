/*
 * フォーカスヘルパー（popup-behavior.js の方針）。
 *
 * 方針: ポップアップを「開いただけ」では input/textarea へ focus しない。
 * ユーザーが入力欄（または add/rename 等）を明示タップしたときだけ focus する。
 * これにより「開いただけでキーボードが飛び出す」ことを防ぐ。
 *
 * 使い方:
 *   // 明示アクション（「＋追加」ボタンクリック後など）の単一入力フォーカス
 *   focusPopupInput(inputRef.current);
 *   // data-autofocus 属性を持つ要素へ解決する（複数入力中の先頭フォーカス）
 *   focusPopupInput(containerEl);
 */

/** DOM に反映される前のフォーカスを次フレームに defer する小ヘルパ。 */
function deferFocus(el: Element | null | undefined, select: boolean): void {
  if (!el || typeof (el as HTMLElement).focus !== 'function') return;
  setTimeout(() => {
    try {
      (el as HTMLElement).focus();
      if (select && typeof (el as HTMLInputElement).select === 'function') {
        (el as HTMLInputElement).select();
      }
    } catch {
      // 失われた DOM 等は無視
    }
  }, 0);
}

/**
 * コンテナまたは要素からフォーカス対象を解決する。
 * 優先順: 明示指定 > [data-autofocus] > input/textarea/select の最初の要素。
 */
function resolveFocusTarget(
  elOrContainer: Element | null | undefined,
  target?: Element | null,
): Element | null {
  if (target instanceof Element) return target;
  if (!elOrContainer) return null;
  return (
    elOrContainer.querySelector('[data-autofocus]') ??
    elOrContainer.querySelector('input, textarea, select')
  );
}

/**
 * 明示操作（「＋追加」「リネーム」クリック等）時の単一入力フォーカス。
 * 要素が `input`/`textarea`/`select` でなく、[data-autofocus] も無い場合は
 * 内部の最初の入力欄へ解決する。
 * opts.select=true で全選択（既存値の上書き向け）。
 */
export function focusPopupInput(
  el: Element | null | undefined,
  opts: { target?: Element | null; select?: boolean } = {},
): void {
  const resolved =
    el instanceof HTMLInputElement ||
    el instanceof HTMLTextAreaElement ||
    el instanceof HTMLSelectElement
      ? el
      : resolveFocusTarget(el, opts.target);
  deferFocus(resolved, opts.select === true);
}
