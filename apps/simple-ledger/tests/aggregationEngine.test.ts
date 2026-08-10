/*
 * C-3 抽出→合計の統一エンジンと C-6 恒等式の常設監視。
 *
 *  - 恒等式（equity の集計上の定義・accounting.ts が正本）:
 *      年末純資産 − 前年末純資産 = 当年の収支（収益 − 費用） + 当年の equity 自然増減
 *    を、実データ規模の生成データ（seed 固定・導出込み仕訳）で全期間・年別に検証する。
 *  - accounting 系（deriveProfitAndLoss / deriveBalanceSheet）と periodMatrix 系が
 *    同じ入力で同じ収支・純資産を返すことを検証する。
 *  - 統一集計関数（方向つき和 / 単純和）の単体検証。
 */
import { describe, expect, it } from 'vitest';
import './setup';
import {
  deriveBalanceSheet,
  deriveProfitAndLoss,
  entryAmount,
  equityNaturalDelta,
  monthRange,
  naturalDelta,
  summarizeEntries,
  summarizeEntriesForAccount,
} from '../src/domain/accounting';
import { buildPeriodMatrix } from '../src/domain/periodMatrix';
import { reportEntriesForAsOf } from '../src/domain/reportEntries';
import {
  CONTINUOUS_COST_LEDGER_ACCOUNT_ID,
  CONTINUOUS_COST_LEDGER_ACCOUNT_NAME,
} from '../src/domain/constants';
import type {
  Account,
  EntryMetadata,
  JournalEntry,
  MonthlyCostItem,
  RecurringRule,
} from '../src/domain/types';

function account(id: string, name: string, type: Account['type'], role: Account['role']): Account {
  return {
    id,
    name,
    type,
    role,
    archived: false,
    createdAt: '2019-01-01T00:00:00.000Z',
    updatedAt: '2019-01-01T00:00:00.000Z',
  };
}

function entry(
  id: string,
  date: string,
  debitAccountId: string,
  creditAccountId: string,
  amount: number,
  options: { kind?: JournalEntry['kind']; metadata?: EntryMetadata } = {},
): JournalEntry {
  return {
    id,
    date,
    description: id,
    kind: options.kind ?? 'normal',
    lines: [
      { accountId: debitAccountId, side: 'debit', amount },
      { accountId: creditAccountId, side: 'credit', amount },
    ],
    ...(options.metadata ? { metadata: options.metadata } : {}),
    createdAt: '2019-01-01T00:00:00.000Z',
    updatedAt: '2019-01-01T00:00:00.000Z',
  };
}

function item(
  id: string,
  name: string,
  amount: number,
  startDate: string,
  endDate: string | undefined,
  expenseAccountId: string,
): MonthlyCostItem {
  return {
    id,
    name,
    amount,
    startDate,
    ...(endDate !== undefined ? { endDate } : {}),
    expenseAccountId,
    createdAt: '2019-01-01T00:00:00.000Z',
    updatedAt: '2019-01-01T00:00:00.000Z',
  };
}

const cash = account('cash', '現金', 'asset', 'daily-asset');
const bank = account('bank', '銀行', 'asset', 'daily-asset');
const ledger = account(
  CONTINUOUS_COST_LEDGER_ACCOUNT_ID,
  CONTINUOUS_COST_LEDGER_ACCOUNT_NAME,
  'asset',
  'continuing-cost-asset',
);
const card = account('card', 'カード', 'liability', 'payment-liability');
const loan = account('loan', 'ローン', 'liability', 'other-liability');
const capital = account('capital', '元入金', 'equity', 'equity');
const salary = account('salary', '給与', 'revenue', 'income-category');
const food = account('food', '食費', 'expense', 'expense-category');
const rent = account('rent', '住居費', 'expense', 'expense-category');
const utility = account('utility', '光熱費', 'expense', 'expense-category');
const accounts = [cash, bank, ledger, card, loan, capital, salary, food, rent, utility];

/* ── 実データ規模の生成データ（seed 固定） ── */

const FIXTURE_YEARS = [2020, 2021, 2022, 2023, 2024, 2025, 2026] as const;
const FIXTURE_AS_OF = '2026-12-31';

/** seed 固定の擬似乱数（Park–Miller LCG）。再現性のため Math.random は使わない。 */
function createRandom(seed: number): () => number {
  let state = seed % 2147483647;
  if (state <= 0) state += 2147483646;
  return () => {
    state = (state * 48271) % 2147483647;
    return state / 2147483647;
  };
}

