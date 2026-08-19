/*
 * ヘッダーの「今日」ボタン（作者決定 2026-08-14）:
 *  - タイムスリップ中（ヘッダーの日付 ≠ 今日）**だけ**現れる＝ずれの警告灯を兼ねる。
 *  - 押すと日付だけを今日へ戻す。画面もズームも動かさない（動作であって状態ではない）。
 */
import { describe, it, expect, afterEach, beforeAll, beforeEach } from 'vitest';
import { render, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { ToastProvider } from '@snishi/foundation/ui/toast';
import { patchDialogIfNeeded } from '@snishi/foundation/ui/test-utils';
import { App } from '../src/App';
import { LedgerProvider } from '../src/state/store';
import { clearOnboardingDone, markOnboardingDone } from '../src/data/localFlags';
import { _resetOverlaysForTests } from '../src/ui/overlays';
import { createOpening, loadLedger } from '../src/data/repository';
import { todayLocal } from '../src/util/time';
import { UI } from '../src/ui-contract';
import './setup';

beforeAll(() => {
  patchDialogIfNeeded();
});

beforeEach(() => {
  markOnboardingDone();
});

afterEach(() => {
  cleanup();
  _resetOverlaysForTests();
  clearOnboardingDone();
});

const q = (dataUi: string) => document.querySelector(`[data-ui="${dataUi}"]`);

async function renderApp() {
  render(
    <ToastProvider>
      <LedgerProvider>
        <App />
      </LedgerProvider>
    </ToastProvider>,
  );
  await waitFor(() => {
    expect(q(UI.dashboard.view)).toBeInTheDocument();
  });
}

const slipTo = (date: string) => {
  fireEvent.change(q(UI.period.dateInput)!, { target: { value: date } });
};

describe('ヘッダーの「今日」ボタン', () => {
  it('今日にいる間は出ず、タイムスリップすると現れ、押すと今日へ戻って消える', async () => {
    await renderApp();
    expect(q(UI.period.today)).toBeNull();

    slipTo('2019-11-30');
    expect(q(UI.period.today)).toBeInTheDocument();
    expect(q(UI.period.dateTrigger)).toHaveTextContent('2019-11-30');

    fireEvent.click(q(UI.period.today)!);
    expect(q(UI.period.today)).toBeNull();
    expect(q(UI.period.dateTrigger)).toHaveTextContent(todayLocal());
  });

  it('日付だけを戻す（画面は動かさない）', async () => {
    await renderApp();
    // 設定画面へ移動してからタイムスリップ → 今日 → 設定画面のまま。
    fireEvent.click(q(UI.nav.menuButton)!);
    await waitFor(() => expect(q(UI.nav.menu)).toBeInTheDocument());
    fireEvent.click(q('nav.settings')!);
    await waitFor(() => expect(q(UI.settings.view)).toBeInTheDocument());

    slipTo('2019-11-30');
    fireEvent.click(q(UI.period.today)!);
    expect(q(UI.settings.view)).toBeInTheDocument();
    expect(q(UI.period.today)).toBeNull();
  });

  it('時間平面ではズームを据え置いたまま、日付だけを今日へ戻す', async () => {
    // 表は仕訳ゼロだと空状態になるため、2019 年のデータを 1 件だけ置く。
    const ledger = await loadLedger();
    const cash = ledger.accounts.find((a) => a.role === 'daily-asset')!;
    await createOpening({ accountId: cash.id, amount: 1000, date: '2019-06-01' });
    await renderApp();
    slipTo('2019-06-15');
    fireEvent.click(q(UI.period.zoomYear)!);
    await waitFor(() => expect(q(UI.timeline.view)).toBeInTheDocument());
    expect(q(UI.timeline.view)).toHaveTextContent('2019年');

    fireEvent.click(q(UI.period.today)!);
    expect(q(UI.period.dateTrigger)).toHaveTextContent(todayLocal());
    // ズームは据え置き（年のまま）。時間平面に居るので点灯も続く。
    expect(q(UI.period.zoomYear)).toHaveAttribute('aria-pressed', 'true');
    expect(q(UI.timeline.view)).toBeInTheDocument();
  });
});
