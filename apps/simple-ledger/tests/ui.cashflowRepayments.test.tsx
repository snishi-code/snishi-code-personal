/*
 * 資金繰り:
 *  - 上部は「自由に動かせるお金」1 値（movable=false の現預金は原資に数えない）。
 *  - 負債行の展開 = 登録済みの返済（未来日付の保存仕訳・借方 = その負債）を日付昇順で表示し、
 *    タップで仕訳の編集シート（onEditEntry 経路）を開く。
 */
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { ToastProvider } from '@snishi/foundation/ui/toast';
import { patchDialogIfNeeded } from '@snishi/foundation/ui/test-utils';
import { LedgerProvider } from '../src/state/store';
import { Cashflow } from '../src/ui/screens/Cashflow';
import {
  createOpenings,
  createRepaymentEntries,
  loadLedger,
  upsertAccount,
} from '../src/data/repository';
import { addMonthsToDate } from '../src/domain/allocation';
import { MONTHLY_AMOUNTS_HARD_CAP } from '../src/domain/allocation';
import { UI } from '../src/ui-contract';
import { _resetOverlaysForTests } from '../src/ui/overlays';
import { todayLocal } from '../src/util/time';
import { cashflowHorizonMonths, rememberCashflowHorizonMonths } from '../src/data/localFlags';
import type { JournalEntry } from '../src/domain/types';
import './setup';

beforeAll(() => {
  patchDialogIfNeeded();
});

afterEach(() => {
  cleanup();
  _resetOverlaysForTests();
});

function view(
  onEditEntry: (entry: JournalEntry) => void,
  handlers: {
    onOpenAllocations?: (target: unknown) => void;
    onOpenAccount?: (accountId: string) => void;
    onOpenEntry?: (entryId: string) => void;
  } = {},
) {
  return (
    <ToastProvider>
      <LedgerProvider>
        <Cashflow
          onEditEntry={onEditEntry}
          onOpenAllocations={(handlers.onOpenAllocations ?? (() => undefined)) as never}
          onOpenAccount={handlers.onOpenAccount ?? (() => undefined)}
          onOpenEntry={handlers.onOpenEntry ?? (() => undefined)}
        />
      </LedgerProvider>
    </ToastProvider>
  );
}

const ui = (name: string) => document.querySelector(`[data-ui="${name}"]`);

describe('表示終了日（既定は設定画面の期間・画面での変更はその場限り）', () => {
  it('開くと今日 + 既定期間の日付が入り、変更しても記憶されず次回は既定へ戻る', async () => {
    rememberCashflowHorizonMonths(4);
    render(view(() => undefined));
    const input = (await screen.findByLabelText('表示終了日')) as HTMLInputElement;
    expect(input.value).toBe(addMonthsToDate(todayLocal(), 4));

    // 一時的に伸ばす → 表示は変わるが端末設定は変わらない。
    const stretched = addMonthsToDate(todayLocal(), 12);
    fireEvent.change(input, { target: { value: stretched } });
    expect(input.value).toBe(stretched);
    expect(cashflowHorizonMonths()).toBe(4);

    // 開き直すと既定（4 ヶ月）へ戻る。
    cleanup();
    _resetOverlaysForTests();
    render(view(() => undefined));
    const again = (await screen.findByLabelText('表示終了日')) as HTMLInputElement;
    expect(again.value).toBe(addMonthsToDate(todayLocal(), 4));
  });
});