function buildFixtureSource(): {
  accounts: Account[];
  journalEntries: JournalEntry[];
  monthlyCostItems: MonthlyCostItem[];
  recurringRules: RecurringRule[];
} {
  const rand = createRandom(20260810);
  const intBetween = (min: number, max: number) => min + Math.floor(rand() * (max - min + 1));
  const pick = <T>(values: readonly T[]): T => values[Math.floor(rand() * values.length)]!;
  const dateIn = (year: number) =>
    `${year}-${String(intBetween(1, 12)).padStart(2, '0')}-${String(intBetween(1, 28)).padStart(2, '0')}`;

  const journalEntries: JournalEntry[] = [
    entry('opening-cash', '2019-12-31', 'cash', 'capital', 1_000_000, { kind: 'opening' }),
    entry('opening-bank', '2019-12-31', 'bank', 'capital', 3_000_000, { kind: 'opening' }),
  ];
  for (const year of FIXTURE_YEARS) {
    // equity の動き（追加出資・引き出し）= 収支に入らない純資産変動を毎年混ぜる。
    journalEntries.push(
      entry(`equity-in-${year}`, dateIn(year), 'cash', 'capital', intBetween(10_000, 200_000)),
      entry(`equity-out-${year}`, dateIn(year), 'capital', 'cash', intBetween(1_000, 50_000)),
    );
    for (let index = 0; index < 500; index++) {
      const id = `gen-${year}-${index}`;
      const roll = rand();
      if (roll < 0.15) {
        // 収入
        journalEntries.push(
          entry(id, dateIn(year), pick(['cash', 'bank']), 'salary', intBetween(1_000, 400_000)),
        );
      } else if (roll < 0.6) {
        // 支出（現金・銀行・カード払い）
        journalEntries.push(
          entry(
            id,
            dateIn(year),
            pick(['food', 'rent', 'utility']),
            pick(['cash', 'bank', 'card']),
            intBetween(100, 30_000),
          ),
        );
      } else if (roll < 0.75) {
        // カード引き落とし
        journalEntries.push(entry(id, dateIn(year), 'card', 'bank', intBetween(1_000, 50_000)));
      } else if (roll < 0.85) {
        // 資金間の振替
        journalEntries.push(entry(id, dateIn(year), 'bank', 'cash', intBetween(1_000, 100_000)));
      } else if (roll < 0.92) {
        // 借入
        journalEntries.push(entry(id, dateIn(year), 'cash', 'loan', intBetween(10_000, 300_000)));
      } else {
        // 返済
        journalEntries.push(entry(id, dateIn(year), 'loan', 'bank', intBetween(1_000, 50_000)));
      }
    }
  }

  const monthlyCostItems: MonthlyCostItem[] = [
    item('item-2020', '18ヶ月償却', 180_000, '2020-04-10', '2021-09-30', 'rent'),
    item('item-2022', '半年償却', 66_000, '2022-07-01', '2022-12-31', 'utility'),
    item('item-2024', '2年償却（年またぎ）', 240_000, '2024-02-15', '2026-01-31', 'food'),
    item('item-open', '終了日なし（配分ゼロ）', 50_000, '2025-05-20', undefined, 'food'),
  ];
  for (const costItem of monthlyCostItems) {
    // 購入の仕訳（借方 継続コスト台帳 / 貸方 支払い元・item と 1:1）。
    journalEntries.push(
      entry(
        `purchase-${costItem.id}`,
        costItem.startDate,
        CONTINUOUS_COST_LEDGER_ACCOUNT_ID,
        'bank',
        costItem.amount,
        { metadata: { monthlyCostId: costItem.id } },
      ),
    );
  }
  // 回収の振替（割り振る総額 = amount − 回収額 の全知識再配分を恒等式へ含める）。
  journalEntries.push(
    entry('recovery-item-2020', '2021-03-31', 'bank', CONTINUOUS_COST_LEDGER_ACCOUNT_ID, 30_000, {
      metadata: { monthlyCostId: 'item-2020', monthlyCostRecovery: true },
    }),
  );

  // 未起票の定期ルール（費用行き）= 投影の購入行 + 月割り行も導出込み仕訳に混ぜる。
  const recurringRules: RecurringRule[] = [
    {
      id: 'rule-subscription',
      name: 'サブスク定期',
      amount: 2_980,
      dayOfMonth: 27,
      everyMonths: 1,
      spreadExpenseAccountId: 'utility',
      debitAccountId: CONTINUOUS_COST_LEDGER_ACCOUNT_ID,
      creditAccountId: 'bank',
      startMonth: '2025-02',
      startDate: '2025-02-01',
      createdAt: '2025-02-01T00:00:00.000Z',
      updatedAt: '2025-02-01T00:00:00.000Z',
    },
  ];

  return { accounts, journalEntries, monthlyCostItems, recurringRules };
}

const fixtureSource = buildFixtureSource();
const expandedEntries = reportEntriesForAsOf(fixtureSource, FIXTURE_AS_OF);

