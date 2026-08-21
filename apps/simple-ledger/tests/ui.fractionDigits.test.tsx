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
import { OnboardingSheet } from '../src/ui/OnboardingSheet';
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
      onOpenAllocations={() => undefined}
      onOpenEntry={() => undefined}
    />
  ) : null;
}

function OnboardingWhenReady() {
  const { status } = useLedger();
  return status === 'ready' ? <OnboardingSheet onClose={() => undefined} /> : null;
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
    // 取り込みは空台帳のみ（v13.9 項目 1）: 全削除 → 読み込みの正規手順で往復する。
    const { resetAll } = await import('../src/data/repository');
    await resetAll();
    const outcome = await importFromJsonText(text);
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

  it('digits=0（既定）: 貼り付けは整数部へ切り捨て、逐次入力の小数部は連結しない', async () => {
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
    // 小数点**以降**が捨てられる（'1234' にすると 100 倍の 1,234 になる）。
    expect(amount.value).toBe('12');

    fireEvent.change(amount, { target: { value: '' } });
    for (const value of ['1', '12', '12.', '12.3', '12.4']) {
      fireEvent.change(amount, { target: { value } });
    }
    // 12. の state を維持して小数キーを無視する。12.34 → 1234 へ連結しない。
    expect(amount.value).toBe('12.');
  });
});

/*
 * 初期残高の一括登録（オンボーディング）の入力欄。
 * ここは onChange で sanitizeAmountText を通した直後に、state 更新側でもう一度
 * [^\d] を落としており、表示桁 2 でも小数点が必ず消えていた（= 小数が入力できない）。
 * 整形の正本は sanitizeAmountText 一つ、が原則（amountText.ts）。
 */
describe('オンボーディングの金額欄も表示桁に従う', () => {
  it('digits=2: 小数が入力でき、minor で保存される', async () => {
    await setDigits(2);
    render(
      <Providers>
        <OnboardingWhenReady />
      </Providers>,
    );
    await waitFor(() => {
      expect(document.querySelector(`[data-ui="${UI.onboarding.view}"]`)).toBeInTheDocument();
    });
    const amount = document.querySelector<HTMLInputElement>(
      `input[data-ui="${UI.onboarding.amount}"]`,
    )!;
    expect(amount.getAttribute('inputmode')).toBe('decimal');
    fireEvent.change(amount, { target: { value: '1234.56' } });
    expect(amount.value).toBe('1234.56');

    fireEvent.click(document.querySelector(`[data-ui="${UI.onboarding.save}"]`)!);
    await waitFor(async () => {
      const after = await loadLedger();
      const opening = after.journalEntries.find((e) => e.kind === 'opening');
      expect(opening?.lines[0]?.amount).toBe(123456);
    });
  });

  it('digits=0: 小数点は落ちる（既定の挙動は変わらない）', async () => {
    await setDigits(0);
    render(
      <Providers>
        <OnboardingWhenReady />
      </Providers>,
    );
    await waitFor(() => {
      expect(document.querySelector(`[data-ui="${UI.onboarding.view}"]`)).toBeInTheDocument();
    });
    const amount = document.querySelector<HTMLInputElement>(
      `input[data-ui="${UI.onboarding.amount}"]`,
    )!;
    expect(amount.getAttribute('inputmode')).toBe('numeric');
    fireEvent.change(amount, { target: { value: '1234.56' } });
    // 小数点以降を捨てる。'123456'（= 100 倍）にしてはいけない。
    expect(amount.value).toBe('1234');
  });
});

/*
 * 全額移動（口座の終了・継続コスト台帳の引き上げ）の金額欄。
 * 保存側は「残高ちょうど」でなければ弾く（error.account.archiveBalance）ため、
 * 表示桁を 0 にしていても端数を削って見せてはいけない。
 * 削ると、画面上は正しく見えるのに保存できない行き止まりになる。
 */
describe('全額移動の固定金額は表示桁より優先して端数まで見せる', () => {
  function FixedTransferWhenReady({ amount }: { amount: number }) {
    const { status, ledger } = useLedger();
    const account = ledger?.accounts.find((a) => a.role === 'daily-asset');
    return status === 'ready' && account ? (
      <EntrySheet
        init={{
          kind: 'transfer-fixed',
          fixed: {
            side: 'credit',
            accountId: account.id,
            amount,
            date: todayLocal(),
            onSave: async () => undefined,
          },
        }}
        onClose={() => undefined}
      />
    ) : null;
  }

  it('digits=0 でも端数のある残高は 1234.56 のまま出す（保存値と一致させる）', async () => {
    await setDigits(0);
    render(
      <Providers>
        <FixedTransferWhenReady amount={123456} />
      </Providers>,
    );
    await waitFor(() => {
      expect(document.querySelector(`[data-ui="${UI.journal.entry.amount}"]`)).toBeInTheDocument();
    });
    const amount = document.querySelector<HTMLInputElement>(
      `[data-ui="${UI.journal.entry.amount}"]`,
    )!;
    expect(amount.value).toBe('1234.56');
    // 端数を打ち直せるよう inputMode も decimal へ寄せる。
    expect(amount.getAttribute('inputmode')).toBe('decimal');
  });

  it('端数の無い残高は表示桁のまま（digits=0 なら整数表示）', async () => {
    await setDigits(0);
    render(
      <Providers>
        <FixedTransferWhenReady amount={123400} />
      </Providers>,
    );
    await waitFor(() => {
      expect(document.querySelector(`[data-ui="${UI.journal.entry.amount}"]`)).toBeInTheDocument();
    });
    const amount = document.querySelector<HTMLInputElement>(
      `[data-ui="${UI.journal.entry.amount}"]`,
    )!;
    expect(amount.value).toBe('1234');
    expect(amount.getAttribute('inputmode')).toBe('numeric');
  });
});
