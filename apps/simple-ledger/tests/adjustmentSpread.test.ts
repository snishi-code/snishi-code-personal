/*
 * 残高補正の按分（v13.4 ①・作者決定 2026-08-17）。
 *
 * 補正は「宣言（pin）」で、集計に載るのは区間へ月割りした按分スライス。
 * ここで固定するのは 3 つ:
 *  1. **pin 日以降の残高は按分前と完全一致**（不変条件）。
 *  2. スライスの合計 = その pin の差額 G（端数の配分で 1 minor も落とさない）。
 *  3. 刻み日・端数・向きは既存規約（月割り台帳 / buildAdjustmentEntry）と同じ。
 */
import { describe, expect, it } from 'vitest';
import './setup';
import { accountBalance } from '../src/domain/accounting';
import { buildAdjustmentEntry } from '../src/domain/adjustment';
import { adjustmentPinExpectedBalance, adjustmentSpread } from '../src/domain/adjustmentSpread';
import { reportEntriesForAsOf, reportEntriesResultForAsOf } from '../src/domain/reportEntries';
import { journalEntrySchema } from '../src/domain/schema';
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

function source(journalEntries: JournalEntry[], accounts: Account[] = ACCOUNTS): Source {
  return { accounts, journalEntries, monthlyCostItems: [], recurringRules: [] };
}

/** 素の 2 行仕訳（借方 → 貸方）。 */
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

/**
 * 宣言（pin）。stored の delta / expectedBalance は集計に使われないので、
 * ここでは向き・metadata が本物と同じになるよう buildAdjustmentEntry を通すだけにする。
 */
function pin(args: {
  id: string;
  accountId: string;
  accountType: 'asset' | 'liability' | 'expense' | 'revenue';
  date: string;
  actual: number;
  /** 作成時の理論残高（集計では使われない値。既定は 0）。 */
  expected?: number;
  counterpartAccountId?: string;
}): JournalEntry {
  const expected = args.expected ?? 0;
  const entry = buildAdjustmentEntry({
    accountId: args.accountId,
    accountType: args.accountType,
    date: args.date,
    description: `補正: ${args.accountId}`,
    expectedBalance: expected,
    actualBalance: args.actual,
    counterpartAccountId:
      args.counterpartAccountId ?? (args.actual - expected > 0 ? 'adj-rev' : 'adj-exp'),
    existing: { id: args.id, createdAt: TS },
  });
  if (!entry) throw new Error('pin は差額 0 では作れない（テストの前提が壊れている）');
  return entry;
}

function slices(entries: JournalEntry[]): JournalEntry[] {
  return entries
    .filter((entry) => entry.metadata?.adjustmentSliceOf !== undefined)
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
}

function balanceAt(src: Source, accountId: string, type: AccountType, asOf: string): number {
  return accountBalance(accountId, type, reportEntriesForAsOf(src, asOf));
}

/** 借方 / 貸方の科目 ID（2 行仕訳前提）。 */
function sides(entry: JournalEntry): { debit: string; credit: string } {
  return {
    debit: entry.lines.find((l) => l.side === 'debit')!.accountId,
    credit: entry.lines.find((l) => l.side === 'credit')!.accountId,
  };
}

