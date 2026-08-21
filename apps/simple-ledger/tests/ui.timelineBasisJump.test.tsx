/*
 * タイムラインの「{基準日} へ戻る」（v13.7 I2）。
 *
 * ヘッダーの「今日」= **断面**を今日へ戻す、はそのまま。こちらは窓をスクロールして
 * 遠くへ行ったときに、**見ている位置だけ**を基準日（ヘッダーの断面日付）へ戻す。
 *
 * 固定するのは 3 つ:
 *  - 基準日が見えている間は出さない（常時表示ではなく警告灯型）。
 *  - 窓を送って基準日が可視範囲の外へ出たら現れる。
 *  - 押すと窓が基準日のところへ戻り、**断面（period）は動かない**。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render } from '@testing-library/react';
import type { Account, JournalEntry, Ledger } from '../src/domain/types';
import { SCHEMA_VERSION } from '../src/domain/constants';
import { UI } from '../src/ui-contract';
import type { ReportPeriod } from '../src/domain/reportPeriod';
import './setup';

const ledgerState = vi.hoisted(() => ({ ledger: null as Ledger | null }));

vi.mock('../src/state/store', () => ({
  useLedger: () => ({ ledger: ledgerState.ledger }),
  useOptionalLedger: () => ({ ledger: ledgerState.ledger }),
}));

const { TimelineCalendar } = await import('../src/ui/screens/TimelineCalendar');

function account(id: string, name: string, type: Account['type'], role: Account['role']): Account {
  return { id, name, type, role, archived: false, createdAt: 'x', updatedAt: 'x' };
}

function entry(id: string, date: string, amount: number): JournalEntry {
  return {
    id,
    date,
    description: id,
    kind: 'normal',
    lines: [
      { accountId: 'food', side: 'debit', amount },
      { accountId: 'cash', side: 'credit', amount },
    ],
    createdAt: 'x',
    updatedAt: 'x',
  };
}

function fixtureLedger(): Ledger {
  return {
    meta: {
      id: 'ledger',
      schemaVersion: SCHEMA_VERSION,
      revision: 1,
      deviceId: 'device',
      createdAt: 'x',
      updatedAt: 'x',
    },
    settings: { ledgerName: 'test', currency: 'JPY', displayFractionDigits: 0 },
    accounts: [
      account('cash', '預金', 'asset', 'daily-asset'),
      account('equity', '元手', 'equity', 'equity'),
      account('food', '食費', 'expense', 'expense-category'),
    ],
    journalEntries: [entry('window-expense', '2026-05-10', 3_000)],
    monthlyCostItems: [],
    recurringRules: [],
  };
}

const BASIS = '2026-07-15';

function renderTimeline(period: ReportPeriod = { mode: 'date', date: BASIS }) {
  const periodChanges: ReportPeriod[] = [];
  const view = render(
    <TimelineCalendar
      period={period}
      zoom="month"
      onZoomChange={() => undefined}
      lens="segment"
      onLensChange={() => undefined}
      onPeriodChange={(next) => periodChanges.push(next)}
      onNavigate={() => undefined}
      onOpenEntry={() => undefined}
      onOpenAllocations={() => undefined}
    />,
  );
  return { view, periodChanges };
}

const jumpButton = () => document.querySelector(`[data-ui="${UI.timeline.backToBasis}"]`);

/** いま描いている窓の左端・右端（線分レンズのヘッダー「年」行）。 */
function windowEdges(): { from: string; to: string } {
  const cells = [
    ...document.querySelectorAll('.timeline-calendar__header-row:first-child > *'),
  ].slice(1);
  return { from: cells[0]?.textContent ?? '', to: cells.at(-1)?.textContent ?? '' };
}

const clickNext = () => {
  act(() => {
    fireEvent.click(document.querySelector(`[data-ui="${UI.timeline.next}"]`)!);
  });
};

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(2026, 6, 15, 12));
  ledgerState.ledger = fixtureLedger();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  ledgerState.ledger = null;
});

describe('タイムラインの「基準日へ戻る」', () => {
  it('基準日が見えている間は出さない', () => {
    renderTimeline();
    expect(jumpButton(), '基準日が可視範囲の中なのにボタンが出ている').toBeNull();
  });

  it('窓を送って基準日が可視範囲の外へ出ると現れる（基準日を名乗る）', () => {
    renderTimeline();
    // 月ズームの窓は中心の ±18 か月ぶん。2 回送れば基準日は窓の外へ出る。
    clickNext();
    clickNext();
    const button = jumpButton();
    expect(button, '基準日が外に出てもボタンが出ない').not.toBeNull();
    expect(button).toHaveTextContent(BASIS);
  });

  it('押すと窓が基準日のところへ戻り、断面（period）は動かさない', () => {
    const { periodChanges } = renderTimeline();
    const initial = windowEdges();

    clickNext();
    clickNext();
    expect(windowEdges(), '「次へ」で窓が動いていない').not.toEqual(initial);

    act(() => {
      fireEvent.click(jumpButton()!);
    });
    expect(windowEdges(), '基準日のところへ窓が戻っていない').toEqual(initial);
    expect(jumpButton(), '戻ったのにボタンが残っている').toBeNull();
    expect(periodChanges, 'スクロール位置だけのはずが断面まで動かした').toEqual([]);
  });

  it('日付以外の断面（全期間）でも、ヘッダーと同じ「今日」を基準日として名乗る', () => {
    renderTimeline({ mode: 'all' });
    clickNext();
    clickNext();
    expect(jumpButton()).toHaveTextContent('2026-07-15');
  });
});
