/*
 * mutation 検証 ②（6 分類の並び）。
 *
 * 表示順マスタ（domain/displayOrder）の**分類の並びだけ**をテスト内で反転し
 * （段の順も段の中の順も逆にする）、ホームのカード・数値レンズの行・グラフの系列が
 * すべてそれに追従することを見る。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, waitFor } from '@testing-library/react';
import { ToastProvider } from '@snishi/foundation/ui/toast';
import type { DisplaySectionKey } from '../src/domain/displayOrder';

vi.mock('../src/domain/displayOrder', async () => {
  const actual = await vi.importActual<typeof import('../src/domain/displayOrder')>(
    '../src/domain/displayOrder',
  );
  const groups = [...actual.DISPLAY_SECTION_GROUPS]
    .reverse()
    .map((group) => ({ ...group, sections: [...group.sections].reverse() }));
  const keys = groups.flatMap((group) => group.sections);
  return {
    ...actual,
    DISPLAY_SECTION_GROUPS: groups,
    DISPLAY_SECTION_KEYS: keys,
    isDisplaySectionGroupStart: (key: DisplaySectionKey) =>
      groups.some((group, index) => index > 0 && group.sections[0] === key),
  };
});

const { buildPeriodMatrix } = await import('../src/domain/periodMatrix');
const { STOCK_SERIES_KEYS } = await import('../src/domain/stockSeries');
const { Dashboard } = await import('../src/ui/screens/Dashboard');
const { LedgerProvider, useLedger } = await import('../src/state/store');
const { loadLedger } = await import('../src/data/repository');
const { UI } = await import('../src/ui-contract');
const { _resetOverlaysForTests } = await import('../src/ui/overlays');
const { todayLocal } = await import('../src/util/time');
await import('./setup');

afterEach(() => {
  cleanup();
  _resetOverlaysForTests();
});

/** 反転後のマスタ順（ストックの段が先・各段の中も逆）。 */
const REVERSED_SECTIONS: DisplaySectionKey[] = [
  'netAssets',
  'totalLiabilities',
  'totalAssets',
  'net',
  'expense',
  'revenue',
];

function DashboardWhenReady() {
  const { status } = useLedger();
  return status === 'ready' ? (
    <Dashboard
      period={{ mode: 'date', date: todayLocal() }}
      onPeriodChange={() => undefined}
      onAddEntry={() => undefined}
      onEditEntry={() => undefined}
      onNavigate={() => undefined}
      onOpenJournal={() => undefined}
      onOpenAllocations={() => undefined}
      onOpenAccount={() => undefined}
      onOpenEntry={() => undefined}
    />
  ) : null;
}

describe('mutation: 6 分類の並びを反転すると全画面が追従する', () => {
  it('数値レンズの行がマスタに従う', async () => {
    const ledger = await loadLedger();
    const matrix = buildPeriodMatrix(ledger.accounts, ledger.journalEntries, {
      mode: 'all',
      years: [2026],
    });
    expect(matrix.sections.map((section) => section.key)).toEqual(REVERSED_SECTIONS);
  });

  it('グラフの系列順がマスタに従う（集計 3 行の並び）', () => {
    expect([...STOCK_SERIES_KEYS]).toEqual(['netAssets', 'liabilities', 'assets', 'freeFunds']);
  });

  it('ホームの 6 カードがマスタの順・マスタの段組みで描画される', async () => {
    render(
      <ToastProvider>
        <LedgerProvider>
          <DashboardWhenReady />
        </LedgerProvider>
      </ToastProvider>,
    );
    await waitFor(() => {
      expect(document.querySelector(`[data-ui="${UI.dashboard.frame}"]`)).toBeInTheDocument();
    });

    const grids = [...document.querySelectorAll('.stat-grid')];
    expect(grids).toHaveLength(2);
    const order = grids.flatMap((grid) =>
      [...grid.querySelectorAll('.stat')].map((stat) => stat.getAttribute('data-ui') ?? ''),
    );
    expect(order).toEqual([
      UI.dashboard.statNetAssets,
      UI.dashboard.statLiabilities,
      UI.dashboard.statAssets,
      UI.dashboard.statNetIncome,
      UI.dashboard.statExpense,
      UI.dashboard.statRevenue,
    ]);
  });
});
