/*
 * 時間平面の**数値レンズ**（v13.5 D で「年間・全体」画面を吸収したもの）。
 *
 * 旧画面との違いを落とさないための検証:
 *  - 月ズーム = 月列 / 年ズーム = 年列。年送りボタンではなく**窓**（可視範囲 + 前後バッファ）。
 *  - 列は全期間ぶん描かない。古いデータがあっても列数は窓のぶんだけ。
 *  - 下端はデータのある最初の年（それより前へは列を作らない = スクロール可能範囲の下端）。
 *  - 列タップのドリル（月 → ホーム / 年 → その年を月で見る）は維持する。
 *  - 仕訳の仮想展開はレンズを切り替えても 1 回だけ。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useState } from 'react';
import { act, cleanup, fireEvent, render, within } from '@testing-library/react';
import {
  TimelineCalendar,
  type TimelineLens,
  type TimelineZoom,
} from '../src/ui/screens/TimelineCalendar';
import type { Account, JournalEntry, Ledger } from '../src/domain/types';
import * as reportEntriesModule from '../src/domain/reportEntries';
import { SCHEMA_VERSION } from '../src/domain/constants';
import { UI } from '../src/ui-contract';
import './setup';
import type { ReportPeriod } from '../src/domain/reportPeriod';

const ledgerState = vi.hoisted(() => ({ ledger: null as Ledger | null }));

vi.mock('../src/state/store', () => ({
  useLedger: () => ({ ledger: ledgerState.ledger }),
  useOptionalLedger: () => ({ ledger: ledgerState.ledger }),
}));

/**
 * ズームとレンズは App（ヘッダー）が持つ props。ここでは stateful なラッパーが持ち、
 * 画面からの onZoomChange（年列タップ）が実際にズームを進めるところまで一続きで見る。
 * App と同じ不変則（数値レンズ ⇒ 日ズームではない）もラッパーが再現する。
 */
function renderTimeline(
  period: ReportPeriod,
  options: {
    initialZoom?: TimelineZoom;
    initialLens?: TimelineLens;
    onPeriodChange?: (next: ReportPeriod) => void;
    onNavigate?: (screen: string) => void;
  } = {},
) {
  let setLensRef: ((lens: TimelineLens) => void) | undefined;
  let zoomRef: TimelineZoom | undefined;

  function Harness() {
    const [zoom, setZoom] = useState<TimelineZoom>(options.initialZoom ?? 'month');
    const [lens, setLens] = useState<TimelineLens>(options.initialLens ?? 'matrix');
    zoomRef = zoom;
    setLensRef = (next) => {
      setLens(next);
      if (next === 'matrix' && zoom === 'day') setZoom('month');
    };
    return (
      <TimelineCalendar
        period={period}
        zoom={zoom}
        onZoomChange={setZoom}
        lens={lens}
        onLensChange={setLensRef!}
        onPeriodChange={options.onPeriodChange ?? (() => undefined)}
        onNavigate={(options.onNavigate ?? (() => undefined)) as never}
        onOpenEntry={() => undefined}
        onOpenAllocations={() => undefined}
      />
    );
  }

  const view = render(<Harness />);
  return {
    ...view,
    setLens: (lens: TimelineLens) => {
      act(() => setLensRef!(lens));
    },
    zoom: () => zoomRef,
  };
}

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
      account('salary', '給与', 'revenue', 'income-category'),
      account('food', '食費', 'expense', 'expense-category'),
    ],
    journalEntries: [
      entry('opening', '2024-01-01', 'cash', 'equity', 100000),
      entry('past-expense', '2024-03-31', 'food', 'cash', 10000),
      // 窓の中の支出（段階的開示で費目を開けるようにする）。
      entry('window-expense', '2026-05-10', 'food', 'cash', 3000),
      entry('current-income', '2026-06-30', 'cash', 'salary', 50000),
      entry('future-income', '2027-01-01', 'cash', 'salary', 80000),
    ],
    monthlyCostItems: [],
    recurringRules: [],
  };
}

