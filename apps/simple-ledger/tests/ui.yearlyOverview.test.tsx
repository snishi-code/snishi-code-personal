import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useState } from 'react';
import { act, cleanup, fireEvent, render, within } from '@testing-library/react';
import { YearlyOverview, type OverviewMode } from '../src/ui/screens/YearlyOverview';
import type { Account, JournalEntry, Ledger } from '../src/domain/types';
import * as reportEntriesModule from '../src/domain/reportEntries';
import { CONTINUOUS_COST_LEDGER_ACCOUNT_ID, SCHEMA_VERSION } from '../src/domain/constants';
import { UI } from '../src/ui-contract';
import './setup';
import type { ReportPeriod } from '../src/domain/reportPeriod';

/**
 * 全 render の既定 props（タップ配線のテストだけ spy を渡す）。
 *
 * 年間/全体はヘッダーの粒度セグメントが持つ props になったので、この画面単体テストでは
 * App の代わりに **stateful なラッパー**が mode を持つ。初期値は initialMode、画面からの
 * onModeChange（全体の年見出しタップ）はラッパーが受けて実際に mode を進める＝
 * 「タップ → 年間表示へ切り替わる」まで一続きで検証できる。
 * setMode は「同じマウントのまま mode だけ変える」ための入口（再マウントと区別したいとき用）。
 */
function renderOverview(
  period: ReportPeriod,
  options: {
    onPeriodChange?: (next: ReportPeriod) => void;
    onNavigate?: (screen: string) => void;
    onModeChange?: (mode: OverviewMode) => void;
    initialMode?: OverviewMode;
  } = {},
) {
  let setModeRef: ((mode: OverviewMode) => void) | undefined;

  function Harness() {
    const [mode, setMode] = useState<OverviewMode>(options.initialMode ?? 'year');
    setModeRef = setMode;
    return (
      <YearlyOverview
        period={period}
        mode={mode}
        onModeChange={(next) => {
          setMode(next);
          options.onModeChange?.(next);
        }}
        onPeriodChange={options.onPeriodChange ?? (() => undefined)}
        onNavigate={(options.onNavigate ?? (() => undefined)) as never}
      />
    );
  }

  const view = render(<Harness />);
  return {
    ...view,
    setMode: (mode: OverviewMode) => {
      act(() => setModeRef!(mode));
    },
  };
}

const ledgerState = vi.hoisted(() => ({ ledger: null as Ledger | null }));

vi.mock('../src/state/store', () => ({
  useLedger: () => ({ ledger: ledgerState.ledger }),
  useOptionalLedger: () => ({ ledger: ledgerState.ledger }),
}));

function account(id: string, name: string, type: Account['type'], role: Account['role']): Account {
  return {
    id,
    name,
    type,
    role,
    archived: false,
    createdAt: 'x',
    updatedAt: 'x',
  };
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
  const accounts = [
    account('cash', '預金', 'asset', 'daily-asset'),
    account('equity', '元手', 'equity', 'equity'),
    account('salary', '給与', 'revenue', 'income-category'),
    account('food', '食費', 'expense', 'expense-category'),
  ];
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
    accounts,
    journalEntries: [
      entry('opening', '2024-01-01', 'cash', 'equity', 100000),
      entry('past-expense', '2024-03-31', 'food', 'cash', 10000),
      entry('current-income', '2026-06-30', 'cash', 'salary', 50000),
      entry('future-income', '2027-01-01', 'cash', 'salary', 80000),
    ],
    tags: [],
    monthlyCostItems: [],
    recurringRules: [],
  };
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

