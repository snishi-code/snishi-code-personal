import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, within } from '@testing-library/react';
import { YearlyOverview } from '../src/ui/screens/YearlyOverview';
import type { Account, JournalEntry, Ledger } from '../src/domain/types';
import * as reportEntriesModule from '../src/domain/reportEntries';
import { SCHEMA_VERSION } from '../src/domain/constants';
import { UI } from '../src/ui-contract';
import './setup';

const ledgerState = vi.hoisted(() => ({ ledger: null as Ledger | null }));

vi.mock('../src/state/store', () => ({
  useLedger: () => ({ ledger: ledgerState.ledger }),
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
    settings: { ledgerName: 'test', currency: 'JPY', locale: 'ja' },
    accounts,
    journalEntries: [
      entry('opening', '2024-01-01', 'cash', 'equity', 1000),
      entry('past-expense', '2024-03-31', 'food', 'cash', 100),
      entry('current-income', '2026-06-30', 'cash', 'salary', 500),
      entry('future-income', '2027-01-01', 'cash', 'salary', 800),
    ],
    cashflowSchedules: [],
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
    render(<YearlyOverview period={{ mode: 'date', date: '2024-05-10' }} />);

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

  it('ヘッダー年に仕訳がなくても、その年を丸めず初期表示する', () => {
    render(<YearlyOverview period={{ mode: 'date', date: '2025-05-10' }} />);

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
          amount: 100,
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

    render(<YearlyOverview period={{ mode: 'date', date: '2025-05-10' }} />);
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
          amount: 100,
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

    render(<YearlyOverview period={{ mode: 'date', date: '2026-07-15' }} />);
    const next = document.querySelector(
      `[data-ui="${UI.yearlyOverview.nextYear}"]`,
    ) as HTMLButtonElement;
    expect(next).toHaveAccessibleName('2027年へ進む');

    fireEvent.click(document.querySelector(`[data-ui="${UI.yearlyOverview.modeAll}"]`)!);
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
    render(<YearlyOverview period={{ mode: 'date', date: '2026-07-15' }} />);

    fireEvent.click(document.querySelector(`[data-ui="${UI.yearlyOverview.modeAll}"]`)!);
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

  it('当年の未来月も対象期間外にせず数値で表示する', () => {
    render(<YearlyOverview period={{ mode: 'date', date: '2026-07-15' }} />);

    const matrix = document.querySelector(`[data-ui="${UI.yearlyOverview.matrix}"]`) as HTMLElement;
    expect(within(matrix).queryByLabelText('対象期間外')).not.toBeInTheDocument();
    expect(matrix).not.toHaveTextContent('—');
    expect(within(matrix).getByText('7月')).toBeInTheDocument();
    expect(within(matrix).getByText('8月')).toBeInTheDocument();
  });

  it('表示単位ごとに仕訳の仮想展開を1回だけ行う', () => {
    const expand = vi.spyOn(reportEntriesModule, 'reportEntriesForAsOf');
    render(<YearlyOverview period={{ mode: 'date', date: '2026-07-15' }} />);
    expect(expand).toHaveBeenCalledTimes(1);

    fireEvent.click(document.querySelector(`[data-ui="${UI.yearlyOverview.modeAll}"]`)!);
    expect(expand).toHaveBeenCalledTimes(2);
  });
});
