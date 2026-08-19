/*
 * 投資の利回り導出（v13.4 ②・作者決定 2026-08-17）。
 *
 * v13.4 ② で意味論が変わった: 起点は today ではなく**最後の残高補正（pin）**、
 * 補正が無ければ科目の実効開始。導出益は保存境界（reportEntriesForAsOf）へ**合流する**。
 * ここで固定するのは:
 *  - エンジン: anchor 起点の同日刻み・月次複利の既知値・刻み間のフローの織り込み・
 *    負利回りの逆向き行・各種ガード（bp 未設定/0・計上先欠落・role 不整合・自分自身・
 *    終了点不明の旧アーカイブ）・2100 打ち切り・桁あふれの打ち切り診断（truncations）。
 *  - ① との結合: 補正を作ると pin 以前の複利行が消えて按分スライスへ置き換わる。
 *    利回りをいつ変えても pin 以前の残高は 1 円も動かない。
 *  - 断面の決定性: 実装から today が消えた（asOf を動かしても手前の断面は不変）。
 *  - 保存境界: アーカイブの残高 0 判定に導出益が**入る**（v13.4 ② の反転）。
 *    ただし補正（pin）の理論残高だけは v13.5 C-3 で複利を**含まない**——pin を置いた
 *    世界では区間の複利が按分に置き換わるため（値の正本 = adjustmentSpread の走査）。
 *  - 科目編集 UI の % ⇄ bp 変換。
 */
import { describe, expect, it } from 'vitest';
import './setup';
import { investmentProjectionResult } from '../src/domain/investmentProjection';
import { lastAdjustmentAnchors } from '../src/domain/adjustmentSpread';
import {
  displayEntriesForAsOf,
  reportEntriesForAsOf,
  reportEntriesResultForAsOf,
} from '../src/domain/reportEntries';
import {
  annualReturnBpToPercentText,
  monthlyReturnRate,
  parseAnnualReturnPercentText,
} from '../src/domain/investmentProjection';
import {
  accountBalance,
  deriveBalanceSheet,
  deriveProfitAndLoss,
  equityNaturalDelta,
} from '../src/domain/accounting';
import { buildAdjustmentEntry } from '../src/domain/adjustment';
import { accountSchema, ledgerExportPackageSchema, MAX_AMOUNT_MINOR } from '../src/domain/schema';
import { APP_ID, SCHEMA_VERSION } from '../src/domain/constants';
import {
  createAdjustment,
  deleteAccount,
  deleteEntry,
  loadLedger,
  upsertAccount,
  upsertEntry,
} from '../src/data/repository';
import { buildSimpleEntry } from '../src/domain/entry';
import { nowIso } from '../src/util/time';
import type { Account, JournalEntry } from '../src/domain/types';

const TS = '2026-01-01T00:00:00.000Z';

