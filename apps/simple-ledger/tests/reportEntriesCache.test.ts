/*
 * 導出キャッシュ（v13.5 B）。
 *
 * ledger が変わったときだけ全地平（2100）まで 1 回導出し、断面（asOf）の切り替えは
 * 日付昇順配列の二分探索と打ち切り診断のフィルタだけで済ませる。根拠は過去断面の決定性
 * （asOf を動かしても過去の値は変わらない）。ここで固定するのは 1 点に尽きる:
 *
 *   **切り出した断面 === その asOf で直接導出した結果**（`…ForAsOfUncached`）。
 *
 * これが崩れたら「速いが違う数字」になるので、複数の ledger × 多数の asOf で総当たりする。
 * 加えて切り出しの 2 系統（二分探索の境界・truncations のフィルタ）を単体で固定する。
 */
import { describe, expect, it } from 'vitest';
import './setup';
import {
  reportEntriesResultForAsOf,
  reportEntriesResultForAsOfUncached,
} from '../src/domain/reportEntries';
import { buildAdjustmentEntry } from '../src/domain/adjustment';
import { CONTINUOUS_COST_LEDGER_ACCOUNT_ID } from '../src/domain/constants';
import { CONTINUOUS_COST_HARD_CAP } from '../src/domain/continuousCost';
import { MAX_AMOUNT_MINOR } from '../src/domain/schema';
import type {
  Account,
  JournalEntry,
  Ledger,
  MonthlyCostItem,
  RecurringRule,
} from '../src/domain/types';

const TS = '2025-01-01T00:00:00.000Z';

type Source = Pick<Ledger, 'accounts' | 'journalEntries' | 'monthlyCostItems' | 'recurringRules'>;

function account(
  id: string,
  name: string,
  type: Account['type'],
  role: Account['role'],
  over: Partial<Account> = {},
): Account {
  return { id, name, type, role, archived: false, createdAt: TS, updatedAt: TS, ...over };
}

function entry(
  id: string,
  date: string,
  debitAccountId: string,
  creditAccountId: string,
  amount: number,
  kind: JournalEntry['kind'] = 'normal',
): JournalEntry {
  return {
    id,
    date,
    description: id,
    kind,
    lines: [
      { accountId: debitAccountId, side: 'debit', amount },
      { accountId: creditAccountId, side: 'credit', amount },
    ],
    createdAt: TS,
    updatedAt: TS,
  };
}

/** schema 上限内の仕訳だけで、指定した合計を組み立てる（桁あふれ打ち切りの再現用）。 */
function entriesForTotal(
  prefix: string,
  date: string,
  debitAccountId: string,
  creditAccountId: string,
  total: number,
  kind: JournalEntry['kind'] = 'normal',
): JournalEntry[] {
  const out: JournalEntry[] = [];
  let remaining = total;
  for (let index = 0; remaining > 0; index += 1) {
    const amount = Math.min(remaining, MAX_AMOUNT_MINOR);
    out.push(entry(`${prefix}-${index}`, date, debitAccountId, creditAccountId, amount, kind));
    remaining -= amount;
  }
  return out;
}

function pin(args: { id: string; date: string; actual: number; accountId: string }): JournalEntry {
  const built = buildAdjustmentEntry({
    accountId: args.accountId,
    accountType: 'asset',
    date: args.date,
    description: `残高補正: ${args.date}`,
    expectedBalance: 0,
    actualBalance: args.actual,
    counterpartAccountId: args.actual > 0 ? 'adj-rev' : 'adj-exp',
    existing: { id: args.id, createdAt: TS },
  });
  if (!built) throw new Error('差額 0 の pin は作れない（テストの前提が壊れている）');
  return built;
}

const ACCOUNTS: Account[] = [
  account('cash', '現金', 'asset', 'daily-asset'),
  account('bank', '銀行', 'asset', 'daily-asset'),
  account('capital', '初期残高', 'equity', 'equity'),
  account('food', '食費', 'expense', 'expense-category'),
  account('fixed', '固定費', 'expense', 'expense-category'),
  account('salary', '給与', 'revenue', 'income-category'),
  account('invest', '投資', 'asset', 'investment-asset', {
    annualReturnBp: 1200,
    projectionAccountId: 'gain',
  }),
  account('gain', '投資益', 'revenue', 'income-category'),
  account('adj-exp', '残高調整費', 'expense', 'system-adjustment'),
  account('adj-rev', '残高調整収入', 'revenue', 'system-adjustment'),
  account(CONTINUOUS_COST_LEDGER_ACCOUNT_ID, '月割り台帳', 'asset', 'continuing-cost-asset'),
];

