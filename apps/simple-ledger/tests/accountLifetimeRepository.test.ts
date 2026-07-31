import { describe, expect, it } from 'vitest';
import {
  catchUpRecurringRules,
  createContinuousCost,
  createRecurringRule,
  loadLedger,
  upsertAccount,
  upsertEntry,
  upsertRecurringRule,
} from '../src/data/repository';
import { buildSimpleEntry } from '../src/domain/entry';
import './setup';

describe('勘定科目の存在期間（保存境界）', () => {
  it('仕訳の初出より後へstartDateを動かせず、最終日より前へendDateを動かせない', async () => {
    const ledger = await loadLedger();
    const cash = ledger.accounts.find((account) => account.name === '預金')!;
    const fixed = ledger.accounts.find((account) => account.name === '固定費')!;
    await upsertAccount({ ...cash, startDate: '2026-01-01' });
    await upsertAccount({ ...fixed, startDate: '2026-01-01' });
    await upsertEntry(
      buildSimpleEntry({
        date: '2026-07-15',
        description: '期間ガード',
        debitAccountId: fixed.id,
        creditAccountId: cash.id,
        amount: 100,
        kind: 'normal',
      }),
    );

    await expect(
      upsertAccount({
        ...(await loadLedger()).accounts.find((a) => a.id === cash.id)!,
        startDate: '2026-07-16',
      }),
    ).rejects.toMatchObject({ code: 'error.account.referenceOutsidePeriod' });
    await expect(
      upsertAccount({
        ...(await loadLedger()).accounts.find((a) => a.id === cash.id)!,
        endDate: '2026-07-14',
        archived: true,
      }),
    ).rejects.toMatchObject({ code: 'error.account.referenceOutsidePeriod' });
  });

  it('仕訳の保存自体も両科目の存在日外なら拒否する', async () => {
    const ledger = await loadLedger();
    const cash = ledger.accounts.find((account) => account.name === '預金')!;
    const fixed = ledger.accounts.find((account) => account.name === '固定費')!;
    await upsertAccount({ ...cash, startDate: '2026-07-01' });
    await upsertAccount({ ...fixed, startDate: '2026-07-01' });

    await expect(
      upsertEntry(
        buildSimpleEntry({
          date: '2026-06-30',
          description: '期間外',
          debitAccountId: fixed.id,
          creditAccountId: cash.id,
          amount: 100,
          kind: 'normal',
        }),
      ),
    ).rejects.toMatchObject({ code: 'error.account.referenceOutsidePeriod' });
  });

  it('itemの有限期間とruleの開区間も参照科目の線分内でなければ保存しない', async () => {
    let ledger = await loadLedger();
    const cash = ledger.accounts.find((account) => account.name === '預金')!;
    const fixed = ledger.accounts.find((account) => account.name === '固定費')!;
    await upsertAccount({
      ...fixed,
      startDate: '2026-01-01',
      endDate: '2026-07-31',
      archived: true,
    });

    await expect(
      createContinuousCost({
        name: '期間外へ伸びる年払い',
        amount: 12_000,
        startDate: '2026-07-01',
        endDate: '2026-08-31',
        expenseAccountId: fixed.id,
        creditAccountId: cash.id,
      }),
    ).rejects.toMatchObject({ code: 'error.account.referenceOutsidePeriod' });

    ledger = await loadLedger();
    const archivedFixed = ledger.accounts.find((account) => account.id === fixed.id)!;
    await expect(
      createRecurringRule({
        name: '終了点のある費用ルール',
        amount: 1_000,
        dayOfMonth: 1,
        debitAccountId: archivedFixed.id,
        creditAccountId: cash.id,
        startMonth: '2026-07',
        startDate: '2026-07-01',
      }),
    ).rejects.toMatchObject({ code: 'error.account.referenceOutsidePeriod' });

    await expect(
      createRecurringRule({
        name: '有限でもitemは年末まで残る',
        amount: 12_000,
        dayOfMonth: 20,
        everyMonths: 12,
        debitAccountId: archivedFixed.id,
        creditAccountId: cash.id,
        startMonth: '2026-01',
        startDate: '2026-01-01',
        endDate: '2026-02-01',
      }),
    ).rejects.toMatchObject({ code: 'error.account.referenceOutsidePeriod' });
  });

  it('費用ルール編集はitem被覆で抑止せず、カーソル後の次回日から新しい科目を使う', async () => {
    let ledger = await loadLedger();
    const cash = ledger.accounts.find((account) => account.name === '預金')!;
    const fixed = ledger.accounts.find((account) => account.name === '固定費')!;
    const rule = await createRecurringRule({
      name: '年払いから月払い',
      amount: 12_000,
      dayOfMonth: 1,
      everyMonths: 12,
      debitAccountId: fixed.id,
      creditAccountId: cash.id,
      startMonth: '2026-01',
      startDate: '2026-01-01',
    });
    expect(await catchUpRecurringRules('2026-01-15')).toBe(1);

    const futureCash = {
      id: 'future-rule-cash',
      name: '未来の支払口座',
      type: 'asset' as const,
      role: 'daily-asset' as const,
      archived: false,
      createdAt: '2027-01-01T00:00:00.000Z',
      updatedAt: '2027-01-01T00:00:00.000Z',
    };
    await upsertAccount(futureCash);

    ledger = await loadLedger();
    const stored = ledger.recurringRules.find((candidate) => candidate.id === rule.id)!;
    await upsertRecurringRule({
      ...stored,
      everyMonths: 1,
      creditAccountId: futureCash.id,
    });

    ledger = await loadLedger();
    expect(ledger.accounts.find((account) => account.id === futureCash.id)?.startDate).toBe(
      '2026-02-01',
    );
    expect(await catchUpRecurringRules('2026-12-31')).toBe(11);
    expect(await catchUpRecurringRules('2027-01-01')).toBe(1);

    ledger = await loadLedger();
    const nextPurchase = ledger.journalEntries.find(
      (entry) => entry.id === `rec-${rule.id}-2027-01`,
    );
    expect(nextPurchase?.lines.find((line) => line.side === 'credit')?.accountId).toBe(
      futureCash.id,
    );
    expect(ledger.monthlyCostItems.some((item) => item.id === `ccr-${rule.id}-2027-01`)).toBe(true);
  });
});
