/*
 * 「未記入」科目（振り分け前の受け皿）の判定。
 *  - 判定は名前の trim 後完全一致だけ（専用フラグ・role を持たない = 改名すれば外れる）。
 *  - 仕訳側の判定は借方・貸方どちらに居ても真になる。
 *  - seed に「未記入」（費用・expense-category）が含まれる。
 */
import { describe, expect, it } from 'vitest';
import {
  UNFILLED_ACCOUNT_NAME,
  entryHasUnfilledAccount,
  isUnfilledAccountName,
} from '../src/domain/accountNames';
import { defaultAccounts } from '../src/data/seed';
import type { Account, JournalEntry } from '../src/domain/types';

function account(id: string, name: string): Account {
  return {
    id,
    name,
    type: 'expense',
    role: 'expense-category',
    archived: false,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
}

function entry(debitId: string, creditId: string): JournalEntry {
  return {
    id: 'e1',
    date: '2026-08-20',
    description: 'テスト仕訳',
    kind: 'normal',
    lines: [
      { accountId: debitId, side: 'debit', amount: 1000 },
      { accountId: creditId, side: 'credit', amount: 1000 },
    ],
    createdAt: '2026-08-20T00:00:00.000Z',
    updatedAt: '2026-08-20T00:00:00.000Z',
  };
}

describe('isUnfilledAccountName（trim 後の完全一致）', () => {
  it('「未記入」と、前後空白付きの「未記入」だけが真', () => {
    expect(isUnfilledAccountName(UNFILLED_ACCOUNT_NAME)).toBe(true);
    expect(isUnfilledAccountName(' 未記入 ')).toBe(true);
    expect(isUnfilledAccountName('　未記入')).toBe(true); // 全角空白も trim 対象
  });

  it('部分一致・別名・空文字は偽（改名すれば未記入扱いから外れる = 仕様）', () => {
    expect(isUnfilledAccountName('未記入分')).toBe(false);
    expect(isUnfilledAccountName('未 記 入')).toBe(false);
    expect(isUnfilledAccountName('食費')).toBe(false);
    expect(isUnfilledAccountName('')).toBe(false);
  });
});

describe('entryHasUnfilledAccount（借方・貸方どちらでも真）', () => {
  const unfilled = account('acc-unfilled', '未記入');
  const food = account('acc-food', '食費');
  const other = account('acc-other', 'その他支出');
  const map = new Map([unfilled, food, other].map((a) => [a.id, a]));

  it('借方が未記入なら真', () => {
    expect(entryHasUnfilledAccount(entry(unfilled.id, food.id), map)).toBe(true);
  });

  it('貸方が未記入でも真', () => {
    expect(entryHasUnfilledAccount(entry(food.id, unfilled.id), map)).toBe(true);
  });

  it('未記入を含まなければ偽・科目が引けない行だけでも偽', () => {
    expect(entryHasUnfilledAccount(entry(food.id, other.id), map)).toBe(false);
    expect(entryHasUnfilledAccount(entry('missing-a', 'missing-b'), map)).toBe(false);
  });
});

describe('seed の「未記入」科目', () => {
  it('費用（expense-category）として 1 つだけ含まれる', () => {
    const unfilled = defaultAccounts().filter((a) => isUnfilledAccountName(a.name));
    expect(unfilled).toHaveLength(1);
    expect(unfilled[0]!.type).toBe('expense');
    expect(unfilled[0]!.role).toBe('expense-category');
  });
});
