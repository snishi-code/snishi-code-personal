/*
 * ヘッダーの 日/月/年（時間平面のズーム）— v13.5 D の作者決定:
 *  - **点灯 = ウィンドウ世界の名乗り**。ズーム対応画面（時間平面・資金繰り）に居るときだけ
 *    現在ズームが点灯し、断面画面ではすべて消灯する。
 *  - 断面画面でタップすると時間平面へ移動して、そのズームで点灯する
 *    （旧「別画面なら移動・当画面なら切替」= openOverview の一般化）。
 *  - ズームは**日付を変えない**（タイムスリップはヘッダーの日付だけ）。
 *  - 数値レンズに日の列は無い = レンズが数値のとき「日」は押せず、理由を読み上げにも出す。
 */
import { describe, it, expect, afterEach, beforeAll, beforeEach } from 'vitest';
import { render, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { ToastProvider } from '@snishi/foundation/ui/toast';
import { patchDialogIfNeeded } from '@snishi/foundation/ui/test-utils';
import { App } from '../src/App';
import { LedgerProvider } from '../src/state/store';
import { clearOnboardingDone, markOnboardingDone } from '../src/data/localFlags';
import { _resetOverlaysForTests } from '../src/ui/overlays';
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
const zoomButtons = () => [UI.period.zoomDay, UI.period.zoomMonth, UI.period.zoomYear].map(q);
const pressed = () =>
  zoomButtons()
    .filter((button) => button?.getAttribute('aria-pressed') === 'true')
    .map((button) => button?.textContent);

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

async function openMenuItem(dataUi: string) {
  fireEvent.click(q(UI.nav.menuButton)!);
  await waitFor(() => expect(q(UI.nav.menu)).toBeInTheDocument());
  fireEvent.click(q(dataUi)!);
}

describe('ヘッダーのズーム（日/月/年）', () => {
  it('ヘッダーに 3 つ並び、断面画面ではどれも点灯しない', async () => {
    await renderApp();
    expect(zoomButtons().every((button) => button !== null)).toBe(true);
    expect(pressed()).toEqual([]);

    // 月割り台帳（断面画面）でも消灯のまま。
    await openMenuItem('nav.allocations');
    await waitFor(() => expect(q(UI.allocations.view)).toBeInTheDocument());
    expect(pressed()).toEqual([]);
  });

  it('断面画面から押すと時間平面へ移動して、そのズームで点灯する', async () => {
    await renderApp();

    fireEvent.click(q(UI.period.zoomYear)!);
    await waitFor(() => expect(q(UI.timeline.view)).toBeInTheDocument());
    expect(pressed()).toEqual(['年']);
  });

  it('ズーム対応画面の間は点灯し、画面を離れると消灯する（状態は覚えている）', async () => {
    await renderApp();
    fireEvent.click(q(UI.period.zoomYear)!);
    await waitFor(() => expect(q(UI.timeline.view)).toBeInTheDocument());

    // 資金繰りもウィンドウ世界（同じズームで点灯し続ける）。
    await openMenuItem('nav.cashflow');
    await waitFor(() => expect(q(UI.cashflow.view)).toBeInTheDocument());
    expect(pressed()).toEqual(['年']);

    // 勘定科目は断面画面 = 消灯。ズームの値そのものは失われない。
    await openMenuItem('nav.accounts');
    await waitFor(() => expect(q(UI.accounts.view)).toBeInTheDocument());
    expect(pressed()).toEqual([]);

    await openMenuItem('nav.timeline');
    await waitFor(() => expect(q(UI.timeline.view)).toBeInTheDocument());
    expect(pressed()).toEqual(['年']);
  });

  it('ズームは日付を変えない（タイムスリップはヘッダーの日付だけ）', async () => {
    await renderApp();
    const today = todayLocal();

    fireEvent.click(q(UI.period.zoomYear)!);
    await waitFor(() => expect(q(UI.timeline.view)).toBeInTheDocument());
    expect(q(UI.period.dateTrigger)).toHaveTextContent(today);
    // 日付が動いていないので「今日」ボタン（ずれの警告灯）も出ない。
    expect(q(UI.period.today)).toBeNull();
  });

  it('数値レンズでは「日」を押せず、理由を読み上げに出す', async () => {
    await renderApp();
    fireEvent.click(q(UI.period.zoomMonth)!);
    await waitFor(() => expect(q(UI.timeline.view)).toBeInTheDocument());
    expect(q(UI.period.zoomDay)).not.toBeDisabled();

    fireEvent.click(q(UI.timeline.lensMatrix)!);
    await waitFor(() => expect(q(UI.timeline.matrix)).toBeInTheDocument());
    expect(q(UI.period.zoomDay)).toBeDisabled();
    expect(q(UI.period.zoomDay)).toHaveAccessibleName('日（数値では選べません）');

    // 線分へ戻せば また押せる。
    fireEvent.click(q(UI.timeline.lensSegment)!);
    await waitFor(() => expect(q(UI.timeline.viewport)).toBeInTheDocument());
    expect(q(UI.period.zoomDay)).not.toBeDisabled();
  });

  it('日ズームのまま数値レンズへ切り替えたら月へ丸める', async () => {
    await renderApp();
    fireEvent.click(q(UI.period.zoomDay)!);
    await waitFor(() => expect(q(UI.timeline.view)).toBeInTheDocument());
    expect(pressed()).toEqual(['日']);

    fireEvent.click(q(UI.timeline.lensMatrix)!);
    await waitFor(() => expect(q(UI.timeline.matrix)).toBeInTheDocument());
    // 日の列を作らず、押せない「日」が点灯したままにもしない。
    expect(pressed()).toEqual(['月']);
    expect(q(UI.period.zoomDay)).toBeDisabled();
  });
});
