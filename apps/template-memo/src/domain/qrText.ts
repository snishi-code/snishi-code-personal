/*
 * QR テキスト（清書の転記用・常に平文）の改行正規化とページ分割。
 *
 * 系譜: medical 側 hospital-workspace/rounds/ui/qrText.ts の実運用実装を移植し、
 * 改行モードを設定値（NewlineMode: crlf / lf）として選べるよう一般化した。
 * ページ番号はペイロードに埋め込まない（貼り付けた本文に混ざらないように）。
 */

import { utf8ByteLength } from '@snishi/foundation/qr/protocol';
import { QR_MAX_BYTES } from '../data/constants';
import type { NewlineMode } from './types';

// エラー文言定数（正本）。投げ元のここが正本で、UI 側も同じ定数を表示する
// （エラー文言は i18n カタログに入れない方針・移植元 qrText.ts と同型）。
export const QR_CHAR_TOO_LONG_MSG = '分割してもQRに入りません（1文字でも不可）';

/**
 * 改行の正規化。
 *  - 'crlf': Windows 系の編集欄には LF 単独を改行として描画しない部品があるため、
 *    \r\n・\r 単独・U+2028/U+2029 を一旦 \n へ潰してから全 \n を \r\n に統一する（既定）。
 *  - 'lf': 同じ揺れ（\r\n・\r 単独・U+2028/U+2029）を \n へ正規化し、CRLF 化はしない。
 */
export function normalizeNewlines(text: string, mode: NewlineMode): string {
  const lf = String(text ?? '')
    .replace(/\r\n/g, '\n')
    .replace(/[\r\u2028\u2029]/g, '\n');
  return mode === 'crlf' ? lf.replace(/\n/g, '\r\n') : lf;
}

/**
 * 正規化後の本文を QR_MAX_BYTES（UTF-8）以下のページ列へ分割する。
 * 各ページの収まり位置は code point 単位の二分探索で求める（サロゲートペアを割らない）。
 * 1 文字も入らない場合は Error(QR_CHAR_TOO_LONG_MSG) を投げる。
 */
export function buildQrPages(raw: string, mode: NewlineMode): string[] {
  const text = normalizeNewlines(raw, mode);
  if (utf8ByteLength(text) <= QR_MAX_BYTES) return [text];

  const cps = Array.from(text); // サロゲートペアを割らない
  const pages: string[] = [];
  let pos = 0;
  while (pos < cps.length) {
    let lo = pos + 1;
    let hi = cps.length;
    let best = -1;
    while (lo <= hi) {
      const mid = Math.floor((lo + hi) / 2);
      const chunk = cps.slice(pos, mid).join('');
      if (utf8ByteLength(chunk) > QR_MAX_BYTES) {
        hi = mid - 1;
      } else {
        best = mid;
        lo = mid + 1;
      }
    }
    // CRLF ペアをページ境界で割らない（前ページ末 \r + 次ページ頭 \n は貼り付け先で
    // 二重改行になり得る）。lf モードでは正規化後に \r が残らないため実質 no-op。
    if (best > pos + 1 && cps[best - 1] === '\r' && cps[best] === '\n') best -= 1;
    if (best <= pos) throw new Error(QR_CHAR_TOO_LONG_MSG);
    pages.push(cps.slice(pos, best).join(''));
    pos = best;
  }
  return pages;
}
