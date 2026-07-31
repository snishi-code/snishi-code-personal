import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import { ToastProvider } from '@snishi/foundation/ui/toast';
import { patchDialogIfNeeded } from '@snishi/foundation/ui/test-utils';
import {
  catchUpRecurringRules,
  createRecurringRule,
  loadLedger,
} from '../src/data/repository';
import * as repository from '../src/data/repository';
import { LedgerProvider, useLedger } from '../src/state/store';
import { UI } from '../src/ui-contract';
import { _resetOverlaysForTests } from '../src/ui/overlays';
import { Allocations } from '../src/ui/screens/Allocations';
import type { RecurringRule } from '../src/domain/types';
import './setup';

const clock = vi.hoisted(() => ({ today: '2026-04-18' }));

vi.mock('../src/util/time', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/util/time')>();
  return { ...actual, todayLocal: () => clock.today };
});

beforeAll(() => {
  patchDialogIfNeeded();
});

afterEach(() => {
  cleanup();
  _resetOverlaysForTests();
  vi.restoreAllMocks();
  clock.today = '2026-04-18';
});

function View({ date = '2026-04-30' }: { date?: string }) {
  return (
    <ToastProvider>
      <LedgerProvider>
        <ReadyView date={date} />
      </LedgerProvider>
    </ToastProvider>
  );
}

function ReadyView({ date }: { date: string }) {
  const { status } = useLedger();
  return status === 'ready' ? (
    <Allocations period={{ mode: 'date', date }} onEditEntry={() => undefined} />
  ) : null;
}

async function seedRule(amount = 1_000): Promise<RecurringRule> {
  const ledger = await loadLedger();
  const bank = ledger.accounts.find((account) => account.role === 'daily-asset')!;
  const expense = ledger.accounts.find((account) => account.role === 'expense-category')!;
  return createRecurringRule({
    name: '料金変更テスト',
    amount,
    dayOfMonth: 20,
    everyMonths: 1,
    debitAccountId: expense.id,
    creditAccountId: bank.id,
    startMonth: '2026-04',
    startDate: '2026-04-12',
  });
}

async function openAmountDecision(nextAmount: string): Promise<void> {
  render(<View />);
  await waitFor(() => {
    expect(document.querySelector(`[data-ui="${UI.allocations.recurringEdit}"]`)).toBeTruthy();
  });
  fireEvent.click(document.querySelector(`[data-ui="${UI.allocations.recurringEdit}"]`)!);
  fireEvent.change(
    document.querySelector(`[data-ui="${UI.allocations.recurringAmount}"]`)!,
    { target: { value: nextAmount } },
  );
  fireEvent.click(document.querySelector(`[data-ui="${UI.allocations.recurringSave}"]`)!);
  await waitFor(() => {
    expect(
      document.querySelector(`[data-ui="${UI.allocations.recurringAmountChangeDialog}"]`),
    ).toBeInTheDocument();
  });
}

