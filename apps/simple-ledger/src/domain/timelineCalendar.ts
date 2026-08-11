/*
 * 横軸=時間、縦軸=勘定科目の「箱」としたタイムラインの純関数モデル。
 *
 * UI はこの結果を描くだけにし、実仕訳 / 月割り / 定期ルール投影 の違いを
 * ポッチの見た目へ持ち込まない。違いは「開く」先を解決する target だけに残す。
 */
import { addMonths, monthOf } from './allocation';
import { recurringRuleLastExistingDate } from './accountLifetime';
import { derivedEntryOrigin, type DerivedEntryOrigin } from './derivedOrigin';
import { buildRuleItem, recurringExpenseAccountId, recurringPostingsDue } from './recurring';
import { parseRuleItemId } from './recurringIds';
import type { Account, JournalEntry, MonthlyCostItem, RecurringRule } from './types';

export type TimelineZoom = 'day' | 'month' | 'year';

export interface TimelineDateRange {
  start: string;
  end: string;
}

export interface TimelineBucket {
  key: string;
  startDate: string;
  endDate: string;
}

export interface TimelineSpan {
  /** 未設定は過去方向へ開いた線分。 */
  startDate?: string;
  /** 未設定は未来方向へ開いた線分。 */
  endDate?: string;
}

/**
 * 「開く」先。実仕訳はその仕訳、導出行は起票元（derivedEntryOrigin が単一正本）。
 * 導出行の種類が増えたら derivedOrigin.ts に足せば、ここへも型で伝播する。
 */
export type TimelineTarget = { kind: 'entry'; entryId: string } | DerivedEntryOrigin;

/** すべてのフローポッチが共有する、貸方（源泉）→借方（行き先）の正規形。 */
export interface TimelineFlow {
  id: string;
  date: string;
  description: string;
  amount: number;
  sourceAccountId: string;
  destinationAccountId: string;
  /**
   * 未定義 = 由来を名乗らない導出行（開く先が無い）。フロー自体は落とさない
   * （黙って捨てると画面ごとに見える数字がずれる）。UI は「開く」を出さないだけにする。
   */
  target?: TimelineTarget;
}

export interface TimelineFlowDot {
  kind: 'flow';
  bucketKey: string;
  /** 同一バケット内で最初のフロー日。日ズームではポッチの日そのもの。 */
  date: string;
  /** この行に対する純増減（借方 + / 貸方 -）。 */
  netChange: number;
  flows: TimelineFlow[];
}

export interface TimelineGenerationItem {
  id: string;
  name: string;
  projected: boolean;
  target: TimelineTarget;
}

export interface TimelineGenerationDot {
  kind: 'generation';
  bucketKey: string;
  date: string;
  items: TimelineGenerationItem[];
}

export interface TimelineAccountRow {
  kind: 'account';
  id: string;
  boxKey: string;
  account: Account;
  spans: TimelineSpan[];
  dots: TimelineFlowDot[];
}

export interface TimelineMonthlyCostRow {
  kind: 'monthlyCost';
  id: string;
  boxKey: string;
  item: MonthlyCostItem;
  projected: boolean;
  originRuleId?: string;
  spans: TimelineSpan[];
  dots: TimelineFlowDot[];
}

export interface TimelineRuleGroup {
  id: string;
  boxKey: string;
  rule: RecurringRule;
  spans: TimelineSpan[];
  generationDots: TimelineGenerationDot[];
  items: TimelineMonthlyCostRow[];
}

export interface TimelineContinuousCostRows {
  ruleGroups: TimelineRuleGroup[];
  standaloneItems: TimelineMonthlyCostRow[];
}

export interface TimelineBoxDefinition {
  key: string;
  /** 箱に属する科目（内訳の帯・箱の純増減の両方）。残高調整科目も通常の内訳として含める。 */
  accountIds: readonly string[];
  kind?: 'accounts' | 'continuousCost';
}

export interface TimelineBoxRow {
  kind: 'box';
  key: string;
  spans: TimelineSpan[];
  dots: TimelineFlowDot[];
  accountRows: TimelineAccountRow[];
  continuousCost?: TimelineContinuousCostRows;
}

export interface TimelineCalendar {
  range: TimelineDateRange;
  zoom: TimelineZoom;
  buckets: TimelineBucket[];
  boxes: TimelineBoxRow[];
}

