/*
 * 取り置き資金（聖域化・集約モデル）の目的別残高。
 *
 * 目的ごとに勘定科目を作らず、全取り置きを単一の集約口座（RESERVE_LEDGER_ACCOUNT_ID『取り置き資金』）に
 * 寄せる。目的別残高は、取り置き仕訳の `metadata.reserveId` と集約口座への増減から導出する:
 *  - 取り置く（資金口座 → 取り置き）: 集約口座は **借方(debit)** = 残高 +。
 *  - 取り崩す（取り置き → 資金/費用）: 集約口座は **貸方(credit)** = 残高 −。
 */
import { RESERVE_LEDGER_ACCOUNT_ID } from './constants';
import type { JournalEntry } from './types';

/** reserveId → 目的別残高（集約口座の debit − credit を reserveId で集計）。 */
export function reserveBalances(entries: JournalEntry[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const e of entries) {
    const rid = e.metadata?.reserveId;
    if (!rid) continue;
    for (const l of e.lines) {
      if (l.accountId !== RESERVE_LEDGER_ACCOUNT_ID) continue;
      m.set(rid, (m.get(rid) ?? 0) + (l.side === 'debit' ? l.amount : -l.amount));
    }
  }
  return m;
}

/** 単一の取り置き目的の現在残高。 */
export function reserveBalance(reserveId: string, entries: JournalEntry[]): number {
  return reserveBalances(entries).get(reserveId) ?? 0;
}
