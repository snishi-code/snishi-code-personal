import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { ToastProvider } from '@snishi/foundation/ui/toast';
import { patchDialogIfNeeded } from '@snishi/foundation/ui/test-utils';
import { LedgerProvider } from '../src/state/store';
import { Dashboard } from '../src/ui/screens/Dashboard';
import { Accounts } from '../src/ui/screens/Accounts';
import { Breakdown } from '../src/ui/screens/Breakdown';
import { Allocations } from '../src/ui/screens/Allocations';
import { AdjustmentCreateSheet, AdjustmentEditSheet } from '../src/ui/AdjustmentSheet';
import { OpeningEditSheet, OpeningRegisterSheet } from '../src/ui/OpeningSheet';
import {
  createContinuousCost,
  createOpenings,
  createRepaymentEntries,
  disposeContinuousCost,
  loadLedger,
  upsertMonthlyCost,
} from '../src/data/repository';
import { _resetOverlaysForTests } from '../src/ui/overlays';
import { todayLocal } from '../src/util/time';
import type { ReportPeriod } from '../src/domain/reportPeriod';
import type { JournalEntry } from '../src/domain/types';
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

function dashboard(period: ReportPeriod) {
  return (
    <Providers>
      <Dashboard
        period={period}
        onPeriodChange={() => undefined}
        onAddEntry={() => undefined}
        onEditEntry={() => undefined}
        onNavigate={() => undefined}
        onOpenJournal={() => undefined}
      />
    </Providers>
  );
}

