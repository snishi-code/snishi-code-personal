/*
 * mutation 検証 ①（ローンの出し分けの正本）。
 *
 * 「台帳に出るのはルールを持つ負債だけ / 資金繰りの行タップはルールの有無で振り分ける」の
 * 判定は domain/loan.ts の 2 関数（isLoanRule / loanRuleForLiability）が単一正本で、
 * 画面はそれを読むだけ——を機械的に示す。テスト内で正本を**反転**し、
 * 月割り台帳のローン扱い（種別タグ・残回数・負債の色）と資金繰りのタップ先が
 * まるごと追従することを見る（画面側に判定のコピーが無い証明）。
 */
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import { ToastProvider } from '@snishi/foundation/ui/toast';
import { patchDialogIfNeeded } from '@snishi/foundation/ui/test-utils';

vi.mock('../src/domain/loan', async () => {
  const actual = await vi.importActual<typeof import('../src/domain/loan')>('../src/domain/loan');
  return {
    ...actual,
    // 反転: どのルールもローンではない / どの負債にも返済ルールは無い。
    isLoanRule: () => false,
    loanRuleForLiability: () => undefined,
  };
});

const { LedgerProvider, useLedger } = await import('../src/state/store');
const { Allocations } = await import('../src/ui/screens/Allocations');
const { Cashflow } = await import('../src/ui/screens/Cashflow');
const { createLoanPurchase, createOpenings, loadLedger } = await import('../src/data/repository');
const { addMonthsToDate } = await import('../src/domain/allocation');
const { UI } = await import('../src/ui-contract');
const { _resetOverlaysForTests } = await import('../src/ui/overlays');
const { todayLocal } = await import('../src/util/time');
await import('./setup');

beforeAll(() => {
  patchDialogIfNeeded();
});

afterEach(() => {
  cleanup();
  _resetOverlaysForTests();
});

const ui = (name: string) => document.querySelector<HTMLElement>(`[data-ui="${name}"]`);
const period = { mode: 'date' as const, date: todayLocal() };

function View({ children }: { children: React.ReactNode }) {
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

async function makeLoan() {
  const ledger = await loadLedger();
  const cash = ledger.accounts.find((a) => a.name === '現金')!;
  const expense = ledger.accounts.find((a) => a.role === 'expense-category')!;
  await createOpenings([{ accountId: cash.id, amount: 500000000, date: '2000-01-01' }]);
  return createLoanPurchase({
    loanName: '自動車ローン',
    date: todayLocal(),
    description: '自動車',
    amount: 12000000,
    expenseAccountId: expense.id,
    repaymentFromAccountId: cash.id,
    repaymentEndDate: addMonthsToDate(todayLocal(), 13),
  });
}

describe('mutation: ローンの判定を反転すると画面が追従する', () => {
  it('月割り台帳の行はローン扱いを失う（種別タグ・残回数・負債の色）', async () => {
    await makeLoan();
    render(
      <View>
        <Allocations period={period} onEditEntry={() => undefined} target={null} />
      </View>,
    );
    await waitFor(() => expect(ui(UI.allocations.recurringList)).toBeInTheDocument());

    const row = ui(UI.allocations.recurringList)!.querySelector('li')!;
    // 行そのものはルールなので残る（台帳に並ぶこと自体はルールの存在が決める）。
    expect(row).toHaveTextContent('自動車ローン');
    // ローン扱いだけが消える = 3 箇所とも同じ正本を読んでいる。
    expect(row).not.toHaveTextContent('ローン（返済）');
    expect(ui(UI.allocations.loanRemaining)).not.toBeInTheDocument();
    expect(row.querySelector('.row-trailing .list__amount span')).not.toHaveClass(
      'amount--liability',
    );
    expect(row).not.toHaveAttribute('data-account-id');
  });

  it('資金繰りの負債行のタップ先が勘定科目へ倒れる', async () => {
    const { liability } = await makeLoan();
    const onOpenAllocations = vi.fn();
    const onOpenAccount = vi.fn();
    render(
      <View>
        <Cashflow
          period={period}
          zoom="day"
          onEditEntry={() => undefined}
          onOpenAllocations={onOpenAllocations}
          onOpenAccount={onOpenAccount}
          onOpenEntry={() => undefined}
        />
      </View>,
    );
    const row = await waitFor(() => {
      const found = ui(UI.cashflow.liabilityRow);
      expect(found).toBeInTheDocument();
      return found!;
    });
    expect(row).toHaveAttribute('aria-label', '自動車ローン を勘定科目で開く');
    fireEvent.click(row);
    expect(onOpenAccount).toHaveBeenCalledWith(liability.id);
    expect(onOpenAllocations).not.toHaveBeenCalled();
  });
});
