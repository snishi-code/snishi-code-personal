/*
 * ルールの切り替え・終了と、配分中 item の清算（v13・switchRecurringRule）。
 *
 * 切り替え = 「同じ位置から別の線」（作者確定 2026-08-16）: 旧線分の endDate と後継の
 * startDate をともに切り替え日に置く（半開区間 = 当日の起票は後継）。位相 anchor
 * （startMonth）と科目・月割りの意図は旧線分から引き継ぐ。
 *
 * 清算 = 「生まれた線は自分の寿命を持つ」の唯一の調整口: 選ばれた item の endDate だけを
 * ルール側の settlements で上書きし、回収は実仕訳（回収の振替）として保存する。
 * ガードはすべて fail-closed（系譜外・導出しない月・範囲外の日付・行き先違いの回収先）。
 */
import { describe, expect, it } from 'vitest';
import './setup';
import {
  createRecurringRule,
  loadLedger,
  switchRecurringRule,
  type RecurringRuleInput,
} from '../src/data/repository';
import { LedgerError } from '../src/domain/errors';
import { CONTINUOUS_COST_LEDGER_ACCOUNT_ID } from '../src/domain/constants';
import { deriveRecurringOutputs } from '../src/domain/recurring';
import { ruleItemId } from '../src/domain/recurringIds';
import {
  continuousCostEntriesForItem,
  recoveredAmountsByItem,
  spreadTotalOf,
} from '../src/domain/continuousCost';
import type { JournalEntry, MonthlyCostItem, RecurringRule } from '../src/domain/types';

/** 台帳経由（月割り）の毎月 2 日・3,200 のルール。8/01 から存在する。 */
async function seedRule(overrides: Partial<RecurringRuleInput> = {}): Promise<RecurringRule> {
  const ledger = await loadLedger();
  const bank = ledger.accounts.find((account) => account.name === '預金')!;
  const fixed = ledger.accounts.find((account) => account.name === '固定費')!;
  return createRecurringRule({
    name: 'Claude',
    amount: 320_000,
    dayOfMonth: 2,
    everyMonths: 1,
    debitAccountId: fixed.id,
    creditAccountId: bank.id,
    startMonth: '2026-08',
    startDate: '2026-08-01',
    ...overrides,
  });
}

async function accountIdByName(name: string): Promise<string> {
  return (await loadLedger()).accounts.find((account) => account.name === name)!.id;
}

/** 失敗の「理由」まで確かめる（fail-closed の検証は code の一致まで見る）。 */
async function errorCodeOf(run: () => Promise<unknown>): Promise<string> {
  try {
    await run();
  } catch (e) {
    return e instanceof LedgerError ? e.code : `unexpected: ${String(e)}`;
  }
  return 'no-error';
}

/** 導出の起票（日付と金額）を日付順に並べた比較用の文字列。 */
function postings(
  rules: RecurringRule[],
  accounts: Parameters<typeof deriveRecurringOutputs>[1],
  asOf: string,
): string[] {
  return deriveRecurringOutputs(rules, accounts, asOf)
    .entries.map((entry) => `${entry.date}:${entry.lines[0]!.amount}`)
    .sort();
}

function recoveryEntriesOf(entries: JournalEntry[]): JournalEntry[] {
  return entries.filter((entry) => entry.metadata?.monthlyCostRecovery === true);
}

function debitOf(entry: JournalEntry): { accountId: string; amount: number } {
  const line = entry.lines.find((l) => l.side === 'debit')!;
  return { accountId: line.accountId, amount: line.amount };
}

