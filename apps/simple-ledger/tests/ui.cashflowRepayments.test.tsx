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
import { UI } from '../src/ui-contract';
import { _resetOverlaysForTests } from '../src/ui/overlays';
import { todayLocal } from '../src/util/time';
import type { JournalEntry } from '../src/domain/types';
import './setup';

beforeAll(() => {
  patchDialogIfNeeded();
});

afterEach(() => {
  cleanup();
  _resetOverlaysForTests();
});

function view(onEditEntry: (entry: JournalEntry) => void) {
  return (
    <ToastProvider>
      <LedgerProvider>
        <Cashflow onEditEntry={onEditEntry} />
      </LedgerProvider>
    </ToastProvider>
  );
}

const ui = (name: string) => document.querySelector(`[data-ui="${name}"]`);

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
});
