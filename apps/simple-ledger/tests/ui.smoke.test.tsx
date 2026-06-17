/*
 * UI スモークテスト。
 * Dashboard / Journal / Settings が LedgerProvider + ToastProvider 下で
 * クラッシュせずにレンダリングされること、主要な data-ui 属性が存在することを確認する。
 */
import { describe, it, expect, afterEach, beforeAll } from 'vitest';
import { render, cleanup, waitFor } from '@testing-library/react';
import { Dashboard } from '../src/ui/screens/Dashboard';
import { Journal } from '../src/ui/screens/Journal';
import { Settings } from '../src/ui/screens/Settings';
import { LedgerProvider } from '../src/state/store';
import { ToastProvider } from '@snishi/foundation/ui/toast';
import { patchDialogIfNeeded } from '@snishi/foundation/ui/test-utils';
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
          period={{ mode: 'month', year: 2025, month: 1 }}
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
          filter={null}
          period={{ mode: 'month', year: 2025, month: 1 }}
          onClearAccountFilter={() => undefined}
        />
      </Providers>,
    );
    await waitFor(() => {
      expect(document.querySelector('[data-ui="journal.view"]')).toBeInTheDocument();
    });
    expect(document.querySelector('[data-ui="journal.search"]')).toBeInTheDocument();
  });
});

// ---------- Settings ----------
describe('Settings スモーク', () => {
  it('data-ui=settings があり、エクスポートボタンが表示される', async () => {
    render(
      <Providers>
        <Settings onNavigate={() => undefined} />
      </Providers>,
    );
    await waitFor(() => {
      expect(document.querySelector('[data-ui="settings.view"]')).toBeInTheDocument();
    });
    expect(document.querySelector('[data-ui="settings.exportJson"]')).toBeInTheDocument();
    expect(document.querySelector('[data-ui="settings.importJson"]')).toBeInTheDocument();
  });
});
