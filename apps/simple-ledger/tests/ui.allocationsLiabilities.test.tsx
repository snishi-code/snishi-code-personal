/*
 * 月割り台帳の「支払用負債」（v13.4 ④ で資金繰りから移設した返済予定の登録・編集）:
 *  - 行はヘッダーの断面で残高 ≠ 0 の payment/other-liability だけ（開始前は出ない・完済後は消える）。
 *    資金繰りと同じ domain の単一正本（liabilityScheduleRows）を通す。
 *  - 行の右列 = 上段 残高 / 下段「返済を登録」（tonal）。押すと返済シートが開き、
 *    未来日付の実仕訳 N 本を作る。
 *  - 行の展開 = 登録済みの返済（断面より後の保存仕訳・借方 = その負債）を日付昇順で表示し、
 *    タップで仕訳の編集シート（onEditEntry 経路）を開く。
 *  - 資金繰りからの遷移（target.liabilityAccountId）は、シートではなく**該当行**へ着地して展開する。
 */
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { ToastProvider } from '@snishi/foundation/ui/toast';
import { patchDialogIfNeeded } from '@snishi/foundation/ui/test-utils';
import { LedgerProvider, useLedger } from '../src/state/store';
import { Allocations, type AllocationsTarget } from '../src/ui/screens/Allocations';
import {
  createOpenings,
  createRepaymentEntries,
  loadLedger,
  upsertAccount,
} from '../src/data/repository';
import { addMonthsToDate, MONTHLY_AMOUNTS_HARD_CAP } from '../src/domain/allocation';
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

const ui = (name: string) => document.querySelector<HTMLElement>(`[data-ui="${name}"]`);
const all = (name: string) => [...document.querySelectorAll<HTMLElement>(`[data-ui="${name}"]`)];

function View({
  period,
  onEditEntry,
  target,
}: {
  period: ReportPeriod;
  onEditEntry?: (entry: JournalEntry) => void;
  target?: AllocationsTarget | null;
}) {
  return (
    <ToastProvider>
      <LedgerProvider>
        <Ready
          period={period}
          onEditEntry={onEditEntry ?? (() => undefined)}
          target={target ?? null}
        />
      </LedgerProvider>
    </ToastProvider>
  );
}

function Ready({
  period,
  onEditEntry,
  target,
}: {
  period: ReportPeriod;
  onEditEntry: (entry: JournalEntry) => void;
  target: AllocationsTarget | null;
}) {
  const { status } = useLedger();
  return status === 'ready' ? (
    <Allocations period={period} onEditEntry={onEditEntry} target={target} />
  ) : null;
}

async function renderReady(
  options: {
    period?: ReportPeriod;
    onEditEntry?: (entry: JournalEntry) => void;
    target?: AllocationsTarget | null;
  } = {},
) {
  const view = render(
    <View
      period={options.period ?? { mode: 'date', date: todayLocal() }}
      {...(options.onEditEntry ? { onEditEntry: options.onEditEntry } : {})}
      target={options.target ?? null}
    />,
  );
  await waitFor(() => {
    expect(ui(UI.allocations.view)).toBeInTheDocument();
  });
  return view;
}

/** 現金 + カード（残高あり）だけの台帳。返済予定は呼び出し側が足す。 */
async function seedCard(cardOpening = 3000000) {
  const ledger = await loadLedger();
  const cash = ledger.accounts.find((a) => a.name === '現金')!;
  const card = ledger.accounts.find((a) => a.role === 'payment-liability')!;
  await createOpenings([
    { accountId: cash.id, amount: 100000000, date: '2000-01-01' },
    { accountId: card.id, amount: cardOpening, date: '2000-01-01' },
  ]);
  return { cash, card };
}

