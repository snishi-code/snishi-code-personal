/*
 * タイムラインカレンダー。
 *
 * 画面は表示範囲と開閉状態だけを持ち、帯・ポッチ・純増減の計算は
 * domain/timelineCalendar に委ねる。ヘッダー日付は初期位置にだけ使い、この画面の
 * 前後移動・ズームで共有期間は書き換えない。
 */
import { useCallback, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { Segmented } from '@snishi/foundation/ui/Segmented';
import { Icon } from '@snishi/foundation/ui/Icon';
import { useLedger } from '../../state/store';
import { displayEntriesForAsOf } from '../../domain/reportEntries';
import { CONTINUOUS_COST_HARD_CAP } from '../../domain/continuousCost';
import {
  buildTimelineCalendar,
  buildTimelineBuckets,
  type TimelineCalendar as DomainTimelineCalendar,
  type TimelineTarget,
  type TimelineZoom,
} from '../../domain/timelineCalendar';
import { todayLocal } from '../../util/time';
import { formatMoney } from '../../util/format';
import { t } from '../../i18n';
import { UI } from '../../ui-contract';
import { TIMELINE_ACCOUNT_BOXES, timelineBoxForAccount, type AccountAccent } from '../accountBoxes';
import type { Account, MonthlyCostItem, RecurringRule } from '../../domain/types';
import type { ReportPeriod } from '../../domain/reportPeriod';

export type { TimelineZoom } from '../../domain/timelineCalendar';

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
  onOpenEntry: (entryId: string) => void;
  onOpenAllocations: (target: { itemId?: string; ruleId?: string }) => void;
  /** 投資利回りの投影行の「開く」: その利回りを宣言した投資科目の編集シートへ。 */
  onOpenAccount: (accountId: string) => void;
}

interface RenderRow {
  id: string;
  kind: 'box' | 'account' | 'rule' | 'item';
  boxKey: string;
  label: string;
  accent: AccountAccent;
  spans: TimelineSpanView[];
  dots: TimelineDotView[];
  generationDots: TimelineGenerationDotView[];
  accountId?: string;
}

interface FlowSelection {
  kind: 'flow';
  rowId: string;
  dot: TimelineDotView;
  flowId?: string;
}

interface GenerationSelection {
  kind: 'generation';
  rowId: string;
  dot: TimelineGenerationDotView;
  itemId?: string;
}

type Selection = FlowSelection | GenerationSelection;

const BUCKET_WIDTH: Record<TimelineZoom, number> = { day: 44, month: 80, year: 96 };
const ROW_HEIGHT = 52;
const TIMELINE_MIN_DATE = '0001-01-01';

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

function centerOfPeriod(period: ReportPeriod, today: string): string {
  if (period.mode === 'date') return clampTimelineDate(period.date);
  if (period.mode === 'year')
    return clampTimelineDate(`${String(period.year).padStart(4, '0')}-07-01`);
  return clampTimelineDate(today);
}

