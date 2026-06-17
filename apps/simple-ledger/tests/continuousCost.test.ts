/*
 * 継続コスト（資産経由モデル）の仮想展開エンジンの不変条件を固定する。
 *  - funding が recognition より先行し、対象資産残高 >= 0（= 未認識残高）。
 *  - 認識合計は amount に一致（端数配分）。upTo で未来を切る。
 *  - recurring は周期ごとに資産化→全額認識で閉じる（積み上がらない）。
 *  - 継続コスト対象でない item / 支払い元欠落は展開しない。
 */
import { describe, expect, it } from 'vitest';
import './setup';
import {
  continuousCostEntriesForItem,
  entriesWithContinuousCost,
  isContinuingCostItem,
} from '../src/domain/continuousCost';
import { accountBalance, deriveBalanceSheet } from '../src/domain/accounting';
import { DEFAULT_MANAGEMENT_SCOPE_ID } from '../src/domain/constants';
import type { Account, MonthlyCostItem } from '../src/domain/types';

function acc(id: string, role: Account['role'], type: Account['type']): Account {
  return { id, name: id, type, role, archived: false, createdAt: 'x', updatedAt: 'x' };
}

const accounts: Account[] = [
  acc('card', 'payment-liability', 'liability'),
  acc('youtube', 'continuing-cost-asset', 'asset'),
  acc('washer', 'continuing-cost-asset', 'asset'),
  acc('fun', 'expense-category', 'expense'),
  acc('fixedcost', 'expense-category', 'expense'),
  acc('car', 'fixed-asset', 'asset'),
];
const byId = new Map(accounts.map((a) => [a.id, a] as const));

function item(over: Partial<MonthlyCostItem>): MonthlyCostItem {
  return {
    id: 'yt',
    name: 'YouTube',
    managementScopeId: DEFAULT_MANAGEMENT_SCOPE_ID,
    kind: 'prepaid-service',
    amount: 12000,
    costMonths: 12,
    startMonth: '2031-01',
    expenseAccountId: 'fun',
    paymentSourceAccountId: 'card',
    recognitionCreditAccountId: 'youtube',
    status: 'active',
    createdAt: 'x',
    updatedAt: 'x',
    ...over,
  };
}

