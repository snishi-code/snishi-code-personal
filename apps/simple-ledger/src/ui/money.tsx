import type { JSX } from 'react';
import { useOptionalLedger } from '../state/store';
import { formatMoney, signOf, type FractionDigits } from '../util/format';

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
  const prefix = signed && signOf(amount) === 'pos' ? '+' : '';
  return `${prefix}${formatMoney(amount, currency, digits)}`;
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
  const digits = useMoneyDigits();
  const sign = signOf(amount);
  const cls = signed ? (sign === 'pos' ? 'amount--pos' : sign === 'neg' ? 'amount--neg' : '') : '';
  return <span className={cls}>{moneyText(amount, currency, digits, signed)}</span>;
}
