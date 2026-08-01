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

/** 有効な ISO 日付の翌日。排他的終了日を「その日まで有効」から作るのに使う。 */
function nextDate(date: string): string {
  const [year, month, day] = date.split('-').map(Number);
  const value = new Date(Date.UTC(2000, (month ?? 1) - 1, day ?? 1));
  value.setUTCFullYear(year ?? 0);
  value.setUTCDate(value.getUTCDate() + 1);
  return value.toISOString().slice(0, 10);
}

/**
 * 「今日で終了する」ときに置ける最小の排他的終了日。
 *
 * 終了は「今日から存在しない」ではなく「**今日以降は生まない**」である。今日すでに起票済みなら
 * その事実はルールが存在していた間に起きたので、終了点は翌日でなければ半開区間の外へ出てしまう
 * （保存境界の `assertGeneratedEntriesInsideRule` が拒否する）。
 * 生成済み事実の最終日 + 1 日と今日の、遅い方を返す。
 */
export function earliestRecurringRuleEndDate(
  rule: RecurringRule,
  entries: readonly JournalEntry[],
  today: string,
): string {
  let last: string | undefined;
  for (const entry of entries) {
    if (entry.metadata?.recurringRuleId !== rule.id) continue;
    if (last === undefined || entry.date > last) last = entry.date;
  }
  if (last === undefined) return today;
  const afterLast = nextDate(last);
  return afterLast > today ? afterLast : today;
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
 * ルールが 1 回の起票で作る継続コスト資産の終了日。
 * 起票月から周期ぶんを数えた最終月の月末になる。
 */
export function recurringRuleItemEndDate(postingMonth: string, everyMonths: number): string {
  return ruleFirstDate(monthFromIndex(monthIndex(postingMonth) + everyMonths - 1), 31);
}

/**
 * カーソルより後に、周期位相と存在期間が一致する最初の未起票日。
 *
 * ルールの startMonth は位相の基準であって、起票済みの過去まで現在の参照科目へ要求する
 * 境界ではない。既に生まれた item は生成時点の事実として確定しており、次回起票を抑止しない。
 */
export function recurringRuleReferenceStartDate(rule: RecurringRule): string | undefined {
  const start = monthIndex(rule.startMonth);
  const step = Math.max(1, rule.everyMonths);
  const after =
    rule.postedThroughMonth === undefined ? start - 1 : monthIndex(rule.postedThroughMonth);
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

/** 存在期間内で周期位相に乗る最後の起票月。起票機会がなければ未定義。 */
function recurringRuleLastPostingMonth(rule: RecurringRule): string | undefined {
  const lastExistingDate = recurringRuleLastExistingDate(rule);
  if (lastExistingDate === undefined) return undefined;
  const anchor = monthIndex(rule.startMonth);
  const step = Math.max(1, rule.everyMonths);
  let candidateIndex =
    anchor + Math.floor((monthIndex(lastExistingDate.slice(0, 7)) - anchor) / step) * step;
  if (candidateIndex < anchor) return undefined;
  let candidateMonth = monthFromIndex(candidateIndex);
  let candidateDate = ruleFirstDate(candidateMonth, rule.dayOfMonth);
  if (candidateDate > lastExistingDate) {
    candidateIndex -= step;
    if (candidateIndex < anchor) return undefined;
    candidateMonth = monthFromIndex(candidateIndex);
    candidateDate = ruleFirstDate(candidateMonth, rule.dayOfMonth);
  }
  return candidateDate >= effectiveRecurringRuleStartDate(rule) ? candidateMonth : undefined;
}

/**
 * 定期ルールが科目を参照し得る終端（含む）。
 * 費用ルールは存在期間内の最後の起票が作る item の配分終端まで科目を使う。
 */
export function recurringRuleReferenceEndDate(
  rule: RecurringRule,
  spreadsExpense: boolean,
): string | undefined {
  const lastExistingDate = recurringRuleLastExistingDate(rule);
  if (lastExistingDate === undefined || !spreadsExpense) return lastExistingDate;
  const lastPostingMonth = recurringRuleLastPostingMonth(rule);
  if (lastPostingMonth === undefined) return lastExistingDate;
  const itemEnd = recurringRuleItemEndDate(lastPostingMonth, rule.everyMonths);
  return itemEnd > lastExistingDate ? itemEnd : lastExistingDate;
}

export interface RecurringLineageViolation {
  kind: 'missing-parent' | 'self-parent' | 'cycle' | 'overlap';
  ruleId: string;
  relatedRuleId?: string;
}

/**
 * splitFromRuleId でつながる各 connected component について、半開存在期間の重なりを列挙する。
 * 親参照の欠落・自己参照・cycle は区間比較以前の構造破損として併せて報告する。
 */
export function recurringLineageViolations(
  rules: readonly RecurringRule[],
): RecurringLineageViolation[] {
  const byId = new Map(rules.map((rule) => [rule.id, rule] as const));
  const parent = new Map(rules.map((rule) => [rule.id, rule.id] as const));
  const violations: RecurringLineageViolation[] = [];

  const find = (id: string): string => {
    let root = id;
    while ((parent.get(root) ?? root) !== root) root = parent.get(root) ?? root;
    let current = id;
    while ((parent.get(current) ?? current) !== current) {
      const next = parent.get(current) ?? current;
      parent.set(current, root);
      current = next;
    }
    return root;
  };
  const union = (left: string, right: string): void => {
    const leftRoot = find(left);
    const rightRoot = find(right);
    if (leftRoot !== rightRoot) parent.set(leftRoot, rightRoot);
  };

  for (const rule of rules) {
    const predecessorId = rule.splitFromRuleId;
    if (predecessorId === undefined) continue;
    if (predecessorId === rule.id) {
      violations.push({ kind: 'self-parent', ruleId: rule.id, relatedRuleId: predecessorId });
      continue;
    }
    if (!byId.has(predecessorId)) {
      violations.push({ kind: 'missing-parent', ruleId: rule.id, relatedRuleId: predecessorId });
      continue;
    }
    if (find(rule.id) === find(predecessorId)) {
      violations.push({ kind: 'cycle', ruleId: rule.id, relatedRuleId: predecessorId });
      continue;
    }
    union(rule.id, predecessorId);
  }

  const components = new Map<string, RecurringRule[]>();
  for (const rule of rules) {
    const root = find(rule.id);
    const component = components.get(root) ?? [];
    component.push(rule);
    components.set(root, component);
  }
  for (const component of components.values()) {
    const sorted = [...component].sort((left, right) =>
      left.startDate < right.startDate ? -1 : left.startDate > right.startDate ? 1 : 0,
    );
    let furthest = sorted[0];
    if (!furthest) continue;
    for (let index = 1; index < sorted.length; index++) {
      const current = sorted[index]!;
      if (furthest.endDate === undefined || current.startDate < furthest.endDate) {
        violations.push({
          kind: 'overlap',
          ruleId: current.id,
          relatedRuleId: furthest.id,
        });
      }
      if (
        furthest.endDate !== undefined &&
        (current.endDate === undefined || current.endDate > furthest.endDate)
      ) {
        furthest = current;
      }
    }
  }
  return violations;
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
    // expenseAccountId と、仮想月割り行の貸方になる集約台帳が item の期間中ずっと存在する。
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
      const referenceStart = recurringRuleReferenceStartDate(rule);
      if (referenceStart === undefined) continue;
      const referenceEnd = recurringRuleReferenceEndDate(
        rule,
        rule.spreadExpenseAccountId !== undefined,
      );
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
