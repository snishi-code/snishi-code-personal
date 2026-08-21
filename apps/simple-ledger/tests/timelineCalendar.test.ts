import { describe, expect, it } from 'vitest';
import { CONTINUOUS_COST_LEDGER_ACCOUNT_ID } from '../src/domain/constants';
import {
  buildTimelineBuckets,
  buildTimelineCalendar,
  type TimelineBoxDefinition,
} from '../src/domain/timelineCalendar';
import type {
  Account,
  EntryMetadata,
  JournalEntry,
  MonthlyCostItem,
  RecurringRule,
} from '../src/domain/types';
import './setup';

const ts = '2026-01-01T00:00:00.000Z';

function account(
  id: string,
  type: Account['type'],
  role: Account['role'],
  startDate: string,
  endDate?: string,
): Account {
  return {
    id,
    name: id,
    type,
    role,
    startDate,
    ...(endDate ? { endDate, archived: true } : { archived: false }),
    createdAt: ts,
    updatedAt: ts,
  };
}

function entry(
  id: string,
  date: string,
  debitAccountId: string,
  creditAccountId: string,
  amount: number,
  metadata?: EntryMetadata,
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
    ...(metadata ? { metadata } : {}),
    createdAt: ts,
    updatedAt: ts,
  };
}

const accounts: Account[] = [
  account('cash-a', 'asset', 'daily-asset', '2025-01-01'),
  account('cash-b', 'asset', 'daily-asset', '2025-01-01'),
  // 月割りルールの導出は継続コスト台帳を実 ID で引く（保存された正規形と同じ形）。
  account(CONTINUOUS_COST_LEDGER_ACCOUNT_ID, 'asset', 'continuing-cost-asset', '2025-01-01'),
  account('expense', 'expense', 'expense-category', '2025-01-01'),
  account('income', 'revenue', 'income-category', '2025-01-01'),
];

const boxes: TimelineBoxDefinition[] = [
  { key: 'assetFree', accountIds: ['cash-a', 'cash-b'] },
  {
    key: 'continuingCost',
    accountIds: [CONTINUOUS_COST_LEDGER_ACCOUNT_ID],
    kind: 'continuousCost',
  },
  { key: 'income', accountIds: ['income'] },
  { key: 'expense', accountIds: ['expense'] },
];

function build(options: Partial<Parameters<typeof buildTimelineCalendar>[0]> = {}) {
  return buildTimelineCalendar({
    accounts,
    entries: [],
    monthlyCostItems: [],
    recurringRules: [],
    boxes,
    range: { start: '2026-01-01', end: '2026-01-31' },
    zoom: 'day',
    showOutsideRange: false,
    ...options,
  });
}

describe('timeline calendar buckets', () => {
  it('日・月・年の境界を表示範囲へクランプする', () => {
    expect(
      buildTimelineBuckets({ start: '2026-01-30', end: '2026-02-02' }, 'day').map(
        (bucket) => bucket.key,
      ),
    ).toEqual(['2026-01-30', '2026-01-31', '2026-02-01', '2026-02-02']);
    expect(buildTimelineBuckets({ start: '2026-01-15', end: '2026-03-03' }, 'month')).toEqual([
      { key: '2026-01', startDate: '2026-01-15', endDate: '2026-01-31' },
      { key: '2026-02', startDate: '2026-02-01', endDate: '2026-02-28' },
      { key: '2026-03', startDate: '2026-03-01', endDate: '2026-03-03' },
    ]);
    expect(buildTimelineBuckets({ start: '2025-12-01', end: '2027-02-01' }, 'year')).toEqual([
      { key: '2025', startDate: '2025-12-01', endDate: '2025-12-31' },
      { key: '2026', startDate: '2026-01-01', endDate: '2026-12-31' },
      { key: '2027', startDate: '2027-01-01', endDate: '2027-02-01' },
    ]);
  });
});