describe('切り替え（後継あり）', () => {
  it('旧線分は切り替え日で閉じ、後継が同じ位相の別線分として同じ日から始まる', async () => {
    const rule = await seedRule();

    await switchRecurringRule({
      ruleId: rule.id,
      effectiveDate: '2026-08-10',
      successor: { amount: 3_520_000, dayOfMonth: 10, everyMonths: 1 },
    });

    const after = await loadLedger();
    expect(after.recurringRules).toHaveLength(2);
    const predecessor = after.recurringRules.find((r) => r.id === rule.id)!;
    const successor = after.recurringRules.find((r) => r.id !== rule.id)!;
    expect(predecessor.endDate).toBe('2026-08-10');
    expect(successor.startDate).toBe('2026-08-10');
    expect(successor.endDate).toBeUndefined();
    expect(successor.splitFromRuleId).toBe(rule.id);
    // 位相 anchor（起票周期の基準月）と科目・月割りの意図は旧線分から引き継ぐ。
    expect(successor.startMonth).toBe(rule.startMonth);
    expect(successor.creditAccountId).toBe(rule.creditAccountId);
    expect(successor.spreadExpenseAccountId).toBe(rule.spreadExpenseAccountId);
    expect(successor.amount).toBe(3_520_000);
    expect(successor.dayOfMonth).toBe(10);
    expect(successor.everyMonths).toBe(1);
  });

  it('導出境界は半開区間: 切り替え日より前は旧金額、当日以後は新金額・新起票日', async () => {
    const rule = await seedRule();

    await switchRecurringRule({
      ruleId: rule.id,
      effectiveDate: '2026-08-10',
      successor: { amount: 3_520_000, dayOfMonth: 10, everyMonths: 1 },
    });

    const after = await loadLedger();
    expect(postings(after.recurringRules, after.accounts, '2026-10-31')).toEqual([
      '2026-08-02:320000',
      '2026-08-10:3520000',
      '2026-09-10:3520000',
      '2026-10-10:3520000',
    ]);
  });
});

describe('終了のみ（successor = null）', () => {
  it('終了点だけが入り、後継は作られない', async () => {
    const rule = await seedRule();

    await switchRecurringRule({ ruleId: rule.id, effectiveDate: '2026-08-10', successor: null });

    const after = await loadLedger();
    expect(after.recurringRules).toHaveLength(1);
    expect(after.recurringRules[0]!.id).toBe(rule.id);
    expect(after.recurringRules[0]!.endDate).toBe('2026-08-10');
    // 8/02 の 1 回だけが残る（以後は存在しないので導出も止まる）。
    expect(postings(after.recurringRules, after.accounts, '2026-12-31')).toEqual([
      '2026-08-02:320000',
    ]);
  });
});

