/*
 * UI スモークテスト。
 * Dashboard / Journal / Settings が LedgerProvider + ToastProvider 下で
 * クラッシュせずにレンダリングされること、主要な data-ui 属性が存在することを確認する。
 */
import { describe, it, expect, afterEach, beforeAll } from 'vitest';
import { render, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { Dashboard } from '../src/ui/screens/Dashboard';
import { Journal } from '../src/ui/screens/Journal';
import { Settings } from '../src/ui/screens/Settings';
import { LedgerProvider } from '../src/state/store';
import { ToastProvider } from '@snishi/foundation/ui/toast';
import { patchDialogIfNeeded } from '@snishi/foundation/ui/test-utils';
import { buildExportPackage } from '../src/data/exportImport';
import { loadLedger, makeSnapshotId, saveSnapshot } from '../src/data/repository';
import './setup';

beforeAll(() => {
  patchDialogIfNeeded();
});

afterEach(() => {
  cleanup();
});

/** プロバイダ込みのラッパー */
function Providers({ children }: { children: React.ReactNode }) {
  return (
    <ToastProvider>
      <LedgerProvider>{children}</LedgerProvider>
    </ToastProvider>
  );
}

// ---------- Dashboard ----------
describe('Dashboard スモーク', () => {
  it('data-ui=dashboard があり、収入/支出/振替ボタンが表示される', async () => {
    render(
      <Providers>
        <Dashboard
          period={{ mode: 'date', date: '2025-01-31' }}
          onPeriodChange={() => undefined}
          onAddEntry={() => undefined}
          onEditEntry={() => undefined}
          onNavigate={() => undefined}
          onOpenJournal={() => undefined}
        />
      </Providers>,
    );
    // LedgerProvider は非同期ロードするので waitFor
    await waitFor(() => {
      expect(document.querySelector('[data-ui="dashboard.view"]')).toBeInTheDocument();
    });
    // 入力タイプボタン（収入/支出/振替）
    expect(document.querySelector('[data-ui="dashboard.entry.income"]')).toBeInTheDocument();
    expect(document.querySelector('[data-ui="dashboard.entry.expense"]')).toBeInTheDocument();
    expect(document.querySelector('[data-ui="dashboard.entry.transfer"]')).toBeInTheDocument();
  });
});

// ---------- Journal ----------
describe('Journal スモーク', () => {
  it('data-ui=journal があり、検索ボックスが表示される', async () => {
    render(
      <Providers>
        <Journal
          onEditEntry={() => undefined}
          onReverse={() => undefined}
          onOpenAllocations={() => undefined}
          onOpenAccount={() => undefined}
          filter={null}
          period={{ mode: 'date', date: '2025-01-31' }}
          onClearFilter={() => undefined}
        />
      </Providers>,
    );
    await waitFor(() => {
      expect(document.querySelector('[data-ui="journal.view"]')).toBeInTheDocument();
    });
    expect(document.querySelector('[data-ui="journal.search"]')).toBeInTheDocument();
    expect(document.querySelector('#journal-from')).toHaveValue('2025-01-01');
    expect(document.querySelector('#journal-to')).toHaveValue('2025-01-31');
  });
});

// ---------- Settings ----------
describe('Settings スモーク', () => {
  it('data-ui=settings があり、エクスポートボタンが表示される', async () => {
    render(
      <Providers>
        <Settings onNavigate={() => undefined} onOpenOnboarding={() => undefined} />
      </Providers>,
    );
    await waitFor(() => {
      expect(document.querySelector('[data-ui="settings.view"]')).toBeInTheDocument();
    });
    expect(document.querySelector('[data-ui="settings.exportJson"]')).toBeInTheDocument();
    expect(document.querySelector('[data-ui="settings.importJson"]')).toBeInTheDocument();
  });

  it('空の台帳名・金額単位を旧値や既定値へ差し替えず、欄ごとのエラーで保存を止める', async () => {
    const before = await loadLedger();
    render(
      <Providers>
        <Settings onNavigate={() => undefined} onOpenOnboarding={() => undefined} />
      </Providers>,
    );

    const ledgerName = await screen.findByLabelText(/台帳名/);
    const currency = screen.getByLabelText(/金額の単位/);
    fireEvent.change(ledgerName, { target: { value: '   ' } });
    fireEvent.change(currency, { target: { value: '   ' } });
    fireEvent.click(screen.getByRole('button', { name: '保存' }));

    expect(await screen.findByText('台帳名を入力してください。')).toBeInTheDocument();
    expect(screen.getByText('金額の単位を入力してください。')).toBeInTheDocument();
    expect(ledgerName).toHaveAttribute('aria-invalid', 'true');
    expect(currency).toHaveAttribute('aria-invalid', 'true');
    const after = await loadLedger();
    expect(after.settings).toEqual(before.settings);
  });

  it('スナップショット削除の確認にも理由コードではなく翻訳済み文言を出す', async () => {
    const ledger = await loadLedger();
    await saveSnapshot(
      {
        id: makeSnapshotId(),
        createdAt: '2026-08-13T00:00:00.000Z',
        reason: 'import',
        data: buildExportPackage(ledger),
      },
      { deviceId: ledger.meta.deviceId, revision: ledger.meta.revision },
    );
    render(
      <Providers>
        <Settings onNavigate={() => undefined} onOpenOnboarding={() => undefined} />
      </Providers>,
    );

    fireEvent.click(await screen.findByRole('button', { name: '削除: import前' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('import前')).toBeInTheDocument();
    expect(within(dialog).queryByText('import')).not.toBeInTheDocument();
  });
});