export interface BuildTimelineCalendarInput {
  accounts: readonly Account[];
  /** displayEntriesForAsOf(range.end) の結果（実仕訳 + 全導出行）。 */
  entries: readonly JournalEntry[];
  monthlyCostItems: readonly MonthlyCostItem[];
  recurringRules: readonly RecurringRule[];
  boxes: readonly TimelineBoxDefinition[];
  range: TimelineDateRange;
  zoom: TimelineZoom;
  showOutsideRange: boolean;
}

function shiftDay(date: string, amount: number): string {
  const [year, month, day] = date.split('-').map(Number);
  const shifted = new Date(Date.UTC(year ?? 0, (month ?? 1) - 1, (day ?? 1) + amount));
  return `${String(shifted.getUTCFullYear()).padStart(4, '0')}-${String(
    shifted.getUTCMonth() + 1,
  ).padStart(2, '0')}-${String(shifted.getUTCDate()).padStart(2, '0')}`;
}

function monthEnd(month: string): string {
  return shiftDay(`${addMonths(month, 1)}-01`, -1);
}

/** 表示範囲を漏れなく覆う日 / 月 / 年バケットを作る。 */
export function buildTimelineBuckets(
  range: TimelineDateRange,
  zoom: TimelineZoom,
): TimelineBucket[] {
  if (range.start > range.end) return [];
  const buckets: TimelineBucket[] = [];
  if (zoom === 'day') {
    for (let date = range.start; date <= range.end; date = shiftDay(date, 1)) {
      buckets.push({ key: date, startDate: date, endDate: date });
    }
    return buckets;
  }
  if (zoom === 'month') {
    for (
      let month = monthOf(range.start);
      month <= monthOf(range.end);
      month = addMonths(month, 1)
    ) {
      buckets.push({
        key: month,
        startDate: `${month}-01` < range.start ? range.start : `${month}-01`,
        endDate: monthEnd(month) > range.end ? range.end : monthEnd(month),
      });
    }
    return buckets;
  }
  const startYear = Number.parseInt(range.start.slice(0, 4), 10);
  const endYear = Number.parseInt(range.end.slice(0, 4), 10);
  for (let year = startYear; year <= endYear; year += 1) {
    const key = String(year).padStart(4, '0');
    const first = `${key}-01-01`;
    const last = `${key}-12-31`;
    buckets.push({
      key,
      startDate: first < range.start ? range.start : first,
      endDate: last > range.end ? range.end : last,
    });
  }
  return buckets;
}

function bucketKeyOf(date: string, zoom: TimelineZoom): string {
  return zoom === 'day' ? date : zoom === 'month' ? date.slice(0, 7) : date.slice(0, 4);
}

export function timelineSpanIntersects(span: TimelineSpan, range: TimelineDateRange): boolean {
  return (
    (span.startDate === undefined || span.startDate <= range.end) &&
    (span.endDate === undefined || span.endDate >= range.start)
  );
}

function accountSpan(account: Account): TimelineSpan {
  // startDate 未設定 = 過去へ開いた線分（§A 案1）。TimelineSpan の開区間表現へそのまま乗せ、
  // 描画側が表示範囲の左端まで伸ばす（createdAt を代用しない）。
  return { startDate: account.startDate, endDate: account.endDate };
}

function accountSpans(account: Account): TimelineSpan[] {
  // 旧 archived/endDate なしは終了点を復元できない。未来へ開いた線分として描くより、
  // 通常表示から除外し、「終了分も表示」時だけ名前を確認できる空行にする。
  if (account.archived && account.endDate === undefined) return [];
  return [accountSpan(account)];
}

function mergeSpans(spans: readonly TimelineSpan[]): TimelineSpan[] {
  if (spans.length === 0) return [];
  const sorted = [...spans].sort((left, right) => {
    if (left.startDate === undefined) return right.startDate === undefined ? 0 : -1;
    if (right.startDate === undefined) return 1;
    return left.startDate.localeCompare(right.startDate);
  });
  const merged: TimelineSpan[] = [];
  for (const span of sorted) {
    const current = merged.at(-1);
    if (!current) {
      merged.push({ ...span });
      continue;
    }
    const touches =
      current.endDate === undefined ||
      span.startDate === undefined ||
      span.startDate <= shiftDay(current.endDate, 1);
    if (!touches) {
      merged.push({ ...span });
      continue;
    }
    if (current.endDate === undefined || span.endDate === undefined) current.endDate = undefined;
    else if (span.endDate > current.endDate) current.endDate = span.endDate;
  }
  return merged;
}

