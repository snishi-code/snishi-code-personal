/*
 * タイムライン = **時間平面**。
 *
 * ズーム（日/月/年）はヘッダーが持つ App の state で、この画面はそれに従う（ローカルには持たない）。
 * 画面が持つのはレンズ（線分/数値/グラフ）の中身・表示範囲・開閉状態だけで、帯・ポッチ・純増減の
 * 計算は domain/timelineCalendar、数値レンズの集計は domain/periodMatrix、グラフレンズの
 * ストック 4 系列は domain/stockSeries に委ねる。
 * ヘッダー日付は初期位置にだけ使い、この画面の前後移動・ズームで共有期間は書き換えない
 * （例外は月列タップのドリル = 明示的に基準日を動かしてホームへ行く操作）。
 */
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';
import { Segmented } from '@snishi/foundation/ui/Segmented';
import { useLedger } from '../../state/store';
import { displayEntriesResultForAsOf } from '../../domain/reportEntries';
import { CONTINUOUS_COST_HARD_CAP } from '../../domain/continuousCost';
import {
  buildTimelineCalendar,
  buildTimelineBuckets,
  type TimelineCalendar as DomainTimelineCalendar,
  type TimelineTarget,
  type TimelineZoom,
} from '../../domain/timelineCalendar';
import {
  buildPeriodMatrix,
  periodMatrixAsOf,
  type PeriodMatrixScope,
} from '../../domain/periodMatrix';
import { buildLensRowTree, type LensRowNode } from '../../domain/lensRows';
import {
  LensRowLabel,
  buildLensRowViews,
  lensLabelWidth,
  lensRowLabelProps,
  type LensRowView,
} from '../components/LensRowTree';
import { LENS_FRAME, LensFrame } from '../components/LensFrame';
import { effectiveRecurringRuleStartDate } from '../../domain/accountLifetime';
import { todayLocal } from '../../util/time';
import { formatMoney } from '../../util/format';
import { useMoneyDigits } from '../money';
import { t } from '../../i18n';
import { UI } from '../../ui-contract';
import { useRegisterOverlay } from '../overlays';
import { TIMELINE_ACCOUNT_BOXES, timelineBoxForAccount } from '../accountBoxes';
import type { Account, Ledger, MonthlyCostItem, RecurringRule } from '../../domain/types';
import type { ReportPeriod } from '../../domain/reportPeriod';
import type { Screen } from '../navigation';
import { visibleIndexRange, type ScrollEdge } from '../scrollWindow';
import { useHorizonScroll } from '../horizonScroll';
import { ScrollTopButton } from '../ScrollTopButton';
import { PeriodMatrixTable } from '../components/PeriodMatrixTable';
import { StockSeriesChart } from '../components/StockSeriesChart';

export type { TimelineZoom } from '../../domain/timelineCalendar';

/**
 * 時間平面のレンズ = 同じ窓の見え方。
 *  - `segment`: 帯とポッチ（存在期間とフロー）
 *  - `matrix`:  表（旧「年間・全体」画面。月ズーム = 月列 / 年ズーム = 年列）
 *  - `chart`:   ストック 4 系列の折れ線（日/月/年すべてのズームで描ける）
 */
export type TimelineLens = 'segment' | 'matrix' | 'chart';

/** Segmented は key を文字列で返す。未知の値は既定（線分）へ落とす。 */
export function timelineLensOf(value: string): TimelineLens {
  return value === 'matrix' || value === 'chart' ? value : 'segment';
}

type TimelineOpenTarget = TimelineTarget;

interface TimelineSpanView {
  from: string;
  to?: string;
}

interface TimelineBucketView {
  key: string;
  from: string;
  to: string;
}

interface TimelineFlowView {
  id: string;
  date: string;
  /** 仕訳の摘要（導出行は item 名 / ルール名）。何のフローかを行で判別するために出す。 */
  description: string;
  amount: number;
  sourceAccountId: string;
  destinationAccountId: string;
  /** 未定義 = 開く先の無い導出行（フローは表示するが「開く」を出さない）。 */
  target?: TimelineOpenTarget;
}

interface TimelineDotView {
  bucketKey: string;
  date: string;
  netChange: number;
  flows: TimelineFlowView[];
}

interface TimelineGenerationDotView {
  id: string;
  bucketKey: string;
  date: string;
  items: {
    id: string;
    name: string;
    amount?: number;
    target: TimelineOpenTarget;
  }[];
}

interface TimelineItemView {
  item: MonthlyCostItem;
  spans: TimelineSpanView[];
  dots: TimelineDotView[];
}

interface TimelineRuleView {
  rule: RecurringRule;
  spans: TimelineSpanView[];
  generationDots: TimelineGenerationDotView[];
  items: TimelineItemView[];
}

interface TimelineBoxView {
  key: string;
  spans: TimelineSpanView[];
  dots: TimelineDotView[];
  accounts: { account: Account; spans: TimelineSpanView[]; dots: TimelineDotView[] }[];
  continuousCost?: {
    rules: TimelineRuleView[];
    unlinkedItems: TimelineItemView[];
  };
}

interface TimelineCalendarViewModel {
  buckets: TimelineBucketView[];
  boxes: TimelineBoxView[];
}

interface TimelineCalendarProps {
  period: ReportPeriod;
  /** 時間の単位。正本はヘッダー（App）で、この画面は従うだけ。 */
  zoom: TimelineZoom;
  /** 画面内からズームを動かす唯一の操作（数値レンズの年列タップ = その年を月で見る）。 */
  onZoomChange: (zoom: TimelineZoom) => void;
  /**
   * レンズ（線分/数値/グラフ）。セレクタはこの画面にあるが、state は App が持つ
   * （ヘッダーの「日」の可否が数値レンズかどうかに依存するため）。
   */
  lens: TimelineLens;
  onLensChange: (lens: TimelineLens) => void;
  /** 月列タップのドリル: 基準日をその月末にしてホームへ。 */
  onPeriodChange: (period: ReportPeriod) => void;
  onNavigate: (screen: Screen) => void;
  onOpenEntry: (entryId: string) => void;
  onOpenAllocations: (target: { itemId?: string; ruleId?: string }) => void;
}

/**
 * 線分レンズが 1 行に描くもの。**行そのもの**（並び・名前・色・チェック）は 3 レンズ共通の
 * ラベル列が持ち、ここはその行 id に紐づく帯とポッチだけを持つ。
 */
interface SegmentRowData {
  spans: TimelineSpanView[];
  dots: TimelineDotView[];
  generationDots: TimelineGenerationDotView[];
}

const EMPTY_SEGMENT_ROW: SegmentRowData = { spans: [], dots: [], generationDots: [] };

interface FlowSelection {
  kind: 'flow';
  rowId: string;
  dot: TimelineDotView;
  /** ポップオーバーを置く基準になるポッチの実体（fixed 座標は毎回ここから実測する）。 */
  anchor: HTMLElement;
  flowId?: string;
}

interface GenerationSelection {
  kind: 'generation';
  rowId: string;
  dot: TimelineGenerationDotView;
  anchor: HTMLElement;
  itemId?: string;
}

type Selection = FlowSelection | GenerationSelection;

const BUCKET_WIDTH: Record<TimelineZoom, number> = { day: 44, month: 80, year: 96 };
const ROW_HEIGHT = 52;
const TIMELINE_MIN_DATE = '0001-01-01';
/** ポッチとポップオーバーの隙間 / viewport 端に残す余白（px）。 */
const POPOVER_GAP = 8;
const POPOVER_MARGIN = 8;
/** 同時に開くのは 1 つだけなので固定 id でよい（ポッチの aria-controls の相手）。 */
const POPOVER_ID = 'timeline-calendar-popover';

function clampTimelineDate(value: string): string {
  if (value < TIMELINE_MIN_DATE) return TIMELINE_MIN_DATE;
  if (value > CONTINUOUS_COST_HARD_CAP) return CONTINUOUS_COST_HARD_CAP;
  return value;
}

function isoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function dateUtc(value: string): Date {
  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(Date.UTC(2000, (month ?? 1) - 1, day ?? 1));
  date.setUTCFullYear(year ?? 0);
  return date;
}

function addDays(value: string, amount: number): string {
  const date = dateUtc(value);
  date.setUTCDate(date.getUTCDate() + amount);
  return clampTimelineDate(isoDate(date));
}

function addMonths(value: string, amount: number): string {
  const [year, month] = value.slice(0, 7).split('-').map(Number);
  const minimum = 12;
  const [capYear, capMonth] = CONTINUOUS_COST_HARD_CAP.slice(0, 7).split('-').map(Number);
  const maximum = (capYear ?? 2100) * 12 + ((capMonth ?? 12) - 1);
  const index = Math.max(
    minimum,
    Math.min(maximum, (year ?? 1) * 12 + ((month ?? 1) - 1) + amount),
  );
  return `${String(Math.floor(index / 12)).padStart(4, '0')}-${String((index % 12) + 1).padStart(
    2,
    '0',
  )}-01`;
}