describe('定期ルールの金額変更範囲', () => {
  it('存在期間と起票周期の基準日を別の入力として保存する', async () => {
    const original = await seedRule();
    render(<View />);
    await waitFor(() => {
      expect(document.querySelector(`[data-ui="${UI.allocations.recurringEdit}"]`)).toBeTruthy();
    });
    fireEvent.click(document.querySelector(`[data-ui="${UI.allocations.recurringEdit}"]`)!);

    expect(document.querySelector(`[data-ui="${UI.allocations.recurringStartDate}"]`)).toHaveValue(
      '2026-04-12',
    );
    expect(
      document.querySelector(`[data-ui="${UI.allocations.recurringFirstPostingDate}"]`),
    ).toHaveValue('2026-04-20');
    fireEvent.change(document.querySelector(`[data-ui="${UI.allocations.recurringEndDate}"]`)!, {
      target: { value: '2026-06-01' },
    });
    fireEvent.click(document.querySelector(`[data-ui="${UI.allocations.recurringSave}"]`)!);

    await waitFor(() => {
      expect(
        document.querySelector(`[data-ui="${UI.allocations.recurringSheet}"]`),
      ).not.toBeInTheDocument();
    });
    expect(
      document.querySelector(`[data-ui="${UI.allocations.recurringAmountChangeDialog}"]`),
    ).not.toBeInTheDocument();
    expect((await loadLedger()).recurringRules.find((rule) => rule.id === original.id)).toMatchObject(
      {
        startDate: '2026-04-12',
        endDate: '2026-06-01',
        startMonth: '2026-04',
        dayOfMonth: 20,
      },
    );

    cleanup();
    _resetOverlaysForTests();
    render(<View />);
    await waitFor(() => {
      expect(document.querySelector(`[data-ui="${UI.allocations.recurringEdit}"]`)).toBeTruthy();
    });
    fireEvent.click(document.querySelector(`[data-ui="${UI.allocations.recurringEdit}"]`)!);
    fireEvent.change(document.querySelector(`[data-ui="${UI.allocations.recurringEndDate}"]`)!, {
      target: { value: '' },
    });
    fireEvent.click(document.querySelector(`[data-ui="${UI.allocations.recurringSave}"]`)!);
    await waitFor(() => {
      expect(
        document.querySelector(`[data-ui="${UI.allocations.recurringSheet}"]`),
      ).not.toBeInTheDocument();
    });
    expect(
      (await loadLedger()).recurringRules.find((rule) => rule.id === original.id)?.endDate,
    ).toBeUndefined();
  });

  it('判断画面を出すまでは保存せず、戻ると入力値を保ったままDBを変更しない', async () => {
    const original = await seedRule();
    await openAmountDecision('1500');

    expect((await loadLedger()).recurringRules.find((rule) => rule.id === original.id)?.amount).toBe(
      1_000,
    );
    fireEvent.click(
      document.querySelector(`[data-ui="${UI.allocations.recurringAmountChangeCancel}"]`)!,
    );

    expect(
      document.querySelector(`[data-ui="${UI.allocations.recurringAmountChangeDialog}"]`),
    ).not.toBeInTheDocument();
    expect(document.querySelector(`[data-ui="${UI.allocations.recurringAmount}"]`)).toHaveValue(
      '1500',
    );
    expect((await loadLedger()).recurringRules.find((rule) => rule.id === original.id)?.amount).toBe(
      1_000,
    );
  });

  it('金額変更で分けたルールは基準月を固定し、起票日は31日まで変更できる', async () => {
    const original = await seedRule();
    await repository.upsertRecurringRule(
      { ...original, amount: 1500 },
      { amountChangeMode: 'split', effectiveDate: '2026-04-18' },
    );
    render(<View />);
    await waitFor(() => {
      expect(document.querySelector(`[data-ui="${UI.allocations.recurringEdit}"]`)).toBeTruthy();
    });
    fireEvent.click(document.querySelector(`[data-ui="${UI.allocations.recurringEdit}"]`)!);

    const dayInput = document.querySelector(
      `[data-ui="${UI.allocations.recurringFirstPostingDate}"]`,
    )!;
    expect(dayInput).toHaveAttribute('inputmode', 'numeric');
    expect(dayInput).toHaveValue('20');
    fireEvent.change(dayInput, { target: { value: '31' } });
    fireEvent.click(document.querySelector(`[data-ui="${UI.allocations.recurringSave}"]`)!);

    await waitFor(() => {
      expect(
        document.querySelector(`[data-ui="${UI.allocations.recurringSheet}"]`),
      ).not.toBeInTheDocument();
    });
    const ledger = await loadLedger();
    const changed = ledger.recurringRules.find((rule) => rule.id !== original.id)!;
    expect(changed).toMatchObject({ startMonth: '2026-04', dayOfMonth: 31 });
  });

  it('保存の連打を二重送信せず、失敗時は判断画面と入力を保つ', async () => {
    const original = await seedRule();
    await openAmountDecision('1500');
    let rejectSave: (reason: unknown) => void = () => undefined;
    const blocked = new Promise<void>((_resolve, reject) => {
      rejectSave = reject;
    });
    const save = vi.spyOn(repository, 'upsertRecurringRule').mockReturnValue(blocked);
    const split = document.querySelector(
      `[data-ui="${UI.allocations.recurringAmountChangeFromToday}"]`,
    ) as HTMLButtonElement;

    fireEvent.click(split);
    fireEvent.click(split);
    expect(save).toHaveBeenCalledTimes(1);
    rejectSave(new Error('テスト用の保存失敗'));

    await waitFor(() => {
      const dialog = document.querySelector(
        `[data-ui="${UI.allocations.recurringAmountChangeDialog}"]`,
      );
      expect(dialog).toBeInTheDocument();
      expect(dialog?.querySelector('[role="alert"]')).toBeInTheDocument();
      expect(split).not.toBeDisabled();
    });
    expect((await loadLedger()).recurringRules.find((rule) => rule.id === original.id)?.amount).toBe(
      1_000,
    );
  });

  it('保存本体の後の自動起票だけが失敗しても、保存済みとして判断画面を閉じる', async () => {
    const original = await seedRule();
    vi.spyOn(repository, 'catchUpRecurringRules')
      .mockResolvedValueOnce(0)
      .mockRejectedValueOnce(new Error('テスト用の後続失敗'));
    await openAmountDecision('1500');

    fireEvent.click(
      document.querySelector(`[data-ui="${UI.allocations.recurringAmountChangeFromToday}"]`)!,
    );
    await waitFor(() => {
      expect(
        document.querySelector(`[data-ui="${UI.allocations.recurringAmountChangeDialog}"]`),
      ).not.toBeInTheDocument();
    });
    const ledger = await loadLedger();
    expect(ledger.recurringRules.find((rule) => rule.id === original.id)).toMatchObject({
      amount: 1_000,
      endDate: '2026-04-18',
    });
    expect(ledger.recurringRules.find((rule) => rule.id !== original.id)).toMatchObject({
      amount: 1_500,
      startDate: '2026-04-18',
    });
  });

  it('新規登録後の自動起票だけが失敗しても、保存済みとして入力画面を閉じる', async () => {
    vi.spyOn(repository, 'catchUpRecurringRules')
      .mockResolvedValueOnce(0)
      .mockRejectedValueOnce(new Error('テスト用の後続失敗'));
    render(<View />);
    await waitFor(() => {
      expect(document.querySelector(`[data-ui="${UI.allocations.unifiedAdd}"]`)).toBeTruthy();
    });
    fireEvent.click(document.querySelector(`[data-ui="${UI.allocations.unifiedAdd}"]`)!);
    fireEvent.click(document.querySelector(`[data-ui="${UI.allocations.addChooser}.rule"]`)!);
    fireEvent.change(document.querySelector(`[data-ui="${UI.allocations.recurringName}"]`)!, {
      target: { value: '後続失敗テスト' },
    });
    fireEvent.change(document.querySelector(`[data-ui="${UI.allocations.recurringAmount}"]`)!, {
      target: { value: '2500' },
    });
    fireEvent.click(document.querySelector(`[data-ui="${UI.allocations.recurringSave}"]`)!);

    await waitFor(() => {
      expect(
        document.querySelector(`[data-ui="${UI.allocations.recurringSheet}"]`),
      ).not.toBeInTheDocument();
    });
    expect(
      (await loadLedger()).recurringRules.filter((rule) => rule.name === '後続失敗テスト'),
    ).toHaveLength(1);
  });

  it('今日すでに存在しないルールには実行不能な「今日から」を表示しない', async () => {
    clock.today = '2026-04-22';
    const original = await seedRule();
    await repository.upsertRecurringRule({ ...original, endDate: '2026-04-22' });
    render(<View date="2026-04-20" />);
    await waitFor(() => {
      expect(document.querySelector(`[data-ui="${UI.allocations.recurringEdit}"]`)).toBeTruthy();
    });
    fireEvent.click(document.querySelector(`[data-ui="${UI.allocations.recurringEdit}"]`)!);
    fireEvent.change(
      document.querySelector(`[data-ui="${UI.allocations.recurringAmount}"]`)!,
      { target: { value: '1500' } },
    );
    fireEvent.click(document.querySelector(`[data-ui="${UI.allocations.recurringSave}"]`)!);

    await waitFor(() => {
      expect(
        document.querySelector(`[data-ui="${UI.allocations.recurringAmountChangeDialog}"]`),
      ).toBeInTheDocument();
    });
    expect(
      document.querySelector(`[data-ui="${UI.allocations.recurringAmountChangeFromToday}"]`),
    ).not.toBeInTheDocument();
    expect(
      document.querySelector(`[data-ui="${UI.allocations.recurringAmountChangeAll}"]`),
    ).toBeInTheDocument();
  });

  it('「全期間」を選ぶと同じルールを新しい金額へ遡及変更する', async () => {
    const original = await seedRule();
    await catchUpRecurringRules('2026-04-20');
    await openAmountDecision('1500');

    fireEvent.click(
      document.querySelector(`[data-ui="${UI.allocations.recurringAmountChangeAll}"]`)!,
    );
    await waitFor(() => {
      expect(
        document.querySelector(`[data-ui="${UI.allocations.recurringAmountChangeDialog}"]`),
      ).not.toBeInTheDocument();
    });

    const ledger = await loadLedger();
    expect(ledger.recurringRules).toHaveLength(1);
    expect(ledger.recurringRules[0]).toMatchObject({ id: original.id, amount: 1_500 });
    expect(
      ledger.monthlyCostItems.find((item) => item.id === `ccr-${original.id}-2026-04`),
    ).toMatchObject({ amount: 1_500 });
    expect(
      ledger.journalEntries
        .find((entry) => entry.metadata?.recurringRuleId === original.id)
        ?.lines.every((line) => line.amount === 1_500),
    ).toBe(true);
  });

  it('4/18の分岐では旧ルールは起票せず、4/20を新ルールの金額で起票する', async () => {
    const original = await seedRule();
    await openAmountDecision('1500');

    const dialog = document.querySelector(
      `[data-ui="${UI.allocations.recurringAmountChangeDialog}"]`,
    );
    expect(dialog).toHaveTextContent('2026-04-18 から新しい金額');
    expect(dialog).toHaveTextContent('起票周期の基準月は現在のルールから引き継ぎ');
    // 判断画面を跨いで日付が変わっても、表示した境界日で保存する。
    clock.today = '2026-04-19';

    fireEvent.click(
      document.querySelector(`[data-ui="${UI.allocations.recurringAmountChangeFromToday}"]`)!,
    );
    await waitFor(() => {
      expect(
        document.querySelector(`[data-ui="${UI.allocations.recurringAmountChangeDialog}"]`),
      ).not.toBeInTheDocument();
    });

    let ledger = await loadLedger();
    const previous = ledger.recurringRules.find((rule) => rule.id === original.id)!;
    const successor = ledger.recurringRules.find((rule) => rule.id !== original.id)!;
    expect(previous).toMatchObject({ amount: 1_000, endDate: '2026-04-18' });
    expect(successor).toMatchObject({ amount: 1_500, startDate: '2026-04-18' });
    expect(successor.startMonth).toBe(original.startMonth);
    expect(successor.dayOfMonth).toBe(original.dayOfMonth);
    expect(ledger.monthlyCostItems).toHaveLength(0);

    await catchUpRecurringRules('2026-04-20');
    ledger = await loadLedger();
    expect(ledger.monthlyCostItems.find((item) => item.id.startsWith(`ccr-${original.id}-`))).toBe(
      undefined,
    );
    expect(
      ledger.monthlyCostItems.find((item) => item.id === `ccr-${successor.id}-2026-04`),
    ).toMatchObject({ amount: 1_500, startDate: '2026-04-20' });
  });

  it('4/22の分岐では旧ルールの4/20分を残し、新ルールは翌月から起票する', async () => {
    clock.today = '2026-04-22';
    const original = await seedRule();
    await catchUpRecurringRules('2026-04-20');
    await openAmountDecision('1500');

    fireEvent.click(
      document.querySelector(`[data-ui="${UI.allocations.recurringAmountChangeFromToday}"]`)!,
    );
    await waitFor(() => {
      expect(
        document.querySelector(`[data-ui="${UI.allocations.recurringAmountChangeDialog}"]`),
      ).not.toBeInTheDocument();
    });

    let ledger = await loadLedger();
    const successor = ledger.recurringRules.find((rule) => rule.id !== original.id)!;
    expect(ledger.recurringRules.find((rule) => rule.id === original.id)).toMatchObject({
      amount: 1_000,
      endDate: '2026-04-22',
    });
    expect(
      ledger.monthlyCostItems.find((item) => item.id === `ccr-${original.id}-2026-04`),
    ).toMatchObject({ amount: 1_000, startDate: '2026-04-20' });
    expect(
      ledger.monthlyCostItems.find((item) => item.id === `ccr-${successor.id}-2026-04`),
    ).toBeUndefined();

    await catchUpRecurringRules('2026-05-20');
    ledger = await loadLedger();
    expect(
      ledger.monthlyCostItems.find((item) => item.id === `ccr-${successor.id}-2026-05`),
    ).toMatchObject({ amount: 1_500, startDate: '2026-05-20' });
  });
});
