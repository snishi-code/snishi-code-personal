/*
 * 状態を変える操作は必ず確認を挟む（2026-08-15 作者合意・docs/dev/ledger-ui-ux.md）:
 *  - 定期ルールの「終了」は終了日シート（既定 = 今日で置ける最小の排他的終了点）を通す
 *  - ルール由来 item の削除は「この回をスキップ」と名乗り、次回起票日を示す
 *  - スキップのダイアログから「ルールを終了する」（終了日シート）へ乗り換えられる
 *  - 手動で登録した継続コスト資産の削除は従来の削除確認のまま
 */
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { ToastProvider } from '@snishi/foundation/ui/toast';
import { patchDialogIfNeeded } from '@snishi/foundation/ui/test-utils';
import {
  catchUpRecurringRules,
  createContinuousCost,
  createRecurringRule,
  loadLedger,
} from '../src/data/repository';
import { LedgerProvider, useLedger } from '../src/state/store';
import { UI } from '../src/ui-contract';
import { _resetOverlaysForTests } from '../src/ui/overlays';
import { Allocations } from '../src/ui/screens/Allocations';
import type { RecurringRule } from '../src/domain/types';
import './setup';

const clock = vi.hoisted(() => ({ today: '2026-04-20' }));

vi.mock('../src/util/time', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/util/time')>();
  return { ...actual, todayLocal: () => clock.today };
});

beforeAll(() => {
  patchDialogIfNeeded();
});

