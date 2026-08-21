/*
 * mutation 検証（連続スクロールの端判定・v13.6 H2-3）。
 *
 * 端に近づいたかの判断は `src/ui/scrollWindow.ts` の `edgeToExtend` が単一正本で、
 * 3 つのレンズ（線分 / 数値 / グラフ）はどれもその答えに従う。
 * ここではテスト内で **`edgeToExtend` の答えを入れ替える**（start ⇄ end を反転する / 常に
 * undefined にする）。どのレンズかが独自の端判定を持っていれば、反転に追従せず落ちる。
 *
 * jsdom は clientWidth / scrollWidth を 0 にするので、実寸から端を判定させることはできない
 * （実ブラウザでの挙動は e2e の「タイムラインは端に近づくと窓が自動で伸びる」が見る）。
 * ここで固定するのは**配線**: どのレンズも正本の答えどおりの側へ窓を伸ばすこと。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useState } from 'react';
import { act, cleanup, fireEvent, render } from '@testing-library/react';
import type { Account, JournalEntry, Ledger } from '../src/domain/types';
import { SCHEMA_VERSION } from '../src/domain/constants';
import { UI } from '../src/ui-contract';
import './setup';

const ledgerState = vi.hoisted(() => ({ ledger: null as Ledger | null }));
/** 端判定の答えを差し替えるつまみ（`'flip'` = start ⇄ end を反転 / `'none'` = 端なし）。 */
const edgeMode = vi.hoisted(() => ({ value: 'flip' as 'flip' | 'none' }));

vi.mock('../src/state/store', () => ({
  useLedger: () => ({ ledger: ledgerState.ledger }),
  useOptionalLedger: () => ({ ledger: ledgerState.ledger }),
}));

vi.mock('../src/ui/scrollWindow', async () => {
  const actual =
    await vi.importActual<typeof import('../src/ui/scrollWindow')>('../src/ui/scrollWindow');
  return {
    ...actual,
    // jsdom では実寸が 0 なので、本物は必ず undefined を返す。ここが唯一の判断点であることを
    // 使って、答えだけを差し替える（呼び出し側の配線だけがテスト対象になる）。
    edgeToExtend: (): 'start' | 'end' | undefined =>
      edgeMode.value === 'none' ? undefined : scrollSide.value === 'start' ? 'end' : 'start',
  };
});

/** テストが「どちらへスクロールしたつもりか」。mock はこれを**反転して**返す。 */
const scrollSide = vi.hoisted(() => ({ value: 'start' as 'start' | 'end' }));

const { TimelineCalendar } = await import('../src/ui/screens/TimelineCalendar');
type TimelineLens = import('../src/ui/screens/TimelineCalendar').TimelineLens;
type TimelineZoom = import('../src/ui/screens/TimelineCalendar').TimelineZoom;

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
      // 下限（データのある最初の年）を十分過去に置く = 左へも伸ばせる台帳にする。
      entry('opening', '2000-01-01', 'cash', 'equity', 10_000_000),
      entry('window-expense', '2026-05-10', 'food', 'cash', 3_000),
    ],
    monthlyCostItems: [],
    recurringRules: [],
  };
}

function renderTimeline(lens: TimelineLens, zoom: TimelineZoom = 'month') {
  function Harness() {
    const [currentZoom, setZoom] = useState<TimelineZoom>(zoom);
    return (
      <TimelineCalendar
        period={{ mode: 'date', date: '2026-07-15' }}
        zoom={currentZoom}
        onZoomChange={setZoom}
        lens={lens}
        onLensChange={() => undefined}
        onPeriodChange={() => undefined}
        onNavigate={() => undefined}
        onOpenEntry={() => undefined}
        onOpenAllocations={() => undefined}
      />
    );
  }
  return render(<Harness />);
}

/** レンズごとの「いま描いている窓」（左端・右端）を DOM から読む。 */
const WINDOW_PROBE: Record<TimelineLens, () => { from: string; to: string }> = {
  // 線分レンズ: ヘッダーの「年」行の最初と最後のセル（例 '2025年'）。
  segment: () => {
    const cells = [
      ...document.querySelectorAll('.timeline-calendar__header-row:first-child > *'),
    ].slice(1);
    return {
      from: cells[0]?.textContent ?? '',
      to: cells.at(-1)?.textContent ?? '',
    };
  },
  // 数値レンズ / グラフレンズ: 枠の aria-label が「{from} 〜 {to}」を名乗る。
  matrix: () => labelRange(UI.timeline.matrix),
  chart: () => labelRange(UI.timeline.chartViewport),
};