function flowTargetOf(entry: JournalEntry): TimelineTarget | undefined {
  if (entry.metadata?.virtual !== true) return { kind: 'entry', entryId: entry.id };
  // 導出行 → 起票元の対応表は derivedEntryOrigin（単一正本）に委ねる。画面ごとに
  // 手書きすると、種類が増えたとき片方だけ更新され「一方は黙って行を捨て、もう一方は
  // 空 ID で誤遷移する」状態になる（投資の利回り投影で実際に起きた）。
  return derivedEntryOrigin(entry);
}

function flowOfEntry(entry: JournalEntry): TimelineFlow | undefined {
  const debit = entry.lines.find((line) => line.side === 'debit');
  const credit = entry.lines.find((line) => line.side === 'credit');
  const target = flowTargetOf(entry);
  if (!debit || !credit || debit.accountId === credit.accountId) return undefined;
  return {
    id: entry.id,
    date: entry.date,
    description: entry.description,
    amount: debit.amount,
    sourceAccountId: credit.accountId,
    destinationAccountId: debit.accountId,
    // 開く先が無い導出行もフローとしては残す（残高・純増減から黙って消さない）。
    ...(target !== undefined ? { target } : {}),
  };
}

interface DotAccumulator {
  netChange: number;
  flows: Map<string, TimelineFlow>;
}

type DotMap = Map<string, DotAccumulator>;

function addFlow(map: DotMap, bucketKey: string, delta: number, flow: TimelineFlow): void {
  const current = map.get(bucketKey) ?? { netChange: 0, flows: new Map() };
  current.netChange += delta;
  current.flows.set(flow.id, flow);
  map.set(bucketKey, current);
}

function dotsOf(
  map: DotMap,
  bucketOrder: ReadonlyMap<string, number>,
  zoom: TimelineZoom,
): TimelineFlowDot[] {
  return (
    [...map.entries()]
      // 日表示は「その日にフローがあった」こと自体をポッチとして残す。同日内で
      // 入出金が相殺して純額 0 になっても、flows の一覧から個別の移動を確認できる。
      // 月・年表示だけは俯瞰用の純増減なので、純額 0 のバケットを省く。
      .filter(([, value]) => (zoom === 'day' ? value.flows.size > 0 : value.netChange !== 0))
      .map(([bucketKey, value]) => {
        const flows = [...value.flows.values()].sort(
          (left, right) => left.date.localeCompare(right.date) || left.id.localeCompare(right.id),
        );
        return {
          kind: 'flow' as const,
          bucketKey,
          date: flows[0]?.date ?? bucketKey,
          netChange: value.netChange,
          flows,
        };
      })
      .sort(
        (left, right) =>
          (bucketOrder.get(left.bucketKey) ?? Number.MAX_SAFE_INTEGER) -
          (bucketOrder.get(right.bucketKey) ?? Number.MAX_SAFE_INTEGER),
      )
  );
}

interface ItemCandidate {
  item: MonthlyCostItem;
  projected: boolean;
  originRuleId?: string;
}

function itemCandidates(
  accounts: readonly Account[],
  items: readonly MonthlyCostItem[],
  rules: readonly RecurringRule[],
  through: string,
): ItemCandidate[] {
  const candidates: ItemCandidate[] = [];
  const existingOrigins = new Set<string>();
  for (const item of items) {
    const origin = parseRuleItemId(item.id);
    if (origin) existingOrigins.add(`${origin.ruleId}\u0000${origin.month}`);
    candidates.push({ item, projected: false, originRuleId: origin?.ruleId });
  }
  const byId = new Map(accounts.map((account) => [account.id, account] as const));
  for (const rule of rules) {
    const expenseAccountId = recurringExpenseAccountId(rule, (id) => byId.get(id)?.role);
    if (expenseAccountId === undefined) continue;
    for (const posting of recurringPostingsDue(rule, through)) {
      if (existingOrigins.has(`${rule.id}\u0000${posting.month}`)) continue;
      const built = buildRuleItem(rule, posting, expenseAccountId, {
        createdAt: rule.createdAt,
        updatedAt: rule.updatedAt,
      });
      // recurringProjectionEntries が metadata.continuousCostId に使う一時 ID と揃える。
      candidates.push({
        item: { ...built, id: `${rule.id}-${posting.month}` },
        projected: true,
        originRuleId: rule.id,
      });
    }
  }
  return candidates;
}

