/*
 * 全ルール台帳経由（v13.1 の c 案・直接形の廃止）の UI 側の回帰:
 *  - 旧「月割りトグル」が既定 OFF だった行き先（資産）でも、シートから作ったルールの保存形は
 *    台帳経由（借方 = 継続コスト台帳・spreadExpenseAccountId = その資産）になる
 *  - シート内に月割りトグルの checkbox が存在しない（勘定科目でも操作でも動作を変えない）
 *  - 終了 → 再開（restart）でも台帳経由の保存形が引き継がれる
 */
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, waitFor, within } from '@testing-library/react';
import { ToastProvider } from '@snishi/foundation/ui/toast';
import { patchDialogIfNeeded } from '@snishi/foundation/ui/test-utils';
import { LedgerProvider, useLedger } from '../src/state/store';
import { Allocations } from '../src/ui/screens/Allocations';
import { createRecurringRule, loadLedger } from '../src/data/repository';
import { CONTINUOUS_COST_LEDGER_ACCOUNT_ID } from '../src/domain/constants';
import type { ReportPeriod } from '../src/domain/reportPeriod';
import { UI } from '../src/ui-contract';
import { firstRuleRow } from './tapTargets';
import { _resetOverlaysForTests } from '../src/ui/overlays';
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
  clock.today = '2026-04-18';
});

function View({ period }: { period: ReportPeriod }) {
  return (
    <ToastProvider>
      <LedgerProvider>
        <ReadyView period={period} />
      </LedgerProvider>
    </ToastProvider>
  );
}

function ReadyView({ period }: { period: ReportPeriod }) {
  const { status } = useLedger();
  return status === 'ready' ? <Allocations period={period} onEditEntry={() => undefined} /> : null;
}

async function renderReady(period: ReportPeriod = { mode: 'all' }) {
  render(<View period={period} />);
  await waitFor(() => {
    expect(document.querySelector(`[data-ui="${UI.allocations.view}"]`)).toBeInTheDocument();
  });
}

function sheet(): HTMLElement {
  const el = document.querySelector<HTMLElement>(`[data-ui="${UI.allocations.recurringSheet}"]`);
  expect(el, '定期ルールシートが開いていること').not.toBeNull();
  return el!;
}

/** 行き先（計上先）チップを名前で選ぶ。 */
function chooseDestination(name: string) {
  fireEvent.click(
    within(document.querySelector(`[data-ui="${UI.allocations.recurringTo}"]`)!).getByRole(
      'radio',
      {
        name,
      },
    ),
  );
}

function chooseSource(name: string) {
  fireEvent.click(
    within(document.querySelector(`[data-ui="${UI.allocations.recurringFrom}"]`)!).getByRole(
      'radio',
      { name },
    ),
  );
}

async function openCreateSheet() {
  await renderReady();
  fireEvent.click(document.querySelector(`[data-ui="${UI.allocations.unifiedAdd}"]`)!);
  fireEvent.click(document.querySelector(`[data-ui="${UI.allocations.addChooser}.rule"]`)!);
  expect(document.querySelector(`[data-ui="${UI.allocations.recurringSheet}"]`)).not.toBeNull();
}

