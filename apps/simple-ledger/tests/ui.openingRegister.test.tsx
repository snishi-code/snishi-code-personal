/*
 * 勘定科目画面の「補正」導線の自動分岐:
 *  - 履歴が全く無い科目 → 初期残高登録シート（createOpening 経路・収入にならない）
 *  - 履歴がある科目 → 従来の残高補正シート
 * あわせて、内訳編集シートからメモ欄が撤去されていることを確認する。
 */
import { describe, it, expect, afterEach, beforeAll } from 'vitest';
import { render, cleanup, fireEvent, waitFor, screen, within } from '@testing-library/react';
import { ToastProvider } from '@snishi/foundation/ui/toast';
import { patchDialogIfNeeded } from '@snishi/foundation/ui/test-utils';
import { Accounts } from '../src/ui/screens/Accounts';
import { LedgerProvider } from '../src/state/store';
import { createOpening, createRepaymentEntries, loadLedger } from '../src/data/repository';
import { _resetOverlaysForTests } from '../src/ui/overlays';
import './setup';

beforeAll(() => {
  patchDialogIfNeeded();
});

afterEach(() => {
  cleanup();
  _resetOverlaysForTests();
});

function q(dataUi: string): Element | null {
  return document.querySelector(`[data-ui="${dataUi}"]`);
}

async function renderAccounts() {
  const view = render(
    <ToastProvider>
      <LedgerProvider>
        <Accounts />
      </LedgerProvider>
    </ToastProvider>,
  );
  await waitFor(() => {
    expect(q('accounts.view')).toBeInTheDocument();
  });
  return view;
}

describe('補正導線の初期残高分岐', () => {
  it('勘定科目の残高は未来日付の返済仕訳を含めない', async () => {
    const ledger = await loadLedger();
    const cash = ledger.accounts.find((account) => account.name === '現金')!;
    const liability = ledger.accounts.find((account) => account.role === 'payment-liability')!;
    await createOpening({ accountId: cash.id, amount: 100000, date: '2000-01-01' });
    await createRepaymentEntries({
      liabilityAccountId: liability.id,
      fromAccountId: cash.id,
      firstDate: '2090-01-27',
      total: 60000,
      count: 3,
      title: '未来返済',
    });

    await renderAccounts();
    const cashRow = (await screen.findByText('現金')).closest('li');
    expect(cashRow).not.toBeNull();
    expect(within(cashRow!).getByText(/100,000/)).toBeInTheDocument();
    expect(within(cashRow!).queryByText(/40,000/)).not.toBeInTheDocument();
  });

  it('履歴ゼロの科目は初期残高登録になり、opening 仕訳が作られる（収入にならない）', async () => {
    await renderAccounts();

    fireEvent.click(await screen.findByRole('button', { name: '補正: 現金' }));
    await waitFor(() => {
      expect(q('adjustments.openingRegister.dialog')).toBeInTheDocument();
    });
    // 通常の補正ダイアログは開いていない。
    expect(q('adjustments.createDialog')).not.toBeInTheDocument();

    fireEvent.change(q('adjustments.openingRegister.amount')!, { target: { value: '50000' } });
    fireEvent.click(q('adjustments.openingRegister.save')!);
    await waitFor(() => {
      expect(q('adjustments.openingRegister.dialog')).not.toBeInTheDocument();
    });

    const ledger = await loadLedger();
    const openings = ledger.journalEntries.filter((e) => e.kind === 'opening');
    expect(openings.length).toBe(1);
    const cash = ledger.accounts.find((a) => a.name === '現金')!;
    expect(openings[0]!.lines.some((l) => l.accountId === cash.id && l.amount === 50000)).toBe(
      true,
    );
    // 補正仕訳（adjustment metadata）は作られていない。
    expect(ledger.journalEntries.some((e) => e.metadata?.adjustment)).toBe(false);
  });

  it('履歴ができた科目は従来どおり補正シートが開く', async () => {
    const first = await renderAccounts();
    fireEvent.click(await screen.findByRole('button', { name: '補正: 現金' }));
    await waitFor(() => {
      expect(q('adjustments.openingRegister.dialog')).toBeInTheDocument();
    });
    fireEvent.change(q('adjustments.openingRegister.amount')!, { target: { value: '1000' } });
    fireEvent.click(q('adjustments.openingRegister.save')!);
    await waitFor(() => {
      expect(q('adjustments.openingRegister.dialog')).not.toBeInTheDocument();
    });
    first.unmount();
    _resetOverlaysForTests();

    const second = await renderAccounts();
    fireEvent.click(await screen.findByRole('button', { name: '補正: 現金' }));
    await waitFor(() => {
      expect(q('adjustments.createDialog')).toBeInTheDocument();
    });
    expect(q('adjustments.openingRegister.dialog')).not.toBeInTheDocument();
    second.unmount();
  });

  it('内訳編集シートにメモ欄（textarea）が無い', async () => {
    await renderAccounts();
    fireEvent.click(await screen.findByRole('button', { name: '編集: 現金' }));
    await waitFor(() => {
      expect(screen.getByText('内訳を編集')).toBeInTheDocument();
    });
    expect(document.querySelector('dialog textarea')).toBeNull();
  });
});
