import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { ToastProvider } from '@snishi/foundation/ui/toast';
import { patchDialogIfNeeded } from '@snishi/foundation/ui/test-utils';
import { createRecurringRule, loadLedger } from '../src/data/repository';
import { LedgerProvider, useLedger } from '../src/state/store';
import { UI } from '../src/ui-contract';
import { _resetOverlaysForTests } from '../src/ui/overlays';
import { Allocations } from '../src/ui/screens/Allocations';
import './setup';

beforeAll(() => {
  patchDialogIfNeeded();
});

afterEach(() => {
  cleanup();
  _resetOverlaysForTests();
});

function View() {
  return (
    <ToastProvider>
      <LedgerProvider>
        <ReadyView />
      </LedgerProvider>
    </ToastProvider>
  );
}

function ReadyView() {
  const { status } = useLedger();
  return status === 'ready' ? <Allocations /> : null;
}

describe('定期ルールの初回起票日', () => {
  it('1つの日付から startMonth と dayOfMonth を導出して保存する', async () => {
    render(<View />);
    await waitFor(() => {
      expect(document.querySelector(`[data-ui="${UI.allocations.view}"]`)).toBeInTheDocument();
    });

    fireEvent.click(document.querySelector(`[data-ui="${UI.allocations.unifiedAdd}"]`)!);
    fireEvent.click(document.querySelector(`[data-ui="${UI.allocations.addChooser}.expense"]`)!);

    const name = document.querySelector(
      `[data-ui="${UI.allocations.recurringName}"]`,
    ) as HTMLInputElement;
    const amount = document.querySelector(
      `[data-ui="${UI.allocations.recurringAmount}"]`,
    ) as HTMLInputElement;
    const firstDate = document.querySelector(
      `[data-ui="${UI.allocations.recurringFirstPostingDate}"]`,
    ) as HTMLInputElement;
    expect(firstDate.type).toBe('date');

    fireEvent.change(name, { target: { value: '未来の定期支出' } });
    fireEvent.change(amount, { target: { value: '1500' } });
    fireEvent.change(firstDate, { target: { value: '2031-03-31' } });
    const save = document.querySelector(
      `[data-ui="${UI.allocations.recurringSave}"]`,
    ) as HTMLButtonElement;
    expect(save).toBeEnabled();
    fireEvent.click(save);

    await waitFor(
      () => {
        expect(
          document.querySelector(`[data-ui="${UI.allocations.recurringSheet}"]`),
        ).not.toBeInTheDocument();
      },
      { timeout: 3000 },
    );

    const saved = (await loadLedger()).recurringRules.find(
      (rule) => rule.name === '未来の定期支出',
    );
    expect(saved).toMatchObject({ startMonth: '2031-03', dayOfMonth: 31 });
  });

  it('編集時は存在しない日をその月の最終日へ丸めて日付欄へ戻す', async () => {
    const ledger = await loadLedger();
    const cash = ledger.accounts.find((account) => account.role === 'daily-asset')!;
    const expense = ledger.accounts.find((account) => account.role === 'expense-category')!;
    await createRecurringRule({
      name: '月末ルール',
      amount: 1000,
      dayOfMonth: 31,
      debitAccountId: expense.id,
      creditAccountId: cash.id,
      startMonth: '2031-02',
    });

    render(<View />);
    await screen.findByText('月末ルール');
    fireEvent.click(document.querySelector(`[data-ui="${UI.allocations.recurringEdit}"]`)!);

    expect(
      document.querySelector(`[data-ui="${UI.allocations.recurringFirstPostingDate}"]`),
    ).toHaveValue('2031-02-28');
  });

  it('日付を触らずに保存し直しても dayOfMonth は書き換わらない', async () => {
    const ledger = await loadLedger();
    const cash = ledger.accounts.find((account) => account.role === 'daily-asset')!;
    const expense = ledger.accounts.find((account) => account.role === 'expense-category')!;
    await createRecurringRule({
      name: '月末ルール（据え置き）',
      amount: 1000,
      dayOfMonth: 31,
      debitAccountId: expense.id,
      creditAccountId: cash.id,
      startMonth: '2031-02',
    });

    render(<View />);
    await screen.findByText('月末ルール（据え置き）');
    fireEvent.click(document.querySelector(`[data-ui="${UI.allocations.recurringEdit}"]`)!);
    // 日付欄は 2031-02-28（31 を 2 月へクランプした表示）。日付は触らず金額だけ変えて保存する
    // （金額の変化で「保存が実際に走った」ことを確かめる＝空振りで通らないようにする）。
    fireEvent.change(
      document.querySelector(`[data-ui="${UI.allocations.recurringAmount}"]`)!,
      { target: { value: '2000' } },
    );
    fireEvent.click(document.querySelector(`[data-ui="${UI.allocations.recurringSave}"]`)!);

    await waitFor(
      () => {
        expect(
          document.querySelector(`[data-ui="${UI.allocations.recurringSheet}"]`),
        ).not.toBeInTheDocument();
      },
      { timeout: 3000 },
    );

    const saved = (await loadLedger()).recurringRules.find(
      (rule) => rule.name === '月末ルール（据え置き）',
    );
    expect(saved).toMatchObject({ startMonth: '2031-02', dayOfMonth: 31, amount: 2000 });
  });

  it('日付欄の日を変えたときは新しい dayOfMonth を保存する', async () => {
    const ledger = await loadLedger();
    const cash = ledger.accounts.find((account) => account.role === 'daily-asset')!;
    const expense = ledger.accounts.find((account) => account.role === 'expense-category')!;
    await createRecurringRule({
      name: '月末ルール（変更）',
      amount: 1000,
      dayOfMonth: 31,
      debitAccountId: expense.id,
      creditAccountId: cash.id,
      startMonth: '2031-02',
    });

    render(<View />);
    await screen.findByText('月末ルール（変更）');
    fireEvent.click(document.querySelector(`[data-ui="${UI.allocations.recurringEdit}"]`)!);
    fireEvent.change(
      document.querySelector(`[data-ui="${UI.allocations.recurringFirstPostingDate}"]`)!,
      { target: { value: '2031-02-10' } },
    );
    fireEvent.click(document.querySelector(`[data-ui="${UI.allocations.recurringSave}"]`)!);

    await waitFor(
      () => {
        expect(
          document.querySelector(`[data-ui="${UI.allocations.recurringSheet}"]`),
        ).not.toBeInTheDocument();
      },
      { timeout: 3000 },
    );

    const saved = (await loadLedger()).recurringRules.find(
      (rule) => rule.name === '月末ルール（変更）',
    );
    expect(saved).toMatchObject({ startMonth: '2031-02', dayOfMonth: 10 });
  });
});