const ANNUAL_ITEM: MonthlyCostItem = {
  id: 'item-annual',
  name: '年払い保険',
  amount: 120_000,
  startDate: '2026-01-10',
  endDate: '2027-01-10',
  expenseAccountId: 'fixed',
  createdAt: TS,
  updatedAt: TS,
};

const ANNUAL_PURCHASE = entry(
  'purchase-annual',
  ANNUAL_ITEM.startDate,
  CONTINUOUS_COST_LEDGER_ACCOUNT_ID,
  'bank',
  ANNUAL_ITEM.amount,
);
// 未来日の回収（全知識で過去の月割りへ遡及する経路をキャッシュ側でも通す）。
const RECOVERY: JournalEntry = {
  ...entry('recovery-annual', '2026-09-10', 'bank', CONTINUOUS_COST_LEDGER_ACCOUNT_ID, 30_000),
  metadata: { monthlyCostId: ANNUAL_ITEM.id, monthlyCostRecovery: true },
};

const RULE: RecurringRule = {
  id: 'rule-sub',
  name: 'サブスク',
  amount: 1_200,
  dayOfMonth: 15,
  everyMonths: 1,
  spreadExpenseAccountId: 'fixed',
  debitAccountId: CONTINUOUS_COST_LEDGER_ACCOUNT_ID,
  creditAccountId: 'bank',
  startMonth: '2026-02',
  startDate: '2026-02-01',
  createdAt: TS,
  updatedAt: TS,
};

/** 実仕訳・継続コスト・ルール導出・按分スライス・利回りの全部が乗った台帳。 */
function fullSource(): Source {
  return {
    accounts: ACCOUNTS,
    journalEntries: [
      entry('opening-cash', '2026-01-01', 'cash', 'capital', 500_000, 'opening'),
      entry('opening-invest', '2026-01-05', 'invest', 'capital', 1_000_000, 'opening'),
      entry('food-1', '2026-03-03', 'food', 'cash', 3_000),
      entry('food-2', '2026-03-03', 'food', 'cash', 4_000),
      entry('salary-1', '2026-04-25', 'bank', 'salary', 300_000),
      entry('invest-add', '2026-05-20', 'invest', 'bank', 200_000),
      ANNUAL_PURCHASE,
      RECOVERY,
      pin({ id: 'pin-past', date: '2026-06-30', actual: 1_400_000, accountId: 'invest' }),
      // **未来の pin**: 展開地平が asOf を超える（按分が asOf に依存しないことの要）。
      pin({ id: 'pin-future', date: '2029-03-31', actual: 3_000_000, accountId: 'invest' }),
    ],
    monthlyCostItems: [ANNUAL_ITEM],
    recurringRules: [RULE],
  };
}

/** 補正なし（地平 = asOf のまま）の台帳。 */
function noAdjustmentSource(): Source {
  return {
    ...fullSource(),
    journalEntries: fullSource().journalEntries.filter((e) => e.metadata?.adjustment === undefined),
  };
}

/** 実仕訳だけ（導出が 1 本も無い最小形）。 */
function plainSource(): Source {
  return {
    accounts: ACCOUNTS,
    journalEntries: [
      entry('opening-cash', '2026-01-01', 'cash', 'capital', 500_000, 'opening'),
      entry('food-1', '2026-02-14', 'food', 'cash', 1_000),
      entry('food-2', '2026-02-14', 'food', 'cash', 2_000),
      entry('food-3', '2027-11-30', 'food', 'cash', 3_000),
    ],
    monthlyCostItems: [],
    recurringRules: [],
  };
}

/** 桁あふれで利回り導出が打ち切られる台帳（刻みは 20 日 = 月半ばの断面を作れる）。 */
function truncatingSource(): Source {
  return {
    accounts: ACCOUNTS.map((a) => (a.id === 'invest' ? { ...a, annualReturnBp: 100_000 } : a)),
    journalEntries: entriesForTotal(
      'huge-opening',
      '2026-01-20',
      'invest',
      'capital',
      3_500_000_000_000_000,
      'opening',
    ),
    monthlyCostItems: [],
    recurringRules: [],
  };
}

