import type { JSX } from 'react';
import { formatMoney, signOf } from '../util/format';

/**
 * Money が描くのと同じ文字列。aria-label など「テキストが要る場所」の正本。
 * 見える表示と読み上げが食い違わないよう、Money 自身もこれを使う。
 */
export function moneyText(amount: number, currency: string, signed = false): string {
  const prefix = signed && signOf(amount) === 'pos' ? '+' : '';
  return `${prefix}${formatMoney(amount, currency)}`;
}

/** 金額表示。signed=true で増減を色 + 記号で示す（色のみに依存しない）。 */
export function Money({
  amount,
  currency,
  signed = false,
}: {
  amount: number;
  currency: string;
  signed?: boolean;
}): JSX.Element {
  const sign = signOf(amount);
  const cls = signed ? (sign === 'pos' ? 'amount--pos' : sign === 'neg' ? 'amount--neg' : '') : '';
  return <span className={cls}>{moneyText(amount, currency, signed)}</span>;
}
