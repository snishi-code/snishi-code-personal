/*
 * 資金繰り（v13.4 ③ = 基準日起点 / ④ = 負債行は表示オンリー）:
 *  - 上部は「自由に動かせるお金」1 値（movable=false の現預金は原資に数えない）。
 *  - 起点は **ヘッダーの日付（period）**。表示終了日の入力欄は無い。
 *  - 負債一覧は基準日断面で残高を持つものだけ（開始前は出ない・完済後は消える）。
 *  - 最低点の金額ではなく「最初に 0 を下回る日」を出し、無ければ静かな 1 行。
 *  - グラフの窓は「さらに先へ」で +12 ヶ月ずつ伸び、未来一覧の範囲もそれに従う。
 *  - **負債行は表示オンリー**（v13.4 ④）。行タップは遷移だけで、行き先は v13.6 H4 で
 *    **ルールの有無**に振り分かる: 返済ルールを持つローン → 月割り台帳の該当行
 *    （onOpenAllocations({ liabilityAccountId })）/ 持たない負債 → 勘定科目（onOpenAccount）。
 *    台帳側の出し分けは ui.allocationsLoans.test.tsx が持つ。
 */
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { ToastProvider } from '@snishi/foundation/ui/toast';
import { patchDialogIfNeeded } from '@snishi/foundation/ui/test-utils';
import { LedgerProvider } from '../src/state/store';
import { Cashflow } from '../src/ui/screens/Cashflow';
import {
  createLoanPurchase,
  createOpenings,
  createRepaymentEntries,
  loadLedger,
  upsertAccount,
  upsertEntry,
} from '../src/data/repository';
import { addMonthsToDate } from '../src/domain/allocation';
import { CONTINUOUS_COST_HARD_CAP } from '../src/domain/continuousCost';
import { UI } from '../src/ui-contract';
import { _resetOverlaysForTests } from '../src/ui/overlays';
import { todayLocal } from '../src/util/time';
import type { ReportPeriod } from '../src/domain/reportPeriod';
import type { JournalEntry } from '../src/domain/types';
import './setup';

beforeAll(() => {
  patchDialogIfNeeded();
});

afterEach(() => {
  cleanup();
  _resetOverlaysForTests();
});

function view(
  onEditEntry: (entry: JournalEntry) => void,
  handlers: {
    onOpenAllocations?: (target: unknown) => void;
    onOpenAccount?: (accountId: string) => void;
    onOpenEntry?: (entryId: string) => void;
    period?: ReportPeriod;
  } = {},
) {
  return (
    <ToastProvider>
      <LedgerProvider>
        <Cashflow
          period={handlers.period ?? { mode: 'date', date: todayLocal() }}
          zoom="day"
          onEditEntry={onEditEntry}
          onOpenAllocations={(handlers.onOpenAllocations ?? (() => undefined)) as never}
          onOpenAccount={handlers.onOpenAccount ?? (() => undefined)}
          onOpenEntry={handlers.onOpenEntry ?? (() => undefined)}
        />
      </LedgerProvider>
    </ToastProvider>
  );
}

const ui = (name: string) => document.querySelector(`[data-ui="${name}"]`);

/** 台帳が読めて資金繰りが描かれるまで待つ（どの断面でも必ず出る要素で待つ）。 */
async function ready(): Promise<HTMLElement> {
  return await waitFor(() => {
    const found = ui(UI.cashflow.summary);
    expect(found).toBeInTheDocument();
    return found as HTMLElement;
  });
}