function account(
  id: string,
  name: string,
  type: Account['type'],
  role: Account['role'],
  over: Partial<Account> = {},
): Account {
  return {
    id,
    name,
    type,
    role,
    archived: false,
    createdAt: TS,
    updatedAt: TS,
    ...over,
  };
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

/** schema 上限内の仕訳だけで、指定した合計を組み立てる。 */
function entriesForTotal(
  prefix: string,
  date: string,
  debitAccountId: string,
  creditAccountId: string,
  total: number,
  kind: JournalEntry['kind'] = 'normal',
): JournalEntry[] {
  const result: JournalEntry[] = [];
  let remaining = total;
  for (let index = 0; remaining > 0; index += 1) {
    const amount = Math.min(remaining, MAX_AMOUNT_MINOR);
    result.push(entry(`${prefix}-${index}`, date, debitAccountId, creditAccountId, amount, kind));
    remaining -= amount;
  }
  return result;
}

const invest = account('invest', '投資', 'asset', 'investment-asset', {
  annualReturnBp: 1200,
  projectionAccountId: 'gain',
});
const gain = account('gain', '投資益', 'revenue', 'income-category');
const cash = account('cash', '現金', 'asset', 'daily-asset');
const capital = account('capital', '初期残高', 'equity', 'equity');
const adjExpense = account('adj-exp', '残高調整費', 'expense', 'system-adjustment');
const adjRevenue = account('adj-rev', '残高調整収入', 'revenue', 'system-adjustment');

const OPENING = entry('opening', '2026-01-01', 'invest', 'capital', 100_000, 'opening');

function source(over: {
  accounts?: Account[];
  journalEntries?: JournalEntry[];
}): Parameters<typeof reportEntriesForAsOf>[0] {
  return {
    accounts: over.accounts ?? [invest, gain, cash, capital, adjExpense, adjRevenue],
    journalEntries: over.journalEntries ?? [OPENING],
    monthlyCostItems: [],
    recurringRules: [],
  };
}

/**
 * 宣言（pin）。stored の delta / expectedBalance は集計に使われない（① の規約）ので、
 * 向きと metadata が本物と同じになるよう buildAdjustmentEntry を通すだけにする。
 */
function pin(args: {
  id: string;
  date: string;
  actual: number;
  expected?: number;
  accountId?: string;
  createdAt?: string;
}): JournalEntry {
  const expected = args.expected ?? 0;
  const built = buildAdjustmentEntry({
    accountId: args.accountId ?? 'invest',
    accountType: 'asset',
    date: args.date,
    description: `残高補正: ${args.date}`,
    expectedBalance: expected,
    actualBalance: args.actual,
    counterpartAccountId: args.actual - expected > 0 ? 'adj-rev' : 'adj-exp',
    existing: { id: args.id, createdAt: args.createdAt ?? TS },
  });
  if (!built) throw new Error('差額 0 の pin は作れない（テストの前提が壊れている）');
  return built;
}

function projectionRows(entries: JournalEntry[]): JournalEntry[] {
  return entries
    .filter((e) => e.metadata?.investmentProjectionOf !== undefined)
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
}

function sliceRows(entries: JournalEntry[]): JournalEntry[] {
  return entries
    .filter((e) => e.metadata?.adjustmentSliceOf !== undefined)
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
}

function dateAndAmount(entries: JournalEntry[]): [string, number | undefined][] {
  return entries.map((e) => [e.date, e.lines[0]?.amount]);
}

function investBalance(src: Parameters<typeof reportEntriesForAsOf>[0], asOf: string): number {
  return accountBalance('invest', 'asset', reportEntriesForAsOf(src, asOf));
}

describe('利回り導出: 起点 = 実効開始（宣言が無い科目）', () => {
  // 月利 = (1 + 1200/10000)^(1/12) − 1 ≈ 0.0094887929…。既知値は
  // 100000 → 949 / 958 / 967 / 976 / 985（各刻み Math.round で円へ丸め・決定的）。
  it('実効開始の翌月から月次複利の評価益を既知値どおり生成する（借方 投資 / 貸方 計上先）', () => {
    const rows = projectionRows(reportEntriesForAsOf(source({}), '2026-06-30'));
    expect(dateAndAmount(rows)).toEqual([
      ['2026-02-01', 949],
      ['2026-03-01', 958],
      ['2026-04-01', 967],
      ['2026-05-01', 976],
      ['2026-06-01', 985],
    ]);
    for (const row of rows) {
      expect(row.lines).toEqual([
        { accountId: 'invest', side: 'debit', amount: row.lines[0]!.amount },
        { accountId: 'gain', side: 'credit', amount: row.lines[0]!.amount },
      ]);
      expect(row.metadata).toEqual({ virtual: true, investmentProjectionOf: 'invest' });
      expect(row.description).toBe('投影: 投資');
      expect(row.id).toBe(`inv-proj-invest-${row.date.slice(0, 7)}`);
    }
  });

  it('刻みは起点の同日刻み（月初固定ではない・月割り台帳と同じ規約）', () => {
    const midMonth = source({
      journalEntries: [entry('opening', '2026-01-15', 'invest', 'capital', 100_000, 'opening')],
    });
    expect(dateAndAmount(projectionRows(reportEntriesForAsOf(midMonth, '2026-04-30')))).toEqual([
      ['2026-02-15', 949],
      ['2026-03-15', 958],
      ['2026-04-15', 967],
    ]);
  });

  it('要求 asOf で打ち切る（asOf より後の行は生まれない）', () => {
    const rows = projectionRows(reportEntriesForAsOf(source({}), '2026-04-15'));
    expect(rows.map((r) => r.date)).toEqual(['2026-02-01', '2026-03-01', '2026-04-01']);
  });

  it('各刻みの間のフロー（積立）を残高へ織り込んで複利する', () => {
    const withDeposit = source({
      journalEntries: [OPENING, entry('deposit', '2026-02-20', 'invest', 'cash', 50_000)],
    });
    const rows = projectionRows(reportEntriesForAsOf(withDeposit, '2026-04-30'));
    // 3 月分から元本 100000 + 949 + 50000 に対する評価益になる。
    expect(dateAndAmount(rows)).toEqual([
      ['2026-02-01', 949],
      ['2026-03-01', 1432],
      ['2026-04-01', 1446],
    ]);
  });

  it('負利回りは逆向きの行（借方 計上先 / 貸方 投資）になる', () => {
    const negative = source({
      accounts: [{ ...invest, annualReturnBp: -1200 }, gain, cash, capital],
    });
    const rows = projectionRows(reportEntriesForAsOf(negative, '2026-03-31'));
    expect(dateAndAmount(rows)).toEqual([
      ['2026-02-01', 1060],
      ['2026-03-01', 1048],
    ]);
    for (const row of rows) {
      expect(row.lines[0]).toMatchObject({ accountId: 'gain', side: 'debit' });
      expect(row.lines[1]).toMatchObject({ accountId: 'invest', side: 'credit' });
    }
  });
});

describe('利回り導出: 起点 = 最後の宣言（pin）', () => {
  const withPin = source({
    journalEntries: [OPENING, pin({ id: 'pin1', date: '2026-04-01', actual: 110_000 })],
  });

  it('宣言を作ると、その日以前の複利行は消えて按分スライスへ置き換わる', () => {
    const entries = reportEntriesForAsOf(withPin, '2026-07-31');
    // 複利は宣言より後だけ（110,000 起点）。
    expect(dateAndAmount(projectionRows(entries))).toEqual([
      ['2026-05-01', 1044],
      ['2026-06-01', 1054],
      ['2026-07-01', 1064],
    ]);
    // 宣言までの区間は ① の按分が支配する（複利ではない・月割り）。
    expect(dateAndAmount(sliceRows(entries))).toEqual([
      ['2026-02-01', 3334],
      ['2026-03-01', 3333],
      ['2026-04-01', 3333],
    ]);
    // 宣言の日の残高は実額そのもの（① の不変条件を ② が壊さない）。
    expect(investBalance(withPin, '2026-04-01')).toBe(110_000);
    expect(investBalance(withPin, '2026-05-01')).toBe(111_044);
  });

  it('宣言が 2 本あれば最後の 1 本だけが起点になる', () => {
    const twoPins = source({
      journalEntries: [
        OPENING,
        pin({ id: 'pin1', date: '2026-03-01', actual: 105_000 }),
        pin({ id: 'pin2', date: '2026-05-01', actual: 120_000 }),
      ],
    });
    const entries = reportEntriesForAsOf(twoPins, '2026-08-31');
    expect(dateAndAmount(projectionRows(entries))).toEqual([
      ['2026-06-01', 1139],
      ['2026-07-01', 1149],
      ['2026-08-01', 1160],
    ]);
    expect(investBalance(twoPins, '2026-03-01')).toBe(105_000);
    expect(investBalance(twoPins, '2026-05-01')).toBe(120_000);
  });

  it('利回りを変えても宣言以前の残高は 1 円も動かない（① との結合）', () => {
    const lowRate = source({
      accounts: [{ ...invest, annualReturnBp: 500 }, gain, cash, capital, adjExpense, adjRevenue],
      journalEntries: [OPENING, pin({ id: 'pin1', date: '2026-04-01', actual: 110_000 })],
    });
    for (const asOf of ['2026-01-31', '2026-02-15', '2026-03-01', '2026-04-01']) {
      expect(investBalance(lowRate, asOf)).toBe(investBalance(withPin, asOf));
    }
    // 動くのは宣言より後だけ。
    expect(investBalance(lowRate, '2026-05-01')).toBe(110_448);
    expect(investBalance(withPin, '2026-05-01')).toBe(111_044);
  });

  it('未来の宣言は、その日までの複利行を全部消す（宣言 1 本で断面を固定できる）', () => {
    const futurePin = source({
      journalEntries: [OPENING, pin({ id: 'pin1', date: '2099-12-31', actual: 500_000 })],
    });
    const entries = reportEntriesForAsOf(futurePin, '2026-12-31');
    expect(projectionRows(entries)).toEqual([]);
    expect(sliceRows(entries).length).toBeGreaterThan(0);
  });

  it('宣言の実額が複利の元本になる（アンカーの読み方を ① と共有する）', () => {
    const pins = [pin({ id: 'pin1', date: '2026-04-01', actual: 110_000 })];
    const anchors = lastAdjustmentAnchors(source({}).accounts, pins);
    expect(anchors.get('invest')).toEqual({ date: '2026-04-01', actualBalance: 110_000 });
    const result = investmentProjectionResult(
      source({}).accounts,
      [OPENING],
      anchors,
      '2026-06-30',
    );
    expect(dateAndAmount(result.entries)).toEqual([
      ['2026-05-01', 1044],
      ['2026-06-01', 1054],
    ]);
  });
});

describe('生成しない条件（fail-closed）', () => {
  const expectNone = (accounts: Account[]) => {
    expect(projectionRows(reportEntriesForAsOf(source({ accounts }), '2027-12-31'))).toEqual([]);
  };

  it('bp 未設定・0 では 1 行も生まれない', () => {
    expectNone([{ ...invest, annualReturnBp: undefined as never }, gain, cash, capital]);
    expectNone([{ ...invest, annualReturnBp: 0 }, gain, cash, capital]);
  });

  it('計上先が欠落・存在しない・income-category でない・自分自身なら生まれない', () => {
    expectNone([{ ...invest, projectionAccountId: undefined as never }, gain, cash, capital]);
    expectNone([invest, cash, capital]); // gain が存在しない
    expectNone([{ ...invest, projectionAccountId: 'cash' }, gain, cash, capital]); // role 不整合
    expectNone([{ ...invest, projectionAccountId: 'invest' }, gain, cash, capital]); // 自分自身
  });

  it('investment-asset 以外の科目に bp が付いていても無視する', () => {
    const oddCash = { ...cash, annualReturnBp: 1200, projectionAccountId: 'gain' };
    const src = source({
      accounts: [{ ...invest, annualReturnBp: 0 }, gain, oddCash, capital],
      journalEntries: [entry('opening', '2026-01-01', 'cash', 'capital', 100_000, 'opening')],
    });
    expect(projectionRows(reportEntriesForAsOf(src, '2027-12-31'))).toEqual([]);
  });

  it('残高 0 以下・評価益 0 円の刻みは行を生成しない', () => {
    // その科目に触れる行が 1 本も無い = 起点も無い。
    expect(
      projectionRows(reportEntriesForAsOf(source({ journalEntries: [] }), '2026-12-31')),
    ).toEqual([]);
    // 残高 10 円 × 月利 0.95% → 丸めて 0 円 = 行なし
    const tiny = source({
      journalEntries: [entry('opening', '2026-01-01', 'invest', 'capital', 10, 'opening')],
    });
    expect(projectionRows(reportEntriesForAsOf(tiny, '2026-12-31'))).toEqual([]);
  });

  it('終了（endDate）を宣言した科目も存在期間内は導出する（v13.4 ② の反転）', () => {
    // 旧挙動は「終了を宣言した科目には一切投影しない」だった（案B・2026-08-12）。v13.4 ② は
    // 終了点までは導出する: 終了時に残高を振替で移すのは作者の仕事で、アプリが黙って
    // 利回りを止めることではない（宣言をアプリの推測で上書きしない、の向きが逆になった）。
    const ended = source({
      accounts: [{ ...invest, archived: true, endDate: '2026-03-31' }, gain, cash, capital],
      journalEntries: [OPENING, entry('close', '2026-03-31', 'cash', 'invest', 100_000)],
    });
    const entries = reportEntriesForAsOf(ended, '2026-12-31');
    // 終了日を超える刻みは 1 本も作らない（上限 = min(asOf, endDate, 2100)）。
    expect(dateAndAmount(projectionRows(entries))).toEqual([
      ['2026-02-01', 949],
      ['2026-03-01', 958],
    ]);
    // 元本だけ引き上げても導出益が残る = 終了点の残高 0 は満たさなくなる（挙動変更）。
    expect(investBalance(ended, '2026-03-31')).toBe(1_907);
    expect(investBalance(ended, '2026-12-31')).toBe(1_907);
  });

  it('終了点不明の旧アーカイブ科目には導出しない（存在期間が決まらない）', () => {
    const legacyArchived = source({
      accounts: [{ ...invest, archived: true }, gain, cash, capital],
    });
    expect(projectionRows(reportEntriesForAsOf(legacyArchived, '2026-12-31'))).toEqual([]);
  });
});

describe('上限', () => {
  it('CONTINUOUS_COST_HARD_CAP（2100 年）で打ち切る', () => {
    const rows = projectionRows(reportEntriesForAsOf(source({}), '2150-12-31'));
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.at(-1)!.date <= '2100-12-31').toBe(true);
  });

  it('桁あふれ: 停止した刻みから行を生成せず、打ち切りを truncations として名乗る', () => {
    const huge = source({
      accounts: [
        { ...invest, annualReturnBp: 100_000 }, // 年率 1000% = 月利 ≈ 22.1%
        gain,
        cash,
        capital,
      ],
      journalEntries: [
        entry('opening', '2026-01-01', 'invest', 'capital', 3_500_000_000_000_000, 'opening'),
      ],
    });
    const result = reportEntriesResultForAsOf(huge, '2027-12-31');
    expect(dateAndAmount(projectionRows(result.entries))).toEqual([
      ['2026-02-01', 774_159_926_091_978],
    ]);
    // 「行が無い」に 3 つの意味（対象外 / 0 円 / 計算を諦めた）を畳まない: 打ち切りは
    // 構造化された診断として返り、UI が注記として名乗れる（黙って横ばいの顔をしない）。
    expect(result.investmentProjectionTruncations).toEqual([
      // date / at は断面の切り出し（導出キャッシュ）が月ではなく日で切るための情報。
      { accountId: 'invest', month: '2026-03', date: '2026-03-01', at: 'step' },
    ]);
  });

  it('打ち切りが起きなければ truncations は空（正常打ち切り = asOf/2100 は診断に含めない）', () => {
    expect(
      reportEntriesResultForAsOf(source({}), '2026-06-30').investmentProjectionTruncations,
    ).toEqual([]);
    // 2100 cap まで完走しても、作者の実データ規模+現実的利回りでは打ち切りにならない。
    expect(
      reportEntriesResultForAsOf(source({}), '2150-12-31').investmentProjectionTruncations,
    ).toEqual([]);
  });

  it('フローの加算が一度でも安全整数域を出たら、後続の引出で戻ってもその刻みで打ち切る', () => {
    const initial = 4_000_000_000_000_000;
    const movement = 6_000_000_000_000_001;
    const src = source({
      journalEntries: [
        ...entriesForTotal('opening', '2026-01-01', 'invest', 'capital', initial, 'opening'),
        ...entriesForTotal('overflow-deposit', '2026-01-20', 'invest', 'cash', movement),
        ...entriesForTotal('restore-withdrawal', '2026-01-21', 'cash', 'invest', movement),
      ],
    });
    const result = investmentProjectionResult(
      src.accounts,
      src.journalEntries,
      new Map(),
      '2026-03-31',
    );
    expect(result.entries).toEqual([]);
    expect(result.truncations).toEqual([
      { accountId: 'invest', month: '2026-02', date: '2026-02-01', at: 'step' },
    ]);
  });
});