describe('支払用負債の一覧（基準日断面）', () => {
  it('残高があるものだけを出す（開始前は出ない・完済後は消える）', async () => {
    const { cash, card } = await seedCard();
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
    await renderReady();
    await waitFor(() => {
      expect(ui(UI.allocations.liabilityRow)).toBeInTheDocument();
    });
    expect(ui(UI.allocations.liabilityRow)).toHaveTextContent(card.name);
    cleanup();
    _resetOverlaysForTests();

    // 初期残高より前の断面: この負債はまだ存在しない。
    await renderReady({ period: { mode: 'date', date: '1999-06-01' } });
    await waitFor(() => {
      expect(ui(UI.allocations.liabilityRow)).not.toBeInTheDocument();
    });
    expect(screen.queryByText('支払用負債')).not.toBeInTheDocument();
    cleanup();
    _resetOverlaysForTests();

    // 完済後の断面: 残高 0 なので消える（返済予定が残っていても行は作らない）。
    await renderReady({ period: { mode: 'date', date: addMonthsToDate(todayLocal(), 6) } });
    await waitFor(() => {
      expect(ui(UI.allocations.list)).not.toBeInTheDocument();
    });
    expect(ui(UI.allocations.liabilityRow)).not.toBeInTheDocument();
  });

  it('行は残高と予定（次回支払日・残回数）を出し、予定が無い行は登録を促す', async () => {
    const { cash, card } = await seedCard();
    const firstDate = addMonthsToDate(todayLocal(), 1);
    await createRepaymentEntries({
      liabilityAccountId: card.id,
      fromAccountId: cash.id,
      firstDate,
      total: 3000000,
      count: 3,
      title: 'カードの返済',
    });

    await renderReady();
    const row = await waitFor(() => {
      const found = ui(UI.allocations.liabilityRow);
      expect(found).toBeInTheDocument();
      return found!;
    });
    expect(row).toHaveTextContent('30,000');
    expect(row).toHaveTextContent(`次回支払日: ${firstDate}`);
    expect(row).toHaveTextContent('残り 3 回');
    // 動詞は右列の tonal ボタン（読み上げ名に科目名を含む）。
    const add = ui(UI.allocations.repayAdd)!;
    expect(add).toHaveClass('btn--tonal');
    expect(add).toHaveAttribute('aria-label', `返済を登録: ${card.name}`);
  });
});

describe('返済予定の登録（移設した返済シート）', () => {
  it('「返済を登録」から未来日付の返済仕訳を作り、行の予定に反映される', async () => {
    const { card } = await seedCard();
    await renderReady();
    await waitFor(() => expect(ui(UI.allocations.repayAdd)).toBeInTheDocument());
    fireEvent.click(ui(UI.allocations.repayAdd)!);

    const sheet = await waitFor(() => {
      const found = ui(UI.allocations.repaySheet);
      expect(found).toBeInTheDocument();
      return found!;
    });
    // 既定の金額 = いまの残高（全額）。
    expect((ui(UI.allocations.repayAmount) as HTMLInputElement).value).toBe('30000');
    const firstDate = addMonthsToDate(todayLocal(), 1);
    fireEvent.change(ui(UI.allocations.repayDate)!, { target: { value: firstDate } });
    fireEvent.change(ui(UI.allocations.repayCount)!, { target: { value: '3' } });
    expect(sheet).toHaveTextContent('月あたり約');
    fireEvent.click(ui(UI.allocations.repaySave)!);

    await waitFor(async () => {
      const saved = (await loadLedger()).journalEntries.filter((e) =>
        e.lines.some((l) => l.side === 'debit' && l.accountId === card.id && e.date >= firstDate),
      );
      expect(saved).toHaveLength(3);
    });
    // 画面の行も予定（残り 3 回）を名乗る。
    await waitFor(() => {
      expect(ui(UI.allocations.liabilityRow)).toHaveTextContent('残り 3 回');
    });
  });

  it('返済回数が hard cap を超えたら、巨大配列を作らず画面上で理由を示す', async () => {
    const ledger = await loadLedger();
    const cash = ledger.accounts.find((a) => a.name === '現金')!;
    const card = ledger.accounts.find((a) => a.role === 'payment-liability')!;
    await createOpenings([
      { accountId: cash.id, amount: 1_000_000, date: '2000-01-01' },
      { accountId: card.id, amount: MONTHLY_AMOUNTS_HARD_CAP + 1, date: '2000-01-01' },
    ]);

    await renderReady();
    await waitFor(() => expect(ui(UI.allocations.repayAdd)).toBeInTheDocument());
    fireEvent.click(ui(UI.allocations.repayAdd)!);
    await waitFor(() => expect(ui(UI.allocations.repayCount)).toBeInTheDocument());
    fireEvent.change(ui(UI.allocations.repayCount)!, {
      target: { value: String(MONTHLY_AMOUNTS_HARD_CAP + 1) },
    });
    fireEvent.click(ui(UI.allocations.repaySave)!);

    expect(await screen.findByRole('alert')).toHaveTextContent(
      `返済回数は 1〜${MONTHLY_AMOUNTS_HARD_CAP} の整数で入力してください。`,
    );
  });

  it('返済口座・返済日を設定した科目では、シートの既定値がその設定になる', async () => {
    const { cash, card } = await seedCard();
    await upsertAccount({ ...card, repaymentAccountId: cash.id, repaymentDay: 27 });

    await renderReady();
    await waitFor(() => expect(ui(UI.allocations.repayAdd)).toBeInTheDocument());
    // 行にも設定が出る（編集する画面なので設定の読み取りはここに置く）。
    expect(ui(UI.allocations.liabilityRow)).toHaveTextContent(`返済口座: ${cash.name}・毎月27日`);
    fireEvent.click(ui(UI.allocations.repayAdd)!);
    await waitFor(() => expect(ui(UI.allocations.repayFrom)).toBeInTheDocument());
    expect((ui(UI.allocations.repayFrom) as HTMLSelectElement).value).toBe(cash.id);
    // 支払日の既定 = 今日より後の直近の 27 日（書込フォームの日付だけが today 規約の例外）。
    expect((ui(UI.allocations.repayDate) as HTMLInputElement).value.slice(8, 10)).toBe('27');
  });
});