describe('資金繰り', () => {
  it('上部は「自由に動かせるお金」1 値（movable=false は除外・表示終了日の入力欄は無い）', async () => {
    const ledger = await loadLedger();
    const cash = ledger.accounts.find((a) => a.name === '現金')!;
    const charge = ledger.accounts.find((a) => a.name === 'チャージ残高')!;
    await upsertAccount({ ...charge, movable: false });
    await createOpenings([
      { accountId: cash.id, amount: 10000000, date: '2000-01-01' },
      { accountId: charge.id, amount: 700000, date: '2000-01-01' },
    ]);

    render(view(() => undefined));

    const summary = await ready();
    await waitFor(() => {
      expect(summary).toHaveTextContent('100,000');
    });
    expect(summary).toHaveTextContent('自由に動かせるお金');
    expect(summary).not.toHaveTextContent('107,000');
    // 総資金/取り置き/自由資金の 3 段は存在しない（1 値のみ）。
    expect(summary.querySelectorAll('.stat')).toHaveLength(1);
    expect(screen.queryByText('総資金')).not.toBeInTheDocument();
    expect(screen.queryByText('取り置き')).not.toBeInTheDocument();
    // 表示終了日は入力欄ごと引退した（範囲は横スクロールで見る）。
    expect(screen.queryByLabelText('表示終了日')).not.toBeInTheDocument();
  });

  it('自由に動かせるお金はヘッダーの日付の断面（タイムスリップに追従する）', async () => {
    const ledger = await loadLedger();
    const cash = ledger.accounts.find((a) => a.name === '現金')!;
    await createOpenings([{ accountId: cash.id, amount: 10000000, date: '2000-01-01' }]);

    // 初期残高より前の断面では、まだ 0。
    render(view(() => undefined, { period: { mode: 'date', date: '1999-06-01' } }));
    const before = await ready();
    await waitFor(() => {
      expect(before).toHaveTextContent('1999-06-01');
    });
    expect(before).not.toHaveTextContent('100,000');

    cleanup();
    _resetOverlaysForTests();

    render(view(() => undefined, { period: { mode: 'date', date: '2001-01-01' } }));
    const after = await ready();
    await waitFor(() => {
      expect(after).toHaveTextContent('100,000');
    });
    expect(after).toHaveTextContent('2001-01-01');
  });

  it('負債一覧は基準日断面で残高があるものだけ（開始前は出ない・完済後は消える）', async () => {
    const ledger = await loadLedger();
    const cash = ledger.accounts.find((a) => a.name === '現金')!;
    const card = ledger.accounts.find((a) => a.role === 'payment-liability')!;
    await createOpenings([
      { accountId: cash.id, amount: 100000000, date: '2000-01-01' },
      { accountId: card.id, amount: 3000000, date: '2000-01-01' },
    ]);
    // 3 回で完済する返済予定（初回 = 1 ヶ月後）。
    await createRepaymentEntries({
      liabilityAccountId: card.id,
      fromAccountId: cash.id,
      firstDate: addMonthsToDate(todayLocal(), 1),
      total: 3000000,
      count: 3,
      title: 'カードの返済',
    });

    // 今日の断面: 残高 30,000 があるので出る。
    render(view(() => undefined));
    await ready();
    await waitFor(() => {
      expect(ui(UI.cashflow.liabilityRow)).toBeInTheDocument();
    });
    cleanup();
    _resetOverlaysForTests();

    // 初期残高より前の断面: この負債はまだ存在しない。
    render(view(() => undefined, { period: { mode: 'date', date: '1999-06-01' } }));
    await ready();
    await waitFor(() => {
      expect(screen.getByText('この日の時点で残高のある負債はありません。')).toBeInTheDocument();
    });
    expect(ui(UI.cashflow.liabilityRow)).not.toBeInTheDocument();
    cleanup();
    _resetOverlaysForTests();

    // 完済後の断面: 残高 0 なので消える（返済予定が残っていても行は作らない）。
    render(
      view(() => undefined, {
        period: { mode: 'date', date: addMonthsToDate(todayLocal(), 6) },
      }),
    );
    await ready();
    await waitFor(() => {
      expect(screen.getByText('この日の時点で残高のある負債はありません。')).toBeInTheDocument();
    });
    expect(ui(UI.cashflow.liabilityRow)).not.toBeInTheDocument();
  });

  it('ルールを持たない負債（クレカ）はタップで勘定科目へ渡す', async () => {
    const ledger = await loadLedger();
    const cash = ledger.accounts.find((a) => a.name === '現金')!;
    const card = ledger.accounts.find((a) => a.role === 'payment-liability')!;
    await createOpenings([
      { accountId: cash.id, amount: 10000000, date: '2000-01-01' },
      { accountId: card.id, amount: 3000000, date: '2000-01-01' },
    ]);
    const firstDate = addMonthsToDate(todayLocal(), 1);
    // 手動の返済（未来日付の実仕訳）だけを持つ負債 = 既存データと同じ形。
    await createRepaymentEntries({
      liabilityAccountId: card.id,
      fromAccountId: cash.id,
      firstDate,
      total: 3000000,
      count: 3,
      title: 'カードの返済',
    });

    const onEditEntry = vi.fn();
    const onOpenAllocations = vi.fn();
    const onOpenAccount = vi.fn();
    render(view(onEditEntry, { onOpenAllocations, onOpenAccount }));

    const row = await waitFor(() => {
      const found = ui(UI.cashflow.liabilityRow);
      expect(found).toBeInTheDocument();
      return found!;
    });
    // 表示情報は残す（残高・次回支払日・残回数）。
    expect(row).toHaveTextContent('30,000');
    expect(row).toHaveTextContent(`次回支払日: ${firstDate}`);
    expect(row).toHaveTextContent('残り 3 回');
    // 読み上げ名は行き先を名乗る。タップ目標は 44px（.list__row-btn の min-height）。
    expect(row).toHaveAttribute('aria-label', `${card.name} を勘定科目で開く`);

    fireEvent.click(row);
    expect(onOpenAccount).toHaveBeenCalledWith(card.id);
    expect(onOpenAllocations).not.toHaveBeenCalled();
    // 遷移だけ。この画面は書込フォームを開かない（返済シート・展開トグルは撤去済み）。
    expect(onEditEntry).not.toHaveBeenCalled();
    expect(document.querySelector('[data-ui="allocations.repay.sheet"]')).toBeNull();
    expect(screen.queryByText('登録済みの返済')).not.toBeInTheDocument();
  });

  it('返済ルールを持つローンはタップで月割り台帳の該当行へ渡す', async () => {
    const ledger = await loadLedger();
    const cash = ledger.accounts.find((a) => a.name === '現金')!;
    await createOpenings([{ accountId: cash.id, amount: 100000000, date: '2000-01-01' }]);
    const { liability } = await createLoanPurchase({
      loanName: '自動車ローン',
      date: todayLocal(),
      description: '自動車',
      amount: 12000000,
      expenseAccountId: ledger.accounts.find((a) => a.role === 'expense-category')!.id,
      repaymentFromAccountId: cash.id,
      repaymentEndDate: addMonthsToDate(todayLocal(), 13),
    });

    const onOpenAllocations = vi.fn();
    const onOpenAccount = vi.fn();
    render(view(() => undefined, { onOpenAllocations, onOpenAccount }));

    const row = await waitFor(() => {
      const found = document.querySelector<HTMLElement>(
        `[data-ui="${UI.cashflow.liabilityRow}"][data-account-id="${liability.id}"]`,
      );
      expect(found).toBeInTheDocument();
      return found!;
    });
    expect(row).toHaveAttribute('aria-label', '自動車ローン を月割り台帳で開く');
    fireEvent.click(row);
    expect(onOpenAllocations).toHaveBeenCalledWith({ liabilityAccountId: liability.id });
    expect(onOpenAccount).not.toHaveBeenCalled();
  });
});

