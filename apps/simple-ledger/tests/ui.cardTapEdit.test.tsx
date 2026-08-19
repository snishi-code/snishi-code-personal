/*
 * カードタップ = 編集（2026-08-15 作者合意）の網:
 *  - 継続コスト item カード / くり返し記帳のルール行 / 導出 item カード / 勘定科目の行を
 *    「そのものを押す」だけで編集シートが開く（行の編集アイコンは存在しない）。
 *  - カード内に残る操作ボタン（アーカイブ等）は押しても編集シートを開かない
 *    （src/ui/cardTap.ts の rowActionClick = バブリング防止。ここを外すとこのテストが赤くなる）。
 *  - キーボード（Enter / Space）でも同じ導線が使える。
 */
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { ToastProvider } from '@snishi/foundation/ui/toast';
import { patchDialogIfNeeded } from '@snishi/foundation/ui/test-utils';
import { LedgerProvider, useLedger } from '../src/state/store';
import { Allocations } from '../src/ui/screens/Allocations';
import { Accounts } from '../src/ui/screens/Accounts';
import { createContinuousCost, createRecurringRule, loadLedger } from '../src/data/repository';
import type { ReportPeriod } from '../src/domain/reportPeriod';
import { UI } from '../src/ui-contract';
import { _resetOverlaysForTests } from '../src/ui/overlays';
import { firstItemCard, firstRuleRow, itemCards } from './tapTargets';
import './setup';

beforeAll(() => {
  patchDialogIfNeeded();
});

afterEach(() => {
  cleanup();
  _resetOverlaysForTests();
});

function AllocationsView({ period }: { period: ReportPeriod }) {
  return (
    <ToastProvider>
      <LedgerProvider>
        <AllocationsReady period={period} />
      </LedgerProvider>
    </ToastProvider>
  );
}

function AllocationsReady({ period }: { period: ReportPeriod }) {
  const { status } = useLedger();
  return status === 'ready' ? <Allocations period={period} onEditEntry={() => undefined} /> : null;
}

async function renderAllocations(period: ReportPeriod = { mode: 'all' }) {
  const view = render(<AllocationsView period={period} />);
  await waitFor(() => {
    expect(document.querySelector(`[data-ui="${UI.allocations.view}"]`)).toBeInTheDocument();
  });
  return view;
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
    expect(document.querySelector(`[data-ui="${UI.accounts.list}"]`)).toBeInTheDocument();
  });
  return view;
}

async function seedItem(name = 'タップで開く項目') {
  const ledger = await loadLedger();
  const cash = ledger.accounts.find((a) => a.role === 'daily-asset')!;
  const expense = ledger.accounts.find((a) => a.role === 'expense-category')!;
  return createContinuousCost({
    name,
    amount: 600000,
    startDate: '2026-01-01',
    endDate: '2027-12-31',
    expenseAccountId: expense.id,
    creditAccountId: cash.id,
  });
}

async function seedRule(name = 'タップで開くルール') {
  const ledger = await loadLedger();
  const cash = ledger.accounts.find((a) => a.role === 'daily-asset')!;
  const expense = ledger.accounts.find((a) => a.role === 'expense-category')!;
  return createRecurringRule({
    name,
    amount: 3000,
    dayOfMonth: 5,
    debitAccountId: expense.id,
    creditAccountId: cash.id,
    // 未来開始 = catch-up が走らないので、一覧に出る item は導出カードだけになる。
    startMonth: '2031-02',
  });
}