/**
 * 青天井のルールを日単位で 2100 年まで DOM 化しないための有限窓。
 * 前後ボタンで同じ幅ずつ送れるため、見たい時点へ到達できる。
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

function flattenRows(boxes: TimelineBoxView[], expanded: ReadonlySet<string>): RenderRow[] {
  const boxUiByKey = new Map(TIMELINE_ACCOUNT_BOXES.map((box) => [box.key, box] as const));
  const rows: RenderRow[] = [];
  for (const box of boxes) {
    const boxUi = boxUiByKey.get(box.key as (typeof TIMELINE_ACCOUNT_BOXES)[number]['key']);
    if (!boxUi) continue;
    rows.push({
      id: `box:${box.key}`,
      kind: 'box',
      boxKey: box.key,
      label: t(boxUi.labelKey),
      accent: boxUi.accent,
      spans: box.spans,
      dots: box.dots,
      generationDots: [],
    });
    if (!expanded.has(box.key)) continue;

    if (box.continuousCost) {
      for (const group of box.continuousCost.rules) {
        rows.push({
          id: `rule:${group.rule.id}`,
          kind: 'rule',
          boxKey: box.key,
          label: group.rule.name,
          accent: boxUi.accent,
          spans: group.spans,
          dots: [],
          generationDots: group.generationDots,
        });
        for (const child of group.items) {
          rows.push({
            id: `item:${child.item.id}`,
            kind: 'item',
            boxKey: box.key,
            label: child.item.name,
            accent: boxUi.accent,
            spans: child.spans,
            dots: child.dots,
            generationDots: [],
          });
        }
      }
      for (const child of box.continuousCost.unlinkedItems) {
        rows.push({
          id: `item:${child.item.id}`,
          kind: 'item',
          boxKey: box.key,
          label: child.item.name,
          accent: boxUi.accent,
          spans: child.spans,
          dots: child.dots,
          generationDots: [],
        });
      }
      continue;
    }

    for (const child of box.accounts) {
      rows.push({
        id: `account:${child.account.id}`,
        kind: 'account',
        boxKey: box.key,
        label: child.account.name,
        accent: boxUi.accent,
        spans: child.spans,
        dots: child.dots,
        generationDots: [],
        accountId: child.account.id,
      });
    }
  }
  return rows;
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
  const labelWidth = viewport.clientWidth <= 480 ? 116 : 132;
  const visibleTrackWidth = Math.max(0, viewport.clientWidth - labelWidth);
  const firstIndex = Math.max(
    0,
    Math.min(buckets.length - 1, Math.floor(viewport.scrollLeft / bucketWidth)),
  );
  const lastIndex = Math.max(
    firstIndex,
    Math.min(
      buckets.length - 1,
      Math.ceil((viewport.scrollLeft + visibleTrackWidth) / bucketWidth) - 1,
    ),
  );
  const first = buckets[firstIndex];
  const last = buckets[lastIndex];
  return first && last ? { from: first.from, to: last.to } : undefined;
}

/**
 * domain model を受ける描画本体。配置先や store に依存しないため、
 * 将来ハンバーガー以外へ移してもこのコンポーネントは変えない。
 */
