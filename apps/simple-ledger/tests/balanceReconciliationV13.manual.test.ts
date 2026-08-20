/*
 * v12→v13 変換の**残高照合**（手動ゲート・移行の受け入れ基準）。
 *
 * schema / import のゲートが全て green のまま仕訳が 2 サイクル消えていた事故があり
 * （v13 その8・孤児起票）、残高照合だけが検出手段だった。以後、実データ移行では
 * この照合の差分ゼロを必須とする（意図した差は行レベル diff で説明できること）。
 *
 * 実行: V12_LEDGER_JSON=<変換前 v12> CONVERTED_LEDGER_JSON=<変換後 v13> npx vitest run
 *       tests/balanceReconciliationV13.manual.test.ts
 * 断面は既定 = 今日（BALANCE_ASOF=YYYY-MM-DD で上書き可）。
 *
 * 方式（v13.8 監査 機構4 で 2 系統に拡張。単一断面 + 単一経路の盲点を塞ぐ）:
 *  1. **複数断面の残高照合**: 両側をアプリ本体の同じ集計エンジン（reportEntriesForAsOf）に
 *     通し、**期間内の全年末 + 最古/最新 + 指定断面**で科目別の借方純額を突き合わせる。
 *     単一断面だと「合計は同じで日付だけずれた」変換ミスが素通りする。
 *  2. **事実保全（エンジン非依存の独立検算）**: v12 の保存仕訳そのもの（生 JSON・エンジンを
 *     通さない）が、v13 世界の行として 1 本も消えていないことを (日付, 借方, 貸方, 金額) の
 *     多重集合の包含で見る。両側を同じエンジンに通す照合は、エンジン共通のバグ（例:
 *     ある種の行を両側で落とす）で差分ゼロに見える——片側をエンジン非依存にして塞ぐ。
 *     消失の検出が役目（二重計上・日付ずれは 1 の複数断面が受け持つ）。
 *
 *  - v12 側: v13 エンジンは保存 rec-/ccr- を読み飛ばすため、由来を剥がした手動データへ
 *    中立化（ID 改名 + recurring メタ削除・参照の付け替え）し、ルール無しで通す
 *    ＝「保存されていた事実そのもの」の残高。
 *  - v13 側: 変換後 JSON をそのまま通す（ルール導出込み）＝「導出が再現する世界」の残高。
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import './setup';
import { reportEntriesForAsOf } from '../src/domain/reportEntries';
import { todayLocal } from '../src/util/time';
import type { JournalEntry } from '../src/domain/types';

const v12Path = process.env.V12_LEDGER_JSON;
const v13Path = process.env.CONVERTED_LEDGER_JSON;

interface RawPackage {
  accounts: { id: string; name: string }[];
  journalEntries: JournalEntry[];
  monthlyCostItems: { id: string }[];
  recurringRules: unknown[];
}

/** 保存 rec-/ccr- を「由来なしの手動データ」へ中立化する（金額・日付・行は不変）。 */
function neutralizeV12(pkg: RawPackage): RawPackage {
  const itemIdMap = new Map<string, string>();
  const monthlyCostItems = pkg.monthlyCostItems.map((item) => {
    if (!item.id.startsWith('ccr-')) return item;
    const nextId = `legacy-item-${item.id}`;
    itemIdMap.set(item.id, nextId);
    return { ...item, id: nextId };
  });
  const journalEntries = pkg.journalEntries.map((entry) => {
    let next = entry;
    if (entry.id.startsWith('rec-')) {
      const metadata = { ...(entry.metadata ?? {}) } as Record<string, unknown>;
      delete metadata.recurringRuleId;
      delete metadata.recurringMonth;
      next = {
        ...entry,
        id: `legacy-entry-${entry.id}`,
        ...(Object.keys(metadata).length > 0
          ? { metadata: metadata as JournalEntry['metadata'] }
          : {}),
      };
      if (Object.keys(metadata).length === 0) delete (next as { metadata?: unknown }).metadata;
    }
    const itemRef = next.metadata?.monthlyCostId;
    if (itemRef !== undefined && itemIdMap.has(itemRef)) {
      next = {
        ...next,
        metadata: { ...next.metadata, monthlyCostId: itemIdMap.get(itemRef)! },
      };
    }
    return next;
  });
  return { ...pkg, journalEntries, monthlyCostItems, recurringRules: [] };
}