/** 比較用の正規化（合流順の違いを消す。日付 → ID の昇順）。 */
function normalize(entries: JournalEntry[]): JournalEntry[] {
  return [...entries].sort((a, b) =>
    a.date !== b.date ? (a.date < b.date ? -1 : 1) : a.id < b.id ? -1 : a.id > b.id ? 1 : 0,
  );
}

function normalizeTruncations<T extends { accountId: string; month: string }>(list: T[]): T[] {
  return [...list].sort((a, b) =>
    a.accountId !== b.accountId
      ? a.accountId < b.accountId
        ? -1
        : 1
      : a.month < b.month
        ? -1
        : a.month > b.month
          ? 1
          : 0,
  );
}

/** 決定的な擬似乱数（テストが実行のたびに違う顔をしない）。 */
function lcg(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1_664_525 + 1_013_904_223) >>> 0;
    return state / 0x1_0000_0000;
  };
}

function isoOf(dayNumber: number): string {
  return new Date(Date.UTC(2025, 0, 1) + dayNumber * 86_400_000).toISOString().slice(0, 10);
}

function previousDay(iso: string): string {
  return new Date(`${iso}T00:00:00.000Z`).getTime() - 86_400_000 > 0
    ? new Date(new Date(`${iso}T00:00:00.000Z`).getTime() - 86_400_000).toISOString().slice(0, 10)
    : iso;
}

describe('導出キャッシュ: 切り出し === 直接導出', () => {
  // 直接導出はキャッシュを読まないので、同じオブジェクトを両方へ渡してよい
  // （組み立て直すと補正の updatedAt が実時刻で変わり、比較が中身以外で落ちる）。
  const sources: [string, Source, number][] = [
    ['実仕訳だけ', plainSource(), 60],
    ['補正なし（継続コスト + ルール + 利回り）', noAdjustmentSource(), 60],
    ['全部乗せ（未来の pin つき）', fullSource(), 60],
    ['桁あふれで打ち切る', truncatingSource(), 12],
  ];

  for (const [name, source, randomCount] of sources) {
    it(`${name}: ランダムな asOf でも 1 行も違わない`, () => {
      const random = lcg(20260818);
      // 2025-01-01 起点で約 8 年ぶんのランダムな日付 + 境界（導出行が実際に立つ日と前日）。
      const asOfs = new Set(
        Array.from({ length: randomCount }, () => isoOf(Math.floor(random() * 2_900))),
      );
      for (const entry of reportEntriesResultForAsOfUncached(source, '2035-12-31').entries) {
        asOfs.add(entry.date);
        asOfs.add(previousDay(entry.date));
      }
      for (const asOf of asOfs) {
        const direct = reportEntriesResultForAsOfUncached(source, asOf);
        const sliced = reportEntriesResultForAsOf(source, asOf);
        expect(normalize(sliced.entries), `entries @ ${asOf}`).toEqual(normalize(direct.entries));
        expect(
          normalizeTruncations(sliced.investmentProjectionTruncations),
          `truncations @ ${asOf}`,
        ).toEqual(normalizeTruncations(direct.investmentProjectionTruncations));
      }
    }, 30_000);
  }

  it('地平（2100）より先の断面はキャッシュに頼らず直接導出と一致する', () => {
    const source = fullSource();
    for (const asOf of [CONTINUOUS_COST_HARD_CAP, '2101-01-01', '2150-12-31']) {
      expect(normalize(reportEntriesResultForAsOf(source, asOf).entries)).toEqual(
        normalize(reportEntriesResultForAsOfUncached(source, asOf).entries),
      );
    }
  });

  it('切り出した行は日付昇順（消費側が並べ直さずに走査できる）', () => {
    const entries = reportEntriesResultForAsOf(fullSource(), '2030-12-31').entries;
    expect(entries.length).toBeGreaterThan(10);
    for (let i = 1; i < entries.length; i += 1) {
      expect(entries[i]!.date >= entries[i - 1]!.date).toBe(true);
    }
  });
});

