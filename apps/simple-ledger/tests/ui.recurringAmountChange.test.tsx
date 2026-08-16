import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { ToastProvider } from '@snishi/foundation/ui/toast';
import { patchDialogIfNeeded } from '@snishi/foundation/ui/test-utils';
import { createRecurringRule, loadLedger } from '../src/data/repository';
import * as repository from '../src/data/repository';
import { deriveRecurringOutputs } from '../src/domain/recurring';
import { LedgerProvider, useLedger } from '../src/state/store';
import { UI } from '../src/ui-contract';
import { firstRuleRow } from './tapTargets';
import { _resetOverlaysForTests } from '../src/ui/overlays';
import { Allocations } from '../src/ui/screens/Allocations';
import type { RecurringRule } from '../src/domain/types';
import './setup';

const clock = vi.hoisted(() => ({ today: '2026-04-18' }));

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
  vi.restoreAllMocks();
  clock.today = '2026-04-18';
});

function View({ date = '2026-04-30' }: { date?: string }) {
  return (
    <ToastProvider>
      <LedgerProvider>
        <ReadyView date={date} />
      </LedgerProvider>
    </ToastProvider>
  );
}

function ReadyView({ date }: { date: string }) {
  const { status } = useLedger();
  return status === 'ready' ? (
    <Allocations period={{ mode: 'date', date }} onEditEntry={() => undefined} />
  ) : null;
}

async function seedRule(amount = 100_000): Promise<RecurringRule> {
  const ledger = await loadLedger();
  const bank = ledger.accounts.find((account) => account.role === 'daily-asset')!;
  const expense = ledger.accounts.find((account) => account.role === 'expense-category')!;
  return createRecurringRule({
    name: '料金変更テスト',
    amount,
    dayOfMonth: 20,
    everyMonths: 1,
    debitAccountId: expense.id,
    creditAccountId: bank.id,
    startMonth: '2026-04',
    startDate: '2026-04-12',
  });
}

async function openAmountDecision(nextAmount: string): Promise<void> {
  render(<View />);
  await waitFor(() => {
    expect(firstRuleRow()).toBeTruthy();
  });
  fireEvent.click(firstRuleRow()!);
  fireEvent.change(document.querySelector(`[data-ui="${UI.allocations.recurringAmount}"]`)!, {
    target: { value: nextAmount },
  });
  fireEvent.click(document.querySelector(`[data-ui="${UI.allocations.recurringSave}"]`)!);
  await waitFor(() => {
    expect(
      document.querySelector(`[data-ui="${UI.allocations.recurringAmountChangeDialog}"]`),
    ).toBeInTheDocument();
  });
}

