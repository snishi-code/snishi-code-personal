import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import { ToastProvider } from '@snishi/foundation/ui/toast';
import { patchDialogIfNeeded } from '@snishi/foundation/ui/test-utils';
import { App } from '../src/App';
import { CONTINUOUS_COST_HARD_CAP } from '../src/domain/continuousCost';
import { createRecurringRule, loadLedger } from '../src/data/repository';
import { clearOnboardingDone, markOnboardingDone } from '../src/data/localFlags';
import { LedgerProvider } from '../src/state/store';
import { UI } from '../src/ui-contract';
import { _resetOverlaysForTests } from '../src/ui/overlays';
import { todayLocal } from '../src/util/time';
import './setup';

beforeAll(() => {
  patchDialogIfNeeded();
});

beforeEach(() => {
  markOnboardingDone();
});

afterEach(() => {
  cleanup();
  _resetOverlaysForTests();
  clearOnboardingDone();
});

describe('未来開始の定期ルールへの期間ナビゲーション', () => {
  it('ヘッダーの日付チップ（透明な date input・1 タップ）で未来の断面を選べる', async () => {
    const ledger = await loadLedger();
    const cash = ledger.accounts.find((account) => account.role === 'daily-asset')!;
    const expense = ledger.accounts.find((account) => account.role === 'expense-category')!;
    const futureYear = Number.parseInt(todayLocal().slice(0, 4), 10) + 11;
    await createRecurringRule({
      name: '未来開始の定期支出',
      amount: 1000,
      dayOfMonth: 15,
      debitAccountId: expense.id,
      creditAccountId: cash.id,
      startMonth: `${futureYear}-04`,
    });

    render(
      <ToastProvider>
        <LedgerProvider>
          <App />
        </LedgerProvider>
      </ToastProvider>,
    );
    await waitFor(() => {
      expect(document.querySelector('[data-ui="dashboard.view"]')).toBeInTheDocument();
    });

    const trigger = document.querySelector(`[data-ui="${UI.period.dateTrigger}"]`) as HTMLElement;
    expect(trigger).toHaveTextContent(todayLocal());

    // ポップアップ経由なし: チップ内の透明な date input が常在し、値変更で即 period が更新される。
    const dateInput = document.querySelector(
      `[data-ui="${UI.period.dateInput}"]`,
    ) as HTMLInputElement;
    expect(dateInput.type).toBe('date');
    expect(dateInput.value).toBe(todayLocal());
    expect(dateInput.max).toBe(CONTINUOUS_COST_HARD_CAP);
    fireEvent.change(dateInput, { target: { value: `${futureYear}-04-15` } });

    await waitFor(() => {
      expect(document.querySelector(`[data-ui="${UI.period.dateTrigger}"]`)).toHaveTextContent(
        `${futureYear}-04-15`,
      );
    });
    expect(dateInput.value).toBe(`${futureYear}-04-15`);

    expect(document.querySelector('[data-ui="period.year.trigger"]')).not.toBeInTheDocument();
    expect(document.querySelector('[data-ui="period.date.picker"]')).not.toBeInTheDocument();
  });
});