describe('恒等式: Δ純資産 = 収支 + equity自然増減', () => {
  it('生成データが実データ規模で、導出行（月割り・ルール投影）を含む', () => {
    expect(fixtureSource.journalEntries.length).toBeGreaterThan(3_000);
    expect(expandedEntries.length).toBeGreaterThan(fixtureSource.journalEntries.length);
    expect(expandedEntries.some((e) => e.id.startsWith('cc-alloc-'))).toBe(true);
    expect(expandedEntries.some((e) => e.id.startsWith('cc-allocp-'))).toBe(true);
    expect(expandedEntries.some((e) => e.id.startsWith('rec-proj-'))).toBe(true);
    expect(expandedEntries.some((e) => e.kind === 'opening')).toBe(true);
  });

  it('全期間で 1 円単位で成立する（純資産は 0 から始まる）', () => {
    const pl = deriveProfitAndLoss(accounts, expandedEntries);
    const bs = deriveBalanceSheet(accounts, expandedEntries);
    expect(bs.netAssets).toBe(pl.netIncome + equityNaturalDelta(accounts, expandedEntries));
  });

  it('年別に 1 円単位で成立する', () => {
    const netAssetsAt = (asOf: string) =>
      deriveBalanceSheet(accounts, expandedEntries, asOf).netAssets;
    for (const year of FIXTURE_YEARS) {
      const range = { from: `${year}-01-01`, to: `${year}-12-31` };
      const delta = netAssetsAt(range.to) - netAssetsAt(`${year - 1}-12-31`);
      const pl = deriveProfitAndLoss(accounts, expandedEntries, range);
      const equityDelta = equityNaturalDelta(accounts, expandedEntries, range);
      // equity が動かない年に退化していない（恒等式の右辺第 2 項が実際に効いている）。
      expect(equityDelta).not.toBe(0);
      expect(delta).toBe(pl.netIncome + equityDelta);
    }
  });
});

describe('エンジン一致: accounting 系と periodMatrix 系', () => {
  it('mode: all の各年列が deriveProfitAndLoss / deriveBalanceSheet と一致する', () => {
    const matrix = buildPeriodMatrix(accounts, expandedEntries, {
      mode: 'all',
      years: FIXTURE_YEARS,
    });
    expect(matrix.columns.map(({ key }) => key)).toEqual(FIXTURE_YEARS.map(String));
    FIXTURE_YEARS.forEach((year, index) => {
      const pl = deriveProfitAndLoss(accounts, expandedEntries, {
        from: `${year}-01-01`,
        to: `${year}-12-31`,
      });
      const bs = deriveBalanceSheet(accounts, expandedEntries, `${year}-12-31`);
      expect(matrix.rows.revenue[index]).toBe(pl.totalRevenue);
      expect(matrix.rows.expense[index]).toBe(pl.totalExpense);
      expect(matrix.rows.net[index]).toBe(pl.netIncome);
      expect(matrix.rows.netAssets[index]).toBe(bs.netAssets);
    });
  });

  it('mode: year の各月列が deriveProfitAndLoss / deriveBalanceSheet と一致する', () => {
    // 2021 = 回収の再配分がある年、2025 = ルール投影・終了日なし item がある年。
    for (const year of [2021, 2025]) {
      const matrix = buildPeriodMatrix(accounts, expandedEntries, { mode: 'year', year });
      for (let month = 1; month <= 12; month++) {
        const { from, to } = monthRange(year, month);
        const pl = deriveProfitAndLoss(accounts, expandedEntries, { from, to });
        const bs = deriveBalanceSheet(accounts, expandedEntries, to);
        const index = month - 1;
        expect(matrix.rows.revenue[index]).toBe(pl.totalRevenue);
        expect(matrix.rows.expense[index]).toBe(pl.totalExpense);
        expect(matrix.rows.net[index]).toBe(pl.netIncome);
        expect(matrix.rows.netAssets[index]).toBe(bs.netAssets);
      }
    }
  });
});

/* ── 統一集計関数の単体 ── */

const always = () => true;

describe('naturalDelta', () => {
  it('借方正の科目（asset/expense）は借方 +・貸方 −', () => {
    expect(naturalDelta(cash, 'debit', 100)).toBe(100);
    expect(naturalDelta(cash, 'credit', 100)).toBe(-100);
    expect(naturalDelta(food, 'debit', 100)).toBe(100);
    expect(naturalDelta(food, 'credit', 100)).toBe(-100);
  });
  it('貸方正の科目（liability/equity/revenue）は貸方 +・借方 −', () => {
    expect(naturalDelta(card, 'credit', 100)).toBe(100);
    expect(naturalDelta(card, 'debit', 100)).toBe(-100);
    expect(naturalDelta(capital, 'credit', 100)).toBe(100);
    expect(naturalDelta(capital, 'debit', 100)).toBe(-100);
    expect(naturalDelta(salary, 'credit', 100)).toBe(100);
    expect(naturalDelta(salary, 'debit', 100)).toBe(-100);
  });
});

