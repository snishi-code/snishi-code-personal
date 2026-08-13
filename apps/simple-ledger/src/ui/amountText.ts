/*
 * 金額テキスト ⇄ minor 整数（1/100 単位）の唯一の正本。
 * 表示桁数の設定（displayFractionDigits）が入力欄の受け付ける小数桁も決める（作者決定 2026-08-13）。
 * 規約:
 *  - 小数点は '.' のみ。カンマは常に桁区切りとして除去（現行踏襲・ロケール判定はしない）。
 *  - 全角文字（全角数字を含む）は変換せず削除（現行踏襲・controlled input で即座に見える）。
 *  - parse は整数部・小数部を文字列のまま分解する（`Number(text) * 100` の float 経由は禁止:
 *    19.99 * 100 === 1998.9999…）。
 */
import { displayRoundsToZero, type FractionDigits } from '../util/format';

/** 入力文字列を「数字 + 小数点 1 個 + 設定桁までの小数」へ整形する（符号なし）。 */
export function sanitizeAmountText(v: string, digits: FractionDigits, previous = ''): string {
  const cleaned = v.replace(/[^\d.]/g, '');
  const dot = cleaned.indexOf('.');
  // 小数点は**削除ではなく切り捨て**。削除すると小数部が整数部に連結して 100 倍になる
  // （'1,234.56' を貼り付けると 123456 = 1,234.56 のつもりが 123,456）。
  // digits=1|2 の分岐（下）と挙動をそろえる。
  if (digits === 0) {
    if (dot === -1) return cleaned;
    const intPart = cleaned.slice(0, dot);

    /*
     * controlled input で '.' を即座に消すと、逐次入力の次のキーが整数部へ連結される:
     *   12 → 12. → 123 → 1234
     * 貼り付け（previous が末尾 '.' でない複数文字列）は従来どおり整数部だけへ
     * 切り捨てる一方、利用者がいま打った末尾 '.' だけは state に保持する。その後の
     * 小数キーは末尾 '.' のまま無視するため、12.34 が 1234 になる経路を閉じる。
     */
    // 守るべき整数部が無いなら保持もしない。空欄で '.' を打った state を「.」に固定すると、
    // 下の保持分岐が以後の数字キーを全部吸い、欄が入力不能になる（Backspace 以外に回復手段なし）。
    if (intPart === '') return '';
    const previousBody = previous.startsWith('-') ? previous.slice(1) : previous;
    if (previousBody.endsWith('.') && cleaned.startsWith(previousBody)) return previousBody;
    if (cleaned.replace(/\./g, '') === previousBody) {
      // 末尾への逐次入力だけは '.' を保持する。途中への挿入は、既存の整数を
      // 切り落とさず入力した '.' だけを無視する。
      return dot === cleaned.length - 1 ? `${intPart}.` : previousBody;
    }
    return intPart;
  }
  if (dot === -1) return cleaned;
  const intPart = cleaned.slice(0, dot);
  const fracPart = cleaned
    .slice(dot + 1)
    .replace(/\./g, '')
    .slice(0, digits);
  return `${intPart}.${fracPart}`;
}

/** 符号付き variant（先頭に 1 つだけ '-' を許す）。初期残高・補正の実残高用。 */
export function sanitizeSignedAmountText(v: string, digits: FractionDigits, previous = ''): string {
  const negative = v.trimStart().startsWith('-');
  const previousBody = previous.startsWith('-') ? previous.slice(1) : previous;
  const body = sanitizeAmountText(v.replace(/-/g, ''), digits, previousBody);
  return negative ? `-${body}` : body;
}

/**
 * 整形済みテキスト → minor 整数。空・'-'・'.' のみは null。
 * '12.' → 1200、'.5' → 50、'12.3' → 1230（2 桁へゼロ埋め）。
 */
export function parseAmountToMinor(v: string): number | null {
  const negative = v.startsWith('-');
  const body = negative ? v.slice(1) : v;
  if (body === '' || body === '.') return null;
  const dot = body.indexOf('.');
  const intPart = dot === -1 ? body : body.slice(0, dot);
  const fracPart = dot === -1 ? '' : body.slice(dot + 1);
  if (!/^\d*$/.test(intPart) || !/^\d{0,2}$/.test(fracPart)) return null;
  const major = intPart === '' ? 0 : Number.parseInt(intPart, 10);
  const frac = fracPart === '' ? 0 : Number.parseInt(fracPart.padEnd(2, '0'), 10);
  if (!Number.isSafeInteger(major)) return null;
  const minor = major * 100 + frac;
  if (!Number.isSafeInteger(minor)) return null;
  return negative ? -minor : minor;
}

/**
 * minor → 編集フォームの初期値文字列（設定桁で丸めた「画面で見えているもの」と同じ値）。
 * 編集フォームは、この文字列とは別に元の minor を保持し、金額欄が変更された場合だけ
 * parse 結果を保存する。日付・摘要など別の欄だけを直して端数を失ってはいけない。
 */
export function formatMinorForInput(minor: number, digits: FractionDigits): string {
  // 符号は**丸めた後**で決める（表示桁 0 で -0.49 を開くと '-0' という入力不能な値が欄に載る）。
  const sign = minor < 0 && !displayRoundsToZero(minor, digits) ? '-' : '';
  const abs = Math.abs(minor);
  const scale = 10 ** (2 - digits);
  const scaled = Math.round(abs / scale);
  const base = 10 ** digits;
  const major = Math.floor(scaled / base);
  const frac = scaled - major * base;
  if (digits === 0 || frac === 0) return `${sign}${major}`;
  return `${sign}${major}.${String(frac).padStart(digits, '0').replace(/0+$/, '')}`;
}

/**
 * minor を「1 の位まで削らずに」表せる最小の桁数（0 / 1 / 2）。
 *
 * 使い所は**残高ちょうどでなければ保存側が弾く金額**（口座の終了・継続コスト台帳の引き上げ）。
 * 表示桁を 0 にしていても、その欄だけはこの桁で見せて「見えている値 = 保存される値」を保つ。
 * 粗い桁のまま丸めて見せると、保存で error.account.archiveBalance に当たって
 * 画面上は正しく見えるのに保存できない、という行き止まりになる。
 */
export function exactDigitsFor(minor: number): FractionDigits {
  const abs = Math.abs(minor);
  if (abs % 100 === 0) return 0;
  if (abs % 10 === 0) return 1;
  return 2;
}