describe('按分の基本形（区間・刻み日・合計）', () => {
  const opening = flow('open', '2026-01-10', 'cash', 'equity', 10_000);
  const p1 = pin({
    id: 'pin1',
    accountId: 'cash',
    accountType: 'asset',
    date: '2026-07-10',
    actual: 8_800,
    expected: 10_000,
  });
  const src = source([opening, p1]);

  it('直前の宣言（無ければ実効開始）との区間へ、同日刻みで並ぶ', () => {
    const rows = slices(reportEntriesForAsOf(src, '2026-12-31'));
    // 実効開始 2026-01-10 → 2026-07-10 は同日通過 6 回。刻み日は 2/10・3/10 …・7/10。
    expect(rows.map((r) => r.date)).toEqual([
      '2026-02-10',
      '2026-03-10',
      '2026-04-10',
      '2026-05-10',
      '2026-06-10',
      '2026-07-10',
    ]);
    expect(rows.map((r) => r.lines[0]!.amount)).toEqual([200, 200, 200, 200, 200, 200]);
    // 合計 = G（|8,800 − 10,000| = 1,200）。
    expect(rows.reduce((s, r) => s + r.lines[0]!.amount, 0)).toBe(1_200);
  });

  it('スライスは導出専用（virtual + 親 pin の ID）で、pin 自身は集計から消える', () => {
    const entries = reportEntriesForAsOf(src, '2026-12-31');
    expect(entries.some((e) => e.id === 'pin1')).toBe(false);
    for (const row of slices(entries)) {
      expect(row.metadata).toEqual({ virtual: true, adjustmentSliceOf: 'pin1' });
      expect(row.id).toBe(`adj-slice-pin1-${row.date.slice(0, 7)}`);
    }
  });

  it('pin 日の残高 = actualBalance・以降は按分前と完全一致（不変条件）', () => {
    expect(balanceAt(src, 'cash', 'asset', '2026-07-10')).toBe(8_800);
    expect(balanceAt(src, 'cash', 'asset', '2026-07-11')).toBe(8_800);
    expect(balanceAt(src, 'cash', 'asset', '2030-01-01')).toBe(8_800);
    // 相手科目（残高調整費）の累計も pin 日以降は従来どおり 1,200。
    expect(balanceAt(src, 'adj-exp', 'expense', '2026-07-10')).toBe(1_200);
  });

  it('区間の途中は按分ぶんだけ動く（補正月に跳ねない）', () => {
    expect(balanceAt(src, 'cash', 'asset', '2026-01-10')).toBe(10_000); // 区間は開区間
    expect(balanceAt(src, 'cash', 'asset', '2026-02-09')).toBe(10_000);
    expect(balanceAt(src, 'cash', 'asset', '2026-02-10')).toBe(9_800);
    expect(balanceAt(src, 'cash', 'asset', '2026-06-10')).toBe(9_000);
    // 補正月（7 月）に立つのは 1 刻みぶんだけ = 200。
    expect(balanceAt(src, 'cash', 'asset', '2026-07-09')).toBe(9_000);
  });
});

describe('区間の端（1 ヶ月未満・実効開始 anchor）', () => {
  it('同日通過が無ければ pin 当日に全額 1 本', () => {
    const src = source([
      flow('open', '2026-01-10', 'cash', 'equity', 10_000),
      pin({
        id: 'pin1',
        accountId: 'cash',
        accountType: 'asset',
        date: '2026-02-05',
        actual: 9_000,
        expected: 10_000,
      }),
    ]);
    const rows = slices(reportEntriesForAsOf(src, '2026-12-31'));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.date).toBe('2026-02-05');
    expect(rows[0]!.lines[0]!.amount).toBe(1_000);
  });

  it('その科目に触れる仕訳が 1 本も無ければ pin 当日に全額 1 本', () => {
    const src = source([
      pin({
        id: 'pin1',
        accountId: 'food',
        accountType: 'expense',
        date: '2026-03-15',
        actual: 5_000,
      }),
    ]);
    const rows = slices(reportEntriesForAsOf(src, '2026-12-31'));
    expect(rows.map((r) => [r.date, r.lines[0]!.amount])).toEqual([['2026-03-15', 5_000]]);
    expect(balanceAt(src, 'food', 'expense', '2026-03-15')).toBe(5_000);
  });

  it('実効開始は opening でも導出行でもよい（種類を区別しない）', () => {
    // opening（kind: 'opening'）を起点にしても同じ区間になる。
    const opening: JournalEntry = {
      ...flow('open', '2026-01-10', 'cash', 'equity', 10_000),
      kind: 'opening',
    };
    const src = source([
      opening,
      pin({
        id: 'pin1',
        accountId: 'cash',
        accountType: 'asset',
        date: '2026-04-10',
        actual: 9_700,
        expected: 10_000,
      }),
    ]);
    expect(slices(reportEntriesForAsOf(src, '2026-12-31')).map((r) => r.date)).toEqual([
      '2026-02-10',
      '2026-03-10',
      '2026-04-10',
    ]);
  });

  it('最初に触れる仕訳が pin より後でも壊れない（当日 1 本へ倒す）', () => {
    const src = source([
      flow('later', '2026-09-01', 'cash', 'equity', 10_000),
      pin({
        id: 'pin1',
        accountId: 'cash',
        accountType: 'asset',
        date: '2026-03-01',
        actual: 500,
      }),
    ]);
    const rows = slices(reportEntriesForAsOf(src, '2026-12-31'));
    expect(rows.map((r) => [r.date, r.lines[0]!.amount])).toEqual([['2026-03-01', 500]]);
    expect(balanceAt(src, 'cash', 'asset', '2026-03-01')).toBe(500);
    expect(balanceAt(src, 'cash', 'asset', '2026-09-01')).toBe(10_500);
  });
});

