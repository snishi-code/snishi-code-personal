import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, waitFor, within } from '@testing-library/react';
import { ToastProvider } from '@snishi/foundation/ui/toast';
import { patchDialogIfNeeded } from '@snishi/foundation/ui/test-utils';
import {
  createOpening,
  createReserve,
  loadLedger,
  upsertEntry,
} from '../src/data/repository';
import { buildSimpleEntry } from '../src/domain/entry';
import { addMonthsToDate } from '../src/domain/allocation';
import { LedgerProvider } from '../src/state/store';
import { UI } from '../src/ui-contract';
import { _resetOverlaysForTests } from '../src/ui/overlays';
import { Breakdown } from '../src/ui/screens/Breakdown';
import { Cashflow } from '../src/ui/screens/Cashflow';
import { todayLocal } from '../src/util/time';
import './setup';

beforeAll(() => {
  patchDialogIfNeeded();
});

afterEach(() => {
  cleanup();
  _resetOverlaysForTests();
});

function queryUi(value: string): HTMLElement {
  const element = document.querySelector<HTMLElement>(`[data-ui="${value}"]`);
  if (!element) throw new Error(`data-ui=${value} が見つかりません。`);
  return element;
}

async function seedReserve(unassigned: number): Promise<void> {
  const ledger = await loadLedger();
  const cash = ledger.accounts.find((account) => account.role === 'daily-asset');
  if (!cash) throw new Error('日常資金口座がありません。');
  const reserve = await createReserve({ name: '旅行' });
  const today = todayLocal();

  await createOpening({ accountId: cash.id, amount: 1_000, date: '2000-01-01' });
  await upsertEntry(
    buildSimpleEntry({
      date: today,
      description: '旅行へ取り置き',
      debitAccountId: reserve.reserveAccountId,
      creditAccountId: cash.id,
      amount: 300,
      metadata: { inputMode: 'transfer', reserveId: reserve.id },
    }),
  );
  await upsertEntry(
    buildSimpleEntry({
      date: today,
      description: '目的未指定の移動',
      debitAccountId: unassigned > 0 ? reserve.reserveAccountId : cash.id,
      creditAccountId: unassigned > 0 ? cash.id : reserve.reserveAccountId,
      amount: Math.abs(unassigned),
      metadata: { inputMode: 'transfer' },
    }),
  );
}

function renderViews() {
  return render(
    <ToastProvider>
      <LedgerProvider>
        <Breakdown
          section="asset"
          period={{ mode: 'all' }}
          onPeriodChange={() => undefined}
          onDrillDown={() => undefined}
          onNavigate={() => undefined}
        />
        <Cashflow />
      </LedgerProvider>
    </ToastProvider>,
  );
}

function reserveParentRow(): Element | undefined {
  return Array.from(
    document.querySelectorAll(`[data-ui="${UI.assetsBreakdown.row}"]`),
  ).find((row) => row.textContent?.includes('取り置き資金'));
}

async function openCashflowReserves(): Promise<void> {
  fireEvent.click(queryUi(UI.cashflow.advancedToggle));
  await waitFor(() => {
    expect(queryUi(UI.cashflow.reserveList)).toBeInTheDocument();
  });
}

describe('取り置き資金の未割り当て表示', () => {
  it('Breakdown/Cashflowとも親500 = 旅行300 + 未割り当て200になる', async () => {
    await seedReserve(200);
    renderViews();

    await waitFor(() => {
      expect(reserveParentRow()).toHaveTextContent('￥500');
    });
    const namedBreakdown = Array.from(
      document.querySelectorAll(`[data-ui="${UI.assetsBreakdown.reserveSub}"]`),
    ).find((row) => row.textContent?.includes('旅行'));
    expect(namedBreakdown).toHaveTextContent('￥300');
    expect(queryUi(UI.assetsBreakdown.reserveUnassigned)).toHaveTextContent('￥200');

    const summary = queryUi(UI.cashflow.summary);
    const reserved = within(summary).getByText('取り置き').closest('.stat');
    expect(reserved).toHaveTextContent('￥500');
    await openCashflowReserves();
    const list = queryUi(UI.cashflow.reserveList);
    expect(within(list).getByText('旅行').closest('li')).toHaveTextContent('￥300');
    expect(queryUi(UI.cashflow.reserveUnassigned)).toHaveTextContent('￥200');
  });

  it('未割り当てが負でも両画面で隠さず、親250 = 旅行300 − 50になる', async () => {
    await seedReserve(-50);
    renderViews();

    await waitFor(() => {
      expect(reserveParentRow()).toHaveTextContent('￥250');
    });
    expect(queryUi(UI.assetsBreakdown.reserveUnassigned)).toHaveTextContent('-￥50');

    const summary = queryUi(UI.cashflow.summary);
    const reserved = within(summary).getByText('取り置き').closest('.stat');
    expect(reserved).toHaveTextContent('￥250');
    await openCashflowReserves();
    expect(queryUi(UI.cashflow.reserveUnassigned)).toHaveTextContent('-￥50');
  });

  it('未来の目的別仕訳をtoday基準の親行・サブ行へ混ぜない', async () => {
    const ledger = await loadLedger();
    const cash = ledger.accounts.find((account) => account.role === 'daily-asset')!;
    const reserve = await createReserve({ name: '旅行' });
    const today = todayLocal();
    await createOpening({ accountId: cash.id, amount: 1_000, date: '2000-01-01' });
    for (const [date, amount] of [
      [today, 300],
      [addMonthsToDate(today, 1), 200],
    ] as const) {
      await upsertEntry(
        buildSimpleEntry({
          date,
          description: '旅行へ取り置き',
          debitAccountId: reserve.reserveAccountId,
          creditAccountId: cash.id,
          amount,
          metadata: { inputMode: 'transfer', reserveId: reserve.id },
        }),
      );
    }

    renderViews();
    await waitFor(() => {
      expect(reserveParentRow()).toHaveTextContent('￥300');
    });
    const namedBreakdown = Array.from(
      document.querySelectorAll(`[data-ui="${UI.assetsBreakdown.reserveSub}"]`),
    ).find((row) => row.textContent?.includes('旅行'));
    expect(namedBreakdown).toHaveTextContent('￥300');
    expect(
      document.querySelector(`[data-ui="${UI.assetsBreakdown.reserveUnassigned}"]`),
    ).not.toBeInTheDocument();

    const summary = queryUi(UI.cashflow.summary);
    const reserved = within(summary).getByText('取り置き').closest('.stat');
    expect(reserved).toHaveTextContent('￥300');
    await openCashflowReserves();
    expect(within(queryUi(UI.cashflow.reserveList)).getByText('旅行').closest('li')).toHaveTextContent(
      '￥300',
    );
  });
});
