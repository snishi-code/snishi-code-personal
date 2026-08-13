/*
 * **全編集シートの「開いて無変更で保存 → 保存値が 1 バイトも変わらない」回帰試験。**
 *
 * v11（金額の 1/100 単位化）で AdjustmentEditSheet が保存値（minor）を生でテキスト欄へ
 * 入れており、無変更保存だけで金額が 100 倍になる事故が起きた。原因は「保存値 → 表示テキスト」
 * の整形（formatMinorForInput）を 1 箇所だけ通していなかったこと。
 *
 * 個別の入力テストでは捕まらない（新規作成しか踏まないため）。**既存レコードを開いて
 * そのまま保存する**という経路を全シートで踏むのがこのファイルの役割で、
 * 同型の欠陥（保存 → 表示 → 保存の往復で値が変わる）を将来にわたって塞ぐ。
 *
 * 表示桁数（0 と 2）の両方で回すことも要点: 桁数設定は表示専用であり、
 * どちらでも保存値は変わってはいけない（作者決定 2026-08-13）。
 */
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import { ToastProvider } from '@snishi/foundation/ui/toast';
import { patchDialogIfNeeded } from '@snishi/foundation/ui/test-utils';
import { LedgerProvider, useLedger } from '../src/state/store';
import { AdjustmentEditSheet } from '../src/ui/AdjustmentSheet';
import { OpeningEditSheet } from '../src/ui/OpeningSheet';
import { EntrySheet } from '../src/ui/screens/EntrySheet';
import { Allocations } from '../src/ui/screens/Allocations';
import {
  createAdjustment,
  createContinuousCost,
  createOpening,
  createRecurringRule,
  loadLedger,
  updateSettings,
  upsertEntry,
} from '../src/data/repository';
import { UI } from '../src/ui-contract';
import { _resetOverlaysForTests } from '../src/ui/overlays';
import { todayLocal } from '../src/util/time';
import type { JournalEntry } from '../src/domain/types';
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

function Ready({ children }: { children: React.ReactNode }) {
  const { status } = useLedger();
  return status === 'ready' ? <>{children}</> : null;
}

async function setDigits(digits: 0 | 1 | 2) {
  const ledger = await loadLedger();
  await updateSettings({ ...ledger.settings, displayFractionDigits: digits });
}

const q = (name: string) => document.querySelector<HTMLElement>(`[data-ui="${name}"]`);

/** 端数を持つ金額（digits=0 では丸めて見えるが、保存値は保たれるべき）。 */
const AMOUNT = 123456; // 1,234.56