describe('continuousCost 仮想展開', () => {
  it('対象判定: continuing-cost-asset を指すときだけ対象', () => {
    expect(isContinuingCostItem(item({}), byId)).toBe(true);
    expect(isContinuingCostItem(item({ recognitionCreditAccountId: 'car' }), byId)).toBe(false);
    expect(isContinuingCostItem(item({ recognitionCreditAccountId: undefined }), byId)).toBe(false);
  });

  it('年払い: funding 1 件 + 認識 12 件、認識合計 = amount、funding・認識とも月初', () => {
    const es = continuousCostEntriesForItem(item({}), byId, '2031-12-31');
    const funding = es.filter((e) => e.metadata?.ccKind === 'funding');
    const recog = es.filter((e) => e.metadata?.ccKind === 'recognition');
    expect(funding).toHaveLength(1);
    expect(funding[0]?.date).toBe('2031-01-01');
    expect(recog).toHaveLength(12);
    expect(recog[0]?.date).toBe('2031-01-01');
    const recogTotal = recog.reduce(
      (s, e) => s + (e.lines.find((l) => l.side === 'debit')?.amount ?? 0),
      0,
    );
    expect(recogTotal).toBe(12000);
  });

  it('未認識残高: 12,000払って3か月認識済みなら対象資産 = 9,000（BS asOf で確認）', () => {
    const es = continuousCostEntriesForItem(item({}), byId, '2031-03-31');
    // funding(2031-01-01) + 認識3件(1/1,2/1,3/1)。4月以降は upTo(03-31) で切れる。
    expect(es.filter((e) => e.metadata?.ccKind === 'recognition')).toHaveLength(3);
    expect(accountBalance('youtube', 'asset', es)).toBe(9000);
    // funding は recognition より先行 → 各時点で資産は非負。
    expect(accountBalance('youtube', 'asset', es)).toBeGreaterThanOrEqual(0);
    // 費用は3か月分のみ。
    expect(accountBalance('fun', 'expense', es)).toBe(3000);
    // 支払い元（カード負債）は funding 全額。
    expect(accountBalance('card', 'liability', es)).toBe(12000);
  });

  it('upTo を funding 前にすると何も出ない', () => {
    expect(continuousCostEntriesForItem(item({}), byId, '2030-12-31')).toHaveLength(0);
  });

  it('recurring: 各サイクルが資産化→全額認識で閉じ、年末に残高 0（積み上がらない）', () => {
    const recurring = item({ repeatEveryMonths: 12 });
    const es = continuousCostEntriesForItem(recurring, byId, '2032-12-31');
    expect(es.filter((e) => e.metadata?.ccKind === 'funding')).toHaveLength(2); // 2031,2032
    // 2 サイクル分: funding 24,000 − 認識 24,000 = 0。
    expect(accountBalance('youtube', 'asset', es)).toBe(0);
  });

  it('one-time（償却のみ・洗濯機84か月）: funding 1 件のみ・周期更新しない', () => {
    const washer = item({
      id: 'w',
      name: '洗濯機',
      amount: 240000,
      costMonths: 84,
      startMonth: '2031-01',
      expenseAccountId: 'fixedcost',
      recognitionCreditAccountId: 'washer',
    });
    const es = continuousCostEntriesForItem(washer, byId, '2100-12-31');
    expect(es.filter((e) => e.metadata?.ccKind === 'funding')).toHaveLength(1);
    expect(es.filter((e) => e.metadata?.ccKind === 'recognition')).toHaveLength(84);
    // 全認識後は残高 0。
    expect(accountBalance('washer', 'asset', es)).toBe(0);
  });

  it('支払い元欠落 / 非対象 は展開しない', () => {
    expect(
      continuousCostEntriesForItem(item({ paymentSourceAccountId: undefined }), byId, '2031-12-31'),
    ).toHaveLength(0);
    expect(
      continuousCostEntriesForItem(item({ recognitionCreditAccountId: 'car' }), byId, '2031-12-31'),
    ).toHaveLength(0);
  });

  it('一時停止/終了（paused/ended）は status では過去を消さず、endMonth までで未来を止める', () => {
    // status だけでは [] にしない（過去保持）。endMonth で停止する。
    const paused = item({ status: 'paused', endMonth: '2031-02' });
    const es = continuousCostEntriesForItem(paused, byId, '2031-12-31');
    // 認識は endMonth(2031-02) まで = 2 件（1月・2月）、未来は止まる。
    expect(es.filter((e) => e.metadata?.ccKind === 'recognition')).toHaveLength(2);
    // 過去は保持: 資産 = 資産化 12,000 − 認識 2,000 = 10,000。
    expect(accountBalance('youtube', 'asset', es)).toBe(10000);
  });

  it('entriesWithContinuousCost は実仕訳 + 仮想仕訳の連結', () => {
    const real = [
      {
        id: 'r1',
        date: '2031-01-05',
        description: 'x',
        kind: 'normal' as const,
        managementScopeId: DEFAULT_MANAGEMENT_SCOPE_ID,
        lines: [
          { accountId: 'fun', side: 'debit' as const, amount: 500 },
          { accountId: 'card', side: 'credit' as const, amount: 500 },
        ],
        createdAt: 'x',
        updatedAt: 'x',
      },
    ];
    const merged = entriesWithContinuousCost(real, [item({})], accounts, '2031-01-31');
    expect(merged.some((e) => e.id === 'r1')).toBe(true);
    expect(merged.some((e) => e.metadata?.virtual)).toBe(true);
    // BS は実仕訳 + 仮想の合算（deriveBalanceSheet は entries を素直に集計する）。
    const bs = deriveBalanceSheet(accounts, merged, '2031-01-31');
    // youtube = funding 12000 − 認識 1000 = 11000。
    const yt = bs.assets.find((a) => a.account.id === 'youtube');
    expect(yt?.balance).toBe(11000);
  });
});