describe('保存境界への合流と断面の決定性', () => {
  it('reportEntriesForAsOf（保存不変条件）にも導出益が入る（v13.4 ② の反転）', () => {
    // 旧: 「仮の利回りを保存判断へ逆流させない」（§D 2026-08-11・Codex 指摘）。
    // 新: 利回りは仮ではなく作者の宣言。表示と保存で違う世界を見せる方が危ない。
    const src = source({});
    expect(projectionRows(reportEntriesForAsOf(src, '2026-12-31')).length).toBeGreaterThan(0);
    // 「表示用」の入口はもう別名にすぎない（結果が完全に一致する）。
    expect(displayEntriesForAsOf(src, '2026-12-31').map((e) => e.id)).toEqual(
      reportEntriesForAsOf(src, '2026-12-31').map((e) => e.id),
    );
  });

  it('asOf を動かしても、その手前の断面は 1 行も変わらない（today 非依存）', () => {
    const src = source({
      journalEntries: [OPENING, pin({ id: 'pin1', date: '2027-06-30', actual: 200_000 })],
    });
    const shape = (entries: JournalEntry[], until: string) =>
      entries
        .filter((e) => e.date <= until)
        .map((e) => `${e.date}|${e.id}|${e.lines[0]!.amount}`)
        .sort();
    const early = reportEntriesForAsOf(src, '2026-06-30');
    const late = reportEntriesForAsOf(src, '2030-12-31');
    expect(shape(early, '2026-06-30')).toEqual(shape(late, '2026-06-30'));
    // 導出は要求断面まで伸びる（地平を伸ばすと先が増えるだけ）。
    expect(late.length).toBeGreaterThan(early.length);
  });

  it('恒等式 Δ純資産 = 収支 + equity 自然増減が導出益込みでも成立する', () => {
    const src = source({
      journalEntries: [
        OPENING,
        entry('deposit', '2026-02-20', 'invest', 'cash', 50_000),
        entry('cash-open', '2026-01-01', 'cash', 'capital', 200_000, 'opening'),
      ],
    });
    const accounts = src.accounts;
    const entries = reportEntriesForAsOf(src, '2026-12-31');
    const bs = deriveBalanceSheet(accounts, entries, '2026-12-31');
    const pl = deriveProfitAndLoss(accounts, entries, { to: '2026-12-31' });
    expect(bs.netAssets).toBe(pl.netIncome + equityNaturalDelta(accounts, entries));
    // 導出益が実際に収支側（収益）へ立っている（恒等式が退化していない）。
    expect(pl.totalRevenue).toBeGreaterThan(0);
  });
});

