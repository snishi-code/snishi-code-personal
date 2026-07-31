/*
 * ルール由来 item の期間は、定期ルールが次に科目を参照する日を決める境界でもある。
 *
 * endDate なしの item は将来をすべて覆うため、その間はルールの次回参照が存在しない。
 * item を有限化・アーカイブ・削除すると次回参照が復活するので、その保存操作では
 * ルールの借方・貸方・費用行き先の存在期間を改めて検証しなければならない。
 */
import { describe, expect, it } from 'vitest';
import './setup';
import {
  archiveMonthlyCost,
  catchUpRecurringRules,
  createRecurringRule,
  deleteMonthlyCost,
  loadLedger,
  upsertAccount,
  upsertMonthlyCost,
} from '../src/data/repository';
import { buildExportPackage } from '../src/data/exportImport';
import { ledgerExportPackageSchema } from '../src/domain/schema';
import type { Account, MonthlyCostItem } from '../src/domain/types';

async function accountByName(name: string): Promise<Account> {
  const ledger = await loadLedger();
  const account = ledger.accounts.find((candidate) => candidate.name === name);
  if (!account) throw new Error(`seed に ${name} がない`);
  return account;
}

async function seedEndedRuleSourceCoveredByOpenItem(): Promise<{
  item: MonthlyCostItem;
  source: Account;
}> {
  const source = await accountByName('給与');
  const expense = await accountByName('固定費');
  const rule = await createRecurringRule({
    name: '期間境界を検証する年払い',
    amount: 1_200,
    dayOfMonth: 1,
    everyMonths: 12,
    debitAccountId: expense.id,
    creditAccountId: source.id,
    startMonth: '2025-01',
  });
  expect(await catchUpRecurringRules('2025-01-31')).toBe(1);

  let ledger = await loadLedger();
  const generated = ledger.monthlyCostItems.find(
    (candidate) => candidate.id === `ccr-${rule.id}-2025-01`,
  )!;
  const openItem = { ...generated };
  delete openItem.endDate;
  await upsertMonthlyCost(openItem);

  ledger = await loadLedger();
  const extendedSource = ledger.accounts.find((candidate) => candidate.id === source.id)!;
  await upsertAccount({
    ...extendedSource,
    archived: true,
    endDate: '2025-12-31',
    updatedAt: '2025-12-31T00:00:00.000Z',
  });

  ledger = await loadLedger();
  const savedItem = ledger.monthlyCostItems.find((candidate) => candidate.id === generated.id)!;
  const savedSource = ledger.accounts.find((candidate) => candidate.id === source.id)!;
  expect(savedItem.endDate).toBeUndefined();
  expect(savedSource).toMatchObject({ archived: true, endDate: '2025-12-31' });
  // endDate なしの item が将来を覆う間は次回ルール参照がなく、この状態自体は正当。
  expect(ledgerExportPackageSchema.safeParse(buildExportPackage(ledger)).success).toBe(true);
  return { item: savedItem, source: savedSource };
}

describe('ルール由来 item の変更後も科目の存在期間を包含する', () => {
  it('upsertMonthlyCostで有限化して終了済み科目への次回参照を復活させない', async () => {
    const { item, source } = await seedEndedRuleSourceCoveredByOpenItem();

    await expect(
      upsertMonthlyCost({
        ...item,
        endDate: '2025-12-31',
      }),
    ).rejects.toMatchObject({
      code: 'error.account.referenceOutsidePeriod',
    });

    const after = await loadLedger();
    expect(after.monthlyCostItems.find((candidate) => candidate.id === item.id)?.endDate).toBe(
      undefined,
    );
    expect(after.accounts.find((candidate) => candidate.id === source.id)?.endDate).toBe(
      '2025-12-31',
    );
  });

  it('archiveMonthlyCostで有限化して終了済み科目への次回参照を復活させない', async () => {
    const { item } = await seedEndedRuleSourceCoveredByOpenItem();

    await expect(
      archiveMonthlyCost({
        id: item.id,
        endDate: '2025-12-31',
      }),
    ).rejects.toMatchObject({
      code: 'error.account.referenceOutsidePeriod',
    });

    expect(
      (await loadLedger()).monthlyCostItems.find((candidate) => candidate.id === item.id)?.endDate,
    ).toBeUndefined();
  });

  it('deleteMonthlyCostで終了済み科目への次回参照を復活させない', async () => {
    const { item } = await seedEndedRuleSourceCoveredByOpenItem();

    await expect(deleteMonthlyCost(item.id)).rejects.toMatchObject({
      code: 'error.account.referenceOutsidePeriod',
    });

    expect(
      (await loadLedger()).monthlyCostItems.some((candidate) => candidate.id === item.id),
    ).toBe(true);
  });
});
