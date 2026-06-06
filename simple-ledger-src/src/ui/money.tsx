import type { JSX } from 'react';
import { formatMoney, signOf } from '../util/format';

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
  const prefix = signed && sign === 'pos' ? '+' : '';
  return (
    <span className={cls}>
      {prefix}
      {formatMoney(amount, currency)}
    </span>
  );
}
