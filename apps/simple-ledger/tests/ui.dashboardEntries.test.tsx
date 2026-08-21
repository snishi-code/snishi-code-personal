/*
 * ホームの仕訳一覧（実ユーズレビュー 2026-08-12 ④）:
 *  - slice(0,5) の上限を撤廃し、期間内の保存仕訳を 50 件ずつ「さらに表示」で開く
 *  - 表示日（期間）を変えたら件数は初期化される
 *  - 一覧は保存される仕訳のみ（導出行を混ぜない）
 *  - 額縁（dashboard.frame）は収支 + 財政状態の 6 枠を含む
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import { ToastProvider } from '@snishi/foundation/ui/toast';
import { LedgerProvider, useLedger } from '../src/state/store';
import { Dashboard } from '../src/ui/screens/Dashboard';
import { createContinuousCost, loadLedger, upsertEntry } from '../src/data/repository';
import { addMonthsToDate } from '../src/domain/allocation';
import { todayLocal } from '../src/util/time';
import type { ReportPeriod } from '../src/domain/reportPeriod';
import { UI } from '../src/ui-contract';
import { _resetOverlaysForTests } from '../src/ui/overlays';
import './setup';

afterEach(() => {
  cleanup();
  _resetOverlaysForTests();
});

function Providers({ children }: { children: React.ReactNode }) {
  return (
    <ToastProvider>
      <LedgerProvider>{children}</LedgerProvider>
    </ToastProvider>
  );
}

function DashboardTap({
  onEditEntry,
  onOpenAllocations,
}: {
  onEditEntry: (entry: unknown) => void;
  onOpenAllocations: (target: unknown) => void;
}) {
  const { status } = useLedger();
  return status === 'ready' ? (
    <Dashboard
      period={{ mode: 'date', date: todayLocal() }}
      onPeriodChange={() => undefined}
      onAddEntry={() => undefined}
      onEditEntry={onEditEntry as never}
      onNavigate={() => undefined}
      onOpenJournal={() => undefined}
      onOpenAllocations={onOpenAllocations as never}
      onOpenEntry={() => undefined}
    />
  ) : null;
}

function DashboardWhenReady({ period }: { period: ReportPeriod }) {
  const { status } = useLedger();
  return status === 'ready' ? (
    <Dashboard
      period={period}
      onPeriodChange={() => undefined}
      onAddEntry={() => undefined}
      onEditEntry={() => undefined}
      onNavigate={() => undefined}
      onOpenJournal={() => undefined}
      onOpenAllocations={() => undefined}
      onOpenEntry={() => undefined}
    />
  ) : null;
}

function dashboard(period: ReportPeriod) {
  return (
    <Providers>
      <DashboardWhenReady period={period} />
    </Providers>
  );
}

async function seedEntries(count: number, month = '2026-03') {
  const ledger = await loadLedger();
  const cash = ledger.accounts.find((account) => account.role === 'daily-asset')!;
  const expense = ledger.accounts.find((account) => account.role === 'expense-category')!;
  for (let i = 0; i < count; i++) {
    const day = String((i % 28) + 1).padStart(2, '0');
    const timestamp = `${month}-01T00:00:${String(i % 60).padStart(2, '0')}.${String(i).padStart(
      3,
      '0',
    )}Z`;
    await upsertEntry({
      id: `home-${month}-${i}`,
      date: `${month}-${day}`,
      description: `ホーム${i}`,
      kind: 'normal',
      lines: [
        { accountId: expense.id, side: 'debit', amount: 100 + i },
        { accountId: cash.id, side: 'credit', amount: 100 + i },
      ],
      metadata: { inputMode: 'expense' },
      createdAt: timestamp,
      updatedAt: timestamp,
    });
  }
}

function rowCount(): number {
  return document.querySelectorAll(`[data-ui="${UI.dashboard.journalPreview}"] .list__item`).length;
}

function moreButton(): Element | null {
  return document.querySelector(`[data-ui="${UI.dashboard.journalMore}"]`);
}

const MARCH: ReportPeriod = { mode: 'date', date: '2026-03-31' };

describe('ホームの仕訳一覧', () => {
  it('6 件でも全件描画される（旧: 5 件で打ち切り）', async () => {
    await seedEntries(6);
    render(dashboard(MARCH));
    await waitFor(() => expect(rowCount()).toBe(6));
    expect(moreButton()).toBeNull();
  });

  it('51 件では 50 件 + さらに表示。押すと全件になりボタンが消える', async () => {
    await seedEntries(51);
    render(dashboard(MARCH));
    await waitFor(() => expect(rowCount()).toBe(50));
    expect(moreButton()).toHaveTextContent('1');
    fireEvent.click(moreButton()!);
    await waitFor(() => expect(rowCount()).toBe(51));
    expect(moreButton()).toBeNull();
  });

  it('表示日（期間）を変えると表示件数が初期化される', async () => {
    await seedEntries(51);
    const view = render(dashboard(MARCH));
    await waitFor(() => expect(rowCount()).toBe(50));
    fireEvent.click(moreButton()!);
    await waitFor(() => expect(rowCount()).toBe(51));

    view.rerender(dashboard({ mode: 'date', date: '2026-04-30' }));
    await waitFor(() => expect(rowCount()).toBe(0));
    view.rerender(dashboard(MARCH));
    await waitFor(() => expect(rowCount()).toBe(50));
    expect(moreButton()).not.toBeNull();
  });

  it('一覧は保存される仕訳のみ（導出の月割り行を混ぜない。displayEntries へ切り替えたら落ちる回帰ガード）', async () => {
    const ledger = await loadLedger();
    const expense = ledger.accounts.find((a) => a.role === 'expense-category')!;
    // 3 月に月割りが発生する継続コスト資産（導出行は Journal には出るがホームには出ない）。
    await createContinuousCost({
      name: '持ち込み資産',
      amount: 12000,
      startDate: '2026-03-01',
      endDate: '2027-02-28',
      expenseAccountId: expense.id,
    });
    await seedEntries(2);
    render(dashboard(MARCH));
    await waitFor(() => expect(rowCount()).toBeGreaterThan(0));
    // 期間内の保存仕訳の件数と 1:1（導出行が混ざればここが増えて落ちる）。
    const saved = (await loadLedger()).journalEntries.filter(
      (e) => e.date >= '2026-03-01' && e.date <= '2026-03-31',
    ).length;
    expect(rowCount()).toBe(saved);
  });

  it('額縁は収支と財政状態の 6 枠を含む', async () => {
    await seedEntries(1);
    render(dashboard(MARCH));
    await waitFor(() => expect(rowCount()).toBe(1));
    const frame = document.querySelector(`[data-ui="${UI.dashboard.frame}"]`)!;
    expect(frame).toBeInTheDocument();
    for (const stat of [
      UI.dashboard.statRevenue,
      UI.dashboard.statExpense,
      UI.dashboard.statNetIncome,
      UI.dashboard.statAssets,
      UI.dashboard.statLiabilities,
      UI.dashboard.statNetAssets,
    ]) {
      expect(frame.querySelector(`[data-ui="${stat}"]`)).not.toBeNull();
    }
  });
});

describe('ホームのアクセシビリティ（Codex 監査 2026-08-12 対応）', () => {
  it('6 枠の accessible name に金額が含まれる（aria-label が子の金額を上書きしない）', async () => {
    await seedEntries(1);
    render(dashboard(MARCH));
    await waitFor(() => expect(rowCount()).toBe(1));
    const revenue = document.querySelector(`[data-ui="${UI.dashboard.statRevenue}"]`)!;
    const label = revenue.getAttribute('aria-label') ?? '';
    // 名称・金額・操作の 3 つが読み上げられる。
    expect(label).toContain('収入');
    expect(label).toContain('内訳を開く');
    expect(label).toMatch(/\d/);
    // 表示と読み上げが食い違わない（Money と同じ文字列）。
    expect(label).toContain((revenue.querySelector('.stat__value')?.textContent ?? '').trim());
  });

  it('「さらに表示」の最終ページでフォーカスが body へ落ちず、最初の追加行へ移る', async () => {
    await seedEntries(51);
    render(dashboard(MARCH));
    await waitFor(() => expect(rowCount()).toBe(50));
    fireEvent.click(moreButton()!);
    await waitFor(() => expect(rowCount()).toBe(51));
    expect(moreButton()).toBeNull();
    await waitFor(() => {
      const rows = document.querySelectorAll(
        `[data-ui="${UI.dashboard.journalPreview}"] button.list__item`,
      );
      // 51 件目（index 50）= 最初に増えた行。
      expect(document.activeElement).toBe(rows[50]);
    });
    expect(document.activeElement).not.toBe(document.body);
  });

  it('表示件数が polite status で読み上げられる', async () => {
    await seedEntries(51);
    render(dashboard(MARCH));
    await waitFor(() => expect(rowCount()).toBe(50));
    const status = document.querySelector(`[data-ui="${UI.dashboard.journalCount}"]`)!;
    expect(status).toHaveAttribute('role', 'status');
    expect(status.textContent).toContain('50');
    expect(status.textContent).toContain('51');
    fireEvent.click(moreButton()!);
    await waitFor(() => expect(status.textContent).toContain('51 件中 51 件'));
  });
});

describe('ホームの仕訳タップの行き先（entryOpenPlan の単一正本）', () => {
  it('継続コスト絡みの保存仕訳（購入）もタップで編集になる（以前は仕訳一覧へ飛んでいた）', async () => {
    const ledger = await loadLedger();
    const cash = ledger.accounts.find((a) => a.role === 'daily-asset')!;
    const expense = ledger.accounts.find((a) => a.role === 'expense-category')!;
    const today = todayLocal();
    // 購入の保存仕訳（metadata.monthlyCostId 付き）が今月の一覧に出る。
    await createContinuousCost({
      name: 'タップ確認CC',
      amount: 300000,
      startDate: today,
      endDate: addMonthsToDate(today, 2),
      expenseAccountId: expense.id,
      creditAccountId: cash.id,
    });

    const onEditEntry = vi.fn();
    const onOpenAllocations = vi.fn();
    render(
      <Providers>
        <DashboardTap onEditEntry={onEditEntry} onOpenAllocations={onOpenAllocations} />
      </Providers>,
    );
    await waitFor(() => {
      expect(
        document.querySelector(`[data-ui="${UI.dashboard.journalPreview}"]`),
      ).toBeInTheDocument();
    });
    const purchase = [
      ...document.querySelectorAll(`[data-ui="${UI.dashboard.journalPreview}"] button.list__item`),
    ].find((r) => r.textContent?.includes('タップ確認CC'))!;
    expect(purchase).toBeDefined();

    fireEvent.click(purchase);
    // 保存仕訳なので編集シート。monthlyCostId を理由に仕訳一覧へ流さない。
    expect(onEditEntry).toHaveBeenCalledTimes(1);
    expect(onOpenAllocations).not.toHaveBeenCalled();
  });
});
