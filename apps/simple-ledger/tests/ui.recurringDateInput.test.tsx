import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { ToastProvider } from '@snishi/foundation/ui/toast';
import { patchDialogIfNeeded } from '@snishi/foundation/ui/test-utils';
import { createRecurringRule, loadLedger } from '../src/data/repository';
import { addMonths } from '../src/domain/allocation';
import { clampDayToMonth } from '../src/domain/recurring';
import { LedgerProvider, useLedger } from '../src/state/store';
import { UI } from '../src/ui-contract';
import { _resetOverlaysForTests } from '../src/ui/overlays';
import { Allocations } from '../src/ui/screens/Allocations';
import { todayLocal } from '../src/util/time';
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
  return status === 'ready' ? (
    <Allocations period={{ mode: 'date', date: '2031-02-28' }} onEditEntry={() => undefined} />
  ) : null;
}

describe('定期ルールの初回起票日', () => {
  it('1つの日付から startMonth と dayOfMonth を導出して保存する', async () => {
    render(<View />);
    await waitFor(() => {
      expect(document.querySelector(`[data-ui="${UI.allocations.view}"]`)).toBeInTheDocument();
    });

    fireEvent.click(document.querySelector(`[data-ui="${UI.allocations.unifiedAdd}"]`)!);
    fireEvent.click(document.querySelector(`[data-ui="${UI.allocations.addChooser}.rule"]`)!);

    const name = document.querySelector(
      `[data-ui="${UI.allocations.recurringName}"]`,
    ) as HTMLInputElement;
    const amount = document.querySelector(
      `[data-ui="${UI.allocations.recurringAmount}"]`,
    ) as HTMLInputElement;
    const firstDate = document.querySelector(
      `[data-ui="${UI.allocations.recurringFirstPostingDate}"]`,
    ) as HTMLInputElement;
    const ruleStartDate = document.querySelector(
      `[data-ui="${UI.allocations.recurringStartDate}"]`,
    ) as HTMLInputElement;
    expect(firstDate.type).toBe('date');
    expect(ruleStartDate).toHaveValue(todayLocal());

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
    expect(saved).toMatchObject({
      startMonth: '2031-03',
      dayOfMonth: 31,
      startDate: todayLocal(),
    });
  });

  it('編集時は存在しない日をその月の最終日へ丸めて日付欄へ戻す', async () => {
    const ledger = await loadLedger();
    const cash = ledger.accounts.find((account) => account.role === 'daily-asset')!;
    const expense = ledger.accounts.find((account) => account.role === 'expense-category')!;
    await createRecurringRule({
      name: '月末ルール',
      amount: 100000,
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
      amount: 100000,
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
    fireEvent.change(document.querySelector(`[data-ui="${UI.allocations.recurringAmount}"]`)!, {
      target: { value: '2000' },
    });
    fireEvent.click(document.querySelector(`[data-ui="${UI.allocations.recurringSave}"]`)!);
    await waitFor(() => {
      expect(
        document.querySelector(`[data-ui="${UI.allocations.recurringAmountChangeDialog}"]`),
      ).toBeInTheDocument();
    });
    fireEvent.click(
      document.querySelector(`[data-ui="${UI.allocations.recurringAmountChangeAll}"]`)!,
    );

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
    expect(saved).toMatchObject({ startMonth: '2031-02', dayOfMonth: 31, amount: 200000 });
  });

  it('日付欄の日を変えたときは新しい dayOfMonth を保存する', async () => {
    const ledger = await loadLedger();
    const cash = ledger.accounts.find((account) => account.role === 'daily-asset')!;
    const expense = ledger.accounts.find((account) => account.role === 'expense-category')!;
    await createRecurringRule({
      name: '月末ルール（変更）',
      amount: 100000,
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

describe('費用行きルール', () => {
  it('周期 12 でも費用を選ぶだけで spreadExpenseAccountId を持ち、借方が台帳に固定される', async () => {
    render(<View />);
    await waitFor(() => {
      expect(document.querySelector(`[data-ui="${UI.allocations.view}"]`)).toBeInTheDocument();
    });

    fireEvent.click(document.querySelector(`[data-ui="${UI.allocations.unifiedAdd}"]`)!);
    fireEvent.click(document.querySelector(`[data-ui="${UI.allocations.addChooser}.rule"]`)!);

    fireEvent.change(document.querySelector(`[data-ui="${UI.allocations.recurringName}"]`)!, {
      target: { value: '年払い保険' },
    });
    fireEvent.change(document.querySelector(`[data-ui="${UI.allocations.recurringAmount}"]`)!, {
      target: { value: '60000' },
    });
    fireEvent.change(document.querySelector(`[data-ui="${UI.allocations.recurringEvery}"]`)!, {
      target: { value: '12' },
    });
    fireEvent.click(
      within(document.querySelector(`[data-ui="${UI.allocations.recurringTo}"]`)!).getByRole(
        'radio',
        { name: '固定費' },
      ),
    );
    expect(document.querySelector('[data-ui="allocations.recurring.manualSpread"]')).toBeNull();
    fireEvent.click(document.querySelector(`[data-ui="${UI.allocations.recurringSave}"]`)!);

    await waitFor(
      () => {
        expect(
          document.querySelector(`[data-ui="${UI.allocations.recurringSheet}"]`),
        ).not.toBeInTheDocument();
      },
      { timeout: 3000 },
    );

    const ledger = await loadLedger();
    const saved = ledger.recurringRules.find((rule) => rule.name === '年払い保険');
    const ledgerAccount = ledger.accounts.find(
      (account) => account.role === 'continuing-cost-asset',
    )!;
    const spread = ledger.accounts.find((account) => account.id === saved!.spreadExpenseAccountId);
    expect(saved).toMatchObject({ everyMonths: 12, debitAccountId: ledgerAccount.id });
    expect(spread?.role).toBe('expense-category');
    // 起票済みぶんの item（継続コスト資産）が決定的 ID で生まれている。
    const item = ledger.monthlyCostItems.find((m) => m.id.startsWith(`ccr-${saved!.id}-`));
    expect(item).toMatchObject({
      name: '年払い保険',
      amount: 6000000,
      expenseAccountId: saved!.spreadExpenseAccountId,
    });
  });

  it('周期 1 でも費用を選ぶだけで起票日開始・次回起票日終了の item が生まれる', async () => {
    render(<View />);
    await waitFor(() => {
      expect(document.querySelector(`[data-ui="${UI.allocations.view}"]`)).toBeInTheDocument();
    });

    fireEvent.click(document.querySelector(`[data-ui="${UI.allocations.unifiedAdd}"]`)!);
    fireEvent.click(document.querySelector(`[data-ui="${UI.allocations.addChooser}.rule"]`)!);
    fireEvent.change(document.querySelector(`[data-ui="${UI.allocations.recurringName}"]`)!, {
      target: { value: '毎月サブスク' },
    });
    fireEvent.change(document.querySelector(`[data-ui="${UI.allocations.recurringAmount}"]`)!, {
      target: { value: '1000' },
    });
    fireEvent.click(
      within(document.querySelector(`[data-ui="${UI.allocations.recurringTo}"]`)!).getByRole(
        'radio',
        { name: '固定費' },
      ),
    );
    expect(document.querySelector('[data-ui="allocations.recurring.manualSpread"]')).toBeNull();
    fireEvent.click(document.querySelector(`[data-ui="${UI.allocations.recurringSave}"]`)!);

    await waitFor(
      () => {
        expect(
          document.querySelector(`[data-ui="${UI.allocations.recurringSheet}"]`),
        ).not.toBeInTheDocument();
      },
      { timeout: 3000 },
    );

    const ledger = await loadLedger();
    const saved = ledger.recurringRules.find((rule) => rule.name === '毎月サブスク');
    const ledgerAccount = ledger.accounts.find(
      (account) => account.role === 'continuing-cost-asset',
    )!;
    const spread = ledger.accounts.find((account) => account.id === saved!.spreadExpenseAccountId);
    expect(saved!.everyMonths).toBe(1);
    // 費用行きなので台帳経由（借方 = 台帳・費用の行き先 = 支出カテゴリ）。
    expect(saved).toMatchObject({ debitAccountId: ledgerAccount.id });
    expect(spread?.role).toBe('expense-category');
    // 起票済みぶんの item は起票日開始・次回起票日終了で毎月生まれて消える。
    // 新規ルールの dayOfMonth は初回起票日（= 今日）の日そのもの。
    const today = todayLocal();
    const dayOfMonth = Number.parseInt(today.slice(8, 10), 10);
    expect(saved!.dayOfMonth).toBe(dayOfMonth);
    const item = ledger.monthlyCostItems.find((m) => m.id.startsWith(`ccr-${saved!.id}-`));
    expect(item).toMatchObject({ name: '毎月サブスク', amount: 100000, startDate: today });
    // endDate = 起票月 + everyMonths(1) を dayOfMonth でクランプ = 次回起票日と同日。
    expect(item!.endDate).toBe(clampDayToMonth(addMonths(today.slice(0, 7), 1), dayOfMonth));
  });
});