/** asOf 断面の科目別の借方純額（借方 +・貸方 −）。 */
function balancesAt(pkg: RawPackage, asOf: string): Map<string, number> {
  const entries = reportEntriesForAsOf(
    pkg as unknown as Parameters<typeof reportEntriesForAsOf>[0],
    asOf,
  );
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

/** 2 側の残高マップの差分（v13 − v12）を人が読める行にする。 */
function balanceDiffLines(
  before: Map<string, number>,
  after: Map<string, number>,
  nameOf: (id: string) => string,
  extraIds: Iterable<string> = [],
): string[] {
  const accountIds = new Set([...before.keys(), ...after.keys(), ...extraIds]);
  const diffs: string[] = [];
  for (const id of accountIds) {
    const delta = (after.get(id) ?? 0) - (before.get(id) ?? 0);
    if (delta !== 0) diffs.push(`${nameOf(id)}: ${delta > 0 ? '+' : ''}${delta}`);
  }
  return diffs;
}

/**
 * 照合する断面の集合: 最古の保存日・期間内の全年末・最新の保存日・指定断面。
 * 単一断面だと「合計は同じで日付だけずれた」変換ミスが素通りする（v13.8 監査 機構4）。
 */
function sliceDates(v12: RawPackage, asOfBase: string): string[] {
  const dates = v12.journalEntries.map((entry) => entry.date).sort();
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
  return [...slices].sort();
}

/** (日付, 借方, 貸方, 金額) の多重集合（キー → 件数）。ID・メタに依存しない生の事実。 */
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

/**
 * 事実保全: v12 の保存仕訳（エンジン非依存の生 JSON）が v13 世界に全て残っているか。
 * 戻り値 = 消えた事実（キーと不足数）。導出行が増える側は問わない（包含・消失検出専用）。
 */
function missingFacts(v12: RawPackage, v13: RawPackage, asOf: string): string[] {
  const facts = flowTupleCounts(v12.journalEntries.filter((entry) => entry.date <= asOf));
  const world = flowTupleCounts(
    reportEntriesForAsOf(v13 as unknown as Parameters<typeof reportEntriesForAsOf>[0], asOf),
  );
  const missing: string[] = [];
  for (const [key, count] of facts) {
    const have = world.get(key) ?? 0;
    if (have < count) missing.push(`${key} が ${count - have} 本消えています`);
  }
  return missing;
}

describe.skipIf(!v12Path || !v13Path)('v12→v13 の残高照合（手動ゲート）', () => {
  // skip は「未確認」を意味する。実データ移行の前に必ず両方の JSON を渡して実行する。
  it('複数断面で全科目の残高が一致する（差分ゼロ）', () => {
    const v12 = JSON.parse(readFileSync(v12Path!, 'utf8')) as RawPackage;
    const v13 = JSON.parse(readFileSync(v13Path!, 'utf8')) as RawPackage;
    const asOfBase = process.env.BALANCE_ASOF ?? todayLocal();
    const nameOf = (id: string) => v12.accounts.find((account) => account.id === id)?.name ?? id;

    const neutral = neutralizeV12(v12);
    const slices = sliceDates(v12, asOfBase);
    const failures: string[] = [];
    for (const asOf of slices) {
      const diffs = balanceDiffLines(
        balancesAt(neutral, asOf),
        balancesAt(v13, asOf),
        nameOf,
        v12.accounts.map((account) => account.id),
      );
      console.log(`[残高照合] 断面 ${asOf} / 差分 ${diffs.length} 件（v13 − v12・minor）`);
      for (const line of diffs) console.log(`  - ${line}`);
      if (diffs.length > 0) failures.push(`${asOf}: ${diffs.join(' / ')}`);
    }
    expect(failures).toEqual([]);
  });

  it('事実保全: v12 の保存仕訳が 1 本も消えていない（エンジン非依存の独立検算）', () => {
    const v12 = JSON.parse(readFileSync(v12Path!, 'utf8')) as RawPackage;
    const v13 = JSON.parse(readFileSync(v13Path!, 'utf8')) as RawPackage;
    const asOf = process.env.BALANCE_ASOF ?? todayLocal();
    const missing = missingFacts(v12, v13, asOf);
    for (const line of missing) console.log(`  - ${line}`);
    expect(missing).toEqual([]);
  });
});

/* ── 照合ロジック自体の回帰テスト（fixture・常時実行） ──
 * 手動ゲートは env が無ければ skip される。照合の**検出力**そのものが退行しないよう、
 * 盲点だった 2 事故を fixture で固定する。 */

const TS = '2026-01-01T00:00:00.000Z';

function fixtureEntry(
  id: string,
  date: string,
  debit: string,
  credit: string,
  amount: number,
): JournalEntry {
  return {
    id,
    date,
    description: id,
    kind: 'normal',
    lines: [
      { accountId: debit, side: 'debit', amount },
      { accountId: credit, side: 'credit', amount },
    ],
    createdAt: TS,
    updatedAt: TS,
  };
}

function fixturePkg(journalEntries: JournalEntry[]): RawPackage {
  return {
    accounts: [
      { id: 'cash', name: '現金' },
      { id: 'food', name: '食費' },
    ],
    journalEntries,
    monthlyCostItems: [],
    recurringRules: [],
  };
}

describe('照合ロジックの検出力（fixture）', () => {
  const v12 = fixturePkg([
    fixtureEntry('e1', '2026-01-15', 'food', 'cash', 1000),
    fixtureEntry('e2', '2026-02-15', 'food', 'cash', 2000),
  ]);

  it('日付だけずれた変換（合計は同じ）を複数断面が検出する', () => {
    // e1 が 1 か月後ろへずれた壊れ方: 最終断面の残高は一致し、単一断面照合は素通りする。
    const broken = fixturePkg([
      fixtureEntry('e1', '2026-02-15', 'food', 'cash', 1000),
      fixtureEntry('e2', '2026-02-15', 'food', 'cash', 2000),
    ]);
    const nameOf = (id: string) => id;
    // 旧方式（最終断面のみ）は差分ゼロ = 盲点。
    expect(
      balanceDiffLines(balancesAt(v12, '2026-12-31'), balancesAt(broken, '2026-12-31'), nameOf),
    ).toEqual([]);
    // 複数断面（1 月末を含む）が捕まえる。
    const slices = sliceDates(v12, '2026-12-31');
    expect(slices).toContain('2026-01-15');
    const failing = slices.filter(
      (asOf) =>
        balanceDiffLines(balancesAt(v12, asOf), balancesAt(broken, asOf), nameOf).length > 0,
    );
    expect(failing.length).toBeGreaterThan(0);
  });

  it('消えた仕訳をエンジン非依存の事実保全が検出する', () => {
    const dropped = fixturePkg([fixtureEntry('e2', '2026-02-15', 'food', 'cash', 2000)]);
    expect(missingFacts(v12, dropped, '2026-12-31')).toEqual([
      '2026-01-15|food|cash|1000 が 1 本消えています',
    ]);
    // 消えていなければ空（導出行が増える側は問わない = 包含）。
    expect(missingFacts(v12, v12, '2026-12-31')).toEqual([]);
  });
});
