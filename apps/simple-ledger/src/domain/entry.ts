/*
 * MVP の仕訳ヘルパ: 「1 借方・1 貸方・同額」の仕訳を組み立てる。
 * 内部表現は常に複式（debit/credit の 2 行）。将来の複合仕訳に備えて lines 配列のまま持つ。
 *
 * UI の「収入/支出/振替」は、どの科目を debit/credit に割り当てるかの違いでしかない。
 * その割当は UI 層（EntrySheet の mode→roles）で行い、ここは debit/credit + metadata を受ける。
 */
import { newId } from './ids';
import type { AccountRole } from './accountRoles';
import type { EntryMetadata, JournalEntry, JournalEntryKind } from './types';
import { nowIso } from '../util/time';

const TRANSFER_FUND_ROLES: AccountRole[] = ['daily-asset'];
const TRANSFER_LIABILITY_ROLES: AccountRole[] = ['payment-liability', 'other-liability'];

/**
 * 振替（資金移動）として成立する役割の組み合わせか。
 *  - 資金 → 資金（口座間）
 *  - 資金 → 負債（返済）
 *  - 負債 → 資金（借入・ローン実行）
 * それ以外（負債→負債、費用/収入カテゴリが絡む等）は不正。
 */
export function transferFlowValid(srcRole: AccountRole, dstRole: AccountRole): boolean {
  if (TRANSFER_FUND_ROLES.includes(srcRole)) {
    return TRANSFER_FUND_ROLES.includes(dstRole) || TRANSFER_LIABILITY_ROLES.includes(dstRole);
  }
  if (TRANSFER_LIABILITY_ROLES.includes(srcRole)) {
    return TRANSFER_FUND_ROLES.includes(dstRole);
  }
  return false;
}

export interface SimpleEntryInput {
  date: string;
  description: string;
  debitAccountId: string;
  creditAccountId: string;
  amount: number;
  kind?: JournalEntryKind;
  metadata?: EntryMetadata;
  /**
   * 諸口（v13.16）: 同一 groupId の通常仕訳 N 本の束。createEntries（振り分け保存）だけが
   * 値を入れる。単一保存では付けない（1 行に減ったら普通の仕訳に退化する設計と対称）。
   */
  groupId?: string;
  /**
   * @deprecated タグ機能は撤去済み（2026-08-15）。UI から値が入る経路は無いが、
   * import 済みデータを編集しても消えないよう素通しだけ残す。
   */
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
  // 値の入ったキーが 1 つでもあれば「意味のある metadata」として丸ごと保持する
  // （既知キーの列挙で判定すると、列挙に無い由来メタしか持たない仕訳の編集で
  // metadata ごと落ちる。一般形の堅牢化・Codex 指摘）。
  const has = Object.values(meta).some((value) => value !== undefined);
  return has ? meta : undefined;
}

/** 既存仕訳を編集するとき、id/createdAt を引き継ぐ。新規なら省略。 */
export function buildSimpleEntry(
  input: SimpleEntryInput,
  existing?: Pick<JournalEntry, 'id' | 'createdAt'>,
): JournalEntry {
  const ts = nowIso();
  const metadata = cleanMetadata(input.metadata);
  return {
    id: existing?.id ?? newId(),
    date: input.date,
    description: input.description.trim(),
    lines: [
      { accountId: input.debitAccountId, side: 'debit', amount: input.amount },
      { accountId: input.creditAccountId, side: 'credit', amount: input.amount },
    ],
    kind: input.kind ?? 'normal',
    ...(metadata ? { metadata } : {}),
    ...(input.groupId !== undefined ? { groupId: input.groupId } : {}),
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
    kind: entry.kind,
    ...(entry.metadata ? { metadata: entry.metadata } : {}),
  };
}

/**
 * 取消/返金（逆仕訳）の初期入力を作る。
 * 元仕訳は削除せず、借方/貸方を入れ替えた新しい仕訳の入力値を返す。
 * 金額・日付・摘要は編集可能（部分返金に対応）。
 * 初期日付は **元仕訳と同じ日付**（未来日付の取消が今日の集計を汚さないように）。
 */
export function reversalInput(source: JournalEntry): SimpleEntryInput {
  const debit = source.lines.find((l) => l.side === 'debit');
  const credit = source.lines.find((l) => l.side === 'credit');
  return {
    date: source.date,
    description: `取消: ${source.description}`,
    // 入れ替え: 元の貸方が新しい借方、元の借方が新しい貸方。
    debitAccountId: credit?.accountId ?? '',
    creditAccountId: debit?.accountId ?? '',
    amount: debit?.amount ?? credit?.amount ?? 0,
    kind: 'normal',
    // タグは撤去済み。import 済みデータの値だけを素通しで引き継ぐ（黙って消さない）。
    metadata: {
      inputMode: 'reversal',
      reversalOfEntryId: source.id,
    },
  };
}
