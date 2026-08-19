/*
 * 台帳の金額ソートは**ローンを負として比べる**（v13.7 I4・作者確定 2026-08-18）。
 *
 * 症状: 昇順で 楽天モバイル 3,300 → ローン 4,167 → 電気代 5,000 と絶対値で混ざっていた。
 * 決定: 計上先が負債のルール（= ローン）の額は負として比較する。昇順なら −4,167 が先頭。
 * 表示は絶対値 + 負債色のまま（符号は付けない）＝ 数直線の規約 debitSignedBalance と同じ向き。
 *
 * mutation check: Allocations の ruleCompare を `(a.amount - b.amount)`（絶対値比較）へ戻すと
 * 昇順の先頭が 3,300 のルールになり、下の 2 本（domain / DOM）がどちらも落ちる。
 */
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import { ToastProvider } from '@snishi/foundation/ui/toast';
import { patchDialogIfNeeded } from '@snishi/foundation/ui/test-utils';
import { LedgerProvider, useLedger } from '../src/state/store';
import { Allocations } from '../src/ui/screens/Allocations';
import {
  createLoanPurchase,
  createOpenings,
  createRecurringRule,
  loadLedger,
} from '../src/data/repository';
import { addMonthsToDate } from '../src/domain/allocation';
import { loanSortAmount } from '../src/domain/loan';
import { UI } from '../src/ui-contract';
import { _resetOverlaysForTests } from '../src/ui/overlays';
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
  const { status } = useLedger();
  return status === 'ready' ? (
    <Allocations period={{ mode: 'date', date: todayLocal() }} onEditEntry={() => undefined} />
  ) : null;
}

async function renderReady() {
  render(
    <ToastProvider>
      <LedgerProvider>
        <View />
      </LedgerProvider>
    </ToastProvider>,
  );
  await waitFor(() => {
    expect(document.querySelector(`[data-ui="${UI.allocations.view}"]`)).not.toBeNull();
  });
}

/** タイトルには種別タグが続くため、先頭の語（= 名前。fixture の名前に空白は無い）だけを読む。 */
function ruleNames(): string[] {
  return [
    ...document.querySelectorAll(`[data-ui="${UI.allocations.recurringList}"] .list__title`),
  ].map((el) => (el.textContent ?? '').trim().split(/\s+/)[0] ?? '');
}

/**
 * 3 本のルール: ローン（月額 4,167）・通信 3,300・電気 5,000。
 * 起票は未到来にしておく（位相 = 翌月）＝ item セクションへ落ちてこない。
 */
async function seedThreeRules() {
  const ledger = await loadLedger();
  const cash = ledger.accounts.find((a) => a.name === '現金')!;
  const bank = ledger.accounts.find((a) => a.name === '預金')!;
  const expense = ledger.accounts.find((a) => a.role === 'expense-category')!;
  const today = todayLocal();
  await createOpenings([{ accountId: cash.id, amount: 500000000, date: '2000-01-01' }]);
  // 借入 50,004 を 12 回 → 月額ちょうど 4,167（端数なし）。
  const loan = await createLoanPurchase({
    loanName: 'ローン返済',
    date: today,
    description: 'ローン返済',
    amount: 5000400,
    expenseAccountId: expense.id,
    repaymentFromAccountId: cash.id,
    repaymentEndDate: addMonthsToDate(today, 13),
  });
  const nextMonth = addMonthsToDate(today, 1).slice(0, 7);
  await createRecurringRule({
    name: '通信費',
    amount: 330000,
    dayOfMonth: 1,
    debitAccountId: expense.id,
    creditAccountId: bank.id,
    startMonth: nextMonth,
    startDate: today,
  });
  await createRecurringRule({
    name: '電気代',
    amount: 500000,
    dayOfMonth: 1,
    debitAccountId: expense.id,
    creditAccountId: bank.id,
    startMonth: nextMonth,
    startDate: today,
  });
  return { loan, expense, bank };
}

describe('金額ソートの符号（ローンは負）', () => {
  it('loanSortAmount はローンだけを負にする（持ち物・通常ルールは素の額）', async () => {
    const { loan, expense, bank } = await seedThreeRules();
    const next = await loadLedger();
    const roleOf = (id: string) => next.accounts.find((a) => a.id === id)?.role;
    const loanRule = next.recurringRules.find((r) => r.name === 'ローン返済')!;
    const normalRule = next.recurringRules.find((r) => r.name === '通信費')!;

    expect(loanRule.spreadExpenseAccountId).toBe(loan.liability.id);
    expect(loanSortAmount(loanRule, roleOf)).toBe(-loanRule.amount);
    expect(loanSortAmount(normalRule, roleOf)).toBe(normalRule.amount);
    // 計上先が費用・資産（負債でない）なら符号は付かない。
    expect(loanSortAmount({ amount: 100, spreadExpenseAccountId: expense.id }, roleOf)).toBe(100);
    expect(loanSortAmount({ amount: 100, spreadExpenseAccountId: bank.id }, roleOf)).toBe(100);
  });

  it('金額の昇順でローンが先頭に来る（表示は絶対値 + 負債色のまま）', async () => {
    await seedThreeRules();
    await renderReady();
    await waitFor(() => {
      expect(ruleNames()).toHaveLength(3);
    });

    fireEvent.click(document.querySelector(`[data-ui="${UI.allocations.sortByAmount}"]`)!);
    // 既定は降順（大きい順）: 5,000 → 3,300 → ローン（−4,167 は最小なので最後）。
    expect(ruleNames()).toEqual(['電気代', '通信費', 'ローン返済']);

    fireEvent.click(document.querySelector(`[data-ui="${UI.allocations.sortAsc}"]`)!);
    // 昇順ではローンが先頭（絶対値比較なら 通信費 3,300 が先頭になり落ちる）。
    expect(ruleNames()).toEqual(['ローン返済', '通信費', '電気代']);

    // 表示は符号なしの絶対値 + 負債色（数字に − を出さないことがこの決定の条件）。
    const loanRow = document.querySelectorAll(`[data-ui="${UI.allocations.recurringList}"] li`)[0]!;
    const amount = loanRow.querySelector('.row-trailing .list__amount span')!;
    expect(amount).toHaveClass('amount--liability');
    expect(amount.textContent).toContain('4,167');
    expect(amount.textContent).not.toContain('-');
    expect(amount.textContent).not.toContain('−');
  });
});
