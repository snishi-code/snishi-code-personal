/*
 * 時間平面の**グラフレンズ**（v13.5 F の第 1 段 = ストック 4 系列）。
 *
 * 固定するもの:
 *  - レンズは 3 つ（線分 / 数値 / グラフ）。同時に 2 つの見え方を出さない。
 *  - **ラベル列 = 凡例トグル**。既定 ON は純資産と自由に動かせるお金で、タップで反転する。
 *  - 描かれる線は ON の系列だけ（凡例は見た目のフィルタではなく描画の正本）。
 *  - 値は**バケット末断面**のストック（凡例の数字 = 窓の右端の断面）。
 *  - グラフレンズには**日ズームがある**（数値レンズだけが日を持たない）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useState } from 'react';
import { act, cleanup, fireEvent, render } from '@testing-library/react';
import {
  TimelineCalendar,
  type TimelineLens,
  type TimelineZoom,
} from '../src/ui/screens/TimelineCalendar';
import type { Account, JournalEntry, Ledger } from '../src/domain/types';
import { SCHEMA_VERSION } from '../src/domain/constants';
import { UI } from '../src/ui-contract';
import './setup';

const ledgerState = vi.hoisted(() => ({ ledger: null as Ledger | null }));

vi.mock('../src/state/store', () => ({
  useLedger: () => ({ ledger: ledgerState.ledger }),
  useOptionalLedger: () => ({ ledger: ledgerState.ledger }),
}));

function account(id: string, name: string, type: Account['type'], role: Account['role']): Account {
  return { id, name, type, role, archived: false, createdAt: 'x', updatedAt: 'x' };
}

function entry(
  id: string,
  date: string,
  debitAccountId: string,
  creditAccountId: string,
  amount: number,
): JournalEntry {
  return {
    id,
    date,
    description: id,
    kind: 'normal',
    lines: [
      { accountId: debitAccountId, side: 'debit', amount },
      { accountId: creditAccountId, side: 'credit', amount },
    ],
    createdAt: 'x',
    updatedAt: 'x',
  };
}

/**
 * 預金 100,000（自由）/ 投資 40,000（自由でない資産）/ ローン 30,000。
 * 窓の右端の断面は 資産 140,000・負債 −30,000・純資産 110,000・自由 100,000。
 */
function fixtureLedger(): Ledger {
  return {
    meta: {
      id: 'ledger',
      schemaVersion: SCHEMA_VERSION,
      revision: 1,
      deviceId: 'device',
      createdAt: 'x',
      updatedAt: 'x',
    },
    settings: { ledgerName: 'test', currency: 'JPY', displayFractionDigits: 0 },
    accounts: [
      account('cash', '預金', 'asset', 'daily-asset'),
      account('fund', '投資', 'asset', 'investment-asset'),
      account('loan', 'ローン', 'liability', 'other-liability'),
      account('equity', '元手', 'equity', 'equity'),
    ],
    journalEntries: [
      entry('opening', '2024-01-01', 'cash', 'equity', 110_000),
      entry('borrow', '2024-02-01', 'cash', 'loan', 30_000),
      entry('invest', '2024-03-01', 'fund', 'cash', 40_000),
    ],
    monthlyCostItems: [],
    recurringRules: [],
  };
}

function renderTimeline(options: { initialZoom?: TimelineZoom; initialLens?: TimelineLens } = {}) {
  let setLensRef: ((lens: TimelineLens) => void) | undefined;
  let zoomRef: TimelineZoom | undefined;

  function Harness() {
    const [zoom, setZoom] = useState<TimelineZoom>(options.initialZoom ?? 'month');
    const [lens, setLens] = useState<TimelineLens>(options.initialLens ?? 'chart');
    zoomRef = zoom;
    setLensRef = (next) => {
      setLens(next);
      // App と同じ不変則（数値レンズ ⇒ 日ズームではない）。グラフには日があるので丸めない。
      if (next === 'matrix' && zoom === 'day') setZoom('month');
    };
    return (
      <TimelineCalendar
        period={{ mode: 'date', date: '2026-07-15' }}
        zoom={zoom}
        onZoomChange={setZoom}
        lens={lens}
        onLensChange={setLensRef!}
        onPeriodChange={() => undefined}
        onNavigate={() => undefined}
        onOpenEntry={() => undefined}
        onOpenAllocations={() => undefined}
        onOpenAccount={() => undefined}
      />
    );
  }

  const view = render(<Harness />);
  return {
    ...view,
    setLens: (lens: TimelineLens) => act(() => setLensRef!(lens)),
    zoom: () => zoomRef,
  };
}