describe('buildTimelineCalendar', () => {
  it('箱内移動を箱では相殺し、月バケットを借方−貸方の純額へ集約する', () => {
    const model = build({
      zoom: 'month',
      entries: [
        entry('inside', '2026-01-02', 'cash-a', 'cash-b', 100),
        entry('spend', '2026-01-10', 'expense', 'cash-a', 50),
        entry('refund', '2026-01-11', 'cash-a', 'expense', 10),
      ],
    });

    const cash = model.boxes.find((box) => box.key === 'assetFree')!;
    const expense = model.boxes.find((box) => box.key === 'expense')!;
    expect(cash.dots).toHaveLength(1);
    expect(cash.dots[0]).toMatchObject({ bucketKey: '2026-01', netChange: -40 });
    expect(cash.dots[0]?.flows.map((flow) => flow.id)).toEqual(['spend', 'refund']);
    expect(expense.dots[0]).toMatchObject({ netChange: 40 });

    expect(cash.accountRows.find((row) => row.account.id === 'cash-a')?.dots[0]).toMatchObject({
      netChange: 60,
    });
    expect(cash.accountRows.find((row) => row.account.id === 'cash-b')?.dots[0]).toMatchObject({
      netChange: -100,
    });
  });

  it('同じ科目・同じ日は1つのポッチへまとめ、内訳のフローは失わない', () => {
    const model = build({
      entries: [
        entry('morning', '2026-01-10', 'expense', 'cash-a', 30),
        entry('evening', '2026-01-10', 'expense', 'cash-a', 20),
      ],
    });
    const row = model.boxes
      .find((box) => box.key === 'expense')
      ?.accountRows.find((candidate) => candidate.account.id === 'expense');
    expect(row?.dots).toHaveLength(1);
    expect(row?.dots[0]).toMatchObject({
      bucketKey: '2026-01-10',
      netChange: 50,
    });
    expect(row?.dots[0]?.flows.map((flow) => flow.id)).toEqual(['evening', 'morning']);
  });

  it('日表示は同日の入出金が相殺してもポッチを残し、月・年は純額0を省く', () => {
    const entries = [
      entry('outflow', '2026-01-10', 'expense', 'cash-a', 50),
      entry('inflow', '2026-01-10', 'cash-a', 'expense', 50),
    ];

    const daily = build({ entries, zoom: 'day' });
    const dailyAccount = daily.boxes
      .find((box) => box.key === 'assetFree')
      ?.accountRows.find((row) => row.account.id === 'cash-a');
    const dailyBox = daily.boxes.find((box) => box.key === 'assetFree');
    expect(dailyAccount?.dots).toHaveLength(1);
    expect(dailyAccount?.dots[0]).toMatchObject({
      bucketKey: '2026-01-10',
      netChange: 0,
    });
    expect(dailyAccount?.dots[0]?.flows.map((flow) => flow.id)).toEqual(['inflow', 'outflow']);
    expect(dailyBox?.dots).toHaveLength(1);
    expect(dailyBox?.dots[0]?.netChange).toBe(0);

    const monthly = build({ entries, zoom: 'month' });
    expect(
      monthly.boxes
        .find((box) => box.key === 'assetFree')
        ?.accountRows.find((row) => row.account.id === 'cash-a')?.dots,
    ).toEqual([]);
    expect(monthly.boxes.find((box) => box.key === 'assetFree')?.dots).toEqual([]);

    const yearly = build({ entries, zoom: 'year' });
    expect(
      yearly.boxes
        .find((box) => box.key === 'assetFree')
        ?.accountRows.find((row) => row.account.id === 'cash-a')?.dots,
    ).toEqual([]);
    expect(yearly.boxes.find((box) => box.key === 'assetFree')?.dots).toEqual([]);
  });

  it('実仕訳・月割り・未来ルールを同じflowにし、開く先だけを解決する', () => {
    const item: MonthlyCostItem = {
      id: 'item-1',
      name: 'item',
      amount: 120,
      startDate: '2026-01-01',
      endDate: '2026-12-31',
      expenseAccountId: 'expense',
      createdAt: ts,
      updatedAt: ts,
    };
    const model = build({
      monthlyCostItems: [item],
      entries: [
        entry('real', '2026-01-05', 'expense', 'cash-a', 20),
        entry('allocation', '2026-01-06', 'expense', CONTINUOUS_COST_LEDGER_ACCOUNT_ID, 10, {
          virtual: true,
          continuousCostId: item.id,
          ccKind: 'monthly-allocation',
        }),
        entry('projection', '2026-01-20', 'cash-a', 'income', 200, {
          virtual: true,
          recurringRuleId: 'rule-1',
          recurringMonth: '2026-01',
        }),
      ],
    });
    const allFlows = model.boxes.flatMap((box) => box.dots.flatMap((dot) => dot.flows));
    const targetById = new Map(allFlows.map((flow) => [flow.id, flow.target] as const));
    expect(targetById.get('real')).toEqual({ kind: 'entry', entryId: 'real' });
    expect(targetById.get('allocation')).toEqual({
      kind: 'monthlyCost',
      monthlyCostId: 'item-1',
    });
    expect(targetById.get('projection')).toEqual({
      kind: 'recurringRule',
      recurringRuleId: 'rule-1',
    });
  });

  it('旧・利回り投影の印を持つ導出行もフローから捨てない（開く先だけが無い）', () => {
    // 生成源は撤去済みだが、導出行の扱いは「由来を名乗らない virtual」と同じ:
    // 黙って捨てると画面間で数字がずれる。target なしのフローとして出す。
    const model = build({
      entries: [
        entry('inv-proj-cash-a-2026-01', '2026-01-01', 'cash-a', 'income', 949, {
          virtual: true,
          investmentProjectionOf: 'cash-a',
        }),
      ],
    });
    const allFlows = model.boxes.flatMap((box) => box.dots.flatMap((dot) => dot.flows));
    const flow = allFlows.find((candidate) => candidate.id === 'inv-proj-cash-a-2026-01');
    expect(flow).toBeDefined();
    expect(flow!.target).toBeUndefined();
  });

  it('由来を名乗らない導出行もフローから捨てない（開く先だけが無い）', () => {
    // 未知の種類の導出行が「片方の画面では消え、数字がずれる」ことを防ぐ:
    // フロー（金額・純増減）は残し、target だけを undefined にする。
    const model = build({
      entries: [entry('unknown-virtual', '2026-01-10', 'cash-a', 'income', 500, { virtual: true })],
    });
    const allFlows = model.boxes.flatMap((box) => box.dots.flatMap((dot) => dot.flows));
    const flow = allFlows.find((candidate) => candidate.id === 'unknown-virtual');
    expect(flow).toBeDefined();
    expect(flow!.amount).toBe(500);
    expect(flow!.target).toBeUndefined();
    // 純増減にも織り込まれている（黙って消えない）。
    const incomeBox = model.boxes.find((box) => box.key === 'income')!;
    expect(incomeBox.dots.some((dot) => dot.netChange !== 0)).toBe(true);
  });

  it('横軸に交差する過去科目・未来itemだけを並べ、終了分表示で範囲外も戻す', () => {
    const datedAccounts = [
      account('past', 'asset', 'daily-asset', '2020-01-01', '2024-12-31'),
      account('current', 'asset', 'daily-asset', '2026-01-01'),
      account(CONTINUOUS_COST_LEDGER_ACCOUNT_ID, 'asset', 'continuing-cost-asset', '2020-01-01'),
      account('expense', 'expense', 'expense-category', '2020-01-01'),
    ];
    const items: MonthlyCostItem[] = [
      {
        id: 'past-item',
        name: 'past item',
        amount: 1,
        startDate: '2024-01-01',
        endDate: '2024-12-31',
        expenseAccountId: 'expense',
        createdAt: ts,
        updatedAt: ts,
      },
      {
        id: 'future-item',
        name: 'future item',
        amount: 1,
        startDate: '2027-01-01',
        endDate: '2027-12-31',
        expenseAccountId: 'expense',
        createdAt: ts,
        updatedAt: ts,
      },
    ];
    const customBoxes: TimelineBoxDefinition[] = [
      { key: 'assetFree', accountIds: ['past', 'current'] },
      {
        key: 'continuingCost',
        accountIds: [CONTINUOUS_COST_LEDGER_ACCOUNT_ID],
        kind: 'continuousCost',
      },
      { key: 'expense', accountIds: ['expense'] },
    ];

    const past = build({
      accounts: datedAccounts,
      boxes: customBoxes,
      monthlyCostItems: items,
      range: { start: '2024-06-01', end: '2024-06-30' },
    });
    expect(
      past.boxes.find((box) => box.key === 'assetFree')?.accountRows.map((row) => row.account.id),
    ).toEqual(['past']);
    expect(
      past.boxes
        .find((box) => box.key === 'continuingCost')
        ?.continuousCost?.standaloneItems.map((row) => row.item.id),
    ).toEqual(['past-item']);

    const future = build({
      accounts: datedAccounts,
      boxes: customBoxes,
      monthlyCostItems: items,
      range: { start: '2027-06-01', end: '2027-06-30' },
    });
    expect(
      future.boxes
        .find((box) => box.key === 'continuingCost')
        ?.continuousCost?.standaloneItems.map((row) => row.item.id),
    ).toEqual(['future-item']);

    const all = build({
      accounts: datedAccounts,
      boxes: customBoxes,
      monthlyCostItems: items,
      range: { start: '2026-06-01', end: '2026-06-30' },
      showOutsideRange: true,
    });
    expect(
      all.boxes.find((box) => box.key === 'assetFree')?.accountRows.map((row) => row.account.id),
    ).toEqual(['past', 'current']);
    expect(
      all.boxes
        .find((box) => box.key === 'continuingCost')
        ?.continuousCost?.standaloneItems.map((row) => row.item.id),
    ).toEqual(['past-item', 'future-item']);
  });

  it('終了日不明の旧アーカイブ科目を未来へ開いた線分として描かない', () => {
    const archivedWithoutEnd = {
      ...account('legacy-ended', 'asset', 'daily-asset', '2020-01-01'),
      archived: true,
    };
    const current = account('current', 'asset', 'daily-asset', '2026-01-01');
    const customBoxes: TimelineBoxDefinition[] = [
      { key: 'assetFree', accountIds: [archivedWithoutEnd.id, current.id] },
    ];

    const normal = build({ accounts: [archivedWithoutEnd, current], boxes: customBoxes });
    expect(normal.boxes[0]?.accountRows.map((row) => row.account.id)).toEqual(['current']);

    const withEnded = build({
      accounts: [archivedWithoutEnd, current],
      boxes: customBoxes,
      showOutsideRange: true,
    });
    const legacyRow = withEnded.boxes[0]?.accountRows.find(
      (row) => row.account.id === archivedWithoutEnd.id,
    );
    expect(legacyRow?.spans).toEqual([]);
  });

  it('残高調整科目を費用箱の通常の内訳として表示し、箱の純増減にも含める', () => {
    const adjustment = account('balance-expense', 'expense', 'system-adjustment', '2025-01-01');
    const customAccounts = [...accounts, adjustment];
    const customBoxes: TimelineBoxDefinition[] = [
      { key: 'assetFree', accountIds: ['cash-a', 'cash-b'] },
      { key: 'expense', accountIds: [adjustment.id] },
    ];
    const model = build({
      accounts: customAccounts,
      boxes: customBoxes,
      entries: [entry('adjustment', '2026-01-10', adjustment.id, 'cash-a', 50)],
    });

    expect(model.boxes.find((box) => box.key === 'assetFree')?.dots[0]?.netChange).toBe(-50);
    const expenseBox = model.boxes.find((box) => box.key === 'expense');
    expect(expenseBox?.dots[0]?.netChange).toBe(50);
    // 内訳の帯としても現れる（聖域は科目管理だけ・表示は普通に）。
    const adjustmentRow = expenseBox?.accountRows.find((row) => row.account.id === adjustment.id);
    expect(adjustmentRow).toBeDefined();
    expect(adjustmentRow?.dots[0]?.netChange).toBe(50);
  });

  it('費用ルールの帯へ導出itemを束ね、範囲内の起票日に生成ポッチを立てる', () => {
    // v13: ルール由来 item は保存されない。buildTimelineCalendar が範囲末日を断面として
    // 毎回導出するので、渡すのはルールだけ（保存 ccr- を混ぜても読まれない）。
    const rule: RecurringRule = {
      id: 'rent-rule',
      name: 'rent',
      amount: 120,
      dayOfMonth: 20,
      everyMonths: 1,
      spreadExpenseAccountId: 'expense',
      debitAccountId: CONTINUOUS_COST_LEDGER_ACCOUNT_ID,
      creditAccountId: 'cash-a',
      startMonth: '2026-01',
      startDate: '2026-01-01',
      createdAt: ts,
      updatedAt: ts,
    };
    const model = build({
      range: { start: '2026-02-01', end: '2026-02-28' },
      zoom: 'month',
      recurringRules: [rule],
    });
    const group = model.boxes.find((box) => box.key === 'continuingCost')?.continuousCost
      ?.ruleGroups[0];
    expect(group?.rule.id).toBe('rent-rule');
    // 1 月起票ぶんの item は [1/20, 2/20]（終了日 = 次回起票日）なので 2 月とも交差する。
    expect(group?.items.map((row) => row.item.startDate)).toEqual(['2026-01-20', '2026-02-20']);
    expect(group?.items[0]).toMatchObject({ ruleDerived: true, originRuleId: 'rent-rule' });
    expect(group?.items[1]).toMatchObject({ ruleDerived: true, originRuleId: 'rent-rule' });
    // 生成ポッチは起票日が範囲内の回だけ（1 月の起票日は範囲外）。
    expect(group?.generationDots).toHaveLength(1);
    expect(group?.generationDots[0]?.date).toBe('2026-02-20');
    expect(group?.generationDots[0]?.items[0]).toMatchObject({ ruleDerived: true });
    expect(group?.generationDots[0]?.items[0]?.target).toEqual({
      kind: 'recurringRule',
      recurringRuleId: 'rent-rule',
    });
  });
});