describe('追補監査の画面回帰', () => {
  it('補正・初期残高の作成と編集は空の必須日付では保存できない', async () => {
    const ledger = await loadLedger();
    const cash = ledger.accounts.find((account) => account.name === '現金')!;
    const expense = ledger.accounts.find((account) => account.name === '固定費')!;
    const equity = ledger.accounts.find((account) => account.role === 'equity')!;
    const timestamp = '2026-01-01T00:00:00.000Z';
    const adjustment: JournalEntry = {
      id: 'ui-adjustment',
      date: '2026-01-01',
      description: '残高補正',
      kind: 'normal',
      lines: [
        { accountId: cash.id, side: 'debit', amount: 100 },
        { accountId: expense.id, side: 'credit', amount: 100 },
      ],
      metadata: {
        adjustment: {
          kind: 'unknown-balance',
          accountId: cash.id,
          expectedBalance: 0,
          actualBalance: 100,
          delta: 100,
          counterpartAccountId: expense.id,
        },
      },
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    const opening: JournalEntry = {
      id: 'ui-opening',
      date: '2026-01-01',
      description: '初期残高',
      kind: 'opening',
      lines: [
        { accountId: cash.id, side: 'debit', amount: 100 },
        { accountId: equity.id, side: 'credit', amount: 100 },
      ],
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    const cases = [
      {
        content: <AdjustmentCreateSheet account={cash} onClose={() => undefined} />,
        dateUi: 'adjust.date',
        saveUi: 'adjust.save',
      },
      {
        content: <AdjustmentEditSheet entry={adjustment} onClose={() => undefined} />,
        dateUi: 'adjustments.edit.date',
        saveUi: 'adjustments.edit.save',
      },
      {
        content: <OpeningRegisterSheet account={cash} onClose={() => undefined} />,
        dateUi: 'adjustments.openingRegister.date',
        saveUi: 'adjustments.openingRegister.save',
      },
      {
        content: <OpeningEditSheet entry={opening} onClose={() => undefined} />,
        dateUi: 'opening.edit.date',
        saveUi: 'opening.edit.save',
      },
    ];

    for (const testCase of cases) {
      const view = render(<Providers>{testCase.content}</Providers>);
      await waitFor(() => {
        expect(document.querySelector(`[data-ui="${testCase.dateUi}"]`)).toBeInTheDocument();
      });
      const dateInput = document.querySelector(
        `[data-ui="${testCase.dateUi}"]`,
      ) as HTMLInputElement;
      const saveButton = document.querySelector(
        `[data-ui="${testCase.saveUi}"]`,
      ) as HTMLButtonElement;
      expect(dateInput.closest('.field')).toHaveTextContent('（必須）');
      fireEvent.change(dateInput, { target: { value: '' } });
      expect(saveButton).toBeDisabled();
      view.unmount();
      _resetOverlaysForTests();
    }
  });

  it('未来月・未来年は期間末まで投影し、全期間と勘定科目は today 時点の残高を表示する', async () => {
    const ledger = await loadLedger();
    const cash = ledger.accounts.find((account) => account.name === '現金')!;
    const liability = ledger.accounts.find((account) => account.role === 'payment-liability')!;
    await createOpenings([
      { accountId: cash.id, amount: 600000, date: '2000-01-01' },
      { accountId: liability.id, amount: 600000, date: '2000-01-01' },
    ]);
    const futureYear = Number(todayLocal().slice(0, 4)) + 2;
    await createRepaymentEntries({
      liabilityAccountId: liability.id,
      fromAccountId: cash.id,
      firstDate: `${futureYear}-01-15`,
      total: 50000,
      count: 1,
      title: '未来返済',
    });

    const view = render(dashboard({ mode: 'date', date: `${futureYear}-01-31` }));
    const expectDashboardBalances = async (amount: string) => {
      await waitFor(() => {
        expect(document.querySelector('[data-ui="dashboard.stat.assets"]')).toHaveTextContent(
          amount,
        );
        expect(document.querySelector('[data-ui="dashboard.stat.liabilities"]')).toHaveTextContent(
          amount,
        );
      });
    };
    // 未来月・未来年は選択期間の末日までを投影するため、1月15日の未来返済を含む。
    await expectDashboardBalances('550,000');
    expect(screen.getByText(`財政状態（${futureYear}-01-31 時点）`)).toBeInTheDocument();

    view.rerender(dashboard({ mode: 'year', year: futureYear }));
    await expectDashboardBalances('550,000');
    expect(screen.getByText(`財政状態（${futureYear}-12-31 時点）`)).toBeInTheDocument();

    // 全期間は「未来を無制限に含む」のではなく today が基準。
    view.rerender(dashboard({ mode: 'all' }));
    await expectDashboardBalances('600,000');
    expect(screen.getByText(`財政状態（${todayLocal()} 時点）`)).toBeInTheDocument();
    view.unmount();

    render(
      <Providers>
        <Accounts />
      </Providers>,
    );
    const cashRow = (await screen.findByText(cash.name)).closest('li');
    const liabilityRow = (await screen.findByText(liability.name)).closest('li');
    expect(cashRow).not.toBeNull();
    expect(liabilityRow).not.toBeNull();
    expect(within(cashRow!).getByText(/600,000/)).toBeInTheDocument();
    expect(within(liabilityRow!).getByText(/600,000/)).toBeInTheDocument();
  });

  it('継続コストを含むホーム資産内訳と勘定科目は同じ現金残高を表示する', async () => {
    const ledger = await loadLedger();
    const cash = ledger.accounts.find((account) => account.name === '現金')!;
    const expense = ledger.accounts.find((account) => account.name === '固定費')!;
    await createOpenings([{ accountId: cash.id, amount: 500000, date: '2000-01-01' }]);
    await createContinuousCost({
      name: '年払いサービス',
      kind: 'prepaid-service',
      amount: 120000,
      costMonths: 12,
      startMonth: todayLocal().slice(0, 7),
      expenseAccountId: expense.id,
      paymentSourceAccountId: cash.id,
    });

    const view = render(
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
    const homeCashRow = (await screen.findByText(cash.name)).closest('button');
    expect(homeCashRow).not.toBeNull();
    expect(within(homeCashRow!).getByText(/380,000/)).toBeInTheDocument();
    view.unmount();
    _resetOverlaysForTests();

    render(
      <Providers>
        <Accounts />
      </Providers>,
    );
    const accountCashRow = (await screen.findByText(cash.name)).closest('li');
    expect(accountCashRow).not.toBeNull();
    expect(within(accountCashRow!).getByText(/380,000/)).toBeInTheDocument();
  });

  it('継続コストの操作可否を処分記録で判定し、処分済みは名称だけ編集できる', async () => {
    const ledger = await loadLedger();
    const cash = ledger.accounts.find((account) => account.name === '現金')!;
    const expense = ledger.accounts.find((account) => account.name === '固定費')!;
    const endedWithoutDisposal = await createContinuousCost({
      name: '未処分終了',
      kind: 'prepaid-service',
      amount: 12000,
      costMonths: 12,
      repeatEveryMonths: 12,
      startMonth: '2026-01',
      expenseAccountId: expense.id,
      paymentSourceAccountId: cash.id,
    });
    await upsertMonthlyCost({
      ...endedWithoutDisposal,
      status: 'ended',
      endMonth: '2026-06',
    });
    const disposed = await createContinuousCost({
      name: '処分済み',
      kind: 'prepaid-service',
      amount: 12000,
      costMonths: 12,
      repeatEveryMonths: 12,
      startMonth: '2026-01',
      expenseAccountId: expense.id,
      paymentSourceAccountId: cash.id,
    });
    await disposeContinuousCost({
      monthlyCostId: disposed.id,
      disposalDate: '2026-07-15',
      proceedsAmount: 0,
    });
    const disposedBeforeRename = (await loadLedger()).monthlyCostItems.find(
      (item) => item.id === disposed.id,
    )!;

    render(
      <Providers>
        <Allocations />
      </Providers>,
    );
    await waitFor(() => {
      expect(document.querySelector('[data-ui="allocations.view"]')).toBeInTheDocument();
    });
    expect(screen.queryByText(endedWithoutDisposal.name)).not.toBeInTheDocument();
    expect(screen.queryByText(disposed.name)).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('checkbox', { name: '停止・終了分も表示' }));
    expect(await screen.findByText(endedWithoutDisposal.name)).toBeInTheDocument();
    expect(await screen.findByText(disposed.name)).toBeInTheDocument();

    expect(
      screen.getByRole('button', { name: `編集: ${endedWithoutDisposal.name}` }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: `再開: ${endedWithoutDisposal.name}` }),
    ).toBeInTheDocument();

    expect(screen.getByRole('button', { name: `編集: ${disposed.name}` })).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: `再開: ${disposed.name}` }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: `削除: ${disposed.name}` }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: `売却・終了: ${disposed.name}` }),
    ).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: `編集: ${disposed.name}` }));
    await screen.findByText('処分済みの継続コストは名称以外変更できません。');
    const editDialog = document.querySelector('[data-ui="allocations.editDialog"]');
    expect(editDialog).not.toBeNull();
    expect(within(editDialog!).getByLabelText(/名称/)).toBeEnabled();
    expect(within(editDialog!).queryByLabelText(/総額/)).not.toBeInTheDocument();
    expect(editDialog!.querySelectorAll('input')).toHaveLength(1);
    expect(editDialog!.querySelectorAll('select')).toHaveLength(0);

    fireEvent.change(within(editDialog!).getByLabelText(/名称/), {
      target: { value: '処分済み・名称変更' },
    });
    fireEvent.click(screen.getByRole('button', { name: '保存' }));

    await waitFor(async () => {
      const updated = (await loadLedger()).monthlyCostItems.find((item) => item.id === disposed.id);
      expect(updated).toBeDefined();
      expect(updated).toEqual({
        ...disposedBeforeRename,
        name: '処分済み・名称変更',
        updatedAt: updated!.updatedAt,
      });
    });
  });
});
