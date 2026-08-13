/*
 * 勘定科目のアーカイブ（§6-2）:
 *  - 残高 0 なら即アーカイブ
 *  - 今日時点の残高が残る資産・負債は振替シート（ホームの振替 = EntrySheet transfer 再利用）
 *    を経由し、振替仕訳 + archived=true を 1 トランザクションで保存する
 *  - キャンセルしたらアーカイブされない
 */
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { ToastProvider } from '@snishi/foundation/ui/toast';
import { patchDialogIfNeeded } from '@snishi/foundation/ui/test-utils';
import { LedgerProvider, useLedger } from '../src/state/store';
import { Accounts } from '../src/ui/screens/Accounts';
import { createOpenings, loadLedger, upsertAccount, upsertEntry } from '../src/data/repository';
import { accountBalance } from '../src/domain/accounting';
import { buildSimpleEntry } from '../src/domain/entry';
import { todayLocal } from '../src/util/time';
import { UI } from '../src/ui-contract';
import { _resetOverlaysForTests } from '../src/ui/overlays';
import './setup';

beforeAll(() => {
  patchDialogIfNeeded();
});

afterEach(() => {
  cleanup();
  _resetOverlaysForTests();
});

function View() {
  return (
    <ToastProvider>
      <LedgerProvider>
        <ReadyView />
      </LedgerProvider>
    </ToastProvider>
  );
}

function ReadyView() {
  const { status } = useLedger();
  return status === 'ready' ? <Accounts /> : null;
}

async function renderReady() {
  render(<View />);
  await waitFor(() => {
    expect(document.querySelector(`[data-ui="${UI.accounts.view}"]`)).toBeInTheDocument();
  });
}