function generationDotsOf(
  items: readonly TimelineMonthlyCostRow[],
  zoom: TimelineZoom,
  range: TimelineDateRange,
  bucketOrder: ReadonlyMap<string, number>,
): TimelineGenerationDot[] {
  const byBucket = new Map<string, { date: string; items: TimelineGenerationItem[] }>();
  for (const row of items) {
    if (row.item.startDate < range.start || row.item.startDate > range.end) continue;
    const bucketKey = bucketKeyOf(row.item.startDate, zoom);
    const current = byBucket.get(bucketKey) ?? { date: row.item.startDate, items: [] };
    if (row.item.startDate < current.date) current.date = row.item.startDate;
    current.items.push({
      id: row.id,
      name: row.item.name,
      projected: row.projected,
      target: row.projected
        ? { kind: 'recurringRule', recurringRuleId: row.originRuleId! }
        : { kind: 'monthlyCost', monthlyCostId: row.item.id },
    });
    byBucket.set(bucketKey, current);
  }
  return [...byBucket.entries()]
    .map(([bucketKey, value]) => ({
      kind: 'generation' as const,
      bucketKey,
      date: value.date,
      items: value.items,
    }))
    .sort(
      (left, right) =>
        (bucketOrder.get(left.bucketKey) ?? Number.MAX_SAFE_INTEGER) -
        (bucketOrder.get(right.bucketKey) ?? Number.MAX_SAFE_INTEGER),
    );
}

/**
 * reportEntries（実仕訳 + 全導出行）を一度だけ走査し、科目×バケット / 箱×バケットへ同時に配る。
 * 箱内で完結するフローは箱へ加えないため、箱レベルでは必ず相手の箱が存在する。
 */
