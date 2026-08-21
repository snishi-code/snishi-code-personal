/*
 * ローン item の wire 不変条件（v14・fail-closed）:
 *  - 返済元（repaymentSourceAccountId）あり ⇔ 計上先（expenseAccountId）の role が負債（双方向）。
 *  - ローン item は完済日（endDate）必須・返済元 ≠ 計上先・返済元は postable。
 *  - 借入の仕訳（loanItemId・loanSettlement なし）はちょうど 1 件・貸方 = 負債・
 *    金額 / 日付が item と完全一致（購入の仕訳 ⑥ と同型）。
 *  - 一括返済（loanItemId + loanSettlement）は 借方 = 負債・貸方 postable・購入日以降・
 *    Σ ≤ 借入総額（過返済拒否）。
 *  - RecurringRule.loan は予約のみ（形式 + 「loan あり ⇒ 源泉負債」。源泉負債の通常ルールは合法）。
 */
import { describe, expect, it } from 'vitest';
import './setup';
import { ledgerExportPackageSchema, monthlyCostItemSchema } from '../src/domain/schema';
import { APP_ID, SCHEMA_VERSION } from '../src/domain/constants';

const accounts = [
  {
    id: 'cash',
    name: '現金',
    type: 'asset',
    role: 'daily-asset',
    archived: false,
    createdAt: 'x',
    updatedAt: 'x',
  },
  {
    id: 'liab',
    name: '家電ローン',
    type: 'liability',
    role: 'other-liability',
    archived: false,
    createdAt: 'x',
    updatedAt: 'x',
  },
  {
    id: 'card',
    name: 'クレカ',
    type: 'liability',
    role: 'payment-liability',
    archived: false,
    createdAt: 'x',
    updatedAt: 'x',
  },
  {
    id: 'food',
    name: '食費',
    type: 'expense',
    role: 'expense-category',
    archived: false,
    createdAt: 'x',
    updatedAt: 'x',
  },
  {
    id: 'adj',
    name: '残高調整費',
    type: 'expense',
    role: 'system-adjustment',
    archived: false,
    createdAt: 'x',
    updatedAt: 'x',
  },
];

const loanItem = {
  id: 'loan1',
  name: '家電ローン',
  amount: 10000,
  startDate: '2026-08-18',
  endDate: '2027-02-18',
  expenseAccountId: 'liab',
  repaymentSourceAccountId: 'cash',
  createdAt: 'x',
  updatedAt: 'x',
};

/** 借入の仕訳（借方 費用 / 貸方 負債・item と金額/日付が完全一致）。 */
function borrowOf(item: Record<string, unknown>, over: Record<string, unknown> = {}) {
  return {
    id: `b-${item.id as string}`,
    date: item.startDate,
    description: item.name,
    kind: 'normal',
    lines: [
      { accountId: 'food', side: 'debit', amount: item.amount },
      { accountId: item.expenseAccountId, side: 'credit', amount: item.amount },
    ],
    metadata: { inputMode: 'expense', loanItemId: item.id },
    createdAt: 'x',
    updatedAt: 'x',
    ...over,
  };
}

/** 一括返済の仕訳（借方 負債 / 貸方 返済元）。 */
function settlementOf(amount: number, over: Record<string, unknown> = {}) {
  return {
    id: `s-${amount}`,
    date: '2026-11-01',
    description: '一括返済',
    kind: 'normal',
    lines: [
      { accountId: 'liab', side: 'debit', amount },
      { accountId: 'cash', side: 'credit', amount },
    ],
    metadata: { inputMode: 'transfer', loanItemId: 'loan1', loanSettlement: true },
    createdAt: 'x',
    updatedAt: 'x',
    ...over,
  };
}

function pkg(over: Record<string, unknown> = {}) {
  return {
    appId: APP_ID,
    schemaVersion: SCHEMA_VERSION,
    ledgerId: 'ledger',
    exportedAt: '2026-06-01T00:00:00.000Z',
    deviceId: 'd',
    revision: 0,
    accounts,
    journalEntries: [borrowOf(loanItem)],
    monthlyCostItems: [loanItem],
    recurringRules: [],
    settings: { ledgerName: '家計簿', currency: 'JPY', displayFractionDigits: 0 },
    ...over,
  };
}

