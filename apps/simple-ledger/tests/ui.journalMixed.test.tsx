/*
 * 仕訳一覧の混合表示（§8）:
 *  - 保存される仕訳と計算で生まれる仕訳（費用行・ルール投影）を同じ一覧に日付順で出す
 *  - 計算で生まれた行のタップは「毎月のもの」の元の項目 / ルールへ遷移する
 *  - 購入の仕訳はタップで編集（削除ボタンは出さない）
 *  - from/to には展開上限（2100-12-31）の max が付く
 */
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { ToastProvider } from '@snishi/foundation/ui/toast';
import { patchDialogIfNeeded } from '@snishi/foundation/ui/test-utils';
import { LedgerProvider, useLedger } from '../src/state/store';
import { Journal, type JournalFilter } from '../src/ui/screens/Journal';
import {
  createContinuousCost,
  createRecurringRule,
  loadLedger,
  upsertAccount,
  upsertEntry,
} from '../src/data/repository';
import { CONTINUOUS_COST_HARD_CAP } from '../src/domain/continuousCost';
import { addMonths, addMonthsToDate, monthOf } from '../src/domain/allocation';
import { UI } from '../src/ui-contract';
import { _resetOverlaysForTests } from '../src/ui/overlays';
import { todayLocal } from '../src/util/time';
import { formatMoney } from '../src/util/format';
import type { AllocationsTarget } from '../src/ui/screens/Allocations';
import type { Account, JournalEntry } from '../src/domain/types';
import './setup';

beforeAll(() => {
  patchDialogIfNeeded();
});

afterEach(() => {
  cleanup();
  _resetOverlaysForTests();
});

function View({
  onEditEntry = () => undefined,
  onOpenAllocations = () => undefined,
  onOpenAccount = () => undefined,
  onClearFilter = () => undefined,
  filter = null,
}: {
  onEditEntry?: (entry: JournalEntry) => void;
  onOpenAllocations?: (target: AllocationsTarget) => void;
  onOpenAccount?: (accountId: string) => void;
  onClearFilter?: () => void;
  filter?: JournalFilter | null;
}) {
  return (
    <ToastProvider>
      <LedgerProvider>
        <ReadyView
          onEditEntry={onEditEntry}
          onOpenAllocations={onOpenAllocations}
          onOpenAccount={onOpenAccount}
          onClearFilter={onClearFilter}
          filter={filter}
        />
      </LedgerProvider>
    </ToastProvider>
  );
}

function ReadyView({
  onEditEntry,
  onOpenAllocations,
  onOpenAccount,
  onClearFilter,
  filter,
}: {
  onEditEntry: (entry: JournalEntry) => void;
  onOpenAllocations: (target: AllocationsTarget) => void;
  onOpenAccount: (accountId: string) => void;
  onClearFilter: () => void;
  filter: JournalFilter | null;
}) {
  const { status } = useLedger();
  if (status !== 'ready') return null;
  return (
    <Journal
      onEditEntry={onEditEntry}
      onReverse={() => undefined}
      onOpenAllocations={onOpenAllocations}
      onOpenAccount={onOpenAccount}
      filter={filter}
      period={{ mode: 'all' }}
      onClearFilter={onClearFilter}
    />
  );
}

async function createBalanceChangeFixtures(): Promise<{
  asset: Account;
  revenue: Account;
  increaseAmount: number;
  decreaseAmount: number;
}> {
  const ledger = await loadLedger();
  const asset = ledger.accounts.find((account) => account.role === 'daily-asset')!;
  const revenue = ledger.accounts.find((account) => account.role === 'income-category')!;
  const today = todayLocal();
  const timestamp = `${today}T00:00:00.000Z`;
  const increaseAmount = 5000;
  const decreaseAmount = 1200;

  // 資産は借方、収入は貸方にあると自然な残高が増える。
  await upsertEntry({
    id: 'balance-change-increase',
    date: today,
    description: '残高が増える仕訳',
    kind: 'normal',
    lines: [
      { accountId: asset.id, side: 'debit', amount: increaseAmount },
      { accountId: revenue.id, side: 'credit', amount: increaseAmount },
    ],
    metadata: { inputMode: 'income' },
    createdAt: timestamp,
    updatedAt: timestamp,
  });
  // 逆側に置けば、両科目とも自然な残高が減る。
  await upsertEntry({
    id: 'balance-change-decrease',
    date: today,
    description: '残高が減る仕訳',
    kind: 'normal',
    lines: [
      { accountId: revenue.id, side: 'debit', amount: decreaseAmount },
      { accountId: asset.id, side: 'credit', amount: decreaseAmount },
    ],
    metadata: { inputMode: 'reversal' },
    createdAt: timestamp,
    updatedAt: timestamp,
  });

  return { asset, revenue, increaseAmount, decreaseAmount };
}

