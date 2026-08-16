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
 * 方式: 両側とも**アプリ本体の同じ集計エンジン**（reportEntriesForAsOf）に通して
 * 科目別の借方純額を突き合わせる（照合ロジックの二重実装を作らない）:
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

describe.skipIf(!v12Path || !v13Path)('v12→v13 の残高照合（手動ゲート）', () => {
  // skip は「未確認」を意味する。実データ移行の前に必ず両方の JSON を渡して実行する。
  it('同一断面で全科目の残高が一致する（差分ゼロ）', () => {
    const v12 = JSON.parse(readFileSync(v12Path!, 'utf8')) as RawPackage;
    const v13 = JSON.parse(readFileSync(v13Path!, 'utf8')) as RawPackage;
    const asOf = process.env.BALANCE_ASOF ?? todayLocal();

    const before = balancesAt(neutralizeV12(v12), asOf);
    const after = balancesAt(v13, asOf);
    const accountIds = new Set([
      ...before.keys(),
      ...after.keys(),
      ...v12.accounts.map((account) => account.id),
    ]);
    const nameOf = (id: string) => v12.accounts.find((account) => account.id === id)?.name ?? id;

    const diffs: string[] = [];
    for (const id of accountIds) {
      const delta = (after.get(id) ?? 0) - (before.get(id) ?? 0);
      if (delta !== 0) diffs.push(`${nameOf(id)}: ${delta > 0 ? '+' : ''}${delta}`);
    }
    console.log(
      `[残高照合] 断面 ${asOf} / 科目 ${accountIds.size} 件 / 差分 ${diffs.length} 件（v13 − v12・minor）`,
    );
    for (const line of diffs) console.log(`  - ${line}`);
    expect(diffs).toEqual([]);
  });
});
