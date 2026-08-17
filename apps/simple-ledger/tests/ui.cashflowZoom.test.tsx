/*
 * 資金繰りのヘッダーズーム追従（v13.5 F）。
 *
 * 会計実務の 日繰り表 / 月次資金繰り表 / 年次計画 の 3 粒度。固定するもの:
 *  - 窓の終端がズームのバケット末に揃う（日 = そのまま / 月 = 月末 / 年 = 年末）。
 *  - 「さらに先へ」の 1 段はズームごとに違う（日 12 / 月 18 / 年 120 ヶ月）。
 *  - ズームを変えると窓はそのズームの 1 段へ戻る（尺が変わるので伸ばした量を持ち越さない）。
 *  - **月ズームだけ**月次純増減を副表示する（読み上げにも出す = SVG は aria-hidden）。
 *  - 下回り日・負債一覧・未来一覧はズームで変わらない（探索は常に日次精度）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useState } from 'react';
import { act, cleanup, render } from '@testing-library/react';
import { Cashflow } from '../src/ui/screens/Cashflow';
import type { TimelineZoom } from '../src/domain/timelineCalendar';
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
      account('equity', '元手', 'equity', 'equity'),
      account('food', '食費', 'expense', 'expense-category'),
    ],
    journalEntries: [
      entry('opening', '2026-01-01', 'cash', 'equity', 1_000_000),
      // 基準日より後の支出（月末断面が動く = 純増減が 0 でない月ができる）。
      entry('future', '2026-10-15', 'food', 'cash', 20_000),
    ],
    monthlyCostItems: [],
    recurringRules: [],
  };
}

function renderCashflow(initialZoom: TimelineZoom) {
  let setZoomRef: ((zoom: TimelineZoom) => void) | undefined;
  function Harness() {
    const [zoom, setZoom] = useState<TimelineZoom>(initialZoom);
    setZoomRef = setZoom;
    return (
      <Cashflow
        period={{ mode: 'date', date: '2026-08-18' }}
        zoom={zoom}
        onEditEntry={() => undefined}
        onOpenAllocations={() => undefined}
        onOpenAccount={() => undefined}
        onOpenEntry={() => undefined}
      />
    );
  }
  const view = render(<Harness />);
  return { ...view, setZoom: (zoom: TimelineZoom) => act(() => setZoomRef!(zoom)) };
}

const q = (dataUi: string) => document.querySelector(`[data-ui="${dataUi}"]`);
const chartText = () => q(UI.cashflow.freeTrend)?.textContent ?? '';
const summaryText = () => q(UI.cashflow.chartSummary)?.textContent ?? '';

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(2026, 7, 18, 12));
  ledgerState.ledger = fixtureLedger();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  ledgerState.ledger = null;
});

describe('資金繰りのズーム追従', () => {
  it('日ズーム: 窓は基準日 + 12 ヶ月のまま（現行の日繰り）', () => {
    renderCashflow('day');
    expect(chartText()).toContain('2027-08-18');
    expect(q(UI.cashflow.chartExtend)).toHaveTextContent('さらに 12 ヶ月先へ');
  });

  it('月ズーム: 窓の終端が月末に揃い、1 段は 18 ヶ月', () => {
    renderCashflow('month');
    // 2026-08-18 + 18 ヶ月 = 2028-02-18 → その月末。
    expect(chartText()).toContain('2028-02-29');
    expect(q(UI.cashflow.chartExtend)).toHaveTextContent('さらに 18 ヶ月先へ');
  });

  it('年ズーム: 窓の終端が年末に揃い、1 段は 120 ヶ月', () => {
    renderCashflow('year');
    expect(chartText()).toContain('2036-12-31');
    expect(q(UI.cashflow.chartExtend)).toHaveTextContent('さらに 120 ヶ月先へ');
  });

  it('月ズームだけ月次純増減を副表示する（読み上げにも出す）', () => {
    const view = renderCashflow('month');
    expect(summaryText()).toContain('2026-10-31 の純増減 -200');

    view.setZoom('day');
    expect(summaryText()).not.toContain('純増減');

    view.setZoom('year');
    expect(summaryText()).not.toContain('純増減');
  });

  it('ズームを変えると窓はそのズームの 1 段へ戻る（尺が違うので伸ばした量を持ち越さない）', () => {
    const view = renderCashflow('day');
    expect(chartText()).toContain('2027-08-18');

    view.setZoom('year');
    expect(chartText()).toContain('2036-12-31');
    // 日へ戻したら、また 12 ヶ月ぶんの窓から。
    view.setZoom('day');
    expect(chartText()).toContain('2027-08-18');
  });

  it('下回り日・負債一覧・未来一覧はズームで変わらない', () => {
    const view = renderCashflow('day');
    const shortfall = q(UI.cashflow.shortfall)?.textContent;
    view.setZoom('month');
    expect(q(UI.cashflow.shortfall)?.textContent).toBe(shortfall);
    // 未来一覧は窓の範囲なので、月ズーム（より長い窓）でも同じ 1 件が残る。
    expect(q(UI.cashflow.futureList)).toBeInTheDocument();
  });
});
