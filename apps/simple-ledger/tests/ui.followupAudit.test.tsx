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
  loadLedger,
} from '../src/data/repository';
import { addMonthsToDate } from '../src/domain/allocation';
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
        onOpenAllocations={() => undefined}
        onOpenAccount={() => undefined}
        onOpenEntry={() => undefined}
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
        { accountId: cash.id, side: 'debit', amount: 10000 },
        { accountId: expense.id, side: 'credit', amount: 10000 },
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
        { accountId: cash.id, side: 'debit', amount: 10000 },
        { accountId: equity.id, side: 'credit', amount: 10000 },
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
      { accountId: cash.id, amount: 60000000, date: '2000-01-01' },
      { accountId: liability.id, amount: 60000000, date: '2000-01-01' },
    ]);
    const futureYear = Number(todayLocal().slice(0, 4)) + 2;
    await createRepaymentEntries({
      liabilityAccountId: liability.id,
      fromAccountId: cash.id,
      firstDate: `${futureYear}-01-15`,
      total: 5000000,
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
    // 未来月・未来年は選択期間の末日までを投影するため、1月15日の未来返済を含む
    // （基準日の検証は残高値そのもので行う。「財政状態（〜時点）」見出しは 2026-08-14 に撤去）。
    await expectDashboardBalances('550,000');

    view.rerender(dashboard({ mode: 'year', year: futureYear }));
    await expectDashboardBalances('550,000');

    // 全期間は「未来を無制限に含む」のではなく today が基準。
    view.rerender(dashboard({ mode: 'all' }));
    await expectDashboardBalances('600,000');
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
    await createOpenings([{ accountId: cash.id, amount: 50000000, date: '2000-01-01' }]);
    await createContinuousCost({
      name: '年払いサービス',
      amount: 12000000,
      startDate: todayLocal(),
      endDate: addMonthsToDate(todayLocal(), 11),
      expenseAccountId: expense.id,
      creditAccountId: cash.id,
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

  it('終了日を過ぎた項目は一覧から消え、「終了分も表示」で戻る（アーカイブは導出）', async () => {
    const ledger = await loadLedger();
    const cash = ledger.accounts.find((account) => account.name === '現金')!;
    const expense = ledger.accounts.find((account) => account.name === '固定費')!;
    const today = todayLocal();
    // 終了日が過去 = アーカイブ済み（導出）。
    const ended = await createContinuousCost({
      name: '終了済み項目',
      amount: 1200000,
      startDate: '2026-01-01',
      endDate: addMonthsToDate(today, -1),
      expenseAccountId: expense.id,
      creditAccountId: cash.id,
    });
    // 終了日 = 今日はまだ消えない（< 今日 で判定）。
    const endingToday = await createContinuousCost({
      name: '今日終了の項目',
      amount: 2400000,
      startDate: '2026-01-01',
      endDate: today,
      expenseAccountId: expense.id,
      creditAccountId: cash.id,
    });
    // 終了日なしは永久にアーカイブされない。
    const openEnded = await createContinuousCost({
      name: '終了日なしの項目',
      amount: 4800000,
      startDate: '2026-01-01',
      expenseAccountId: expense.id,
      creditAccountId: cash.id,
    });

    render(
      <Providers>
        <Allocations period={{ mode: 'all' }} onEditEntry={() => undefined} />
      </Providers>,
    );
    await waitFor(() => {
      expect(document.querySelector('[data-ui="allocations.view"]')).toBeInTheDocument();
    });
    expect(screen.queryByText(ended.name)).not.toBeInTheDocument();
    expect(await screen.findByText(endingToday.name)).toBeInTheDocument();
    expect(screen.getByText(openEnded.name)).toBeInTheDocument();
    // 終了日なしの月あたりは数字を出さない（—）。
    const openEndedCard = screen.getByText(openEnded.name).closest('.card');
    expect(openEndedCard).not.toBeNull();
    expect(within(openEndedCard as HTMLElement).getByText('—')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('checkbox', { name: '終了分も表示' }));
    expect(await screen.findByText(ended.name)).toBeInTheDocument();

    // 終了済みの行にもアーカイブ（終了日の変更 = 復元も同じ 1 操作）・編集が出る。
    // 削除は行アクションではなく編集シート最下部（動詞体系 v13.1）。
    expect(screen.getByRole('button', { name: `終了: ${ended.name}` })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: `編集: ${ended.name}` })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: `削除: ${ended.name}` })).not.toBeInTheDocument();
  });
});
