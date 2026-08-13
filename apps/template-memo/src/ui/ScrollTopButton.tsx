/*
 * 一番上へ移動する浮動ボタン（simple-ledger の同名部品を移植。実ユーズレビュー 2026-08-13）。
 * 縦スクロールは全画面 document 1 本なので、対象は window のスクロール位置だけ。
 * しきい値未満では要素ごと描画しない（タブ順・支援技術に出ない）。
 * 下部固定バー (.bottomActionBar) が全画面にあるため、CSS 側でその上へ逃がす。
 */
import { useEffect, useState } from 'react';
import { IconButton } from '@snishi/foundation/ui/IconButton';
import { Icon } from '@snishi/foundation/ui/Icon';
import { s } from '../i18n';
import { UI } from '../ui-contract';

/** 出現しきい値（px）。この量を超えて下へスクロールしたら表示する。 */
export const SCROLL_TOP_THRESHOLD_PX = 400;

export function ScrollTopButton() {
  const [visible, setVisible] = useState(() => window.scrollY > SCROLL_TOP_THRESHOLD_PX);

  useEffect(() => {
    const update = () => setVisible(window.scrollY > SCROLL_TOP_THRESHOLD_PX);
    // マウント時にも 1 回読む（画面切替直後など、scroll イベント無しで深い位置にいる場合）。
    update();
    window.addEventListener('scroll', update, { passive: true });
    return () => window.removeEventListener('scroll', update);
  }, []);

  if (!visible) return null;

  const scrollToTop = () => {
    // reduced-motion では動きを足さない。matchMedia が無い環境も auto 側へ倒す。
    const reduce =
      typeof window.matchMedia !== 'function' ||
      window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (typeof window.scrollTo === 'function') {
      window.scrollTo({ top: 0, behavior: reduce ? 'auto' : 'smooth' });
    }
    // ボタン自身は消えるため、フォーカスを本文の起点（#main）へ移す。恒久的な
    // tabindex は付けない（付けると本文タップのたびに main がフォーカスを受け、
    // ModalBase の restoreRef 経由で全ダイアログの復帰先が変わる）。blur で即回収する。
    const main = document.getElementById('main');
    if (main) {
      main.setAttribute('tabindex', '-1');
      main.addEventListener('blur', () => main.removeAttribute('tabindex'), { once: true });
      main.focus({ preventScroll: true });
    }
  };

  return (
    <IconButton
      className="scroll-top"
      label={s.a11y.scrollTop}
      dataUi={UI.home.scrollTop}
      onClick={scrollToTop}
    >
      <Icon name="expand" className="scroll-top__icon" />
    </IconButton>
  );
}
