/*
 * ローン = 月割り台帳の item（v13.13）。旧「ローン = 台帳のルール」の試験を置き換える。
 *
 *  - **区別は item の有無**: ローン item を持つ負債だけが月割り台帳に出る。
 *    クレカ（item を持たない負債）は残高があっても台帳に居ない。
 *  - ローン item は持ち物と同じカード一覧に混在し、同じ検索・並び替えが効く。
 *    行の動詞は「（タップ =）編集」「終了」——ルールの「切替」はローンから消えた（仕様差 3）。
 *  - 資金繰りからの遷移（target.liabilityAccountId）は該当**ローン item カード**へ着地する
 *    （シートは開かない）。item が無い負債を指しても何も起きない（fail-closed）。
 *  - 返済の導出は `借方 負債 / 貸方 返済元` の**直接 1 本**＝資金の出と負債の減りが同日
 *    （旧・台帳経由 2 本の 1 刻み遅れは構造的に解消）。完済日で負債はちょうど 0（厳密一致）。
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

/** 12 回払いのローンを 1 本組む（購入は費用カテゴリへ・完済日 = 12 か月後 inclusive）。 */
async function makeLoan(name = '自動車ローン', amount = 12000000) {
  const { cash, expense } = await seed();
  const created = await createLoanPurchase({
    loanName: name,
    date: todayLocal(),
    description: name,
    amount,
    expenseAccountId: expense.id,
    repaymentSourceAccountId: cash.id,
    repaymentEndDate: addMonthsToDate(todayLocal(), 12),
  });
  return { ...created, cash, expense };
}

describe('台帳の出し分け（ローン item の有無）', () => {
  it('ローン item はカード一覧に出て、残回数・返済元・負債の色を名乗る', async () => {
    const { liability } = await makeLoan();
    await renderReady();
    await waitFor(() => expect(ui(UI.allocations.item)).toBeInTheDocument());

    // ルールは無い（旧形ローンルールの廃止）。
    expect(ui(UI.allocations.recurringList)).not.toBeInTheDocument();
    const card = ui(UI.allocations.item)!;
    expect(card).toHaveTextContent('自動車ローン');
    expect(card).toHaveTextContent('ローン');
    // 残回数は完済日からの導出（今日の断面で 12 回残っている）。
    expect(ui(UI.allocations.loanRemaining)).toHaveTextContent('残り 12 回');
    // 返済元と、月あたり = 先頭刻み（120,000 / 12 = 10,000）。
    expect(card).toHaveTextContent('返済元');
    expect(card).toHaveTextContent('現金');
    // 借入総額は負債の数字色（絶対値のまま・記号なし）。
    const amount = card.querySelector('.row-trailing .list__amount span')!;
    expect(amount).toHaveClass('amount--liability');
    // 行の動詞は「終了」（一括返済）。ルールの「切替」はローンに無い（仕様差 3）。
    expect(ui(UI.allocations.loanSettle)).toBeInTheDocument();
    expect(ui(UI.allocations.recurringSwitch)).not.toBeInTheDocument();
    expect(ui(UI.allocations.archive)).not.toBeInTheDocument();
    // 資金繰りからの着地点として、カードが負債科目を名乗る。
    expect(card).toHaveAttribute('data-account-id', liability.id);
  });

  it('item を持たない負債（クレカ）は残高があっても台帳に出ない', async () => {
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
    // 台帳は空（item もルールも無い）。手動返済だけの負債は資金繰りと勘定科目に居る。
    expect(ui(UI.allocations.item)).not.toBeInTheDocument();
    expect(document.body.textContent).not.toContain(card.name);
  });

  it('ローンは持ち物と同じ検索欄の下に並び、負債の科目名（= ローン名）でも当たる', async () => {
    await makeLoan();
    await renderReady();
    await waitFor(() => expect(ui(UI.allocations.filterFrame)).toBeInTheDocument());

    const search = ui(UI.allocations.search) as HTMLInputElement;
    fireEvent.change(search, { target: { value: '自動車' } });
    await waitFor(() => expect(ui(UI.allocations.item)).toBeInTheDocument());
    expect(ui(UI.allocations.searchCount)).toHaveTextContent('持ち物 1 件');

    fireEvent.change(search, { target: { value: 'ありえない語' } });
    await waitFor(() => expect(ui(UI.allocations.searchEmpty)).toBeInTheDocument());
    expect(ui(UI.allocations.item)).not.toBeInTheDocument();
  });
});

