/*
 * v13→v14 変換の**残高照合**（手動ゲート・移行の受け入れ基準・v13.13 §5）。
 *
 * v12→v13 と違い、**差分ゼロではなく「差分が想定表と一致」がゲート**:
 * ローンの意味論変更（台帳経由 2 本・1 刻み遅れ・floor 端数 → 直接 1 本・同日・厳密一致）で
 * ①負債 ②月割り台帳 ③返済元 に必ず差が出る。照合条件は:
 *  (i) 差分が出る科目が**想定集合**（ローンの負債・月割り台帳・ローンの返済元）に限られること
 *  (ii) **純資産は全断面で不変**（監査 #8: 旧モデルでも in-flight は台帳〔資産〕が持ち
 *       純資産は動かないため、純資産差 = 変換ミスの兆候。想定差分扱いにすると誤変換を誤受理する）
 *  (iii) 事実保全: v13 の保存仕訳が 1 本も消えていない（エンジン非依存の独立検算。
 *        変換が意図して消す/付け替える壊れ pin だけは変換ログと突き合わせて説明できること）
 *
 * 実行: V13_LEDGER_JSON=<変換前 v13> CONVERTED_LEDGER_JSON=<変換後 v14> npx vitest run
 *       tests/balanceReconciliationV14.manual.test.ts
 * 断面は既定 = 今日（BALANCE_ASOF=YYYY-MM-DD で上書き可）。
 *
 * v13 側の残高は**現行エンジンそのもの**で出す: 計上先が負債のルールは v14 の wire で
 * 拒否されるだけで、導出（deriveRecurringOutputs + 台帳経由の月割り）は汎用ルールとして
 * 今も同じ数学で動く = 旧モデルの残高が正確に再現される。
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import './setup';
import { reportEntriesForAsOf } from '../src/domain/reportEntries';
import { CONTINUOUS_COST_LEDGER_ACCOUNT_ID } from '../src/domain/constants';
import { todayLocal } from '../src/util/time';
import type { Account, JournalEntry, MonthlyCostItem, RecurringRule } from '../src/domain/types';

const v13Path = process.env.V13_LEDGER_JSON;
const v14Path = process.env.CONVERTED_LEDGER_JSON;

interface RawPackage {
  accounts: Account[];
  journalEntries: JournalEntry[];
  monthlyCostItems: MonthlyCostItem[];
  recurringRules: RecurringRule[];
}

const LIABILITY_ROLES = new Set(['payment-liability', 'other-liability']);

/** asOf 断面の科目別の借方純額（借方 +・貸方 −）。 */
function balancesAt(pkg: RawPackage, asOf: string): Map<string, number> {
  const entries = reportEntriesForAsOf(pkg, asOf);
  const map = new Map<string, number>();
  for (const entry of entries) {
    if (entry.date > asOf) continue;
    for (const line of entry.lines) {
      const delta = line.side === 'debit' ? line.amount : -line.amount;
      map.set(line.accountId, (map.get(line.accountId) ?? 0) + delta);
    }
  }
  return map;
}

/** 借方純額の差分マップから純資産の差を出す（資産 +・負債は借方 + = 減 = 純資産 +・PL 経由も加味）。 */
function netAssetsDelta(diff: Map<string, number>, accounts: Account[]): number {
  const typeOf = new Map(accounts.map((a) => [a.id, a.type] as const));
  let net = 0;
  for (const [id, v] of diff) {
    const type = typeOf.get(id);
    if (type === 'asset' || type === 'liability') net += v;
    else net -= v; // expense/revenue/equity は retained earnings 経由で逆符号
  }
  return net;
}