describe('monthlyReturnRate / % ⇄ bp 変換', () => {
  it('月利 = (1 + bp/10000)^(1/12) − 1', () => {
    expect(monthlyReturnRate(1200)).toBeCloseTo(Math.pow(1.12, 1 / 12) - 1, 15);
    expect(monthlyReturnRate(0)).toBe(0);
    expect(monthlyReturnRate(-1200)).toBeLessThan(0);
  });

  it('bp → % テキスト', () => {
    expect(annualReturnBpToPercentText(300)).toBe('3');
    expect(annualReturnBpToPercentText(325)).toBe('3.25');
    expect(annualReturnBpToPercentText(1050)).toBe('10.5');
    expect(annualReturnBpToPercentText(1)).toBe('0.01');
    expect(annualReturnBpToPercentText(-50)).toBe('-0.5');
    expect(annualReturnBpToPercentText(100_000)).toBe('1000');
  });

  it('% テキスト → bp（小数第 2 位まで・範囲外と不正は null）', () => {
    expect(parseAnnualReturnPercentText('3')).toBe(300);
    expect(parseAnnualReturnPercentText('3.25')).toBe(325);
    expect(parseAnnualReturnPercentText(' 10.5 ')).toBe(1050);
    expect(parseAnnualReturnPercentText('-0.5')).toBe(-50);
    expect(parseAnnualReturnPercentText('-99.99')).toBe(-9999);
    expect(parseAnnualReturnPercentText('1000')).toBe(100_000);
    expect(parseAnnualReturnPercentText('0.29')).toBe(29);
    for (const bad of ['', 'abc', '3.256', '1000.01', '-100', '3,5', '3.']) {
      expect(parseAnnualReturnPercentText(bad)).toBeNull();
    }
  });

  it('往復変換が恒等（bp → % → bp）', () => {
    for (const bp of [1, 29, 300, 325, 1050, 9999, 100_000, -1, -50, -9999]) {
      expect(parseAnnualReturnPercentText(annualReturnBpToPercentText(bp))).toBe(bp);
    }
  });
});