describe('仕訳一覧の混合表示', () => {
  it('計算で生まれた費用行が保存される仕訳と同じ一覧に出て、タップで item へ遷移する', async () => {
    const ledger = await loadLedger();
    const expense = ledger.accounts.find((a) => a.role === 'expense-category')!;
    const today = todayLocal();
    const item = await createContinuousCost({
      name: '月割り対象',
      amount: 60000,
      startDate: addMonthsToDate(today, -5),
      endDate: addMonthsToDate(today, 6),
      expenseAccountId: expense.id,
    });

    const onOpenAllocations = vi.fn();
    render(<View onOpenAllocations={onOpenAllocations} />);
    await waitFor(() => {
      expect(document.querySelector(`[data-ui="${UI.journal.view}"]`)).toBeInTheDocument();
    });

    // 購入の仕訳（保存）+ 費用行（計算・過去 6 ヶ月ぶん）が同じ一覧に出る。
    const rows = await screen.findAllByText('月割り対象');
    expect(rows.length).toBeGreaterThanOrEqual(2);

    // 計算で生まれた行（費用行）は最初の月のもの以外に今日までの各月ぶん存在する。
    // 先頭（日付降順で最新）の行をタップ → 「毎月のもの」の item へ。
    const list = document.querySelector(`[data-ui="${UI.journal.list}"]`)!;
    const buttons = Array.from(list.querySelectorAll('button.list__main'));
    const virtualRow = buttons.find(
      (b) => b.textContent?.includes('月割り対象') && b.textContent.includes('継続コスト'),
    );
    expect(virtualRow).toBeDefined();
    fireEvent.click(virtualRow!);
    expect(onOpenAllocations).toHaveBeenCalledWith({ itemId: item.id });
  });

  it('未来の to を選ぶとルール投影の行が出て、タップでルールへ遷移する', async () => {
    const ledger = await loadLedger();
    const cash = ledger.accounts.find((a) => a.role === 'daily-asset')!;
    const expense = ledger.accounts.find((a) => a.role === 'expense-category')!;
    // 未来開始のルール（catchUp では起票されない = 投影だけが出る）。
    const futureMonth = addMonths(monthOf(todayLocal()), 2);
    const rule = await createRecurringRule({
      name: '未来の定期支出',
      amount: 1500,
      dayOfMonth: 15,
      debitAccountId: expense.id,
      creditAccountId: cash.id,
      startMonth: futureMonth,
    });

    const onOpenAllocations = vi.fn();
    render(<View onOpenAllocations={onOpenAllocations} />);
    await waitFor(() => {
      expect(document.querySelector(`[data-ui="${UI.journal.view}"]`)).toBeInTheDocument();
    });

    // 既定（今日まで）では出ない。
    expect(screen.queryByText('未来の定期支出')).not.toBeInTheDocument();

    const toInput = document.querySelector('#journal-to') as HTMLInputElement;
    expect(toInput.max).toBe(CONTINUOUS_COST_HARD_CAP);
    const fromInput = document.querySelector('#journal-from') as HTMLInputElement;
    expect(fromInput.max).toBe(CONTINUOUS_COST_HARD_CAP);
    fireEvent.change(toInput, { target: { value: `${addMonths(futureMonth, 1)}-01` } });

    const rows = await screen.findAllByText('未来の定期支出');
    fireEvent.click(rows[0]!.closest('button')!);
    expect(onOpenAllocations).toHaveBeenCalledWith({ ruleId: rule.id });
  });

  it('投資利回りの投影行はタップで、利回りを宣言した投資科目へ遷移する（誤遷移の回帰）', async () => {
    // 旧実装は未知の virtual を itemId: '' で「毎月のもの」へ握り潰していた（監査 2026-08-12）。
    const ledger = await loadLedger();
    const invest = ledger.accounts.find((a) => a.role === 'investment-asset')!;
    const income = ledger.accounts.find((a) => a.role === 'income-category')!;
    const today = todayLocal();
    const timestamp = `${today}T00:00:00.000Z`;
    await upsertEntry({
      id: 'invest-balance',
      date: today,
      description: '投資残高',
      kind: 'normal',
      lines: [
        { accountId: invest.id, side: 'debit', amount: 100_000 },
        { accountId: income.id, side: 'credit', amount: 100_000 },
      ],
      metadata: { inputMode: 'income' },
      createdAt: timestamp,
      updatedAt: timestamp,
    });
    await upsertAccount({
      ...(await loadLedger()).accounts.find((a) => a.id === invest.id)!,
      annualReturnBp: 1200,
      projectionAccountId: income.id,
      updatedAt: timestamp,
    });

    const onOpenAccount = vi.fn();
    const onOpenAllocations = vi.fn();
    render(<View onOpenAccount={onOpenAccount} onOpenAllocations={onOpenAllocations} />);
    await waitFor(() => {
      expect(document.querySelector(`[data-ui="${UI.journal.view}"]`)).toBeInTheDocument();
    });

    const toInput = document.querySelector('#journal-to') as HTMLInputElement;
    fireEvent.change(toInput, { target: { value: `${addMonths(monthOf(today), 1)}-15` } });

    const rows = await screen.findAllByText(`投影: ${invest.name}`);
    fireEvent.click(rows[0]!.closest('button')!);
    expect(onOpenAccount).toHaveBeenCalledWith(invest.id);
    expect(onOpenAllocations).not.toHaveBeenCalled();
  });

  it('購入の仕訳はタップで編集でき、削除ボタンは出ない', async () => {
    const ledger = await loadLedger();
    const cash = ledger.accounts.find((a) => a.name === '現金')!;
    const expense = ledger.accounts.find((a) => a.role === 'expense-category')!;
    const item = await createContinuousCost({
      name: '購入の仕訳テスト',
      amount: 12000,
      startDate: todayLocal(),
      expenseAccountId: expense.id,
      creditAccountId: cash.id,
    });

    const onEditEntry = vi.fn();
    render(<View onEditEntry={onEditEntry} />);
    await waitFor(() => {
      expect(document.querySelector(`[data-ui="${UI.journal.view}"]`)).toBeInTheDocument();
    });

    // 終了日なし = 費用行ゼロ。一覧に出る「購入の仕訳テスト」は購入の仕訳 1 本だけ。
    const row = await screen.findByText('購入の仕訳テスト');
    const li = row.closest('li')!;
    expect(li.querySelector(`[data-ui="${UI.journal.entry.delete}"]`)).toBeNull();
    expect(li.querySelector(`[data-ui="${UI.journal.entry.reverse}"]`)).toBeNull();
    fireEvent.click(row.closest('button')!);
    expect(onEditEntry).toHaveBeenCalledTimes(1);
    const edited = onEditEntry.mock.calls[0]![0] as JournalEntry;
    expect(edited.metadata?.monthlyCostId).toBe(item.id);
  });

  it('通常支出フィルタは通常の費用だけを表示し、解除チップを出す', async () => {
    const ledger = await loadLedger();
    const cash = ledger.accounts.find((account) => account.role === 'daily-asset')!;
    const expense = ledger.accounts.find((account) => account.role === 'expense-category')!;
    const revenue = ledger.accounts.find((account) => account.role === 'income-category')!;
    const today = todayLocal();
    const timestamp = `${today}T00:00:00.000Z`;

    await upsertEntry({
      id: 'normal-expense-filter-target',
      date: today,
      description: '通常支出フィルタ対象',
      kind: 'normal',
      lines: [
        { accountId: expense.id, side: 'debit', amount: 1000 },
        { accountId: cash.id, side: 'credit', amount: 1000 },
      ],
      metadata: { inputMode: 'expense' },
      createdAt: timestamp,
      updatedAt: timestamp,
    });
    await upsertEntry({
      id: 'normal-expense-filter-income',
      date: today,
      description: '通常支出ではない収入',
      kind: 'normal',
      lines: [
        { accountId: cash.id, side: 'debit', amount: 3000 },
        { accountId: revenue.id, side: 'credit', amount: 3000 },
      ],
      metadata: { inputMode: 'income' },
      createdAt: timestamp,
      updatedAt: timestamp,
    });
    await createContinuousCost({
      name: '通常支出ではない継続コスト',
      amount: 500,
      startDate: today,
      endDate: today,
      expenseAccountId: expense.id,
      creditAccountId: cash.id,
    });

    const onClearFilter = vi.fn();
    render(
      <View
        filter={{ expenseKind: 'normal', from: today, to: today }}
        onClearFilter={onClearFilter}
      />,
    );
    await screen.findByText('通常支出フィルタ対象');

    expect(screen.queryByText('通常支出ではない収入')).not.toBeInTheDocument();
    expect(screen.queryByText('通常支出ではない継続コスト')).not.toBeInTheDocument();
    expect(screen.getByText('通常支出のみ')).toBeInTheDocument();
    const normalExpenseAmount = screen
      .getByText('通常支出フィルタ対象')
      .closest('li')!
      .querySelector('.list__amount')!;
    expect(normalExpenseAmount).not.toHaveClass('amount--pos');
    expect(normalExpenseAmount).not.toHaveClass('amount--neg');
    expect(normalExpenseAmount).not.toHaveAttribute('aria-label');

    fireEvent.click(
      document.querySelector(
        `[data-ui="${UI.journal.clearNormalExpenseFilter}"]`,
      ) as HTMLButtonElement,
    );
    expect(onClearFilter).toHaveBeenCalledTimes(1);
  });

  it('給与（収入科目）フィルタでは貸方を増加色、借方を減少色にし、増減を読み上げる', async () => {
    const { revenue, increaseAmount, decreaseAmount } = await createBalanceChangeFixtures();

    render(<View filter={{ accountId: revenue.id, from: todayLocal(), to: todayLocal() }} />);

    const increase = await screen.findByLabelText(
      `${revenue.name}の残高が増える金額: ${formatMoney(increaseAmount, '円', 0)}`,
    );
    const decrease = screen.getByLabelText(
      `${revenue.name}の残高が減る金額: ${formatMoney(decreaseAmount, '円', 0)}`,
    );
    expect(increase).toHaveClass('amount--pos');
    expect(decrease).toHaveClass('amount--neg');
    expect(increase).toHaveTextContent(formatMoney(increaseAmount, '円', 0));
    expect(decrease).toHaveTextContent(formatMoney(decreaseAmount, '円', 0));
    expect(increase).not.toHaveTextContent('+');
  });

  it('資産科目フィルタでは借方を増加色、貸方を減少色にする', async () => {
    const { asset, increaseAmount, decreaseAmount } = await createBalanceChangeFixtures();

    render(<View filter={{ accountId: asset.id, from: todayLocal(), to: todayLocal() }} />);

    expect(
      await screen.findByLabelText(
        `${asset.name}の残高が増える金額: ${formatMoney(increaseAmount, '円', 0)}`,
      ),
    ).toHaveClass('amount--pos');
    expect(
      screen.getByLabelText(
        `${asset.name}の残高が減る金額: ${formatMoney(decreaseAmount, '円', 0)}`,
      ),
    ).toHaveClass('amount--neg');
  });

  it('科目フィルタなしでは金額を増減色にしない', async () => {
    await createBalanceChangeFixtures();

    render(<View />);
    const rowTitle = await screen.findByText('残高が増える仕訳');
    const amount = rowTitle.closest('li')!.querySelector('.list__amount')!;
    expect(amount).not.toHaveClass('amount--pos');
    expect(amount).not.toHaveClass('amount--neg');
    expect(amount).not.toHaveAttribute('aria-label');
  });
});