describe('最初に 0 を下回る日', () => {
  it('下回る予定が無ければ、地平の年まで大丈夫だと静かに伝える（警告色を使わない）', async () => {
    const ledger = await loadLedger();
    const cash = ledger.accounts.find((a) => a.name === '現金')!;
    await createOpenings([{ accountId: cash.id, amount: 10000000, date: '2000-01-01' }]);

    render(view(() => undefined));
    await ready();

    const note = await waitFor(() => {
      const found = ui(UI.cashflow.shortfall);
      expect(found).toBeInTheDocument();
      return found!;
    });
    const horizonYear = CONTINUOUS_COST_HARD_CAP.slice(0, 4);
    await waitFor(() => {
      expect(note).toHaveTextContent(
        `${horizonYear}年まで、自由に動かせるお金が 0 を下回る予定はありません。`,
      );
    });
    // 静かな 1 行 = 警告バナーではない。
    expect(note).not.toHaveClass('banner');
    expect(note.getAttribute('role')).toBeNull();
  });

  it('基準日以降に足りなくなるなら、その日を名指しで出す', async () => {
    const ledger = await loadLedger();
    const cash = ledger.accounts.find((a) => a.name === '現金')!;
    const card = ledger.accounts.find((a) => a.role === 'payment-liability')!;
    await createOpenings([
      { accountId: cash.id, amount: 10000000, date: '2000-01-01' },
      { accountId: card.id, amount: 50000000, date: '2000-01-01' },
    ]);
    // 残高 100,000 に対して 500,000 を 1 回で返す = その日に足りなくなる。
    const dueDate = addMonthsToDate(todayLocal(), 2);
    await createRepaymentEntries({
      liabilityAccountId: card.id,
      fromAccountId: cash.id,
      firstDate: dueDate,
      total: 50000000,
      count: 1,
      title: 'カードの返済',
    });

    render(view(() => undefined));
    await ready();

    const banner = await waitFor(() => {
      const found = ui(UI.cashflow.shortfall);
      expect(found).toHaveTextContent(`${dueDate} に自由に動かせるお金が 0 を下回る見込みです。`);
      return found!;
    });
    expect(banner).toHaveClass('banner');
  });

  it('基準日より前に下回っていてもスルーする（過去の谷は基準日の残高に織り込み済み）', async () => {
    const ledger = await loadLedger();
    const cash = ledger.accounts.find((a) => a.name === '現金')!;
    const card = ledger.accounts.find((a) => a.role === 'payment-liability')!;
    const income = ledger.accounts.find((a) => a.role === 'income-category')!;
    await createOpenings([
      { accountId: cash.id, amount: 10000000, date: '2000-01-01' },
      { accountId: card.id, amount: 50000000, date: '2000-01-01' },
    ]);
    // +2 ヶ月で 100,000 → −400,000 まで沈み、+3 ヶ月の入金で 500,000 へ戻る。
    const dueDate = addMonthsToDate(todayLocal(), 2);
    await createRepaymentEntries({
      liabilityAccountId: card.id,
      fromAccountId: cash.id,
      firstDate: dueDate,
      total: 50000000,
      count: 1,
      title: 'カードの返済',
    });
    const recoveryDate = addMonthsToDate(todayLocal(), 3);
    const timestamp = '2026-01-01T00:00:00.000Z';
    await upsertEntry({
      id: 'recovery-income',
      date: recoveryDate,
      description: '立て直しの入金',
      kind: 'normal',
      lines: [
        { accountId: cash.id, side: 'debit', amount: 90000000 },
        { accountId: income.id, side: 'credit', amount: 90000000 },
      ],
      metadata: { inputMode: 'income' },
      createdAt: timestamp,
      updatedAt: timestamp,
    });

    // 谷も立て直しも済んだ後ろへタイムスリップする = 下回りはもう「過去」なので出さない。
    render(
      view(() => undefined, {
        period: { mode: 'date', date: addMonthsToDate(todayLocal(), 4) },
      }),
    );
    const summary = await ready();
    await waitFor(() => {
      expect(summary).toHaveTextContent('500,000');
    });

    const horizonYear = CONTINUOUS_COST_HARD_CAP.slice(0, 4);
    expect(ui(UI.cashflow.shortfall)).toHaveTextContent(
      `${horizonYear}年まで、自由に動かせるお金が 0 を下回る予定はありません。`,
    );
  });
});

