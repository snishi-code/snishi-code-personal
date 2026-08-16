/*
 * 状態を変える操作は必ず確認を挟む（2026-08-15 作者合意・docs/dev/ledger-ui-ux.md）:
 *  - 定期ルールの「終了」は終了日シート（既定 = 今日で置ける最小の排他的終了点）を通す
 *  - ルール由来 item には確認どころか操作自体が無い（読み取り専用・作者決定 2026-08-15。
 *    「この回をスキップ」は概念ごと撤去し、調整はルール側の編集・終了で行う）
 *  - ルール削除はカスケード。確認で「一緒に消える回数」（v13 = 今日までの導出起票数）と
 *    復旧方法を示す
 *  - 手動で登録した継続コスト資産の削除は従来の削除確認のまま
 */
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { ToastProvider } from '@snishi/foundation/ui/toast';
import { patchDialogIfNeeded } from '@snishi/foundation/ui/test-utils';
import { createContinuousCost, createRecurringRule, loadLedger } from '../src/data/repository';
import { deriveRecurringOutputs } from '../src/domain/recurring';
import { reportEntriesForAsOf, reportMonthlyCostItems } from '../src/domain/reportEntries';
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

/**
 * 毎月 20 日・月割りありのルール。今日（4/20）が周期日なので、導出は 1 回ぶんの
 * 購入の仕訳と item（`ccr-{ruleId}-2026-04`）を出す（保存はされない = v13）。
 */
async function seedPostedRule(): Promise<RecurringRule> {
  const ledger = await loadLedger();
  const bank = ledger.accounts.find((account) => account.name === '預金')!;
  const fixed = ledger.accounts.find((account) => account.name === '固定費')!;
  return createRecurringRule({
    name: 'サブスク',
    amount: 60_000,
    dayOfMonth: 20,
    everyMonths: 1,
    debitAccountId: fixed.id,
    creditAccountId: bank.id,
    startMonth: '2026-04',
    startDate: '2026-04-12',
  });
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
    // 今日（4/20）は周期日なので、その回は今日の断面にすでに立っている。半開区間
    // [startDate, endDate) の外へ出さない最小の終了点は翌日（4/21）。
    // v13 では今日の回が導出行なので、終了点の下限も導出から決まる必要がある。
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

describe('定期ルールの削除（カスケード）', () => {
  it('確認に「一緒に消える回数」（今日までの導出起票数）を出し、確定で全部消える', async () => {
    const rule = await seedPostedRule();
    // 今日（4/20）までの導出 = 4/20 の 1 回ぶん（仕訳 1 + item 1）。確認の数はこれを数える。
    const before = await loadLedger();
    const derivedBefore = deriveRecurringOutputs(
      before.recurringRules,
      before.accounts,
      '2026-04-20',
    );
    expect(derivedBefore.entries).toHaveLength(1);
    expect(derivedBefore.items).toHaveLength(1);
    await renderReady();

    fireEvent.click(
      await waitFor(() => document.querySelector(`[data-ui="${UI.allocations.recurringDelete}"]`)!),
    );
    const dialog = screen.getByRole('dialog');
    expect(dialog).toHaveTextContent('1 回分の仕訳と持ち物も一緒に消えます');
    expect(dialog).toHaveTextContent('登録し直せば復旧できます');

    fireEvent.click(screen.getByRole('button', { name: '削除' }));
    await waitFor(async () => {
      const after = await loadLedger();
      expect(after.recurringRules).toHaveLength(0);
      // ルール本体が消えれば導出も消える（保存側にも残骸を残さない）。
      const derived = deriveRecurringOutputs(after.recurringRules, after.accounts, '2026-04-20');
      expect(derived.entries).toHaveLength(0);
      expect(reportMonthlyCostItems(after, derived.items)).toHaveLength(0);
      expect(
        reportEntriesForAsOf(after, '2026-04-20').filter((e) => e.description === rule.name),
      ).toHaveLength(0);
    });
  });

  it('起票が 1 回も導出されないルールは「まだ起票はありません」だけを示す', async () => {
    const ledger = await loadLedger();
    const bank = ledger.accounts.find((account) => account.name === '預金')!;
    const fixed = ledger.accounts.find((account) => account.name === '固定費')!;
    await createRecurringRule({
      name: 'これから始めるもの',
      amount: 1000,
      dayOfMonth: 25,
      everyMonths: 1,
      debitAccountId: fixed.id,
      creditAccountId: bank.id,
      startMonth: '2026-04',
      // 表示断面（4/20）には存在するが、初回起票日（4/25）はまだ来ていない。
      startDate: '2026-04-01',
    });
    await renderReady();

    fireEvent.click(
      await waitFor(() => document.querySelector(`[data-ui="${UI.allocations.recurringDelete}"]`)!),
    );
    const dialog = screen.getByRole('dialog');
    expect(dialog).toHaveTextContent('まだ起票はありません');
    expect(dialog).not.toHaveTextContent('回分の仕訳と持ち物');
  });
});

describe('継続コスト item の削除確認', () => {
  it('ルール由来 item にはそもそも削除・アーカイブを出さない（読み取り専用）', async () => {
    const rule = await seedPostedRule();
    await renderReady();

    const card = (await waitFor(() =>
      document.querySelector(`[data-ui="${UI.allocations.item}"]`),
    )) as HTMLElement;
    // 「この回をスキップ」という概念自体を撤去した（作者決定 2026-08-15）。
    expect(
      within(card).queryByRole('button', { name: `この回をスキップ: ${rule.name}` }),
    ).not.toBeInTheDocument();
    expect(
      within(card).queryByRole('button', { name: `削除: ${rule.name}` }),
    ).not.toBeInTheDocument();
    expect(within(card).queryAllByRole('button')).toHaveLength(0);
  });

  it('ルール由来 item のタップは由来ルールの編集シート（手動 item とは行き先が違う）', async () => {
    const rule = await seedPostedRule();
    await renderReady();

    const card = (await waitFor(() =>
      document.querySelector(`[data-ui="${UI.allocations.item}"]`),
    )) as HTMLElement;
    // ルール由来 item のアクセシブル名は由来ルール（手動 item のカードと同型の見た目）。
    expect(card).toHaveAttribute('role', 'button');
    expect(card).toHaveAttribute('aria-label', `編集: ${rule.name}`);
    fireEvent.click(card);
    // 継続コスト資産シートではなくルールの編集シートが開く。
    expect(document.querySelector(`[data-ui="${UI.allocations.editDialog}"]`)).toBeNull();
    expect(
      document.querySelector(`[data-ui="${UI.allocations.recurringSheet}"]`),
    ).toBeInTheDocument();
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
    expect(screen.getByText('継続コスト資産を削除しますか？')).toBeInTheDocument();
  });
});
