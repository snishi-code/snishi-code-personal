/*
 * 仕訳一覧の並び替え（C-4）と抽出結果の件数+合計（C-3 の UI 出口）:
 *  - 日付/金額/名称 × 昇順/降順。既定 = 日付降順（従来の並びそのもの）。
 *    名称 = 摘要の五十音順（毎月のものと同じ語彙・軸の正本は LIST_SORT_AXES）。
 *  - 同日・同額・同摘要は基準順（日付降順・同日は登録の新しい順）を保つ安定ソート。
 *  - 件数+合計の対象 = 表示している行の集合（＝ユーザーが数えたら合う）。
 *    テキスト抽出 = 単純和（仕訳ごとに金額 1 回・二重計上なし）/
 *    科目タップ抽出 = その科目視点の方向つき和。月割りの導出行も対象に含む。
 */
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { ToastProvider } from '@snishi/foundation/ui/toast';
import { patchDialogIfNeeded } from '@snishi/foundation/ui/test-utils';
import { LedgerProvider, useLedger } from '../src/state/store';
import { Journal, type JournalFilter } from '../src/ui/screens/Journal';
import { createContinuousCost, loadLedger, upsertEntry } from '../src/data/repository';
import { addMonthsToDate } from '../src/domain/allocation';
import { UI } from '../src/ui-contract';
import { _resetOverlaysForTests } from '../src/ui/overlays';
import { todayLocal } from '../src/util/time';
import { formatMoney } from '../src/util/format';
import type { Account } from '../src/domain/types';
import './setup';

beforeAll(() => {
  patchDialogIfNeeded();
});

afterEach(() => {
  cleanup();
  _resetOverlaysForTests();
});

function View({ filter = null }: { filter?: JournalFilter | null }) {
  return (
    <ToastProvider>
      <LedgerProvider>
        <ReadyView filter={filter} />
      </LedgerProvider>
    </ToastProvider>
  );
}

function ReadyView({ filter }: { filter: JournalFilter | null }) {
  const { status } = useLedger();
  if (status !== 'ready') return null;
  return (
    <Journal
      onEditEntry={() => undefined}
      onReverse={() => undefined}
      onOpenAllocations={() => undefined}
      filter={filter}
      period={{ mode: 'all' }}
      onClearFilter={() => undefined}
    />
  );
}

/** 表示中の行のタイトル（摘要を含む）を上から順に返す。 */
function rowTitles(): string[] {
  return Array.from(document.querySelectorAll(`[data-ui="${UI.journal.list}"] .list__title`)).map(
    (el) => (el.textContent ?? '').trim(),
  );
}

/** 表示中の行の金額（表示単位の整数）を上から順に返す。同じ摘要の行を区別するために使う。 */
function rowAmounts(): number[] {
  return Array.from(document.querySelectorAll(`[data-ui="${UI.journal.list}"] .list__amount`)).map(
    (el) => Number((el.textContent ?? '').replace(/[^0-9-]/g, '')),
  );
}

function summaryText(): string {
  return document.querySelector(`[data-ui="${UI.journal.summary}"]`)?.textContent ?? '';
}

/**
 * 並び替えの境界検証用: 同日（3/5）かつ同額（100）の B・C で、
 * どの並び替えでも基準順（登録の新しい順 = C が B より先）が保たれることを見る。
 */
async function createSortFixtures(): Promise<{ cash: Account; expense: Account }> {
  const ledger = await loadLedger();
  const cash = ledger.accounts.find((account) => account.role === 'daily-asset')!;
  const expense = ledger.accounts.find((account) => account.role === 'expense-category')!;
  const rows = [
    { id: 'sort-a', date: '2026-03-01', description: 'ソートA', amount: 300, second: 1 },
    { id: 'sort-b', date: '2026-03-05', description: 'ソートB', amount: 100, second: 2 },
    { id: 'sort-c', date: '2026-03-05', description: 'ソートC', amount: 100, second: 3 },
    { id: 'sort-d', date: '2026-03-10', description: 'ソートD', amount: 200, second: 4 },
  ];
  for (const row of rows) {
    const timestamp = `2026-03-01T00:00:0${row.second}.000Z`;
    await upsertEntry({
      id: row.id,
      date: row.date,
      description: row.description,
      kind: 'normal',
      lines: [
        { accountId: expense.id, side: 'debit', amount: row.amount },
        { accountId: cash.id, side: 'credit', amount: row.amount },
      ],
      metadata: { inputMode: 'expense' },
      createdAt: timestamp,
      updatedAt: timestamp,
    });
  }
  return { cash, expense };
}