describe.each([0, 2] as const)('編集シートの open→save 往復（表示桁数 %i）', (digits) => {
  it('残高補正: 開いて無変更で保存しても actualBalance が変わらない（v11 の 100 倍バグの回帰）', async () => {
    await setDigits(digits);
    const ledger = await loadLedger();
    const cash = ledger.accounts.find((a) => a.role === 'daily-asset')!;
    await createAdjustment({ accountId: cash.id, date: '2026-03-01', actualBalance: AMOUNT });
    const before = (await loadLedger()).journalEntries.find((e) => e.metadata?.adjustment)!;
    expect(before.metadata!.adjustment!.actualBalance).toBe(AMOUNT);

    render(
      <Providers>
        <Ready>
          <AdjustmentEditSheet entry={before} onClose={() => undefined} />
        </Ready>
      </Providers>,
    );
    await waitFor(() => expect(q(UI.adjustments.editDialog)).toBeInTheDocument());
    // 欄には「表示桁で整形した値」が入っている（生の minor ではない）。
    const input = q(UI.adjustments.editActual) as HTMLInputElement;
    expect(input.value).toBe(digits === 0 ? '1235' : '1234.56');

    fireEvent.click(q(UI.adjustments.editSave)!);
    await waitFor(async () => {
      const after = (await loadLedger()).journalEntries.find((e) => e.metadata?.adjustment)!;
      // digits=0 では表示に合わせて 1,235 へ丸められる（画面で見えている値をそのまま保存する
      // = 明示操作なので仕様どおり）。
      // どちらの桁でも「100 倍」にはならない、が本テストの主眼。
      expect(after.metadata!.adjustment!.actualBalance).toBe(digits === 0 ? 123500 : AMOUNT);
    });
  });

  it('初期残高: 開いて無変更で保存しても明細金額が変わらない', async () => {
    await setDigits(digits);
    const ledger = await loadLedger();
    const cash = ledger.accounts.find((a) => a.role === 'daily-asset')!;
    await createOpening({ accountId: cash.id, amount: AMOUNT, date: '2026-02-01' });
    const before = (await loadLedger()).journalEntries.find((e) => e.kind === 'opening')!;

    render(
      <Providers>
        <Ready>
          <OpeningEditSheet entry={before} onClose={() => undefined} />
        </Ready>
      </Providers>,
    );
    await waitFor(() => expect(q(UI.adjustments.openingEditDialog)).toBeInTheDocument());
    const input = q(UI.adjustments.openingEditAmount) as HTMLInputElement;
    expect(input.value).toBe(digits === 0 ? '1235' : '1234.56');

    fireEvent.click(q(UI.adjustments.openingEditSave)!);
    await waitFor(async () => {
      const after = (await loadLedger()).journalEntries.find((e) => e.kind === 'opening')!;
      expect(after.lines[0]!.amount).toBe(digits === 0 ? 123500 : AMOUNT);
    });
  });

  it('通常の仕訳: 開いて無変更で保存しても明細金額が変わらない', async () => {
    await setDigits(digits);
    const ledger = await loadLedger();
    const cash = ledger.accounts.find((a) => a.role === 'daily-asset')!;
    const expense = ledger.accounts.find((a) => a.role === 'expense-category')!;
    const entry: JournalEntry = {
      id: 'round-trip-entry',
      date: todayLocal(),
      description: '往復確認',
      kind: 'normal',
      lines: [
        { accountId: expense.id, side: 'debit', amount: AMOUNT },
        { accountId: cash.id, side: 'credit', amount: AMOUNT },
      ],
      metadata: { inputMode: 'expense' },
      createdAt: '2026-08-13T00:00:00.000Z',
      updatedAt: '2026-08-13T00:00:00.000Z',
    };
    await upsertEntry(entry);

    render(
      <Providers>
        <Ready>
          <EntrySheet init={{ kind: 'edit', entry }} onClose={() => undefined} />
        </Ready>
      </Providers>,
    );
    await waitFor(() => expect(q(UI.journal.entry.amount)).toBeInTheDocument());
    const input = q(UI.journal.entry.amount) as HTMLInputElement;
    expect(input.value).toBe(digits === 0 ? '1235' : '1234.56');

    fireEvent.click(q(UI.journal.entry.save)!);
    await waitFor(async () => {
      const after = (await loadLedger()).journalEntries.find((e) => e.id === entry.id)!;
      expect(after.lines[0]!.amount).toBe(digits === 0 ? 123500 : AMOUNT);
    });
  });

  it('継続コスト資産: 開いて無変更で保存しても amount が変わらない', async () => {
    await setDigits(digits);
    const ledger = await loadLedger();
    const expense = ledger.accounts.find((a) => a.role === 'expense-category')!;
    const item = await createContinuousCost({
      name: '往復確認CC',
      amount: AMOUNT,
      startDate: '2026-01-01',
      endDate: '2026-12-31',
      expenseAccountId: expense.id,
    });

    render(
      <Providers>
        <Ready>
          <Allocations
            period={{ mode: 'all' }}
            onEditEntry={() => undefined}
            target={{ itemId: item.id }}
          />
        </Ready>
      </Providers>,
    );
    await waitFor(() => expect(q(UI.allocations.editDialog)).toBeInTheDocument());
    const input = q(UI.allocations.editAmount) as HTMLInputElement;
    expect(input.value).toBe(digits === 0 ? '1235' : '1234.56');

    fireEvent.click(q(UI.allocations.editSave)!);
    await waitFor(async () => {
      const after = (await loadLedger()).monthlyCostItems.find((m) => m.id === item.id)!;
      expect(after.amount).toBe(digits === 0 ? 123500 : AMOUNT);
    });
  });

  it('くり返し記帳: 開いて無変更で保存しても amount が変わらない（金額変更の確認シートも出ない）', async () => {
    await setDigits(digits);
    const ledger = await loadLedger();
    const bank = ledger.accounts.find((a) => a.name === '預金')!;
    const invest = ledger.accounts.find((a) => a.name === '投資')!;
    const today = todayLocal();
    const rule = await createRecurringRule({
      name: '往復確認ルール',
      amount: AMOUNT,
      dayOfMonth: 1,
      everyMonths: 1,
      debitAccountId: invest.id,
      creditAccountId: bank.id,
      startMonth: today.slice(0, 7),
      startDate: today,
    });

    render(
      <Providers>
        <Ready>
          <Allocations
            period={{ mode: 'all' }}
            onEditEntry={() => undefined}
            target={{ ruleId: rule.id }}
          />
        </Ready>
      </Providers>,
    );
    await waitFor(() => expect(q(UI.allocations.recurringSheet)).toBeInTheDocument());
    const input = q(UI.allocations.recurringAmount) as HTMLInputElement;
    expect(input.value).toBe(digits === 0 ? '1235' : '1234.56');

    fireEvent.click(q(UI.allocations.recurringSave)!);

    if (digits === 2) {
      // 値が変わらないのでそのまま保存され、確認シートも出ない。
      await waitFor(async () => {
        const after = (await loadLedger()).recurringRules.find((r) => r.id === rule.id)!;
        expect(after.amount).toBe(AMOUNT);
      });
      expect(q(UI.allocations.recurringAmountChangeDialog)).toBeNull();
      return;
    }

    // digits=0 では表示の丸め（1,234.56 → 1,235）で金額が変わるため、
    // **黙って保存せず「金額の変更方法」の確認シートを挟む**（定期ルールは過去へ遡及するため）。
    // 確認を出すまでルールは 1 バイトも変わらない = 意図しない遡及変更が起きない。
    await waitFor(() => {
      expect(q(UI.allocations.recurringAmountChangeDialog)).toBeInTheDocument();
    });
    const after = (await loadLedger()).recurringRules.find((r) => r.id === rule.id)!;
    expect(after.amount).toBe(AMOUNT);
  });
});

