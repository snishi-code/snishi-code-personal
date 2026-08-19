import type { JSX } from 'react';
import { useOptionalLedger } from '../state/store';
import { displayRoundsToZero, formatMoney, signOf, type FractionDigits } from '../util/format';

/** 台帳設定の表示桁数（Provider 外では使わない。全画面は LedgerProvider 配下で描画される）。 */
export function useMoneyDigits(): FractionDigits {
  const ledger = useOptionalLedger()?.ledger;
  return ledger?.settings.displayFractionDigits ?? 0;
}

/**
 * Money が描くのと同じ文字列。aria-label など「テキストが要る場所」の正本。
 * 見える表示と読み上げが食い違わないよう、Money 自身もこれを使う。
 */
export function moneyText(
  amount: number,
  currency: string,
  digits: FractionDigits,
  signed = false,
): string {
  // 丸めた結果が 0 なら符号を付けない（'+0' / '-0' を出さない）。
  const prefix =
    signed && signOf(amount) === 'pos' && !displayRoundsToZero(amount, digits) ? '+' : '';
  return `${prefix}${formatMoney(amount, currency, digits)}`;
}

/**
 * 金額の色の軸（C-2）。`signed` の増減色（--pos/--neg）とは別で、こちらは
 * **残高の性質**だけを言う 1 軸。振替（投資積立など）には足さない（作者合意）。
 */
export type MoneyTone = 'liability';

/**
 * 金額表示。signed=true で増減を色 + 記号で示す（色のみに依存しない）。
 * tone='liability' は負債残高の数字色。表示は絶対値のままでマイナス記号は付けない
 * （どの箱・どのセクションの数字かというラベルが色以外の手がかりになる）。
 * signed と tone は同時に使わない（増減の向きと残高の性質を 1 つの文字列へ重ねない）。
 */
export function Money({
  amount,
  currency,
  signed = false,
  tone,
}: {
  amount: number;
  currency: string;
  signed?: boolean;
  tone?: MoneyTone;
}): JSX.Element {
  const digits = useMoneyDigits();
  // 表示が 0 に丸まる額は色も中立にする（見た目と文字列を一致させる）。
  const sign = displayRoundsToZero(amount, digits) ? 'zero' : signOf(amount);
  const signedCls = sign === 'pos' ? 'amount--pos' : sign === 'neg' ? 'amount--neg' : '';
  const cls = signed ? signedCls : tone === 'liability' ? 'amount--liability' : '';
  return <span className={cls}>{moneyText(amount, currency, digits, signed)}</span>;
}
