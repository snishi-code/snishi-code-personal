import { describe, expect, it } from 'vitest';
import {
  catchUpRecurringRules,
  createContinuousCost,
  createOpening,
  createRecurringRule,
  loadLedger,
  upsertAccount,
  upsertEntry,
  upsertRecurringRule,
} from '../src/data/repository';
import { buildSimpleEntry } from '../src/domain/entry';
import { CONTINUOUS_COST_LEDGER_ACCOUNT_ID } from '../src/domain/constants';
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
    // §A 案1（2026-08-11）: 開始日未設定の科目は過去へ開いた線分なので、参照による
    // 暗黙開始日の明示化（旧 extendImplicitAccountStart）は行われず undefined のまま。
    expect(
      ledger.accounts.find((account) => account.id === futureCash.id)?.startDate,
    ).toBeUndefined();
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

  // ── §A 案1（2026-08-11）: 開始日未設定 = 過去へ開いた線分。暗黙開始日（createdAt 代用）の廃止 ──

  it('開始日未設定の科目へ「新→古」の順で保存でき、startDate は書かれない', async () => {
    // 旧仕様では最初の遡及保存が暗黙開始日を明示化するため、新しい日付を先に保存すると
    // 古い行が期間外参照で拒否された（CSV 分割適用の順序依存の根）。新仕様では順序不問。
    const ledger = await loadLedger();
    const cash = ledger.accounts.find((account) => account.name === '預金')!;
    const fixed = ledger.accounts.find((account) => account.name === '固定費')!;
    expect(cash.startDate).toBeUndefined();

    for (const date of ['2026-07-15', '2019-01-05']) {
      await upsertEntry(
        buildSimpleEntry({
          date,
          description: `新→古 ${date}`,
          debitAccountId: fixed.id,
          creditAccountId: cash.id,
          amount: 100,
          kind: 'normal',
        }),
      );
    }

    const after = await loadLedger();
    expect(
      after.journalEntries.filter((entry) => entry.description.startsWith('新→古')),
    ).toHaveLength(2);
    expect(after.accounts.find((account) => account.id === cash.id)?.startDate).toBeUndefined();
    expect(after.accounts.find((account) => account.id === fixed.id)?.startDate).toBeUndefined();
  });

  it('createdAt より古い仕訳を持つ開始日未設定科目の改名が保存できる（作者データ形状）', async () => {
    // 旧仕様では改名保存の参照検証が暗黙開始日（createdAt）で下限を引くため、
    // createdAt より古い仕訳（取込 JSON 由来）を持つ科目は編集不能だった。
    const ledger = await loadLedger();
    const cash = ledger.accounts.find((account) => account.name === '預金')!;
    const fixed = ledger.accounts.find((account) => account.name === '固定費')!;
    await upsertEntry(
      buildSimpleEntry({
        date: '2019-11-01',
        description: '過去の実データ',
        debitAccountId: fixed.id,
        creditAccountId: cash.id,
        amount: 500,
        kind: 'normal',
      }),
    );

    await upsertAccount({ ...cash, name: '銀行口座', updatedAt: new Date().toISOString() });

    const saved = (await loadLedger()).accounts.find((account) => account.id === cash.id)!;
    expect(saved.name).toBe('銀行口座');
    expect(saved.startDate).toBeUndefined();
  });

  it('明示 startDate を空欄へ戻すと削除される（`startDate: undefined` をキー付きで渡す導線）', async () => {
    const ledger = await loadLedger();
    const cash = ledger.accounts.find((account) => account.name === '預金')!;
    await upsertAccount({ ...cash, startDate: '2026-01-01' });
    expect((await loadLedger()).accounts.find((account) => account.id === cash.id)?.startDate).toBe(
      '2026-01-01',
    );

    // AccountSheet の空欄保存と同じ形: キーを明示して undefined を渡す（キー省略は「据え置き」）。
    const current = (await loadLedger()).accounts.find((account) => account.id === cash.id)!;
    await upsertAccount({ ...current, startDate: undefined, updatedAt: new Date().toISOString() });

    const cleared = (await loadLedger()).accounts.find((account) => account.id === cash.id)!;
    expect(cleared.startDate).toBeUndefined();
    expect(Object.prototype.hasOwnProperty.call(cleared, 'startDate')).toBe(false);
  });

  it('初期残高付きの新規科目にも開始日は書かれない（それより古い仕訳を後から保存できる）', async () => {
    // §A 案1 作者決定3 の適用漏れ回帰（監査 2026-08-12）。同じ createOpeningsUnlocked でも
    // newAccount 分岐だけ startDate: input.date の直書きが残り、「今日、口座を初期残高付きで
    // 作る」という最も自然な操作が error.account.referenceOutsidePeriod を再発させていた。
    await createOpening({
      newAccount: { name: '新しい口座', type: 'asset', role: 'daily-asset' },
      amount: 100_000,
      date: '2026-05-01',
    });
    let ledger = await loadLedger();
    const created = ledger.accounts.find((account) => account.name === '新しい口座')!;
    expect(created.startDate).toBeUndefined();
    expect(Object.prototype.hasOwnProperty.call(created, 'startDate')).toBe(false);

    // 開始日が無い = 過去へ開いた線分。初期残高の日付より古い仕訳も保存できる。
    const fixed = ledger.accounts.find((account) => account.name === '固定費')!;
    await upsertEntry(
      buildSimpleEntry({
        date: '2020-01-01',
        description: '初期残高より古い実データ',
        debitAccountId: fixed.id,
        creditAccountId: created.id,
        amount: 500,
        kind: 'normal',
      }),
    );
    ledger = await loadLedger();
    expect(
      ledger.journalEntries.some((entry) => entry.description === '初期残高より古い実データ'),
    ).toBe(true);
    expect(ledger.accounts.find((account) => account.id === created.id)?.startDate).toBeUndefined();
  });

  it('system 科目（継続コスト台帳）の開始点は必要な最古日まで自動延長される（不変）', async () => {
    let ledger = await loadLedger();
    const cash = ledger.accounts.find((account) => account.name === '預金')!;
    const fixed = ledger.accounts.find((account) => account.name === '固定費')!;
    await createContinuousCost({
      name: '後から登録',
      amount: 12_000,
      startDate: '2026-05-01',
      expenseAccountId: fixed.id,
      creditAccountId: cash.id,
    });
    ledger = await loadLedger();
    expect(
      ledger.accounts.find((account) => account.id === CONTINUOUS_COST_LEDGER_ACCOUNT_ID)
        ?.startDate,
    ).toBe('2026-05-01');

    await createContinuousCost({
      name: '先に始まっていた',
      amount: 24_000,
      startDate: '2025-01-15',
      expenseAccountId: fixed.id,
      creditAccountId: cash.id,
    });
    ledger = await loadLedger();
    expect(
      ledger.accounts.find((account) => account.id === CONTINUOUS_COST_LEDGER_ACCOUNT_ID)
        ?.startDate,
    ).toBe('2025-01-15');
  });
});