const q = (dataUi: string) => document.querySelector(`[data-ui="${dataUi}"]`);
const all = (dataUi: string) => [...document.querySelectorAll(`[data-ui="${dataUi}"]`)];
const legend = (key: string) =>
  document.querySelector(
    `[data-ui="${UI.timeline.chartLegend}"][data-series-key="${key}"]`,
  ) as HTMLElement;
const lineKeys = () =>
  all(UI.timeline.chartLine).map((line) => line.getAttribute('data-series-key'));

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(2026, 6, 15, 12));
  ledgerState.ledger = fixtureLedger();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  ledgerState.ledger = null;
});

describe('時間平面のグラフレンズ', () => {
  it('レンズは 3 つで、グラフへ切り替えると表も線分も出ない', () => {
    const view = renderTimeline({ initialLens: 'segment' });
    expect(q(UI.timeline.lensSegment)).toBeInTheDocument();
    expect(q(UI.timeline.lensMatrix)).toBeInTheDocument();
    expect(q(UI.timeline.lensChart)).toBeInTheDocument();
    expect(q(UI.timeline.chart)).toBeNull();

    view.setLens('chart');
    expect(q(UI.timeline.chart)).toBeInTheDocument();
    expect(q(UI.timeline.matrix)).toBeNull();
    expect(q(UI.timeline.viewport)).toBeNull();
  });

  it('ラベル列 = 凡例トグル。4 系列が並び、既定 ON は純資産と自由に動かせるお金', () => {
    renderTimeline();
    expect(
      all(UI.timeline.chartLegend).map((button) => button.getAttribute('data-series-key')),
    ).toEqual(['assets', 'liabilities', 'netAssets', 'freeFunds']);
    expect(legend('assets').getAttribute('aria-pressed')).toBe('false');
    expect(legend('liabilities').getAttribute('aria-pressed')).toBe('false');
    expect(legend('netAssets').getAttribute('aria-pressed')).toBe('true');
    expect(legend('freeFunds').getAttribute('aria-pressed')).toBe('true');
    // 描かれるのは ON の 2 本だけ（凡例は描画の正本であって、後がけのフィルタではない）。
    expect(lineKeys()).toEqual(['netAssets', 'freeFunds']);
  });

  it('凡例のタップで表示 / 非表示が反転し、線の本数がそのぶん変わる', () => {
    renderTimeline();

    fireEvent.click(legend('assets'));
    expect(legend('assets').getAttribute('aria-pressed')).toBe('true');
    expect(lineKeys()).toEqual(['assets', 'netAssets', 'freeFunds']);

    fireEvent.click(legend('netAssets'));
    expect(legend('netAssets').getAttribute('aria-pressed')).toBe('false');
    expect(lineKeys()).toEqual(['assets', 'freeFunds']);
  });

  it('全部 OFF にすると線は 1 本も無く、選び直しの案内が出る', () => {
    renderTimeline();
    fireEvent.click(legend('netAssets'));
    fireEvent.click(legend('freeFunds'));
    expect(lineKeys()).toEqual([]);
    expect(q(UI.timeline.chartNoSeries)).toBeInTheDocument();
  });

  it('凡例の数字は窓の右端（最後のバケット末）の断面', () => {
    renderTimeline();
    // 金額は minor unit（表示は 100 分の 1）。資産 110,000 + 30,000（借入）= 140,000。
    expect(legend('assets')).toHaveTextContent('1,400');
    // 負債は自然符号（貸方残高を負で描く）。
    expect(legend('liabilities')).toHaveTextContent('-300');
    expect(legend('netAssets')).toHaveTextContent('1,100');
    // 40,000 は投資（自由に動かせない）へ移っている。
    expect(legend('freeFunds')).toHaveTextContent('1,000');
  });

  it('読み上げ用の要約が ON の系列ぶんだけ出る（SVG は aria-hidden）', () => {
    renderTimeline();
    const chart = q(UI.timeline.chart)!;
    expect(chart.textContent).toContain('純資産:');
    expect(chart.textContent).toContain('自由に動かせるお金:');
    expect(chart.textContent).not.toContain('負債:');
  });

  it('グラフレンズは日ズームでも描ける（日のバケットを持つのは数値レンズだけの制約ではない）', () => {
    const view = renderTimeline({ initialZoom: 'day' });
    expect(view.zoom()).toBe('day');
    expect(q(UI.timeline.chart)).toBeInTheDocument();
    expect(lineKeys()).toEqual(['netAssets', 'freeFunds']);

    // 数値レンズへ移ると日は無いので月へ丸まる（不変則はグラフには効かない）。
    view.setLens('matrix');
    expect(view.zoom()).toBe('month');
    view.setLens('chart');
    expect(q(UI.timeline.chart)).toBeInTheDocument();
  });
});