describe('導出キャッシュ: 二分探索の境界', () => {
  const source = plainSource();

  it('基準日**当日**の行は含み、翌日以降は含まない', () => {
    expect(reportEntriesResultForAsOf(source, '2026-02-13').entries.map((e) => e.id)).toEqual([
      'opening-cash',
    ]);
    // 同日 2 本をまとめて含む（上界の探索が同日の途中で止まらない）。
    expect(reportEntriesResultForAsOf(source, '2026-02-14').entries.map((e) => e.id)).toEqual([
      'opening-cash',
      'food-1',
      'food-2',
    ]);
  });

  it('最初の行より前・最後の行より後の断面（配列の両端）', () => {
    expect(reportEntriesResultForAsOf(source, '2025-12-31').entries).toEqual([]);
    expect(reportEntriesResultForAsOf(source, '2026-01-01').entries.map((e) => e.id)).toEqual([
      'opening-cash',
    ]);
    expect(reportEntriesResultForAsOf(source, '2027-11-29').entries).toHaveLength(3);
    expect(reportEntriesResultForAsOf(source, '2027-11-30').entries).toHaveLength(4);
    expect(reportEntriesResultForAsOf(source, '2099-12-31').entries).toHaveLength(4);
  });

  it('導出行（月割り・ルール・利回り）も刻みの当日から現れる', () => {
    const src = noAdjustmentSource();
    // 年払いの最初の刻み = 購入日（2026-01-10）の同日通過 = 2026-02-10。
    const before = reportEntriesResultForAsOf(src, '2026-02-09').entries;
    const on = reportEntriesResultForAsOf(src, '2026-02-10').entries;
    expect(before.some((e) => e.date === '2026-02-10')).toBe(false);
    expect(on.filter((e) => e.date === '2026-02-10')).not.toHaveLength(0);
    expect(on).toHaveLength(before.length + on.filter((e) => e.date === '2026-02-10').length);
  });
});

describe('導出キャッシュ: truncations のフィルタ', () => {
  const source = truncatingSource();
  // 起点 2026-01-20 の同日刻み: 2026-02-20 に 1 本生成し、2026-03-20 で桁あふれ。
  const truncationDate = '2026-03-20';

  it('打ち切りの**日**より前の断面では名乗らない（月で切ると月半ばで嘘になる）', () => {
    expect(
      reportEntriesResultForAsOf(source, '2026-02-28').investmentProjectionTruncations,
    ).toEqual([]);
    expect(
      reportEntriesResultForAsOf(source, '2026-03-19').investmentProjectionTruncations,
    ).toEqual([]);
  });

  it('打ち切りの日に達したら名乗る（以降の断面でも消えない）', () => {
    for (const asOf of [truncationDate, '2026-12-31', '2100-12-31']) {
      expect(reportEntriesResultForAsOf(source, asOf).investmentProjectionTruncations).toEqual([
        { accountId: 'invest', month: '2026-03', date: truncationDate, at: 'step' },
      ]);
    }
  });

  /*
   * 刻みへ入る前（起点残高の畳み込み）で諦める打ち切りは、asOf ではなく**展開地平**で
   * 見え始める: 未来の補正があると導出はそこまで広がるので、その科目に触れる行が asOf の
   * 先にあっても直接導出は打ち切りを名乗る。asOf だけで切ると切り出しが 1 件足りなくなる。
   */
  it('起点の畳み込みで諦めた打ち切りは、補正で伸びた地平の側で判定する', () => {
    const openingDate = '2030-01-15';
    // 1 日ぶんの合算だけで安全整数域（2^53-1 ≈ 9.007e15）を出る量を積む。
    const overflow: JournalEntry[] = Array.from({ length: 9_010 }, (_, i) =>
      entry(`over-${i}`, openingDate, 'invest', 'capital', MAX_AMOUNT_MINOR, 'opening'),
    );
    const src: Source = {
      accounts: ACCOUNTS,
      journalEntries: [
        ...overflow,
        // **別科目**の未来の pin。これで展開地平が asOf より先へ伸びる。
        pin({ id: 'pin-cash-future', date: '2031-06-30', actual: 50_000, accountId: 'cash' }),
      ],
      monthlyCostItems: [],
      recurringRules: [],
    };

    const expected = [{ accountId: 'invest', month: '2030-01', date: openingDate, at: 'opening' }];
    for (const asOf of ['2026-12-31', '2030-01-14', openingDate, '2031-12-31']) {
      const sliced = reportEntriesResultForAsOf(src, asOf);
      expect(sliced.investmentProjectionTruncations, `@ ${asOf}`).toEqual(expected);
      expect(sliced.investmentProjectionTruncations, `@ ${asOf}`).toEqual(
        reportEntriesResultForAsOfUncached(src, asOf).investmentProjectionTruncations,
      );
    }

    // 補正が無ければ地平は asOf のまま = その科目に触れる行がまだ 1 本も無い断面では
    // 打ち切りも起きていない（全地平のキャッシュに載っていても見せない）。
    const noPin: Source = { ...src, journalEntries: overflow };
    expect(reportEntriesResultForAsOf(noPin, '2029-12-31').investmentProjectionTruncations).toEqual(
      [],
    );
    expect(
      reportEntriesResultForAsOfUncached(noPin, '2029-12-31').investmentProjectionTruncations,
    ).toEqual([]);
    expect(reportEntriesResultForAsOf(noPin, openingDate).investmentProjectionTruncations).toEqual(
      expected,
    );
  });

  it('直接導出と同じ断面で現れる（境界の総当たり）', () => {
    for (const asOf of ['2026-03-18', '2026-03-19', truncationDate, '2026-03-21']) {
      expect(reportEntriesResultForAsOf(source, asOf).investmentProjectionTruncations).toEqual(
        reportEntriesResultForAsOfUncached(source, asOf).investmentProjectionTruncations,
      );
    }
  });
});