/**
 * 名称軸（摘要の五十音順）の検証用。日付順・金額順のどれとも違う並びになるようにし、
 * 同じ摘要（あんぱん）を 2 件入れて同着の相対順（基準順 = 日付降順）を見られるようにする。
 */
async function createNameSortFixtures(): Promise<void> {
  const ledger = await loadLedger();
  const cash = ledger.accounts.find((account) => account.role === 'daily-asset')!;
  const expense = ledger.accounts.find((account) => account.role === 'expense-category')!;
  const rows = [
    { id: 'namesort-a', date: '2026-03-03', description: 'うどん', amount: 100, second: 1 },
    { id: 'namesort-b', date: '2026-03-01', description: 'あんぱん', amount: 200, second: 2 },
    { id: 'namesort-c', date: '2026-03-02', description: 'いちご', amount: 300, second: 3 },
    { id: 'namesort-d', date: '2026-03-04', description: 'あんぱん', amount: 400, second: 4 },
  ];
  for (const row of rows) {
    const timestamp = `2026-03-01T00:00:0${row.second}.000Z`;
    await upsertEntry({
      id: row.id,
      date: row.date,
      description: row.description,
      kind: 'normal',
      lines: [
        { accountId: expense.id, side: 'debit', amount: row.amount },
        { accountId: cash.id, side: 'credit', amount: row.amount },
      ],
      metadata: { inputMode: 'expense' },
      createdAt: timestamp,
      updatedAt: timestamp,
    });
  }
}

const MARCH: JournalFilter = { from: '2026-03-01', to: '2026-03-31' };

describe('仕訳一覧の並び替え（表示専用）', () => {
  it('既定は日付降順（従来の並び）で、昇順へ切り替えても同日は基準順を保つ', async () => {
    await createSortFixtures();
    render(<View filter={MARCH} />);
    await screen.findByText('ソートA');

    // 既定 = 日付降順・同日（3/5）は登録の新しい順（C → B）。
    expect(rowTitles()).toEqual(['ソートD', 'ソートC', 'ソートB', 'ソートA']);

    fireEvent.click(document.querySelector(`[data-ui="${UI.journal.sortAsc}"]`)!);
    // 日付昇順。同日の並びは安定（基準順のまま C → B）。
    expect(rowTitles()).toEqual(['ソートA', 'ソートC', 'ソートB', 'ソートD']);
  });

  it('金額の降順・昇順が正しく、同額は基準順を保つ', async () => {
    await createSortFixtures();
    render(<View filter={MARCH} />);
    await screen.findByText('ソートA');

    fireEvent.click(document.querySelector(`[data-ui="${UI.journal.sortByAmount}"]`)!);
    // 金額降順: 300, 200, 100, 100。同額（100）は安定（C → B）。
    expect(rowTitles()).toEqual(['ソートA', 'ソートD', 'ソートC', 'ソートB']);

    fireEvent.click(document.querySelector(`[data-ui="${UI.journal.sortAsc}"]`)!);
    // 金額昇順: 100, 100, 200, 300。同額（100）は安定（C → B）。
    expect(rowTitles()).toEqual(['ソートC', 'ソートB', 'ソートD', 'ソートA']);
  });

  it('名称軸は摘要の五十音順で、昇降が効き、同じ摘要は基準順を保つ', async () => {
    await createNameSortFixtures();
    render(<View filter={MARCH} />);
    await screen.findByText('うどん');

    // 既定 = 日付降順（3/4 あんぱん → 3/3 うどん → 3/2 いちご → 3/1 あんぱん）。
    expect(rowAmounts()).toEqual([4, 1, 3, 2]);

    // 名称軸へ切り替え。方向は名称の既定（昇順 = 五十音順）へ戻る。
    fireEvent.click(document.querySelector(`[data-ui="${UI.journal.sortByName}"]`)!);
    expect(document.querySelector(`[data-ui="${UI.journal.sortAsc}"]`)).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    expect(rowTitles()).toEqual(['あんぱん', 'あんぱん', 'いちご', 'うどん']);
    // 同じ摘要の 2 件は基準順（日付降順 = 3/4 の 400 が先）のまま。
    expect(rowAmounts()).toEqual([4, 2, 3, 1]);

    fireEvent.click(document.querySelector(`[data-ui="${UI.journal.sortDesc}"]`)!);
    expect(rowTitles()).toEqual(['うどん', 'いちご', 'あんぱん', 'あんぱん']);
    // 降順でも同じ摘要どうしの相対順は基準順のまま（方向で入れ替わらない）。
    expect(rowAmounts()).toEqual([1, 3, 4, 2]);
  });
});