describe('登録済みの返済（行の展開）', () => {
  it('日付昇順に出し、タップで仕訳の編集シートへ渡す', async () => {
    const { cash, card } = await seedCard();
    const firstDate = addMonthsToDate(todayLocal(), 1);
    await createRepaymentEntries({
      liabilityAccountId: card.id,
      fromAccountId: cash.id,
      firstDate,
      total: 3000000,
      count: 3,
      title: 'カードの返済',
    });

    const onEditEntry = vi.fn();
    await renderReady({ onEditEntry });

    const toggle = await waitFor(() => {
      const found = ui(UI.allocations.repaymentsToggle);
      expect(found).toBeInTheDocument();
      return found!;
    });
    expect(toggle).toHaveTextContent('登録済みの返済');
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'true');

    const rows = all(UI.allocations.repaymentRow);
    expect(rows).toHaveLength(3);
    // 日付昇順（初回 = firstDate）+ 金額（30,000 を 3 回 = 各 10,000）。
    expect(rows[0]).toHaveTextContent(firstDate);
    expect(rows[0]).toHaveTextContent('10,000');
    const dates = rows.map((row) => row.textContent ?? '');
    expect(dates).toEqual([...dates].sort());

    fireEvent.click(rows[0]!);
    expect(onEditEntry).toHaveBeenCalledTimes(1);
    const entry = onEditEntry.mock.calls[0]![0] as JournalEntry;
    expect(entry.date).toBe(firstDate);
    expect(
      entry.lines.some(
        (l) => l.side === 'debit' && l.accountId === card.id && l.amount === 1000000,
      ),
    ).toBe(true);
  });
});

describe('資金繰りからの遷移（target.liabilityAccountId）', () => {
  it('該当の負債行を展開する（シートは開かない）', async () => {
    const { cash, card } = await seedCard();
    await createRepaymentEntries({
      liabilityAccountId: card.id,
      fromAccountId: cash.id,
      firstDate: addMonthsToDate(todayLocal(), 1),
      total: 3000000,
      count: 3,
      title: 'カードの返済',
    });

    const { rerender } = await renderReady();
    await waitFor(() => expect(ui(UI.allocations.repaymentsToggle)).toBeInTheDocument());
    expect(ui(UI.allocations.repaymentsToggle)).toHaveAttribute('aria-expanded', 'false');

    rerender(
      <View
        period={{ mode: 'date', date: todayLocal() }}
        target={{ liabilityAccountId: card.id }}
      />,
    );
    await waitFor(() => {
      expect(ui(UI.allocations.repaymentsToggle)).toHaveAttribute('aria-expanded', 'true');
    });
    expect(all(UI.allocations.repaymentRow)).toHaveLength(3);
    // 負債の遷移は行が目的地。編集シートの類は開かない。
    expect(ui(UI.allocations.repaySheet)).not.toBeInTheDocument();
    expect(ui(UI.allocations.editDialog)).not.toBeInTheDocument();
    expect(ui(UI.allocations.recurringSheet)).not.toBeInTheDocument();
  });

  it('その断面に行が無い負債（完済済み）を指しても、何も開かない', async () => {
    const { cash, card } = await seedCard();
    await createRepaymentEntries({
      liabilityAccountId: card.id,
      fromAccountId: cash.id,
      firstDate: addMonthsToDate(todayLocal(), 1),
      total: 3000000,
      count: 3,
      title: 'カードの返済',
    });

    await renderReady({
      period: { mode: 'date', date: addMonthsToDate(todayLocal(), 6) },
      target: { liabilityAccountId: card.id },
    });
    await waitFor(() => expect(ui(UI.allocations.view)).toBeInTheDocument());
    expect(ui(UI.allocations.liabilityRow)).not.toBeInTheDocument();
    expect(ui(UI.allocations.repaySheet)).not.toBeInTheDocument();
  });
});