describe('端数（割り切れない G）', () => {
  it('先頭刻みから 1 ずつ配り、合計は必ず G に一致する', () => {
    const src = source([
      flow('open', '2026-01-10', 'cash', 'equity', 10_000),
      pin({
        id: 'pin1',
        accountId: 'cash',
        accountType: 'asset',
        date: '2026-07-10',
        actual: 9_000,
        expected: 10_000,
      }),
    ]);
    const rows = slices(reportEntriesForAsOf(src, '2026-12-31'));
    // 1,000 を 6 刻み: 166 余り 4 → 先頭 4 本が 167。
    expect(rows.map((r) => r.lines[0]!.amount)).toEqual([167, 167, 167, 167, 166, 166]);
    expect(rows.reduce((s, r) => s + r.lines[0]!.amount, 0)).toBe(1_000);
    expect(balanceAt(src, 'cash', 'asset', '2026-07-10')).toBe(9_000);
  });

  it('刻み数より G が小さいときは 0 の刻みを作らない（金額 0 の行を出さない）', () => {
    const src = source([
      flow('open', '2026-01-10', 'cash', 'equity', 10_000),
      pin({
        id: 'pin1',
        accountId: 'cash',
        accountType: 'asset',
        date: '2026-07-10',
        actual: 9_998,
        expected: 10_000,
      }),
    ]);
    const rows = slices(reportEntriesForAsOf(src, '2026-12-31'));
    expect(rows.map((r) => [r.date, r.lines[0]!.amount])).toEqual([
      ['2026-02-10', 1],
      ['2026-03-10', 1],
    ]);
    expect(balanceAt(src, 'cash', 'asset', '2026-07-10')).toBe(9_998);
  });
});

