/*
 * 貼り付け一括登録の保存境界（v13.10・repository.createEntries）:
 *  - 全行を単一 tx で保存し、1 行でも通らなければ 1 件も書かない（fail-closed）。
 *  - upsertEntry の通常経路と同じ検証（由来メタ拒否・構造/参照検証）を全行に適用する。
 *  - 新規専用: 既存 ID・バッチ内重複 ID は拒否する（編集は upsertEntry のみ）。
 */
import { describe, expect, it } from 'vitest';
import { createEntries, loadLedger } from '../src/data/repository';
import { buildSimpleEntry } from '../src/domain/entry';
import type { SimpleEntryInput } from '../src/domain/entry';
import './setup';

async function seed() {
  const ledger = await loadLedger();
  const cash = ledger.accounts.find((a) => a.name === '現金')!;
  const expense = ledger.accounts.find((a) => a.role === 'expense-category')!;
  const card = ledger.accounts.find((a) => a.role === 'payment-liability')!;
  return { cash, expense, card };
}

function input(
  partial: Partial<SimpleEntryInput> & Pick<SimpleEntryInput, 'debitAccountId' | 'creditAccountId'>,
): SimpleEntryInput {
  return { date: '2026-08-19', description: '貼り付け', amount: 115500, ...partial };
}

describe('createEntries（貼り付け一括登録の保存境界）', () => {
  it('複数行を一括保存する', async () => {
    const { cash, expense, card } = await seed();
    await createEntries([
      buildSimpleEntry(input({ debitAccountId: expense.id, creditAccountId: card.id })),
      buildSimpleEntry(
        input({ debitAccountId: expense.id, creditAccountId: cash.id, amount: 80000 }),
      ),
    ]);
    const ledger = await loadLedger();
    expect(ledger.journalEntries).toHaveLength(2);
    expect(ledger.journalEntries.every((entry) => entry.kind === 'normal')).toBe(true);
  });

  it('1 行でも不正（未知科目）なら 1 件も書かない（原子性）', async () => {
    const { cash, expense } = await seed();
    await expect(
      createEntries([
        buildSimpleEntry(input({ debitAccountId: expense.id, creditAccountId: cash.id })),
        buildSimpleEntry(input({ debitAccountId: 'no-such-account', creditAccountId: cash.id })),
      ]),
    ).rejects.toMatchObject({ code: 'error.entry.unknownAccount' });
    expect((await loadLedger()).journalEntries).toHaveLength(0);
  });

  it('既存 ID・バッチ内重複 ID は拒否する（新規専用）', async () => {
    const { cash, expense } = await seed();
    const entry = buildSimpleEntry(input({ debitAccountId: expense.id, creditAccountId: cash.id }));
    await createEntries([entry]);
    await expect(createEntries([entry])).rejects.toMatchObject({
      code: 'error.entry.invalidStructure',
    });
    const twin = buildSimpleEntry(input({ debitAccountId: expense.id, creditAccountId: cash.id }));
    await expect(createEntries([{ ...twin }, { ...twin }])).rejects.toMatchObject({
      code: 'error.entry.invalidStructure',
    });
    expect((await loadLedger()).journalEntries).toHaveLength(1);
  });

  it('由来メタ（補正・ルール・継続コスト）の持ち込みは拒否する', async () => {
    const { cash, expense } = await seed();
    const base = input({ debitAccountId: expense.id, creditAccountId: cash.id });
    await expect(
      createEntries([
        buildSimpleEntry({
          ...base,
          metadata: {
            adjustment: {
              accountId: cash.id,
              expectedBalance: 0,
              actualBalance: 115500,
              delta: 115500,
              counterpartAccountId: expense.id,
            },
          },
        }),
      ]),
    ).rejects.toMatchObject({ code: 'error.entry.adjustment' });
    await expect(
      createEntries([buildSimpleEntry({ ...base, metadata: { recurringRuleId: 'r1' } })]),
    ).rejects.toMatchObject({ code: 'error.recurring.invalidStructure' });
    await expect(
      createEntries([buildSimpleEntry({ ...base, metadata: { monthlyCostId: 'm1' } })]),
    ).rejects.toMatchObject({ code: 'error.entry.monthlyCost' });
    expect((await loadLedger()).journalEntries).toHaveLength(0);
  });

  it('空配列は何もしない', async () => {
    await createEntries([]);
    expect((await loadLedger()).journalEntries).toHaveLength(0);
  });
});
