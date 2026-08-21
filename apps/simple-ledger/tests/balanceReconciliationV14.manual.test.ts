/*
 * v13→v14 変換の**残高照合**（手動ゲート・移行の受け入れ基準・v13.13 §5）。
 *
 * v12→v13 と違い、**差分ゼロではなく「差分が想定表と一致」がゲート**:
 * ローンの意味論変更（台帳経由 2 本・1 刻み遅れ・floor 端数 → 直接 1 本・同日・厳密一致）で
 * ①負債 ②月割り台帳 ③返済元 に必ず差が出る。さらに v13.17（投資の利回り投影の撤去）で
 * ④投資宣言を持っていた科目 + その投影計上先に**最後の pin 以降の複利ぶんの差**が出る
 * （投資残高のフラット化 = 意図どおり）。照合条件は:
 *  (i) 差分が出る科目が**想定集合**（ローンの負債・月割り台帳・ローンの返済元 +
 *      投資宣言を持っていた科目とその投影計上先）に限られること
 *  (ii) **純資産は投影経路を除き全断面で不変**（監査 #8: 純資産差 = 変換ミスの兆候。
 *       v13.17 で投影益ぶんだけ純資産が下がるのは意図どおりなので、投資宣言科目と
 *       投影計上先**経由の差分だけ**を不変条件から除外する — 無条件には緩めない）
 *  (iii) 事実保全: v13 の保存仕訳が 1 本も消えていない（エンジン非依存の独立検算。
 *        変換が意図して消す/付け替える壊れ pin だけは変換ログと突き合わせて説明できること）
 *
 * 実行: V13_LEDGER_JSON=<変換前 v13> CONVERTED_LEDGER_JSON=<変換後 v14> npx vitest run
 *       tests/balanceReconciliationV14.manual.test.ts
 * 断面は既定 = 今日（BALANCE_ASOF=YYYY-MM-DD で上書き可）。
 *
 * v13 側の残高は**現行エンジン + 投影の凍結再実装**で出す: ローン等は汎用ルールとして
 * 今も同じ数学で動くが、利回り投影だけは v13.17 でエンジンから消えたため、旧アプリが
 * 見せていた残高（最後の pin 起点の月次複利）をこのテスト内の凍結コピーで復元して足す。
 * 差分表にフラット化の金額がそのまま出る = 作者の実機目視の照合表になる。
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import './setup';
import { reportEntriesForAsOf } from '../src/domain/reportEntries';
import { CONTINUOUS_COST_LEDGER_ACCOUNT_ID } from '../src/domain/constants';
import { accountExistsAt } from '../src/domain/accountLifetime';
import { addMonthsToDate } from '../src/domain/allocation';
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

/* ── 旧・投資の利回り投影の凍結再実装（v13.17 で撤去した v13.4 ② の導出。照合専用） ──
 * v13 の実データが旧アプリで見せていた投資残高を復元するためだけの写し。正本は git 履歴の
 * src/domain/investmentProjection.ts（309b73e 以前）。健全な pin（対象・相手とも引ける）を
 * 前提にした近似で、打ち切り診断・桁あふれガードは持たない（実データの規模では届かない）。 */

interface RawInvestmentDeclaration {
  accountId: string;
  projectionAccountId: string;
  /** 月利 = (1 + bp/10000)^(1/12) − 1。 */
  rate: number;
}

/** v13 JSON の生フィールド（現行 Account 型からは撤去済み）から有効な宣言を読む。 */
function investmentDeclarations(pkg: RawPackage): RawInvestmentDeclaration[] {
  const byId = new Map(pkg.accounts.map((a) => [a.id, a] as const));
  const out: RawInvestmentDeclaration[] = [];
  for (const account of pkg.accounts) {
    if (account.role !== 'investment-asset') continue;
    const raw = account as unknown as { annualReturnBp?: number; projectionAccountId?: string };
    const bp = raw.annualReturnBp;
    if (bp === undefined || bp === 0 || !Number.isInteger(bp) || bp < -9999 || bp > 100_000) {
      continue;
    }
    const projectionAccountId = raw.projectionAccountId;
    if (projectionAccountId === undefined || projectionAccountId === account.id) continue;
    if (byId.get(projectionAccountId)?.role !== 'income-category') continue;
    if (account.archived && account.endDate === undefined) continue;
    const rate = Math.pow(1 + bp / 10_000, 1 / 12) - 1;
    if (!Number.isFinite(rate) || rate === 0) continue;
    out.push({ accountId: account.id, projectionAccountId, rate });
  }
  return out;
}

