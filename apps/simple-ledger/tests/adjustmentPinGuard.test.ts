/*
 * v13.14: 補正 pin の参照ガード（metadata 正本のハード参照化）。
 *
 * pin の正本は metadata.adjustment（仕訳の行から対象科目を推測しない）。参照モデル
 * （accountRefs.adjustmentRefs）が metadata 側の 2 参照（対象科目・記録相手）を数える
 * ことで、削除・区分変更・使用中バッジが同じ 1 本で追従することを保存境界で固定する。
 * lines と metadata が食い違う pin は wire からは作れないため、putRecord で直接構築する。
 */
import { describe, expect, it } from 'vitest';
import './setup';
import {
  createAdjustment,
  deleteAccount,
  deleteAdjustment,
  loadLedger,
  upsertAccount,
} from '../src/data/repository';
import { putRecord, STORE } from '../src/data/db';
import { referencedAccountIds } from '../src/domain/accountRefs';
import { LedgerError } from '../src/domain/errors';
import type { Account, JournalEntry } from '../src/domain/types';

const CREATED_AT = '2025-01-01T00:00:00.000Z';

function assetAccount(id: string, name: string): Account {
  return {
    id,
    name,
    type: 'asset',
    role: 'daily-asset',
    archived: false,
    startDate: '2025-01-01',
    createdAt: CREATED_AT,
    updatedAt: CREATED_AT,
  };
}

async function caught(p: Promise<unknown>): Promise<LedgerError> {
  try {
    await p;
  } catch (e) {
    if (e instanceof LedgerError) return e;
    throw e;
  }
  throw new Error('拒否されるはずの操作が成功した');
}

/** lines は現金/費用を指し、metadata は別の 2 科目を指す破損 pin（wire からは作れない）。 */
async function injectMismatchedPin(targetId: string, counterpartId: string): Promise<void> {
  const ledger = await loadLedger();
  const cash = ledger.accounts.find((a) => a.name === '現金')!;
  const expense = ledger.accounts.find((a) => a.role === 'expense-category')!;
  const pin: JournalEntry = {
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
        accountId: targetId,
        expectedBalance: 0,
        actualBalance: 100,
        delta: 100,
        counterpartAccountId: counterpartId,
      },
    },
    createdAt: CREATED_AT,
    updatedAt: CREATED_AT,
  };
  await putRecord(STORE.journalEntries, pin);
}

describe('補正 pin の削除ガード（metadata 正本・v13.14 §5-1）', () => {
  it('lines に載らない metadata 側の対象科目・記録相手の削除を理由付きで拒否する', async () => {
    await loadLedger();
    await upsertAccount(assetAccount('adj-x', '対象X'));
    await upsertAccount(assetAccount('adj-y', '相手Y'));
    await injectMismatchedPin('adj-x', 'adj-y');

    const target = await caught(deleteAccount('adj-x'));
    expect(target.code).toBe('error.account.deleteInUseAdjustment');
    const counterpart = await caught(deleteAccount('adj-y'));
    expect(counterpart.code).toBe('error.account.deleteInUseAdjustment');
  });

  it('metadata だけが参照する科目は区分・役割も変更できない（同じ 1 本で追従）', async () => {
    await loadLedger();
    await upsertAccount(assetAccount('adj-x', '対象X'));
    // role 変更の確認は負債側で行う（v13.18 で investment-asset が消え、資産にはユーザーが
    // 選べる別 role が無くなったため。ガードの正本は role 全般に効く）。
    await upsertAccount({
      ...assetAccount('adj-y', '相手Y'),
      type: 'liability',
      role: 'payment-liability',
    });
    await injectMismatchedPin('adj-x', 'adj-y');

    const typeChange = await caught(
      upsertAccount({
        ...assetAccount('adj-x', '対象X'),
        type: 'liability',
        role: 'other-liability',
      }),
    );
    expect(typeChange.code).toBe('error.account.typeLocked');
    const roleChange = await caught(
      upsertAccount({
        ...assetAccount('adj-y', '相手Y'),
        type: 'liability',
        role: 'other-liability',
      }),
    );
    expect(roleChange.code).toBe('error.account.roleLocked');
  });

  it('metadata だけが参照する科目も「使用中」集合に入る（科目一覧バッジの正本・§5-4）', async () => {
    await loadLedger();
    await upsertAccount(assetAccount('adj-x', '対象X'));
    await upsertAccount(assetAccount('adj-y', '相手Y'));
    await injectMismatchedPin('adj-x', 'adj-y');

    const ledger = await loadLedger();
    const used = referencedAccountIds({
      entries: ledger.journalEntries,
      monthlyCostItems: ledger.monthlyCostItems,
      recurringRules: ledger.recurringRules,
    });
    expect(used.has('adj-x')).toBe(true);
    expect(used.has('adj-y')).toBe(true);
  });
});

describe('補正 pin の削除ガード（実経路 = createAdjustment）', () => {
  it('対象科目・自動生成された相手科目とも削除拒否 → 補正削除で解除される', async () => {
    await loadLedger();
    await upsertAccount(assetAccount('adj-z', '対象Z'));
    const pin = await createAdjustment({
      accountId: 'adj-z',
      date: '2025-06-01',
      actualBalance: 5000,
    });
    expect(pin).not.toBeNull();
    const counterpartId = pin!.metadata!.adjustment!.counterpartAccountId;

    // pin が存在する限り、対象も相手（残高調整科目）も削除できない。文言は補正への導線。
    expect((await caught(deleteAccount('adj-z'))).code).toBe('error.account.deleteInUseAdjustment');
    expect((await caught(deleteAccount(counterpartId))).code).toBe(
      'error.account.deleteInUseAdjustment',
    );

    // 補正を削除すれば参照が消え、対象科目は削除できる（導線が成立している）。
    await deleteAdjustment(pin!.id);
    await expect(deleteAccount('adj-z')).resolves.toBeUndefined();
  });
});
