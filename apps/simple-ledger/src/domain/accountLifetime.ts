/*
 * 勘定科目の存在期間（時間軸上の線分）の単一正本。
 *
 * start/end は両端を含む。startDate 未設定時は createdAt の日付部分を表示・新規保存の
 * 既定に使う。参照期間の収集は import schema と repository の保存境界で共有する。
 */
import { CONTINUOUS_COST_LEDGER_ACCOUNT_ID } from './constants';
import { isValidIsoDate } from './calendar';
import type {
  Account,
  CashflowSchedule,
  JournalEntry,
  MonthlyCostItem,
  RecurringRule,
} from './types';

export interface AccountLifetimeCollections {
  entries: readonly JournalEntry[];
  schedules: readonly CashflowSchedule[];
  monthlyCostItems: readonly MonthlyCostItem[];
  recurringRules: readonly RecurringRule[];
}

export type AccountReferenceKind = 'entry' | 'schedule' | 'monthlyCost' | 'recurringRule';

export interface AccountReferenceInterval {
  kind: AccountReferenceKind;
  /** 参照が始まる日（含む）。 */
  from: string;
  /** 参照が終わる日（含む）。未設定は将来へ継続。 */
  to?: string;
}

export interface AccountLifetimeViolation {
  edge: 'start' | 'end';
  reference: AccountReferenceInterval;
}

function ruleFirstDate(startMonth: string, dayOfMonth: number): string {
  const [year, month] = startMonth.split('-').map(Number);
  const lastDay = new Date(year ?? 0, month ?? 0, 0).getDate();
  return `${startMonth}-${String(Math.min(dayOfMonth, lastDay)).padStart(2, '0')}`;
}

function monthIndex(month: string): number {
  const [year, value] = month.split('-').map(Number);
  return (year ?? 0) * 12 + ((value ?? 1) - 1);
}

function monthFromIndex(index: number): string {
  const year = Math.floor(index / 12);
  const month = (index % 12) + 1;
  return `${year}-${String(month).padStart(2, '0')}`;
}

/**
 * カーソルと既存itemの被覆より後に、周期位相が一致する最初の未起票日。
 *
 * ルールの startMonth は位相の基準であって、起票済みの過去まで現在の参照科目へ要求する
 * 境界ではない。費用ルールは既存itemの期間中も新しいitemを作らないため、その被覆後を使う。
 * 終了日なしのitemがある場合は以後をすべて覆うので、次回参照自体が存在しない。
 */
export function recurringRuleReferenceStartDate(
  rule: RecurringRule,
  items: readonly MonthlyCostItem[],
): string | undefined {
  let coveredThrough = rule.postedThroughMonth;
  const prefix = `ccr-${rule.id}-`;
  for (const item of items) {
    if (!item.id.startsWith(prefix)) continue;
    const itemThrough = item.endDate?.slice(0, 7) ?? '9999-12';
    if (coveredThrough === undefined || itemThrough > coveredThrough) coveredThrough = itemThrough;
  }
  if (coveredThrough === '9999-12') return undefined;
  if (coveredThrough === undefined || coveredThrough < rule.startMonth) {
    return ruleFirstDate(rule.startMonth, rule.dayOfMonth);
  }
  const start = monthIndex(rule.startMonth);
  const after = monthIndex(coveredThrough);
  const step = Math.max(1, rule.everyMonths);
  const phase = Math.max(0, Math.floor((after - start) / step) + 1);
  const nextIndex = start + phase * step;
  if (nextIndex > 9999 * 12 + 11) return undefined;
  return ruleFirstDate(monthFromIndex(nextIndex), rule.dayOfMonth);
}

function timestampDate(value: string): string | undefined {
  const candidate = value.slice(0, 10);
  return isValidIsoDate(candidate) ? candidate : undefined;
}

/** 明示開始日、なければ createdAt の日付部分。破損 timestamp は開区間として fail-soft。 */
export function effectiveAccountStartDate(account: Account): string | undefined {
  return account.startDate ?? timestampDate(account.createdAt);
}

/** 線分の両端だけで指定日を包含するか。保存境界で使う。 */
export function accountCoversDate(account: Account, date: string): boolean {
  const start = effectiveAccountStartDate(account);
  return (
    (start === undefined || start <= date) &&
    (account.endDate === undefined || date <= account.endDate)
  );
}

/**
 * 指定日に一覧・ピッカー上で存在するか。
 * 旧データの archived=true / endDateなしだけは、終了点不明のため通常候補から隠す。
 */
export function accountExistsAt(account: Account, date: string): boolean {
  return !(account.archived && account.endDate === undefined) && accountCoversDate(account, date);
}

/**
 * 名前衝突など「現在使われているか」の判定。
 * endDate は当日を含むため翌日から終了済み。旧 archived=true / endDateなしは終了済みとして扱う。
 * 非 archived は未来開始でも既存の名前予約を維持する。
 */
export function accountIsRetiredAt(account: Account, date: string): boolean {
  return account.archived && (account.endDate === undefined || account.endDate < date);
}

/** 科目を参照する保存データの全期間を集める。 */
export function accountReferenceIntervals(
  accountId: string,
  collections: AccountLifetimeCollections,
): AccountReferenceInterval[] {
  const intervals: AccountReferenceInterval[] = [];

  for (const entry of collections.entries) {
    if (entry.lines.some((line) => line.accountId === accountId)) {
      intervals.push({ kind: 'entry', from: entry.date, to: entry.date });
    }
  }
  for (const schedule of collections.schedules) {
    if (schedule.accountId === accountId || schedule.counterAccountId === accountId) {
      intervals.push({ kind: 'schedule', from: schedule.dueDate, to: schedule.dueDate });
    }
  }
  for (const item of collections.monthlyCostItems) {
    // expenseAccountId と、仮想認識行の貸方になる集約台帳が item の期間中ずっと存在する。
    if (item.expenseAccountId === accountId || accountId === CONTINUOUS_COST_LEDGER_ACCOUNT_ID) {
      intervals.push({
        kind: 'monthlyCost',
        from: item.startDate,
        ...(item.endDate !== undefined ? { to: item.endDate } : {}),
      });
    }
  }
  for (const rule of collections.recurringRules) {
    if (
      rule.debitAccountId === accountId ||
      rule.creditAccountId === accountId ||
      rule.spreadExpenseAccountId === accountId
    ) {
      const referenceStart = recurringRuleReferenceStartDate(rule, collections.monthlyCostItems);
      if (referenceStart === undefined) continue;
      intervals.push({
        kind: 'recurringRule',
        from: referenceStart,
      });
    }
  }
  return intervals;
}

/**
 * 科目の線分が全参照を包含するか。
 *
 * import では optional 追加の受理拡大を守るため、未設定 startDate の下限は検証しない
 * (`useImplicitStart=false`)。アプリ内保存・表示では createdAt を既定開始点として扱う。
 */
export function accountLifetimeViolation(
  account: Account,
  references: readonly AccountReferenceInterval[],
  options: { useImplicitStart?: boolean } = {},
): AccountLifetimeViolation | undefined {
  const start = options.useImplicitStart ? effectiveAccountStartDate(account) : account.startDate;
  for (const reference of references) {
    if (start !== undefined && reference.from < start) {
      return { edge: 'start', reference };
    }
    if (
      account.endDate !== undefined &&
      (reference.to === undefined || reference.to > account.endDate)
    ) {
      return { edge: 'end', reference };
    }
  }
  return undefined;
}