describe('契約持ち込みの数字欄エラー', () => {
  it('残存価値と更新支払額を、それぞれの欄で具体的に示す', async () => {
    render(<View />);
    await waitFor(() => {
      expect(document.querySelector(`[data-ui="${UI.allocations.view}"]`)).toBeInTheDocument();
    });

    fireEvent.click(document.querySelector(`[data-ui="${UI.allocations.unifiedAdd}"]`)!);
    fireEvent.click(
      document.querySelector(`[data-ui="${UI.allocations.addChooser}.sub-migration"]`)!,
    );

    fireEvent.change(
      document.querySelector(`[data-ui="${UI.allocations.subMigrationName}"]`)!,
      { target: { value: '契約持ち込み' } },
    );
    fireEvent.change(
      document.querySelector(`[data-ui="${UI.allocations.subMigrationRemaining}"]`)!,
      { target: { value: '0' } },
    );
    fireEvent.change(
      document.querySelector(`[data-ui="${UI.allocations.subMigrationMonths}"]`)!,
      { target: { value: '1' } },
    );
    fireEvent.change(
      document.querySelector(`[data-ui="${UI.allocations.subMigrationRenewal}"]`)!,
      { target: { value: '0' } },
    );
    fireEvent.click(
      document.querySelector(`[data-ui="${UI.allocations.subMigrationSave}"]`)!,
    );

    expect(screen.getByText('残存価値は 1 以上の整数で入力してください。')).toBeInTheDocument();
    expect(
      screen.getByText('更新ごとの支払額は 1 以上の整数で入力してください。'),
    ).toBeInTheDocument();
  });
});
