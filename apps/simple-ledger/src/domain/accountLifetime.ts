/*
 * 勘定科目の存在期間（時間軸上の線分）の単一正本。
 *
 * start/end は両端を含む。startDate 未設定時は createdAt の日付部分を表示・新規保存の
 * 既定に使う。参照期間の収集は import schema と repository の保存境界で共有する。
 */
import { CONTINUOUS_COST_LEDGER_ACCOUNT_ID } from './constants';
import { isValidIsoDate } from './calendar';
import { parseRuleItemId } from './recurringIds';
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

/** 定期ルールの存在開始日。各回の item が生まれる起票日とは別概念である。 */
export function effectiveRecurringRuleStartDate(rule: RecurringRule): string {
  return rule.startDate;
}

/** 定期ルールの半開区間 [startDate, endDate) が指定日を含むか。 */
export function ruleExistsAt(rule: RecurringRule, date: string): boolean {
  return (
    effectiveRecurringRuleStartDate(rule) <= date &&
    (rule.endDate === undefined || date < rule.endDate)
  );
}

/** 有効な ISO 日付の前日。rule.endDate は排他的、Account の参照終端は包含なので変換する。 */
function previousDate(date: string): string {
  const [year, month, day] = date.split('-').map(Number);
  const value = new Date(Date.UTC(2000, (month ?? 1) - 1, day ?? 1));
  value.setUTCFullYear(year ?? 0);
  value.setUTCDate(value.getUTCDate() - 1);
  return value.toISOString().slice(0, 10);
}

/** 排他的終了日の直前にルールが存在する最後の日。終了なしなら未定義。 */
export function recurringRuleLastExistingDate(rule: RecurringRule): string | undefined {
  return rule.endDate !== undefined ? previousDate(rule.endDate) : undefined;
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
  for (const item of items) {
    if (parseRuleItemId(item.id)?.ruleId !== rule.id) continue;
    const itemThrough = item.endDate?.slice(0, 7) ?? '9999-12';
    if (coveredThrough === undefined || itemThrough > coveredThrough) coveredThrough = itemThrough;
  }
  if (coveredThrough === '9999-12') return undefined;
  const start = monthIndex(rule.startMonth);
  const step = Math.max(1, rule.everyMonths);
  const after = coveredThrough === undefined ? start - 1 : monthIndex(coveredThrough);
  let phase = Math.max(0, Math.floor((after - start) / step) + 1);

  // 明示された存在開始より前の周期日は飛ばす。年月だけで位相を合わせ、同月内の日付差は
  // 最後に 1 周期進めることで 4/22 開始・毎月20日のような境界を正しく扱う。
  const effectiveStart = effectiveRecurringRuleStartDate(rule);
  const effectiveStartMonth = monthIndex(effectiveStart.slice(0, 7));
  phase = Math.max(phase, Math.max(0, Math.ceil((effectiveStartMonth - start) / step)));
  let nextIndex = start + phase * step;
  if (nextIndex > 9999 * 12 + 11) return undefined;
  let candidate = ruleFirstDate(monthFromIndex(nextIndex), rule.dayOfMonth);
  if (candidate < effectiveStart) {
    phase += 1;
    nextIndex = start + phase * step;
    if (nextIndex > 9999 * 12 + 11) return undefined;
    candidate = ruleFirstDate(monthFromIndex(nextIndex), rule.dayOfMonth);
  }
  if (rule.endDate !== undefined && candidate >= rule.endDate) return undefined;
  return candidate;
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
  options: { ruleUsesItemCoverage?: (rule: RecurringRule) => boolean } = {},
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
      const referenceStart = recurringRuleReferenceStartDate(
        rule,
        options.ruleUsesItemCoverage?.(rule) === false ? [] : collections.monthlyCostItems,
      );
      if (referenceStart === undefined) continue;
      const referenceEnd = recurringRuleLastExistingDate(rule);
      intervals.push({
        kind: 'recurringRule',
        from: referenceStart,
        ...(referenceEnd !== undefined ? { to: referenceEnd } : {}),
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
