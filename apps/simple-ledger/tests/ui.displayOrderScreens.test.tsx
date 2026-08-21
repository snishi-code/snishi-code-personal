/*
 * 「画面の並び = 表示順マスタ」の回帰（v13.6 H1）。
 *
 * 各画面が独自の並びを持たないこと（= マスタの射影であること）を、描画結果とマスタの
 * 突き合わせで見る。マスタそのものの中身が変わっていないことは displayOrder.test.ts が
 * 別に固定しているので、この 2 本で「見た目が勝手に変わらない」が閉じる。
 *
 * タイムラインの箱・数値レンズの行・グラフの凡例は ui.timelineCalendar / ui.timelineMatrixLens /
 * ui.timelineChartLens が既に並びを固定しているため、ここではホーム・勘定科目・内訳を見る。
 */
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { cleanup, render, waitFor } from '@testing-library/react';
import { ToastProvider } from '@snishi/foundation/ui/toast';
import { patchDialogIfNeeded } from '@snishi/foundation/ui/test-utils';
import { LedgerProvider, useLedger } from '../src/state/store';
import { Dashboard } from '../src/ui/screens/Dashboard';
import { Accounts } from '../src/ui/screens/Accounts';
import { Breakdown } from '../src/ui/screens/Breakdown';
import { createOpenings, loadLedger, upsertAccount } from '../src/data/repository';
import {
  ASSET_GROUP_KEYS,
  DISPLAY_SECTION_GROUPS,
  type DisplaySectionKey,
} from '../src/domain/displayOrder';
import { ACCOUNT_BOXES } from '../src/ui/accountBoxes';
import { UI } from '../src/ui-contract';
import { _resetOverlaysForTests } from '../src/ui/overlays';
import { todayLocal } from '../src/util/time';
import './setup';

beforeAll(() => {
  patchDialogIfNeeded();
});

afterEach(() => {
  cleanup();
  _resetOverlaysForTests();
});

function Providers({ children }: { children: React.ReactNode }) {
  return (
    <ToastProvider>
      <LedgerProvider>
        <Ready>{children}</Ready>
      </LedgerProvider>
    </ToastProvider>
  );
}

function Ready({ children }: { children: React.ReactNode }) {
  const { status } = useLedger();
  return status === 'ready' ? <>{children}</> : null;
}

const STAT_UI: Record<DisplaySectionKey, string> = {
  revenue: UI.dashboard.statRevenue,
  expense: UI.dashboard.statExpense,
  net: UI.dashboard.statNetIncome,
  totalAssets: UI.dashboard.statAssets,
  totalLiabilities: UI.dashboard.statLiabilities,
  netAssets: UI.dashboard.statNetAssets,
};

function uiOrder(prefix: string): string[] {
  return [...document.querySelectorAll(`[data-ui^="${prefix}"]`)].map(
    (element) => element.getAttribute('data-ui') ?? '',
  );
}

describe('ホームの 6 カード', () => {
  it('段組みもカード順もマスタ（DISPLAY_SECTION_GROUPS）どおり', async () => {
    render(
      <Providers>
        <Dashboard
          period={{ mode: 'date', date: todayLocal() }}
          onPeriodChange={() => undefined}
          onAddEntry={() => undefined}
          onEditEntry={() => undefined}
          onNavigate={() => undefined}
          onOpenJournal={() => undefined}
          onOpenAllocations={() => undefined}
          onOpenEntry={() => undefined}
        />
      </Providers>,
    );
    await waitFor(() => {
      expect(document.querySelector(`[data-ui="${UI.dashboard.frame}"]`)).toBeInTheDocument();
    });

    const grids = [...document.querySelectorAll('.stat-grid')];
    expect(grids).toHaveLength(DISPLAY_SECTION_GROUPS.length);
    grids.forEach((grid, index) => {
      const expected = DISPLAY_SECTION_GROUPS[index]!.sections.map((key) => STAT_UI[key]);
      expect([...grid.querySelectorAll('.stat')].map((s) => s.getAttribute('data-ui'))).toEqual(
        expected,
      );
    });
  });
});

describe('勘定科目画面の箱', () => {
  it('箱見出しの並びが ACCOUNT_BOXES（= マスタの射影）どおり', async () => {
    render(
      <Providers>
        <Accounts />
      </Providers>,
    );
    await waitFor(() => {
      expect(document.querySelector(`[data-ui="${UI.accounts.view}"]`)).toBeInTheDocument();
    });
    expect(uiOrder(`${UI.accounts.box}.`)).toEqual(
      ACCOUNT_BOXES.map((box) => `${UI.accounts.box}.${box.key}`),
    );
  });
});

describe('資産の内訳の 3 枠', () => {
  it('枠の並びが ASSET_GROUP_KEYS（= 箱の並びの射影）どおり', async () => {
    const ledger = await loadLedger();
    const cash = ledger.accounts.find((a) => a.name === '現金')!;
    const charge = ledger.accounts.find((a) => a.name === 'チャージ残高')!;
    const invest = ledger.accounts.find((a) => a.name === '投資')!;
    await upsertAccount({ ...charge, movable: false });
    await createOpenings([
      { accountId: cash.id, amount: 30_000, date: '2026-01-01' },
      { accountId: charge.id, amount: 5_000, date: '2026-01-01' },
      { accountId: invest.id, amount: 50_000, date: '2026-01-01' },
    ]);

    render(
      <Providers>
        <Breakdown
          section="asset"
          period={{ mode: 'all' }}
          onPeriodChange={() => undefined}
          onDrillDown={() => undefined}
          onNavigate={() => undefined}
        />
      </Providers>,
    );
    await waitFor(() => {
      expect(document.querySelector(`[data-ui="${UI.assetsBreakdown.view}"]`)).toBeInTheDocument();
    });

    // 残高のある枠だけが出る。出ている枠の相対順はマスタと一致する。
    const shown = uiOrder(`${UI.assetsBreakdown.frame}.`);
    const expected = ASSET_GROUP_KEYS.map((key) => `${UI.assetsBreakdown.frame}.${key}`).filter(
      (ui) => shown.includes(ui),
    );
    expect(shown).toEqual(expected);
    // 投資は「自由に動かせない」枠に合流（v13.18）。残高があるのは free / fixed の 2 枠。
    expect(shown.length).toBeGreaterThanOrEqual(2);
  });
});