function monthEnd(value: string): string {
  const first = dateUtc(`${value.slice(0, 7)}-01`);
  first.setUTCMonth(first.getUTCMonth() + 1);
  first.setUTCDate(0);
  return isoDate(first);
}

function addYears(value: string, amount: number): string {
  const date = dateUtc(value);
  const month = date.getUTCMonth();
  date.setUTCFullYear(date.getUTCFullYear() + amount);
  // 2/29 は平年の 3/1 に繰り上げず、2月末に丸める。
  if (date.getUTCMonth() !== month) date.setUTCDate(0);
  return clampTimelineDate(isoDate(date));
}

function daysBetween(from: string, to: string): number {
  return Math.round((dateUtc(to).getTime() - dateUtc(from).getTime()) / 86_400_000);
}

function midpoint(from: string, to: string): string {
  return addDays(from, Math.floor(daysBetween(from, to) / 2));
}

/**
 * ヘッダーが名乗っている**基準日**（= App の日付チップと同じ規則）。
 * 窓の初期中心（`centerOfPeriod`）とは役割が違う: あちらは「どこを中心に窓を開くか」で、
 * こちらは「ヘッダーがいま指している日」。画面側のジャンプ（v13.7 I2）はこちらへ戻す。
 */
function basisDateOf(period: ReportPeriod, today: string): string {
  return clampTimelineDate(period.mode === 'date' ? period.date : today);
}

function centerOfPeriod(period: ReportPeriod, today: string): string {
  if (period.mode === 'date') return clampTimelineDate(period.date);
  if (period.mode === 'year')
    return clampTimelineDate(`${String(period.year).padStart(4, '0')}-07-01`);
  return clampTimelineDate(today);
}

/**
 * 青天井のルールを日単位で 2100 年まで DOM 化しないための有限窓。
 * 端に近づけば `grownRange` が継ぎ足す（連続スクロール）ので、ここは**開いた直後の窓**。
 */
function rangeAround(center: string, zoom: TimelineZoom): { from: string; to: string } {
  if (zoom === 'day') return { from: addDays(center, -46), to: addDays(center, 46) };
  if (zoom === 'month') {
    const from = addMonths(center, -17);
    return { from, to: monthEnd(addMonths(center, 18)) };
  }
  const year = Number.parseInt(center.slice(0, 4), 10);
  return {
    from: `${String(Math.max(1, year - 7)).padStart(4, '0')}-01-01`,
    to: clampTimelineDate(`${String(year + 7).padStart(4, '0')}-12-31`),
  };
}

/**
 * 数値レンズが 1 度に描く列の上限。窓（可視範囲 + 前後バッファ）は zoom ごとに数十列だが、
 * 壊れた日付から無制限に列を増やさないための歯止め（periodMatrix の年上限と同じ 200）。
 */
const MATRIX_MAX_COLUMNS = 200;

/*
 * ── 連続スクロールの継ぎ足し（v13.6 H2-3・作者確定 2026-08-18）──
 * 端に近づいたら窓が自動で伸びる。伸びるのは端だけで、反対側は捨てない
 * （捨てると戻ったときに作り直しになり、`grownRange` が純関数でなくなる）。
 */
/** 1 回の継ぎ足し量（`rangeAround` 1 窓のおよそ半分 = 継ぎ足し直後にまた端へ触れない距離）。 */
const EXTEND_STEP: Record<TimelineZoom, number> = { day: 46, month: 18, year: 7 };
/**
 * 継ぎ足しの上限（before + after の合計回数）。窓は伸びるだけなので、DOM の列数はここで
 * 頭打ちになる: 日 93 + 46×5 = 323 列 / 月 36 + 18×9 = 198 列 / 年 15 + 7×26 = 197 列。
 * 月・年は数値レンズの列上限 `MATRIX_MAX_COLUMNS`(200) を超えない（超えると表の列だけ
 * 生えなくなり、同じ窓のはずの帯・折れ線とずれる）。ここで止まったあとは左右ボタンで送る
 * = ボタンを残す理由の 1 つ（もう 1 つはキーボード / 支援技術）。
 */
const MAX_EXTEND_STEPS: Record<TimelineZoom, number> = { day: 5, month: 9, year: 26 };

/** 窓の伸び具合。`key` = どの窓に対する伸びか（送り直したら 0 に戻る）。 */
interface WindowGrowth {
  key: string;
  before: number;
  after: number;
}
const NO_GROWTH: WindowGrowth = { key: '', before: 0, after: 0 };

/** 窓の端を `steps` 段ぶん動かす。バケット末（月末 / 年末）へ揃えるのもここ。 */
function shiftWindowEdge(date: string, zoom: TimelineZoom, steps: number): string {
  if (zoom === 'day') return addDays(date, steps * EXTEND_STEP.day);
  if (zoom === 'month') {
    const shifted = addMonths(date, steps * EXTEND_STEP.month);
    return steps > 0 ? monthEnd(shifted) : shifted;
  }
  const shifted = addYears(date, steps * EXTEND_STEP.year);
  return clampTimelineDate(`${shifted.slice(0, 4)}-${steps > 0 ? '12-31' : '01-01'}`);
}

/**
 * 継ぎ足し後の窓。**開いた直後の窓 + 段数**から毎回引き直す純関数なので、同じ段数なら
 * 何度描いても同じ範囲になる（差分を足し込まないので丸めも溜まらない）。
 *
 * 上限は従来どおり: 右は `CONTINUOUS_COST_HARD_CAP`（`addDays` / `addMonths` / `addYears` が
 * 既にクランプする）、左は**データのある最初の年**。開いた直後の窓が既にそれより過去から
 * 始まっているときは、そこを下限にする（今見えているものを取り上げない）。
 */
function grownRange(
  base: { from: string; to: string },
  zoom: TimelineZoom,
  growth: WindowGrowth,
  floor: string,
): { from: string; to: string } {
  const limit = floor < base.from ? floor : base.from;
  const shifted = growth.before > 0 ? shiftWindowEdge(base.from, zoom, -growth.before) : base.from;
  return {
    from: shifted < limit ? limit : shifted,
    to: growth.after > 0 ? shiftWindowEdge(base.to, zoom, growth.after) : base.to,
  };
}

/** 窓に入る 'YYYY-MM' の並び。年をまたいで連続する。 */
function monthsBetween(from: string, to: string): string[] {
  const months: string[] = [];
  const end = to.slice(0, 7);
  let cursor = from.slice(0, 7);
  while (cursor <= end && months.length < MATRIX_MAX_COLUMNS) {
    months.push(cursor);
    const next = addMonths(`${cursor}-01`, 1).slice(0, 7);
    // 上限（HARD_CAP）に貼り付いたら進めない = そこが最終列。
    if (next <= cursor) break;
    cursor = next;
  }
  return months;
}

/** 窓に入る年の並び。 */
function yearsBetween(from: string, to: string): number[] {
  const first = Number.parseInt(from.slice(0, 4), 10);
  const last = Number.parseInt(to.slice(0, 4), 10);
  if (!Number.isFinite(first) || !Number.isFinite(last) || last < first) return [];
  const years: number[] = [];
  for (let year = first; year <= last && years.length < MATRIX_MAX_COLUMNS; year += 1) {
    years.push(year);
  }
  return years;
}

/**
 * 数値レンズのスクロール可能範囲の下端 = データのある最初の年の 1/1。
 * 上端は HARD_CAP（`rangeAround` / `addMonths` が既にクランプする）。
 * 旧「年間・全体」画面の表示地平セレクタ（実績のみ / +30年 / 2100年）は、この下端と
 * 横スクロールに溶けて消えた（見たい先まで送れば列は生える・v13.5 D）。
 */
function matrixFloorDate(ledger: Ledger | null, today: string): string {
  let floor: string | undefined;
  const consider = (date: string) => {
    if (floor === undefined || date < floor) floor = date;
  };
  for (const entry of ledger?.journalEntries ?? []) consider(entry.date);
  for (const item of ledger?.monthlyCostItems ?? []) consider(item.startDate);
  for (const rule of ledger?.recurringRules ?? []) consider(effectiveRecurringRuleStartDate(rule));
  return clampTimelineDate(`${(floor ?? today).slice(0, 4)}-01-01`);
}

function shiftCenter(center: string, zoom: TimelineZoom, direction: -1 | 1): string {
  if (zoom === 'day') return addDays(center, direction * 93);
  if (zoom === 'month') return addMonths(center, direction * 36);
  return addYears(center, direction * 15);
}

function headerGroups(
  buckets: TimelineBucketView[],
  labelOf: (bucket: TimelineBucketView) => string,
): { key: string; label: string; start: number; count: number }[] {
  const groups: { key: string; label: string; start: number; count: number }[] = [];
  buckets.forEach((bucket, index) => {
    const label = labelOf(bucket);
    const previous = groups.at(-1);
    if (previous?.label === label) previous.count += 1;
    else groups.push({ key: `${bucket.key}-${label}`, label, start: index, count: 1 });
  });
  return groups;
}

