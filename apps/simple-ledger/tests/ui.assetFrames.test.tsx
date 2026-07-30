/*
 * 資産の内訳の 4 枠表示:
 *  ① 自由に動かせるお金（daily-asset・movable ≠ false）
 *  ② 自由に動かせないお金（daily-asset・movable = false）
 *  ③ 投資（investment-asset）
 *  ④ 継続コスト台帳（1 行 = 残存価値合計・タップで「毎月のもの」へ）
 * 各枠に小計・最後に全体合計（従来の total）。
 */
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { ToastProvider } from '@snishi/foundation/ui/toast';
import { patchDialogIfNeeded } from '@snishi/foundation/ui/test-utils';
import { LedgerProvider } from '../src/state/store';
import { Breakdown } from '../src/ui/screens/Breakdown';
import {
  createContinuousCost,
  createOpenings,
  loadLedger,
  upsertAccount,
} from '../src/data/repository';
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

function Providers({ children }: { children: React.ReactNode }) {
  return (
    <ToastProvider>
      <LedgerProvider>{children}</LedgerProvider>
    </ToastProvider>
  );
}

const ui = (name: string) => document.querySelector(`[data-ui="${name}"]`);

describe('資産の内訳 4 枠', () => {
  it('枠ごとの小計と全体合計を出し、継続コスト台帳は 1 行でタップすると毎月のものへ遷移する', async () => {
    const ledger = await loadLedger();
    const cash = ledger.accounts.find((a) => a.name === '現金')!;
    const bank = ledger.accounts.find((a) => a.name === '預金')!;
    const charge = ledger.accounts.find((a) => a.name === 'チャージ残高')!;
    const invest = ledger.accounts.find((a) => a.name === '投資')!;
    // チャージ残高を「自由に動かせない」印に（例外側だけ movable=false を持つ）。
    await upsertAccount({ ...charge, movable: false });
    await createOpenings([
      { accountId: cash.id, amount: 300000, date: '2000-01-01' },
      { accountId: bank.id, amount: 200000, date: '2000-01-01' },
      { accountId: charge.id, amount: 5000, date: '2000-01-01' },
      { accountId: invest.id, amount: 50000, date: '2000-01-01' },
    ]);
    // 終了日なし = 費用の割り振りなし → 台帳の残存価値は全額 120,000 のまま。
    const expense = ledger.accounts.find((a) => a.role === 'expense-category')!;
    await createContinuousCost({
      name: '洗濯機',
      amount: 120000,
      startDate: todayLocal(),
      expenseAccountId: expense.id,
      creditAccountId: cash.id,
    });

    const onNavigate = vi.fn();
    render(
      <Providers>
        <Breakdown
          section="asset"
          period={{ mode: 'all' }}
          onPeriodChange={() => undefined}
          onDrillDown={() => undefined}
          onNavigate={onNavigate}
        />
      </Providers>,
    );

    // ① 自由に動かせるお金 = 現金 180,000（300,000 − 購入 120,000）+ 預金 200,000。
    await waitFor(() => {
      expect(ui(UI.assetsBreakdown.freeSubtotal)).toHaveTextContent('380,000');
    });
    expect(screen.getByText('自由に動かせるお金')).toBeInTheDocument();
    // ② 自由に動かせないお金 = チャージ残高 5,000。
    expect(screen.getByText('自由に動かせないお金')).toBeInTheDocument();
    expect(ui(UI.assetsBreakdown.fixedSubtotal)).toHaveTextContent('5,000');
    // ③ 投資 = 50,000。
    expect(ui(UI.assetsBreakdown.investmentSubtotal)).toHaveTextContent('50,000');
    // ④ 継続コスト台帳は 1 行（残存価値合計 120,000）。
    const ledgerRow = ui(UI.assetsBreakdown.ledgerRow)!;
    expect(ledgerRow).toHaveTextContent('継続コスト台帳');
    expect(ledgerRow).toHaveTextContent('120,000');
    expect(ui(`${UI.assetsBreakdown.frame}.ledger`)).toHaveTextContent('継続コスト台帳');
    expect(ui(UI.assetsBreakdown.ledgerSubtotal)).toHaveTextContent('120,000');
    expect(document.querySelectorAll(`[data-ui="${UI.assetsBreakdown.ledgerRow}"]`)).toHaveLength(
      1,
    );
    // 全体合計（既存 total）= 380,000 + 5,000 + 50,000 + 120,000。
    expect(ui(UI.assetsBreakdown.total)).toHaveTextContent('555,000');

    // 台帳行タップ → 毎月のもの（内訳は台帳画面で見る）。
    fireEvent.click(ledgerRow);
    expect(onNavigate).toHaveBeenCalledWith('allocations');
  });

  it('自由に動かせないお金・台帳が無ければ、その枠ごと出さない', async () => {
    const ledger = await loadLedger();
    const cash = ledger.accounts.find((a) => a.name === '現金')!;
    await createOpenings([{ accountId: cash.id, amount: 10000, date: '2000-01-01' }]);

    render(
      <Providers>
        <Breakdown
          section="asset"
          period={{ mode: 'all' }}
          onPeriodChange={() => undefined}
          onDrillDown={() => undefined}
          onNavigate={() => undefined}
        />
      </Providers>,
    );

    await waitFor(() => {
      expect(ui(UI.assetsBreakdown.freeSubtotal)).toBeInTheDocument();
    });
    expect(ui(UI.assetsBreakdown.fixedSubtotal)).not.toBeInTheDocument();
    expect(ui(UI.assetsBreakdown.ledgerRow)).not.toBeInTheDocument();
    expect(ui(UI.assetsBreakdown.ledgerSubtotal)).not.toBeInTheDocument();
    expect(screen.queryByText('自由に動かせないお金')).not.toBeInTheDocument();
  });
});

