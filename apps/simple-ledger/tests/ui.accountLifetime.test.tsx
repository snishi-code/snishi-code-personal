import type { ReactNode } from 'react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { ToastProvider } from '@snishi/foundation/ui/toast';
import { patchDialogIfNeeded } from '@snishi/foundation/ui/test-utils';
import { loadLedger, upsertAccount, upsertEntry } from '../src/data/repository';
import { buildSimpleEntry } from '../src/domain/entry';
import { LedgerProvider, useLedger } from '../src/state/store';
import { _resetOverlaysForTests } from '../src/ui/overlays';
import { AccountSheet } from '../src/ui/screens/AccountSheet';
import { EntrySheet } from '../src/ui/screens/EntrySheet';
import { boxForRole } from '../src/ui/accountBoxes';
import { UI } from '../src/ui-contract';
import './setup';

beforeAll(() => {
  patchDialogIfNeeded();
});

afterEach(() => {
  cleanup();
  _resetOverlaysForTests();
});

function Providers({ children }: { children: ReactNode }) {
  return (
    <ToastProvider>
      <LedgerProvider>{children}</LedgerProvider>
    </ToastProvider>
  );
}

function ReadyAccountSheet({ accountId, onClose }: { accountId: string; onClose: () => void }) {
  const { ledger, status } = useLedger();
  if (status !== 'ready' || !ledger) return null;
  const account = ledger.accounts.find((candidate) => candidate.id === accountId);
  return account ? <AccountSheet existing={account} onClose={onClose} /> : null;
}

function ReadyEntrySheet() {
  const { status } = useLedger();
  return status === 'ready' ? (
    <EntrySheet init={{ kind: 'create', mode: 'expense' }} onClose={() => undefined} />
  ) : null;
}

async function renderAccountSheet(accountId: string, onClose: () => void) {
  render(
    <Providers>
      <ReadyAccountSheet accountId={accountId} onClose={onClose} />
    </Providers>,
  );
  const startDate = await waitFor(() => {
    const input = document.querySelector(
      '[data-ui="accounts.startDate"]',
    ) as HTMLInputElement | null;
    expect(input).toBeInTheDocument();
    return input!;
  });
  const endDate = document.querySelector('[data-ui="accounts.endDate"]') as HTMLInputElement;
  return { startDate, endDate };
}