describe('summarizeEntriesForAccount（方向つき和）', () => {
  const e1 = entry('e1', '2026-01-10', 'food', 'cash', 1_000);
  const e2 = entry('e2', '2026-01-20', 'cash', 'food', 300); // 返金（費用の減）
  const e3 = entry('e3', '2026-02-05', 'rent', 'cash', 500);
  const e4 = entry('e4', '2026-02-15', 'food', 'card', 800);

  it('指定科目の行だけを naturalDelta で合算する', () => {
    expect(summarizeEntriesForAccount(food, [e1, e2, e3, e4], always)).toEqual({
      count: 3,
      total: 1_500, // +1000 −300 +800
    });
    expect(summarizeEntriesForAccount(cash, [e1, e2, e3, e4], always)).toEqual({
      count: 3,
      total: -1_200, // −1000 +300 −500
    });
    expect(summarizeEntriesForAccount(card, [e1, e2, e3, e4], always)).toEqual({
      count: 1,
      total: 800, // 貸方正（負債の増加）
    });
  });

  it('述語で絞り、指定科目の行を持たない仕訳は件数にも入れない', () => {
    const january = (e: JournalEntry) => e.date < '2026-02-01';
    expect(summarizeEntriesForAccount(food, [e1, e2, e3, e4], january)).toEqual({
      count: 2,
      total: 700,
    });
    expect(summarizeEntriesForAccount(salary, [e1, e2, e3, e4], always)).toEqual({
      count: 0,
      total: 0,
    });
  });

  it('空集合は {count: 0, total: 0}', () => {
    expect(summarizeEntriesForAccount(food, [], always)).toEqual({ count: 0, total: 0 });
  });
});

describe('summarizeEntries（単純和）', () => {
  const e1 = entry('e1', '2026-01-10', 'food', 'cash', 1_000);
  const e2 = entry('e2', '2026-01-20', 'bank', 'cash', 300); // 振替も 1 回だけ数える
  const e3 = entry('e3', '2026-02-05', 'rent', 'cash', 500);

  it('仕訳ごとに金額（借方合計）を 1 回だけ数える（借方+貸方の二重計上をしない）', () => {
    expect(summarizeEntries([e1], always)).toEqual({ count: 1, total: 1_000 }); // 2000 ではない
    expect(summarizeEntries([e1, e2, e3], always)).toEqual({ count: 3, total: 1_800 });
  });

  it('複合仕訳（将来拡張）でも定義は「借方合計を 1 回」', () => {
    const composite: JournalEntry = {
      id: 'composite',
      date: '2026-04-01',
      description: '複合仕訳の想定',
      kind: 'normal',
      lines: [
        { accountId: 'food', side: 'debit', amount: 600 },
        { accountId: 'rent', side: 'debit', amount: 400 },
        { accountId: 'cash', side: 'credit', amount: 1_000 },
      ],
      createdAt: '2019-01-01T00:00:00.000Z',
      updatedAt: '2019-01-01T00:00:00.000Z',
    };
    expect(entryAmount(composite)).toBe(1_000);
    expect(summarizeEntries([composite], always)).toEqual({ count: 1, total: 1_000 });
  });

  it('述語で絞れる・空集合は {count: 0, total: 0}', () => {
    expect(summarizeEntries([e1, e2, e3], (e) => e.date < '2026-02-01')).toEqual({
      count: 2,
      total: 1_300,
    });
    expect(summarizeEntries([], always)).toEqual({ count: 0, total: 0 });
    expect(summarizeEntries([e1], () => false)).toEqual({ count: 0, total: 0 });
  });
});

describe('equityNaturalDelta', () => {
  const opening = entry('opening', '2026-01-01', 'cash', 'capital', 1_000, { kind: 'opening' });
  const drawing = entry('drawing', '2026-03-01', 'capital', 'cash', 200);
  const income = entry('income', '2026-02-01', 'cash', 'salary', 5_000);

  it('equity 行だけを貸方正で合算し、収益・費用・資産の行は無視する', () => {
    expect(equityNaturalDelta(accounts, [opening, drawing, income])).toBe(800);
    expect(equityNaturalDelta(accounts, [income])).toBe(0);
  });

  it('期間（両端を含む）で絞れる', () => {
    const all = [opening, drawing, income];
    expect(equityNaturalDelta(accounts, all, { from: '2026-01-01', to: '2026-01-31' })).toBe(1_000);
    expect(equityNaturalDelta(accounts, all, { from: '2026-03-01', to: '2026-03-01' })).toBe(-200);
    expect(equityNaturalDelta(accounts, all, { from: '2026-04-01' })).toBe(0);
  });
});
