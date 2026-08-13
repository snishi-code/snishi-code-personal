import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/react';
import { useState } from 'react';
import { TimelineCalendarView, type TimelineZoom } from '../src/ui/screens/TimelineCalendar';
import { ACCOUNT_ACCENTS, TIMELINE_ACCOUNT_BOXES } from '../src/ui/accountBoxes';
import type { Account } from '../src/domain/types';
import { UI } from '../src/ui-contract';
import './setup';

const cash: Account = {
  id: 'cash',
  name: '預金',
  type: 'asset',
  role: 'daily-asset',
  archived: false,
  startDate: '2026-01-01',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

const food: Account = {
  id: 'food',
  name: '食費',
  type: 'expense',
  role: 'expense-category',
  archived: false,
  startDate: '2026-01-01',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

const flow = {
  id: 'entry-1',
  date: '2026-02-10',
  description: '昼のラーメン',
  amount: 120000,
  sourceAccountId: cash.id,
  destinationAccountId: food.id,
  target: { kind: 'entry' as const, entryId: 'entry-1' },
};

const model = {
  buckets: [
    { key: '2026-01', from: '2026-01-01', to: '2026-01-31' },
    { key: '2026-02', from: '2026-02-01', to: '2026-02-28' },
  ],
  boxes: [
    {
      key: 'assetFree',
      spans: [{ from: '2026-01-01', to: '2026-02-28' }],
      dots: [{ bucketKey: '2026-02', date: flow.date, netChange: -1200, flows: [flow] }],
      accounts: [
        {
          account: cash,
          spans: [{ from: '2026-01-01', to: '2026-02-28' }],
          dots: [{ bucketKey: '2026-02', date: flow.date, netChange: -1200, flows: [flow] }],
        },
      ],
    },
    {
      key: 'expense',
      spans: [{ from: '2026-01-01', to: '2026-02-28' }],
      dots: [{ bucketKey: '2026-02', date: flow.date, netChange: 1200, flows: [flow] }],
      accounts: [
        {
          account: food,
          spans: [{ from: '2026-01-01', to: '2026-02-28' }],
          dots: [{ bucketKey: '2026-02', date: flow.date, netChange: 1200, flows: [flow] }],
        },
      ],
    },
  ],
};

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function Harness({ onOpenTarget = () => undefined }: { onOpenTarget?: (target: unknown) => void }) {
  const [zoom, setZoom] = useState<TimelineZoom>('month');
  return (
    <TimelineCalendarView
      model={model}
      zoom={zoom}
      onZoomChange={(next) => setZoom(next)}
      onPrevious={() => undefined}
      onNext={() => undefined}
      showEnded={false}
      onShowEndedChange={() => undefined}
      today="2026-02-15"
      accounts={[cash, food]}
      currency="JPY"
      onOpenTarget={onOpenTarget}
    />
  );
}

describe('TimelineCalendarView', () => {
  it('既存の順序と色を再利用した大きな箱を9分類持つ', () => {
    expect(TIMELINE_ACCOUNT_BOXES).toHaveLength(9);
    expect(TIMELINE_ACCOUNT_BOXES.map((box) => box.key)).toEqual([
      'assetFree',
      'assetFixed',
      'investment',
      'continuingCost',
      'shortTermDebt',
      'longTermDebt',
      'income',
      'expense',
      'equity',
    ]);
  });

  it('箱は既定で畳み、開いた状態をズーム変更後も維持する', () => {
    render(<Harness />);

    const boxToggles = document.querySelectorAll(`[data-ui="${UI.timeline.boxToggle}"]`);
    expect(boxToggles).toHaveLength(2);
    expect(document.querySelectorAll(`[data-ui="${UI.timeline.detailRow}"]`)).toHaveLength(0);

    fireEvent.click(boxToggles[0]!);
    expect(document.querySelectorAll(`[data-ui="${UI.timeline.detailRow}"]`)).toHaveLength(1);
    expect(document.body).toHaveTextContent('預金');

    fireEvent.click(document.querySelector(`[data-ui="${UI.timeline.zoomYear}"]`)!);
    expect(document.querySelectorAll(`[data-ui="${UI.timeline.detailRow}"]`)).toHaveLength(1);
    expect(document.body).toHaveTextContent('預金');
  });

  it('フローのポッチから摘要・矢印・金額を出し、実体の遷移 target を渡す', () => {
    const onOpenTarget = vi.fn();
    render(<Harness onOpenTarget={onOpenTarget} />);

    fireEvent.click(document.querySelector(`[data-ui="${UI.timeline.flowDot}"]`)!);

    // 摘要が 1 行目（何の仕訳か）、科目の対と日付が 2 行目。
    const flowName = document.querySelector('.timeline-calendar__flow-name')!;
    expect(flowName).toHaveTextContent('昼のラーメン');
    const flowSub = document.querySelector('.timeline-calendar__flow-sub')!;
    expect(flowSub).toHaveTextContent('預金 → 食費');
    expect(flowSub).toHaveTextContent('2026-02-10');
    expect(document.querySelector(`[data-ui="${UI.timeline.popover}"]`)).toHaveTextContent(
      '預金 → 食費',
    );
    expect(document.querySelector(`[data-ui="${UI.timeline.popover}"]`)).toHaveTextContent('1,200');
    expect(document.querySelector('.timeline-calendar__connector line')).toBeInTheDocument();
    expect(document.querySelectorAll('.timeline-calendar__row--dimmed')).toHaveLength(0);

    fireEvent.click(document.querySelector(`[data-ui="${UI.timeline.open}"]`)!);
    expect(onOpenTarget).toHaveBeenCalledWith({ kind: 'entry', entryId: 'entry-1' });
  });

  it('箱のアクセントは既存の色の正本を使う', () => {
    render(<Harness />);
    const first = document.querySelector(`[data-ui="${UI.timeline.boxRow}"]`) as HTMLElement;
    expect(first.style.getPropertyValue('--timeline-accent')).toBe(ACCOUNT_ACCENTS.assetFree);
  });

  it('生成ポッチは同じバケットのitemを表示し、実体のルールtargetを渡す', () => {
    const onOpenTarget = vi.fn();
    const recurringRule = {
      id: 'rule-1',
      name: '動画サービス',
      amount: 120000,
      dayOfMonth: 10,
      everyMonths: 1,
      debitAccountId: 'ledger',
      creditAccountId: cash.id,
      spreadExpenseAccountId: food.id,
      startMonth: '2026-01',
      startDate: '2026-01-01',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    };
    const generationModel = {
      buckets: model.buckets,
      boxes: [
        {
          key: 'continuingCost',
          spans: [{ from: '2026-01-01' }],
          dots: [],
          accounts: [],
          continuousCost: {
            rules: [
              {
                rule: recurringRule,
                spans: [{ from: recurringRule.startDate }],
                generationDots: [
                  {
                    id: 'generation-1',
                    bucketKey: '2026-02',
                    date: '2026-02-10',
                    items: [
                      {
                        id: 'item-1',
                        name: '動画サービス 2月分',
                        amount: 120000,
                        target: { kind: 'recurringRule' as const, recurringRuleId: 'rule-1' },
                      },
                    ],
                  },
                ],
                items: [],
              },
            ],
            unlinkedItems: [],
          },
        },
      ],
    };
    render(
      <TimelineCalendarView
        model={generationModel}
        zoom="month"
        onZoomChange={() => undefined}
        onPrevious={() => undefined}
        onNext={() => undefined}
        showEnded={false}
        onShowEndedChange={() => undefined}
        today="2026-02-15"
        accounts={[cash, food]}
        currency="JPY"
        onOpenTarget={onOpenTarget}
      />,
    );

    fireEvent.click(document.querySelector(`[data-ui="${UI.timeline.boxToggle}"]`)!);
    fireEvent.click(document.querySelector(`[data-ui="${UI.timeline.generationDot}"]`)!);
    expect(document.querySelector(`[data-ui="${UI.timeline.popover}"]`)).toHaveTextContent(
      '動画サービス 2月分',
    );
    fireEvent.click(document.querySelector(`[data-ui="${UI.timeline.open}"]`)!);
    expect(onOpenTarget).toHaveBeenCalledWith({
      kind: 'recurringRule',
      recurringRuleId: 'rule-1',
    });
  });

  it('横スクロール位置から実際に見えている日付範囲を親へ返す', () => {
    vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(196);
    const onVisibleRangeChange = vi.fn();
    render(
      <TimelineCalendarView
        model={model}
        zoom="month"
        onZoomChange={() => undefined}
        onPrevious={() => undefined}
        onNext={() => undefined}
        showEnded={false}
        onShowEndedChange={() => undefined}
        today="2026-01-15"
        focusDate="2026-01-15"
        accounts={[cash, food]}
        currency="JPY"
        onOpenTarget={() => undefined}
        onVisibleRangeChange={onVisibleRangeChange}
      />,
    );

    const viewport = document.querySelector(
      `[data-ui="${UI.timeline.viewport}"]`,
    ) as HTMLDivElement;
    viewport.scrollLeft = 80;
    fireEvent.scroll(viewport);
    expect(onVisibleRangeChange).toHaveBeenLastCalledWith({
      from: '2026-02-01',
      to: '2026-02-28',
    });
  });

  it('リサイズで新しく見える期間を親へ返し直す', () => {
    let width = 196;
    let triggerResize: (() => void) | undefined;
    vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockImplementation(() => width);
    vi.stubGlobal(
      'ResizeObserver',
      class {
        constructor(callback: ResizeObserverCallback) {
          triggerResize = () => callback([], this as unknown as ResizeObserver);
        }
        observe() {}
        unobserve() {}
        disconnect() {}
      },
    );
    const onVisibleRangeChange = vi.fn();
    render(
      <TimelineCalendarView
        model={model}
        zoom="month"
        onZoomChange={() => undefined}
        onPrevious={() => undefined}
        onNext={() => undefined}
        showEnded={false}
        onShowEndedChange={() => undefined}
        today="2026-01-15"
        focusDate="2026-01-15"
        accounts={[cash, food]}
        currency="JPY"
        onOpenTarget={() => undefined}
        onVisibleRangeChange={onVisibleRangeChange}
      />,
    );

    width = 276;
    triggerResize?.();
    expect(onVisibleRangeChange).toHaveBeenLastCalledWith({
      from: '2026-01-01',
      to: '2026-02-28',
    });
  });

  it('終了分表示の範囲外線分を表示窓の端へ偽装しない', () => {
    render(
      <TimelineCalendarView
        model={{
          buckets: model.buckets,
          boxes: [{ ...model.boxes[0]!, spans: [{ from: '2024-01-01', to: '2024-12-31' }] }],
        }}
        zoom="month"
        onZoomChange={() => undefined}
        onPrevious={() => undefined}
        onNext={() => undefined}
        showEnded
        onShowEndedChange={() => undefined}
        today="2026-01-15"
        accounts={[cash, food]}
        currency="JPY"
        onOpenTarget={() => undefined}
      />,
    );

    expect(document.querySelectorAll(`[data-ui="${UI.timeline.band}"]`)).toHaveLength(0);
  });

  it('見えている期間が空でも横スクロール領域と時間軸を残す', () => {
    const onVisibleRangeChange = vi.fn();
    render(
      <TimelineCalendarView
        model={{ buckets: model.buckets, boxes: [] }}
        zoom="month"
        onZoomChange={() => undefined}
        onPrevious={() => undefined}
        onNext={() => undefined}
        showEnded={false}
        onShowEndedChange={() => undefined}
        today="2026-01-15"
        accounts={[]}
        currency="JPY"
        onOpenTarget={() => undefined}
        onVisibleRangeChange={onVisibleRangeChange}
      />,
    );

    expect(document.querySelector(`[data-ui="${UI.timeline.viewport}"]`)).toBeInTheDocument();
    expect(document.body).toHaveTextContent('この期間に存在するものはありません。');
    expect(document.body).toHaveTextContent('2026年');
  });
});
