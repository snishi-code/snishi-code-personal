import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import { ToastProvider } from '@snishi/foundation/ui/toast';
import { patchDialogIfNeeded } from '@snishi/foundation/ui/test-utils';
import { App } from '../src/App';
import { loadLedger, upsertEntry } from '../src/data/repository';
import { clearOnboardingDone, markOnboardingDone } from '../src/data/localFlags';
import { LedgerProvider } from '../src/state/store';
import { UI } from '../src/ui-contract';
import { _resetOverlaysForTests } from '../src/ui/overlays';
import { todayLocal } from '../src/util/time';
import './setup';

beforeAll(() => patchDialogIfNeeded());
beforeEach(() => markOnboardingDone());
afterEach(() => {
  cleanup();
  _resetOverlaysForTests();
  clearOnboardingDone();
});

describe('タイムラインの画面接続', () => {
  it('メニューから開き、保存仕訳のポッチを既存の仕訳詳細で開く', async () => {
    const ledger = await loadLedger();
    const cash = ledger.accounts.find((account) => account.role === 'daily-asset')!;
    const expense = ledger.accounts.find((account) => account.role === 'expense-category')!;
    const now = new Date().toISOString();
    await upsertEntry({
      id: 'timeline-navigation-entry',
      date: todayLocal(),
      description: 'タイムライン遷移確認',
      kind: 'normal',
      lines: [
        { accountId: expense.id, side: 'debit', amount: 1234 },
        { accountId: cash.id, side: 'credit', amount: 1234 },
      ],
      createdAt: now,
      updatedAt: now,
    });

    render(
      <ToastProvider>
        <LedgerProvider>
          <App />
        </LedgerProvider>
      </ToastProvider>,
    );
    await waitFor(() =>
      expect(document.querySelector(`[data-ui="${UI.dashboard.view}"]`)).toBeInTheDocument(),
    );

    fireEvent.click(document.querySelector(`[data-ui="${UI.nav.menuButton}"]`)!);
    fireEvent.click(
      await waitFor(() => {
        const item = document.querySelector('[data-ui="nav.timeline"]');
        expect(item).toBeInTheDocument();
        return item!;
      }),
    );
    await waitFor(() =>
      expect(document.querySelector(`[data-ui="${UI.timeline.view}"]`)).toBeInTheDocument(),
    );

    fireEvent.click(document.querySelector(`[data-ui="${UI.timeline.flowDot}"]`)!);
    expect(document.querySelector(`[data-ui="${UI.timeline.popover}"]`)).toHaveTextContent(
      `${cash.name} → ${expense.name}`,
    );
    fireEvent.click(document.querySelector(`[data-ui="${UI.timeline.open}"]`)!);

    await waitFor(() => {
      expect(document.querySelector(`[data-ui="${UI.journal.view}"]`)).toBeInTheDocument();
      expect(document.querySelector(`[data-ui="${UI.journal.entry.save}"]`)).toBeInTheDocument();
    });
  });
});