function bucketIndex(buckets: TimelineBucketView[], key: string): number {
  return buckets.findIndex((bucket) => bucket.key === key);
}

function positionForDate(
  buckets: TimelineBucketView[],
  date: string,
  bucketWidth: number,
  edge: 'start' | 'middle' | 'end' = 'middle',
): number {
  if (buckets.length === 0) return 0;
  const first = buckets[0]!;
  const last = buckets[buckets.length - 1]!;
  if (date < first.from) return 0;
  if (date > last.to) return buckets.length * bucketWidth;
  const index = buckets.findIndex((bucket) => bucket.from <= date && date <= bucket.to);
  if (index < 0) return 0;
  const bucket = buckets[index]!;
  const bucketDays = daysBetween(bucket.from, bucket.to) + 1;
  const elapsed = daysBetween(bucket.from, date);
  const fraction =
    edge === 'start'
      ? elapsed / bucketDays
      : edge === 'end'
        ? (elapsed + 1) / bucketDays
        : (elapsed + 0.5) / bucketDays;
  return (index + fraction) * bucketWidth;
}

function bandStyle(
  span: TimelineSpanView,
  buckets: TimelineBucketView[],
  bucketWidth: number,
): CSSProperties | undefined {
  const first = buckets[0];
  const last = buckets.at(-1);
  if (!first || !last || span.from > last.to || (span.to !== undefined && span.to < first.from)) {
    return undefined;
  }
  const start = positionForDate(buckets, span.from, bucketWidth, 'start');
  const end = positionForDate(
    buckets,
    span.to ?? buckets.at(-1)?.to ?? span.from,
    bucketWidth,
    'end',
  );
  return { left: start, width: Math.max(2, end - start) };
}

/** 線分レンズの計算結果を、共通ラベル列の行 id で引けるようにする。 */
function segmentRowData(boxes: TimelineBoxView[]): Map<string, SegmentRowData> {
  const byId = new Map<string, SegmentRowData>();
  for (const box of boxes) {
    byId.set(`box:${box.key}`, {
      spans: box.spans,
      dots: box.dots,
      generationDots: [],
    });
    for (const child of box.accounts) {
      byId.set(`account:${child.account.id}`, {
        spans: child.spans,
        dots: child.dots,
        generationDots: [],
      });
    }
    for (const group of box.continuousCost?.rules ?? []) {
      byId.set(`rule:${group.rule.id}`, {
        spans: group.spans,
        dots: [],
        generationDots: group.generationDots,
      });
      for (const child of group.items) {
        byId.set(`item:${child.item.id}`, {
          spans: child.spans,
          dots: child.dots,
          generationDots: [],
        });
      }
    }
    for (const child of box.continuousCost?.unlinkedItems ?? []) {
      byId.set(`item:${child.item.id}`, {
        spans: child.spans,
        dots: child.dots,
        generationDots: [],
      });
    }
  }
  return byId;
}

/**
 * 継続コスト台帳の箱に線分レンズだけが足す子（定期ルール → 月割り項目）。
 * 科目ではない実体なので共通木は持たず、線分レンズが `extraChildren` として渡す。
 */
export function continuousCostChildren(boxes: TimelineBoxView[], boxKey: string): LensRowNode[] {
  const box = boxes.find((candidate) => candidate.key === boxKey);
  const rows = box?.continuousCost;
  if (!rows) return [];
  return [
    ...rows.rules.map<LensRowNode>((group) => ({
      id: `rule:${group.rule.id}`,
      kind: 'rule',
      stock: true,
      boxKey: box!.key as LensRowNode['boxKey'],
      name: group.rule.name,
      children: group.items.map<LensRowNode>((child) => ({
        id: `item:${child.item.id}`,
        kind: 'item',
        stock: true,
        boxKey: box!.key as LensRowNode['boxKey'],
        name: child.item.name,
        children: [],
      })),
    })),
    ...rows.unlinkedItems.map<LensRowNode>((child) => ({
      id: `item:${child.item.id}`,
      kind: 'item',
      stock: true,
      boxKey: box!.key as LensRowNode['boxKey'],
      name: child.item.name,
      children: [],
    })),
  ];
}

/** domain の計算結果を描画名に合わせる薄い adapter。金額の再集計はしない。 */
function timelineViewModel(
  model: DomainTimelineCalendar,
  displayRange = model.range,
  displayBuckets: TimelineBucketView[] = model.buckets.map((bucket) => ({
    key: bucket.key,
    from: bucket.startDate,
    to: bucket.endDate,
  })),
): TimelineCalendarViewModel {
  const spanView = (span: { startDate?: string; endDate?: string }): TimelineSpanView => ({
    from: span.startDate ?? displayRange.start,
    ...(span.endDate !== undefined ? { to: span.endDate } : {}),
  });
  return {
    buckets: displayBuckets,
    boxes: model.boxes.map((box) => ({
      key: box.key,
      spans: box.spans.map(spanView),
      dots: box.dots,
      accounts: box.accountRows.map((row) => ({
        account: row.account,
        spans: row.spans.map(spanView),
        dots: row.dots,
      })),
      ...(box.continuousCost
        ? {
            continuousCost: {
              rules: box.continuousCost.ruleGroups.map((group) => {
                const itemById = new Map(group.items.map((row) => [row.id, row] as const));
                return {
                  rule: group.rule,
                  spans: group.spans.map(spanView),
                  generationDots: group.generationDots.map((dot) => ({
                    id: `${group.id}:${dot.bucketKey}`,
                    bucketKey: dot.bucketKey,
                    date: dot.date,
                    items: dot.items.map((item) => ({
                      id: item.id,
                      name: item.name,
                      ...(itemById.get(item.id)?.item.amount !== undefined
                        ? { amount: itemById.get(item.id)!.item.amount }
                        : {}),
                      target: item.target,
                    })),
                  })),
                  items: group.items.map((row) => ({
                    item: row.item,
                    spans: row.spans.map(spanView),
                    dots: row.dots,
                  })),
                };
              }),
              unlinkedItems: box.continuousCost.standaloneItems.map((row) => ({
                item: row.item,
                spans: row.spans.map(spanView),
                dots: row.dots,
              })),
            },
          }
        : {}),
    })),
  };
}

function visibleRangeOf(
  viewport: HTMLDivElement,
  buckets: TimelineBucketView[],
  bucketWidth: number,
): { from: string; to: string } | undefined {
  if (buckets.length === 0 || viewport.clientWidth <= 0) return undefined;
  const labelWidth = lensLabelWidth(viewport.clientWidth);
  const visible = visibleIndexRange(
    viewport.scrollLeft,
    viewport.clientWidth - labelWidth,
    bucketWidth,
    buckets.length,
  );
  const first = visible && buckets[visible.first];
  const last = visible && buckets[visible.last];
  return first && last ? { from: first.from, to: last.to } : undefined;
}

/**
 * domain model を受ける描画本体。配置先や store に依存しないため、
 * 将来ハンバーガー以外へ移してもこのコンポーネントは変えない。
 */