/** 対象科目の借方符号の増減（複数行合算）。 */
function debitDeltaOf(entry: JournalEntry, accountId: string): number {
  let delta = 0;
  for (const line of entry.lines) {
    if (line.accountId !== accountId) continue;
    delta += line.side === 'debit' ? line.amount : -line.amount;
  }
  return delta;
}

/** 旧投影の評価益（asOf まで）。起点 = 最後の pin（無ければ実効開始）・同日刻みの月次複利。 */
function projectedGainThrough(
  v13: RawPackage,
  declaration: RawInvestmentDeclaration,
  asOf: string,
): number {
  const account = v13.accounts.find((a) => a.id === declaration.accountId)!;
  const projectionAccount = v13.accounts.find((a) => a.id === declaration.projectionAccountId)!;
  const cap = account.endDate !== undefined && account.endDate < asOf ? account.endDate : asOf;
  // フロー = 現行エンジンの導出込み世界（按分スライスの対象科目側の行は旧エンジンと同一）。
  const flows = reportEntriesForAsOf(v13, asOf)
    .filter((entry) => entry.lines.some((line) => line.accountId === declaration.accountId))
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  const pins = v13.journalEntries
    .filter((entry) => entry.metadata?.adjustment?.accountId === declaration.accountId)
    .sort((a, b) => {
      if (a.date !== b.date) return a.date < b.date ? -1 : 1;
      if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? -1 : 1;
      return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    });
  const lastPin = pins.at(-1);
  const anchorDate = lastPin?.date ?? flows[0]?.date;
  if (anchorDate === undefined) return 0;
  let cursor = 0;
  while (cursor < flows.length && flows[cursor]!.date <= anchorDate) cursor += 1;
  let balance = lastPin?.metadata?.adjustment?.actualBalance ?? 0;
  if (lastPin === undefined) {
    for (let i = 0; i < cursor; i += 1) balance += debitDeltaOf(flows[i]!, declaration.accountId);
  }
  let total = 0;
  for (let k = 1; ; k += 1) {
    const date = addMonthsToDate(anchorDate, k);
    if (date > cap) break;
    while (cursor < flows.length && flows[cursor]!.date < date) {
      balance += debitDeltaOf(flows[cursor]!, declaration.accountId);
      cursor += 1;
    }
    if (!accountExistsAt(account, date) || !accountExistsAt(projectionAccount, date)) continue;
    if (balance <= 0) continue;
    const gain = Math.round(balance * declaration.rate);
    if (gain === 0) continue;
    balance += gain;
    total += gain;
  }
  return total;
}

/** v13 側の残高 = 現行エンジン + 旧投影の復元（旧アプリが見せていた残高の再現）。 */
function v13BalancesAt(v13: RawPackage, asOf: string): Map<string, number> {
  const balances = balancesAt(v13, asOf);
  for (const declaration of investmentDeclarations(v13)) {
    const gain = projectedGainThrough(v13, declaration, asOf);
    if (gain === 0) continue;
    balances.set(declaration.accountId, (balances.get(declaration.accountId) ?? 0) + gain);
    balances.set(
      declaration.projectionAccountId,
      (balances.get(declaration.projectionAccountId) ?? 0) - gain,
    );
  }
  return balances;
}

/** 投影経路の科目（純資産不変の除外対象 = 投資宣言科目 + その投影計上先・§4.3）。 */
function projectionExemptAccounts(v13: RawPackage): Set<string> {
  const exempt = new Set<string>();
  for (const declaration of investmentDeclarations(v13)) {
    exempt.add(declaration.accountId);
    exempt.add(declaration.projectionAccountId);
  }
  return exempt;
}