describe('ローン item の item 単体検証', () => {
  it('完済日なしのローン item は invalid（終わらない返済を作らない）', () => {
    expect(monthlyCostItemSchema.safeParse(loanItem).success).toBe(true);
    const noEnd = { ...loanItem } as Record<string, unknown>;
    delete noEnd.endDate;
    expect(monthlyCostItemSchema.safeParse(noEnd).success).toBe(false);
  });
  it('返済元 = 計上先（負債自身）は invalid', () => {
    expect(
      monthlyCostItemSchema.safeParse({ ...loanItem, repaymentSourceAccountId: 'liab' }).success,
    ).toBe(false);
  });
});

describe('ローン item のパッケージ検証（双方向不変条件・監査 #4）', () => {
  it('正しいローン（借入の仕訳 1 件・ミラー一致）は valid', () => {
    expect(ledgerExportPackageSchema.safeParse(pkg()).success).toBe(true);
  });
  it('返済元あり + 計上先が負債でない は invalid', () => {
    const bad = { ...loanItem, expenseAccountId: 'food' };
    const entries = [
      borrowOf(bad, {
        lines: [
          { accountId: 'cash', side: 'debit', amount: bad.amount },
          { accountId: 'food', side: 'credit', amount: bad.amount },
        ],
      }),
    ];
    expect(
      ledgerExportPackageSchema.safeParse(pkg({ monthlyCostItems: [bad], journalEntries: entries }))
        .success,
    ).toBe(false);
  });
  it('計上先が負債 + 返済元なし は invalid（v13 では合法だった形。変換で列挙・作者判断）', () => {
    const bad = { ...loanItem } as Record<string, unknown>;
    delete bad.repaymentSourceAccountId;
    expect(
      ledgerExportPackageSchema.safeParse(
        pkg({ monthlyCostItems: [bad], journalEntries: [borrowOf(loanItem)] }),
      ).success,
    ).toBe(false);
  });
  it('返済元が存在しない・内部集約/残高調整の返済元は invalid', () => {
    expect(
      ledgerExportPackageSchema.safeParse(
        pkg({ monthlyCostItems: [{ ...loanItem, repaymentSourceAccountId: 'ghost' }] }),
      ).success,
    ).toBe(false);
    expect(
      ledgerExportPackageSchema.safeParse(
        pkg({ monthlyCostItems: [{ ...loanItem, repaymentSourceAccountId: 'adj' }] }),
      ).success,
    ).toBe(false);
  });
});

describe('借入の仕訳の 1:1 ミラー（購入の仕訳 ⑥ のローン版）', () => {
  it('借入の仕訳が 0 件・2 件は invalid', () => {
    expect(ledgerExportPackageSchema.safeParse(pkg({ journalEntries: [] })).success).toBe(false);
    expect(
      ledgerExportPackageSchema.safeParse(
        pkg({ journalEntries: [borrowOf(loanItem), borrowOf(loanItem, { id: 'b2' })] }),
      ).success,
    ).toBe(false);
  });
  it('金額・日付のミラー不一致は invalid', () => {
    expect(
      ledgerExportPackageSchema.safeParse(
        pkg({ journalEntries: [borrowOf(loanItem, { date: '2026-08-19' })] }),
      ).success,
    ).toBe(false);
    expect(
      ledgerExportPackageSchema.safeParse(
        pkg({
          journalEntries: [
            borrowOf(loanItem, {
              lines: [
                { accountId: 'food', side: 'debit', amount: 9999 },
                { accountId: 'liab', side: 'credit', amount: 9999 },
              ],
            }),
          ],
        }),
      ).success,
    ).toBe(false);
  });
  it('貸方がローンの負債でない借入の仕訳は invalid', () => {
    expect(
      ledgerExportPackageSchema.safeParse(
        pkg({
          journalEntries: [
            borrowOf(loanItem, {
              lines: [
                { accountId: 'food', side: 'debit', amount: 10000 },
                { accountId: 'card', side: 'credit', amount: 10000 },
              ],
            }),
          ],
        }),
      ).success,
    ).toBe(false);
  });
  it('存在しないローンを指す loanItemId は invalid', () => {
    expect(
      ledgerExportPackageSchema.safeParse(
        pkg({
          journalEntries: [
            borrowOf(loanItem),
            borrowOf(loanItem, { id: 'x', metadata: { loanItemId: 'ghost' } }),
          ],
        }),
      ).success,
    ).toBe(false);
  });
});

