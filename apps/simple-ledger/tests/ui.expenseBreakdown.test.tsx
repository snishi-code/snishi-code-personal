import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import { ToastProvider } from '@snishi/foundation/ui/toast';
import { LedgerProvider } from '../src/state/store';
import { ExpenseBreakdown } from '../src/ui/screens/ExpenseBreakdown';
import { UI } from '../src/ui-contract';
import './setup';

afterEach(() => {
  cleanup();
});

describe('支出内訳の通常支出ドリルダウン', () => {
  it('通常支出をタップすると選択期間付きの通常支出フィルタで仕訳一覧へ渡す', async () => {
    const onDrillDown = vi.fn();
    render(
      <ToastProvider>
        <LedgerProvider>
          <ExpenseBreakdown
            period={{ mode: 'date', date: '2026-07-30' }}
            onPeriodChange={() => undefined}
            onDrillDown={onDrillDown}
            onNavigate={() => undefined}
          />
        </LedgerProvider>
      </ToastProvider>,
    );

    await waitFor(() => {
      expect(
        document.querySelector(`[data-ui="${UI.expenseBreakdown.view}"]`),
      ).toBeInTheDocument();
    });
    fireEvent.click(
      document.querySelector(
        `[data-ui="${UI.expenseBreakdown.normalExpense}"]`,
      ) as HTMLButtonElement,
    );

    expect(onDrillDown).toHaveBeenCalledWith({
      expenseKind: 'normal',
      from: '2026-07-01',
      to: '2026-07-30',
    });
  });
});
