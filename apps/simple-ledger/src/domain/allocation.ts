/* 月単位の計算で共有する純粋関数。 */

/** total を months で割り、端数を先頭月から 1 ずつ配って合計を total に一致させる。 */
export function monthlyAmounts(total: number, months: number): number[] {
  const base = Math.floor(total / months);
  const remainder = total - base * months;
  return Array.from({ length: months }, (_, i) => base + (i < remainder ? 1 : 0));
}

/** ISO 日付 'YYYY-MM-DD' → 'YYYY-MM'。 */
export function monthOf(isoDate: string): string {
  return isoDate.slice(0, 7);
}

/** 'YYYY-MM' に n か月を加える。 */
export function addMonths(ym: string, n: number): string {
  const [y, m] = ym.split('-').map(Number);
  const total = (y ?? 0) * 12 + ((m ?? 1) - 1) + n;
  const ny = Math.floor(total / 12);
  const nm = (total % 12) + 1;
  return `${ny}-${String(nm).padStart(2, '0')}`;
}

function daysInMonth(year: number, month1to12: number): number {
  const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
  return [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month1to12 - 1] ?? 30;
}

/** ISO 日付 'YYYY-MM-DD' に n か月加える（末日は月末へクランプ）。Date を使わず決定的に計算する。 */
export function addMonthsToDate(iso: string, n: number): string {
  const [y, m, d] = iso.split('-').map(Number);
  const total = (y ?? 0) * 12 + ((m ?? 1) - 1) + n;
  const ny = Math.floor(total / 12);
  const nm = (total % 12) + 1;
  const day = Math.min(d ?? 1, daysInMonth(ny, nm));
  return `${ny}-${String(nm).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/** toYm - fromYm（月数）。 */
export function monthsBetween(fromYm: string, toYm: string): number {
  const [fy, fm] = fromYm.split('-').map(Number);
  const [ty, tm] = toYm.split('-').map(Number);
  return (ty ?? 0) * 12 + ((tm ?? 1) - 1) - ((fy ?? 0) * 12 + ((fm ?? 1) - 1));
}
