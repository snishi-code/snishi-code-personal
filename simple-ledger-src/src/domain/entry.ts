/*
 * MVP の仕訳ヘルパ: 「1 借方・1 貸方・同額」の仕訳を組み立てる。
 * 内部表現は常に複式（debit/credit の 2 行）。将来の複合仕訳に備えて lines 配列のまま持つ。
 */
import { newId } from './ids';
import type { JournalEntry, JournalEntryKind } from './types';
import { nowIso } from '../util/time';

export interface SimpleEntryInput {
  date: string;
  description: string;
  debitAccountId: string;
  creditAccountId: string;
  amount: number;
  memo?: string;
  kind?: JournalEntryKind;
}

export type EntryValidationError =
  | 'date-required'
  | 'description-required'
  | 'debit-required'
  | 'credit-required'
  | 'same-account'
  | 'amount-invalid';

/** 入力を検証する。問題が無ければ空配列。 */
export function validateSimpleEntry(input: Partial<SimpleEntryInput>): EntryValidationError[] {
  const errors: EntryValidationError[] = [];
  if (!input.date) errors.push('date-required');
  if (!input.description || input.description.trim() === '') errors.push('description-required');
  if (!input.debitAccountId) errors.push('debit-required');
  if (!input.creditAccountId) errors.push('credit-required');
  if (
    input.debitAccountId &&
    input.creditAccountId &&
    input.debitAccountId === input.creditAccountId
  ) {
    errors.push('same-account');
  }
  if (input.amount === undefined || !Number.isInteger(input.amount) || input.amount <= 0) {
    errors.push('amount-invalid');
  }
  return errors;
}

/** 既存仕訳を編集するとき、id/createdAt を引き継ぐ。新規なら省略。 */
export function buildSimpleEntry(
  input: SimpleEntryInput,
  existing?: Pick<JournalEntry, 'id' | 'createdAt'>,
): JournalEntry {
  const ts = nowIso();
  return {
    id: existing?.id ?? newId(),
    date: input.date,
    description: input.description.trim(),
    lines: [
      { accountId: input.debitAccountId, side: 'debit', amount: input.amount },
      { accountId: input.creditAccountId, side: 'credit', amount: input.amount },
    ],
    ...(input.memo && input.memo.trim() !== '' ? { memo: input.memo.trim() } : {}),
    kind: input.kind ?? 'normal',
    createdAt: existing?.createdAt ?? ts,
    updatedAt: ts,
  };
}

/** 既存仕訳を SimpleEntryInput に戻す（編集フォーム初期化用）。MVP の 2 行前提。 */
export function toSimpleInput(entry: JournalEntry): SimpleEntryInput {
  const debit = entry.lines.find((l) => l.side === 'debit');
  const credit = entry.lines.find((l) => l.side === 'credit');
  return {
    date: entry.date,
    description: entry.description,
    debitAccountId: debit?.accountId ?? '',
    creditAccountId: credit?.accountId ?? '',
    amount: debit?.amount ?? credit?.amount ?? 0,
    ...(entry.memo !== undefined ? { memo: entry.memo } : {}),
    kind: entry.kind,
  };
}