describe('複数 pin の連鎖', () => {
  const entries = [
    flow('open', '2026-01-10', 'cash', 'equity', 10_000),
    pin({
      id: 'pin1',
      accountId: 'cash',
      accountType: 'asset',
      date: '2026-04-10',
      actual: 9_700,
      expected: 10_000,
    }),
    flow('spend', '2026-05-20', 'food', 'cash', 500),
    pin({
      id: 'pin2',
      accountId: 'cash',
      accountType: 'asset',
      date: '2026-07-10',
      actual: 9_400,
      expected: 9_200,
    }),
  ];
  const src = source(entries);

  it('2 本目の区間は直前の宣言から始まり、G は走査で決まる', () => {
    const rows = slices(reportEntriesForAsOf(src, '2026-12-31'));
    const first = rows.filter((r) => r.metadata?.adjustmentSliceOf === 'pin1');
    const second = rows.filter((r) => r.metadata?.adjustmentSliceOf === 'pin2');
    expect(first.map((r) => [r.date, r.lines[0]!.amount])).toEqual([
      ['2026-02-10', 100],
      ['2026-03-10', 100],
      ['2026-04-10', 100],
    ]);
    // 2 本目: 導出残高 9,700 − 500 = 9,200 に対し実額 9,400 → G = +200（向きが反転する）。
    expect(second.map((r) => [r.date, r.lines[0]!.amount])).toEqual([
      ['2026-05-10', 67],
      ['2026-06-10', 67],
      ['2026-07-10', 66],
    ]);
    expect(sides(first[0]!)).toEqual({ debit: 'adj-exp', credit: 'cash' });
    expect(sides(second[0]!)).toEqual({ debit: 'cash', credit: 'adj-rev' });
  });

  it('各 pin 日の残高がそれぞれの actualBalance になる', () => {
    expect(balanceAt(src, 'cash', 'asset', '2026-04-10')).toBe(9_700);
    expect(balanceAt(src, 'cash', 'asset', '2026-07-10')).toBe(9_400);
    expect(balanceAt(src, 'cash', 'asset', '2027-01-01')).toBe(9_400);
  });

  it('同じ日に 2 本並んだら後から宣言した方が勝つ（保存配列の順に依存しない）', () => {
    const older = {
      ...pin({
        id: 'pinA',
        accountId: 'cash',
        accountType: 'asset',
        date: '2026-04-10',
        actual: 9_700,
        expected: 10_000,
      }),
      createdAt: '2026-04-10T01:00:00.000Z',
    };
    const newer = {
      ...pin({
        id: 'pinB',
        accountId: 'cash',
        accountType: 'asset',
        date: '2026-04-10',
        actual: 9_000,
        expected: 9_700,
      }),
      createdAt: '2026-04-10T02:00:00.000Z',
    };
    // loadLedger は日付降順 → 作成降順で返す = 新しい方が配列の先に来る。
    const sameDay = source([newer, older, flow('open', '2026-01-10', 'cash', 'equity', 10_000)]);
    const rows = slices(reportEntriesForAsOf(sameDay, '2026-12-31'));
    expect(rows.filter((r) => r.metadata?.adjustmentSliceOf === 'pinB')).toHaveLength(1);
    expect(balanceAt(sameDay, 'cash', 'asset', '2026-04-10')).toBe(9_000);
  });

  it('宣言を消すと区間が結合され、残る宣言の G が計算し直される（遡及処理は持たない）', () => {
    const withoutFirst = source(entries.filter((e) => e.id !== 'pin1'));
    const rows = slices(reportEntriesForAsOf(withoutFirst, '2026-12-31'));
    // 区間は 2026-01-10 → 2026-07-10 の 6 刻み、G = 9,400 − (10,000 − 500) = −100。
    expect(rows.map((r) => r.date)).toEqual([
      '2026-02-10',
      '2026-03-10',
      '2026-04-10',
      '2026-05-10',
      '2026-06-10',
      '2026-07-10',
    ]);
    expect(rows.reduce((s, r) => s + r.lines[0]!.amount, 0)).toBe(100);
    expect(balanceAt(withoutFirst, 'cash', 'asset', '2026-07-10')).toBe(9_400);
    // 1 本目を消したので 4/10 は宣言点ではなくなる（按分の途中 = 17+17+17 だけ引かれる）。
    expect(balanceAt(withoutFirst, 'cash', 'asset', '2026-04-10')).toBe(9_949);
  });

  it('宣言の実額を書き換えると、その pin 以降だけが追随する', () => {
    const edited = source(
      entries.map((e) =>
        e.id === 'pin2'
          ? pin({
              id: 'pin2',
              accountId: 'cash',
              accountType: 'asset',
              date: '2026-07-10',
              actual: 9_100,
              expected: 9_200,
            })
          : e,
      ),
    );
    expect(balanceAt(edited, 'cash', 'asset', '2026-04-10')).toBe(9_700); // 手前は不変
    expect(balanceAt(edited, 'cash', 'asset', '2026-07-10')).toBe(9_100);
  });
});

