/*
 * 一番上へ移動する浮動ボタン（実ユーズレビュー 2026-08-12 ③）。
 * 縦スクロールは全画面 document 1 本（内側コンテナは横方向のみ）なので、対象は window の
 * スクロール位置だけ。しきい値未満では要素ごと描画しない（タブ順・支援技術に出ない）。
 * 各画面が </section> の直前に 1 行置く。下部バーのある画面は自画面のルートに
 * --scroll-top-bottom を定義して逃がす（fixed でもカスタムプロパティは DOM 祖先から継承される）。
 * トーストと下端が重なる間はトーストが前面（--z-toast 60 > --z-float 30）で、ボタンの
 * 上半分が最長 6 秒タップしづらくなるが、一時通知を隠さないことを優先する（意図的な決定）。
 */
import { useEffect, useState } from 'react';
import { IconButton } from '@snishi/foundation/ui/IconButton';
import { Icon } from '@snishi/foundation/ui/Icon';
import { t } from '../i18n';

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
    <IconButton className="scroll-top" label={t('a11y.scrollTop')} onClick={scrollToTop}>
      <Icon name="expand" className="scroll-top__icon" />
    </IconButton>
  );
}