export function TimelineCalendarView({
  model,
  rows,
  onToggleRow,
  onCheckRow,
  zoom,
  today,
  accounts,
  currency,
  onOpenTarget,
  onVisibleRangeChange,
  onExtend,
  focusDate,
  windowKey,
}: {
  model: TimelineCalendarViewModel;
  /** 3 レンズ共通のラベル列の行（並び・名前・色・チェックは画面が解決済み）。 */
  rows: LensRowView[];
  onToggleRow: (id: string) => void;
  onCheckRow: (id: string, checked: boolean) => void;
  zoom: TimelineZoom;
  today: string;
  accounts: Account[];
  currency: string;
  onOpenTarget: (target: TimelineOpenTarget) => void;
  /** 実際に viewport 内へ見えている横軸。行の存在期間フィルタへ返す。 */
  onVisibleRangeChange?: (range: { from: string; to: string }) => void;
  /** 端に近づいた = 窓をその側へ伸ばしたい（連続スクロール・v13.6 H2-3）。 */
  onExtend?: (edge: ScrollEdge) => void;
  /** ヘッダー日付または窓送り後の中心。初期スクロール位置にだけ使う。 */
  focusDate?: string;
  /** 窓（ズーム・前後移動）の同一性。変わったら開いているポップオーバーを捨てる。 */
  windowKey?: string;
}) {
  const [selection, setSelection] = useState<Selection | null>(null);
  // 窓が変わればポッチの実体も座標も入れ替わる。選択を持ち越すと、消えたポッチに
  // 紐づいたポップオーバーだけが残る（render 中の派生調整パターン）。
  const [trackedWindowKey, setTrackedWindowKey] = useState(windowKey);
  if (trackedWindowKey !== windowKey) {
    setTrackedWindowKey(windowKey);
    if (selection !== null) setSelection(null);
  }
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const visibleCenterRef = useRef(
    model.buckets[Math.floor(model.buckets.length / 2)]?.from ?? today,
  );
  const bucketWidth = BUCKET_WIDTH[zoom];
  const rowData = useMemo(() => segmentRowData(model.boxes), [model.boxes]);
  const accountById = useMemo(
    () => new Map(accounts.map((account) => [account.id, account] as const)),
    [accounts],
  );
  const trackWidth = model.buckets.length * bucketWidth;
  const windowCenter =
    focusDate ??
    (() => {
      const centerBucket = model.buckets[Math.floor(model.buckets.length / 2)];
      return centerBucket ? midpoint(centerBucket.from, centerBucket.to) : today;
    })();

  const readViewport = useCallback(
    (viewport: HTMLDivElement): string => {
      if (model.buckets.length === 0) return visibleCenterRef.current;
      const labelWidth = lensLabelWidth(viewport.clientWidth);
      const visibleTrackWidth = Math.max(0, viewport.clientWidth - labelWidth);
      const pixel = viewport.scrollLeft + visibleTrackWidth / 2;
      const index = Math.max(
        0,
        Math.min(model.buckets.length - 1, Math.floor(pixel / bucketWidth)),
      );
      const bucket = model.buckets[index];
      if (bucket) visibleCenterRef.current = midpoint(bucket.from, bucket.to);
      const visible = visibleRangeOf(viewport, model.buckets, bucketWidth);
      if (visible) onVisibleRangeChange?.(visible);
      return visibleCenterRef.current;
    },
    [bucketWidth, model.buckets, onVisibleRangeChange],
  );

  // 窓を送ったときとズーム時は中央日付が見える位置から始め、連続スクロールで窓が左へ
  // 伸びたぶんは scrollLeft で打ち消す（機構は 3 レンズ共通の useHorizonScroll が持つ）。
  const bucketKeys = useMemo(() => model.buckets.map((bucket) => bucket.key), [model.buckets]);
  const handleScroll = useHorizonScroll({
    viewportRef,
    keys: bucketKeys,
    itemWidth: bucketWidth,
    windowKey: `${windowKey ?? ''}:${windowCenter}`,
    focusScrollLeft: (viewport) => {
      const focusX = positionForDate(model.buckets, windowCenter, bucketWidth);
      const labelWidth = lensLabelWidth(viewport.clientWidth);
      visibleCenterRef.current = windowCenter;
      return Math.max(0, focusX - Math.max(0, viewport.clientWidth - labelWidth) / 2);
    },
    onSettle: readViewport,
    ...(onExtend ? { onExtend } : {}),
  });

  // 画面回転やコンテナ幅の変化でも、物理的に見えている期間へ行とポッチを追従させる。
  useLayoutEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => readViewport(viewport));
    observer.observe(viewport);
    return () => observer.disconnect();
  }, [readViewport]);

  const selectedFlow =
    selection?.kind === 'flow'
      ? selection.dot.flows.find((flow) => flow.id === selection.flowId)
      : undefined;

  const renderedRowById = new Map(rows.map((row, index) => [row.id, { row, index }] as const));
  const accountBoxKey = (accountId: string): string | undefined => {
    const account = accountById.get(accountId);
    return account ? timelineBoxForAccount(account)?.key : undefined;
  };

  const counterpartRow = (() => {
    if (!selection || selection.kind !== 'flow' || !selectedFlow) return undefined;
    const source = renderedRowById.get(selection.rowId)?.row;
    if (!source) return undefined;
    let otherAccountId: string | undefined;
    if (source.kind === 'account') {
      otherAccountId =
        source.node.accountId === selectedFlow.sourceAccountId
          ? selectedFlow.destinationAccountId
          : selectedFlow.sourceAccountId;
    } else if (source.kind === 'box') {
      const sourceBox = accountBoxKey(selectedFlow.sourceAccountId);
      otherAccountId =
        sourceBox === source.node.boxKey
          ? selectedFlow.destinationAccountId
          : selectedFlow.sourceAccountId;
    } else {
      // item は内部台帳側の実体。相手となる通常科目の行を優先する。
      const sourceIsContinuing = accountBoxKey(selectedFlow.sourceAccountId) === 'continuingCost';
      otherAccountId = sourceIsContinuing
        ? selectedFlow.destinationAccountId
        : selectedFlow.sourceAccountId;
    }
    const detail = renderedRowById.get(`account:${otherAccountId}`);
    if (detail) return detail;
    const boxKey = accountBoxKey(otherAccountId);
    return boxKey ? renderedRowById.get(`box:${boxKey}`) : undefined;
  })();

  const sourceIndex = selection ? renderedRowById.get(selection.rowId)?.index : undefined;
  // 接続線が**下の行**へ伸びるときはポップオーバーを行の上へ出す（線と重ねない・実測不要の決定則）。
  const connectorGoesDown =
    sourceIndex !== undefined && counterpartRow !== undefined && counterpartRow.index > sourceIndex;
  const connectedIds =
    sourceIndex !== undefined && counterpartRow
      ? new Set([selection?.rowId, counterpartRow.row.id])
      : undefined;
  const selectedBucketIndex =
    selection?.kind === 'flow'
      ? bucketIndex(model.buckets, selection.dot.bucketKey)
      : selection?.kind === 'generation'
        ? bucketIndex(model.buckets, selection.dot.bucketKey)
        : -1;
  // 接続線・ポップオーバーはポッチと同じ x（日付比例）に置く。バケット中央だとポッチと分離する。
  const connectorX =
    selection !== null
      ? positionForDate(model.buckets, selection.dot.date, bucketWidth)
      : (selectedBucketIndex + 0.5) * bucketWidth;
  const todayX =
    model.buckets[0] &&
    model.buckets.at(-1) &&
    model.buckets[0].from <= today &&
    today <= model.buckets.at(-1)!.to
      ? positionForDate(model.buckets, today, bucketWidth)
      : undefined;

  // 箱の行は骨格なので常に並ぶ。「何も無い」は**帯もポッチも 1 つも無い**ことで言う
  // （行が消えることではない）。器の中に置くと 9 行の骨格と重なるので、枠の手前に出す。
  const hasAnything = rows.some((row) => {
    const data = rowData.get(row.id);
    return (
      data !== undefined &&
      (data.spans.length > 0 || data.dots.length > 0 || data.generationDots.length > 0)
    );
  });

  return (
    <>
      {hasAnything ? null : (
        <p className="field__hint" role="status">
          {t('timeline.empty')}
        </p>
      )}
      <LensFrame
        viewportRef={viewportRef}
        className="timeline-calendar__viewport card"
        label={t('timeline.title')}
        dataUi={UI.timeline.viewport}
        onScroll={handleScroll}
      >
        <div
          className="timeline-calendar__canvas"
          style={
            {
              '--timeline-bucket-count': model.buckets.length,
              '--timeline-bucket-width': `${bucketWidth}px`,
            } as CSSProperties
          }
        >
          <TimelineHeader buckets={model.buckets} zoom={zoom} />
          <div className="timeline-calendar__body">
            {todayX !== undefined ? (
              <div
                className="timeline-calendar__today-line"
                // ラベル列の幅の正本は --lens-label-width（3 レンズ共通）。別名を書くと
                // 未定義変数になり calc ごと無効 = 今日の線が軌道の左端へ寄る。
                style={{ left: `calc(var(--lens-label-width) + ${todayX}px)` }}
                title={t('timeline.today')}
                aria-hidden="true"
              />
            ) : null}

            {sourceIndex !== undefined && counterpartRow ? (
              <svg
                className="timeline-calendar__connector"
                width={trackWidth}
                height={rows.length * ROW_HEIGHT}
                aria-hidden="true"
              >
                <line
                  x1={connectorX}
                  x2={connectorX}
                  y1={sourceIndex * ROW_HEIGHT + ROW_HEIGHT / 2}
                  y2={counterpartRow.index * ROW_HEIGHT + ROW_HEIGHT / 2}
                />
              </svg>
            ) : null}

            {rows.map((row) => (
              <TimelineRow
                key={row.id}
                row={row}
                // チェック OFF の行は帯もポッチも消える（行そのものは残る = 戻せる）。
                data={row.checked ? (rowData.get(row.id) ?? EMPTY_SEGMENT_ROW) : EMPTY_SEGMENT_ROW}
                buckets={model.buckets}
                bucketWidth={bucketWidth}
                dimmed={connectedIds !== undefined && !connectedIds.has(row.id)}
                selection={selection?.rowId === row.id ? selection : null}
                popoverAbove={selection?.rowId === row.id && connectorGoesDown}
                accountById={accountById}
                currency={currency}
                onToggleRow={onToggleRow}
                onCheckRow={onCheckRow}
                onSelect={setSelection}
                onOpenTarget={onOpenTarget}
              />
            ))}
          </div>
        </div>
      </LensFrame>
    </>
  );
}

