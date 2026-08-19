/*
 * 時間平面の**グラフレンズ**（v13.6 H3 でラベル列を 3 レンズ共通にしたもの）。
 *
 * 固定するもの:
 *  - レンズは 3 つ（線分 / 数値 / グラフ）。同時に 2 つの見え方を出さない。
 *  - **ラベル列は共通**（専用の凡例は無い）。チェックボックスがそのまま系列選択で、
 *    既定は全 ON。描かれる線はチェックされたストック行だけ。
 *  - フロー行（収入・支出・収支）はチェック自体が disabled（理由を読み上げる）。
 *  - 値は**バケット末断面**のストック。
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
const chartEl = () => q(UI.timeline.chart) as HTMLElement;
const check = (rowKey: string) =>
  chartEl().querySelector(
    `[data-ui="${UI.timeline.rowCheck}"][data-row-key="${rowKey}"]`,
  ) as HTMLInputElement;
const rowKeys = () =>
  [...chartEl().querySelectorAll(`[data-ui="${UI.timeline.rowLabel}"]`)].map((row) =>
    row.getAttribute('data-row-key'),
  );
const lineKeys = () => all(UI.timeline.chartLine).map((line) => line.getAttribute('data-row-key'));

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

  it('ラベル列は 3 レンズ共通の木。既定は全 ON で、ストックの行だけが線になる', () => {
    renderTimeline();
    expect(rowKeys()).toEqual([
      'box:assetFree',
      'box:assetFixed',
      'box:investment',
      'box:continuingCost',
      'box:shortTermDebt',
      'box:longTermDebt',
      'identity:netAssets',
      'box:income',
      'box:expense',
      'identity:net',
      'box:equity',
    ]);
    // 既定は全 ON（画面ローカル・保存しない）。
    expect(check('identity:netAssets').checked).toBe(true);
    expect(check('box:assetFree').checked).toBe(true);
    // 線になるのはストックの行だけ。フロー行はチェックが付いていても描かない。
    expect(lineKeys()).toEqual([
      'box:assetFree',
      'box:assetFixed',
      'box:investment',
      'box:continuingCost',
      'box:shortTermDebt',
      'box:longTermDebt',
      'identity:netAssets',
      'box:equity',
    ]);
  });

  it('フローの行はチェックできず、理由を読み上げる（形式が決まるまで描けない）', () => {
    renderTimeline();
    for (const key of ['box:income', 'box:expense', 'identity:net']) {
      expect(check(key).disabled).toBe(true);
    }
    expect(chartEl().textContent).toContain('グラフの描き方が決まるまで');
    // ストックの行は操作できる。
    expect(check('identity:netAssets').disabled).toBe(false);
  });

  /* mutation 系統: チェックと右ペイン（折れ線）の連動。 */
  it('チェックを外すとその線が消え、戻すと出る', () => {
    renderTimeline();
    expect(lineKeys()).toContain('identity:netAssets');

    fireEvent.click(check('identity:netAssets'));
    expect(check('identity:netAssets').checked).toBe(false);
    expect(lineKeys()).not.toContain('identity:netAssets');
    // 行そのものは残る（チェックし直せる）。
    expect(rowKeys()).toContain('identity:netAssets');

    fireEvent.click(check('identity:netAssets'));
    expect(lineKeys()).toContain('identity:netAssets');
  });

  it('ストックを全部 OFF にすると線は 1 本も無く、選び直しの案内が出る', () => {
    renderTimeline();
    for (const key of rowKeys()) {
      const input = check(key!);
      if (!input.disabled && input.checked) fireEvent.click(input);
    }
    expect(lineKeys()).toEqual([]);
    expect(q(UI.timeline.chartNoSeries)).toBeInTheDocument();
  });

  it('読み上げ用の要約が描かれている系列ぶんだけ出る（SVG は aria-hidden）', () => {
    renderTimeline();
    // 純資産 = 110,000（表示は 100 分の 1）。負債は自然符号なので 300（マイナスにしない）。
    expect(chartEl().textContent).toContain('純資産:');
    expect(chartEl().textContent).toContain('1,100');
    expect(chartEl().textContent).toContain('300');
    expect(chartEl().querySelector('svg')?.getAttribute('aria-hidden')).toBe('true');
  });

  it('グラフレンズは日ズームでも描ける（日のバケットを持つのは数値レンズだけの制約ではない）', () => {
    const view = renderTimeline({ initialZoom: 'day' });
    expect(view.zoom()).toBe('day');
    expect(q(UI.timeline.chart)).toBeInTheDocument();
    expect(lineKeys()).toContain('identity:netAssets');

    // 数値レンズへ移ると日は無いので月へ丸まる（不変則はグラフには効かない）。
    view.setLens('matrix');
    expect(view.zoom()).toBe('month');
    view.setLens('chart');
    expect(q(UI.timeline.chart)).toBeInTheDocument();
  });
});
