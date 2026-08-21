/*
 * 勘定科目の存在期間（時間軸上の線分）の単一正本。
 *
 * start/end は両端を含む。**startDate 未設定 = 過去へ開いた線分**（§A 案1・2026-08-11）。
 * 旧仕様の「createdAt を暗黙開始日とみなす」は廃止した — 作者の実データ（createdAt より
 * 古い仕訳を持つ開始日未設定科目）で科目編集が保存できず、CSV の分割適用に順序依存を
 * 生んでいたため。明示 startDate の fail-closed 検証は不変。
 * 参照期間の収集は import schema と repository の保存境界で共有する。
 */
import { addMonthsToDate } from './allocation';
import { CONTINUOUS_COST_LEDGER_ACCOUNT_ID } from './constants';
import type { Account, JournalEntry, MonthlyCostItem, RecurringRule } from './types';

export interface AccountLifetimeCollections {
  entries: readonly JournalEntry[];
  monthlyCostItems: readonly MonthlyCostItem[];
  recurringRules: readonly RecurringRule[];
}

export type AccountReferenceKind = 'entry' | 'monthlyCost' | 'recurringRule';

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
export function nextDate(date: string): string {
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
 * ルールが 1 回の起票で作る継続コスト資産の終了日 = **次回起票日と同日**（v12・同日刻み）。
 * 「残高 0 になる日 = 期間の終わり = 次の支払い日」。実起票の有無に依存せず、周期上の
 * 次回予定日（クランプ込み）を決定的に返す。旧「周期末の月末」は廃止（13 分割問題の根）。
 */
export function recurringRuleItemEndDate(
  postingMonth: string,
  everyMonths: number,
  dayOfMonth: number,
): string {
  return ruleFirstDate(monthFromIndex(monthIndex(postingMonth) + everyMonths), dayOfMonth);
}

/**
 * 周期位相と存在期間が一致する最初の起票日（= ルールが科目を参照し始める日）。
 * v13: ルール由来は全期間を導出するため、参照区間も存在期間の先頭から始まる。
 */
export function recurringRuleReferenceStartDate(rule: RecurringRule): string | undefined {
  const start = monthIndex(rule.startMonth);
  const step = Math.max(1, rule.everyMonths);
  // v13: カーソルは存在しない。参照開始 = 存在期間内で位相に乗る最初の起票日。
  let phase = 0;

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
 * ルールが month の起票で生む item の配分終端。既定 = 次回起票日（同日刻み）。
 * その月に清算（settlement）があれば **その上書きが正本**（v13.9 項目 3 で 1 か所に集約。
 * `deriveRecurringOutputs` の導出と、参照区間・保存境界の検証が同じ規則を共有する）。
 */
export function recurringRuleItemEndDateFor(rule: RecurringRule, month: string): string {
  const settlement = rule.settlements?.find((s) => s.month === month);
  return settlement !== undefined
    ? settlement.endDate
    : recurringRuleItemEndDate(month, rule.everyMonths, rule.dayOfMonth);
}

/*
 * ルール由来の参照区間の終端は**役割別**（v13.9 項目 3・作者の設計指摘 2026-08-20）。
 * ルールと勘定科目は別世界で、門番が見るべきは「その科目に実際に触れるフローの終端」:
 *  - 起票仕訳の両側（源泉 = creditAccountId）: 触れるのは起票日だけ → 終端 = 最終起票日
 *  - 按分の受け口（spreadExpenseAccountId）と集約台帳（保存形の debitAccountId）:
 *    月割り行が item の配分期間じゅう触れる → 終端 = 最終 item の配分終端（清算反映）
 * ルール未終了（endDate 無し）はどちらも開区間（undefined）= 従来どおり終了不可。
 */

/** 起票仕訳の両側の参照終端 = 存在期間内の最終起票日。未終了ルールは開区間。 */
export function recurringRulePostingReferenceEndDate(rule: RecurringRule): string | undefined {
  if (rule.endDate === undefined) return undefined;
  const lastPostingMonth = recurringRuleLastPostingMonth(rule);
  if (lastPostingMonth === undefined) return recurringRuleLastExistingDate(rule);
  return ruleFirstDate(lastPostingMonth, rule.dayOfMonth);
}

/** 按分の受け口・集約台帳の参照終端 = 最終 item の配分終端（清算があれば前倒し）。 */
export function recurringRuleSpreadReferenceEndDate(rule: RecurringRule): string | undefined {
  if (rule.endDate === undefined) return undefined;
  const lastPostingMonth = recurringRuleLastPostingMonth(rule);
  if (lastPostingMonth === undefined) return recurringRuleLastExistingDate(rule);
  return recurringRuleItemEndDateFor(rule, lastPostingMonth);
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

/**
 * 線分の両端だけで指定日を包含するか。保存境界で使う。
 * startDate 未設定は過去へ開いた線分 = 過去側の制限なし（§A 案1）。
 */
export function accountCoversDate(account: Account, date: string): boolean {
  return (
    (account.startDate === undefined || account.startDate <= date) &&
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
  for (const item of collections.monthlyCostItems) {
    const isLoan = item.repaymentSourceAccountId !== undefined;
    // expenseAccountId と、仮想月割り行の貸方になる集約台帳が item の期間中ずっと存在する。
    // ローン item は台帳を経由しない（返済行 = 負債 ⇄ 返済元）ので、台帳の区間は課さない。
    if (
      item.expenseAccountId === accountId ||
      (!isLoan && accountId === CONTINUOUS_COST_LEDGER_ACCOUNT_ID)
    ) {
      intervals.push({
        kind: 'monthlyCost',
        from: item.startDate,
        ...(item.endDate !== undefined ? { to: item.endDate } : {}),
      });
    }
    // 返済元は返済の導出行（先頭刻み〜完済日）が触れる。先頭刻み = 購入日の 1 か月後
    // （同日通過なしの縮退は完済日に全額 1 本）。購入日からは拘束しない —
    // 借入の仕訳は返済元に触れないため（源泉を購入日から縛る誤りを作らない）。
    if (isLoan && item.repaymentSourceAccountId === accountId && item.endDate !== undefined) {
      const firstCut = addMonthsToDate(item.startDate, 1);
      intervals.push({
        kind: 'monthlyCost',
        from: firstCut <= item.endDate ? firstCut : item.endDate,
        to: item.endDate,
      });
    }
  }
  for (const rule of collections.recurringRules) {
    // 役割別の終端（v13.9 項目 3）: 源泉（起票の両側）は最終起票日まで、受け口と集約台帳
    // （保存形の借方 = 台帳）は最終 item の配分終端まで。ルール単位の一律区間を科目へ
    // 課さない（支払い元が item の配分終端まで拘束される誤りの是正）。
    const postingSide = rule.creditAccountId === accountId;
    const spreadSide =
      rule.spreadExpenseAccountId === accountId || rule.debitAccountId === accountId;
    if (!postingSide && !spreadSide) continue;
    const referenceStart = recurringRuleReferenceStartDate(rule);
    if (referenceStart === undefined) continue;
    if (postingSide) {
      const to = recurringRulePostingReferenceEndDate(rule);
      intervals.push({
        kind: 'recurringRule',
        from: referenceStart,
        ...(to !== undefined ? { to } : {}),
      });
    }
    if (spreadSide) {
      const to = recurringRuleSpreadReferenceEndDate(rule);
      intervals.push({
        kind: 'recurringRule',
        from: referenceStart,
        ...(to !== undefined ? { to } : {}),
      });
    }
  }
  return intervals;
}

/**
 * 科目の線分が全参照を包含するか。
 *
 * 下限は**明示 startDate のみ**検証する（§A 案1: 未設定 = 過去へ開いた線分なので
 * どんな過去の参照も包含する）。import 境界とアプリ内保存で同一の意味論。
 */
export function accountLifetimeViolation(
  account: Account,
  references: readonly AccountReferenceInterval[],
): AccountLifetimeViolation | undefined {
  const start = account.startDate;
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