describe('科目編集シートの存在期間', () => {
  it('開始日と終了日を編集して保存する', async () => {
    const ledger = await loadLedger();
    const target = ledger.accounts.find((account) => account.name === 'チャージ残高')!;
    await upsertAccount({ ...target, startDate: '2026-01-01' });
    const onClose = vi.fn();

    const { startDate, endDate } = await renderAccountSheet(target.id, onClose);
    expect(startDate.value).toBe('2026-01-01');
    expect(endDate.value).toBe('');

    fireEvent.change(startDate, { target: { value: '2025-04-01' } });
    fireEvent.change(endDate, { target: { value: '2026-12-31' } });
    fireEvent.click(document.querySelector(`[data-ui="${UI.accounts.save}"]`)!);

    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    const saved = (await loadLedger()).accounts.find((account) => account.id === target.id)!;
    expect(saved).toMatchObject({
      startDate: '2025-04-01',
      endDate: '2026-12-31',
      archived: true,
    });
  });

  it('終了日を空に戻すと終了点を削除してアーカイブ解除する', async () => {
    const ledger = await loadLedger();
    const target = ledger.accounts.find((account) => account.name === 'チャージ残高')!;
    await upsertAccount({
      ...target,
      startDate: '2025-01-01',
      endDate: '2026-06-30',
      archived: true,
    });
    const onClose = vi.fn();

    const { endDate } = await renderAccountSheet(target.id, onClose);
    expect(endDate.value).toBe('2026-06-30');
    fireEvent.change(endDate, { target: { value: '' } });
    fireEvent.click(document.querySelector(`[data-ui="${UI.accounts.save}"]`)!);

    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    const saved = (await loadLedger()).accounts.find((account) => account.id === target.id)!;
    expect(saved.archived).toBe(false);
    expect(saved.endDate).toBeUndefined();
  });

  // ── §A 案1（2026-08-11）: 開始日欄の契約 = 空欄 = undefined = 過去側制限なし ──

  it('開始日未設定は空欄で表示し、触らず保存しても undefined を維持する（createdAt を再保存しない）', async () => {
    // 旧仕様は未設定値を createdAt で表示し、編集のたびに暗黙値を明示化して保存していた。
    const ledger = await loadLedger();
    const target = ledger.accounts.find((account) => account.name === 'チャージ残高')!;
    expect(target.startDate).toBeUndefined();
    const onClose = vi.fn();

    const { startDate } = await renderAccountSheet(target.id, onClose);
    expect(startDate.value).toBe('');
    fireEvent.click(document.querySelector(`[data-ui="${UI.accounts.save}"]`)!);

    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    const saved = (await loadLedger()).accounts.find((account) => account.id === target.id)!;
    expect(saved.startDate).toBeUndefined();
  });

  it('明示開始日を空欄へ戻すと開始日を削除する', async () => {
    const ledger = await loadLedger();
    const target = ledger.accounts.find((account) => account.name === 'チャージ残高')!;
    await upsertAccount({ ...target, startDate: '2026-01-01' });
    const onClose = vi.fn();

    const { startDate } = await renderAccountSheet(target.id, onClose);
    expect(startDate.value).toBe('2026-01-01');
    fireEvent.change(startDate, { target: { value: '' } });
    fireEvent.click(document.querySelector(`[data-ui="${UI.accounts.save}"]`)!);

    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    const saved = (await loadLedger()).accounts.find((account) => account.id === target.id)!;
    expect(saved.startDate).toBeUndefined();
  });

  it('新規作成は開始日を持たない（既定 = 空欄 = 過去へ開いた線分）', async () => {
    await loadLedger();
    const onClose = vi.fn();
    function ReadyCreateSheet() {
      const { status } = useLedger();
      return status === 'ready' ? (
        <AccountSheet box={boxForRole('expense-category')} onClose={onClose} />
      ) : null;
    }
    render(
      <Providers>
        <ReadyCreateSheet />
      </Providers>,
    );
    await waitFor(() => {
      expect(document.querySelector(`[data-ui="${UI.accounts.save}"]`)).toBeInTheDocument();
    });
    // 新規モードには開始日欄自体が無い＝暗黙の既定値を作らない。
    expect(document.querySelector('[data-ui="accounts.startDate"]')).toBeNull();
    fireEvent.change(screen.getByLabelText(/科目名/), { target: { value: '新しい費目' } });
    fireEvent.click(document.querySelector(`[data-ui="${UI.accounts.save}"]`)!);

    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    const saved = (await loadLedger()).accounts.find((account) => account.name === '新しい費目')!;
    expect(saved.startDate).toBeUndefined();
    expect(Object.prototype.hasOwnProperty.call(saved, 'startDate')).toBe(false);
  });

  it('初出仕訳より後へ開始点を縮める保存は拒否する', async () => {
    const ledger = await loadLedger();
    const cash = ledger.accounts.find((account) => account.name === '預金')!;
    const expense = ledger.accounts.find((account) => account.name === '固定費')!;
    await upsertAccount({ ...cash, startDate: '2026-01-01' });
    await upsertAccount({ ...expense, startDate: '2026-01-01' });
    await upsertEntry(
      buildSimpleEntry({
        date: '2026-06-15',
        description: '開始点ガード',
        debitAccountId: expense.id,
        creditAccountId: cash.id,
        amount: 100,
      }),
    );
    const onClose = vi.fn();

    const { startDate } = await renderAccountSheet(cash.id, onClose);
    fireEvent.change(startDate, { target: { value: '2026-06-16' } });
    fireEvent.click(document.querySelector(`[data-ui="${UI.accounts.save}"]`)!);

    expect(await screen.findByRole('alert')).toHaveTextContent('存在期間の外');
    expect(onClose).not.toHaveBeenCalled();
    expect((await loadLedger()).accounts.find((account) => account.id === cash.id)?.startDate).toBe(
      '2026-01-01',
    );
  });

  it('最終仕訳より前へ終了点を縮める保存は拒否する', async () => {
    const ledger = await loadLedger();
    const cash = ledger.accounts.find((account) => account.name === '預金')!;
    const expense = ledger.accounts.find((account) => account.name === '固定費')!;
    await upsertAccount({ ...cash, startDate: '2026-01-01' });
    await upsertAccount({ ...expense, startDate: '2026-01-01' });
    await upsertEntry(
      buildSimpleEntry({
        date: '2026-06-15',
        description: '終了点ガード',
        debitAccountId: expense.id,
        creditAccountId: cash.id,
        amount: 100,
      }),
    );
    const onClose = vi.fn();

    const { endDate } = await renderAccountSheet(cash.id, onClose);
    fireEvent.change(endDate, { target: { value: '2026-06-14' } });
    fireEvent.click(document.querySelector(`[data-ui="${UI.accounts.save}"]`)!);

    expect(await screen.findByRole('alert')).toHaveTextContent('存在期間の外');
    expect(onClose).not.toHaveBeenCalled();
    expect(
      (await loadLedger()).accounts.find((account) => account.id === cash.id)?.endDate,
    ).toBeUndefined();
  });
});

