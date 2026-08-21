/*
 * mutation 検証 ①（ローンの出し分けの正本・v13.13）。
 *
 * 「台帳のローン扱い / 資金繰りの行タップの振り分け」の判定は domain/loan.ts の 2 関数
 * （isLoanItem / loanItemForLiability）が単一正本で、画面はそれを読むだけ——を機械的に示す。
 * テスト内で正本を**反転**し、月割り台帳のローン扱い（種別タグ・残回数・負債の色・
 * data-account-id）と資金繰りのタップ先がまるごと追従することを見る
 * （画面側に判定のコピーが無い証明）。
 */
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import { ToastProvider } from '@snishi/foundation/ui/toast';
import { patchDialogIfNeeded } from '@snishi/foundation/ui/test-utils';

// 反転スイッチ: 登録（repository も同じ正本を読む）はそのまま通し、描画の直前だけ反転する。
const mockState = vi.hoisted(() => ({ invert: false }));

vi.mock('../src/domain/loan', async () => {
  const actual = await vi.importActual<typeof import('../src/domain/loan')>('../src/domain/loan');
  return {
    ...actual,
    // 反転中: どの item もローンではない / どの負債にもローン item は無い。
    isLoanItem: (item: Parameters<typeof actual.isLoanItem>[0]) =>
      mockState.invert ? false : actual.isLoanItem(item),
    loanItemForLiability: (
      ...args: Parameters<typeof actual.loanItemForLiability>
    ): ReturnType<typeof actual.loanItemForLiability> =>
      mockState.invert ? undefined : actual.loanItemForLiability(...args),
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
  mockState.invert = false;
  const ledger = await loadLedger();
  const cash = ledger.accounts.find((a) => a.name === '現金')!;
  const expense = ledger.accounts.find((a) => a.role === 'expense-category')!;
  await createOpenings([{ accountId: cash.id, amount: 500000000, date: '2000-01-01' }]);
  const created = await createLoanPurchase({
    loanName: '自動車ローン',
    date: todayLocal(),
    description: '自動車',
    amount: 12000000,
    expenseAccountId: expense.id,
    repaymentSourceAccountId: cash.id,
    repaymentEndDate: addMonthsToDate(todayLocal(), 12),
  });
  // ここから反転（画面が読む判定だけが倒れる）。
  mockState.invert = true;
  return created;
}

describe('mutation: ローンの判定を反転すると画面が追従する', () => {
  it('月割り台帳のカードはローン扱いを失う（種別タグ・残回数・負債の色・着地点）', async () => {
    await makeLoan();
    render(
      <View>
        <Allocations period={period} onEditEntry={() => undefined} target={null} />
      </View>,
    );
    await waitFor(() => expect(ui(UI.allocations.item)).toBeInTheDocument());

    const card = ui(UI.allocations.item)!;
    // カードそのものは item なので残る（一覧に並ぶこと自体は item の存在が決める）。
    expect(card).toHaveTextContent('自動車ローン');
    // ローン扱いだけが消える = すべて同じ正本を読んでいる。
    expect(card).not.toHaveTextContent('残り 12 回');
    expect(ui(UI.allocations.loanRemaining)).not.toBeInTheDocument();
    expect(card.querySelector('.row-trailing .list__amount span')).not.toHaveClass(
      'amount--liability',
    );
    expect(card).not.toHaveAttribute('data-account-id');
    // 終了（一括返済）ボタンも消え、持ち物のアーカイブボタンに倒れる。
    expect(ui(UI.allocations.loanSettle)).not.toBeInTheDocument();
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