describe('資金繰り', () => {
  it('上部は「自由に動かせるお金」1 値（movable=false は除外・総資金/取り置きの段は無い）', async () => {
    const ledger = await loadLedger();
    const cash = ledger.accounts.find((a) => a.name === '現金')!;
    const charge = ledger.accounts.find((a) => a.name === 'チャージ残高')!;
    await upsertAccount({ ...charge, movable: false });
    await createOpenings([
      { accountId: cash.id, amount: 10000000, date: '2000-01-01' },
      { accountId: charge.id, amount: 700000, date: '2000-01-01' },
    ]);

    render(view(() => undefined));

    const summary = await waitFor(() => {
      const found = ui(UI.cashflow.summary);
      expect(found).toBeInTheDocument();
      return found!;
    });
    expect(summary).toHaveTextContent('自由に動かせるお金');
    await waitFor(() => {
      expect(summary).toHaveTextContent('100,000');
    });
    expect(summary).not.toHaveTextContent('107,000');
    // 総資金/取り置き/自由資金の 3 段は存在しない（1 値のみ）。
    expect(summary!.querySelectorAll('.stat')).toHaveLength(1);
    expect(screen.queryByText('総資金')).not.toBeInTheDocument();
    expect(screen.queryByText('取り置き')).not.toBeInTheDocument();
  });

  it('負債行の展開で登録済みの返済（未来仕訳）を日付昇順に出し、タップで編集シートへ渡す', async () => {
    const ledger = await loadLedger();
    const cash = ledger.accounts.find((a) => a.name === '現金')!;
    const card = ledger.accounts.find((a) => a.role === 'payment-liability')!;
    await createOpenings([
      { accountId: cash.id, amount: 10000000, date: '2000-01-01' },
      { accountId: card.id, amount: 3000000, date: '2000-01-01' },
    ]);
    const firstDate = addMonthsToDate(todayLocal(), 1);
    await createRepaymentEntries({
      liabilityAccountId: card.id,
      fromAccountId: cash.id,
      firstDate,
      total: 3000000,
      count: 3,
      title: 'カードの返済',
    });

    const onEditEntry = vi.fn();
    render(view(onEditEntry));

    // 負債行の展開トグル（行タップ = 新規返済シートとは独立）。
    const toggle = await waitFor(() => {
      const found = ui(UI.cashflow.repaymentsToggle);
      expect(found).toBeInTheDocument();
      return found!;
    });
    expect(toggle).toHaveTextContent('登録済みの返済');
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'true');

    const rows = Array.from(
      document.querySelectorAll(`[data-ui="${UI.cashflow.repaymentRow}"]`),
    ) as HTMLElement[];
    expect(rows).toHaveLength(3);
    // 日付昇順（初回 = firstDate）+ 金額（30,000 を 3 回 = 各 10,000）。
    expect(rows[0]).toHaveTextContent(firstDate);
    expect(rows[0]).toHaveTextContent('10,000');
    const dates = rows.map((row) => row.textContent ?? '');
    expect(dates).toEqual([...dates].sort());

    // タップ = その返済仕訳の編集（既存の onEditEntry 経路）。
    fireEvent.click(rows[0]!);
    expect(onEditEntry).toHaveBeenCalledTimes(1);
    const entry = onEditEntry.mock.calls[0]![0] as JournalEntry;
    expect(entry.date).toBe(firstDate);
    expect(
      entry.lines.some(
        (l) => l.side === 'debit' && l.accountId === card.id && l.amount === 1000000,
      ),
    ).toBe(true);
  });

  it('返済回数が hard cap を超えたら、巨大配列を作らず画面上で理由を示す', async () => {
    const ledger = await loadLedger();
    const cash = ledger.accounts.find((a) => a.name === '現金')!;
    const card = ledger.accounts.find((a) => a.role === 'payment-liability')!;
    await createOpenings([
      { accountId: cash.id, amount: 1_000_000, date: '2000-01-01' },
      {
        accountId: card.id,
        amount: MONTHLY_AMOUNTS_HARD_CAP + 1,
        date: '2000-01-01',
      },
    ]);
    render(view(() => undefined));

    const liabilityRow = await waitFor(() => {
      const found = ui(UI.cashflow.liabilityRow);
      expect(found).toBeInTheDocument();
      return found!;
    });
    fireEvent.click(liabilityRow);
    fireEvent.change(ui(UI.cashflow.repayCount)!, {
      target: { value: String(MONTHLY_AMOUNTS_HARD_CAP + 1) },
    });
    fireEvent.click(ui(UI.cashflow.repaySave)!);

    expect(await screen.findByRole('alert')).toHaveTextContent(
      `返済回数は 1〜${MONTHLY_AMOUNTS_HARD_CAP} の整数で入力してください。`,
    );
  });
});

describe('将来の入出金の行タップ（entryOpenPlan の単一正本）', () => {
  it('保存された返済仕訳は編集シート、定期ルールの投影は毎月のもの（ルール）へ', async () => {
    const ledger = await loadLedger();
    const bank = ledger.accounts.find((a) => a.name === '預金')!;
    const card = ledger.accounts.find((a) => a.role === 'payment-liability')!;
    await createOpenings([
      { accountId: bank.id, amount: 50000000, date: '2000-01-01' },
      { accountId: card.id, amount: 3000000, date: '2000-01-01' },
    ]);
    // 保存された将来の返済（実仕訳）。
    await createRepaymentEntries({
      title: 'カードの返済',
      liabilityAccountId: card.id,
      fromAccountId: bank.id,
      total: 3000000,
      count: 1,
      firstDate: addMonthsToDate(todayLocal(), 1),
    });
    // 未来へ投影される定期ルール（支払い元 = 預金なので購入行が資金繰りへ出る）。
    const expense = ledger.accounts.find((a) => a.role === 'expense-category')!;
    const { createRecurringRule } = await import('../src/data/repository');
    await createRecurringRule({
      name: '家賃ルール',
      amount: 20000000,
      dayOfMonth: 25,
      debitAccountId: expense.id,
      creditAccountId: bank.id,
      startMonth: todayLocal().slice(0, 7),
      startDate: todayLocal(),
    });

    const onEditEntry = vi.fn();
    const onOpenAllocations = vi.fn();
    render(view(onEditEntry, { onOpenAllocations }));
    const rows = await screen.findAllByRole('button', { name: /カードの返済|家賃ルール/ });
    const repayRow = rows.find((r) => r.textContent?.includes('カードの返済'))!;
    const ruleRow = rows.find((r) => r.textContent?.includes('家賃ルール'))!;

    fireEvent.click(repayRow);
    expect(onEditEntry).toHaveBeenCalledTimes(1);

    fireEvent.click(ruleRow);
    expect(onOpenAllocations).toHaveBeenCalledWith(
      expect.objectContaining({ ruleId: expect.any(String) }),
    );
  });
});
