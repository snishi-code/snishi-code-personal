/*
 * 予定 pin の理論残高（v13.5 C-3）。
 *
 * 補正シートが見せる「理論残高 / 差分」と repository が保存する expectedBalance は
 * **同じヘルパ**（adjustmentPinExpectedBalanceForLedger → adjustmentSpread の走査）を通る。
 * ここで固定するのは 2 つ:
 *  1. **差分 = 実際に按分されるスライスの合計**（投資科目を含む全科目）。
 *  2. 従来値（その日までの導出残高）と一致する = 回帰。
 */
import { describe, expect, it } from 'vitest';
import './setup';
import { accountBalance, filterByDateRange } from '../src/domain/accounting';
import { buildAdjustmentEntry } from '../src/domain/adjustment';
import {
  adjustmentPinExpectedBalanceForLedger,
  reportEntriesForAsOf,
} from '../src/domain/reportEntries';
import { sumAmounts } from '../src/domain/safeSum';
import type { Account, AccountType, JournalEntry, Ledger } from '../src/domain/types';

const TS = '2026-01-01T00:00:00.000Z';

function account(
  id: string,
  type: AccountType,
  role: Account['role'],
  extra: Partial<Account> = {},
): Account {
  return { id, name: id, type, role, archived: false, createdAt: TS, updatedAt: TS, ...extra };
}

const ACCOUNTS: Account[] = [
  account('cash', 'asset', 'daily-asset'),
  account('equity', 'equity', 'equity'),
  account('loan', 'liability', 'other-liability'),
  account('food', 'expense', 'expense-category'),
  account('salary', 'revenue', 'income-category'),
  account('adj-exp', 'expense', 'system-adjustment'),
  account('adj-rev', 'revenue', 'system-adjustment'),
  { ...account('invest', 'asset', 'daily-asset'), movable: false },
  account('gain', 'revenue', 'income-category'),
];

type Source = Pick<Ledger, 'accounts' | 'journalEntries' | 'monthlyCostItems' | 'recurringRules'>;

function source(journalEntries: JournalEntry[]): Source {
  return { accounts: ACCOUNTS, journalEntries, monthlyCostItems: [], recurringRules: [] };
}

function flow(
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
    createdAt: TS,
    updatedAt: TS,
  };
}

function pin(args: {
  id: string;
  accountId: string;
  accountType: 'asset' | 'liability' | 'expense' | 'revenue';
  date: string;
  actual: number;
  expected?: number;
}): JournalEntry {
  const expected = args.expected ?? 0;
  const entry = buildAdjustmentEntry({
    accountId: args.accountId,
    accountType: args.accountType,
    date: args.date,
    description: `補正: ${args.accountId}`,
    expectedBalance: expected,
    actualBalance: args.actual,
    counterpartAccountId: args.actual - expected > 0 ? 'adj-rev' : 'adj-exp',
    existing: { id: args.id, createdAt: TS },
  });
  if (!entry) throw new Error('pin は差額 0 では作れない（テストの前提が壊れている）');
  return entry;
}

/** 従来の算定（その日までの導出残高）。非投資科目ではこれと一致し続ける。 */
function legacyExpected(src: Source, accountId: string, type: AccountType, date: string): number {
  return accountBalance(
    accountId,
    type,
    filterByDateRange(reportEntriesForAsOf(src, date), undefined, date),
  );
}

/** その pin が実際に生んだスライスの、対象科目から見た自然符号の合計。 */
function sliceTotalFor(
  src: Source,
  pinId: string,
  accountId: string,
  debitIsPlus: boolean,
): number {
  const lines = reportEntriesForAsOf(src, '2999-12-31')
    .filter((entry) => entry.metadata?.adjustmentSliceOf === pinId)
    .flatMap((entry) => entry.lines.filter((line) => line.accountId === accountId));
  return sumAmounts(
    lines.map((line) => ((line.side === 'debit') === debitIsPlus ? line.amount : -line.amount)),
  );
}

