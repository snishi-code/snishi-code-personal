/**
 * ISO 形式の日付・年月が実在する暦値かを検証する。
 * Date によるタイムゾーン依存の正規化を避け、決定的に判定する。
 */
function isValidCalendarValue(value: string, withDay: boolean): boolean {
  const match = withDay ? /^(\d{4})-(\d{2})-(\d{2})$/.exec(value) : /^(\d{4})-(\d{2})$/.exec(value);
  if (!match) return false;
  const year = Number.parseInt(match[1] ?? '', 10);
  const month = Number.parseInt(match[2] ?? '', 10);
  if (month < 1 || month > 12) return false;
  if (!withDay) return true;
  const day = Number.parseInt(match[3] ?? '', 10);
  const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1] ?? 0;
  return day >= 1 && day <= days;
}

export function isValidIsoDate(value: string): boolean {
  return isValidCalendarValue(value, true);
}

export function isValidIsoMonth(value: string): boolean {
  return isValidCalendarValue(value, false);
}

/**
 * 台帳が受け付ける日付の上限（= 導出地平 `CONTINUOUS_COST_HARD_CAP` と同じ端点）。
 * 遠未来の日付（例: 9999-12-31 の補正 pin）が 1 つあるだけで月次展開が数万月ぶん走るため、
 * 導出側で clamp するのではなく**入口（UI / repository / schema / import）で一律拒否する**
 * （clamp は pin の残高保証を壊す。v13.8 監査 E）。
 */
export const MAX_LEDGER_DATE = '2100-12-31';

/** 台帳に保存できる日付か（暦として正しく、かつ上限以内）。ライブ導出の入口ガードにも使う。 */
export function isLedgerDate(value: string): boolean {
  return isValidIsoDate(value) && value <= MAX_LEDGER_DATE;
}