describe('カードタップ = 編集', () => {
  it('継続コスト item カードのタップで編集シートが開く', async () => {
    const item = await seedItem();
    await renderAllocations();
    await screen.findByText(item.name);

    fireEvent.click(firstItemCard()!);

    await waitFor(() => {
      expect(
        document.querySelector(`[data-ui="${UI.allocations.editDialog}"]`),
      ).toBeInTheDocument();
    });
    expect(document.querySelector(`[data-ui="${UI.allocations.editName}"]`)).toHaveValue(item.name);
  });

  it('くり返し記帳のルール行のタップでルールのシートが開く', async () => {
    const rule = await seedRule();
    // ルールが存在する断面（未来開始 = 起票済みゼロ）で一覧に出す。
    await renderAllocations({ mode: 'date', date: '2031-02-28' });
    await screen.findAllByText(rule.name);

    fireEvent.click(firstRuleRow()!);

    await waitFor(() => {
      expect(
        document.querySelector(`[data-ui="${UI.allocations.recurringSheet}"]`),
      ).toBeInTheDocument();
    });
    expect(document.querySelector(`[data-ui="${UI.allocations.recurringName}"]`)).toHaveValue(
      rule.name,
    );
  });

  it('導出 item カード（未起票周期）のタップで由来ルールのシートが開く', async () => {
    const rule = await seedRule('導出カードのルール');
    // 断面 2031-04-30 = 起票済みゼロ・その日の未起票周期だけがカードで見える。
    await renderAllocations({ mode: 'date', date: '2031-04-30' });
    const derived = await waitFor(() => {
      const card = itemCards().find((el) => el.hasAttribute('data-derived-rule'));
      expect(card).toBeDefined();
      return card!;
    });

    fireEvent.click(derived);

    await waitFor(() => {
      expect(
        document.querySelector(`[data-ui="${UI.allocations.recurringSheet}"]`),
      ).toBeInTheDocument();
    });
    expect(document.querySelector(`[data-ui="${UI.allocations.recurringName}"]`)).toHaveValue(
      rule.name,
    );
  });

  it('カード内のアーカイブボタンを押しても編集シートは開かない（カードタップへ伝播しない）', async () => {
    const item = await seedItem('アーカイブだけしたい項目');
    await renderAllocations();
    await screen.findByText(item.name);

    fireEvent.click(await screen.findByRole('button', { name: `終了: ${item.name}` }));

    // 押した操作（アーカイブのダイアログ）だけが起き、編集シートは開かない。
    await waitFor(() => {
      expect(
        document.querySelector(`[data-ui="${UI.allocations.archiveDialog}"]`),
      ).toBeInTheDocument();
    });
    expect(
      document.querySelector(`[data-ui="${UI.allocations.editDialog}"]`),
    ).not.toBeInTheDocument();
  });

  it('勘定科目の行のタップで科目の編集シートが開く', async () => {
    await renderAccounts();

    fireEvent.click(await screen.findByRole('button', { name: '編集: 現金' }));

    await waitFor(() => {
      expect(document.querySelector(`[data-ui="${UI.accounts.save}"]`)).toBeInTheDocument();
    });
  });

  it('キーボードの Enter でも item カードから編集シートが開く', async () => {
    const item = await seedItem('キーボードで開く項目');
    await renderAllocations();
    await screen.findByText(item.name);

    const card = firstItemCard()!;
    card.focus();
    fireEvent.keyDown(card, { key: 'Enter' });

    await waitFor(() => {
      expect(
        document.querySelector(`[data-ui="${UI.allocations.editDialog}"]`),
      ).toBeInTheDocument();
    });
    expect(document.querySelector(`[data-ui="${UI.allocations.editName}"]`)).toHaveValue(item.name);
  });

  it('キーボードの Space でもルール行からルールのシートが開く', async () => {
    const rule = await seedRule('キーボードで開くルール');
    await renderAllocations({ mode: 'date', date: '2031-02-28' });
    await screen.findAllByText(rule.name);

    const row = firstRuleRow()!;
    row.focus();
    fireEvent.keyDown(row, { key: ' ' });

    await waitFor(() => {
      expect(
        document.querySelector(`[data-ui="${UI.allocations.recurringSheet}"]`),
      ).toBeInTheDocument();
    });
    expect(document.querySelector(`[data-ui="${UI.allocations.recurringName}"]`)).toHaveValue(
      rule.name,
    );
  });
});