function labelRange(dataUi: string): { from: string; to: string } {
  const label = document.querySelector(`[data-ui="${dataUi}"]`)?.getAttribute('aria-label') ?? '';
  const [from = '', to = ''] = label.split('〜').map((part) => part.trim());
  return { from, to };
}

function viewportOf(lens: TimelineLens): HTMLElement {
  const dataUi =
    lens === 'matrix'
      ? UI.timeline.matrix
      : lens === 'chart'
        ? UI.timeline.chartViewport
        : UI.timeline.viewport;
  return document.querySelector(`[data-ui="${dataUi}"]`) as HTMLElement;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(2026, 6, 15, 12));
  ledgerState.ledger = fixtureLedger();
  edgeMode.value = 'flip';
  scrollSide.value = 'start';
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  ledgerState.ledger = null;
});

const LENSES: TimelineLens[] = ['segment', 'matrix', 'chart'];

describe('連続スクロールの端判定は 3 レンズ共通の正本に従う', () => {
  for (const lens of LENSES) {
    it(`${lens}: 正本が 'end' と言えば未来側だけが伸びる`, () => {
      renderTimeline(lens);
      const before = WINDOW_PROBE[lens]();
      // 左へ寄せたつもり → mock は反転して 'end' を返す。独自判定なら 'start' 側が伸びる。
      scrollSide.value = 'start';
      act(() => {
        fireEvent.scroll(viewportOf(lens));
      });
      const after = WINDOW_PROBE[lens]();
      expect(after.to, `${lens}: 未来側が伸びていない`).not.toBe(before.to);
      expect(after.from, `${lens}: 過去側まで動いた`).toBe(before.from);
    });

    it(`${lens}: 正本が 'start' と言えば過去側だけが伸びる`, () => {
      renderTimeline(lens);
      const before = WINDOW_PROBE[lens]();
      scrollSide.value = 'end';
      act(() => {
        fireEvent.scroll(viewportOf(lens));
      });
      const after = WINDOW_PROBE[lens]();
      expect(after.from, `${lens}: 過去側が伸びていない`).not.toBe(before.from);
      expect(after.to, `${lens}: 未来側まで動いた`).toBe(before.to);
    });

    it(`${lens}: 正本が「端ではない」と言えば窓は動かない`, () => {
      edgeMode.value = 'none';
      renderTimeline(lens);
      const before = WINDOW_PROBE[lens]();
      act(() => {
        fireEvent.scroll(viewportOf(lens));
      });
      expect(WINDOW_PROBE[lens]()).toEqual(before);
    });
  }

  it('伸ばし続けても上限で止まる（DOM が無制限に育たない）', () => {
    renderTimeline('matrix');
    scrollSide.value = 'start'; // → 'end' 側へ伸ばし続ける
    const seen = new Set<string>();
    for (let i = 0; i < 40; i += 1) {
      act(() => {
        fireEvent.scroll(viewportOf('matrix'));
      });
      seen.add(WINDOW_PROBE.matrix().to);
    }
    // 月ズームの上限は 9 段（36 + 18×9 = 198 列 ≤ MATRIX_MAX_COLUMNS）。
    expect(seen.size).toBeLessThanOrEqual(9);
    const columns = document.querySelectorAll(`[data-ui="${UI.timeline.matrix}"] thead th`).length;
    expect(columns, '列数が数値レンズの上限 200 を超えた').toBeLessThanOrEqual(1 + 200);
  });

  it('左右ボタンで送り直すと継ぎ足しは 0 に戻る（窓が伸びっぱなしにならない）', () => {
    renderTimeline('matrix');
    const initial = WINDOW_PROBE.matrix();
    scrollSide.value = 'start';
    for (let i = 0; i < 3; i += 1) {
      act(() => {
        fireEvent.scroll(viewportOf('matrix'));
      });
    }
    const grown = WINDOW_PROBE.matrix();
    expect(grown.to).not.toBe(initial.to);

    // 「次へ」= 窓ごと送り直し。伸ばした量は持ち越さないので、窓の長さは初期に戻る。
    act(() => {
      fireEvent.click(document.querySelector(`[data-ui="${UI.timeline.next}"]`)!);
    });
    const columns = document.querySelectorAll(`[data-ui="${UI.timeline.matrix}"] thead th`).length;
    expect(columns, '送り直したのに継ぎ足しぶんが残っている').toBe(1 + 36);
  });
});