describe('グラフの窓（基準日起点・右へ +12 ヶ月ずつ）', () => {
  it('初期は 12 ヶ月ぶん。「さらに先へ」で伸ばすと、その先の予定も一覧に入る', async () => {
    const ledger = await loadLedger();
    const cash = ledger.accounts.find((a) => a.name === '現金')!;
    const card = ledger.accounts.find((a) => a.role === 'payment-liability')!;
    await createOpenings([
      { accountId: cash.id, amount: 100000000, date: '2000-01-01' },
      { accountId: card.id, amount: 3000000, date: '2000-01-01' },
    ]);
    // 初期の窓（12 ヶ月）の外に置く返済。
    const farDate = addMonthsToDate(todayLocal(), 18);
    await createRepaymentEntries({
      liabilityAccountId: card.id,
      fromAccountId: cash.id,
      firstDate: farDate,
      total: 3000000,
      count: 1,
      title: '遠い返済',
    });

    render(view(() => undefined));
    await ready();

    // 窓の外なので未来一覧には出ない。
    await waitFor(() => {
      expect(ui(UI.cashflow.chartExtend)).toBeInTheDocument();
    });
    expect(screen.queryByText('遠い返済')).not.toBeInTheDocument();

    fireEvent.click(ui(UI.cashflow.chartExtend)!);

    // +12 ヶ月（= 基準日 +24 ヶ月）まで伸びたので、18 ヶ月後の返済が範囲に入る。
    await waitFor(() => {
      expect(screen.getByText('遠い返済')).toBeInTheDocument();
    });
    const list = ui(UI.cashflow.futureList);
    expect(list).toHaveTextContent(farDate);
  });

  it('地平（2100 年）を基準日にすると、もう伸ばせないことを伝える', async () => {
    const ledger = await loadLedger();
    const cash = ledger.accounts.find((a) => a.name === '現金')!;
    await createOpenings([{ accountId: cash.id, amount: 10000000, date: '2000-01-01' }]);

    render(
      view(() => undefined, {
        period: { mode: 'date', date: CONTINUOUS_COST_HARD_CAP },
      }),
    );
    await ready();

    await waitFor(() => {
      expect(
        screen.getByText(
          `${CONTINUOUS_COST_HARD_CAP.slice(0, 4)}年（見通せる上限）まで表示しています。`,
        ),
      ).toBeInTheDocument();
    });
    expect(ui(UI.cashflow.chartExtend)).not.toBeInTheDocument();
  });
});