describe('勘定科目のアーカイブ', () => {
  it('残高 0 の科目は即アーカイブされる', async () => {
    await loadLedger();
    await renderReady();
    fireEvent.click(await screen.findByRole('button', { name: 'アーカイブ: チャージ残高' }));
    await waitFor(async () => {
      const after = await loadLedger();
      expect(after.accounts.find((a) => a.name === 'チャージ残高')?.archived).toBe(true);
    });
    // 振替シートは開かない。
    expect(document.querySelector(`[data-ui="${UI.journal.entry.save}"]`)).toBeNull();
  });

  it('残高が残る資産は振替シートを経由し、振替 + アーカイブが 1 回で終わる', async () => {
    const ledger = await loadLedger();
    const charge = ledger.accounts.find((a) => a.name === 'チャージ残高')!;
    await createOpenings([{ accountId: charge.id, amount: 500000, date: '2020-01-01' }]);

    await renderReady();
    fireEvent.click(await screen.findByRole('button', { name: 'アーカイブ: チャージ残高' }));

    // ホームの振替と同じシート。金額の既定 = |残高|・振替元 = 対象科目（固定・ピッカー無し）。
    const amountInput = await waitFor(() => {
      const found = document.querySelector(
        `[data-ui="${UI.journal.entry.amount}"]`,
      ) as HTMLInputElement | null;
      expect(found).toBeInTheDocument();
      return found!;
    });
    expect(amountInput.value).toBe('5000');
    expect(
      document.querySelector(`[data-ui="${UI.journal.entry.flowSource}"]`),
    ).not.toBeInTheDocument();
    const destination = document.querySelector(
      `[data-ui="${UI.journal.entry.flowDestination}"]`,
    ) as HTMLElement;
    // 資産の必須振替では同区分だけを候補にする。費用科目は候補にしない。
    expect(within(destination).queryByRole('radio', { name: '変動費' })).not.toBeInTheDocument();
    fireEvent.click(within(destination).getByRole('radio', { name: '現金' }));
    fireEvent.click(document.querySelector(`[data-ui="${UI.journal.entry.save}"]`)!);

    await waitFor(async () => {
      const after = await loadLedger();
      const archived = after.accounts.find((a) => a.name === 'チャージ残高');
      expect(archived?.archived).toBe(true);
      expect(accountBalance(archived!.id, 'asset', after.journalEntries)).toBe(0);
      // 振替仕訳が保存されている（借方 現金 / 貸方 チャージ残高）。
      const cash = after.accounts.find((a) => a.name === '現金')!;
      const transfer = after.journalEntries.find(
        (e) =>
          e.lines.some((l) => l.side === 'credit' && l.accountId === archived!.id) &&
          e.lines.some((l) => l.side === 'debit' && l.accountId === cash.id),
      );
      expect(transfer).toBeDefined();
    });
  });

  it('振替シートをキャンセルするとアーカイブされない', async () => {
    const ledger = await loadLedger();
    const charge = ledger.accounts.find((a) => a.name === 'チャージ残高')!;
    await createOpenings([{ accountId: charge.id, amount: 500000, date: '2020-01-01' }]);

    await renderReady();
    fireEvent.click(await screen.findByRole('button', { name: 'アーカイブ: チャージ残高' }));
    const cancel = await waitFor(() => {
      const found = document.querySelector(`[data-ui="${UI.journal.entry.cancel}"]`);
      expect(found).toBeInTheDocument();
      return found!;
    });
    fireEvent.click(cancel);

    await waitFor(async () => {
      const after = await loadLedger();
      expect(after.accounts.find((a) => a.name === 'チャージ残高')?.archived).toBe(false);
      expect(after.journalEntries.filter((e) => e.kind !== 'opening')).toHaveLength(0);
    });
  });

  it('費用カテゴリは累計を残したまま直接アーカイブできる', async () => {
    const ledger = await loadLedger();
    const cash = ledger.accounts.find((account) => account.name === '預金')!;
    const fixed = ledger.accounts.find((account) => account.name === '固定費')!;
    const today = todayLocal();
    await upsertEntry(
      buildSimpleEntry({
        date: today,
        description: '一時費用',
        debitAccountId: fixed.id,
        creditAccountId: cash.id,
        amount: 100_000,
        kind: 'normal',
      }),
    );

    await renderReady();
    fireEvent.click(await screen.findByRole('button', { name: `アーカイブ: ${fixed.name}` }));

    await waitFor(async () => {
      const after = await loadLedger();
      const archived = after.accounts.find((account) => account.id === fixed.id)!;
      expect(archived).toMatchObject({ archived: true, endDate: today });
      expect(accountBalance(fixed.id, 'expense', after.journalEntries)).toBe(100_000); // UI 入力 1000 = 100,000 minor
    });
    expect(document.querySelector(`[data-ui="${UI.journal.entry.save}"]`)).toBeNull();
  });

  it('費用カテゴリも同区分へ振り替えて累計0にしてから終了点を記録する', async () => {
    const ledger = await loadLedger();
    const cash = ledger.accounts.find((account) => account.name === '預金')!;
    const fixed = ledger.accounts.find((account) => account.name === '固定費')!;
    const variable = ledger.accounts.find((account) => account.name === '変動費')!;
    const today = todayLocal();
    await upsertEntry(
      buildSimpleEntry({
        date: today,
        description: '固定費の累計',
        debitAccountId: fixed.id,
        creditAccountId: cash.id,
        amount: 100_000,
        kind: 'normal',
      }),
    );

    await renderReady();
    fireEvent.click(
      await screen.findByRole('button', {
        name: `累計を振り替えてアーカイブ: ${fixed.name}`,
      }),
    );
    const destination = await waitFor(() => {
      const found = document.querySelector(
        `[data-ui="${UI.journal.entry.flowDestination}"]`,
      ) as HTMLElement | null;
      expect(found).toBeInTheDocument();
      return found!;
    });
    expect(within(destination).queryByRole('radio', { name: cash.name })).not.toBeInTheDocument();
    expect(within(destination).queryByRole('radio', { name: fixed.name })).not.toBeInTheDocument();
    fireEvent.click(within(destination).getByRole('radio', { name: variable.name }));
    fireEvent.click(document.querySelector(`[data-ui="${UI.journal.entry.save}"]`)!);

    await waitFor(async () => {
      const after = await loadLedger();
      const archived = after.accounts.find((account) => account.id === fixed.id)!;
      expect(archived).toMatchObject({ archived: true, endDate: today });
      expect(accountBalance(fixed.id, 'expense', after.journalEntries)).toBe(0);
      expect(accountBalance(variable.id, 'expense', after.journalEntries)).toBe(100_000); // UI 入力 1000 = 100,000 minor
    });
  });
});

describe('勘定科目の色分けと可動性表示', () => {
  it('箱見出しにアクセントを付け、movable=false を一覧のバッジで示す', async () => {
    const ledger = await loadLedger();
    const charge = ledger.accounts.find((account) => account.name === 'チャージ残高')!;
    await upsertAccount({ ...charge, movable: false });

    await renderReady();

    const heading = document.querySelector(`[data-ui="${UI.accounts.box}.cash"]`);
    expect(heading).toHaveAttribute('style', expect.stringContaining('--account-accent'));
    expect(screen.getByText('チャージ残高')).toBeInTheDocument();
    expect(document.querySelector(`[data-ui="${UI.accounts.notMovableBadge}"]`)).toHaveTextContent(
      '自由に動かせない',
    );
  });
});