describe('資金繰りからの遷移（target.liabilityAccountId）', () => {
  it('該当のローン item カードへ着地する（シートは開かない）', async () => {
    const { liability } = await makeLoan();
    const { rerender } = await renderReady();
    await waitFor(() => expect(ui(UI.allocations.item)).toBeInTheDocument());

    rerender(
      <View
        period={{ mode: 'date', date: todayLocal() }}
        target={{ liabilityAccountId: liability.id }}
      />,
    );
    await waitFor(() => {
      expect(
        document.querySelector(
          `[data-ui="${UI.allocations.item}"][data-account-id="${liability.id}"]`,
        ),
      ).toBeInTheDocument();
    });
    // カードが目的地。編集シートの類は開かない。
    expect(ui(UI.allocations.loanSheet)).not.toBeInTheDocument();
    expect(ui(UI.allocations.editDialog)).not.toBeInTheDocument();
  });

  it('item を持たない負債を指しても何も開かない（fail-closed）', async () => {
    const { card } = await seed();
    await createOpenings([{ accountId: card.id, amount: 3000000, date: '2000-01-01' }]);
    await renderReady({ target: { liabilityAccountId: card.id } });
    await waitFor(() => expect(ui(UI.allocations.view)).toBeInTheDocument());
    expect(ui(UI.allocations.loanSheet)).not.toBeInTheDocument();
    expect(ui(UI.allocations.editDialog)).not.toBeInTheDocument();
  });
});

describe('シートの動詞（編集 = カードタップ / 終了 = 一括返済）', () => {
  it('カードタップでローンの編集シートが開く（名前・金額・完済日・返済元）', async () => {
    await makeLoan();
    await renderReady();
    const card = await waitFor(() => {
      const found = ui(UI.allocations.item);
      expect(found).toBeInTheDocument();
      return found!;
    });
    fireEvent.click(card);
    await waitFor(() => expect(ui(UI.allocations.loanSheet)).toBeInTheDocument());
    expect(ui(UI.allocations.loanSheetName)).toBeInTheDocument();
    expect(ui(UI.allocations.loanSheetEndDate)).toBeInTheDocument();
    expect(ui(UI.allocations.loanSheetSource)).toBeInTheDocument();
    // 開始日は読み取り専用（借入の仕訳のミラー）+ 仕訳への導線。
    expect(ui(UI.allocations.loanSheetOpenBorrow)).toBeInTheDocument();
  });

  it('「終了」で一括返済シートが開き、既定額 = その日の理論残債が入る', async () => {
    await makeLoan();
    await renderReady();
    await waitFor(() => expect(ui(UI.allocations.loanSettle)).toBeInTheDocument());
    fireEvent.click(ui(UI.allocations.loanSettle)!);
    await waitFor(() => expect(ui(UI.allocations.loanSettleSheet)).toBeInTheDocument());
    // 今日 = 購入当日: 刻みはまだ 1 本も経過していないので理論残債 = 借入総額。
    expect((ui(UI.allocations.loanSettleAmount) as HTMLInputElement).value).toBe('120000');
    expect(ui(UI.allocations.loanSettleSource)).toBeInTheDocument();
  });
});

describe('返済の導出（借方 負債 / 貸方 返済元 の直接 1 本・同日一致）', () => {
  it('刻み日に現金の出と負債の減りが同日に起き、完済日でちょうど 0 になる', async () => {
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
    // 1 回目の刻み日: 現金の出と負債の減りが**同日**（旧・1 刻み遅れの解消）。
    const after1 = balanceAt(addMonthsToDate(today, 1));
    expect(after1.cash).toBe(500000000 - 1000000);
    expect(after1.loan).toBe(12000000 - 1000000);
    // 完済日（購入 + 12 か月 = 最終刻み）で負債はちょうど 0・現金は総額ぶん出ている。
    const atEnd = balanceAt(addMonthsToDate(today, 12));
    expect(atEnd.loan).toBe(0);
    expect(atEnd.cash).toBe(500000000 - 12000000);
  });
});