describe('将来の入出金の行タップ（entryOpenPlan の単一正本）', () => {
  it('保存された返済仕訳は編集シート、定期ルールの投影は毎月のもの（ルール）へ', async () => {
    const ledger = await loadLedger();
    const bank = ledger.accounts.find((a) => a.name === '預金')!;
    const card = ledger.accounts.find((a) => a.role === 'payment-liability')!;
    await createOpenings([
      { accountId: bank.id, amount: 50000000, date: '2000-01-01' },
      { accountId: card.id, amount: 3000000, date: '2000-01-01' },
    ]);
    // 保存された将来の返済（実仕訳）。
    await createRepaymentEntries({
      title: 'カードの返済',
      liabilityAccountId: card.id,
      fromAccountId: bank.id,
      total: 3000000,
      count: 1,
      firstDate: addMonthsToDate(todayLocal(), 1),
    });
    // 未来へ投影される定期ルール（支払い元 = 預金なので購入行が資金繰りへ出る）。
    const expense = ledger.accounts.find((a) => a.role === 'expense-category')!;
    const { createRecurringRule } = await import('../src/data/repository');
    await createRecurringRule({
      name: '家賃ルール',
      amount: 20000000,
      dayOfMonth: 25,
      debitAccountId: expense.id,
      creditAccountId: bank.id,
      startMonth: todayLocal().slice(0, 7),
      startDate: todayLocal(),
    });

    const onEditEntry = vi.fn();
    const onOpenAllocations = vi.fn();
    render(view(onEditEntry, { onOpenAllocations }));
    const rows = await screen.findAllByRole('button', { name: /カードの返済|家賃ルール/ });
    const repayRow = rows.find((r) => r.textContent?.includes('カードの返済'))!;
    const ruleRow = rows.find((r) => r.textContent?.includes('家賃ルール'))!;

    fireEvent.click(repayRow);
    expect(onEditEntry).toHaveBeenCalledTimes(1);

    fireEvent.click(ruleRow);
    expect(onOpenAllocations).toHaveBeenCalledWith(
      expect.objectContaining({ ruleId: expect.any(String) }),
    );
  });
});
