/** 金額の表示整形。最小通貨単位の整数を受け取る。 */
export function formatMoney(amount: number, currency = 'JPY'): string {
  try {
    return new Intl.NumberFormat('ja-JP', {
      style: 'currency',
      currency,
      currencyDisplay: 'symbol',
      maximumFractionDigits: 0,
    }).format(amount);
  } catch {
    // 未知の通貨コードでも落とさない。
    return `${amount.toLocaleString('ja-JP')} ${currency}`;
  }
}

/** 符号付きの色分け用: 正なら '+'、負なら '-'（0 は中立）。 */
export function signOf(n: number): 'pos' | 'neg' | 'zero' {
  if (n > 0) return 'pos';
  if (n < 0) return 'neg';
  return 'zero';
}
