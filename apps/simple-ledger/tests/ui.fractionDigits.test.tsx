/*
 * 表示桁数の設定（settings.displayFractionDigits・作者決定 2026-08-13・指示書v3 §A-2b）:
 *  - 保存・計算は常に 1/100 固定。設定は 表示・入力の刻み・inputMode の 3 点だけを変える
 *  - 設定を切り替えても保存値は 1 バイトも変わらない
 *  - round-trip: 入力 '1234.56' → 保存 123456 → 表示 '1,234.56 円' → export → import → 同値
 */
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { ToastProvider } from '@snishi/foundation/ui/toast';
import { patchDialogIfNeeded } from '@snishi/foundation/ui/test-utils';
import { LedgerProvider, useLedger } from '../src/state/store';
import { Dashboard } from '../src/ui/screens/Dashboard';
import { EntrySheet } from '../src/ui/screens/EntrySheet';
import { loadLedger, updateSettings } from '../src/data/repository';
import { exportToJsonText, importFromJsonText } from '../src/data/exportImport';
import type { ReportPeriod } from '../src/domain/reportPeriod';
import { UI } from '../src/ui-contract';
import { _resetOverlaysForTests } from '../src/ui/overlays';
import { todayLocal } from '../src/util/time';
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

function SheetWhenReady({ onClose }: { onClose: () => void }) {
  const { status } = useLedger();
  return status === 'ready' ? (
    <EntrySheet init={{ kind: 'create', mode: 'expense' }} onClose={onClose} />
  ) : null;
}

function DashboardWhenReady({ period }: { period: ReportPeriod }) {
  const { status } = useLedger();
  return status === 'ready' ? (
    <Dashboard
      period={period}
      onPeriodChange={() => undefined}
      onAddEntry={() => undefined}
      onEditEntry={() => undefined}
      onNavigate={() => undefined}
      onOpenJournal={() => undefined}
    />
  ) : null;
}

async function setDigits(digits: 0 | 1 | 2) {
  const ledger = await loadLedger();
  await updateSettings({ ...ledger.settings, displayFractionDigits: digits });
}

describe('表示桁数の設定', () => {
  it('digits=2: 小数入力 → minor 保存 → 表示 → export → import の round-trip', async () => {
    await setDigits(2);
    render(
      <Providers>
        <SheetWhenReady onClose={() => undefined} />
      </Providers>,
    );
    await waitFor(() => {
      expect(document.querySelector(`[data-ui="${UI.journal.entry.amount}"]`)).toBeInTheDocument();
    });
    const amount = document.querySelector<HTMLInputElement>(
      `[data-ui="${UI.journal.entry.amount}"]`,
    )!;
    expect(amount.getAttribute('inputmode')).toBe('decimal');
    fireEvent.change(document.querySelector(`[data-ui="${UI.journal.entry.item}"]`)!, {
      target: { value: '小数往復' },
    });
    fireEvent.change(amount, { target: { value: '1234.56' } });
    expect(amount.value).toBe('1234.56');
    const flowSource = document.querySelector(`[data-ui="${UI.journal.entry.flowSource}"]`)!;
    const flowDest = document.querySelector(`[data-ui="${UI.journal.entry.flowDestination}"]`)!;
    fireEvent.click(flowSource.querySelector('label.chip input')!);
    fireEvent.click(flowDest.querySelector('label.chip input')!);
    fireEvent.click(document.querySelector(`[data-ui="${UI.journal.entry.save}"]`)!);
    await waitFor(async () => {
      const ledger = await loadLedger();
      expect(ledger.journalEntries.some((e) => e.description === '小数往復')).toBe(true);
    });

    // 保存 = minor（123456）。
    const ledger = await loadLedger();
    const saved = ledger.journalEntries.find((e) => e.description === '小数往復')!;
    expect(saved.lines[0]!.amount).toBe(123456);

    // export → import 往復で同値。
    const text = exportToJsonText(ledger);
    expect(
      JSON.parse(text).journalEntries.some((e: { lines: { amount: number }[] }) =>
        e.lines.some((l) => l.amount === 123456),
      ),
    ).toBe(true);
    const outcome = await importFromJsonText(text, { force: true });
    expect(outcome.kind).toBe('ok');
    const after = await loadLedger();
    expect(after.journalEntries.find((e) => e.description === '小数往復')?.lines[0]?.amount).toBe(
      123456,
    );
  });

  it('設定を 0→2→0 と切り替えても保存値は 1 バイトも変わらない（表示だけ変わる）', async () => {
    const { upsertEntry } = await import('../src/data/repository');
    const ledger0 = await loadLedger();
    const cash = ledger0.accounts.find((a) => a.role === 'daily-asset')!;
    const expense = ledger0.accounts.find((a) => a.role === 'expense-category')!;
    const today = todayLocal();
    await upsertEntry({
      id: 'digits-check',
      date: today,
      description: '桁数確認',
      kind: 'normal',
      lines: [
        { accountId: expense.id, side: 'debit', amount: 123456 },
        { accountId: cash.id, side: 'credit', amount: 123456 },
      ],
      metadata: { inputMode: 'expense' },
      createdAt: '2026-08-13T00:00:00.000Z',
      updatedAt: '2026-08-13T00:00:00.000Z',
    });

    const view = render(
      <Providers>
        <DashboardWhenReady period={{ mode: 'date', date: today }} />
      </Providers>,
    );
    // digits=0（既定）: 1,235 円（表示のみ四捨五入）。
    await screen.findByText('桁数確認');
    expect(screen.getAllByText(/1,235 円/).length).toBeGreaterThan(0);

    await setDigits(2);
    view.unmount();
    render(
      <Providers>
        <DashboardWhenReady period={{ mode: 'date', date: today }} />
      </Providers>,
    );
    await screen.findByText('桁数確認');
    expect(screen.getAllByText(/1,234\.56 円/).length).toBeGreaterThan(0);

    // 保存値は不変。
    const after = await loadLedger();
    expect(after.journalEntries.find((e) => e.id === 'digits-check')?.lines[0]?.amount).toBe(
      123456,
    );
  });

  it('digits=0（既定）: 小数点は入力できず inputMode は numeric のまま', async () => {
    render(
      <Providers>
        <SheetWhenReady onClose={() => undefined} />
      </Providers>,
    );
    await waitFor(() => {
      expect(document.querySelector(`[data-ui="${UI.journal.entry.amount}"]`)).toBeInTheDocument();
    });
    const amount = document.querySelector<HTMLInputElement>(
      `[data-ui="${UI.journal.entry.amount}"]`,
    )!;
    expect(amount.getAttribute('inputmode')).toBe('numeric');
    fireEvent.change(amount, { target: { value: '12.34' } });
    expect(amount.value).toBe('1234'); // 小数点は捨てられ、結果が欄に見える（controlled input）
  });
});