/** 想定差分の科目集合: 旧ローンルールの負債・返済元 + 月割り台帳 + 投影経路（v13.17）。 */
function expectedDiffAccounts(v13: RawPackage): Set<string> {
  const roleOf = (id: string) => v13.accounts.find((a) => a.id === id)?.role;
  const expected = new Set<string>([CONTINUOUS_COST_LEDGER_ACCOUNT_ID]);
  for (const rule of v13.recurringRules) {
    if (LIABILITY_ROLES.has(roleOf(rule.spreadExpenseAccountId) ?? '')) {
      expected.add(rule.spreadExpenseAccountId);
      expected.add(rule.creditAccountId);
    }
  }
  for (const id of projectionExemptAccounts(v13)) expected.add(id);
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
  it('差分は想定科目（ローンの負債・台帳・返済元 + 投影経路）に限られ、純資産は投影経路を除き全断面で不変', () => {
    const v13 = JSON.parse(readFileSync(v13Path!, 'utf8')) as RawPackage;
    const v14 = JSON.parse(readFileSync(v14Path!, 'utf8')) as RawPackage;
    const asOfBase = process.env.BALANCE_ASOF ?? todayLocal();
    const nameOf = (id: string) => v13.accounts.find((account) => account.id === id)?.name ?? id;
    const expected = expectedDiffAccounts(v13);
    const exempt = projectionExemptAccounts(v13);

    const failures: string[] = [];
    for (const asOf of sliceDates(v13, asOfBase)) {
      // v13 側は旧投影を復元した残高（旧アプリの見た目）。差分表にフラット化の額が出る。
      const before = v13BalancesAt(v13, asOf);
      const after = balancesAt(v14, asOf);
      const diff = new Map<string, number>();
      for (const id of new Set([...before.keys(), ...after.keys()])) {
        const delta = (after.get(id) ?? 0) - (before.get(id) ?? 0);
        if (delta !== 0) diff.set(id, delta);
      }
      console.log(`[残高照合] 断面 ${asOf} / 差分 ${diff.size} 件（v14 − v13・借方純額・minor）`);
      for (const [id, delta] of diff) {
        const mark = exempt.has(id) ? '（投影経路・フラット化ぶん）' : '';
        console.log(`  - ${nameOf(id)}: ${delta > 0 ? '+' : ''}${delta}${mark}`);
      }
      // (i) 想定外の科目に差分が出たら fail（想定差分方式のゲート）。
      for (const id of diff.keys()) {
        if (!expected.has(id)) failures.push(`${asOf}: 想定外の科目に差分（${nameOf(id)}）`);
      }
      // (ii) 純資産は**投影経路（投資宣言科目 + 投影計上先）を除き**全断面で不変（監査 #8・
      //      v13.17 §4.3。投影益ぶんの低下だけが意図どおりで、それ以外の経路は従来どおり不変）。
      const nonExemptDiff = new Map([...diff].filter(([id]) => !exempt.has(id)));
      const net = netAssetsDelta(nonExemptDiff, v13.accounts);
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

/* ── 投影経路（v13.17 撤去）の照合フィクスチャ ──
 * v13 側に投資宣言（生フィールド）+ pin、v14 側は strip 済みの同一データ。
 * 差分 = 最後の pin 以降の複利ぶんが投資科目と投影計上先だけに出て、
 * それを除けば純資産不変が成り立つことを固定する（mutation (c): expectedDiffAccounts /
 * projectionExemptAccounts から投影経路の追加を外すと、この照合が想定外差分で落ちる）。 */

const investAccountsV13: Account[] = [
  {
    id: 'invest',
    name: '投資',
    type: 'asset',
    role: 'investment-asset',
    archived: false,
    createdAt: TS,
    updatedAt: TS,
    // v13 の生フィールド（現行 Account 型からは撤去済みなので生 JSON と同じ形で持たせる）。
    ...({ annualReturnBp: 1200, projectionAccountId: 'gain' } as object),
  },
  {
    id: 'gain',
    name: '投資益',
    type: 'revenue',
    role: 'income-category',
    archived: false,
    createdAt: TS,
    updatedAt: TS,
  },
  {
    id: 'equity',
    name: '初期残高',
    type: 'equity',
    role: 'equity',
    archived: false,
    createdAt: TS,
    updatedAt: TS,
  },
  {
    id: 'adj-rev',
    name: '残高調整益',
    type: 'revenue',
    role: 'system-adjustment',
    archived: false,
    createdAt: TS,
    updatedAt: TS,
  },
];
const investOpening: JournalEntry = {
  id: 'invest-open',
  date: '2026-01-10',
  description: '投資の初期残高',
  kind: 'opening',
  lines: [
    { accountId: 'invest', side: 'debit', amount: 1_200_000 },
    { accountId: 'equity', side: 'credit', amount: 1_200_000 },
  ],
  createdAt: TS,
  updatedAt: TS,
};
const investPin: JournalEntry = {
  id: 'invest-pin',
  date: '2026-03-15',
  description: '残高補正',
  kind: 'normal',
  lines: [
    { accountId: 'invest', side: 'debit', amount: 50_000 },
    { accountId: 'adj-rev', side: 'credit', amount: 50_000 },
  ],
  metadata: {
    adjustment: {
      accountId: 'invest',
      expectedBalance: 1_200_000,
      actualBalance: 1_250_000,
      delta: 50_000,
      counterpartAccountId: 'adj-rev',
    },
  },
  createdAt: TS,
  updatedAt: TS,
};
const investV13: RawPackage = {
  accounts: investAccountsV13,
  journalEntries: [investOpening, investPin],
  monthlyCostItems: [],
  recurringRules: [],
};
/** 変換スクリプトの strip 出力と同じ形（宣言フィールドだけが消えた同一データ）。 */
const investV14: RawPackage = {
  ...investV13,
  accounts: investAccountsV13.map((a) => {
    const next = { ...a } as Record<string, unknown>;
    delete next.annualReturnBp;
    delete next.projectionAccountId;
    return next as unknown as Account;
  }),
};

describe('照合ロジックの検出力（投影経路・v13.17）', () => {
  it('最後の pin 以降の複利ぶんだけが投資科目と投影計上先に出て、想定集合と純資産条件を通る', () => {
    const expected = expectedDiffAccounts(investV13);
    const exempt = projectionExemptAccounts(investV13);
    // mutation (c) の固定: 投影経路の追加を外すと expected から invest / gain が消えて落ちる。
    expect(expected.has('invest')).toBe(true);
    expect(expected.has('gain')).toBe(true);

    const asOf = '2026-06-20';
    const before = v13BalancesAt(investV13, asOf);
    const after = balancesAt(investV14, asOf);
    const diff = new Map<string, number>();
    for (const id of new Set([...before.keys(), ...after.keys()])) {
      const delta = (after.get(id) ?? 0) - (before.get(id) ?? 0);
      if (delta !== 0) diff.set(id, delta);
    }
    // フラット化の差分が実在し（複利 3 刻みぶん）、投影経路の 2 科目に限られる。
    expect(diff.size).toBe(2);
    const investDiff = diff.get('invest')!;
    expect(investDiff).toBeLessThan(0);
    expect(diff.get('gain')).toBe(-investDiff);
    for (const id of diff.keys()) expect(expected.has(id)).toBe(true);
    // 投影経路を除けば純資産不変・除かなければ動く（除外が仕事をしている = 無条件に緩めていない）。
    const nonExempt = new Map([...diff].filter(([id]) => !exempt.has(id)));
    expect(netAssetsDelta(nonExempt, investV13.accounts)).toBe(0);
    expect(netAssetsDelta(diff, investV13.accounts)).not.toBe(0);
    // 複利の値そのもの: 起点 = pin の実額 1,250,000・月利 = 1.12^(1/12) − 1 の 3 刻み。
    const rate = Math.pow(1.12, 1 / 12) - 1;
    let balance = 1_250_000;
    let total = 0;
    for (let k = 0; k < 3; k += 1) {
      const gain = Math.round(balance * rate);
      balance += gain;
      total += gain;
    }
    expect(-investDiff).toBe(total);
  });

  it('pin より手前の断面では差分ゼロ（按分の世界は両側で同一）', () => {
    for (const asOf of ['2026-01-10', '2026-03-14', '2026-03-15', '2026-04-14']) {
      const before = v13BalancesAt(investV13, asOf);
      const after = balancesAt(investV14, asOf);
      for (const id of new Set([...before.keys(), ...after.keys()])) {
        expect((after.get(id) ?? 0) - (before.get(id) ?? 0), `@ ${asOf} ${id}`).toBe(0);
      }
    }
  });
});
