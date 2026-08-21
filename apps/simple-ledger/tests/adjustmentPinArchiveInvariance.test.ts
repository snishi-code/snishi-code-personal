/*
 * v13.14 §5-2: アーカイブ（終了）は原則現状維持 — pin の参照ガードが効いても、
 * アーカイブ系の既存挙動は変わらないことを固定する。
 *
 * アーカイブは科目を byId から消さない（archived でも参照解決できる）ため pin は
 * 壊れない。ガード（adjustmentRefs）は削除・区分変更だけに効き、アーカイブを
 * 新たに塞がないことが不変条件。
 */
import { describe, expect, it } from 'vitest';
import './setup';
import {
  archiveAccount,
  createAdjustment,
  loadLedger,
  upsertAccount,
} from '../src/data/repository';
import { buildSimpleEntry } from '../src/domain/entry';
import { reportEntriesResultForAsOf } from '../src/domain/reportEntries';
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

describe('補正 pin とアーカイブの不変（v13.14 §5-2）', () => {
  it('記録相手科目（残高調整）は pin があっても従来どおりアーカイブでき、pin は按分されたまま', async () => {
    await loadLedger();
    await upsertAccount(assetAccount('adj-z', '対象Z'));
    const pin = await createAdjustment({
      accountId: 'adj-z',
      date: '2025-06-01',
      actualBalance: 5000,
    });
    const counterpartId = pin!.metadata!.adjustment!.counterpartAccountId;

    // 収入（残高調整益）は振替なしで終了できる従来挙動のまま。
    await expect(archiveAccount(counterpartId)).resolves.toBeUndefined();

    const ledger = await loadLedger();
    expect(ledger.accounts.find((a) => a.id === counterpartId)?.archived).toBe(true);
    // アーカイブは byId から消えない = pin は按分不能（unspread）にならない（カナリア）。
    const result = reportEntriesResultForAsOf(ledger, todayLocal());
    expect(result.unspreadAdjustments).toEqual([]);
  });

  it('対象科目も残高 0 への振替を添えれば従来どおりアーカイブできる', async () => {
    const seeded = await loadLedger();
    const bank = seeded.accounts.find((a) => a.name === '預金')!;
    await upsertAccount(assetAccount('adj-z', '対象Z'));
    await createAdjustment({
      accountId: 'adj-z',
      date: '2025-06-01',
      actualBalance: 5000,
    });

    // 按分スライスで実残高 5000。全額を預金へ振り替えて終了する（既存の導線のまま）。
    await expect(
      archiveAccount(
        'adj-z',
        buildSimpleEntry({
          date: todayLocal(),
          description: '対象Z 残高移動',
          debitAccountId: bank.id,
          creditAccountId: 'adj-z',
          amount: 5000,
          metadata: { inputMode: 'transfer' },
        }),
      ),
    ).resolves.toBeUndefined();

    const ledger = await loadLedger();
    expect(ledger.accounts.find((a) => a.id === 'adj-z')?.archived).toBe(true);
    // アーカイブ後も pin は保存されたまま・按分されたまま（壊れ pin は発生しない）。
    expect(ledger.journalEntries.some((e) => e.metadata?.adjustment !== undefined)).toBe(true);
    const result = reportEntriesResultForAsOf(ledger, todayLocal());
    expect(result.unspreadAdjustments).toEqual([]);
  });
});