describe('schema: annualReturnBp / projectionAccountId', () => {
  const base = {
    id: 'inv',
    name: '投資',
    type: 'asset',
    role: 'investment-asset',
    archived: false,
    createdAt: 'x',
    updatedAt: 'x',
  };

  it('investment-asset にセットで付いていれば受理する', () => {
    expect(
      accountSchema.safeParse({ ...base, annualReturnBp: 300, projectionAccountId: 'gain' })
        .success,
    ).toBe(true);
    expect(
      accountSchema.safeParse({ ...base, annualReturnBp: -9999, projectionAccountId: 'gain' })
        .success,
    ).toBe(true);
  });

  it('片方だけ・自分自身・範囲外・小数・投資以外は拒否する', () => {
    expect(accountSchema.safeParse({ ...base, annualReturnBp: 300 }).success).toBe(false);
    expect(accountSchema.safeParse({ ...base, projectionAccountId: 'gain' }).success).toBe(false);
    expect(
      accountSchema.safeParse({ ...base, annualReturnBp: 300, projectionAccountId: 'inv' }).success,
    ).toBe(false);
    expect(
      accountSchema.safeParse({ ...base, annualReturnBp: 100_001, projectionAccountId: 'gain' })
        .success,
    ).toBe(false);
    expect(
      accountSchema.safeParse({ ...base, annualReturnBp: -10_000, projectionAccountId: 'gain' })
        .success,
    ).toBe(false);
    expect(
      accountSchema.safeParse({ ...base, annualReturnBp: 3.5, projectionAccountId: 'gain' })
        .success,
    ).toBe(false);
    expect(
      accountSchema.safeParse({
        ...base,
        role: 'daily-asset',
        annualReturnBp: 300,
        projectionAccountId: 'gain',
      }).success,
    ).toBe(false);
  });

  it('import は計上先の存在を要求しない（soft reference・消えた後の export を取り込める）', () => {
    const pkg = {
      appId: APP_ID,
      schemaVersion: SCHEMA_VERSION,
      ledgerId: 'ledger',
      exportedAt: '2026-06-01T00:00:00.000Z',
      deviceId: 'dev1',
      revision: 0,
      accounts: [
        // projectionAccountId 'gone' はパッケージ内に存在しない = soft reference なので適法。
        { ...base, annualReturnBp: 300, projectionAccountId: 'gone' },
      ],
      journalEntries: [],
      tags: [],
      monthlyCostItems: [],
      recurringRules: [],
      settings: { ledgerName: '家計簿', currency: 'JPY', displayFractionDigits: 0 },
    };
    expect(ledgerExportPackageSchema.safeParse(pkg).success).toBe(true);
  });
});