describe('抽出結果の件数と合計', () => {
  it('テキスト検索の合計は単純和で、表示行の集合と一致する', async () => {
    await createSortFixtures();
    render(<View filter={MARCH} />);
    await screen.findByText('ソートA');

    // 絞り込みなし（期間内全行）: 4 件・単純和 300+100+100+200。
    expect(summaryText()).toContain('4件');
    expect(summaryText()).toContain(formatMoney(700, '円', 0));

    fireEvent.change(document.querySelector(`[data-ui="${UI.journal.search}"]`)!, {
      target: { value: 'ソートB' },
    });
    expect(rowTitles()).toEqual(['ソートB']);
    expect(summaryText()).toContain('1件');
    expect(summaryText()).toContain(formatMoney(100, '円', 0));
  });

  it('科目タップの抽出は方向つき和（増減の純額）を符号つきで出す', async () => {
    const ledger = await loadLedger();
    const cash = ledger.accounts.find((account) => account.role === 'daily-asset')!;
    const revenue = ledger.accounts.find((account) => account.role === 'income-category')!;
    const today = todayLocal();
    const timestamp = `${today}T00:00:00.000Z`;
    await upsertEntry({
      id: 'summary-income',
      date: today,
      description: '収入の仕訳',
      kind: 'normal',
      lines: [
        { accountId: cash.id, side: 'debit', amount: 5000 },
        { accountId: revenue.id, side: 'credit', amount: 5000 },
      ],
      metadata: { inputMode: 'income' },
      createdAt: timestamp,
      updatedAt: timestamp,
    });
    await upsertEntry({
      id: 'summary-income-reversal',
      date: today,
      description: '収入の取消',
      kind: 'normal',
      lines: [
        { accountId: revenue.id, side: 'debit', amount: 1200 },
        { accountId: cash.id, side: 'credit', amount: 1200 },
      ],
      metadata: { inputMode: 'reversal' },
      createdAt: timestamp,
      updatedAt: timestamp,
    });

    render(<View filter={{ accountId: revenue.id, from: today, to: today }} />);
    await screen.findByText('収入の仕訳');

    // 給与視点の方向つき和 = +5000 − 1200 = +3800（単純和 6200 ではない）。
    expect(summaryText()).toContain('2件');
    expect(summaryText()).toContain(`+${formatMoney(3800, '円', 0)}`);
    expect(summaryText()).not.toContain(formatMoney(6200, '円', 0));
    expect(
      document.querySelector(`[data-ui="${UI.journal.summary}"] .amount--pos`),
    ).toHaveTextContent(formatMoney(3800, '円', 0));
  });

  it('月割りの導出行も対象に含み、合計・件数が表示行と一致する', async () => {
    const ledger = await loadLedger();
    const expense = ledger.accounts.find((account) => account.role === 'expense-category')!;
    const today = todayLocal();
    // 同日刻み: 購入日（today − 5ヶ月）の同日通過は today + 6ヶ月まで 11 本。
    // この網は「導出行が件数・合計に入るか」なので、11 で割り切れる額にして
    // 表示丸め（minor → 表示単位）の誤差が合計比較へ混ざらないようにする（66,000 / 11 = 6,000）。
    await createContinuousCost({
      name: '月割り対象',
      amount: 66000,
      startDate: addMonthsToDate(today, -5),
      endDate: addMonthsToDate(today, 6),
      expenseAccountId: expense.id,
    });

    render(<View />);
    await waitFor(() => {
      expect(document.querySelector(`[data-ui="${UI.journal.view}"]`)).toBeInTheDocument();
    });
    const rows = await screen.findAllByText('月割り対象');
    // 購入の仕訳（保存）+ 費用行（導出）が両方表示されている。
    expect(rows.length).toBeGreaterThanOrEqual(2);

    // 表示行の金額を実際に数えて足すと、ヘッダの件数・合計とちょうど一致する（単純和）。
    const amounts = Array.from(
      document.querySelectorAll(`[data-ui="${UI.journal.list}"] .list__amount`),
    ).map((el) => Number((el.textContent ?? '').replace(/[^0-9-]/g, '')));
    expect(amounts.length).toBeGreaterThanOrEqual(2);
    const total = amounts.reduce((sum, value) => sum + value, 0);
    expect(summaryText()).toContain(`${amounts.length}件`);
    // 表示テキストから拾った数値は「表示単位」なので minor（×100）へ戻して比較する。
    expect(summaryText()).toContain(formatMoney(total * 100, '円', 0));
  });
});
