/*
 * mutation 検証（3 レンズ共通の枠・v13.7 I1）。
 *
 * 「ラベル列は左・目盛り行は上・左上の隅は両方・描画部は横だけ」は CSS の規則で、
 * どの要素がどの役割かを名乗るのは `src/ui/components/LensFrame.ts` の `LENS_FRAME` が
 * **単一の正本**。3 つのレンズ（線分 / 数値 / グラフ）はどれもその名前を着るだけで、
 * 自前の class 名を書かない。
 *
 * ここではテスト内で **`LENS_FRAME` の中身を入れ替える**。どれかのレンズが役割の class を
 * 直書きしていれば、入れ替えに追従せず（＝本物の class 名が DOM に残って）落ちる。
 *
 * jsdom は sticky も touch-action も評価しないので、貼りつき自体は実ブラウザの e2e
 * （「3 レンズとも ラベル列・目盛り行・左上の隅が貼りつく」）が見る。ここで固定するのは
 * **役割の名乗りが 1 か所から来ていること**だけ。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import type { Account, JournalEntry, Ledger } from '../src/domain/types';
import { SCHEMA_VERSION } from '../src/domain/constants';
import './setup';

const ledgerState = vi.hoisted(() => ({ ledger: null as Ledger | null }));

/** 入れ替え後の役割名。本物（`lens-frame__*`）と 1 文字も重ならない値にする。 */
const MUTATED = vi.hoisted(() => ({
  viewport: 'zzz-window',
  head: 'zzz-ticks',
  corner: 'zzz-origin',
  pane: 'zzz-canvas',
}));

vi.mock('../src/state/store', () => ({
  useLedger: () => ({ ledger: ledgerState.ledger }),
  useOptionalLedger: () => ({ ledger: ledgerState.ledger }),
}));

vi.mock('../src/ui/components/LensFrame', async () => {
  const actual = await vi.importActual<typeof import('../src/ui/components/LensFrame')>(
    '../src/ui/components/LensFrame',
  );
  // 窓そのもの（LensFrame コンポーネント）は本物のまま。差し替えるのは**役割の名前**だけで、
  // レンズ側がその名前を使っているかを見る。
  return { ...actual, LENS_FRAME: MUTATED };
});

const { TimelineCalendar } = await import('../src/ui/screens/TimelineCalendar');
type TimelineLens = import('../src/ui/screens/TimelineCalendar').TimelineLens;

function account(id: string, name: string, type: Account['type'], role: Account['role']): Account {
  return { id, name, type, role, archived: false, createdAt: 'x', updatedAt: 'x' };
}

function entry(
  id: string,
  date: string,
  debitAccountId: string,
  creditAccountId: string,
  amount: number,
): JournalEntry {
  return {
    id,
    date,
    description: id,
    kind: 'normal',
    lines: [
      { accountId: debitAccountId, side: 'debit', amount },
      { accountId: creditAccountId, side: 'credit', amount },
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
    journalEntries: [
      entry('opening', '2000-01-01', 'cash', 'equity', 10_000_000),
      entry('window-expense', '2026-05-10', 'food', 'cash', 3_000),
    ],
    monthlyCostItems: [],
    recurringRules: [],
  };
}

function renderTimeline(lens: TimelineLens) {
  return render(
    <TimelineCalendar
      period={{ mode: 'date', date: '2026-07-15' }}
      zoom="month"
      onZoomChange={() => undefined}
      lens={lens}
      onLensChange={() => undefined}
      onPeriodChange={() => undefined}
      onNavigate={() => undefined}
      onOpenEntry={() => undefined}
      onOpenAllocations={() => undefined}
      onOpenAccount={() => undefined}
    />,
  );
}

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

const LENSES: TimelineLens[] = ['segment', 'matrix', 'chart'];

describe('枠の役割（目盛り行・隅・描画部）は 3 レンズ共通の正本から来る', () => {
  for (const lens of LENSES) {
    it(`${lens}: 目盛り行・左上の隅・描画部が正本の名前を着ている`, () => {
      renderTimeline(lens);
      expect(
        document.querySelectorAll(`.${MUTATED.head}`).length,
        `${lens}: 目盛り行が無い`,
      ).toBeGreaterThan(0);
      expect(
        document.querySelectorAll(`.${MUTATED.corner}`).length,
        `${lens}: 左上の隅が無い`,
      ).toBeGreaterThan(0);
      expect(
        document.querySelectorAll(`.${MUTATED.pane}`).length,
        `${lens}: 描画部が無い`,
      ).toBeGreaterThan(0);
    });

    it(`${lens}: 役割の class を直書きしていない`, () => {
      renderTimeline(lens);
      for (const real of ['lens-frame__head', 'lens-frame__corner', 'lens-frame__pane']) {
        expect(
          document.querySelectorAll(`.${real}`).length,
          `${lens}: ${real} を直書きしている（正本の入れ替えに追従しない）`,
        ).toBe(0);
      }
    });

    it(`${lens}: 左上の隅は目盛り行の中にある（縦にも横にも貼る点が 1 つある）`, () => {
      renderTimeline(lens);
      const corners = [...document.querySelectorAll(`.${MUTATED.corner}`)];
      const inHead = corners.filter(
        (corner) => corner.classList.contains(MUTATED.head) || corner.closest(`.${MUTATED.head}`),
      );
      expect(inHead.length, `${lens}: 隅が目盛り行の外にある = 縦に送ると消える`).toBeGreaterThan(
        0,
      );
    });
  }
});