describe('全ルール台帳経由（月割りトグルの廃止）', () => {
  it('資産行き（旧・既定 OFF）でも保存形は台帳経由になる', async () => {
    const before = await loadLedger();
    const invest = before.accounts.find((a) => a.name === '投資')!;
    const bank = before.accounts.find((a) => a.name === '預金')!;

    await openCreateSheet();
    fireEvent.change(document.querySelector(`[data-ui="${UI.allocations.recurringName}"]`)!, {
      target: { value: 'クレカ積立' },
    });
    fireEvent.change(document.querySelector(`[data-ui="${UI.allocations.recurringAmount}"]`)!, {
      target: { value: '60000' },
    });
    chooseSource('預金');
    chooseDestination('投資');
    fireEvent.click(document.querySelector(`[data-ui="${UI.allocations.recurringSave}"]`)!);

    await waitFor(() => {
      expect(
        document.querySelector(`[data-ui="${UI.allocations.recurringSheet}"]`),
      ).not.toBeInTheDocument();
    });
    const saved = (await loadLedger()).recurringRules.find((r) => r.name === 'クレカ積立')!;
    expect(saved.debitAccountId).toBe(CONTINUOUS_COST_LEDGER_ACCOUNT_ID);
    expect(saved.spreadExpenseAccountId).toBe(invest.id);
    expect(saved.creditAccountId).toBe(bank.id);
  });

  it('新規シートにも編集シートにも月割りトグルの checkbox が無い', async () => {
    const ledger = await loadLedger();
    const bank = ledger.accounts.find((a) => a.name === '預金')!;
    const fixed = ledger.accounts.find((a) => a.name === '固定費')!;

    await openCreateSheet();
    expect(within(sheet()).queryAllByRole('checkbox')).toEqual([]);
    cleanup();
    _resetOverlaysForTests();

    await createRecurringRule({
      name: '家賃',
      amount: 80000,
      dayOfMonth: 20,
      debitAccountId: fixed.id,
      creditAccountId: bank.id,
      startMonth: '2026-04',
      startDate: '2026-04-12',
    });
    await renderReady();
    fireEvent.click(await waitFor(() => firstRuleRow()!));
    expect(within(sheet()).queryAllByRole('checkbox')).toEqual([]);
  });

  it('終了 → 解除（clearEndDate）で同じ台帳経由の線分が継続中へ戻る', async () => {
    const ledger = await loadLedger();
    const bank = ledger.accounts.find((a) => a.name === '預金')!;
    const invest = ledger.accounts.find((a) => a.name === '投資')!;
    const original = await createRecurringRule({
      name: 'クレカ積立',
      amount: 60000,
      dayOfMonth: 20,
      everyMonths: 12,
      debitAccountId: invest.id,
      creditAccountId: bank.id,
      startMonth: '2026-04',
      startDate: '2026-04-12',
    });

    await renderReady();
    // 終了は終了日シート経由（無確認では実行しない）。
    fireEvent.click(
      await waitFor(() => document.querySelector(`[data-ui="${UI.allocations.recurringEnd}"]`)!),
    );
    fireEvent.click(
      await waitFor(
        () => document.querySelector(`[data-ui="${UI.allocations.recurringEndSheetConfirm}"]`)!,
      ),
    );
    await waitFor(async () => {
      expect(
        (await loadLedger()).recurringRules.find((rule) => rule.id === original.id)?.endDate,
      ).toBe('2026-04-18');
    });

    fireEvent.click(
      await waitFor(() => document.querySelector(`[data-ui="${UI.allocations.showCompleted}"]`)!),
    );
    // 「再開」は撤去済み。終了の Undo = 編集シート下部の「終了日を解除」（確認つき）。
    fireEvent.click(await waitFor(() => firstRuleRow()!));
    fireEvent.click(
      await waitFor(
        () => document.querySelector(`[data-ui="${UI.allocations.recurringClearEndDate}"]`)!,
      ),
    );
    fireEvent.click(
      await waitFor(
        () =>
          document.querySelector(
            `[data-ui="${UI.allocations.recurringClearEndDateConfirm}"] [data-ui="${UI.dialog.confirm}"]`,
          )!,
      ),
    );
    // 新しいルールは増えず、同じ線分の終了点だけが消える（保存形は台帳経由のまま）。
    await waitFor(async () => {
      const after = await loadLedger();
      expect(after.recurringRules).toHaveLength(1);
      expect(after.recurringRules[0]!.endDate).toBeUndefined();
    });
    const restored = (await loadLedger()).recurringRules[0]!;
    expect(restored.id).toBe(original.id);
    expect(restored.spreadExpenseAccountId).toBe(invest.id);
    expect(restored.debitAccountId).toBe(CONTINUOUS_COST_LEDGER_ACCOUNT_ID);
  });
});