describe('清算（settlements）', () => {
  async function settledLedger(recoveryAccountName = '預金'): Promise<{
    rule: RecurringRule;
    recoveryAccountId: string;
    item: MonthlyCostItem;
    entries: JournalEntry[];
  }> {
    const rule = await seedRule();
    const recoveryAccountId = await accountIdByName(recoveryAccountName);
    await switchRecurringRule({
      ruleId: rule.id,
      effectiveDate: '2026-08-10',
      successor: { amount: 3_520_000, dayOfMonth: 10, everyMonths: 1 },
      settlements: [
        {
          ruleId: rule.id,
          month: '2026-08',
          recoveries: [{ destinationAccountId: recoveryAccountId, amount: 247_800 }],
        },
      ],
    });
    const after = await loadLedger();
    const derived = deriveRecurringOutputs(after.recurringRules, after.accounts, '2026-08-31');
    return {
      rule,
      recoveryAccountId,
      item: derived.items.find((i) => i.id === ruleItemId(rule.id, '2026-08'))!,
      entries: after.journalEntries,
    };
  }

  it('対象 item の導出 endDate が切り替え日になる（保存形は settlements の 1 行だけ）', async () => {
    const { rule, item } = await settledLedger();

    expect(item.startDate).toBe('2026-08-02');
    expect(item.endDate).toBe('2026-08-10');
    const stored = (await loadLedger()).recurringRules.find((r) => r.id === rule.id)!;
    expect(stored.settlements).toEqual([{ month: '2026-08', endDate: '2026-08-10' }]);
  });

  it('回収の振替が実仕訳として保存される（ccr- 参照・monthlyCostRecovery・日付 = 切り替え日）', async () => {
    const { rule, recoveryAccountId, entries } = await settledLedger();

    const recoveries = recoveryEntriesOf(entries);
    expect(recoveries).toHaveLength(1);
    const recovery = recoveries[0]!;
    expect(recovery.date).toBe('2026-08-10');
    expect(recovery.metadata?.monthlyCostId).toBe(ruleItemId(rule.id, '2026-08'));
    expect(debitOf(recovery)).toEqual({ accountId: recoveryAccountId, amount: 247_800 });
    expect(recovery.lines.find((l) => l.side === 'credit')).toEqual({
      accountId: CONTINUOUS_COST_LEDGER_ACCOUNT_ID,
      side: 'credit',
      amount: 247_800,
    });
  });

  it('回収は spreadTotal へ反映され、残りは短くなった期間で費用化される', async () => {
    const { item, entries } = await settledLedger();

    const spreadTotal = spreadTotalOf(item, recoveredAmountsByItem(entries));
    expect(spreadTotal).toBe(320_000 - 247_800);
    // [8/02, 8/10] は同日通過が 0 回 = 終了日に残り全額 1 本（monthlyCost.ts の規則）。
    expect(
      continuousCostEntriesForItem(item, '2026-12-31', spreadTotal).map(
        (entry) => `${entry.date}:${entry.lines[0]!.amount}`,
      ),
    ).toEqual(['2026-08-10:72200']);
  });

  it('回収 0 本（回収なしで終える）でも item の終了日だけは動く', async () => {
    const rule = await seedRule();

    await switchRecurringRule({
      ruleId: rule.id,
      effectiveDate: '2026-08-10',
      successor: null,
      settlements: [{ ruleId: rule.id, month: '2026-08' }],
    });

    const after = await loadLedger();
    const derived = deriveRecurringOutputs(after.recurringRules, after.accounts, '2026-08-31');
    expect(derived.items.find((i) => i.id === ruleItemId(rule.id, '2026-08'))?.endDate).toBe(
      '2026-08-10',
    );
    expect(recoveryEntriesOf(after.journalEntries)).toHaveLength(0);
  });
});