export function buildTimelineCalendar(input: BuildTimelineCalendarInput): TimelineCalendar {
  const buckets = buildTimelineBuckets(input.range, input.zoom);
  const bucketOrder = new Map(buckets.map((bucket, index) => [bucket.key, index] as const));
  const validBucketKeys = new Set(bucketOrder.keys());
  const accountById = new Map(input.accounts.map((account) => [account.id, account] as const));
  const accountToBox = new Map<string, string>();
  for (const box of input.boxes) {
    for (const accountId of box.accountIds) accountToBox.set(accountId, box.key);
  }

  const accountDots = new Map<string, DotMap>();
  const boxDots = new Map<string, DotMap>();
  const itemDots = new Map<string, DotMap>();
  const flows: { flow: TimelineFlow; entry?: JournalEntry }[] = [];
  for (const entry of input.entries) {
    if (entry.date < input.range.start || entry.date > input.range.end) continue;
    const flow = flowOfEntry(entry);
    if (flow) flows.push({ flow, entry });
  }

  for (const record of flows) {
    const { flow, entry } = record;
    const bucketKey = bucketKeyOf(flow.date, input.zoom);
    if (!validBucketKeys.has(bucketKey)) continue;
    const destination = accountDots.get(flow.destinationAccountId) ?? new Map();
    addFlow(destination, bucketKey, flow.amount, flow);
    accountDots.set(flow.destinationAccountId, destination);
    const source = accountDots.get(flow.sourceAccountId) ?? new Map();
    addFlow(source, bucketKey, -flow.amount, flow);
    accountDots.set(flow.sourceAccountId, source);

    const destinationBox = accountToBox.get(flow.destinationAccountId);
    const sourceBox = accountToBox.get(flow.sourceAccountId);
    if (destinationBox !== undefined && sourceBox !== undefined && destinationBox !== sourceBox) {
      const destinationMap = boxDots.get(destinationBox) ?? new Map();
      addFlow(destinationMap, bucketKey, flow.amount, flow);
      boxDots.set(destinationBox, destinationMap);
      const sourceMap = boxDots.get(sourceBox) ?? new Map();
      addFlow(sourceMap, bucketKey, -flow.amount, flow);
      boxDots.set(sourceBox, sourceMap);
    }

    const itemId = entry?.metadata?.monthlyCostId ?? entry?.metadata?.continuousCostId;
    if (itemId !== undefined) {
      const map = itemDots.get(itemId) ?? new Map();
      const ledgerDelta = entry?.lines.reduce((sum, line) => {
        const account = accountById.get(line.accountId);
        if (account?.role !== 'continuing-cost-asset') return sum;
        return sum + (line.side === 'debit' ? line.amount : -line.amount);
      }, 0);
      addFlow(map, bucketKey, ledgerDelta ?? 0, flow);
      itemDots.set(itemId, map);
    }
  }

  const candidates = itemCandidates(
    input.accounts,
    input.monthlyCostItems,
    input.recurringRules,
    input.range.end,
  );
  const monthlyRowsAll = candidates.map<TimelineMonthlyCostRow>((candidate) => {
    const span: TimelineSpan = {
      startDate: candidate.item.startDate,
      endDate: candidate.item.endDate,
    };
    return {
      kind: 'monthlyCost',
      id: `monthlyCost:${candidate.item.id}`,
      boxKey: input.boxes.find((box) => box.kind === 'continuousCost')?.key ?? 'continuingCost',
      item: candidate.item,
      projected: candidate.projected,
      originRuleId: candidate.originRuleId,
      spans: [span],
      dots: dotsOf(itemDots.get(candidate.item.id) ?? new Map(), bucketOrder, input.zoom),
    };
  });
  const visibleMonthlyRows = monthlyRowsAll.filter(
    (row) =>
      input.showOutsideRange || row.spans.some((span) => timelineSpanIntersects(span, input.range)),
  );

  const rulesById = new Map(input.recurringRules.map((rule) => [rule.id, rule] as const));
  const expenseRuleIds = new Set(
    input.recurringRules
      .filter(
        (rule) => recurringExpenseAccountId(rule, (id) => accountById.get(id)?.role) !== undefined,
      )
      .map((rule) => rule.id),
  );
  const ruleGroups = input.recurringRules
    .filter((rule) => expenseRuleIds.has(rule.id))
    .map<TimelineRuleGroup>((rule) => {
      const items = visibleMonthlyRows.filter((row) => row.originRuleId === rule.id);
      const endDate = recurringRuleLastExistingDate(rule);
      const spans: TimelineSpan[] = [{ startDate: rule.startDate, endDate }];
      return {
        id: `recurringRule:${rule.id}`,
        boxKey: input.boxes.find((box) => box.kind === 'continuousCost')?.key ?? 'continuingCost',
        rule,
        spans,
        generationDots: generationDotsOf(
          monthlyRowsAll.filter((row) => row.originRuleId === rule.id),
          input.zoom,
          input.range,
          bucketOrder,
        ),
        items,
      };
    })
    .filter(
      (group) =>
        input.showOutsideRange ||
        group.items.length > 0 ||
        group.spans.some((span) => timelineSpanIntersects(span, input.range)),
    );
  const standaloneItems = visibleMonthlyRows.filter(
    (row) => row.originRuleId === undefined || !rulesById.has(row.originRuleId),
  );

  const boxes = input.boxes
    .map<TimelineBoxRow>((definition) => {
      const accounts = definition.accountIds
        .map((id) => accountById.get(id))
        .filter((account): account is Account => account !== undefined);
      const allAccountRows = accounts.map<TimelineAccountRow>((account) => ({
        kind: 'account',
        id: `account:${account.id}`,
        boxKey: definition.key,
        account,
        spans: accountSpans(account),
        dots: dotsOf(accountDots.get(account.id) ?? new Map(), bucketOrder, input.zoom),
      }));
      const accountRows = allAccountRows.filter(
        (row) =>
          input.showOutsideRange ||
          row.spans.some((span) => timelineSpanIntersects(span, input.range)),
      );
      const spans = mergeSpans(allAccountRows.flatMap((row) => row.spans));
      return {
        kind: 'box',
        key: definition.key,
        spans,
        dots: dotsOf(boxDots.get(definition.key) ?? new Map(), bucketOrder, input.zoom),
        accountRows,
        ...(definition.kind === 'continuousCost'
          ? { continuousCost: { ruleGroups, standaloneItems } }
          : {}),
      };
    })
    .filter((box) => {
      if (input.showOutsideRange) {
        return (
          box.spans.length > 0 ||
          box.dots.length > 0 ||
          (box.continuousCost !== undefined &&
            (box.continuousCost.ruleGroups.length > 0 ||
              box.continuousCost.standaloneItems.length > 0))
        );
      }
      const spanVisible = box.spans.some((span) => timelineSpanIntersects(span, input.range));
      const flowVisible = box.dots.length > 0;
      const costVisible =
        box.continuousCost !== undefined &&
        (box.continuousCost.ruleGroups.length > 0 || box.continuousCost.standaloneItems.length > 0);
      return spanVisible || flowVisible || costVisible;
    });

  return { range: input.range, zoom: input.zoom, buckets, boxes };
}