describe('向き（資産 / 負債 / 費用 / 収入 × G±）', () => {
  const cases: {
    accountId: string;
    accountType: 'asset' | 'liability' | 'expense' | 'revenue';
    type: AccountType;
    seedDebit: string;
    seedCredit: string;
  }[] = [
    {
      accountId: 'cash',
      accountType: 'asset',
      type: 'asset',
      seedDebit: 'cash',
      seedCredit: 'equity',
    },
    {
      accountId: 'loan',
      accountType: 'liability',
      type: 'liability',
      seedDebit: 'cash',
      seedCredit: 'loan',
    },
    {
      accountId: 'food',
      accountType: 'expense',
      type: 'expense',
      seedDebit: 'food',
      seedCredit: 'cash',
    },
    {
      accountId: 'salary',
      accountType: 'revenue',
      type: 'revenue',
      seedDebit: 'cash',
      seedCredit: 'salary',
    },
  ];

  for (const c of cases) {
    for (const [label, actual] of [
      ['増える方向', 12_000],
      ['減る方向', 8_000],
    ] as const) {
      it(`${c.accountType} の ${label}: buildAdjustmentEntry と同じ借貸になる`, () => {
        const src = source([
          flow('seed', '2026-01-10', c.seedDebit, c.seedCredit, 10_000),
          pin({
            id: 'pin1',
            accountId: c.accountId,
            accountType: c.accountType,
            date: '2026-04-10',
            actual,
            expected: 10_000,
          }),
        ]);
        const rows = slices(reportEntriesForAsOf(src, '2026-12-31'));
        // 同じ差額を stored の 1 本で作ったときの借貸（既存規約）と一致すること。
        const reference = buildAdjustmentEntry({
          accountId: c.accountId,
          accountType: c.accountType,
          date: '2026-04-10',
          description: 'x',
          expectedBalance: 10_000,
          actualBalance: actual,
          counterpartAccountId: actual > 10_000 ? 'adj-rev' : 'adj-exp',
        })!;
        expect(rows).toHaveLength(3);
        for (const row of rows) expect(sides(row)).toEqual(sides(reference));
        expect(rows.reduce((s, r) => s + r.lines[0]!.amount, 0)).toBe(Math.abs(actual - 10_000));
        // pin 日の残高 = 実額（自然符号）。
        expect(balanceAt(src, c.accountId, c.type, '2026-04-10')).toBe(actual);
      });
    }
  }
});

describe('投資科目の計上先（v13.17 §D 例外解消の固定）', () => {
  const seed = flow('buy', '2026-01-10', 'invest', 'cash', 100_000);

  it('投資科目への補正も記録相手科目（残高調整）へ按分される — 投影計上先へ寄せない', () => {
    // 実効計上先の解決に投資分岐を戻す変異（旧 counterpartFor / collectPins の
    // investmentReturnDeclaration 分岐）は、この gain=0 の固定で落ちる（mutation (a)）。
    const src = source([
      seed,
      pin({
        id: 'pin1',
        accountId: 'invest',
        accountType: 'asset',
        date: '2026-04-10',
        actual: 103_000,
        expected: 100_000,
      }),
    ]);
    const rows = slices(reportEntriesForAsOf(src, '2026-12-31'));
    expect(rows).toHaveLength(3);
    for (const row of rows) expect(sides(row)).toEqual({ debit: 'invest', credit: 'adj-rev' });
    // 収入科目（旧・投影計上先の候補）は 1 円も動かない。
    expect(balanceAt(src, 'gain', 'revenue', '2026-12-31')).toBe(0);
    expect(balanceAt(src, 'adj-rev', 'revenue', '2026-04-10')).toBe(3_000);
    // pin 日の残高保証は不変。
    expect(balanceAt(src, 'invest', 'asset', '2026-04-10')).toBe(103_000);
  });

  it('旧・投資宣言の残骸（annualReturnBp / projectionAccountId）が accounts に残っていても按分は記録相手で成立する', () => {
    // 旧 fixture 相当: strip 前のオブジェクトが読まれても、実効計上先の解決は
    // 記録相手科目のみ（宣言フィールドは参照されない）。
    const legacyAccounts = ACCOUNTS.map((a) =>
      a.id === 'invest'
        ? ({ ...a, annualReturnBp: 300, projectionAccountId: 'gain' } as Account)
        : a,
    );
    const src = source(
      [
        seed,
        pin({
          id: 'pin1',
          accountId: 'invest',
          accountType: 'asset',
          date: '2026-04-10',
          actual: 103_000,
          expected: 100_000,
        }),
      ],
      legacyAccounts,
    );
    const rows = slices(reportEntriesForAsOf(src, '2026-12-31'));
    expect(rows).toHaveLength(3);
    for (const row of rows) expect(sides(row)).toEqual({ debit: 'invest', credit: 'adj-rev' });
    expect(balanceAt(src, 'gain', 'revenue', '2026-12-31')).toBe(0);
  });
});

