/*
 * テスト専用ユーティリティ（配信コードに含めない）。
 * jsdom が実装していない API の最小 shim をここに置く。
 * vitest の setupFiles ではなく各テストファイルで必要時に import する。
 */

/**
 * jsdom 29 は <dialog>.showModal() / .close() を実装しているが、
 * ::backdrop や top-layer 機能は持たない。
 * showModal が存在しない環境向けのフォールバック shim。
 * （通常 jsdom 29 では不要だが、古い環境への保険として用意する）
 */
export function patchDialogIfNeeded(): void {
  if (
    typeof HTMLDialogElement !== 'undefined' &&
    typeof HTMLDialogElement.prototype.showModal === 'function'
  ) {
    return; // 実装済みなので不要
  }
  // 最小 shim: open 属性を管理するだけ
  Object.defineProperty(HTMLElement.prototype, 'showModal', {
    value(this: HTMLElement) {
      this.setAttribute('open', '');
    },
    writable: true,
    configurable: true,
  });
  Object.defineProperty(HTMLElement.prototype, 'close', {
    value(this: HTMLElement) {
      this.removeAttribute('open');
      this.dispatchEvent(new Event('close'));
    },
    writable: true,
    configurable: true,
  });
}
