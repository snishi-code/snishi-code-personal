/*
 * MVP の仕訳ヘルパ: 「1 借方・1 貸方・同額」の仕訳を組み立てる。
 * 内部表現は常に複式（debit/credit の 2 行）。将来の複合仕訳に備えて lines 配列のまま持つ。
 *
 * UI の「収入/支出/振替」は、どの科目を debit/credit に割り当てるかの違いでしかない。
 * その割当は UI 層（EntrySheet の mode→roles）で行い、ここは debit/credit + metadata を受ける。
 */
import { newId } from './ids';
import type { EntryMetadata, JournalEntry, JournalEntryKind } from './types';
import { nowIso, todayLocal } from '../util/time';

export interface SimpleEntryInput {
  date: string;
  description: string;
  debitAccountId: string;
  creditAccountId: string;
  amount: number;
  memo?: string;
  kind?: JournalEntryKind;
  metadata?: EntryMetadata;
  /** 仕訳全体タグ。 */
  tagIds?: string[];
  /** 借方明細タグ / 貸方明細タグ。 */
  debitTagIds?: string[];
  creditTagIds?: string[];
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

function cleanMetadata(meta: EntryMetadata | undefined): EntryMetadata | undefined {
  if (!meta) return undefined;
  const has =
    meta.inputMode !== undefined ||
    meta.reversalOfEntryId !== undefined ||
    meta.allocationPlan !== undefined;
  return has ? meta : undefined;
}

/** 既存仕訳を編集するとき、id/createdAt を引き継ぐ。新規なら省略。 */
export function buildSimpleEntry(
  input: SimpleEntryInput,
  existing?: Pick<JournalEntry, 'id' | 'createdAt'>,
): JournalEntry {
  const ts = nowIso();
  const metadata = cleanMetadata(input.metadata);
  const debitTags = input.debitTagIds?.length ? { tagIds: input.debitTagIds } : {};
  const creditTags = input.creditTagIds?.length ? { tagIds: input.creditTagIds } : {};
  return {
    id: existing?.id ?? newId(),
    date: input.date,
    description: input.description.trim(),
    lines: [
      { accountId: input.debitAccountId, side: 'debit', amount: input.amount, ...debitTags },
      { accountId: input.creditAccountId, side: 'credit', amount: input.amount, ...creditTags },
    ],
    ...(input.memo && input.memo.trim() !== '' ? { memo: input.memo.trim() } : {}),
    kind: input.kind ?? 'normal',
    ...(metadata ? { metadata } : {}),
    ...(input.tagIds?.length ? { tagIds: input.tagIds } : {}),
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
    ...(entry.metadata ? { metadata: entry.metadata } : {}),
    ...(entry.tagIds ? { tagIds: entry.tagIds } : {}),
    ...(debit?.tagIds ? { debitTagIds: debit.tagIds } : {}),
    ...(credit?.tagIds ? { creditTagIds: credit.tagIds } : {}),
  };
}

/**
 * 取消/返金（逆仕訳）の初期入力を作る。
 * 元仕訳は削除せず、借方/貸方を入れ替えた新しい仕訳の入力値を返す。
 * 金額・日付・摘要は編集可能（部分返金に対応）。
 */
export function reversalInput(source: JournalEntry): SimpleEntryInput {
  const debit = source.lines.find((l) => l.side === 'debit');
  const credit = source.lines.find((l) => l.side === 'credit');
  return {
    date: todayLocal(),
    description: `取消: ${source.description}`,
    // 入れ替え: 元の貸方が新しい借方、元の借方が新しい貸方。
    debitAccountId: credit?.accountId ?? '',
    creditAccountId: debit?.accountId ?? '',
    amount: debit?.amount ?? credit?.amount ?? 0,
    kind: 'normal',
    metadata: { inputMode: 'reversal', reversalOfEntryId: source.id },
  };
}
