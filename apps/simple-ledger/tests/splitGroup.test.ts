/*
 * 諸口 = グループ ID 方式の保存・集計規約（v13.16）。
 *
 *  - 保存形 = 通常の 2 行仕訳 N 本 + 同一 groupId（1 本の多行仕訳ではない）
 *  - **groupId は集計に一切効かない**（BS/PL/導出行が「単発 N 回」「groupId 全剥がし」と完全一致）
 *  - グループに不変条件を持たせない（件数検証なし・1 行に減ったら普通の仕訳に退化）
 *  - createEntries が groupId を落とさない・upsertEntry（個別編集）が既存 groupId を保持する・
 *    通常経路からの groupId 持ち込みはしない（グループ化は保存の瞬間だけ）
 *  - export → import（wire）往復で groupId が保持される
 */
import { describe, expect, it } from 'vitest';
import { createEntries, loadLedger, upsertEntry, deleteEntry } from '../src/data/repository';
import { buildSimpleEntry } from '../src/domain/entry';
import { newId } from '../src/domain/ids';
import { reportEntriesForAsOf } from '../src/domain/reportEntries';
import { deriveBalanceSheet, deriveProfitAndLoss } from '../src/domain/accounting';
import { buildExportPackage } from '../src/data/exportImport';
import { ledgerExportPackageSchema } from '../src/domain/schema';
import type { Ledger } from '../src/domain/types';
import './setup';

async function seed() {
  const ledger = await loadLedger();
  const cash = ledger.accounts.find((a) => a.name === '現金')!;
  const bank = ledger.accounts.find((a) => a.name === '預金')!;
  const card = ledger.accounts.find((a) => a.role === 'payment-liability')!;
  const expense = ledger.accounts.find((a) => a.role === 'expense-category')!;
  return { cash, bank, card, expense };
}

/** スマホ 10 万を 3 源泉へ按分（借方 通信費 / 貸方 各源泉 の 3 本）を保存する。 */
async function saveSplit(): Promise<string> {
  const { cash, bank, card, expense } = await seed();
  const groupId = newId();
  await createEntries(
    [
      { creditAccountId: cash.id, amount: 30000 },
      { creditAccountId: bank.id, amount: 25000 },
      { creditAccountId: card.id, amount: 45000 },
    ].map((row) =>
      buildSimpleEntry({
        date: '2026-08-01',
        description: 'スマホ',
        debitAccountId: expense.id,
        creditAccountId: row.creditAccountId,
        amount: row.amount,
        kind: 'normal',
        metadata: { inputMode: 'expense' },
        groupId,
      }),
    ),
  );
  return groupId;
}

/** 集計スナップショット（BS/PL・導出行込み）。groupId の有無で 1 bit も変わらないことの比較用。 */
function aggregate(ledger: Ledger) {
  const rows = reportEntriesForAsOf(ledger, '2026-12-31');
  return {
    bs: deriveBalanceSheet(ledger.accounts, rows, '2026-12-31'),
    pl: deriveProfitAndLoss(ledger.accounts, rows, { from: '2026-01-01', to: '2026-12-31' }),
  };
}

describe('諸口（グループ ID 方式・v13.16）', () => {
  it('createEntries は groupId を落とさず N 本へ同値を保存する', async () => {
    const groupId = await saveSplit();
    const ledger = await loadLedger();
    expect(ledger.journalEntries).toHaveLength(3);
    expect(ledger.journalEntries.every((e) => e.groupId === groupId)).toBe(true);
    // 合計はちょうど一致（30,000 + 25,000 + 45,000 = 100,000）。
    const total = ledger.journalEntries.reduce(
      (sum, e) => sum + (e.lines.find((l) => l.side === 'debit')?.amount ?? 0),
      0,
    );
    expect(total).toBe(100000);
  });

  it('集計不変: groupId を全部剥がした台帳と全集計が完全一致する（groupId は集計に効かない）', async () => {
    await saveSplit();
    const ledger = await loadLedger();
    const stripped: Ledger = {
      ...ledger,
      journalEntries: ledger.journalEntries.map((e) => {
        const rest = { ...e };
        delete rest.groupId;
        return rest;
      }),
    };
    expect(aggregate(stripped)).toEqual(aggregate(ledger));
  });

  it('個別編集（upsertEntry）は既存 groupId を保持し、通常経路からの持ち込みは無視する', async () => {
    const groupId = await saveSplit();
    const before = await loadLedger();
    const target = before.journalEntries.find(
      (e) => e.lines.find((l) => l.side === 'credit')?.amount === 30000,
    )!;
    // 金額を編集しても groupId は剥がれない（他の行の groupId も不変）。
    await upsertEntry({
      ...target,
      lines: target.lines.map((l) => ({ ...l, amount: 31000 })),
    });
    const after = await loadLedger();
    expect(after.journalEntries.every((e) => e.groupId === groupId)).toBe(true);
    // 通常経路の新規保存に groupId を持ち込んでも保存境界が付けない（退化と対称）。
    const { cash, expense } = await seed();
    await upsertEntry(
      buildSimpleEntry({
        date: '2026-08-02',
        description: '単発',
        debitAccountId: expense.id,
        creditAccountId: cash.id,
        amount: 500,
        kind: 'normal',
        groupId: 'smuggled-group',
      }),
    );
    const single = (await loadLedger()).journalEntries.find((e) => e.description === '単発')!;
    expect(single.groupId).toBeUndefined();
  });

  it('1 行に減っても普通の仕訳として残る（グループに件数の不変条件を持たせない）', async () => {
    const groupId = await saveSplit();
    const entries = (await loadLedger()).journalEntries;
    await deleteEntry(entries[0]!.id);
    await deleteEntry(entries[1]!.id);
    const remaining = (await loadLedger()).journalEntries;
    expect(remaining).toHaveLength(1);
    // groupId は目印として残るだけ（剥がしもしない・検証もしない）。
    expect(remaining[0]!.groupId).toBe(groupId);
    // wire も件数の相互参照を検証しない = 1 本でも通る。
    const pkg = buildExportPackage(await loadLedger());
    expect(ledgerExportPackageSchema.safeParse(pkg).success).toBe(true);
  });

  it('export → import（wire）往復で groupId が保持される', async () => {
    const groupId = await saveSplit();
    const pkg = buildExportPackage(await loadLedger());
    const parsed = ledgerExportPackageSchema.safeParse(pkg);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.journalEntries.every((e) => e.groupId === groupId)).toBe(true);
    }
  });
});
