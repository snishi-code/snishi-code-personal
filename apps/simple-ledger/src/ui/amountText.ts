/*
 * 符号付き金額テキスト入力の共通処理。
 * 立替金のような「マイナスにもなる残高」を初期残高・補正の実残高として入力できるようにする
 * （マイナスの資産 = 相手に払うべき状態。仕訳の明細金額は常に正で、符号は貸借の向きで表す）。
 */

/** 入力文字列を「先頭に 1 つだけ '-' を許す数字列」へ整形する。 */
export function sanitizeSignedAmountText(v: string): string {
  const cleaned = v.replace(/[^\d-]/g, '');
  const negative = cleaned.startsWith('-');
  const digits = cleaned.replace(/-/g, '');
  return negative ? `-${digits}` : digits;
}

/** 整形済みテキストを整数へ。空・'-' のみは null。 */
export function parseSignedAmountText(v: string): number | null {
  if (v === '' || v === '-') return null;
  const n = Number.parseInt(v, 10);
  return Number.isInteger(n) ? n : null;
}