describe('定期ルールの金額変更範囲', () => {
  it('終了したルールに「再開」は無く、終了の取り消しは編集シートの「終了日を解除」で行う', async () => {
    const original = await seedRule();
    // 起票を 1 回済ませてから終了する（v13.3: 起票ゼロになる終了は保存境界が拒否し、
    // 削除へ誘導する。ここで見たいのは終了 → 解除の往復なので起票済みの線分を使う）。
    clock.today = '2026-04-25';
    render(<View />);
    await waitFor(() => {
      expect(document.querySelector(`[data-ui="${UI.allocations.recurringEnd}"]`)).toBeTruthy();
    });

    // 終了は終了日シートを通す（既定 = 今日で置ける最小の排他的終了点）。
    fireEvent.click(document.querySelector(`[data-ui="${UI.allocations.recurringEnd}"]`)!);
    await waitFor(() => {
      expect(
        document.querySelector(`[data-ui="${UI.allocations.recurringEndSheet}"]`),
      ).toBeInTheDocument();
    });
    fireEvent.click(
      document.querySelector(`[data-ui="${UI.allocations.recurringEndSheetConfirm}"]`)!,
    );
    await waitFor(async () => {
      expect(
        (await loadLedger()).recurringRules.find((rule) => rule.id === original.id)?.endDate,
      ).toBe('2026-04-25');
    });

    await waitFor(() => {
      expect(document.querySelector(`[data-ui="${UI.allocations.showCompleted}"]`)).toBeTruthy();
    });
    const showEnded = document.querySelector(
      `[data-ui="${UI.allocations.showCompleted}"]`,
    ) as HTMLInputElement;
    fireEvent.click(showEnded);
    // 「再開」ボタンは撤去済み（実体は新規登録と同じで「終了の Undo」と誤読させるため。
    // 再契約 = 新規登録・終了の間違い = 解除）。
    // 起票済みなので由来 item カードも同名で並ぶ。ルール行（先頭）を選ぶ。
    await waitFor(() => {
      expect(firstRuleRow()).toBeTruthy();
    });
    expect(document.querySelector('[data-ui="allocations.recurring.restart"]')).toBeNull();

    // 終了の Undo = 編集シート下部の「終了日を解除」（終了済みのときだけ表示・確認つき）。
    fireEvent.click(firstRuleRow()!);
    fireEvent.click(
      await waitFor(
        () => document.querySelector(`[data-ui="${UI.allocations.recurringClearEndDate}"]`)!,
      ),
    );
    const clearConfirm = await waitFor(
      () => document.querySelector(`[data-ui="${UI.allocations.recurringClearEndDateConfirm}"]`)!,
    );
    expect(clearConfirm).toHaveTextContent('継続中に戻します');
    fireEvent.click(clearConfirm.querySelector(`[data-ui="${UI.dialog.confirm}"]`)!);

    // 新しいルールは作られず（再開の廃止）、同じルールの終了点だけが消える。
    await waitFor(async () => {
      const ledger = await loadLedger();
      expect(ledger.recurringRules).toHaveLength(1);
      expect(ledger.recurringRules[0]!.id).toBe(original.id);
      expect(ledger.recurringRules[0]!.endDate).toBeUndefined();
    });
  });

  it('存在期間と起票周期の基準日を別の入力として保存する', async () => {
    const original = await seedRule();
    render(<View />);
    await waitFor(() => {
      expect(firstRuleRow()).toBeTruthy();
    });
    fireEvent.click(firstRuleRow()!);

    // 存在期間は詳細の折りたたみの中（v13.1 その4）。
    fireEvent.click(
      document.querySelector(`[data-ui="${UI.allocations.recurringDetailsToggle}"]`)!,
    );
    expect(document.querySelector(`[data-ui="${UI.allocations.recurringStartDate}"]`)).toHaveValue(
      '2026-04-12',
    );
    expect(
      document.querySelector(`[data-ui="${UI.allocations.recurringFirstPostingDate}"]`),
    ).toHaveValue('2026-04-20');
    fireEvent.change(document.querySelector(`[data-ui="${UI.allocations.recurringEndDate}"]`)!, {
      target: { value: '2026-06-01' },
    });
    fireEvent.click(document.querySelector(`[data-ui="${UI.allocations.recurringSave}"]`)!);

    await waitFor(() => {
      expect(
        document.querySelector(`[data-ui="${UI.allocations.recurringSheet}"]`),
      ).not.toBeInTheDocument();
    });
    expect(
      document.querySelector(`[data-ui="${UI.allocations.recurringAmountChangeDialog}"]`),
    ).not.toBeInTheDocument();
    expect(
      (await loadLedger()).recurringRules.find((rule) => rule.id === original.id),
    ).toMatchObject({
      startDate: '2026-04-12',
      endDate: '2026-06-01',
      startMonth: '2026-04',
      dayOfMonth: 20,
    });

    cleanup();
    _resetOverlaysForTests();
    render(<View />);
    await waitFor(() => {
      expect(firstRuleRow()).toBeTruthy();
    });
    fireEvent.click(firstRuleRow()!);
    fireEvent.click(
      document.querySelector(`[data-ui="${UI.allocations.recurringDetailsToggle}"]`)!,
    );
    fireEvent.change(document.querySelector(`[data-ui="${UI.allocations.recurringEndDate}"]`)!, {
      target: { value: '' },
    });
    fireEvent.click(document.querySelector(`[data-ui="${UI.allocations.recurringSave}"]`)!);
    await waitFor(() => {
      expect(
        document.querySelector(`[data-ui="${UI.allocations.recurringSheet}"]`),
      ).not.toBeInTheDocument();
    });
    expect(
      (await loadLedger()).recurringRules.find((rule) => rule.id === original.id)?.endDate,
    ).toBeUndefined();
  });

  it('判断画面を出すまでは保存せず、戻ると入力値を保ったままDBを変更しない', async () => {
    const original = await seedRule();
    await openAmountDecision('1500');

    expect(
      (await loadLedger()).recurringRules.find((rule) => rule.id === original.id)?.amount,
    ).toBe(100_000);
    fireEvent.click(
      document.querySelector(`[data-ui="${UI.allocations.recurringAmountChangeCancel}"]`)!,
    );

    expect(
      document.querySelector(`[data-ui="${UI.allocations.recurringAmountChangeDialog}"]`),
    ).not.toBeInTheDocument();
    expect(document.querySelector(`[data-ui="${UI.allocations.recurringAmount}"]`)).toHaveValue(
      '1500',
    );
    expect(
      (await loadLedger()).recurringRules.find((rule) => rule.id === original.id)?.amount,
    ).toBe(100_000);
  });

  it('金額変更で分けたルールも、系譜と重ならなければ期間と位相を編集できる', async () => {
    const original = await seedRule();
    await repository.upsertRecurringRule(
      { ...original, amount: 150000 },
      { amountChangeMode: 'split', effectiveDate: '2026-04-18' },
    );
    render(<View />);
    await waitFor(() => {
      expect(firstRuleRow()).toBeTruthy();
    });
    fireEvent.click(firstRuleRow()!);

    const dayInput = document.querySelector(
      `[data-ui="${UI.allocations.recurringFirstPostingDate}"]`,
    )!;
    expect(dayInput).toHaveAttribute('type', 'date');
    expect(dayInput).toHaveValue('2026-04-20');
    fireEvent.change(dayInput, { target: { value: '2026-05-31' } });
    // 存在期間は詳細の折りたたみの中（v13.1 その4）。
    fireEvent.click(
      document.querySelector(`[data-ui="${UI.allocations.recurringDetailsToggle}"]`)!,
    );
    fireEvent.change(document.querySelector(`[data-ui="${UI.allocations.recurringStartDate}"]`)!, {
      target: { value: '2026-04-19' },
    });
    fireEvent.change(document.querySelector(`[data-ui="${UI.allocations.recurringEndDate}"]`)!, {
      target: { value: '2026-06-01' },
    });
    fireEvent.click(document.querySelector(`[data-ui="${UI.allocations.recurringSave}"]`)!);

    await waitFor(() => {
      expect(
        document.querySelector(`[data-ui="${UI.allocations.recurringSheet}"]`),
      ).not.toBeInTheDocument();
    });
    const ledger = await loadLedger();
    const changed = ledger.recurringRules.find((rule) => rule.id !== original.id)!;
    expect(changed).toMatchObject({
      startMonth: '2026-05',
      dayOfMonth: 31,
      startDate: '2026-04-19',
      endDate: '2026-06-01',
    });
  });

  it('保存の連打を二重送信せず、失敗時は判断画面と入力を保つ', async () => {
    const original = await seedRule();
    await openAmountDecision('1500');
    let rejectSave: (reason: unknown) => void = () => undefined;
    const blocked = new Promise<void>((_resolve, reject) => {
      rejectSave = reject;
    });
    const save = vi.spyOn(repository, 'upsertRecurringRule').mockReturnValue(blocked);
    const split = document.querySelector(
      `[data-ui="${UI.allocations.recurringAmountChangeFromToday}"]`,
    ) as HTMLButtonElement;

    fireEvent.click(split);
    fireEvent.click(split);
    expect(save).toHaveBeenCalledTimes(1);
    rejectSave(new Error('テスト用の保存失敗'));

    await waitFor(() => {
      const dialog = document.querySelector(
        `[data-ui="${UI.allocations.recurringAmountChangeDialog}"]`,
      );
      expect(dialog).toBeInTheDocument();
      expect(dialog?.querySelector('[role="alert"]')).toBeInTheDocument();
      expect(split).not.toBeDisabled();
    });
    expect(
      (await loadLedger()).recurringRules.find((rule) => rule.id === original.id)?.amount,
    ).toBe(100_000);
  });

  it('保存本体の後の再読込だけが失敗しても、保存済みとして判断画面を閉じる', async () => {
    // v13: ルール保存後の後続処理は再読込（refresh）だけ。durable 境界の後に失敗しても
    // 「未保存」へ戻さない＝分割の後継 segment を二重保存させない。
    const original = await seedRule();
    await openAmountDecision('1500');
    vi.spyOn(repository, 'loadLedger').mockRejectedValueOnce(new Error('テスト用の後続失敗'));

    fireEvent.click(
      document.querySelector(`[data-ui="${UI.allocations.recurringAmountChangeFromToday}"]`)!,
    );
    await waitFor(() => {
      expect(
        document.querySelector(`[data-ui="${UI.allocations.recurringAmountChangeDialog}"]`),
      ).not.toBeInTheDocument();
    });
    // 注入した失敗が実際に後続経路を通ったこと（= 空振りで通っていないこと）を名乗らせる。
    expect(await screen.findByText(/画面の再読込に失敗しました/)).toBeInTheDocument();
    const ledger = await loadLedger();
    expect(ledger.recurringRules.find((rule) => rule.id === original.id)).toMatchObject({
      amount: 100000,
      endDate: '2026-04-18',
    });
    expect(ledger.recurringRules.find((rule) => rule.id !== original.id)).toMatchObject({
      amount: 150000,
      startDate: '2026-04-18',
    });
  });

  it('新規登録後の再読込だけが失敗しても、保存済みとして入力画面を閉じる', async () => {
    render(<View />);
    await waitFor(() => {
      expect(document.querySelector(`[data-ui="${UI.allocations.unifiedAdd}"]`)).toBeTruthy();
    });
    // 初回読込は通し、保存直後の再読込だけを 1 回失敗させる（新規は別 ID の同一ルールを
    // 二重に作り得るため、durable 境界の後は警告だけで完了する）。
    vi.spyOn(repository, 'loadLedger').mockRejectedValueOnce(new Error('テスト用の後続失敗'));
    fireEvent.click(document.querySelector(`[data-ui="${UI.allocations.unifiedAdd}"]`)!);
    fireEvent.click(document.querySelector(`[data-ui="${UI.allocations.addChooser}.rule"]`)!);
    fireEvent.change(document.querySelector(`[data-ui="${UI.allocations.recurringName}"]`)!, {
      target: { value: '後続失敗テスト' },
    });
    fireEvent.change(document.querySelector(`[data-ui="${UI.allocations.recurringAmount}"]`)!, {
      target: { value: '2500' },
    });
    fireEvent.click(document.querySelector(`[data-ui="${UI.allocations.recurringSave}"]`)!);

    await waitFor(() => {
      expect(
        document.querySelector(`[data-ui="${UI.allocations.recurringSheet}"]`),
      ).not.toBeInTheDocument();
    });
    expect(await screen.findByText(/画面の再読込に失敗しました/)).toBeInTheDocument();
    expect(
      (await loadLedger()).recurringRules.filter((rule) => rule.name === '後続失敗テスト'),
    ).toHaveLength(1);
  });

  it('今日すでに存在しないルールには実行不能な「今日から」を表示しない', async () => {
    clock.today = '2026-04-22';
    const original = await seedRule();
    await repository.upsertRecurringRule({ ...original, endDate: '2026-04-22' });
    render(<View date="2026-04-20" />);
    await waitFor(() => {
      expect(firstRuleRow()).toBeTruthy();
    });
    fireEvent.click(firstRuleRow()!);
    fireEvent.change(document.querySelector(`[data-ui="${UI.allocations.recurringAmount}"]`)!, {
      target: { value: '1500' },
    });
    fireEvent.click(document.querySelector(`[data-ui="${UI.allocations.recurringSave}"]`)!);

    await waitFor(() => {
      expect(
        document.querySelector(`[data-ui="${UI.allocations.recurringAmountChangeDialog}"]`),
      ).toBeInTheDocument();
    });
    expect(
      document.querySelector(`[data-ui="${UI.allocations.recurringAmountChangeFromToday}"]`),
    ).not.toBeInTheDocument();
    expect(
      document.querySelector(`[data-ui="${UI.allocations.recurringAmountChangeAll}"]`),
    ).toBeInTheDocument();
  });

  it('「全期間」を選ぶと同じ線分の全期間が新しい金額で導出し直される', async () => {
    const original = await seedRule();
    await openAmountDecision('1500');

    fireEvent.click(
      document.querySelector(`[data-ui="${UI.allocations.recurringAmountChangeAll}"]`)!,
    );
    await waitFor(() => {
      expect(
        document.querySelector(`[data-ui="${UI.allocations.recurringAmountChangeDialog}"]`),
      ).not.toBeInTheDocument();
    });

    const ledger = await loadLedger();
    expect(ledger.recurringRules).toHaveLength(1);
    expect(ledger.recurringRules[0]).toMatchObject({ id: original.id, amount: 150_000 });
    // v13: ルール由来の仕訳・item は保存しない。全期間の訂正は「保存行の書き換え」ではなく
    // 「現在のルール値での引き直し」として現れる。
    expect(ledger.monthlyCostItems).toHaveLength(0);
    expect(
      ledger.journalEntries.filter((entry) => entry.metadata?.recurringRuleId === original.id),
    ).toHaveLength(0);
    const derived = deriveRecurringOutputs(ledger.recurringRules, ledger.accounts, '2026-04-20');
    expect(derived.items.find((item) => item.id === `ccr-${original.id}-2026-04`)).toMatchObject({
      amount: 150_000,
    });
    expect(derived.entries).toHaveLength(1);
    expect(
      derived.entries
        .find((entry) => entry.metadata?.recurringRuleId === original.id)
        ?.lines.every((line) => line.amount === 150_000),
    ).toBe(true);
  });

  it('4/18の分岐では4/20が旧線分から外れ、新しい金額の後継から導出される', async () => {
    const original = await seedRule();
    await openAmountDecision('1500');

    const dialog = document.querySelector(
      `[data-ui="${UI.allocations.recurringAmountChangeDialog}"]`,
    );
    expect(dialog).toHaveTextContent('2026-04-18 から新しい金額');
    expect(dialog).toHaveTextContent('起票周期の基準月は現在のルールから引き継ぎ');
    // 判断画面を跨いで日付が変わっても、表示した境界日で保存する。
    clock.today = '2026-04-19';

    fireEvent.click(
      document.querySelector(`[data-ui="${UI.allocations.recurringAmountChangeFromToday}"]`)!,
    );
    await waitFor(() => {
      expect(
        document.querySelector(`[data-ui="${UI.allocations.recurringAmountChangeDialog}"]`),
      ).not.toBeInTheDocument();
    });

    const ledger = await loadLedger();
    const previous = ledger.recurringRules.find((rule) => rule.id === original.id)!;
    const successor = ledger.recurringRules.find((rule) => rule.id !== original.id)!;
    expect(previous).toMatchObject({ amount: 100000, endDate: '2026-04-18' });
    expect(successor).toMatchObject({ amount: 150000, startDate: '2026-04-18' });
    expect(successor.startMonth).toBe(original.startMonth);
    expect(successor.dayOfMonth).toBe(original.dayOfMonth);
    // 保存側の付け替えは存在しない（何も保存しない）。境界の帰属は半開区間が決める。
    expect(ledger.monthlyCostItems).toHaveLength(0);

    const derived = deriveRecurringOutputs(ledger.recurringRules, ledger.accounts, '2026-04-20');
    expect(derived.items.find((item) => item.id.startsWith(`ccr-${original.id}-`))).toBe(undefined);
    expect(derived.items.find((item) => item.id === `ccr-${successor.id}-2026-04`)).toMatchObject({
      amount: 150000,
      startDate: '2026-04-20',
    });
  });

  it('4/22の分岐では4/20分が旧線分に残り、新線分は翌月から導出される', async () => {
    clock.today = '2026-04-22';
    const original = await seedRule();
    await openAmountDecision('1500');

    fireEvent.click(
      document.querySelector(`[data-ui="${UI.allocations.recurringAmountChangeFromToday}"]`)!,
    );
    await waitFor(() => {
      expect(
        document.querySelector(`[data-ui="${UI.allocations.recurringAmountChangeDialog}"]`),
      ).not.toBeInTheDocument();
    });

    const ledger = await loadLedger();
    const successor = ledger.recurringRules.find((rule) => rule.id !== original.id)!;
    expect(ledger.recurringRules.find((rule) => rule.id === original.id)).toMatchObject({
      amount: 100000,
      endDate: '2026-04-22',
    });
    // 4/20 は旧線分 [4/12, 4/22) の中なので旧金額のまま導出される。
    const april = deriveRecurringOutputs(ledger.recurringRules, ledger.accounts, '2026-04-22');
    expect(april.items.find((item) => item.id === `ccr-${original.id}-2026-04`)).toMatchObject({
      amount: 100000,
      startDate: '2026-04-20',
    });
    expect(april.items.find((item) => item.id === `ccr-${successor.id}-2026-04`)).toBeUndefined();

    // 後継は 4/22 開始・位相は 20 日のままなので、最初の回は 5/20。
    const may = deriveRecurringOutputs(ledger.recurringRules, ledger.accounts, '2026-05-20');
    expect(may.items.find((item) => item.id === `ccr-${successor.id}-2026-05`)).toMatchObject({
      amount: 150000,
      startDate: '2026-05-20',
    });
  });
});
