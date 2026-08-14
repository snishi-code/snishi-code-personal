/*
 * 「継続コスト台帳を経由して月割りする」明示トグル（作者哲学: 勘定科目で動作を変えない）:
 *  - 既定は行き先 role の提案だけ（費用 = ON・資産 = OFF）で、触るまで行き先変更に追従する
 *  - 一度触ったら固定される（行き先を変えても既定へ戻らない）
 *  - 手動 OFF で保存した費用行きは直接形（spread なし・借方 = 費用）で保存される
 *  - 編集シートの初期値は保存済みの形（spread の有無）
 *  - 終了 → 再開（restart）でも月割りの有無が引き継がれる
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

function toggle(): HTMLInputElement {
  const el = document.querySelector(`[data-ui="${UI.allocations.recurringSpreadToggle}"]`);
  expect(el, '月割りトグルはシート内に常設であること').not.toBeNull();
  return el as HTMLInputElement;
}

/** 行き先（借方）チップを名前で選ぶ。 */
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

describe('継続コスト台帳経由の明示トグル', () => {
  it('既定は行き先 role の提案（費用 = ON・資産 = OFF）で、触るまで行き先変更に追従する', async () => {
    await openCreateSheet();
    chooseSource('預金');

    chooseDestination('固定費');
    expect(toggle().checked).toBe(true);

    // 資産（積立先）へ変えると既定は OFF へ追従する。
    chooseDestination('投資');
    expect(toggle().checked).toBe(false);

    // 費用へ戻せば ON へ戻る（まだ誰も触っていないので既定のまま）。
    chooseDestination('固定費');
    expect(toggle().checked).toBe(true);
  });

  it('一度トグルを触ったら固定され、行き先を変えても既定へ戻らない', async () => {
    await openCreateSheet();
    chooseSource('預金');
    chooseDestination('固定費');
    expect(toggle().checked).toBe(true);

    // 手動 OFF。
    fireEvent.click(toggle());
    expect(toggle().checked).toBe(false);

    // 行き先を変えても手動の選択を尊重する（費用でも OFF のまま）。
    chooseDestination('投資');
    expect(toggle().checked).toBe(false);
    chooseDestination('固定費');
    expect(toggle().checked).toBe(false);
  });

  it('費用行きでも手動 OFF で保存すると直接形（spread なし・借方 = 費用）になる', async () => {
    const ledgerBefore = await loadLedger();
    const fixed = ledgerBefore.accounts.find((a) => a.name === '固定費')!;
    const bank = ledgerBefore.accounts.find((a) => a.name === '預金')!;

    await openCreateSheet();
    fireEvent.change(document.querySelector(`[data-ui="${UI.allocations.recurringName}"]`)!, {
      target: { value: '直接記帳の家賃' },
    });
    fireEvent.change(document.querySelector(`[data-ui="${UI.allocations.recurringAmount}"]`)!, {
      target: { value: '80000' },
    });
    chooseSource('預金');
    chooseDestination('固定費');
    fireEvent.click(toggle());
    fireEvent.click(document.querySelector(`[data-ui="${UI.allocations.recurringSave}"]`)!);

    await waitFor(() => {
      expect(
        document.querySelector(`[data-ui="${UI.allocations.recurringSheet}"]`),
      ).not.toBeInTheDocument();
    });
    const saved = (await loadLedger()).recurringRules.find((r) => r.name === '直接記帳の家賃')!;
    expect(saved.spreadExpenseAccountId).toBeUndefined();
    expect(saved.debitAccountId).toBe(fixed.id);
    expect(saved.creditAccountId).toBe(bank.id);
  });

  it('編集シートの初期値は保存済みの形（spread の有無）に一致する', async () => {
    const ledger = await loadLedger();
    const bank = ledger.accounts.find((a) => a.name === '預金')!;
    const fixed = ledger.accounts.find((a) => a.name === '固定費')!;
    await createRecurringRule({
      name: '直接形の家賃',
      amount: 80000,
      dayOfMonth: 20,
      debitAccountId: fixed.id,
      creditAccountId: bank.id,
      spreadViaLedger: false,
      startMonth: '2026-04',
      startDate: '2026-04-12',
    });

    await renderReady();
    fireEvent.click(
      await waitFor(() => document.querySelector(`[data-ui="${UI.allocations.recurringEdit}"]`)!),
    );
    // 費用行きでも保存形が直接形なら OFF で開く（role から再導出しない）。
    expect(toggle().checked).toBe(false);
  });

  it('終了 → 再開（restart）でも月割りの有無が引き継がれる', async () => {
    const ledger = await loadLedger();
    const bank = ledger.accounts.find((a) => a.name === '預金')!;
    const invest = ledger.accounts.find((a) => a.name === '投資')!;
    // 資産行き + トグル ON = role 既定では生まれない形。再開が role を再導出したら落ちる。
    const original = await createRecurringRule({
      name: 'クレカ積立',
      amount: 60000,
      dayOfMonth: 20,
      everyMonths: 12,
      debitAccountId: invest.id,
      creditAccountId: bank.id,
      spreadViaLedger: true,
      startMonth: '2026-04',
      startDate: '2026-04-12',
    });

    await renderReady();
    fireEvent.click(
      await waitFor(() => document.querySelector(`[data-ui="${UI.allocations.recurringEnd}"]`)!),
    );
    await waitFor(async () => {
      expect(
        (await loadLedger()).recurringRules.find((rule) => rule.id === original.id)?.endDate,
      ).toBe('2026-04-18');
    });

    fireEvent.click(
      await waitFor(() => document.querySelector(`[data-ui="${UI.allocations.showCompleted}"]`)!),
    );
    fireEvent.click(
      await waitFor(
        () => document.querySelector(`[data-ui="${UI.allocations.recurringRestart}"]`)!,
      ),
    );
    await waitFor(async () => {
      expect((await loadLedger()).recurringRules).toHaveLength(2);
    });

    const restarted = (await loadLedger()).recurringRules.find((r) => r.id !== original.id)!;
    expect(restarted.spreadExpenseAccountId).toBe(invest.id);
    expect(restarted.debitAccountId).toBe(CONTINUOUS_COST_LEDGER_ACCOUNT_ID);
  });
});