function TimelineHeader({ buckets, zoom }: { buckets: TimelineBucketView[]; zoom: TimelineZoom }) {
  const yearGroups = headerGroups(buckets, (bucket) => bucket.from.slice(0, 4));
  const monthGroups = headerGroups(buckets, (bucket) =>
    zoom === 'year' ? '' : String(Number.parseInt(bucket.from.slice(5, 7), 10)),
  );
  const dayGroups = headerGroups(buckets, (bucket) =>
    zoom === 'day' ? String(Number.parseInt(bucket.from.slice(8, 10), 10)) : '',
  );
  const rows = [
    { label: t('zoom.year'), groups: yearGroups },
    { label: t('zoom.month'), groups: monthGroups },
    { label: t('zoom.day'), groups: dayGroups },
  ];
  return (
    // 年月日の 3 行がまとまって枠の上端に貼りつく（3 レンズ共通の目盛り行）。
    // 貼るのは器のほうで、中の隅（年/月/日 の見出し）は左に貼るだけ。
    <div className={`timeline-calendar__header ${LENS_FRAME.head}`}>
      {rows.map((row) => (
        <div className="timeline-calendar__header-row" key={row.label}>
          <div className={`timeline-calendar__header-label ${LENS_FRAME.corner}`}>{row.label}</div>
          {row.groups.map((group) => (
            <div
              className={`timeline-calendar__header-cell ${LENS_FRAME.pane}`}
              key={group.key}
              style={{ gridColumn: `${group.start + 2} / span ${group.count}` }}
              aria-hidden={group.label === '' ? 'true' : undefined}
            >
              {group.label === '' ? '' : `${group.label}${row.label}`}
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}

function TimelineRow({
  row,
  data,
  buckets,
  bucketWidth,
  dimmed,
  selection,
  popoverAbove,
  accountById,
  currency,
  onToggleRow,
  onCheckRow,
  onSelect,
  onOpenTarget,
}: {
  row: LensRowView;
  /** この行に描く帯とポッチ（チェック OFF なら空）。 */
  data: SegmentRowData;
  buckets: TimelineBucketView[];
  bucketWidth: number;
  dimmed: boolean;
  selection: Selection | null;
  /** フロー選択の接続線が下の行へ伸びるとき true（ポップオーバーを行の上へ出す）。 */
  popoverAbove: boolean;
  accountById: ReadonlyMap<string, Account>;
  currency: string;
  onToggleRow: (id: string) => void;
  onCheckRow: (id: string, checked: boolean) => void;
  onSelect: (selection: Selection | null) => void;
  onOpenTarget: (target: TimelineOpenTarget) => void;
}) {
  const digits = useMoneyDigits();
  const rowClass = [
    'timeline-calendar__row',
    row.heading ? '' : 'timeline-calendar__row--detail',
    dimmed ? 'timeline-calendar__row--dimmed' : '',
  ]
    .filter(Boolean)
    .join(' ');
  const labelProps = lensRowLabelProps(row);
  const rowStyle = { '--timeline-accent': row.accent } as CSSProperties;
  const selectedFlow =
    selection?.kind === 'flow'
      ? selection.dot.flows.find((flow) => flow.id === selection.flowId)
      : undefined;

  return (
    <div
      className={rowClass}
      style={rowStyle}
      data-ui={row.heading ? UI.timeline.boxRow : UI.timeline.detailRow}
    >
      <div {...labelProps} style={{ ...labelProps.style, ...rowStyle }}>
        <LensRowLabel row={row} onToggle={onToggleRow} onCheckChange={onCheckRow} />
      </div>
      <div className={`timeline-calendar__track ${LENS_FRAME.pane}`} onClick={() => onSelect(null)}>
        {data.spans.map((span, index) => {
          const style = bandStyle(span, buckets, bucketWidth);
          return style ? (
            <div
              className="timeline-calendar__band"
              style={style}
              data-ui={UI.timeline.band}
              aria-hidden="true"
              key={`${span.from}-${span.to ?? 'open'}-${index}`}
            />
          ) : null;
        })}
        {data.dots.map((dot) => {
          const index = bucketIndex(buckets, dot.bucketKey);
          if (index < 0) return null;
          // ポッチの x は帯と同じ「日付比例」で置く。バケット中央固定にすると、帯の端が
          // バケット途中にあるとき（月の後半に始まる項目など）ポッチが帯の外へ浮いて見える
          // ＝同じ軸に 2 つの座標規則を持たない（実ユーズ指摘 2026-08-14）。
          const dotX = positionForDate(buckets, dot.date, bucketWidth);
          const selected = selection?.kind === 'flow' && selection.dot === dot;
          return (
            <button
              type="button"
              className={`timeline-calendar__dot ${
                dot.netChange > 0
                  ? 'timeline-calendar__dot--positive'
                  : dot.netChange < 0
                    ? 'timeline-calendar__dot--negative'
                    : ''
              }`}
              style={{ left: dotX }}
              aria-label={`${dot.date} ${t('timeline.flowCount', { count: dot.flows.length })}: ${formatMoney(
                dot.netChange,
                currency,
                digits,
              )}`}
              aria-expanded={selected}
              aria-controls={selected ? POPOVER_ID : undefined}
              data-ui={UI.timeline.flowDot}
              key={`${dot.bucketKey}-${dot.date}`}
              onClick={(event) => {
                const anchor = event.currentTarget;
                event.stopPropagation();
                onSelect(
                  selected
                    ? null
                    : {
                        kind: 'flow',
                        rowId: row.id,
                        dot,
                        anchor,
                        ...(dot.flows.length === 1 ? { flowId: dot.flows[0]!.id } : {}),
                      },
                );
              }}
            />
          );
        })}
        {data.generationDots.map((dot) => {
          const index = bucketIndex(buckets, dot.bucketKey);
          if (index < 0) return null;
          const selected = selection?.kind === 'generation' && selection.dot === dot;
          return (
            <button
              type="button"
              className="timeline-calendar__dot timeline-calendar__dot--generation"
              style={{ left: positionForDate(buckets, dot.date, bucketWidth) }}
              aria-label={`${t('timeline.generation')}: ${dot.date}`}
              aria-expanded={selected}
              aria-controls={selected ? POPOVER_ID : undefined}
              data-ui={UI.timeline.generationDot}
              key={dot.id}
              onClick={(event) => {
                const anchor = event.currentTarget;
                event.stopPropagation();
                onSelect(
                  selected
                    ? null
                    : {
                        kind: 'generation',
                        rowId: row.id,
                        dot,
                        anchor,
                        ...(dot.items.length === 1 ? { itemId: dot.items[0]!.id } : {}),
                      },
                );
              }}
            />
          );
        })}

        {/* 実体は body へ portal される。React ツリー上はここなので、中のクリックは
            行の onClick まで伝播する（器側の stopPropagation で閉じないようにしている）。 */}
        {selection?.kind === 'flow' ? (
          <TimelineFlowPopover
            dot={selection.dot}
            selectedFlow={selectedFlow}
            above={popoverAbove}
            anchor={selection.anchor}
            accountById={accountById}
            currency={currency}
            onClose={() => onSelect(null)}
            onSelectFlow={(flow) => onSelect({ ...selection, flowId: flow.id })}
            onOpenTarget={onOpenTarget}
          />
        ) : selection?.kind === 'generation' ? (
          <TimelineGenerationPopover
            dot={selection.dot}
            selectedItemId={selection.itemId}
            anchor={selection.anchor}
            currency={currency}
            onClose={() => onSelect(null)}
            onSelectItem={(itemId) => onSelect({ ...selection, itemId })}
            onOpenTarget={onOpenTarget}
          />
        ) : null}
      </div>
    </div>
  );
}

export interface TimelinePopoverPlacement {
  top: number;
  left: number;
  placement: 'above' | 'below';
}

function clampToViewport(value: number, size: number, extent: number): number {
  return Math.max(POPOVER_MARGIN, Math.min(value, extent - size - POPOVER_MARGIN));
}

/**
 * ポップオーバーの **viewport 座標**（position: fixed 用）。
 *
 * 表のスクロール枠の中に置くと上端・下端で切られる（実機で発生）。body へ portal し、
 * ここで viewport 端にクランプ／反転して「必ず画面内に収まる」を座標側の不変則にする。
 * preferAbove は接続線が下の行へ伸びる選択（線とポップオーバーを重ねない）の希望であって、
 * 収まらないときは反対側へ反転する。どちらも収まらないときはクランプに委ねる。
 * 実測に依らない純関数なので、テストが座標を直接固定できる。
 */
export function timelinePopoverPlacement(
  anchor: { top: number; bottom: number; left: number; width: number },
  size: { width: number; height: number },
  viewport: { width: number; height: number },
  preferAbove: boolean,
): TimelinePopoverPlacement {
  const needed = size.height + POPOVER_GAP;
  const spaceAbove = anchor.top - POPOVER_MARGIN;
  const spaceBelow = viewport.height - anchor.bottom - POPOVER_MARGIN;
  const above = preferAbove
    ? !(spaceAbove < needed && spaceBelow > spaceAbove)
    : spaceBelow < needed && spaceAbove > spaceBelow;
  return {
    top: clampToViewport(
      above ? anchor.top - POPOVER_GAP - size.height : anchor.bottom + POPOVER_GAP,
      size.height,
      viewport.height,
    ),
    left: clampToViewport(
      anchor.left + anchor.width / 2 - size.width / 2,
      size.width,
      viewport.width,
    ),
    placement: above ? 'above' : 'below',
  };
}

/**
 * ポップオーバーの器。**body へ portal** して親のスクロール枠から脱出させ、位置は
 * アンカー実測からの fixed 座標で置く。
 *
 * 追従はしない（iOS のポップオーバーと同じ）: スクロール・リサイズ・外側タップ・Esc で閉じる。
 * 端末 Back は overlays 登録簿（useRegisterOverlay）が拾い、ポップオーバーだけを閉じる
 * ＝画面ごと遷移しない。
 */
function TimelinePopoverShell({
  anchor,
  preferAbove,
  onClose,
  children,
}: {
  anchor: HTMLElement;
  preferAbove: boolean;
  onClose: () => void;
  children: ReactNode;
}) {
  useRegisterOverlay(onClose);
  const ref = useRef<HTMLDivElement | null>(null);
  const closeRef = useRef(onClose);
  const [placed, setPlaced] = useState<TimelinePopoverPlacement>(() => ({
    top: POPOVER_MARGIN,
    left: POPOVER_MARGIN,
    placement: preferAbove ? 'above' : 'below',
  }));

  useEffect(() => {
    closeRef.current = onClose;
  });

  const reposition = useCallback(() => {
    const element = ref.current;
    if (!element) return;
    const box = element.getBoundingClientRect();
    const next = timelinePopoverPlacement(
      anchor.getBoundingClientRect(),
      { width: box.width, height: box.height },
      { width: window.innerWidth, height: window.innerHeight },
      preferAbove,
    );
    setPlaced((current) =>
      current.top === next.top && current.left === next.left && current.placement === next.placement
        ? current
        : next,
    );
  }, [anchor, preferAbove]);

  // 初回に実測して置き直し、以後は**自分の大きさが変わったとき**だけ計算し直す
  // （フローを選ぶと「開く」が生えて背が変わる）。値が同じなら state を触らない。
  useLayoutEffect(() => {
    reposition();
    const element = ref.current;
    if (!element || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(reposition);
    observer.observe(element);
    return () => observer.disconnect();
  }, [reposition]);

  useEffect(() => {
    const close = () => closeRef.current();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') close();
    };
    const onPointerDown = (event: Event) => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      // アンカー自身は除く（同じポッチの再タップは開閉トグルのまま）。
      if (ref.current?.contains(target) === true || anchor.contains(target)) return;
      close();
    };
    const onScroll = (event: Event) => {
      // ポップオーバー内の一覧を送っただけでは閉じない（枠の外が動いたときだけ）。
      if (event.target instanceof Node && ref.current?.contains(event.target) === true) return;
      close();
    };
    document.addEventListener('keydown', onKeyDown);
    document.addEventListener('pointerdown', onPointerDown, true);
    // 表の横スクロールも画面の縦スクロールも拾うため capture で window に張る。
    window.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', close);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      document.removeEventListener('pointerdown', onPointerDown, true);
      window.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('resize', close);
    };
  }, [anchor]);

  return createPortal(
    <div
      ref={ref}
      id={POPOVER_ID}
      className="timeline-calendar__popover"
      style={{ top: placed.top, left: placed.left }}
      data-ui={UI.timeline.popover}
      data-placement={placed.placement}
      onClick={(event) => event.stopPropagation()}
    >
      {children}
    </div>,
    document.body,
  );
}

function TimelineFlowPopover({
  dot,
  selectedFlow,
  above,
  anchor,
  accountById,
  currency,
  onClose,
  onSelectFlow,
  onOpenTarget,
}: {
  dot: TimelineDotView;
  selectedFlow?: TimelineFlowView;
  above: boolean;
  anchor: HTMLElement;
  accountById: ReadonlyMap<string, Account>;
  currency: string;
  onClose: () => void;
  onSelectFlow: (flow: TimelineFlowView) => void;
  onOpenTarget: (target: TimelineOpenTarget) => void;
}) {
  const digits = useMoneyDigits();
  const name = (id: string) => accountById.get(id)?.name ?? '—';
  return (
    <TimelinePopoverShell anchor={anchor} preferAbove={above} onClose={onClose}>
      <p className="timeline-calendar__popover-title">
        {t('timeline.flowCount', { count: dot.flows.length })}・
        <span
          className={dot.netChange > 0 ? 'amount--pos' : dot.netChange < 0 ? 'amount--neg' : ''}
        >
          {formatMoney(dot.netChange, currency, digits)}
        </span>
      </p>
      <ul className="list timeline-calendar__flow-list" data-ui={UI.timeline.flowList}>
        {dot.flows.map((flow) => (
          <li key={flow.id}>
            <button
              type="button"
              className="list__row-btn timeline-calendar__flow-button"
              aria-pressed={selectedFlow?.id === flow.id}
              onClick={() => onSelectFlow(flow)}
            >
              <span className="timeline-calendar__flow-main">
                {/* 1 行目 = 摘要（何の仕訳か）。科目の対と日付は 2 行目へ。長い摘要は省略。 */}
                <span className="timeline-calendar__flow-name">{flow.description}</span>
                <span className="timeline-calendar__flow-sub">
                  {t('timeline.flow', {
                    credit: name(flow.sourceAccountId),
                    debit: name(flow.destinationAccountId),
                  })}
                  ・{flow.date}
                </span>
              </span>
              <span>{formatMoney(flow.amount, currency, digits)}</span>
            </button>
          </li>
        ))}
      </ul>
      {selectedFlow?.target !== undefined ? (
        <div className="timeline-calendar__popover-actions">
          <button
            type="button"
            className="btn btn--primary"
            onClick={() => onOpenTarget(selectedFlow.target!)}
            data-ui={UI.timeline.open}
          >
            {t('timeline.open')}
          </button>
        </div>
      ) : null}
    </TimelinePopoverShell>
  );
}

function TimelineGenerationPopover({
  dot,
  selectedItemId,
  anchor,
  currency,
  onClose,
  onSelectItem,
  onOpenTarget,
}: {
  dot: TimelineGenerationDotView;
  selectedItemId?: string;
  anchor: HTMLElement;
  currency: string;
  onClose: () => void;
  onSelectItem: (itemId: string) => void;
  onOpenTarget: (target: TimelineOpenTarget) => void;
}) {
  const digits = useMoneyDigits();
  const selectedItem = dot.items.find((item) => item.id === selectedItemId);
  return (
    <TimelinePopoverShell anchor={anchor} preferAbove={false} onClose={onClose}>
      <p className="timeline-calendar__popover-title">
        {t('timeline.generation')}・{dot.date}
      </p>
      <ul className="list timeline-calendar__flow-list" data-ui={UI.timeline.flowList}>
        {dot.items.map((item) => (
          <li key={item.id}>
            <button
              type="button"
              className="list__row-btn timeline-calendar__flow-button"
              aria-pressed={selectedItem?.id === item.id}
              onClick={() => onSelectItem(item.id)}
            >
              <span className="timeline-calendar__flow-name">{item.name}</span>
              {item.amount !== undefined ? (
                <span>{formatMoney(item.amount, currency, digits)}</span>
              ) : null}
            </button>
          </li>
        ))}
      </ul>
      {selectedItem ? (
        <div className="timeline-calendar__popover-actions">
          <button
            type="button"
            className="btn btn--primary"
            onClick={() => onOpenTarget(selectedItem.target)}
            data-ui={UI.timeline.open}
          >
            {t('timeline.open')}
          </button>
        </div>
      ) : null}
    </TimelinePopoverShell>
  );
}

/** store/domain と描画本体をつなぐ薄い画面 adapter。 */
export function TimelineCalendar({
  period,
  zoom,
  onZoomChange,
  lens,
  onLensChange,
  onPeriodChange,
  onNavigate,
  onOpenEntry,
  onOpenAllocations,
}: TimelineCalendarProps) {
  const { ledger } = useLedger();
  const today = todayLocal();
  /**
   * 窓の中心と、**何回目の送り直しか**。同じ日付へもう一度送ることがある
   * （基準日へ戻る = スクロールで離れたが中心の日付は変わっていない）ので、日付だけでは
   * 「送り直した」を名乗れない。回数を鍵に含めて、同じ日付への送り直しも 1 回として数える。
   */
  const [focus, setFocus] = useState(() => ({ date: centerOfPeriod(period, today), sent: 0 }));
  const center = focus.date;
  /** 窓を（もう一度）その日付へ送る。スクロール位置だけが動き、断面（period）は触らない。 */
  const sendWindowTo = (date: string) => setFocus((current) => ({ date, sent: current.sent + 1 }));
  const [showEnded, setShowEnded] = useState(false);
  const baseRange = useMemo(() => rangeAround(center, zoom), [center, zoom]);
  /**
   * 窓の同一性 = **送り直したか**（ズーム変更・左右ボタン・年列ドリル・基準日へ戻る）。
   * 連続スクロールの継ぎ足しでは変えない: これが変わると各レンズが中心へスクロールし直すので、
   * 伸ばすたびに画面が飛ぶ。範囲そのもの（from/to）を鍵にしてはいけないのはそのため。
   */
  const anchorKey = `${zoom}:${center}:${focus.sent}`;
  /** 数値レンズだけでなく**全レンズ**の左の下限（= データのある最初の年）。 */
  const floorDate = useMemo(() => matrixFloorDate(ledger, today), [ledger, today]);
  const [growth, setGrowth] = useState<WindowGrowth>(() => ({ ...NO_GROWTH, key: anchorKey }));
  const range = useMemo(
    () => grownRange(baseRange, zoom, growth.key === anchorKey ? growth : NO_GROWTH, floorDate),
    [anchorKey, baseRange, floorDate, growth, zoom],
  );
  /**
   * 端に近づいた = 窓をその側へ 1 段伸ばす（`horizonScroll` の共通機構から呼ばれる）。
   * 上限・下限に貼り付いていて実際には範囲が動かないときは state を触らない
   * （スクロールのたびに再描画を作らない = 端で指が止まらない）。
   */
  const extendWindow = useCallback(
    (edge: ScrollEdge) => {
      setGrowth((current) => {
        const from: WindowGrowth =
          current.key === anchorKey ? current : { ...NO_GROWTH, key: anchorKey };
        if (from.before + from.after >= MAX_EXTEND_STEPS[zoom]) return current;
        const next: WindowGrowth =
          edge === 'start'
            ? { ...from, before: from.before + 1 }
            : { ...from, after: from.after + 1 };
        const grown = grownRange(baseRange, zoom, next, floorDate);
        const previous = grownRange(baseRange, zoom, from, floorDate);
        if (grown.from === previous.from && grown.to === previous.to) return current;
        return next;
      });
    },
    [anchorKey, baseRange, floorDate, zoom],
  );
  const [visibleWindow, setVisibleWindow] = useState(() => ({
    key: anchorKey,
    from: range.from,
    to: range.to,
  }));
  // 実際に見えている範囲の中心。窓送りとズーム変更の起点（画面内セグメントだった頃に
  // その場で実測していたものを state にした = ヘッダーから変わっても「いま見ている時点」を保つ）。
  const [visibleCenter, setVisibleCenter] = useState(center);
  // 可視範囲は**日付**なので、窓を継ぎ足しても意味を失わない（鍵は anchorKey で足りる）。
  const visibleRange =
    visibleWindow.key === anchorKey
      ? { from: visibleWindow.from, to: visibleWindow.to }
      : { from: range.from, to: range.to };
  /**
   * 基準日（ヘッダーの断面日付）が可視範囲の外にあるか。ジャンプのボタンは**このときだけ**
   * 出す（常時表示ではなく警告灯型 = ヘッダーの「今日」と同じ既存規約）。
   */
  const basisDate = basisDateOf(period, today);
  const basisOutOfView = basisDate < visibleRange.from || visibleRange.to < basisDate;
  const updateVisibleRange = useCallback(
    (next: { from: string; to: string }) => {
      setVisibleWindow((current) =>
        current.key === anchorKey && current.from === next.from && current.to === next.to
          ? current
          : { key: anchorKey, from: next.from, to: next.to },
      );
      setVisibleCenter(midpoint(next.from, next.to));
    },
    [anchorKey],
  );

  // ヘッダーのズームが変わったら、見えていた時点を中心に窓を組み直す（render 中の派生調整
  // パターン。effect での setState を避ける）。年列タップのドリルだけは行き先を明示するので、
  // 見えていた中心ではなくその年を中心に置く（同じ 1 回の操作で set されるので取りこぼさない）。
  const [pendingZoomFocus, setPendingZoomFocus] = useState<string | null>(null);
  const [trackedZoom, setTrackedZoom] = useState(zoom);
  if (trackedZoom !== zoom) {
    setTrackedZoom(zoom);
    sendWindowTo(pendingZoomFocus ?? visibleCenter);
    if (pendingZoomFocus !== null) setPendingZoomFocus(null);
  }
  const displayBuckets = useMemo(
    () =>
      buildTimelineBuckets({ start: range.from, end: range.to }, zoom).map((bucket) => ({
        key: bucket.key,
        from: bucket.startDate,
        to: bucket.endDate,
      })),
    [range.from, range.to, zoom],
  );

  // 数値レンズの列窓。線分レンズと同じ窓（`grownRange`）を使い、下端だけデータの最初の年で
  // 止める（= スクロール可能範囲はデータ年〜HARD_CAP）。日ズームで数値レンズは選べないが、
  // 万一来ても月列へ落として表を壊さない。
  const matrixZoom: Extract<TimelineZoom, 'month' | 'year'> = zoom === 'year' ? 'year' : 'month';
  const matrixScope = useMemo<PeriodMatrixScope>(() => {
    const from = range.from < floorDate ? floorDate : range.from;
    const to = range.to < from ? from : range.to;
    return matrixZoom === 'year'
      ? { mode: 'all', years: yearsBetween(from, to) }
      : { mode: 'months', months: monthsBetween(from, to) };
  }, [floorDate, matrixZoom, range.from, range.to]);
  const matrixAsOf = periodMatrixAsOf(matrixScope, today);
  // グラフレンズの断面は線分レンズと同じバケット（日/月/年すべて描ける）。最終バケットの
  // 末日まで展開しないと右端の断面が欠けるので、数値レンズと同じく窓の全体を要求する。
  const chartAsOf = displayBuckets.at(-1)?.to ?? today;

  // 仕訳の仮想展開はレンズによらず 1 回だけ。線分は「見えている右端」まで、
  // 数値・グラフは「最終列/最終バケットの末日」まで（右端に空白を作らないため窓の全体が要る）。
  const displayAsOf =
    lens === 'matrix' ? matrixAsOf : lens === 'chart' ? chartAsOf : visibleRange.to;
  const display = useMemo(
    () => (ledger ? displayEntriesResultForAsOf(ledger, displayAsOf) : null),
    [displayAsOf, ledger],
  );

  const matrix = useMemo(
    () =>
      ledger && lens === 'matrix'
        ? buildPeriodMatrix(ledger.accounts, display?.entries ?? [], matrixScope)
        : null,
    [display, ledger, lens, matrixScope],
  );

  // グラフレンズの断面。数値レンズと同じ集計エンジンへ、線分レンズと同じバケットを渡す
  // （列ごとに deriveBalanceSheet を回さず、日付順の単一走査で焼き付ける）。
  const series = useMemo(
    () =>
      ledger && lens === 'chart'
        ? buildPeriodMatrix(ledger.accounts, display?.entries ?? [], {
            mode: 'buckets',
            buckets: displayBuckets,
          })
        : null,
    [display, displayBuckets, ledger, lens],
  );

  const model = useMemo<TimelineCalendarViewModel>(() => {
    if (!ledger || lens !== 'segment') return { buckets: [], boxes: [] };
    const boxes = TIMELINE_ACCOUNT_BOXES.map((box) => ({
      key: box.key,
      accountIds: ledger.accounts.filter(box.includes).map((account) => account.id),
      ...(box.key === 'continuingCost' ? { kind: 'continuousCost' as const } : {}),
    }));
    const calculated = buildTimelineCalendar({
      accounts: ledger.accounts,
      entries: display?.entries ?? [],
      monthlyCostItems: ledger.monthlyCostItems,
      recurringRules: ledger.recurringRules,
      boxes,
      range: { start: visibleRange.from, end: visibleRange.to },
      zoom,
      showOutsideRange: showEnded,
    });
    return timelineViewModel(calculated, { start: range.from, end: range.to }, displayBuckets);
  }, [
    displayBuckets,
    display,
    ledger,
    lens,
    range.from,
    range.to,
    showEnded,
    visibleRange.from,
    visibleRange.to,
    zoom,
  ]);

  /*
   * ── 3 レンズ共通のラベル列（v13.6 H3）──
   * 行の集合・並び・開閉・チェックは**画面が 1 つだけ持つ**。レンズを切り替えても、
   * 同じ木・同じ開閉・同じチェックのまま右ペインの描画だけが入れ替わる。
   * どちらも画面ローカルで保存しない（既定 = 全部たたんだ状態・全部 ON）。
   */
  const [expandedRows, setExpandedRows] = useState<ReadonlySet<string>>(() => new Set<string>());
  /** チェックが**外れている**行。既定は全 ON なので、持つのは OFF の側だけ。 */
  const [hiddenRows, setHiddenRows] = useState<ReadonlySet<string>>(() => new Set<string>());
  const toggleRow = useCallback((id: string) => {
    setExpandedRows((current) => {
      const next = new Set(current);
      if (!next.delete(id)) next.add(id);
      return next;
    });
  }, []);
  const checkRow = useCallback((id: string, checked: boolean) => {
    setHiddenRows((current) => {
      const next = new Set(current);
      if (checked) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  /**
   * 行に出す科目。**レンズによらず同じ絞り込み**（窓に重なる存在期間だけ / 「終了分も表示」で
   * 全部）。ここでレンズごとに違う条件を書くと「レンズごとの独自ラベル列」が戻ってくる。
   */
  const rowAccounts = useMemo(() => {
    const all = ledger?.accounts ?? [];
    if (showEnded) return all;
    return all.filter((account) => {
      // 旧 archived で終了日が復元できない科目は、線分が描けないので通常表示から外す。
      if (account.archived && account.endDate === undefined) return false;
      const startsAfter = account.startDate !== undefined && account.startDate > visibleRange.to;
      const endedBefore = account.endDate !== undefined && account.endDate < visibleRange.from;
      return !startsAfter && !endedBefore;
    });
  }, [ledger, showEnded, visibleRange.from, visibleRange.to]);

  const rowTree = useMemo(
    () =>
      buildLensRowTree(rowAccounts, {
        // 継続コスト台帳の中身（定期ルール → 月割り項目）は科目ではないので線分レンズだけ。
        extraChildren: (boxKey) =>
          lens === 'segment' ? continuousCostChildren(model.boxes, boxKey) : [],
      }),
    [lens, model.boxes, rowAccounts],
  );
  const rowViews = useMemo(
    () =>
      buildLensRowViews({
        tree: rowTree,
        expanded: expandedRows,
        hidden: hiddenRows,
        // グラフはストック（残高の断面）しか描けない。フロー行は形式が決まるまで選べない。
        ...(lens === 'chart'
          ? {
              disabledReason: (node: LensRowNode) =>
                node.stock ? undefined : t('lens.flowNotPlottable'),
            }
          : {}),
      }),
    [expandedRows, hiddenRows, lens, rowTree],
  );

  // 年列タップ = その年を月ズームで見る（旧「全体 → その年の年間表示へ」のドリルの後継）。
  // ズームは App が持つので、行き先の中心を預けてから切り替える（同じ 1 回の更新で届く）。
  const openMatrixYear = (year: number) => {
    const target = clampTimelineDate(`${String(year).padStart(4, '0')}-07-01`);
    if (zoom === 'month') {
      sendWindowTo(target);
      return;
    }
    setPendingZoomFocus(target);
    onZoomChange('month');
  };

  // 「開く」先の分岐。TimelineTarget は導出行の起票元（derivedEntryOrigin）と同じ union
  // なので、種類が増えるとここが型エラーで落ちる（黙って捨てる・空 ID で誤遷移する余地を残さない）。
  const openTarget = (target: TimelineOpenTarget) => {
    switch (target.kind) {
      case 'entry':
        onOpenEntry(target.entryId);
        return;
      case 'monthlyCost':
        onOpenAllocations({ itemId: target.monthlyCostId });
        return;
      case 'recurringRule':
        onOpenAllocations({ ruleId: target.recurringRuleId });
        return;
      case 'adjustmentEntry':
        // 按分スライスは宣言した補正仕訳（stored）へ。既存の resolver が補正シートを開く。
        onOpenEntry(target.entryId);
        return;
    }
  };

  return (
    <section
      className="timeline-calendar"
      aria-labelledby="timeline-calendar-title"
      data-ui={UI.timeline.view}
    >
      {/* タイトル行の右は空いているので、窓の「現在地」を戻す導線をここへ置く。
          ヘッダーの「今日」（断面そのものを動かす）とは別物なので、ヘッダーには足さない。 */}
      <div className="timeline-calendar__title-row">
        <h1 className="screen-title" id="timeline-calendar-title">
          {t('timeline.title')}
        </h1>
        {basisOutOfView ? (
          <>
            <button
              type="button"
              className="btn btn--ghost timeline-calendar__back-to-basis"
              aria-describedby="timeline-back-to-basis-hint"
              onClick={() => sendWindowTo(basisDate)}
              data-ui={UI.timeline.backToBasis}
            >
              {t('timeline.backToBasis', { date: basisDate })}
            </button>
            <span className="sr-only" id="timeline-back-to-basis-hint">
              {t('timeline.backToBasisHint', { date: basisDate })}
            </span>
          </>
        ) : null}
      </div>
      <p className="field__hint" style={{ marginBottom: 'var(--space-3)' }}>
        {t('timeline.intro')}
      </p>
      {/* レンズ（見え方）と窓送り。ズーム（日/月/年）はヘッダーにあり、ここには置かない
          （同じ意味のボタンを 2 つ出さない）。
          左右ボタンは v13.6 H2-3 の連続スクロール後も残す: (a) キーボード・支援技術からの
          フォールバック (b) 継ぎ足しの上限（MAX_EXTEND_STEPS）に達したあとの唯一の移動手段。
          押すと窓ごと送り直す（= 継ぎ足しは 0 に戻る）ので、伸ばし続けても DOM は肥大しない。 */}
      <div className="toolbar timeline-calendar__controls">
        <div className="timeline-calendar__lens" role="group" aria-label={t('timeline.lens')}>
          <Segmented
            value={lens}
            items={(
              [
                ['segment', 'timeline.lens.segment', UI.timeline.lensSegment],
                ['matrix', 'timeline.lens.matrix', UI.timeline.lensMatrix],
                ['chart', 'timeline.lens.chart', UI.timeline.lensChart],
              ] as const
            ).map(([key, labelKey, dataUi]) => ({ key, label: t(labelKey), dataUi }))}
            onChange={(value) => onLensChange(timelineLensOf(value))}
          />
        </div>
        <div className="row-actions">
          <button
            type="button"
            className="btn btn--ghost timeline-calendar__range-button"
            aria-label={t('timeline.previous')}
            onClick={() => sendWindowTo(shiftCenter(visibleCenter, zoom, -1))}
            data-ui={UI.timeline.previous}
          >
            <span aria-hidden="true">←</span>
          </button>
          <button
            type="button"
            className="btn btn--ghost timeline-calendar__range-button"
            aria-label={t('timeline.next')}
            onClick={() => sendWindowTo(shiftCenter(visibleCenter, zoom, 1))}
            data-ui={UI.timeline.next}
          >
            <span aria-hidden="true">→</span>
          </button>
        </div>
      </div>

      {/* 「終了分も表示」は行の集合を決めるので、レンズの外（3 レンズ共通）に置く。 */}
      <label className="timeline-calendar__show-ended">
        <input
          type="checkbox"
          checked={showEnded}
          onChange={(event) => setShowEnded(event.target.checked)}
          data-ui={UI.timeline.showEnded}
        />
        {t('timeline.showEnded')}
      </label>

      {lens === 'chart' ? (
        <>
          {/* 仮の数字が本物の顔をしない: 折れ線に何が混ざるかをグラフの手前で名乗る。 */}
          {chartAsOf > today ? (
            <p className="field__hint" data-ui={UI.timeline.chartNote}>
              {t('matrix.projectionNote')}
            </p>
          ) : null}
          {series ? (
            <StockSeriesChart
              series={series}
              rows={rowViews}
              onToggleRow={toggleRow}
              onCheckRow={checkRow}
              zoom={zoom}
              bucketWidth={BUCKET_WIDTH[zoom]}
              currency={ledger?.settings.currency ?? ''}
              focusDate={center}
              windowKey={anchorKey}
              onVisibleRangeChange={updateVisibleRange}
              onExtend={extendWindow}
            />
          ) : (
            <p className="muted period-matrix__empty">{t('matrix.noData')}</p>
          )}
        </>
      ) : lens === 'matrix' ? (
        <>
          {/* 仮の数字が本物の顔をしない: 表に何が混ざるかを表の手前で名乗る。 */}
          {matrixAsOf > today ? (
            <p className="field__hint" data-ui={UI.timeline.matrixNote}>
              {t('matrix.projectionNote')}
            </p>
          ) : null}
          {matrix ? (
            <PeriodMatrixTable
              matrix={matrix}
              rows={rowViews}
              onToggleRow={toggleRow}
              onCheckRow={checkRow}
              currency={ledger?.settings.currency ?? ''}
              focusDate={center}
              windowKey={anchorKey}
              onOpenMonth={(asOf) => {
                onPeriodChange({ mode: 'date', date: asOf });
                onNavigate('dashboard');
              }}
              onOpenYear={openMatrixYear}
              onVisibleRangeChange={updateVisibleRange}
              onExtend={extendWindow}
            />
          ) : (
            <p className="muted period-matrix__empty">{t('matrix.noData')}</p>
          )}
        </>
      ) : (
        <TimelineCalendarView
          model={model}
          rows={rowViews}
          onToggleRow={toggleRow}
          onCheckRow={checkRow}
          zoom={zoom}
          today={today}
          accounts={ledger?.accounts ?? []}
          currency={ledger?.settings.currency ?? ''}
          onOpenTarget={openTarget}
          onVisibleRangeChange={updateVisibleRange}
          onExtend={extendWindow}
          focusDate={center}
          windowKey={anchorKey}
        />
      )}
      <ScrollTopButton />
    </section>
  );
}
