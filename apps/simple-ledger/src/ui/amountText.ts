/*
 * 金額テキスト ⇄ minor 整数（1/100 単位）の唯一の正本。
 * 表示桁数の設定（displayFractionDigits）が入力欄の受け付ける小数桁も決める（作者決定 2026-08-13）。
 * 規約:
 *  - 小数点は '.' のみ。カンマは常に桁区切りとして除去（現行踏襲・ロケール判定はしない）。
 *  - 全角文字（全角数字を含む）は変換せず削除（現行踏襲・controlled input で即座に見える）。
 *  - parse は整数部・小数部を文字列のまま分解する（`Number(text) * 100` の float 経由は禁止:
 *    19.99 * 100 === 1998.9999…）。
 */
import type { FractionDigits } from '../util/format';

/** 入力文字列を「数字 + 小数点 1 個 + 設定桁までの小数」へ整形する（符号なし）。 */
export function sanitizeAmountText(v: string, digits: FractionDigits): string {
  const cleaned = v.replace(/[^\d.]/g, '');
  if (digits === 0) return cleaned.replace(/\./g, '');
  const dot = cleaned.indexOf('.');
  if (dot === -1) return cleaned;
  const intPart = cleaned.slice(0, dot);
  const fracPart = cleaned
    .slice(dot + 1)
    .replace(/\./g, '')
    .slice(0, digits);
  return `${intPart}.${fracPart}`;
}

/** 符号付き variant（先頭に 1 つだけ '-' を許す）。初期残高・補正の実残高用。 */
export function sanitizeSignedAmountText(v: string, digits: FractionDigits): string {
  const negative = v.trimStart().startsWith('-');
  const body = sanitizeAmountText(v.replace(/-/g, ''), digits);
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
 * 保存精度より粗い設定で開いて保存し直すと、その明示操作で丸めた値が保存される
 * （作者決定 2026-08-13:「途中で表示桁を変えたら消えるが、ユーザー責任・補正で吸収できる」）。
 */
export function formatMinorForInput(minor: number, digits: FractionDigits): string {
  const sign = minor < 0 ? '-' : '';
  const abs = Math.abs(minor);
  const scale = 10 ** (2 - digits);
  const scaled = Math.round(abs / scale);
  const base = 10 ** digits;
  const major = Math.floor(scaled / base);
  const frac = scaled - major * base;
  if (digits === 0 || frac === 0) return `${sign}${major}`;
  return `${sign}${major}.${String(frac).padStart(digits, '0').replace(/0+$/, '')}`;
}