const matrixEl = () => document.querySelector(`[data-ui="${UI.timeline.matrix}"]`) as HTMLElement;
const columnKeys = () =>
  within(matrixEl())
    .getAllByRole('columnheader')
    .map((header) => header.textContent);

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

describe('時間平面の数値レンズ', () => {
  it('線分レンズでは表を出さず、数値レンズへ切り替えると表になる', () => {
    const view = renderTimeline({ mode: 'date', date: '2026-07-15' }, { initialLens: 'segment' });
    expect(matrixEl()).toBeNull();
    expect(document.querySelector(`[data-ui="${UI.timeline.viewport}"]`)).toBeInTheDocument();

    view.setLens('matrix');
    expect(matrixEl()).toBeInTheDocument();
    // 表と線分は同時に出さない（同じ窓の別の見え方であって、2 つの窓ではない）。
    expect(document.querySelector(`[data-ui="${UI.timeline.viewport}"]`)).toBeNull();
  });

  it('月ズーム: 年をまたいで連続する月列を、窓のぶんだけ出す', () => {
    renderTimeline({ mode: 'date', date: '2026-07-15' });

    const keys = columnKeys();
    // 先頭は項目列。月列は 2025-02〜2028-01 の 36 列（基準日の前後バッファ）。
    expect(keys[0]).toBe('項目');
    expect(keys).toHaveLength(1 + 36);
    // 年の変わり目だけ年を名乗る = 年またぎが読める。
    expect(keys).toContain('2026年1月');
    expect(keys).toContain('2027年1月');
    expect(keys.filter((key) => key === '7月')).toHaveLength(3);
  });

  it('年ズーム: 年列になり、列数は窓のぶんだけ（全期間を全列描かない）', () => {
    renderTimeline({ mode: 'date', date: '2026-07-15' }, { initialZoom: 'year' });

    const keys = columnKeys();
    expect(keys[0]).toBe('項目');
    // 2024（データ下端でクランプ）〜2033 の年列。1900 年代までは伸ばさない。
    expect(keys[1]).toBe('2024年');
    expect(keys.at(-1)).toBe('2033年');
    expect(keys.length).toBeLessThan(1 + 30);
  });

  it('データのある最初の年より前へは列を作らない（スクロール可能範囲の下端）', () => {
    renderTimeline({ mode: 'date', date: '2024-06-15' }, { initialZoom: 'year' });
    // 窓は 2017〜2031 だが、データは 2024 年から。下端はデータ年で止まる。
    expect(columnKeys()[1]).toBe('2024年');
  });

  it('古い仕訳があっても列は窓のぶんだけ（全期間 = 全列にしない）', () => {
    const base = fixtureLedger();
    ledgerState.ledger = {
      ...base,
      journalEntries: [
        entry('ancient', '1880-01-01', 'cash', 'equity', 1000),
        ...base.journalEntries,
      ],
    };

    renderTimeline({ mode: 'date', date: '2026-07-15' }, { initialZoom: 'year' });
    const keys = columnKeys();
    // 1880 年の列は描かない（旧「全体」は全データ年を常に描いていた）。
    expect(keys).not.toContain('1880年');
    expect(keys[1]).toBe('2019年');
    expect(keys).toHaveLength(1 + 15);
  });

  it('月列のタップで基準日をその月末にしてホームへ飛ぶ', () => {
    const onPeriodChange = vi.fn();
    const onNavigate = vi.fn();
    renderTimeline({ mode: 'date', date: '2026-07-15' }, { onPeriodChange, onNavigate });

    const months = document.querySelectorAll<HTMLButtonElement>(
      `[data-ui="${UI.timeline.matrixMonthColumn}"]`,
    );
    const november = [...months].find(
      (button) => button.getAttribute('aria-label') === '2026-11-30 時点の残高をホームで見る',
    )!;
    fireEvent.click(november);
    expect(onPeriodChange).toHaveBeenCalledWith({ mode: 'date', date: '2026-11-30' });
    expect(onNavigate).toHaveBeenCalledWith('dashboard');
  });

  it('年列のタップでその年を月ズームで見る（ヘッダーの日付は変えない）', () => {
    const onPeriodChange = vi.fn();
    const view = renderTimeline(
      { mode: 'date', date: '2026-07-15' },
      { initialZoom: 'year', onPeriodChange },
    );

    const years = document.querySelectorAll<HTMLButtonElement>(
      `[data-ui="${UI.timeline.matrixYearColumn}"]`,
    );
    const target = [...years].find((button) => button.textContent?.includes('2028'))!;
    act(() => {
      fireEvent.click(target);
    });

    expect(view.zoom()).toBe('month');
    // 押した年が窓の中心（= 見えている場所）になる。
    expect(columnKeys()).toContain('2028年1月');
    expect(onPeriodChange).not.toHaveBeenCalled();
  });

  it('未来列を含むときだけ投影の注記を出す', () => {
    const { unmount } = renderTimeline({ mode: 'date', date: '2026-07-15' });
    expect(document.querySelector(`[data-ui="${UI.timeline.matrixNote}"]`)).toBeInTheDocument();
    unmount();

    // 窓が丸ごと過去（2019 中心 → 2020-08 まで）なら投影は混ざらない。
    renderTimeline({ mode: 'date', date: '2019-02-15' });
    expect(document.querySelector(`[data-ui="${UI.timeline.matrixNote}"]`)).toBeNull();
  });

  it('仕訳の仮想展開は基準日ごとに 1 回だけ（レンズを変えても重ねて展開しない）', () => {
    const expand = vi.spyOn(reportEntriesModule, 'displayEntriesResultForAsOf');
    const view = renderTimeline({ mode: 'date', date: '2026-07-15' }, { initialLens: 'segment' });
    const asOfs = () => new Set(expand.mock.calls.map(([, asOf]) => asOf));
    expect(asOfs().size).toBe(1);
    const segmentCalls = expand.mock.calls.length;

    view.setLens('matrix');
    // 数値レンズの基準日 = 最終列の列末。線分レンズの窓の右端と同じなので、
    // レンズを替えても展開はやり直さない（導出キャッシュ以前に呼びすらしない）。
    expect(asOfs()).toEqual(new Set(['2028-01-31']));
    expect(expand.mock.calls.length).toBe(segmentCalls);
    expect(matrixEl()).toBeInTheDocument();
  });

  it('当年の未来月も対象期間外にせず数値で表示する', () => {
    renderTimeline({ mode: 'date', date: '2026-07-15' });
    expect(within(matrixEl()).queryByLabelText('対象期間外')).not.toBeInTheDocument();
    expect(matrixEl()).not.toHaveTextContent('—');
  });

  /*
   * v13.6 H3: 行は**3 レンズ共通のラベル列**（箱 → 科目の木 + 恒等行）。
   * 数値レンズ専用の 6 分類の木は無くなり、線分レンズと同じ行に値が載る。
   */
  describe('共通ラベル列', () => {
    const rowKeys = () =>
      [...matrixEl().querySelectorAll(`[data-ui="${UI.timeline.matrixRow}"]`)].map((row) =>
        row.getAttribute('data-row-key'),
      );
    const toggle = (key: string) =>
      matrixEl().querySelector<HTMLButtonElement>(
        `[data-ui="${UI.timeline.rowToggle}"][data-row-key="${key}"]`,
      );
    const check = (key: string) =>
      matrixEl().querySelector<HTMLInputElement>(
        `[data-ui="${UI.timeline.rowCheck}"][data-row-key="${key}"]`,
      );
    const cellsOf = (key: string) =>
      matrixEl().querySelector(`[data-ui="${UI.timeline.matrixRow}"][data-row-key="${key}"]`)!;

    it('既定は箱 8 つ + 恒等行 2 つ（科目は開くまで出さない）', () => {
      renderTimeline({ mode: 'date', date: '2026-07-15' });

      expect(rowKeys()).toEqual([
        'box:assetFree',
        'box:assetFixed',
        'box:continuingCost',
        'box:shortTermDebt',
        'box:longTermDebt',
        'identity:netAssets',
        'box:income',
        'box:expense',
        'identity:net',
        'box:equity',
      ]);
      // 恒等行の名前はホームのカードと同じ語彙（行の識別は data-row-key）。
      expect(cellsOf('identity:net')).toHaveTextContent('収支');
      expect(cellsOf('identity:netAssets')).toHaveTextContent('純資産');
      // 科目は開くまで出さない。
      expect(within(matrixEl()).queryByRole('rowheader', { name: /食費/ })).toBeNull();
    });

    it('フローとストックの段の切り替わりに区切り線を引く（stock 性の変化で判定・監査 C）', () => {
      renderTimeline({ mode: 'date', date: '2026-07-15' });
      const sectionRows = [...matrixEl().querySelectorAll('.period-matrix__row--section')].map(
        (row) => row.getAttribute('data-row-key'),
      );
      // ストック（資産〜純資産） → フロー（収入）と、フロー（収支） → ストック（純資産の箱）。
      expect(sectionRows).toEqual(['box:income', 'box:equity']);
    });

    it('箱のタップで科目を開き、もう一度で閉じる（aria-expanded が名乗る）', () => {
      renderTimeline({ mode: 'date', date: '2026-07-15' });

      const expense = toggle('box:expense')!;
      expect(expense).toHaveAttribute('aria-expanded', 'false');
      fireEvent.click(expense);
      expect(toggle('box:expense')).toHaveAttribute('aria-expanded', 'true');
      expect(rowKeys()).toContain('account:food');
      expect(within(matrixEl()).getByRole('rowheader', { name: /食費/ })).toBeInTheDocument();

      fireEvent.click(toggle('box:expense')!);
      expect(rowKeys()).not.toContain('account:food');
    });

    it('恒等行にはトグルが無い（引き算の結果はばらさない）', () => {
      renderTimeline({ mode: 'date', date: '2026-07-15' });
      expect(toggle('identity:net')).toBeNull();
      expect(toggle('identity:netAssets')).toBeNull();
    });

    /* mutation 系統: チェックと右ペインの連動。 */
    it('チェックを外すとその行の値が列から消え、戻すと出る（行そのものは残る）', () => {
      renderTimeline({ mode: 'date', date: '2026-07-15' });

      const box = check('box:assetFree')!;
      expect(box.checked).toBe(true);
      const filled = () =>
        [
          ...cellsOf('box:assetFree').querySelectorAll(`[data-ui="${UI.timeline.matrixCell}"]`),
        ].filter((cell) => cell.textContent !== '').length;
      expect(filled()).toBeGreaterThan(0);

      fireEvent.click(box);
      expect(check('box:assetFree')!.checked).toBe(false);
      // 行は残る（チェックし直せる）が、値のセルは空になる。
      expect(rowKeys()).toContain('box:assetFree');
      expect(filled()).toBe(0);

      fireEvent.click(check('box:assetFree')!);
      expect(filled()).toBeGreaterThan(0);
    });

    it('負債の数字は負債トークンの色（C-2）で、資産の数字には付かない', () => {
      const base = fixtureLedger();
      ledgerState.ledger = {
        ...base,
        accounts: [...base.accounts, account('loan', 'ローン', 'liability', 'other-liability')],
        journalEntries: [
          ...base.journalEntries,
          entry('borrow', '2026-05-01', 'cash', 'loan', 300),
        ],
      };
      renderTimeline({ mode: 'date', date: '2026-07-15' });

      expect(cellsOf('box:longTermDebt').querySelector('.amount--liability')).not.toBeNull();
      expect(cellsOf('box:assetFree').querySelector('.amount--liability')).toBeNull();

      fireEvent.click(toggle('box:longTermDebt')!);
      expect(cellsOf('account:loan').querySelector('.amount--liability')).not.toBeNull();
    });
  });
});
