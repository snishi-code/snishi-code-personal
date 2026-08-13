/*
 * マイナス残高の許容:
 *  - createOpening / updateOpening は符号付き金額を受け、貸借の向きで表す（明細金額は常に正）。
 *  - 補正（createAdjustment）は負の実残高を受けられる。
 *  - 符号付き金額テキストの整形/解釈（amountText）。
 */
import { describe, expect, it } from 'vitest';
import './setup';
import { createAdjustment, createOpening, loadLedger, updateOpening } from '../src/data/repository';
import { accountBalance } from '../src/domain/accounting';
import { parseAmountToMinor, sanitizeSignedAmountText } from '../src/ui/amountText';
import { LedgerError } from '../src/domain/errors';

async function cashAccount() {
  const ledger = await loadLedger();
  const cash = ledger.accounts.find((a) => a.name === '現金');
  if (!cash) throw new Error('seed に現金がない');
  return cash;
}

describe('マイナスの初期残高（opening）', () => {
  it('負の金額は貸借を反転して登録され、残高がマイナスになる', async () => {
    const cash = await cashAccount();
    const entry = await createOpening({ accountId: cash.id, amount: -3000, date: '2026-07-23' });

    const ledger = await loadLedger();
    const equity = ledger.accounts.find((a) => a.role === 'equity')!;
    // 反転: 借方 初期残高 / 貸方 現金（明細金額は正）。
    expect(entry.lines).toEqual([
      { accountId: equity.id, side: 'debit', amount: 3000 },
      { accountId: cash.id, side: 'credit', amount: 3000 },
    ]);
    expect(accountBalance(cash.id, 'asset', ledger.journalEntries)).toBe(-3000);
  });

  it('updateOpening は符号で向きを組み直せる（負→正）', async () => {
    const cash = await cashAccount();
    const entry = await createOpening({ accountId: cash.id, amount: -3000, date: '2026-07-23' });
    await updateOpening({ id: entry.id, amount: 5000, date: '2026-07-23' });

    const ledger = await loadLedger();
    expect(accountBalance(cash.id, 'asset', ledger.journalEntries)).toBe(5000);
    const updated = ledger.journalEntries.find((e) => e.id === entry.id)!;
    const cashLine = updated.lines.find((l) => l.accountId === cash.id)!;
    expect(cashLine.side).toBe('debit');
    expect(cashLine.amount).toBe(5000);
  });

  it('0 は不可', async () => {
    const cash = await cashAccount();
    await expect(
      createOpening({ accountId: cash.id, amount: 0, date: '2026-07-23' }),
    ).rejects.toThrow(LedgerError);
  });
});

describe('負の実残高の補正', () => {
  it('実残高 -2000 の補正で残高がマイナスへピン留めされる', async () => {
    const cash = await cashAccount();
    const entry = await createAdjustment({
      kind: 'unknown-balance',
      accountId: cash.id,
      date: '2026-07-23',
      actualBalance: -2000,
    });
    expect(entry).not.toBeNull();
    expect(entry!.metadata?.adjustment?.delta).toBe(-2000);

    const ledger = await loadLedger();
    expect(accountBalance(cash.id, 'asset', ledger.journalEntries)).toBe(-2000);
  });
});

describe('amountText（符号付き金額テキスト・v11 = minor 変換）', () => {
  it('sanitize: 先頭の - を 1 つだけ許す（digits=0 は小数点以降を捨てる）', () => {
    expect(sanitizeSignedAmountText('-3000', 0)).toBe('-3000');
    expect(sanitizeSignedAmountText('3-000', 0)).toBe('3000');
    expect(sanitizeSignedAmountText('--12a', 0)).toBe('-12');
    expect(sanitizeSignedAmountText('abc', 0)).toBe('');
    expect(sanitizeSignedAmountText('-12.34', 2)).toBe('-12.34');
    expect(sanitizeSignedAmountText('-12.34', 0)).toBe('-12');
  });

  it('parse: 空と "-" のみは null（テキスト → minor・float 経由なし）', () => {
    expect(parseAmountToMinor('')).toBeNull();
    expect(parseAmountToMinor('-')).toBeNull();
    expect(parseAmountToMinor('-3000')).toBe(-300000);
    expect(parseAmountToMinor('42')).toBe(4200);
    expect(parseAmountToMinor('19.99')).toBe(1999);
    expect(parseAmountToMinor('12.')).toBe(1200);
    expect(parseAmountToMinor('.5')).toBe(50);
    expect(parseAmountToMinor('-0.5')).toBe(-50);
  });
});