describe('導出キャッシュ: キーは ledger オブジェクトの同一性', () => {
  it('同じオブジェクトの 2 回目は導出済みの行を使い回す（同一参照）', () => {
    const source = fullSource();
    const first = reportEntriesResultForAsOf(source, '2027-12-31');
    const second = reportEntriesResultForAsOf(source, '2030-12-31');
    expect(first.entries[0]).toBe(second.entries[0]);
    // 配列そのものは切り出しごとに新しい（呼び出し側の破壊がキャッシュへ波及しない）。
    expect(first.entries).not.toBe(second.entries);
  });

  it('別オブジェクト（store が差し替えた新しい ledger）は導出し直す', () => {
    const before = fullSource();
    const countBefore = reportEntriesResultForAsOf(before, '2027-12-31').entries.length;
    // store は既存の ledger を書き換えず、loadLedger の戻り値で丸ごと差し替える。
    const after: Source = {
      ...before,
      journalEntries: [...before.journalEntries, entry('extra', '2026-07-07', 'food', 'cash', 999)],
    };
    const sliced = reportEntriesResultForAsOf(after, '2027-12-31');
    expect(sliced.entries.length).toBe(countBefore + 1);
    expect(sliced.entries.some((e) => e.id === 'extra')).toBe(true);
    // 元のオブジェクトの断面は影響を受けない。
    expect(reportEntriesResultForAsOf(before, '2027-12-31').entries.length).toBe(countBefore);
  });
});

/*
 * ベンチ（既定で走る。重い環境では SKIP_PERF=1 で外せる）。
 * 見るのは「初回の全地平導出のあとは、断面の切り替えが導出し直しでない」こと。
 */
describe('導出キャッシュ: 断面切り替えの速さ', () => {
  const skip = process.env.SKIP_PERF === '1';
  it.skipIf(skip)('10 万件の台帳でも断面の切り替えは数 ms', () => {
    const journalEntries: JournalEntry[] = [];
    for (let i = 0; i < 100_000; i += 1) {
      journalEntries.push(entry(`e-${i}`, isoOf(i % 2_900), 'food', 'cash', 100 + (i % 900)));
    }
    const source: Source = {
      accounts: ACCOUNTS,
      journalEntries,
      monthlyCostItems: [],
      recurringRules: [],
    };

    const t0 = performance.now();
    reportEntriesResultForAsOf(source, '2028-01-01');
    const firstMs = performance.now() - t0;

    const random = lcg(1234);
    const t1 = performance.now();
    let total = 0;
    for (let i = 0; i < 50; i += 1) {
      total += reportEntriesResultForAsOf(source, isoOf(Math.floor(random() * 2_900))).entries
        .length;
    }
    const switchMs = (performance.now() - t1) / 50;
    expect(total).toBeGreaterThan(0);
    // 導出し直していたら 1 回あたり数十 ms 以上かかる（配列の切り出しだけなら 1 桁 ms）。
    expect(switchMs).toBeLessThan(20);
    // 記録用（失敗時に数字が残るよう明示的に出す）。
    console.info(
      `[perf] 初回導出(10万件) ${firstMs.toFixed(1)}ms / 断面切り替え ${switchMs.toFixed(2)}ms`,
    );
  });
});
