/*
 * 仕訳一覧・カード表示の「未記入」注意表示のスモーク。
 *  - seed の「未記入」科目が借方にある仕訳: 行に list__item--unfilled + チップ「未記入」が付く。
 *  - 未記入を含まない仕訳には付かない（誤検知しない）。
 *  - カード表示（EntryListItem。ホームの直近仕訳）でも同じチップ + 行クラスが付く。
 */
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { ToastProvider } from '@snishi/foundation/ui/toast';
import { patchDialogIfNeeded } from '@snishi/foundation/ui/test-utils';
import { LedgerProvider, useLedger } from '../src/state/store';
import { Journal } from '../src/ui/screens/Journal';
import { EntryListItem } from '../src/ui/EntryListItem';
import { loadLedger, upsertEntry } from '../src/data/repository';
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

function JournalView() {
  return (
    <ToastProvider>
      <LedgerProvider>
        <ReadyJournal />
      </LedgerProvider>
    </ToastProvider>
  );
}

function ReadyJournal() {
  const { status } = useLedger();
  if (status !== 'ready') return null;
  return (
    <Journal
      onEditEntry={() => undefined}
      onReverse={() => undefined}
      onOpenAllocations={() => undefined}
      onOpenAccount={() => undefined}
      filter={null}
      period={{ mode: 'all' }}
      onClearFilter={() => undefined}
    />
  );
}

/** seed 済み台帳へ、未記入が借方の仕訳と通常の仕訳を 1 件ずつ入れる。 */
async function createFixtures(): Promise<{ unfilled: JournalEntry; normal: JournalEntry }> {
  const ledger = await loadLedger();
  const unfilledAccount = ledger.accounts.find((a) => a.name === '未記入')!;
  const expense = ledger.accounts.find((a) => a.name === '変動費')!;
  const asset = ledger.accounts.find((a) => a.role === 'daily-asset')!;
  const today = todayLocal();
  const timestamp = `${today}T00:00:00.000Z`;
  const unfilled: JournalEntry = {
    id: 'ent-unfilled',
    date: today,
    description: 'カード決済（振り分け前）',
    kind: 'normal',
    lines: [
      { accountId: unfilledAccount.id, side: 'debit', amount: 3200 },
      { accountId: asset.id, side: 'credit', amount: 3200 },
    ],
    metadata: { inputMode: 'expense' },
    createdAt: timestamp,
    updatedAt: timestamp,
  };
  const normal: JournalEntry = {
    id: 'ent-normal',
    date: today,
    description: '振り分け済みの買い物',
    kind: 'normal',
    lines: [
      { accountId: expense.id, side: 'debit', amount: 1500 },
      { accountId: asset.id, side: 'credit', amount: 1500 },
    ],
    metadata: { inputMode: 'expense' },
    createdAt: timestamp,
    updatedAt: timestamp,
  };
  await upsertEntry(unfilled);
  await upsertEntry(normal);
  return { unfilled, normal };
}

describe('仕訳一覧の「未記入」注意表示', () => {
  it('未記入が借方の行にだけ淡色クラスとチップが付く', async () => {
    await createFixtures();
    render(<JournalView />);
    await waitFor(() => {
      expect(document.querySelector(`[data-ui="${UI.journal.view}"]`)).toBeInTheDocument();
    });

    const unfilledRow = (await screen.findByText('カード決済（振り分け前）')).closest('li')!;
    expect(unfilledRow.classList.contains('list__item--unfilled')).toBe(true);
    expect(unfilledRow.querySelector('.tag--unfilled')).toHaveTextContent('未記入');

    const normalRow = screen.getByText('振り分け済みの買い物').closest('li')!;
    expect(normalRow.classList.contains('list__item--unfilled')).toBe(false);
    expect(normalRow.querySelector('.tag--unfilled')).toBeNull();
  });
});

describe('カード表示（EntryListItem）の「未記入」注意表示', () => {
  it('未記入を含む仕訳のカードにだけ淡色クラスとチップが付く', async () => {
    const { unfilled, normal } = await createFixtures();
    const ledger = await loadLedger();
    render(
      <ul>
        <EntryListItem entry={unfilled} accounts={ledger.accounts} currency="円" />
        <EntryListItem entry={normal} accounts={ledger.accounts} currency="円" />
      </ul>,
    );

    const unfilledItem = screen.getByText('カード決済（振り分け前）').closest('.list__item')!;
    expect(unfilledItem.classList.contains('list__item--unfilled')).toBe(true);
    expect(unfilledItem.querySelector('.tag--unfilled')).toHaveTextContent('未記入');

    const normalItem = screen.getByText('振り分け済みの買い物').closest('.list__item')!;
    expect(normalItem.classList.contains('list__item--unfilled')).toBe(false);
    expect(normalItem.querySelector('.tag--unfilled')).toBeNull();
  });
});
