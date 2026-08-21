/*
 * mutation 検証（v13.14 §5-1）。
 *
 * 変異 = adjustmentRefs（pin の metadata 参照）を外し、参照モデルを v13.14 導入前
 * （lines / item / rule のみ）へ戻す。この世界では metadata だけが参照する科目を
 * 削除でき、直後に按分不能（unspread）の壊れ pin が発生する——本体テスト
 * （adjustmentPinGuard）の削除拒否が adjustmentRefs に依存していることの固定。
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('../src/domain/accountRefs', async () => {
  const actual = await vi.importActual<typeof import('../src/domain/accountRefs')>(
    '../src/domain/accountRefs',
  );
  type Collections = import('../src/domain/accountRefs').AccountRefCollections;
  return {
    ...actual,
    // 変異: pin の metadata 参照を数えない。
    adjustmentRefs: () => [],
    // 変異: v13.14 導入前の参照判定（lines 走査 + 継続コスト + 定期ルール）を再現する。
    isAccountReferenced: (id: string, c: Collections) =>
      c.entries.some((e) => e.lines.some((l) => l.accountId === id)) ||
      c.monthlyCostItems.some((m) =>
        [m.expenseAccountId, m.repaymentSourceAccountId].includes(id),
      ) ||
      c.recurringRules.some((r) =>
        [r.debitAccountId, r.creditAccountId, r.spreadExpenseAccountId].includes(id),
      ),
  };
});

const { deleteAccount, loadLedger, upsertAccount } = await import('../src/data/repository');
const { putRecord, STORE } = await import('../src/data/db');
const { adjustmentSpread, isAdjustmentEntry } = await import('../src/domain/adjustmentSpread');
await import('./setup');

const CREATED_AT = '2025-01-01T00:00:00.000Z';

describe('mutation: adjustmentRefs を外すと壊れ pin の発生経路が開く', () => {
  it('metadata だけが参照する対象科目を削除でき、pin が unspread になる', async () => {
    const seeded = await loadLedger();
    const cash = seeded.accounts.find((a) => a.name === '現金')!;
    const expense = seeded.accounts.find((a) => a.role === 'expense-category')!;
    await upsertAccount({
      id: 'adj-x',
      name: '対象X',
      type: 'asset',
      role: 'daily-asset',
      archived: false,
      startDate: '2025-01-01',
      createdAt: CREATED_AT,
      updatedAt: CREATED_AT,
    });
    await putRecord(STORE.journalEntries, {
      id: 'pin-mismatch',
      date: '2025-06-01',
      description: '補正（破損データ）',
      kind: 'normal',
      lines: [
        { accountId: cash.id, side: 'debit', amount: 100 },
        { accountId: expense.id, side: 'credit', amount: 100 },
      ],
      metadata: {
        adjustment: {
          accountId: 'adj-x',
          expectedBalance: 0,
          actualBalance: 100,
          delta: 100,
          counterpartAccountId: cash.id,
        },
      },
      createdAt: CREATED_AT,
      updatedAt: CREATED_AT,
    });

    // 変異した参照モデルは metadata を見ないため、削除が通ってしまう。
    await expect(deleteAccount('adj-x')).resolves.toBeUndefined();

    // 直後の導出で pin は按分不能 = 壊れ pin がその場で発生している。
    const ledger = await loadLedger();
    const pins = ledger.journalEntries.filter(isAdjustmentEntry);
    const { unspread } = adjustmentSpread(ledger.accounts, [], pins);
    expect(unspread.map((e) => e.id)).toEqual(['pin-mismatch']);
  });
});
