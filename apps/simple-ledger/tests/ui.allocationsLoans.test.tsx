/*
 * ローン = 台帳のルール（v13.6 H4）。旧「支払用負債」セクションの試験を置き換える。
 *
 *  - **区別はルールの有無**: 計上先が負債科目のルール（= ローン）だけが月割り台帳に出る。
 *    クレカ（ルールを持たない負債）は残高があっても台帳に居ない ← mutation check ①
 *  - ローン行は持ち物・定期と同じ一覧に混在し、同じ検索・並び替えが効く。
 *  - 資金繰りからの遷移（target.liabilityAccountId）は該当**ルール行**へ着地する
 *    （シートは開かない）。ルールが無い負債を指しても何も起きない（fail-closed）。
 *  - 返済ルールの導出は `借方 負債 / 貸方 返済元` の月次刻み（合成後）＝残高が毎月減る。
 */
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import { ToastProvider } from '@snishi/foundation/ui/toast';
import { patchDialogIfNeeded } from '@snishi/foundation/ui/test-utils';
import { LedgerProvider, useLedger } from '../src/state/store';
import { Allocations, type AllocationsTarget } from '../src/ui/screens/Allocations';
import {
  createLoanPurchase,
  createOpenings,
  createRepaymentEntries,
  loadLedger,
} from '../src/data/repository';
import { addMonthsToDate } from '../src/domain/allocation';
import { deriveBalanceSheet } from '../src/domain/accounting';
import { displayEntriesResultForAsOf } from '../src/domain/reportEntries';
import { UI } from '../src/ui-contract';
import { _resetOverlaysForTests } from '../src/ui/overlays';
import { todayLocal } from '../src/util/time';
import type { ReportPeriod } from '../src/domain/reportPeriod';
import './setup';

beforeAll(() => {
  patchDialogIfNeeded();
});

afterEach(() => {
  cleanup();
  _resetOverlaysForTests();
});

const ui = (name: string) => document.querySelector<HTMLElement>(`[data-ui="${name}"]`);
const all = (name: string) => [...document.querySelectorAll<HTMLElement>(`[data-ui="${name}"]`)];

function View({ period, target }: { period: ReportPeriod; target?: AllocationsTarget | null }) {
  return (
    <ToastProvider>
      <LedgerProvider>
        <Ready period={period} target={target ?? null} />
      </LedgerProvider>
    </ToastProvider>
  );
}

function Ready({ period, target }: { period: ReportPeriod; target: AllocationsTarget | null }) {
  const { status } = useLedger();
  return status === 'ready' ? (
    <Allocations period={period} onEditEntry={() => undefined} target={target} />
  ) : null;
}

async function renderReady(options: { period?: ReportPeriod; target?: AllocationsTarget } = {}) {
  const view = render(
    <View
      period={options.period ?? { mode: 'date', date: todayLocal() }}
      target={options.target ?? null}
    />,
  );
  await waitFor(() => {
    expect(ui(UI.allocations.view)).toBeInTheDocument();
  });
  return view;
}

/** 現金（潤沢）と費用カテゴリを持つ台帳。 */
async function seed() {
  const ledger = await loadLedger();
  const cash = ledger.accounts.find((a) => a.name === '現金')!;
  const card = ledger.accounts.find((a) => a.role === 'payment-liability')!;
  const expense = ledger.accounts.find((a) => a.role === 'expense-category')!;
  await createOpenings([{ accountId: cash.id, amount: 500000000, date: '2000-01-01' }]);
  return { cash, card, expense };
}

/** 12 回払いのローンを 1 本組む（購入は費用カテゴリへ）。 */
async function makeLoan(name = '自動車ローン', amount = 12000000) {
  const { cash, expense } = await seed();
  const created = await createLoanPurchase({
    loanName: name,
    date: todayLocal(),
    description: name,
    amount,
    expenseAccountId: expense.id,
    repaymentFromAccountId: cash.id,
    // 初回 = 1 ヶ月後・12 回 → 排他的終了日 = 13 ヶ月後。
    repaymentEndDate: addMonthsToDate(todayLocal(), 13),
  });
  return { ...created, cash, expense };
}