describe('fail-closed', () => {
  it('系譜外のルールの月は清算できない', async () => {
    const rule = await seedRule();
    const other = await seedRule({ name: '別系譜' });

    expect(
      await errorCodeOf(() =>
        switchRecurringRule({
          ruleId: rule.id,
          effectiveDate: '2026-08-10',
          successor: null,
          settlements: [{ ruleId: other.id, month: '2026-08' }],
        }),
      ),
    ).toBe('error.recurring.settlementInvalid');
    // 1 トランザクション: 拒否されたら旧線分の終了点も入らない。
    expect(
      (await loadLedger()).recurringRules.find((r) => r.id === rule.id)?.endDate,
    ).toBeUndefined();
  });

  it('そのルールが導出しない月は清算できない', async () => {
    const rule = await seedRule();

    // 起票開始月より前（span < 0）。
    expect(
      await errorCodeOf(() =>
        switchRecurringRule({
          ruleId: rule.id,
          effectiveDate: '2026-08-10',
          successor: null,
          settlements: [{ ruleId: rule.id, month: '2026-07' }],
        }),
      ),
    ).toBe('error.recurring.settlementInvalid');
  });

  it('周期の位相から外れた月は清算できない', async () => {
    const rule = await seedRule({ everyMonths: 2 });

    // 2 か月ごと（8, 10, 12 月）の位相に 9 月は無い。
    expect(
      await errorCodeOf(() =>
        switchRecurringRule({
          ruleId: rule.id,
          effectiveDate: '2026-08-10',
          successor: null,
          settlements: [{ ruleId: rule.id, month: '2026-09' }],
        }),
      ),
    ).toBe('error.recurring.settlementInvalid');
  });

  it('切り替え日が [起票日, 既定終了日] の外なら清算できない', async () => {
    const rule = await seedRule();

    // 2026-08 の item は [8/02, 9/02]。9/05 はその外側。
    expect(
      await errorCodeOf(() =>
        switchRecurringRule({
          ruleId: rule.id,
          effectiveDate: '2026-09-05',
          successor: null,
          settlements: [{ ruleId: rule.id, month: '2026-08' }],
        }),
      ),
    ).toBe('error.recurring.settlementInvalid');
  });

  it('費用カテゴリの回収先は item の計上先と一致していなければならない', async () => {
    const rule = await seedRule();
    const otherExpense = await accountIdByName('変動費');

    expect(
      await errorCodeOf(() =>
        switchRecurringRule({
          ruleId: rule.id,
          effectiveDate: '2026-08-10',
          successor: null,
          settlements: [
            {
              ruleId: rule.id,
              month: '2026-08',
              recoveries: [{ destinationAccountId: otherExpense, amount: 100_000 }],
            },
          ],
        }),
      ),
    ).toBe('error.monthlyCost.recoveryDestination');
    expect(recoveryEntriesOf((await loadLedger()).journalEntries)).toHaveLength(0);
  });

  it('旧線分が 1 日も存在しない境界は切り替えではない', async () => {
    const rule = await seedRule();

    expect(
      await errorCodeOf(() =>
        switchRecurringRule({
          ruleId: rule.id,
          // 存在開始日と同じ日 = 旧線分の長さが 0。
          effectiveDate: '2026-08-01',
          successor: { amount: 3_520_000, dayOfMonth: 10, everyMonths: 1 },
        }),
      ),
    ).toBe('error.recurring.periodInvalid');
    expect((await loadLedger()).recurringRules).toHaveLength(1);
  });
});

describe('実ユーズ（Claude のプラン切り替え）', () => {
  it('8/10 に 35,200・毎月 10 日へ切り替え、8/02 の持ち物を 2,478 回収して終える', async () => {
    const rule = await seedRule();
    const bank = await accountIdByName('預金');

    await switchRecurringRule({
      ruleId: rule.id,
      effectiveDate: '2026-08-10',
      successor: { amount: 3_520_000, dayOfMonth: 10, everyMonths: 1 },
      settlements: [
        {
          ruleId: rule.id,
          month: '2026-08',
          recoveries: [{ destinationAccountId: bank, amount: 247_800 }],
        },
      ],
    });

    const after = await loadLedger();
    // 同じ 8 月に旧プランの 3,200（8/02）と新プランの 35,200（8/10）が両方立つ。
    expect(postings(after.recurringRules, after.accounts, '2026-08-31')).toEqual([
      '2026-08-02:320000',
      '2026-08-10:3520000',
    ]);
    const derived = deriveRecurringOutputs(after.recurringRules, after.accounts, '2026-08-31');
    const successor = after.recurringRules.find((r) => r.id !== rule.id)!;
    expect(
      derived.items.map((item) => `${item.startDate}〜${item.endDate}:${item.amount}`).sort(),
    ).toEqual(['2026-08-02〜2026-08-10:320000', '2026-08-10〜2026-09-10:3520000']);
    expect(derived.items.some((item) => item.id === ruleItemId(successor.id, '2026-08'))).toBe(
      true,
    );
    // 回収の振替は切り替え日の 1 本だけ（旧 item を指す）。
    const recoveries = recoveryEntriesOf(after.journalEntries);
    expect(recoveries).toHaveLength(1);
    expect(recoveries[0]!.date).toBe('2026-08-10');
    expect(recoveries[0]!.metadata?.monthlyCostId).toBe(ruleItemId(rule.id, '2026-08'));
  });
});