describe('保存境界（repository）', () => {
  async function seededAccounts() {
    const ledger = await loadLedger();
    const investAcc = ledger.accounts.find((a) => a.name === '投資')!;
    const income = ledger.accounts.find((a) => a.name === 'その他収入')!;
    const cashAcc = ledger.accounts.find((a) => a.name === '現金')!;
    const capitalAcc = ledger.accounts.find((a) => a.name === '初期残高')!;
    return { investAcc, income, cashAcc, capitalAcc };
  }

  /** 100,000 の初期残高を持つ、利回り宣言済みの投資科目を用意する。 */
  async function seedDeclaredInvestment() {
    const seeded = await seededAccounts();
    await upsertEntry(
      buildSimpleEntry({
        date: '2026-01-01',
        description: '初期',
        debitAccountId: seeded.investAcc.id,
        creditAccountId: seeded.capitalAcc.id,
        amount: 100_000,
      }),
    );
    await upsertAccount({
      ...(await loadLedger()).accounts.find((a) => a.id === seeded.investAcc.id)!,
      annualReturnBp: 1200,
      projectionAccountId: seeded.income.id,
      updatedAt: nowIso(),
    });
    return seeded;
  }

  it('セットで保存でき、片方だけ・投資以外・自分自身・未知の計上先は拒否する', async () => {
    const { investAcc, income, cashAcc } = await seededAccounts();
    await upsertAccount({
      ...investAcc,
      annualReturnBp: 325,
      projectionAccountId: income.id,
      updatedAt: nowIso(),
    });
    const saved = (await loadLedger()).accounts.find((a) => a.id === investAcc.id)!;
    expect(saved.annualReturnBp).toBe(325);
    expect(saved.projectionAccountId).toBe(income.id);

    await expect(
      upsertAccount({ ...saved, annualReturnBp: 325, projectionAccountId: undefined as never }),
    ).rejects.toMatchObject({ code: 'error.account.projectionPair' });
    await expect(
      upsertAccount({
        ...cashAcc,
        annualReturnBp: 325,
        projectionAccountId: income.id,
        updatedAt: nowIso(),
      }),
    ).rejects.toMatchObject({ code: 'error.account.returnOnlyInvestment' });
    await expect(upsertAccount({ ...saved, projectionAccountId: saved.id })).rejects.toMatchObject({
      code: 'error.account.projectionAccountInvalid',
    });
    await expect(
      upsertAccount({ ...saved, projectionAccountId: 'no-such-account' }),
    ).rejects.toMatchObject({ code: 'error.account.projectionAccountInvalid' });
    await expect(
      upsertAccount({ ...saved, projectionAccountId: cashAcc.id }),
    ).rejects.toMatchObject({ code: 'error.account.projectionAccountInvalid' });
  });

  it('soft reference: 計上先が消えても既存科目の編集（改名）は保存できる', async () => {
    const { investAcc, income } = await seededAccounts();
    await upsertAccount({
      ...investAcc,
      annualReturnBp: 300,
      projectionAccountId: income.id,
      updatedAt: nowIso(),
    });
    // 計上先は soft reference なので削除できる（使用中判定に入らない）。
    await deleteAccount(income.id);
    const stale = (await loadLedger()).accounts.find((a) => a.id === investAcc.id)!;
    expect(stale.projectionAccountId).toBe(income.id);
    // 参照先が消えた後でも改名は保存できる（値を変えない限り再検証しない・§A の教訓）。
    await upsertAccount({ ...stale, name: '投資（改名）', updatedAt: nowIso() });
    const renamed = (await loadLedger()).accounts.find((a) => a.id === investAcc.id)!;
    expect(renamed.name).toBe('投資（改名）');
    expect(renamed.projectionAccountId).toBe(income.id);
  });

  it('補正の理論残高は「pin を置いたあとの世界」= 区間の複利を含まない（C-3）', async () => {
    const { investAcc } = await seedDeclaredInvestment();
    // pin が無い世界の残高は複利込みで元本より大きい。
    const withProjection = accountBalance(
      investAcc.id,
      'asset',
      reportEntriesForAsOf(await loadLedger(), '2099-12-31'),
    );
    expect(withProjection).toBeGreaterThan(100_000);

    // pin を置くと利回りの起点がその日へ移り、手前の区間の複利は按分へ置き換わる。
    // したがって理論残高は非補正フローそのもの（元本 100,000）で、差分はそのまま
    // 按分されるスライスの合計になる（旧: 複利込みの残高を基準にしていたため、
    // シートが見せた差分と実際のスライス合計が食い違っていた）。
    const adjusted = await createAdjustment({
      accountId: investAcc.id,
      date: '2099-12-31',
      actualBalance: 90_000,
    });
    expect(adjusted?.metadata?.adjustment).toMatchObject({
      expectedBalance: 100_000,
      actualBalance: 90_000,
      delta: -10_000,
    });
    // 宣言した日の残高は実額ちょうど（按分の不変条件）。
    expect(
      accountBalance(investAcc.id, 'asset', reportEntriesForAsOf(await loadLedger(), '2099-12-31')),
    ).toBe(90_000);
  });

  it('科目アーカイブの残高 0 判定に導出益が入る（宣言 1 本で断面を固定すれば終了できる）', async () => {
    const { investAcc, cashAcc } = await seedDeclaredInvestment();
    // 未来日付の引き出しで**元本だけ**を 0 にする。
    const withdrawal = buildSimpleEntry({
      date: '2099-12-31',
      description: '全額引き出し',
      debitAccountId: cashAcc.id,
      creditAccountId: investAcc.id,
      amount: 100_000,
    });
    await upsertEntry(withdrawal);
    const current = (await loadLedger()).accounts.find((a) => a.id === investAcc.id)!;
    // 導出益が残っているので、終了点の残高 0 を満たさない（挙動変更）。
    await expect(
      upsertAccount({ ...current, archived: true, endDate: '2099-12-31', updatedAt: nowIso() }),
    ).rejects.toMatchObject({ code: 'error.account.archiveBalance' });

    // C-3: pin を置いた世界に区間の複利は無いので、理論残高は非補正フローそのもの
    // （元本 100,000 − 引き出し 100,000 = 0）。実額 0 を宣言しても差額 0 = 宣言が
    // 何も動かさないので pin は作られない（引き出して 0 にしてから宣言しても終われない）。
    expect(
      await createAdjustment({ accountId: investAcc.id, date: '2099-12-31', actualBalance: 0 }),
    ).toBeNull();

    // 終わらせ方は**宣言 1 本**: 引き出しを取り消し、終了日の実残高 0 を宣言する。
    // 差額 −100,000 が (実効開始, 2099-12-31] へ月割りされ、その日の残高はちょうど 0 になる
    // （複利は宣言日より後にしか効かず、終了点で打ち切られる）。
    await deleteEntry(withdrawal.id);
    const pin = await createAdjustment({
      accountId: investAcc.id,
      date: '2099-12-31',
      actualBalance: 0,
    });
    expect(pin).not.toBeNull();
    expect(
      accountBalance(investAcc.id, 'asset', reportEntriesForAsOf(await loadLedger(), '2099-12-31')),
    ).toBe(0);
    const pinned = (await loadLedger()).accounts.find((a) => a.id === investAcc.id)!;
    await upsertAccount({
      ...pinned,
      archived: true,
      endDate: '2099-12-31',
      updatedAt: nowIso(),
    });
    const archived = (await loadLedger()).accounts.find((a) => a.id === investAcc.id)!;
    expect(archived.archived).toBe(true);
    expect(archived.endDate).toBe('2099-12-31');
  });
});
