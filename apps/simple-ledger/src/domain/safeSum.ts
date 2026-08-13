/*
 * 金額集計の checked sum。1 行の上限は schema（MAX_AMOUNT_MINOR = 10^12 minor）が守るが、
 * 台帳全体の合算が Number の安全整数域（2^53-1）を出ると等値比較（貸借一致・残高 0 判定）が
 * 静かに壊れるため、集計の正本はここを通して fail-closed に検出する（指示書v3 §A-4）。
 * BigInt は採らない（local-first 家計簿の現実域では checked sum で十分）。
 */
import { LedgerError } from './errors';

/** 加算結果が安全整数域を出たら LedgerError（fail-closed）。 */
export function assertSafeAmount(total: number): number {
  if (!Number.isSafeInteger(total)) throw new LedgerError('error.amount.overflow');
  return total;
}

/** 値列の checked 合算。 */
export function sumAmounts(values: Iterable<number>): number {
  let total = 0;
  for (const v of values) total = assertSafeAmount(total + v);
  return total;
}