describe('投資科目: シートの差分 = 実際に按分されるスライスの合計', () => {
  const opening = flow('open', '2026-01-10', 'invest', 'equity', 100_000);

  it('理論残高は非補正フローそのもの（利回りの導出益は存在しない・v13.17）', () => {
    const src = source([opening]);
    // 投資科目でも従来値（導出残高）と理論残高が一致する（複利の導出は撤去済み）。
    expect(legacyExpected(src, 'invest', 'asset', '2027-01-10')).toBe(100_000);
    expect(
      adjustmentPinExpectedBalanceForLedger(src, { accountId: 'invest', date: '2027-01-10' }),
    ).toBe(100_000);
  });

  it('その差分どおりのスライスが按分される（保存後に食い違わない）', () => {
    const src = source([opening]);
    const date = '2027-01-10';
    const actual = 130_000;
    const expected = adjustmentPinExpectedBalanceForLedger(src, { accountId: 'invest', date });
    const delta = actual - expected;

    const saved = source([
      opening,
      pin({ id: 'p1', accountId: 'invest', accountType: 'asset', date, actual, expected }),
    ]);
    expect(sliceTotalFor(saved, 'p1', 'invest', true)).toBe(delta);
    // 宣言した日の残高は実額ちょうど（按分の不変条件）。
    expect(accountBalance('invest', 'asset', reportEntriesForAsOf(saved, date))).toBe(actual);
  });

  it('2 本目の pin も同じ（1 本目の宣言を織り込む）', () => {
    const first = pin({
      id: 'p1',
      accountId: 'invest',
      accountType: 'asset',
      date: '2026-07-10',
      actual: 110_000,
      expected: 100_000,
    });
    const src = source([opening, first]);
    const date = '2027-01-10';
    const expected = adjustmentPinExpectedBalanceForLedger(src, { accountId: 'invest', date });
    // 1 本目の実額がそのまま次の pin の理論残高になる（複利は 1 円も乗らない）。
    expect(expected).toBe(110_000);

    const actual = 125_000;
    const saved = source([
      opening,
      first,
      pin({ id: 'p2', accountId: 'invest', accountType: 'asset', date, actual, expected }),
    ]);
    expect(sliceTotalFor(saved, 'p2', 'invest', true)).toBe(actual - expected);
  });
});

describe('非投資科目: 従来値（その日までの導出残高）と一致する', () => {
  it.each([
    {
      name: '資産・pin なし',
      accountId: 'cash',
      type: 'asset' as const,
      debitIsPlus: true,
      entries: [flow('o', '2026-01-10', 'cash', 'equity', 10_000)],
    },
    {
      name: '資産・手前に pin あり',
      accountId: 'cash',
      type: 'asset' as const,
      debitIsPlus: true,
      entries: [
        flow('o', '2026-01-10', 'cash', 'equity', 10_000),
        pin({
          id: 'p1',
          accountId: 'cash',
          accountType: 'asset',
          date: '2026-04-10',
          actual: 9_700,
          expected: 10_000,
        }),
      ],
    },
    {
      name: '負債',
      accountId: 'loan',
      type: 'liability' as const,
      debitIsPlus: false,
      entries: [flow('o', '2026-01-10', 'cash', 'loan', 200_000)],
    },
    {
      name: '費用（その日までの累計）',
      accountId: 'food',
      type: 'expense' as const,
      debitIsPlus: true,
      entries: [
        flow('f1', '2026-02-10', 'food', 'cash', 3_000),
        flow('f2', '2026-05-10', 'food', 'cash', 4_000),
      ],
    },
    {
      name: '収入（その日までの累計）',
      accountId: 'salary',
      type: 'revenue' as const,
      debitIsPlus: false,
      entries: [flow('s1', '2026-03-10', 'cash', 'salary', 250_000)],
    },
  ])('$name', ({ accountId, type, entries }) => {
    const src = source(entries);
    const date = '2026-07-10';
    expect(adjustmentPinExpectedBalanceForLedger(src, { accountId, date })).toBe(
      legacyExpected(src, accountId, type, date),
    );
  });

  it('編集（自分を除いた母集合 + probe）でも、後ろに pin が無ければ従来値と一致する', () => {
    const target = pin({
      id: 'p1',
      accountId: 'cash',
      accountType: 'asset',
      date: '2026-07-10',
      actual: 9_000,
      expected: 10_000,
    });
    const entries = [flow('o', '2026-01-10', 'cash', 'equity', 10_000), target];
    const others = entries.filter((e) => e.id !== target.id);
    const date = '2026-08-10';
    expect(
      adjustmentPinExpectedBalanceForLedger(source(others), {
        accountId: 'cash',
        date,
        id: target.id,
        createdAt: target.createdAt,
      }),
    ).toBe(legacyExpected(source(others), 'cash', 'asset', date));
  });

  it('補正できない科目・存在しない科目は 0（保存境界が別途 fail-closed に弾く）', () => {
    const src = source([flow('o', '2026-01-10', 'cash', 'equity', 10_000)]);
    expect(
      adjustmentPinExpectedBalanceForLedger(src, { accountId: 'equity', date: '2026-07-10' }),
    ).toBe(0);
    expect(
      adjustmentPinExpectedBalanceForLedger(src, { accountId: 'no-such', date: '2026-07-10' }),
    ).toBe(0);
  });
});
