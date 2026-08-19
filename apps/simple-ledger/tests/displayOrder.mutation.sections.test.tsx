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
  };
});

const { buildLensRowTree } = await import('../src/domain/lensRows');
const { Dashboard } = await import('../src/ui/screens/Dashboard');
const { LedgerProvider, useLedger } = await import('../src/state/store');
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
void (REVERSED_SECTIONS satisfies DisplaySectionKey[]);

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
  it('3 レンズ共通の木は 6 分類の並びに引きずられない（恒等行は箱の並びから引き直す）', () => {
    // 恒等行の位置は「式の右辺の最後の**箱**の直後」。6 分類の並びを反転しても、
    // 箱の並びは動いていないので木は変わらない = 木が独自の並びを持っていない証拠。
    const rows = buildLensRowTree([]);
    expect(rows.map((row) => row.id)).toEqual([
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
    // 段（フロー / ストック）の所属も 6 分類の並べ替えでは動かない
    // ＝ グラフに描ける行の集合が並び順の副作用で変わらない。
    expect(rows.filter((row) => !row.stock).map((row) => row.id)).toEqual([
      'box:income',
      'box:expense',
      'identity:net',
    ]);
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