describe('一括返済（loanSettlement）の wire 検証', () => {
  it('正しい一括返済（借方 負債 / 貸方 返済元・購入日以降・Σ ≤ 総額）は valid', () => {
    expect(
      ledgerExportPackageSchema.safeParse(
        pkg({ journalEntries: [borrowOf(loanItem), settlementOf(4000)] }),
      ).success,
    ).toBe(true);
  });
  it('Σ 一括返済 > 借入総額（過返済）は invalid', () => {
    expect(
      ledgerExportPackageSchema.safeParse(
        pkg({
          journalEntries: [borrowOf(loanItem), settlementOf(8000), settlementOf(3000)],
        }),
      ).success,
    ).toBe(false);
  });
  it('借方が負債でない・購入日より前・loanItemId なしの loanSettlement は invalid', () => {
    expect(
      ledgerExportPackageSchema.safeParse(
        pkg({
          journalEntries: [
            borrowOf(loanItem),
            settlementOf(1000, {
              lines: [
                { accountId: 'food', side: 'debit', amount: 1000 },
                { accountId: 'cash', side: 'credit', amount: 1000 },
              ],
            }),
          ],
        }),
      ).success,
    ).toBe(false);
    expect(
      ledgerExportPackageSchema.safeParse(
        pkg({ journalEntries: [borrowOf(loanItem), settlementOf(1000, { date: '2026-08-01' })] }),
      ).success,
    ).toBe(false);
    expect(
      ledgerExportPackageSchema.safeParse(
        pkg({
          journalEntries: [
            borrowOf(loanItem),
            settlementOf(1000, { metadata: { loanSettlement: true } }),
          ],
        }),
      ).success,
    ).toBe(false);
  });
});

describe('RecurringRule.loan 予約ブロック（v14 は形式のみ）', () => {
  const rule = {
    id: 'r1',
    name: '車の買い替え',
    amount: 3000000,
    dayOfMonth: 15,
    everyMonths: 120,
    spreadExpenseAccountId: 'food',
    debitAccountId: 'continuing-cost-ledger',
    creditAccountId: 'card',
    startMonth: '2026-09',
    startDate: '2026-08-18',
    createdAt: 'x',
    updatedAt: 'x',
  };
  const ccLedger = {
    id: 'continuing-cost-ledger',
    name: '月割り台帳',
    type: 'asset',
    role: 'continuing-cost-asset',
    archived: false,
    createdAt: 'x',
    updatedAt: 'x',
  };
  function rulePkg(theRule: Record<string, unknown>) {
    return pkg({
      accounts: [...accounts, ccLedger],
      monthlyCostItems: [],
      journalEntries: [],
      recurringRules: [theRule],
    });
  }
  it('loan ブロック付きルール（源泉 = 負債）は valid・形式不正は invalid', () => {
    expect(
      ledgerExportPackageSchema.safeParse(
        rulePkg({ ...rule, loan: { repaymentSourceAccountId: 'cash', repaymentMonths: 60 } }),
      ).success,
    ).toBe(true);
    expect(
      ledgerExportPackageSchema.safeParse(
        rulePkg({ ...rule, loan: { repaymentSourceAccountId: '', repaymentMonths: 60 } }),
      ).success,
    ).toBe(false);
    expect(
      ledgerExportPackageSchema.safeParse(
        rulePkg({ ...rule, loan: { repaymentSourceAccountId: 'cash', repaymentMonths: 0 } }),
      ).success,
    ).toBe(false);
  });
  it('loan ブロックあり + 源泉が負債でない は invalid（逆向きは課さない）', () => {
    expect(
      ledgerExportPackageSchema.safeParse(
        rulePkg({
          ...rule,
          creditAccountId: 'cash',
          loan: { repaymentSourceAccountId: 'cash', repaymentMonths: 60 },
        }),
      ).success,
    ).toBe(false);
    // 源泉 = 負債（クレカ）で loan ブロック無しの通常定期支出は現行どおり合法。
    expect(ledgerExportPackageSchema.safeParse(rulePkg(rule)).success).toBe(true);
  });
});