describe('asOf からの独立と壊れた入力', () => {
  it('未来日の宣言でも、過去断面の値は地平の取り方で変わらない', () => {
    const src = source([
      flow('open', '2026-01-10', 'cash', 'equity', 10_000),
      pin({
        id: 'pin1',
        accountId: 'cash',
        accountType: 'asset',
        date: '2026-07-10',
        actual: 8_800,
        expected: 10_000,
      }),
    ]);
    // asOf を宣言より手前に置いても、その日までのスライスは同じだけ載る。
    expect(balanceAt(src, 'cash', 'asset', '2026-03-10')).toBe(9_600);
    const cutAtAsOf = reportEntriesForAsOf(src, '2026-03-10');
    const cutLater = reportEntriesForAsOf(src, '2026-12-31').filter((e) => e.date <= '2026-03-10');
    expect(slices(cutAtAsOf).map((e) => e.id)).toEqual(slices(cutLater).map((e) => e.id));
  });

  it('対象科目を引けない壊れた宣言は stored のまま集計に残す（差額を消さない）', () => {
    const orphan = pin({
      id: 'pin1',
      accountId: 'ghost',
      accountType: 'asset',
      date: '2026-04-10',
      actual: 1_000,
    });
    const src = source([orphan]);
    const entries = reportEntriesForAsOf(src, '2026-12-31');
    expect(entries.some((e) => e.id === 'pin1')).toBe(true);
    expect(slices(entries)).toHaveLength(0);
  });

  it('区間が配分上限（100 年）を超えても投げず、合計は G のまま', () => {
    const src = source([
      flow('ancient', '1800-01-01', 'cash', 'equity', 10_000),
      pin({
        id: 'pin1',
        accountId: 'cash',
        accountType: 'asset',
        date: '2026-01-01',
        actual: 8_000,
        expected: 10_000,
      }),
    ]);
    const rows = slices(reportEntriesForAsOf(src, '2026-12-31'));
    expect(rows).toHaveLength(1_200);
    expect(rows.reduce((s, r) => s + r.lines[0]!.amount, 0)).toBe(2_000);
    expect(rows.at(-1)!.date).toBe('2026-01-01');
    expect(balanceAt(src, 'cash', 'asset', '2026-01-01')).toBe(8_000);
  });
});

describe('保存境界（wire 非接触）', () => {
  it('adjustmentSliceOf を名乗る仕訳は wire で拒否する（strip の自己修復に任せない・機構3）', () => {
    // strip すると導出行が実仕訳として取り込まれ二重計上になるため、明示拒否へ変更（v13.8）。
    const result = journalEntrySchema.safeParse({
      id: 'e1',
      date: '2026-04-10',
      description: 'x',
      kind: 'normal',
      lines: [
        { accountId: 'cash', side: 'debit', amount: 100 },
        { accountId: 'adj-rev', side: 'credit', amount: 100 },
      ],
      metadata: { inputMode: 'manual', virtual: true, adjustmentSliceOf: 'pin1' },
      createdAt: TS,
      updatedAt: TS,
    });
    expect(result.success).toBe(false);
  });
});

