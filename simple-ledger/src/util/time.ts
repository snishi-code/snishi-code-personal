/** 現在時刻の ISO 文字列。テストで差し替えやすいよう 1 箇所に集約する。 */
export function nowIso(): string {
  return new Date().toISOString();
}

/** 現在のローカル日付 (YYYY-MM-DD)。仕訳の既定日付などに使う。 */
export function todayLocal(): string {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/** ローカルの「今年・今月(1-12)」。 */
export function currentYearMonth(): { year: number; month: number } {
  const d = new Date();
  return { year: d.getFullYear(), month: d.getMonth() + 1 };
}