describe('台帳の出し分け（ルールの有無）', () => {
  it('ルールを持つローンは一覧に出て、残回数と負債の色を名乗る', async () => {
    const { rule } = await makeLoan();
    await renderReady();
    await waitFor(() => expect(ui(UI.allocations.recurringList)).toBeInTheDocument());

    const rows = all(UI.allocations.recurringList)[0]!.querySelectorAll('li');
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row).toHaveTextContent('自動車ローン');
    // 種別は形からの導出（計上先が負債 = ローン）。
    expect(row).toHaveTextContent('ローン（返済）');
    // 残回数は終了日からの導出（今日の断面で 12 回残っている）。
    expect(ui(UI.allocations.loanRemaining)).toHaveTextContent('残り 12 回');
    // 月額 = 120,000 / 12。負債の数字色（絶対値のまま・記号なし）。
    const amount = row.querySelector('.row-trailing .list__amount span')!;
    expect(amount).toHaveClass('amount--liability');
    expect(amount.textContent).toContain('10,000');
    // 資金繰りからの着地点として、行が負債科目を名乗る。
    expect(row).toHaveAttribute('data-account-id', rule.spreadExpenseAccountId);
  });

  it('ルールを持たない負債（クレカ）は残高があっても台帳に出ない', async () => {
    const { cash, card } = await seed();
    await createOpenings([{ accountId: card.id, amount: 3000000, date: '2000-01-01' }]);
    await createRepaymentEntries({
      liabilityAccountId: card.id,
      fromAccountId: cash.id,
      firstDate: addMonthsToDate(todayLocal(), 1),
      total: 3000000,
      count: 3,
      title: 'カードの返済',
    });

    await renderReady();
    await waitFor(() => expect(ui(UI.allocations.view)).toBeInTheDocument());
    // 台帳は空（ルールも持ち物も無い）。手動返済だけの負債は資金繰りと勘定科目に居る。
    expect(ui(UI.allocations.recurringList)).not.toBeInTheDocument();
    expect(document.body.textContent).not.toContain(card.name);
  });

  it('ローンは持ち物・定期と同じ検索欄・同じ並び替えの下に並ぶ', async () => {
    await makeLoan();
    await renderReady();
    await waitFor(() => expect(ui(UI.allocations.filterFrame)).toBeInTheDocument());

    // 検索は負債の科目名（= ローン名）でも当たる。
    const search = ui(UI.allocations.search) as HTMLInputElement;
    fireEvent.change(search, { target: { value: '自動車' } });
    await waitFor(() => expect(ui(UI.allocations.recurringList)).toBeInTheDocument());
    expect(ui(UI.allocations.searchCount)).toHaveTextContent('くり返し記帳 1 件');

    fireEvent.change(search, { target: { value: 'ありえない語' } });
    await waitFor(() => expect(ui(UI.allocations.searchEmpty)).toBeInTheDocument());
    expect(ui(UI.allocations.recurringList)).not.toBeInTheDocument();
  });
});

describe('資金繰りからの遷移（target.liabilityAccountId）', () => {
  it('該当のルール行へ着地する（シートは開かない）', async () => {
    const { liability } = await makeLoan();
    const { rerender } = await renderReady();
    await waitFor(() => expect(ui(UI.allocations.recurringList)).toBeInTheDocument());

    rerender(
      <View
        period={{ mode: 'date', date: todayLocal() }}
        target={{ liabilityAccountId: liability.id }}
      />,
    );
    await waitFor(() => {
      expect(document.querySelector(`li[data-account-id="${liability.id}"]`)).toBeInTheDocument();
    });
    // 行が目的地。編集シートの類は開かない。
    expect(ui(UI.allocations.recurringSheet)).not.toBeInTheDocument();
    expect(ui(UI.allocations.editDialog)).not.toBeInTheDocument();
  });

  it('ルールを持たない負債を指しても何も開かない（fail-closed）', async () => {
    const { card } = await seed();
    await createOpenings([{ accountId: card.id, amount: 3000000, date: '2000-01-01' }]);
    await renderReady({ target: { liabilityAccountId: card.id } });
    await waitFor(() => expect(ui(UI.allocations.view)).toBeInTheDocument());
    expect(ui(UI.allocations.recurringSheet)).not.toBeInTheDocument();
    expect(ui(UI.allocations.editDialog)).not.toBeInTheDocument();
  });
});

describe('返済ルールの導出（借方 負債 / 貸方 返済元 の月次刻み）', () => {
  /*
   * 全ルールが月割り台帳を経由する（v13.1 c 案）ため、1 回の返済は 2 本に分かれる:
   *  - 返済日: `借方 台帳 / 貸方 返済元`（現金が出ていく）
   *  - その 1 刻み後: `借方 負債 / 貸方 台帳`（負債が減る）
   * = 負債の減りは現金の出より 1 刻み遅れ、差額は台帳が持つ（純資産は常に正しい）。
   * 最後の刻みが落ちる日 = ルールの排他的終了日 = 完済日。
   */
  it('返済日に現金が出て、1 刻み後に負債が減る（完済日 = 終了日）', async () => {
    const { liability, cash } = await makeLoan();
    const ledger = await loadLedger();
    const balanceAt = (asOf: string) => {
      const entries = displayEntriesResultForAsOf(ledger, asOf).entries;
      const bs = deriveBalanceSheet(ledger.accounts, entries, asOf);
      return {
        loan: bs.liabilities.find((l) => l.account.id === liability.id)?.balance ?? 0,
        cash: bs.assets.find((a) => a.account.id === cash.id)?.balance ?? 0,
      };
    };
    const today = todayLocal();
    // 購入当日: 借入額まるごと負債（現金は動かない）。
    expect(balanceAt(today).loan).toBe(12000000);
    expect(balanceAt(today).cash).toBe(500000000);
    // 1 回目の返済日: 現金は出たが、負債の減りはまだ台帳の中（1 刻み遅れ）。
    const after1 = balanceAt(addMonthsToDate(today, 1));
    expect(after1.cash).toBe(500000000 - 1000000);
    expect(after1.loan).toBe(12000000);
    // その 1 刻み後に負債が 1 回ぶん減る。
    expect(balanceAt(addMonthsToDate(today, 2)).loan).toBe(12000000 - 1000000);
    // 12 回で現金は出きり、その 1 刻み後（= 排他的終了日）に負債がちょうど 0 になる。
    const after12 = balanceAt(addMonthsToDate(today, 12));
    expect(after12.cash).toBe(500000000 - 12000000);
    expect(balanceAt(addMonthsToDate(today, 13)).loan).toBe(0);
  });
});
