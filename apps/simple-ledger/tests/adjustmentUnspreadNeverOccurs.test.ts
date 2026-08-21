/*
 * v13.14 §5-3: 壊れ pin（按分不能 = unspread）の発生経路ゼロの固定。
 *
 * 現行の保存境界操作（補正の作成/編集/削除・科目の削除/区分変更/アーカイブ・
 * export → import）をどう並べても `unspreadAdjustments` が空のままであることを
 * 代表列で固定する。v13.8-H の再発防止を「復旧表示」でなく「不発生」で保証する
 * （表示側 AdjustmentUnspreadNotice は最終防衛線 = 出たらバグ）。
 */
import { describe, expect, it } from 'vitest';
import './setup';
import {
  archiveAccount,
  createAdjustment,
  deleteAccount,
  deleteAdjustment,
  loadLedger,
  resetAll,
  updateAdjustment,
  upsertAccount,
} from '../src/data/repository';
import { exportToJsonText, importFromJsonText } from '../src/data/exportImport';
import { buildSimpleEntry } from '../src/domain/entry';
import { reportEntriesResultForAsOf } from '../src/domain/reportEntries';
import { LedgerError } from '../src/domain/errors';
import { todayLocal } from '../src/util/time';
import type { Account } from '../src/domain/types';

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

/** どの断面でも unspread が 1 本も無いこと（発生経路ゼロの検査点）。 */
async function assertNoUnspread(): Promise<void> {
  const ledger = await loadLedger();
  expect(reportEntriesResultForAsOf(ledger, todayLocal()).unspreadAdjustments).toEqual([]);
}

describe('壊れ pin の発生経路ゼロ（v13.14 §5-3・代表列）', () => {
  it('補正 CRUD・削除試行・区分変更試行・アーカイブ・import をどう並べても unspread は空のまま', async () => {
    const seeded = await loadLedger();
    const bank = seeded.accounts.find((a) => a.name === '預金')!;
    await upsertAccount(assetAccount('acc-a', '口座A'));
    await upsertAccount(assetAccount('acc-b', '口座B'));

    // 補正の作成・編集（pin の CRUD）。
    const pin1 = await createAdjustment({
      accountId: 'acc-a',
      date: '2025-06-01',
      actualBalance: 5000,
    });
    await assertNoUnspread();
    await updateAdjustment({
      id: pin1!.id,
      accountId: 'acc-a',
      date: '2025-07-01',
      actualBalance: 4000,
    });
    await assertNoUnspread();
    const pin2 = await createAdjustment({
      accountId: 'acc-b',
      date: '2025-06-15',
      actualBalance: 2000,
    });
    expect(pin2).not.toBeNull();
    await assertNoUnspread();

    // 参照先の削除・区分変更はガードが拒否する（拒否後も何も変わらない）。
    const counterpartId = pin1!.metadata!.adjustment!.counterpartAccountId;
    expect((await caught(deleteAccount('acc-a'))).code).toBe('error.account.deleteInUseAdjustment');
    expect((await caught(deleteAccount(counterpartId))).code).toBe(
      'error.account.deleteInUseAdjustment',
    );
    const ledgerNow = await loadLedger();
    const counterpart = ledgerNow.accounts.find((a) => a.id === counterpartId)!;
    expect(
      (await caught(upsertAccount({ ...counterpart, type: 'expense', role: 'expense-category' })))
        .code,
    ).toBe('error.account.typeLocked');
    await assertNoUnspread();

    // アーカイブは塞がない（相手科目・対象科目とも）。pin は按分されたまま。
    await archiveAccount(counterpartId);
    await assertNoUnspread();
    await archiveAccount(
      'acc-b',
      buildSimpleEntry({
        date: todayLocal(),
        description: '口座B 残高移動',
        debitAccountId: bank.id,
        creditAccountId: 'acc-b',
        amount: 2000,
        metadata: { inputMode: 'transfer' },
      }),
    );
    await assertNoUnspread();

    // export → 全削除 → import（wire 検証を通る往復で pin の整合は保たれる）。
    const exported = exportToJsonText(await loadLedger());
    await resetAll();
    const outcome = await importFromJsonText(exported);
    expect(outcome.kind).toBe('ok');
    await assertNoUnspread();

    // 補正を削除すれば参照が解け、対象科目の削除が通る。残る pin も壊れない。
    await deleteAdjustment(pin1!.id);
    await deleteAccount('acc-a');
    await assertNoUnspread();
  });
});