/** 想定差分の科目集合: 旧ローンルールの負債・返済元 + 月割り台帳。 */
function expectedDiffAccounts(v13: RawPackage): Set<string> {
  const roleOf = (id: string) => v13.accounts.find((a) => a.id === id)?.role;
  const expected = new Set<string>([CONTINUOUS_COST_LEDGER_ACCOUNT_ID]);
  for (const rule of v13.recurringRules) {
    if (LIABILITY_ROLES.has(roleOf(rule.spreadExpenseAccountId) ?? '')) {
      expected.add(rule.spreadExpenseAccountId);
      expected.add(rule.creditAccountId);
    }
  }
  return expected;
}

/** 照合する断面の集合: 最古の保存日・期間内の全年末・最新の保存日・指定断面 + 完済後の遠断面。 */
function sliceDates(v13: RawPackage, asOfBase: string): string[] {
  const dates = v13.journalEntries.map((entry) => entry.date).sort();
  const slices = new Set<string>([asOfBase]);
  const first = dates[0];
  const last = dates.at(-1);
  if (first !== undefined && last !== undefined) {
    slices.add(first);
    slices.add(last);
    const firstYear = Number.parseInt(first.slice(0, 4), 10);
    const lastYear = Number.parseInt(last.slice(0, 4), 10);
    for (let year = firstYear; year <= lastYear; year += 1) slices.add(`${year}-12-31`);
  }
  // ローンの完済後（旧・排他的終了日の後）も 1 断面見る（端数解消の最終形）。
  for (const rule of v13.recurringRules) {
    if (rule.endDate !== undefined) slices.add(rule.endDate);
  }
  return [...slices].sort();
}

