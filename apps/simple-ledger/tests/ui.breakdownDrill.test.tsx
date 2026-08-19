/*
 * 内訳ページのドリル（C-1）。
 * ストック（資産・負債・純資産）のドリルも、フロー（収入）と同じ窓
 * （reportBasis の flowRange = 月初〜断面 / 年 / 全期間）を渡す。
 * ストックだけ from を落として全期間へ落ちると、画面が見せている期間と
 * 着地した仕訳一覧の期間が黙って食い違う。
 */
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import { ToastProvider } from '@snishi/foundation/ui/toast';
import { patchDialogIfNeeded } from '@snishi/foundation/ui/test-utils';
import { LedgerProvider } from '../src/state/store';
import { Breakdown } from '../src/ui/screens/Breakdown';
import { createOpenings, loadLedger, upsertEntry } from '../src/data/repository';
import { reportBasis } from '../src/domain/reportPeriod';
import { todayLocal } from '../src/util/time';
import { UI } from '../src/ui-contract';
import { _resetOverlaysForTests } from '../src/ui/overlays';
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
      <LedgerProvider>{children}</LedgerProvider>
    </ToastProvider>
  );
}

const ui = (name: string) => document.querySelector(`[data-ui="${name}"]`);

describe('内訳のドリルの窓', () => {
  it.each([
    { section: 'asset' as const, row: UI.assetsBreakdown.row },
    { section: 'liability' as const, row: UI.liabilitiesBreakdown.row },
    { section: 'revenue' as const, row: UI.incomeBreakdown.row },
  ])('$section のドリルはフローと同じ from/to を渡す', async ({ section, row }) => {
    const ledger = await loadLedger();
    const cash = ledger.accounts.find((a) => a.name === '現金')!;
    const card = ledger.accounts.find((a) => a.role === 'payment-liability')!;
    const income = ledger.accounts.find((a) => a.role === 'income-category')!;
    await createOpenings([
      { accountId: cash.id, amount: 30000000, date: '2000-01-01' },
      { accountId: card.id, amount: 3000000, date: '2000-01-01' },
    ]);
    const today = todayLocal();
    await upsertEntry({
      id: 'drill-salary',
      date: today,
      description: '給与',
      kind: 'normal',
      lines: [
        { accountId: cash.id, side: 'debit', amount: 10000000 },
        { accountId: income.id, side: 'credit', amount: 10000000 },
      ],
      metadata: { inputMode: 'manual' },
      createdAt: `${today}T00:00:00.000Z`,
      updatedAt: `${today}T00:00:00.000Z`,
    });

    const period = { mode: 'date' as const, date: today };
    const onDrillDown = vi.fn();
    render(
      <Providers>
        <Breakdown
          section={section}
          period={period}
          onPeriodChange={() => undefined}
          onDrillDown={onDrillDown}
          onNavigate={() => undefined}
        />
      </Providers>,
    );

    await waitFor(() => {
      expect(ui(row)).toBeInTheDocument();
    });
    fireEvent.click(ui(row)!);

    const range = reportBasis(period, today).flowRange;
    expect(range.from).toBeDefined();
    expect(onDrillDown).toHaveBeenCalledTimes(1);
    const filter = onDrillDown.mock.calls[0]![0] as {
      accountId: string;
      from?: string;
      to?: string;
    };
    expect(filter.from).toBe(range.from);
    expect(filter.to).toBe(range.to);
  });

  it('休眠モード（全期間）は from を持たない窓をそのまま渡す', async () => {
    const ledger = await loadLedger();
    const cash = ledger.accounts.find((a) => a.name === '現金')!;
    await createOpenings([{ accountId: cash.id, amount: 30000000, date: '2000-01-01' }]);

    const onDrillDown = vi.fn();
    render(
      <Providers>
        <Breakdown
          section="asset"
          period={{ mode: 'all' }}
          onPeriodChange={() => undefined}
          onDrillDown={onDrillDown}
          onNavigate={() => undefined}
        />
      </Providers>,
    );

    await waitFor(() => {
      expect(ui(UI.assetsBreakdown.row)).toBeInTheDocument();
    });
    fireEvent.click(ui(UI.assetsBreakdown.row)!);

    const range = reportBasis({ mode: 'all' }, todayLocal()).flowRange;
    expect(onDrillDown).toHaveBeenCalledWith(
      expect.objectContaining({ accountId: expect.any(String), to: range.to }),
    );
    expect(onDrillDown.mock.calls[0]![0]).not.toHaveProperty('from');
  });
});