describe('負債の内訳 2 枠', () => {
  it.each([
    { name: 'カードのみ', card: true, loan: false, total: 30000 },
    { name: 'ローンのみ', card: false, loan: true, total: 200000 },
    { name: 'カードとローン', card: true, loan: true, total: 230000 },
    { name: '負債なし', card: false, loan: false, total: 0 },
  ])('$name', async ({ card: showCard, loan: showLoan, total }) => {
    const ledger = await loadLedger();
    const card = ledger.accounts.find((account) => account.role === 'payment-liability')!;
    if (!showCard) {
      await upsertAccount({ ...card, archived: true });
    }
    const loan = {
      id: 'frame-loan',
      name: '住宅ローン',
      type: 'liability' as const,
      role: 'other-liability' as const,
      archived: false,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    };
    if (showLoan) await upsertAccount(loan);

    const openings = [
      ...(showCard ? [{ accountId: card.id, amount: 30000, date: '2000-01-01' }] : []),
      ...(showLoan ? [{ accountId: loan.id, amount: 200000, date: '2000-01-01' }] : []),
    ];
    if (openings.length > 0) await createOpenings(openings);

    render(
      <Providers>
        <Breakdown
          section="liability"
          period={{ mode: 'all' }}
          onPeriodChange={() => undefined}
          onDrillDown={() => undefined}
          onNavigate={() => undefined}
        />
      </Providers>,
    );

    await waitFor(() => {
      expect(ui(UI.liabilitiesBreakdown.total)).toHaveTextContent(
        new Intl.NumberFormat('ja-JP').format(total),
      );
    });
    expect(Boolean(ui(UI.liabilitiesBreakdown.shortTermSubtotal))).toBe(showCard);
    expect(Boolean(ui(UI.liabilitiesBreakdown.longTermSubtotal))).toBe(showLoan);
    if (showCard) {
      expect(ui(UI.liabilitiesBreakdown.shortTermSubtotal)).toHaveTextContent('30,000');
    }
    if (showLoan) {
      expect(ui(UI.liabilitiesBreakdown.longTermSubtotal)).toHaveTextContent('200,000');
    }
    if (showCard && showLoan) {
      const shortTerm = ui(UI.liabilitiesBreakdown.shortTermSubtotal)!;
      const longTerm = ui(UI.liabilitiesBreakdown.longTermSubtotal)!;
      expect(shortTerm.compareDocumentPosition(longTerm) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(
        0,
      );
    }
  });
});