describe('unspread（完全整合性を欠く pin・v13.8 監査 H）', () => {
  /** 対象科目が消えた破損 pin。stored の行は正常 pin の対象科目（cash）を動かす。 */
  const brokenPin: JournalEntry = {
    id: 'broken-pin',
    date: '2026-02-10',
    description: '壊れた補正',
    kind: 'normal',
    lines: [
      { accountId: 'cash', side: 'debit', amount: 500 },
      { accountId: 'adj-rev', side: 'credit', amount: 500 },
    ],
    metadata: {
      adjustment: {
        accountId: 'ghost',
        expectedBalance: 0,
        actualBalance: 500,
        delta: 500,
        counterpartAccountId: 'adj-rev',
      },
    },
    createdAt: TS,
    updatedAt: TS,
  };

  it('対象科目・実効計上先が引けない / 対象と同一の pin は按分せず stored のまま戻す', () => {
    const ghostTarget = brokenPin;
    const ghostCounterpart = pin({
      id: 'p-ghost-cp',
      accountId: 'cash',
      accountType: 'asset',
      date: '2026-02-10',
      actual: 700,
      counterpartAccountId: 'ghost',
    });
    const selfCounterpart = pin({
      id: 'p-self',
      accountId: 'cash',
      accountType: 'asset',
      date: '2026-02-10',
      actual: 700,
      counterpartAccountId: 'cash',
    });
    for (const broken of [ghostTarget, ghostCounterpart, selfCounterpart]) {
      const result = adjustmentSpread(
        ACCOUNTS,
        [flow('f1', '2026-01-01', 'cash', 'equity', 100)],
        [broken],
      );
      expect(result.entries).toHaveLength(0);
      expect(result.unspread).toEqual([broken]);
    }
  });

  it('破損 pin の stored 行が正常 pin の対象科目を動かしても、pin の残高保証は破れない', () => {
    // 旧実装: gap は破損 pin を除いた世界で算定し、最後に stored 行を足し戻すため、
    // 正常 pin 日の残高が actualBalance + 500 になっていた（監査 H の主経路）。
    const healthy = pin({
      id: 'p-healthy',
      accountId: 'cash',
      accountType: 'asset',
      date: '2026-03-15',
      actual: 12000,
    });
    const src = source([flow('f1', '2026-01-01', 'cash', 'equity', 10000), brokenPin, healthy]);
    expect(balanceAt(src, 'cash', 'asset', '2026-03-15')).toBe(12000);
    expect(balanceAt(src, 'cash', 'asset', '2026-04-30')).toBe(12000);
  });

  it('予定 pin の理論残高も unspread の stored 行を含む同じ世界を見る', () => {
    const base = [flow('f1', '2026-01-01', 'cash', 'equity', 10000)];
    const expected = adjustmentPinExpectedBalance(ACCOUNTS, base, [brokenPin], {
      accountId: 'cash',
      date: '2026-03-15',
    });
    // 非補正フロー 10,000 + 破損 pin の stored 行 +500。
    expect(expected).toBe(10500);
  });

  it('unspread は復旧診断として結果に載り、断面の日付で切られる', () => {
    const healthy = pin({
      id: 'p-healthy',
      accountId: 'cash',
      accountType: 'asset',
      date: '2026-03-15',
      actual: 12000,
    });
    const src = source([flow('f1', '2026-01-01', 'cash', 'equity', 10000), brokenPin, healthy]);
    expect(
      reportEntriesResultForAsOf(src, '2026-04-30').unspreadAdjustments.map((e) => e.id),
    ).toEqual(['broken-pin']);
    expect(reportEntriesResultForAsOf(src, '2026-02-01').unspreadAdjustments).toEqual([]);
  });
});