describe('仕訳入力の科目候補', () => {
  it('ヘッダーではなくフォームの日付時点で存在する科目だけを表示する', async () => {
    await loadLedger();
    const timestamp = '2025-01-01T00:00:00.000Z';
    await upsertAccount({
      id: 'limited-payment-source',
      name: '期間限定の支払い元',
      type: 'asset',
      role: 'daily-asset',
      startDate: '2025-01-01',
      endDate: '2025-12-31',
      archived: true,
      createdAt: timestamp,
      updatedAt: timestamp,
    });
    await upsertAccount({
      id: 'limited-expense-destination',
      name: '期間限定の支出先',
      type: 'expense',
      role: 'expense-category',
      startDate: '2025-01-01',
      endDate: '2025-12-31',
      archived: true,
      createdAt: timestamp,
      updatedAt: timestamp,
    });

    render(
      <Providers>
        <ReadyEntrySheet />
      </Providers>,
    );
    const date = await waitFor(() => {
      const input = document.querySelector(
        `[data-ui="${UI.journal.entry.date}"]`,
      ) as HTMLInputElement | null;
      expect(input).toBeInTheDocument();
      return input!;
    });

    const expectCandidates = async (value: string, visible: boolean) => {
      fireEvent.change(date, { target: { value } });
      await waitFor(() => {
        const source = document.querySelector(
          `[data-ui="${UI.journal.entry.flowSource}"]`,
        ) as HTMLElement;
        const destination = document.querySelector(
          `[data-ui="${UI.journal.entry.flowDestination}"]`,
        ) as HTMLElement;
        const sourceCandidate = within(source).queryByRole('radio', {
          name: '期間限定の支払い元',
        });
        const destinationCandidate = within(destination).queryByRole('radio', {
          name: '期間限定の支出先',
        });
        if (visible) {
          expect(sourceCandidate).toBeInTheDocument();
          expect(destinationCandidate).toBeInTheDocument();
        } else {
          expect(sourceCandidate).not.toBeInTheDocument();
          expect(destinationCandidate).not.toBeInTheDocument();
        }
      });
    };

    await expectCandidates('2024-12-31', false);
    await expectCandidates('2025-01-01', true);
    await expectCandidates('2025-12-31', true);
    await expectCandidates('2026-01-01', false);
  });
});