/** (日付, 借方, 貸方, 金額) の多重集合（キー → 件数）。ID・メタ・memo に依存しない生の事実。 */
function flowTupleCounts(entries: readonly JournalEntry[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const entry of entries) {
    const debit = entry.lines.find((line) => line.side === 'debit');
    const credit = entry.lines.find((line) => line.side === 'credit');
    const key = `${entry.date}|${debit?.accountId}|${credit?.accountId}|${debit?.amount}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

function missingFacts(v13: RawPackage, v14: RawPackage, asOf: string): string[] {
  // 補正 pin（metadata.adjustment）は v13.4 以降、エンジンが按分スライスへ置き換えるため
  // 「stored の行そのもの」は導出世界に現れない（設計どおり）。事実保全の対象から除き、
  // pin の保全は残高照合（想定差分 + 純資産不変）と変換ログの pin 修復列挙が受け持つ。
  const facts = flowTupleCounts(
    v13.journalEntries.filter(
      (entry) => entry.date <= asOf && entry.metadata?.adjustment === undefined,
    ),
  );
  const world = flowTupleCounts(reportEntriesForAsOf(v14, asOf));
  const missing: string[] = [];
  for (const [key, count] of facts) {
    const have = world.get(key) ?? 0;
    if (have < count) missing.push(`${key} が ${count - have} 本消えています`);
  }
  return missing;
}

describe.skipIf(!v13Path || !v14Path)('v13→v14 の残高照合（手動ゲート・想定差分方式）', () => {
  // skip は「未確認」を意味する。実データ移行の前に必ず両方の JSON を渡して実行する。
  it('差分は想定科目（ローンの負債・台帳・返済元）に限られ、純資産は全断面で不変', () => {
    const v13 = JSON.parse(readFileSync(v13Path!, 'utf8')) as RawPackage;
    const v14 = JSON.parse(readFileSync(v14Path!, 'utf8')) as RawPackage;
    const asOfBase = process.env.BALANCE_ASOF ?? todayLocal();
    const nameOf = (id: string) => v13.accounts.find((account) => account.id === id)?.name ?? id;
    const expected = expectedDiffAccounts(v13);

    const failures: string[] = [];
    for (const asOf of sliceDates(v13, asOfBase)) {
      const before = balancesAt(v13, asOf);
      const after = balancesAt(v14, asOf);
      const diff = new Map<string, number>();
      for (const id of new Set([...before.keys(), ...after.keys()])) {
        const delta = (after.get(id) ?? 0) - (before.get(id) ?? 0);
        if (delta !== 0) diff.set(id, delta);
      }
      console.log(`[残高照合] 断面 ${asOf} / 差分 ${diff.size} 件（v14 − v13・借方純額・minor）`);
      for (const [id, delta] of diff) {
        console.log(`  - ${nameOf(id)}: ${delta > 0 ? '+' : ''}${delta}`);
      }
      // (i) 想定外の科目に差分が出たら fail（想定差分方式のゲート）。
      for (const id of diff.keys()) {
        if (!expected.has(id)) failures.push(`${asOf}: 想定外の科目に差分（${nameOf(id)}）`);
      }
      // (ii) 純資産は全断面で不変（監査 #8）。
      const net = netAssetsDelta(diff, v13.accounts);
      if (net !== 0) failures.push(`${asOf}: 純資産が ${net} 動いています（変換ミスの兆候）`);
    }
    expect(failures).toEqual([]);
  });

  it('事実保全: v13 の保存仕訳が 1 本も消えていない（エンジン非依存の独立検算）', () => {
    const v13 = JSON.parse(readFileSync(v13Path!, 'utf8')) as RawPackage;
    const v14 = JSON.parse(readFileSync(v14Path!, 'utf8')) as RawPackage;
    const asOf = process.env.BALANCE_ASOF ?? todayLocal();
    const missing = missingFacts(v13, v14, asOf);
    for (const line of missing) console.log(`  - ${line}`);
    // 変換が意図して消す/付け替えるのは壊れ pin だけ（変換ログの「壊れた補正 pin の修復」と
    // 突き合わせて説明できること）。実データでは 0 件想定。
    expect(missing).toEqual([]);
  });
});

/* ── 照合ロジック自体の回帰テスト（fixture・常時実行） ──
 * 手動ゲートは env が無ければ skip される。照合の**検出力**そのものが退行しないよう、
 * 「純資産不変」と「想定科目の限定」が実際にローン変換の差分を受理し、
 * 変換ミス（返済の消失で純資産が動く形ではなく、想定外科目への波及）を弾くことを固定する。 */

const TS = '2026-01-10T00:00:00.000Z';
const fixtureAccounts: Account[] = [
  {
    id: 'cash',
    name: '現金',
    type: 'asset',
    role: 'daily-asset',
    archived: false,
    createdAt: TS,
    updatedAt: TS,
  },
  {
    id: 'liab',
    name: 'ローン',
    type: 'liability',
    role: 'other-liability',
    archived: false,
    createdAt: TS,
    updatedAt: TS,
  },
  {
    id: 'food',
    name: '食費',
    type: 'expense',
    role: 'expense-category',
    archived: false,
    createdAt: TS,
    updatedAt: TS,
  },
  {
    id: CONTINUOUS_COST_LEDGER_ACCOUNT_ID,
    name: '月割り台帳',
    type: 'asset',
    role: 'continuing-cost-asset',
    archived: false,
    createdAt: TS,
    updatedAt: TS,
  },
];
const borrow: JournalEntry = {
  id: 'b1',
  date: '2026-01-10',
  description: 'ローン',
  kind: 'normal',
  lines: [
    { accountId: 'food', side: 'debit', amount: 10000 },
    { accountId: 'liab', side: 'credit', amount: 10000 },
  ],
  createdAt: TS,
  updatedAt: TS,
};
/** 旧モデル: 計上先 = 負債のルール（floor 月額 1666 × 6 回）。 */
const v13Fixture: RawPackage = {
  accounts: fixtureAccounts,
  journalEntries: [borrow],
  monthlyCostItems: [],
  recurringRules: [
    {
      id: 'r1',
      name: 'ローン',
      amount: 1666,
      dayOfMonth: 10,
      everyMonths: 1,
      spreadExpenseAccountId: 'liab',
      debitAccountId: CONTINUOUS_COST_LEDGER_ACCOUNT_ID,
      creditAccountId: 'cash',
      startMonth: '2026-02',
      startDate: '2026-01-10',
      endDate: '2026-08-10',
      createdAt: TS,
      updatedAt: TS,
    },
  ],
};
/** 新モデル: 同じローンの item 形（変換スクリプトの出力と同じ形を手組み）。 */
const v14Fixture: RawPackage = {
  accounts: fixtureAccounts,
  journalEntries: [{ ...borrow, metadata: { loanItemId: 'loan1' } }],
  monthlyCostItems: [
    {
      id: 'loan1',
      name: 'ローン',
      amount: 10000,
      startDate: '2026-01-10',
      endDate: '2026-07-10',
      expenseAccountId: 'liab',
      repaymentSourceAccountId: 'cash',
      createdAt: TS,
      updatedAt: TS,
    },
  ],
  recurringRules: [],
};

describe('照合ロジックの検出力（fixture）', () => {
  it('正しいローン変換の差分は想定科目に収まり、純資産は全断面で不変', () => {
    const expected = expectedDiffAccounts(v13Fixture);
    for (const asOf of [
      '2026-01-10',
      '2026-02-10',
      '2026-03-09',
      '2026-05-01',
      '2026-08-10',
      '2027-01-01',
    ]) {
      const before = balancesAt(v13Fixture, asOf);
      const after = balancesAt(v14Fixture, asOf);
      const diff = new Map<string, number>();
      for (const id of new Set([...before.keys(), ...after.keys()])) {
        const delta = (after.get(id) ?? 0) - (before.get(id) ?? 0);
        if (delta !== 0) diff.set(id, delta);
      }
      for (const id of diff.keys()) expect(expected.has(id)).toBe(true);
      expect(netAssetsDelta(diff, fixtureAccounts)).toBe(0);
    }
    // 端数の解消が最終形で見える: 旧は負債に 4 残り、新は 0（差分 = 借方純額 +4）。
    const finalDiff =
      (balancesAt(v14Fixture, '2027-01-01').get('liab') ?? 0) -
      (balancesAt(v13Fixture, '2027-01-01').get('liab') ?? 0);
    expect(finalDiff).toBe(4);
  });

  it('返済の刻みが消える変換ミス（完済日の欠落）でも純資産不変はすり抜けない…ではなく想定科目の限定と事実保全が受け持つ', () => {
    // 返済は 負債⇄返済元 の振替なので、刻みが消えても純資産は動かない（転記もれは
    // 純資産不変では捕まらない）。その代わり (i) 想定科目の限定が「想定外の科目に出る誤変換」を、
    // (iii) 事実保全が「保存仕訳の消失」を受け持つ——3 条件で 1 つのゲートである根拠を固定する。
    const brokenV14: RawPackage = {
      ...v14Fixture,
      monthlyCostItems: [
        { ...v14Fixture.monthlyCostItems[0]!, expenseAccountId: 'liab', endDate: '2026-04-10' },
      ],
    };
    const diffAt = (asOf: string) => {
      const before = balancesAt(v13Fixture, asOf);
      const after = balancesAt(brokenV14, asOf);
      const diff = new Map<string, number>();
      for (const id of new Set([...before.keys(), ...after.keys()])) {
        const delta = (after.get(id) ?? 0) - (before.get(id) ?? 0);
        if (delta !== 0) diff.set(id, delta);
      }
      return diff;
    };
    // 純資産は動かない（振替の性質）。
    expect(netAssetsDelta(diffAt('2026-12-31'), fixtureAccounts)).toBe(0);
    // が、差分そのもの（負債・返済元）は残高照合の表に出て、作者の目視確認へ渡る。
    expect(diffAt('2026-12-31').size).toBeGreaterThan(0);
    // 保存仕訳の消失は事実保全が独立に捕まえる。
    const dropped: RawPackage = { ...v14Fixture, journalEntries: [] };
    expect(missingFacts(v13Fixture, dropped, '2026-12-31')).toEqual([
      '2026-01-10|food|liab|10000 が 1 本消えています',
    ]);
  });
});