describe('YearlyOverview', () => {
  it('ヘッダー選択日の年を初期表示し、データ年だけを両端まで送る', () => {
    renderOverview({ mode: 'date', date: '2024-05-10' });

    expect(document.querySelector(`[data-ui="${UI.yearlyOverview.view}"]`)).toHaveTextContent(
      '2024年',
    );
    const previous = document.querySelector(
      `[data-ui="${UI.yearlyOverview.prevYear}"]`,
    ) as HTMLButtonElement;
    const next = document.querySelector(
      `[data-ui="${UI.yearlyOverview.nextYear}"]`,
    ) as HTMLButtonElement;
    expect(previous).toBeDisabled();
    expect(next).not.toBeDisabled();
    expect(next).toHaveAccessibleName('2026年へ進む');

    fireEvent.click(next);
    expect(document.querySelector(`[data-ui="${UI.yearlyOverview.view}"]`)).toHaveTextContent(
      '2026年',
    );
    expect(previous).toHaveAccessibleName('2024年へ戻る');

    fireEvent.click(next);
    expect(document.querySelector(`[data-ui="${UI.yearlyOverview.view}"]`)).toHaveTextContent(
      '2027年',
    );
    expect(next).toBeDisabled();
  });

  it('年間: 月の列見出しタップで基準日をその月末にしてホームへ飛ぶ', () => {
    const onPeriodChange = vi.fn();
    const onNavigate = vi.fn();
    renderOverview({ mode: 'date', date: '2024-05-10' }, { onPeriodChange, onNavigate });

    const months = document.querySelectorAll<HTMLButtonElement>(
      `[data-ui="${UI.yearlyOverview.monthColumn}"]`,
    );
    expect(months).toHaveLength(12);
    // 11 月の列 → 基準日 = 2024-11-30（集計列と同じ月末の正本）。
    fireEvent.click(months[10]!);
    expect(onPeriodChange).toHaveBeenCalledWith({ mode: 'date', date: '2024-11-30' });
    expect(onNavigate).toHaveBeenCalledWith('dashboard');
  });

  it('全体: 年の列見出しタップでその年の年間表示へ切り替わる（ヘッダーは変えない）', () => {
    const onPeriodChange = vi.fn();
    renderOverview({ mode: 'date', date: '2024-05-10' }, { onPeriodChange, initialMode: 'all' });

    const years = document.querySelectorAll<HTMLButtonElement>(
      `[data-ui="${UI.yearlyOverview.yearColumn}"]`,
    );
    expect(years.length).toBeGreaterThan(0);
    const target = [...years].find((b) => b.textContent?.includes('2026'))!;
    fireEvent.click(target);

    // 画面内で年間 2026 へ（月列が現れる）。ヘッダーの期間は動かさない。
    expect(document.querySelector(`[data-ui="${UI.yearlyOverview.view}"]`)).toHaveTextContent(
      '2026年',
    );
    expect(document.querySelectorAll(`[data-ui="${UI.yearlyOverview.monthColumn}"]`)).toHaveLength(
      12,
    );
    expect(onPeriodChange).not.toHaveBeenCalled();
  });

  it('ヘッダー年に仕訳がなくても、その年を丸めず初期表示する', () => {
    renderOverview({ mode: 'date', date: '2025-05-10' });

    expect(document.querySelector(`[data-ui="${UI.yearlyOverview.view}"]`)).toHaveTextContent(
      '2025年',
    );
    expect(
      document.querySelector(`[data-ui="${UI.yearlyOverview.prevYear}"]`),
    ).toHaveAccessibleName('2024年へ戻る');
    expect(
      document.querySelector(`[data-ui="${UI.yearlyOverview.nextYear}"]`),
    ).toHaveAccessibleName('2026年へ進む');
  });

  it('catch-up未完了でも到来済み定期ルールの年を表示候補にする', () => {
    ledgerState.ledger = {
      ...fixtureLedger(),
      journalEntries: [],
      recurringRules: [
        {
          id: 'rule',
          name: '定期支出',
          amount: 10000,
          dayOfMonth: 1,
          everyMonths: 1,
          debitAccountId: 'food',
          creditAccountId: 'cash',
          startMonth: '2025-01',
          startDate: '2025-01-01',
          createdAt: 'x',
          updatedAt: 'x',
        },
      ],
    };

    renderOverview({ mode: 'date', date: '2025-05-10' });
    expect(document.querySelector(`[data-ui="${UI.yearlyOverview.matrix}"]`)).toBeInTheDocument();
    expect(document.querySelector(`[data-ui="${UI.yearlyOverview.view}"]`)).toHaveTextContent(
      '2025年',
    );
  });

  it('有限のルール線分が伸びる未来年を全体列と年送り候補に含める', () => {
    ledgerState.ledger = {
      ...fixtureLedger(),
      journalEntries: [entry('opening', '2026-01-01', 'cash', 'equity', 10_000)],
      recurringRules: [
        {
          id: 'future-rule-span',
          name: '未来までの定期収入',
          amount: 10000,
          dayOfMonth: 1,
          everyMonths: 1,
          debitAccountId: 'cash',
          creditAccountId: 'salary',
          startMonth: '2026-01',
          startDate: '2026-01-01',
          endDate: '2032-01-01',
          postedThroughMonth: '2026-06',
          createdAt: 'x',
          updatedAt: 'x',
        },
      ],
    };

    const view = renderOverview({ mode: 'date', date: '2026-07-15' });
    const next = document.querySelector(
      `[data-ui="${UI.yearlyOverview.nextYear}"]`,
    ) as HTMLButtonElement;
    expect(next).toHaveAccessibleName('2027年へ進む');

    view.setMode('all');
    const matrix = document.querySelector(`[data-ui="${UI.yearlyOverview.matrix}"]`) as HTMLElement;
    expect(
      within(matrix)
        .getAllByRole('columnheader')
        .map((header) => header.textContent),
    ).toEqual(['項目', '2026年', '2027年', '2028年', '2029年', '2030年', '2031年']);
    expect(matrix).not.toHaveTextContent('—');
    const revenueRow = within(matrix).getByRole('rowheader', { name: '収入' }).closest('tr');
    expect(revenueRow).not.toBeNull();
    expect(within(revenueRow!).getAllByRole('cell').at(-1)).toHaveTextContent('1,200');
  });

  it('全体へ切り替えるとデータ年を昇順に並べ、未来年も投影値を表示する', () => {
    renderOverview({ mode: 'date', date: '2026-07-15' }, { initialMode: 'all' });

    const matrix = document.querySelector(`[data-ui="${UI.yearlyOverview.matrix}"]`) as HTMLElement;
    const headers = within(matrix).getAllByRole('columnheader');
    expect(headers.map((header) => header.textContent)).toEqual([
      '項目',
      '2024年',
      '2026年',
      '2027年',
    ]);
    expect(within(matrix).queryByLabelText('対象期間外')).not.toBeInTheDocument();
    expect(matrix).not.toHaveTextContent('—');
    expect(matrix).toHaveTextContent('800');
  });

  it('表示地平セレクタは全体モードだけに出し、既定=実績のみは従来の歯抜け列のまま', () => {
    const view = renderOverview({ mode: 'date', date: '2026-07-15' });
    expect(
      document.querySelector(`[data-ui="${UI.yearlyOverview.horizonActual}"]`),
    ).not.toBeInTheDocument();

    view.setMode('all');
    const actual = document.querySelector(
      `[data-ui="${UI.yearlyOverview.horizonActual}"]`,
    ) as HTMLButtonElement;
    expect(actual).toHaveAttribute('aria-pressed', 'true');
    const matrix = document.querySelector(`[data-ui="${UI.yearlyOverview.matrix}"]`) as HTMLElement;
    expect(
      within(matrix)
        .getAllByRole('columnheader')
        .map((header) => header.textContent),
    ).toEqual(['項目', '2024年', '2026年', '2027年']);
  });

  it('地平の切替で列数が変わる: +30年=今年+30まで連続、2100年まで=最終列2100年', () => {
    renderOverview({ mode: 'date', date: '2026-07-15' }, { initialMode: 'all' });
    const matrix = document.querySelector(`[data-ui="${UI.yearlyOverview.matrix}"]`) as HTMLElement;
    expect(within(matrix).getAllByRole('columnheader')).toHaveLength(4);

    fireEvent.click(document.querySelector(`[data-ui="${UI.yearlyOverview.horizonPlus30}"]`)!);
    const plus30Headers = within(matrix)
      .getAllByRole('columnheader')
      .map((header) => header.textContent);
    // 2024〜2056（今日=2026の+30年）の連続33列。歯抜けだった2025年も埋まる。
    expect(plus30Headers).toHaveLength(1 + (2056 - 2024 + 1));
    expect(plus30Headers[1]).toBe('2024年');
    expect(plus30Headers).toContain('2025年');
    expect(plus30Headers.at(-1)).toBe('2056年');

    fireEvent.click(document.querySelector(`[data-ui="${UI.yearlyOverview.horizonHardCap}"]`)!);
    const hardCapHeaders = within(matrix)
      .getAllByRole('columnheader')
      .map((header) => header.textContent);
    expect(hardCapHeaders).toHaveLength(1 + (2100 - 2024 + 1));
    expect(hardCapHeaders.at(-1)).toBe('2100年');

    fireEvent.click(document.querySelector(`[data-ui="${UI.yearlyOverview.horizonActual}"]`)!);
    expect(within(matrix).getAllByRole('columnheader')).toHaveLength(4);
  });

  it('最初のデータ年が極端に古くても、200列上限は古い側を切り詰めて地平年まで届く（P1-5）', () => {
    const base = fixtureLedger();
    ledgerState.ledger = {
      ...base,
      journalEntries: [
        entry('ancient', '1880-01-01', 'cash', 'equity', 100000),
        ...base.journalEntries,
      ],
    };

    renderOverview({ mode: 'date', date: '2026-07-15' }, { initialMode: 'all' });
    fireEvent.click(document.querySelector(`[data-ui="${UI.yearlyOverview.horizonHardCap}"]`)!);
    const matrix = document.querySelector(`[data-ui="${UI.yearlyOverview.matrix}"]`) as HTMLElement;
    const headers = within(matrix)
      .getAllByRole('columnheader')
      .map((header) => header.textContent);
    // 上限は最終年（地平）側を守る: 2100 年を必ず含み、超過分は古い側を切り詰める。
    expect(headers.at(-1)).toBe('2100年');
    expect(headers).toHaveLength(1 + 200);
    expect(headers[1]).toBe('1901年');

    // 実績のみへ戻すと従来どおり 1880 年を含む歯抜け列のまま。
    fireEvent.click(document.querySelector(`[data-ui="${UI.yearlyOverview.horizonActual}"]`)!);
    const actualHeaders = within(matrix)
      .getAllByRole('columnheader')
      .map((header) => header.textContent);
    expect(actualHeaders[1]).toBe('1880年');
    expect(actualHeaders.at(-1)).toBe('2027年');
  });

  it('実績が今年+30より長ければ、+30年でも実績の最終年まで表示する', () => {
    ledgerState.ledger = {
      ...fixtureLedger(),
      journalEntries: [entry('opening', '2026-01-01', 'cash', 'equity', 10_000)],
      recurringRules: [
        {
          id: 'long-rule',
          name: '長期の定期収入',
          amount: 10000,
          dayOfMonth: 1,
          everyMonths: 1,
          debitAccountId: 'cash',
          creditAccountId: 'salary',
          startMonth: '2026-01',
          startDate: '2026-01-01',
          endDate: '2060-02-01',
          postedThroughMonth: '2026-06',
          createdAt: 'x',
          updatedAt: 'x',
        },
      ],
    };

    renderOverview({ mode: 'date', date: '2026-07-15' }, { initialMode: 'all' });
    fireEvent.click(document.querySelector(`[data-ui="${UI.yearlyOverview.horizonPlus30}"]`)!);
    const matrix = document.querySelector(`[data-ui="${UI.yearlyOverview.matrix}"]`) as HTMLElement;
    expect(
      within(matrix)
        .getAllByRole('columnheader')
        .map((header) => header.textContent)
        .at(-1),
    ).toBe('2060年');
  });

  it('終了日なしの定期ルールを延長地平の未来列へ購入行+月割りで投影する', () => {
    const base = fixtureLedger();
    ledgerState.ledger = {
      ...base,
      accounts: [
        ...base.accounts,
        account(
          CONTINUOUS_COST_LEDGER_ACCOUNT_ID,
          '継続コスト台帳',
          'asset',
          'continuing-cost-asset',
        ),
      ],
      journalEntries: [entry('opening', '2026-01-01', 'cash', 'equity', 1_000_000)],
      recurringRules: [
        {
          id: 'endless-rule',
          name: '終了日なしの保険',
          amount: 10000,
          dayOfMonth: 1,
          everyMonths: 1,
          debitAccountId: CONTINUOUS_COST_LEDGER_ACCOUNT_ID,
          spreadExpenseAccountId: 'food',
          creditAccountId: 'cash',
          startMonth: '2026-01',
          startDate: '2026-01-01',
          postedThroughMonth: '2026-06',
          createdAt: 'x',
          updatedAt: 'x',
        },
      ],
    };

    renderOverview({ mode: 'date', date: '2026-07-15' }, { initialMode: 'all' });
    const matrix = document.querySelector(`[data-ui="${UI.yearlyOverview.matrix}"]`) as HTMLElement;
    // 実績のみでは終了日なしルールは地平を延ばさない（データ年=2026のみ）。
    expect(within(matrix).getAllByRole('columnheader')).toHaveLength(2);

    fireEvent.click(document.querySelector(`[data-ui="${UI.yearlyOverview.horizonPlus30}"]`)!);
    const headers = within(matrix)
      .getAllByRole('columnheader')
      .map((header) => header.textContent);
    expect(headers.at(-1)).toBe('2056年');
    const lastCellOf = (rowName: string) => {
      const row = within(matrix).getByRole('rowheader', { name: rowName }).closest('tr');
      expect(row).not.toBeNull();
      return within(row!).getAllByRole('cell').at(-1);
    };
    // 最終年も 12 か月ぶんの月割り（100×12）が費用・継続コスト行へ乗る。
    expect(lastCellOf('支出')).toHaveTextContent('1,200');
    expect(lastCellOf('継続コスト')).toHaveTextContent('1,200');
  });

  it('当年の未来月も対象期間外にせず数値で表示する', () => {
    renderOverview({ mode: 'date', date: '2026-07-15' });

    const matrix = document.querySelector(`[data-ui="${UI.yearlyOverview.matrix}"]`) as HTMLElement;
    expect(within(matrix).queryByLabelText('対象期間外')).not.toBeInTheDocument();
    expect(matrix).not.toHaveTextContent('—');
    expect(within(matrix).getByText('7月')).toBeInTheDocument();
    expect(within(matrix).getByText('8月')).toBeInTheDocument();
  });

  it('表示単位ごとに仕訳の仮想展開を1回だけ行う', () => {
    // 画面の展開入口は displayEntriesResultForAsOf（投影込み+打ち切り診断の表示 API）。
    const expand = vi.spyOn(reportEntriesModule, 'displayEntriesResultForAsOf');
    const view = renderOverview({ mode: 'date', date: '2026-07-15' });
    expect(expand).toHaveBeenCalledTimes(1);

    // 同じマウントのまま全体へ（mode 変更は再マウントではなく props の入れ替え）。
    view.setMode('all');
    expect(expand).toHaveBeenCalledTimes(2);
  });

  it('年間モードでも未来月を含む年には投影の注記を出す（過去年には出さない）', () => {
    const { unmount } = renderOverview({ mode: 'date', date: '2026-07-15' });
    // 2026 年は未来月（8〜12月）を含む = 投影が混ざるので注記を出す。
    expect(
      document.querySelector(`[data-ui="${UI.yearlyOverview.projectionNote}"]`),
    ).toBeInTheDocument();
    unmount();

    // 2024 年は全月が過去 = 投影ゼロなので注記を出さない。
    renderOverview({ mode: 'date', date: '2024-05-10' });
    expect(
      document.querySelector(`[data-ui="${UI.yearlyOverview.projectionNote}"]`),
    ).not.toBeInTheDocument();
  });

  it('桁あふれで投影を打ち切った科目は、打ち切り月とともに注記で名乗る', () => {
    // 打ち切りは作者が宣言した端点ではなくアプリ都合の端点なので、黙って横ばいの顔をさせない
    // （監査 2026-08-12・案1）。
    const ledger = fixtureLedger();
    ledger.accounts.push({
      ...account('invest', '投資', 'asset', 'investment-asset'),
      annualReturnBp: 100_000, // 年率 1000% = 月利 ≈ 22.1%
      projectionAccountId: 'salary',
    });
    ledger.journalEntries.push(
      entry('invest-opening', '2026-01-01', 'invest', 'equity', 3_500_000_000_000_000),
    );
    ledgerState.ledger = ledger;

    renderOverview({ mode: 'date', date: '2026-07-15' });
    const note = document.querySelector(`[data-ui="${UI.yearlyOverview.projectionTruncatedNote}"]`);
    expect(note).toBeInTheDocument();
    expect(note).toHaveTextContent('投資');
    expect(note).toHaveTextContent('2026-09');
  });
});