export function TimelineCalendarView({
  model,
  zoom,
  onZoomChange,
  onPrevious,
  onNext,
  showEnded,
  onShowEndedChange,
  today,
  accounts,
  currency,
  onOpenTarget,
  onVisibleRangeChange,
  focusDate,
}: {
  model: TimelineCalendarViewModel;
  zoom: TimelineZoom;
  onZoomChange: (zoom: TimelineZoom, visibleCenter: string) => void;
  onPrevious: (visibleCenter: string) => void;
  onNext: (visibleCenter: string) => void;
  showEnded: boolean;
  onShowEndedChange: (show: boolean) => void;
  today: string;
  accounts: Account[];
  currency: string;
  onOpenTarget: (target: TimelineOpenTarget) => void;
  /** 実際に viewport 内へ見えている横軸。行の存在期間フィルタへ返す。 */
  onVisibleRangeChange?: (range: { from: string; to: string }) => void;
  /** ヘッダー日付または窓送り後の中心。初期スクロール位置にだけ使う。 */
  focusDate?: string;
}) {
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const [selection, setSelection] = useState<Selection | null>(null);
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const visibleCenterRef = useRef(
    model.buckets[Math.floor(model.buckets.length / 2)]?.from ?? today,
  );
  const bucketWidth = BUCKET_WIDTH[zoom];
  const rows = useMemo(() => flattenRows(model.boxes, expanded), [expanded, model.boxes]);
  const accountById = useMemo(
    () => new Map(accounts.map((account) => [account.id, account] as const)),
    [accounts],
  );
  const trackWidth = model.buckets.length * bucketWidth;
  const firstBucketFrom = model.buckets[0]?.from;
  const lastBucketTo = model.buckets.at(-1)?.to;
  const windowCenter =
    focusDate ??
    (() => {
      const centerBucket = model.buckets[Math.floor(model.buckets.length / 2)];
      return centerBucket ? midpoint(centerBucket.from, centerBucket.to) : today;
    })();

  const readViewport = useCallback(
    (viewport: HTMLDivElement): string => {
      if (model.buckets.length === 0) return visibleCenterRef.current;
      const labelWidth = viewport.clientWidth <= 480 ? 116 : 132;
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

  // 窓を送ったときとズーム時は、中央日付が見える位置から始める。
  useLayoutEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    const focusX = positionForDate(model.buckets, windowCenter, bucketWidth);
    const labelWidth = viewport.clientWidth <= 480 ? 116 : 132;
    const middle = Math.max(0, focusX - Math.max(0, viewport.clientWidth - labelWidth) / 2);
    viewport.scrollLeft = middle;
    visibleCenterRef.current = windowCenter;
    readViewport(viewport);
  }, [
    bucketWidth,
    firstBucketFrom,
    lastBucketTo,
    model.buckets,
    readViewport,
    trackWidth,
    windowCenter,
  ]);

  // 画面回転やコンテナ幅の変化でも、物理的に見えている期間へ行とポッチを追従させる。
  useLayoutEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => readViewport(viewport));
    observer.observe(viewport);
    return () => observer.disconnect();
  }, [readViewport]);

  const captureVisibleCenter = () => {
    const viewport = viewportRef.current;
    return viewport ? readViewport(viewport) : visibleCenterRef.current;
  };

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
        source.accountId === selectedFlow.sourceAccountId
          ? selectedFlow.destinationAccountId
          : selectedFlow.sourceAccountId;
    } else if (source.kind === 'box') {
      const sourceBox = accountBoxKey(selectedFlow.sourceAccountId);
      otherAccountId =
        sourceBox === source.boxKey
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
  const connectorX = (selectedBucketIndex + 0.5) * bucketWidth;
  const todayX =
    model.buckets[0] &&
    model.buckets.at(-1) &&
    model.buckets[0].from <= today &&
    today <= model.buckets.at(-1)!.to
      ? positionForDate(model.buckets, today, bucketWidth)
      : undefined;

  return (
    <>
      <div className="toolbar timeline-calendar__controls">
        <div className="timeline-calendar__zoom" role="group" aria-label={t('timeline.zoom')}>
          <Segmented
            value={zoom}
            items={(
              [
                ['day', 'timeline.zoom.day', UI.timeline.zoomDay],
                ['month', 'timeline.zoom.month', UI.timeline.zoomMonth],
                ['year', 'timeline.zoom.year', UI.timeline.zoomYear],
              ] as const
            ).map(([key, labelKey, dataUi]) => ({
              key,
              label: t(labelKey),
              dataUi,
            }))}
            onChange={(value) => {
              setSelection(null);
              onZoomChange(
                value === 'month' || value === 'year' ? value : 'day',
                captureVisibleCenter(),
              );
            }}
          />
        </div>
        <div className="row-actions">
          <button
            type="button"
            className="btn btn--ghost timeline-calendar__range-button"
            aria-label={t('timeline.previous')}
            onClick={() => {
              setSelection(null);
              onPrevious(captureVisibleCenter());
            }}
            data-ui={UI.timeline.previous}
          >
            <span aria-hidden="true">←</span>
          </button>
          <button
            type="button"
            className="btn btn--ghost timeline-calendar__range-button"
            aria-label={t('timeline.next')}
            onClick={() => {
              setSelection(null);
              onNext(captureVisibleCenter());
            }}
            data-ui={UI.timeline.next}
          >
            <span aria-hidden="true">→</span>
          </button>
        </div>
      </div>

      <label className="timeline-calendar__show-ended">
        <input
          type="checkbox"
          checked={showEnded}
          onChange={(event) => {
            setSelection(null);
            onShowEndedChange(event.target.checked);
          }}
          data-ui={UI.timeline.showEnded}
        />
        {t('timeline.showEnded')}
      </label>

      <div
        ref={viewportRef}
        className="timeline-calendar__viewport card"
        role="region"
        tabIndex={0}
        aria-label={t('timeline.title')}
        data-ui={UI.timeline.viewport}
        onScroll={captureVisibleCenter}
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
            {rows.length === 0 ? (
              <div className="timeline-calendar__empty" role="status">
                {t('timeline.empty')}
              </div>
            ) : null}
            {todayX !== undefined ? (
              <div
                className="timeline-calendar__today-line"
                style={{ left: `calc(var(--timeline-label-width) + ${todayX}px)` }}
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
                buckets={model.buckets}
                bucketWidth={bucketWidth}
                expanded={expanded.has(row.boxKey)}
                dimmed={connectedIds !== undefined && !connectedIds.has(row.id)}
                selection={selection?.rowId === row.id ? selection : null}
                accountById={accountById}
                currency={currency}
                onToggleBox={() =>
                  setExpanded((current) => {
                    const next = new Set(current);
                    if (next.has(row.boxKey)) next.delete(row.boxKey);
                    else next.add(row.boxKey);
                    return next;
                  })
                }
                onSelect={setSelection}
                onOpenTarget={onOpenTarget}
              />
            ))}
          </div>
        </div>
      </div>
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
    { label: t('timeline.zoom.year'), groups: yearGroups },
    { label: t('timeline.zoom.month'), groups: monthGroups },
    { label: t('timeline.zoom.day'), groups: dayGroups },
  ];
  return (
    <div>
      {rows.map((row) => (
        <div className="timeline-calendar__header-row" key={row.label}>
          <div className="timeline-calendar__header-label">{row.label}</div>
          {row.groups.map((group) => (
            <div
              className="timeline-calendar__header-cell"
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
  buckets,
  bucketWidth,
  expanded,
  dimmed,
  selection,
  accountById,
  currency,
  onToggleBox,
  onSelect,
  onOpenTarget,
}: {
  row: RenderRow;
  buckets: TimelineBucketView[];
  bucketWidth: number;
  expanded: boolean;
  dimmed: boolean;
  selection: Selection | null;
  accountById: ReadonlyMap<string, Account>;
  currency: string;
  onToggleBox: () => void;
  onSelect: (selection: Selection | null) => void;
  onOpenTarget: (target: TimelineOpenTarget) => void;
}) {
  const rowClass = [
    'timeline-calendar__row',
    row.kind === 'box' ? '' : 'timeline-calendar__row--detail',
    dimmed ? 'timeline-calendar__row--dimmed' : '',
  ]
    .filter(Boolean)
    .join(' ');
  const rowStyle = { '--timeline-accent': row.accent } as CSSProperties;
  const selectedFlow =
    selection?.kind === 'flow'
      ? selection.dot.flows.find((flow) => flow.id === selection.flowId)
      : undefined;

  return (
    <div
      className={rowClass}
      style={rowStyle}
      data-ui={row.kind === 'box' ? UI.timeline.boxRow : UI.timeline.detailRow}
    >
      {row.kind === 'box' ? (
        <button
          type="button"
          className="timeline-calendar__row-label"
          aria-expanded={expanded}
          onClick={onToggleBox}
          data-ui={UI.timeline.boxToggle}
          title={row.label}
        >
          <Icon name={expanded ? 'expand' : 'chevronRight'} size={16} />
          <span className="timeline-calendar__row-label-text">{row.label}</span>
        </button>
      ) : (
        <div
          className={`timeline-calendar__row-label timeline-calendar__row-label--detail${
            row.kind === 'item' ? ' timeline-calendar__row-label--item' : ''
          }`}
          title={row.label}
        >
          <span className="timeline-calendar__row-label-text">{row.label}</span>
        </div>
      )}
      <div className="timeline-calendar__track" onClick={() => onSelect(null)}>
        {row.spans.map((span, index) => {
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
        {row.dots.map((dot) => {
          const index = bucketIndex(buckets, dot.bucketKey);
          if (index < 0) return null;
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
              style={{ left: (index + 0.5) * bucketWidth }}
              aria-label={`${dot.date} ${t('timeline.flowCount', { count: dot.flows.length })}: ${formatMoney(
                dot.netChange,
                currency,
              )}`}
              aria-expanded={selected}
              data-ui={UI.timeline.flowDot}
              key={`${dot.bucketKey}-${dot.date}`}
              onClick={(event) => {
                event.stopPropagation();
                onSelect(
                  selected
                    ? null
                    : {
                        kind: 'flow',
                        rowId: row.id,
                        dot,
                        ...(dot.flows.length === 1 ? { flowId: dot.flows[0]!.id } : {}),
                      },
                );
              }}
            />
          );
        })}
        {row.generationDots.map((dot) => {
          const index = bucketIndex(buckets, dot.bucketKey);
          if (index < 0) return null;
          const selected = selection?.kind === 'generation' && selection.dot === dot;
          return (
            <button
              type="button"
              className="timeline-calendar__dot timeline-calendar__dot--generation"
              style={{ left: (index + 0.5) * bucketWidth }}
              aria-label={`${t('timeline.generation')}: ${dot.date}`}
              aria-expanded={selected}
              data-ui={UI.timeline.generationDot}
              key={dot.id}
              onClick={(event) => {
                event.stopPropagation();
                onSelect(
                  selected
                    ? null
                    : {
                        kind: 'generation',
                        rowId: row.id,
                        dot,
                        ...(dot.items.length === 1 ? { itemId: dot.items[0]!.id } : {}),
                      },
                );
              }}
            />
          );
        })}

        {selection?.kind === 'flow' ? (
          <TimelineFlowPopover
            dot={selection.dot}
            selectedFlow={selectedFlow}
            buckets={buckets}
            bucketWidth={bucketWidth}
            accountById={accountById}
            currency={currency}
            onSelectFlow={(flow) => onSelect({ ...selection, flowId: flow.id })}
            onOpenTarget={onOpenTarget}
          />
        ) : selection?.kind === 'generation' ? (
          <TimelineGenerationPopover
            dot={selection.dot}
            selectedItemId={selection.itemId}
            buckets={buckets}
            bucketWidth={bucketWidth}
            currency={currency}
            onSelectItem={(itemId) => onSelect({ ...selection, itemId })}
            onOpenTarget={onOpenTarget}
          />
        ) : null}
      </div>
    </div>
  );
}

function popoverStyle(
  bucketKey: string,
  buckets: TimelineBucketView[],
  bucketWidth: number,
): CSSProperties {
  const index = bucketIndex(buckets, bucketKey);
  const ratio = buckets.length <= 1 ? 0.5 : index / (buckets.length - 1);
  return {
    left: (index + 0.5) * bucketWidth,
    '--timeline-popover-shift': ratio < 0.2 ? '0%' : ratio > 0.8 ? '-100%' : '-50%',
  } as CSSProperties;
}

function TimelineFlowPopover({
  dot,
  selectedFlow,
  buckets,
  bucketWidth,
  accountById,
  currency,
  onSelectFlow,
  onOpenTarget,
}: {
  dot: TimelineDotView;
  selectedFlow?: TimelineFlowView;
  buckets: TimelineBucketView[];
  bucketWidth: number;
  accountById: ReadonlyMap<string, Account>;
  currency: string;
  onSelectFlow: (flow: TimelineFlowView) => void;
  onOpenTarget: (target: TimelineOpenTarget) => void;
}) {
  const name = (id: string) => accountById.get(id)?.name ?? '—';
  return (
    <div
      className="timeline-calendar__popover"
      style={popoverStyle(dot.bucketKey, buckets, bucketWidth)}
      data-ui={UI.timeline.popover}
      onClick={(event) => event.stopPropagation()}
    >
      <p className="timeline-calendar__popover-title">
        {t('timeline.flowCount', { count: dot.flows.length })}・
        <span
          className={dot.netChange > 0 ? 'amount--pos' : dot.netChange < 0 ? 'amount--neg' : ''}
        >
          {formatMoney(dot.netChange, currency)}
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
              <span>{formatMoney(flow.amount, currency)}</span>
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
    </div>
  );
}

function TimelineGenerationPopover({
  dot,
  selectedItemId,
  buckets,
  bucketWidth,
  currency,
  onSelectItem,
  onOpenTarget,
}: {
  dot: TimelineGenerationDotView;
  selectedItemId?: string;
  buckets: TimelineBucketView[];
  bucketWidth: number;
  currency: string;
  onSelectItem: (itemId: string) => void;
  onOpenTarget: (target: TimelineOpenTarget) => void;
}) {
  const selectedItem = dot.items.find((item) => item.id === selectedItemId);
  return (
    <div
      className="timeline-calendar__popover"
      style={popoverStyle(dot.bucketKey, buckets, bucketWidth)}
      data-ui={UI.timeline.popover}
      onClick={(event) => event.stopPropagation()}
    >
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
              {item.amount !== undefined ? <span>{formatMoney(item.amount, currency)}</span> : null}
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
    </div>
  );
}

/** store/domain と描画本体をつなぐ薄い画面 adapter。 */
export function TimelineCalendar({
  period,
  onOpenEntry,
  onOpenAllocations,
  onOpenAccount,
}: TimelineCalendarProps) {
  const { ledger } = useLedger();
  const today = todayLocal();
  const [zoom, setZoom] = useState<TimelineZoom>('month');
  const [center, setCenter] = useState(() => centerOfPeriod(period, today));
  const [showEnded, setShowEnded] = useState(false);
  const range = useMemo(() => rangeAround(center, zoom), [center, zoom]);
  const rangeKey = `${zoom}:${range.from}:${range.to}`;
  const [visibleWindow, setVisibleWindow] = useState(() => ({
    key: rangeKey,
    from: range.from,
    to: range.to,
  }));
  const visibleRange =
    visibleWindow.key === rangeKey
      ? { from: visibleWindow.from, to: visibleWindow.to }
      : { from: range.from, to: range.to };
  const updateVisibleRange = useCallback(
    (next: { from: string; to: string }) =>
      setVisibleWindow((current) =>
        current.key === rangeKey && current.from === next.from && current.to === next.to
          ? current
          : { key: rangeKey, from: next.from, to: next.to },
      ),
    [rangeKey],
  );
  const displayBuckets = useMemo(
    () =>
      buildTimelineBuckets({ start: range.from, end: range.to }, zoom).map((bucket) => ({
        key: bucket.key,
        from: bucket.startDate,
        to: bucket.endDate,
      })),
    [range.from, range.to, zoom],
  );

  const model = useMemo<TimelineCalendarViewModel>(() => {
    if (!ledger) return { buckets: [], boxes: [] };
    const boxes = TIMELINE_ACCOUNT_BOXES.map((box) => ({
      key: box.key,
      accountIds: ledger.accounts.filter(box.includes).map((account) => account.id),
      ...(box.key === 'continuingCost' ? { kind: 'continuousCost' as const } : {}),
    }));
    const calculated = buildTimelineCalendar({
      accounts: ledger.accounts,
      entries: displayEntriesForAsOf(ledger, visibleRange.to, today),
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
    ledger,
    range.from,
    range.to,
    showEnded,
    today,
    visibleRange.from,
    visibleRange.to,
    zoom,
  ]);

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
      case 'investmentAccount':
        onOpenAccount(target.accountId);
        return;
    }
  };

  return (
    <section
      className="timeline-calendar"
      aria-labelledby="timeline-calendar-title"
      data-ui={UI.timeline.view}
    >
      <h1 className="screen-title" id="timeline-calendar-title">
        {t('timeline.title')}
      </h1>
      <p className="field__hint" style={{ marginBottom: 'var(--space-3)' }}>
        {t('timeline.intro')}
      </p>
      <TimelineCalendarView
        model={model}
        zoom={zoom}
        onZoomChange={(next, visibleCenter) => {
          setCenter(visibleCenter);
          setZoom(next);
        }}
        onPrevious={(visibleCenter) => setCenter(shiftCenter(visibleCenter, zoom, -1))}
        onNext={(visibleCenter) => setCenter(shiftCenter(visibleCenter, zoom, 1))}
        showEnded={showEnded}
        onShowEndedChange={setShowEnded}
        today={today}
        accounts={ledger?.accounts ?? []}
        currency={ledger?.settings.currency ?? 'JPY'}
        onOpenTarget={openTarget}
        onVisibleRangeChange={updateVisibleRange}
        focusDate={center}
      />
    </section>
  );
}
