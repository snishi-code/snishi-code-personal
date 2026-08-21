/*
 * 台帳の金額ソートは**ローンを負として比べる**（v13.7 I4 → v13.13 で item へ継承）。
 *
 * 症状（ルール時代）: 昇順で 3,300 → ローン 4,167 → 5,000 と絶対値で混ざっていた。
 * 決定: ローン item の額は負として比較する。昇順ならローンが先頭。
 * 表示は絶対値 + 負債色のまま（符号は付けない）＝ 数直線の規約 debitSignedBalance と同じ向き。
 *
 * mutation check: Allocations の itemCompare を `(a.amount - b.amount)`（絶対値比較）へ戻すと
 * 昇順の先頭が安い持ち物になり、下の 2 本（domain / DOM）がどちらも落ちる。
 */
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import { ToastProvider } from '@snishi/foundation/ui/toast';
import { patchDialogIfNeeded } from '@snishi/foundation/ui/test-utils';
import { LedgerProvider, useLedger } from '../src/state/store';
import { Allocations } from '../src/ui/screens/Allocations';
import {
  createContinuousCost,
  createLoanPurchase,
  createOpenings,
  loadLedger,
} from '../src/data/repository';
import { addMonthsToDate } from '../src/domain/allocation';
import { loanItemSortAmount } from '../src/domain/loan';
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

/** カードのタイトル（名前 + 種別タグ）の先頭の語だけを読む（fixture の名前に空白は無い）。 */
function itemNames(): string[] {
  return [...document.querySelectorAll(`[data-ui="${UI.allocations.item}"] .list__title`)].map(
    (el) => (el.querySelector('span')?.textContent ?? '').trim().split(/\s+/)[0] ?? '',
  );
}

/**
 * 3 枚のカード: ローン（借入 4,167）・持ち物 3,300・持ち物 5,000。
 * 金額ソートの比較対象は item.amount（ローンだけ負として比べる）。
 */
async function seedThreeItems() {
  const ledger = await loadLedger();
  const cash = ledger.accounts.find((a) => a.name === '現金')!;
  const expense = ledger.accounts.find((a) => a.role === 'expense-category')!;
  const today = todayLocal();
  await createOpenings([{ accountId: cash.id, amount: 500000000, date: '2000-01-01' }]);
  const loan = await createLoanPurchase({
    loanName: 'ローン返済',
    date: today,
    description: 'ローン返済',
    amount: 416700,
    expenseAccountId: expense.id,
    repaymentSourceAccountId: cash.id,
    repaymentEndDate: addMonthsToDate(today, 12),
  });
  await createContinuousCost({
    name: '通信機器',
    amount: 330000,
    startDate: today,
    endDate: addMonthsToDate(today, 12),
    expenseAccountId: expense.id,
    creditAccountId: cash.id,
  });
  await createContinuousCost({
    name: '電気設備',
    amount: 500000,
    startDate: today,
    endDate: addMonthsToDate(today, 12),
    expenseAccountId: expense.id,
    creditAccountId: cash.id,
  });
  return { loan, expense };
}

describe('金額ソートの符号（ローン item は負）', () => {
  it('loanItemSortAmount はローンだけを負にする（持ち物は素の額）', async () => {
    const { loan } = await seedThreeItems();
    const next = await loadLedger();
    const loanItem = next.monthlyCostItems.find((m) => m.id === loan.loanItem.id)!;
    const normalItem = next.monthlyCostItems.find((m) => m.name === '通信機器')!;
    expect(loanItemSortAmount(loanItem)).toBe(-loanItem.amount);
    expect(loanItemSortAmount(normalItem)).toBe(normalItem.amount);
  });

  it('金額の昇順でローンが先頭に来る（表示は絶対値 + 負債色のまま）', async () => {
    await seedThreeItems();
    await renderReady();
    await waitFor(() => {
      expect(itemNames()).toHaveLength(3);
    });

    fireEvent.click(document.querySelector(`[data-ui="${UI.allocations.sortByAmount}"]`)!);
    // 既定は降順（大きい順）: 5,000 → 3,300 → ローン（−4,167 は最小なので最後）。
    expect(itemNames()).toEqual(['電気設備', '通信機器', 'ローン返済']);

    fireEvent.click(document.querySelector(`[data-ui="${UI.allocations.sortAsc}"]`)!);
    // 昇順ではローンが先頭（絶対値比較なら 通信機器 3,300 が先頭になり落ちる）。
    expect(itemNames()).toEqual(['ローン返済', '通信機器', '電気設備']);

    // 表示は符号なしの絶対値 + 負債色（数字に − を出さないことがこの決定の条件）。
    const loanCard = document.querySelectorAll(`[data-ui="${UI.allocations.item}"]`)[0]!;
    const amount = loanCard.querySelector('.row-trailing .list__amount span')!;
    expect(amount).toHaveClass('amount--liability');
    expect(amount.textContent).toContain('4,167');
    expect(amount.textContent).not.toContain('-');
    expect(amount.textContent).not.toContain('−');
  });
});