describe('保存値 → 表示 → 保存 が恒等になる金額（表示桁 2）', () => {
  it.each([1, 50, 99, 100, 101, 1234, 123456, 999999])('minor=%i は往復で不変', async (amount) => {
    await setDigits(2);
    const ledger = await loadLedger();
    const cash = ledger.accounts.find((a) => a.role === 'daily-asset')!;
    const expense = ledger.accounts.find((a) => a.role === 'expense-category')!;
    const entry: JournalEntry = {
      id: `identity-${amount}`,
      date: todayLocal(),
      description: `恒等${amount}`,
      kind: 'normal',
      lines: [
        { accountId: expense.id, side: 'debit', amount },
        { accountId: cash.id, side: 'credit', amount },
      ],
      metadata: { inputMode: 'expense' },
      createdAt: '2026-08-13T00:00:00.000Z',
      updatedAt: '2026-08-13T00:00:00.000Z',
    };
    await upsertEntry(entry);

    render(
      <Providers>
        <Ready>
          <EntrySheet init={{ kind: 'edit', entry }} onClose={() => undefined} />
        </Ready>
      </Providers>,
    );
    await waitFor(() => expect(q(UI.journal.entry.amount)).toBeInTheDocument());
    fireEvent.click(q(UI.journal.entry.save)!);
    await waitFor(async () => {
      const after = (await loadLedger()).journalEntries.find((e) => e.id === entry.id)!;
      expect(after.lines[0]!.amount).toBe(amount);
    });
    cleanup();
    _resetOverlaysForTests();
  });
});
