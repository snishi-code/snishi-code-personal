/*
 * 金額の表示整形。保存値は「1/100 単位の整数」（minor）。
 * 通貨はただの単位文字列（後置固定・ISO 4217 に依存しない・換算しない）。
 * 表示桁数は台帳設定 displayFractionDigits（0|1|2）に従い、設定桁より細かい端数は
 * 表示上のみ四捨五入する（Excel の表示形式と同じ。保存値は不変）。
 */

export type FractionDigits = 0 | 1 | 2;

/**
 * minor → 数値文字列（単位なし）。
 * `minor / 100` を Intl へ渡さず、整数の商と剰余から組み立てる（安全整数域の外＝
 * import 由来の異常値でも桁が壊れないための安全側実装）。`Math.abs` の前置は必須
 * （`Math.trunc(-50 / 100) === -0` → Intl が "-0" を返すため）。
 */
export function formatAmount(minorAmount: number, fractionDigits: FractionDigits): string {
  const sign = minorAmount < 0 ? '-' : '';
  const abs = Math.abs(minorAmount);
  // 表示桁への丸め（half away from zero）。x.5 は二進で正確に表現されるため誤丸めしない。
  const scale = 10 ** (2 - fractionDigits);
  const scaled = Math.round(abs / scale);
  const base = 10 ** fractionDigits;
  const major = Math.floor(scaled / base);
  const frac = scaled - major * base;
  const majorText = major.toLocaleString('ja-JP');
  const fracText = fractionDigits === 0 ? '' : `.${String(frac).padStart(fractionDigits, '0')}`;
  return `${sign}${majorText}${fracText}`;
}

/** minor + 単位文字列 → 表示（例 '1,234.50 円'）。単位が空文字なら数値のみ。 */
export function formatMoney(
  minorAmount: number,
  currency: string,
  fractionDigits: FractionDigits,
): string {
  const num = formatAmount(minorAmount, fractionDigits);
  return currency === '' ? num : `${num} ${currency}`;
}

/** 符号付きの色分け用: 正なら '+'、負なら '-'（0 は中立）。 */
export function signOf(n: number): 'pos' | 'neg' | 'zero' {
  if (n > 0) return 'pos';
  if (n < 0) return 'neg';
  return 'zero';
}