afterEach(() => {
  cleanup();
  _resetOverlaysForTests();
  clock.today = '2026-04-20';
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
  return status === 'ready' ? (
    <Allocations period={{ mode: 'date', date: clock.today }} onEditEntry={() => undefined} />
  ) : null;
}

async function renderReady() {
  render(<View />);
  await waitFor(() => {
    expect(document.querySelector(`[data-ui="${UI.allocations.view}"]`)).toBeInTheDocument();
  });
}

/** 4/20 起票・月割りありのルール。catch-up 済み（ccr- item と購入の仕訳が 1 回ぶんある）。 */
async function seedPostedRule(): Promise<RecurringRule> {
  const ledger = await loadLedger();
  const bank = ledger.accounts.find((account) => account.name === '預金')!;
  const fixed = ledger.accounts.find((account) => account.name === '固定費')!;
  const rule = await createRecurringRule({
    name: 'サブスク',
    amount: 60_000,
    dayOfMonth: 20,
    everyMonths: 1,
    debitAccountId: fixed.id,
    spreadViaLedger: true,
    creditAccountId: bank.id,
    startMonth: '2026-04',
    startDate: '2026-04-12',
  });
  await catchUpRecurringRules('2026-04-20');
  return rule;
}

describe('定期ルールの終了（終了日シート）', () => {
  it('終了ボタンでシートが開き、既定は今日で置ける最小の排他的終了点', async () => {
    const rule = await seedPostedRule();
    await renderReady();

    fireEvent.click(
      await waitFor(() => document.querySelector(`[data-ui="${UI.allocations.recurringEnd}"]`)!),
    );
    const sheet = document.querySelector(`[data-ui="${UI.allocations.recurringEndSheet}"]`);
    expect(sheet).toBeInTheDocument();
    // 4/20 に起票済み = その事実は存在期間の中。終了点は翌日（保存境界と同じ規則）。
    expect(
      document.querySelector(`[data-ui="${UI.allocations.recurringEndSheetDate}"]`),
    ).toHaveValue('2026-04-21');
    expect(sheet).toHaveTextContent('この日以降は起票されません');
    // 開いただけでは何も保存しない。
    expect(
      (await loadLedger()).recurringRules.find((r) => r.id === rule.id)?.endDate,
    ).toBeUndefined();
  });

  it('確定で終了点が入り、キャンセルでは何も変わらない', async () => {
    const rule = await seedPostedRule();
    await renderReady();

    fireEvent.click(
      await waitFor(() => document.querySelector(`[data-ui="${UI.allocations.recurringEnd}"]`)!),
    );
    fireEvent.click(screen.getByRole('button', { name: 'キャンセル' }));
    expect(document.querySelector(`[data-ui="${UI.allocations.recurringEndSheet}"]`)).toBeNull();
    expect(
      (await loadLedger()).recurringRules.find((r) => r.id === rule.id)?.endDate,
    ).toBeUndefined();

    fireEvent.click(document.querySelector(`[data-ui="${UI.allocations.recurringEnd}"]`)!);
    fireEvent.change(
      document.querySelector(`[data-ui="${UI.allocations.recurringEndSheetDate}"]`)!,
      {
        target: { value: '2026-06-01' },
      },
    );
    fireEvent.click(
      document.querySelector(`[data-ui="${UI.allocations.recurringEndSheetConfirm}"]`)!,
    );

    await waitFor(async () => {
      expect((await loadLedger()).recurringRules.find((r) => r.id === rule.id)?.endDate).toBe(
        '2026-06-01',
      );
    });
    expect(document.querySelector(`[data-ui="${UI.allocations.recurringEndSheet}"]`)).toBeNull();
  });
});

describe('ルール由来 item の「この回をスキップ」', () => {
  it('削除ではなくスキップと名乗り、次回の起票日を示す', async () => {
    const rule = await seedPostedRule();
    await renderReady();

    const skip = await screen.findByRole('button', { name: `この回をスキップ: ${rule.name}` });
    // item カードの側に「削除」は残らない（ルール行の削除ボタンは別物なので範囲を絞る）。
    const card = document.querySelector(`[data-ui="${UI.allocations.item}"]`) as HTMLElement;
    expect(
      within(card).queryByRole('button', { name: `削除: ${rule.name}` }),
    ).not.toBeInTheDocument();
    fireEvent.click(skip);

    const dialog = document.querySelector(`[data-ui="${UI.allocations.skipDialog}"]`)!;
    expect(dialog).toHaveTextContent('この回をスキップしますか？');
    // 次回 = カーソルより後の最初の未起票日（周期位相どおりの 5/20）。
    expect(dialog).toHaveTextContent('次回は 2026-05-20 に起票されます');
  });

  it('確定すると item と購入の仕訳が消え、カーソルは戻らない', async () => {
    const rule = await seedPostedRule();
    const itemId = `ccr-${rule.id}-2026-04`;
    await renderReady();

    fireEvent.click(await screen.findByRole('button', { name: `この回をスキップ: ${rule.name}` }));
    fireEvent.click(document.querySelector(`[data-ui="${UI.allocations.skipConfirm}"]`)!);

    await waitFor(async () => {
      const after = await loadLedger();
      expect(after.monthlyCostItems.some((item) => item.id === itemId)).toBe(false);
      expect(after.journalEntries.some((e) => e.metadata?.monthlyCostId === itemId)).toBe(false);
      // カーソル（起票済み月）は戻らない = 同じ回が再起票されない。
      expect(after.recurringRules.find((r) => r.id === rule.id)?.postedThroughMonth).toBe(
        '2026-04',
      );
    });
  });

  it('「ルールを終了する」から終了日シートへ乗り換えられる（item はまだ消えない）', async () => {
    const rule = await seedPostedRule();
    const itemId = `ccr-${rule.id}-2026-04`;
    await renderReady();

    fireEvent.click(await screen.findByRole('button', { name: `この回をスキップ: ${rule.name}` }));
    fireEvent.click(document.querySelector(`[data-ui="${UI.allocations.skipEndRule}"]`)!);

    expect(document.querySelector(`[data-ui="${UI.allocations.skipDialog}"]`)).toBeNull();
    expect(
      document.querySelector(`[data-ui="${UI.allocations.recurringEndSheet}"]`),
    ).toBeInTheDocument();
    expect((await loadLedger()).monthlyCostItems.some((item) => item.id === itemId)).toBe(true);
  });

  it('手動で登録した継続コスト資産は従来どおりの削除確認', async () => {
    const ledger = await loadLedger();
    const fixed = ledger.accounts.find((account) => account.name === '固定費')!;
    const cash = ledger.accounts.find((account) => account.name === '預金')!;
    const item = await createContinuousCost({
      name: '手で登録した持ち物',
      amount: 120_000,
      startDate: '2026-04-01',
      endDate: '2027-04-01',
      expenseAccountId: fixed.id,
      creditAccountId: cash.id,
    });
    await renderReady();

    fireEvent.click(await screen.findByRole('button', { name: `削除: ${item.name}` }));
    expect(document.querySelector(`[data-ui="${UI.allocations.skipDialog}"]`)).toBeNull();
    expect(screen.getByText('継続コスト資産を削除しますか？')).toBeInTheDocument();
  });
});
