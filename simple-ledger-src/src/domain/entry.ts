/*
 * MVP の仕訳ヘルパ: 「1 借方・1 貸方・同額」の仕訳を組み立てる。
 * 内部表現は常に複式（debit/credit の 2 行）。将来の複合仕訳に備えて lines 配列のまま持つ。
 *
 * UI の「収入/支出/振替」は、どの科目を debit/credit に割り当てるかの違いでしかない。
 * その割当は UI 層（EntrySheet の mode→roles）で行い、ここは debit/credit + metadata を受ける。
 */
import { newId } from './ids';
import { accountBalance, filterByDateRange } from './accounting';
import type { AccountRole } from './accountRoles';
import { DEFAULT_MANAGEMENT_SCOPE_ID, RESERVE_LEDGER_ACCOUNT_ID } from './constants';
import type { Account, EntryMetadata, JournalEntry, JournalEntryKind, ReserveItem } from './types';
import { reserveBalances } from './reserve';
import { nowIso } from '../util/time';

const TRANSFER_FUND_ROLES: AccountRole[] = ['daily-asset', 'reserve-asset'];
const TRANSFER_LIABILITY_ROLES: AccountRole[] = ['payment-liability', 'other-liability'];

/**
 * 振替（資金移動）として成立する役割の組み合わせか。
 *  - 資金 → 資金（口座間・目的別資金へ/から）
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

/**
 * 目的別資金（reserve-asset）から支払う/移動する仕訳で、その資金の残高が不足しないかを判定する。
 * entry が貸方で減らす reserve-asset 口座について、**entry.date 時点**の残高
 *（その日までの既存仕訳 + この entry）が負になるなら不足。fail-closed の保存前チェックに使う。
 *  - otherEntries は「保存対象 entry 以外」の全仕訳（編集時は自分自身を二重計上しない）。
 *  - 未来日付でも、その日付までの既存仕訳を含めて判定する。
 * 不足する口座があれば最初の 1 件を返す。無ければ null。
 */
export function reserveBalanceShortfall(
  entry: JournalEntry,
  accounts: Account[],
  otherEntries: JournalEntry[],
  reserves: ReserveItem[] = [],
): { accountId: string; name: string } | null {
  const byId = new Map(accounts.map((a) => [a.id, a]));
  const reduced = new Set(
    entry.lines
      .filter((l) => l.side === 'credit' && byId.get(l.accountId)?.role === 'reserve-asset')
      .map((l) => l.accountId),
  );
  if (reduced.size === 0) return null;
  const asOf = filterByDateRange([...otherEntries, entry], undefined, entry.date);
  for (const accId of reduced) {
    // 集約モデル: 取り置き集約口座は口座残高（全目的の合計）でなく、その仕訳の目的(reserveId)
    // 単位の残高で不足判定する（旅行が 0 でも老後の残高で払えてしまう不具合を防ぐ）。
    if (accId === RESERVE_LEDGER_ACCOUNT_ID && entry.metadata?.reserveId) {
      const rid = entry.metadata.reserveId;
      if ((reserveBalances(asOf).get(rid) ?? 0) < 0) {
        const name = reserves.find((r) => r.id === rid)?.name ?? byId.get(accId)?.name ?? accId;
        return { accountId: accId, name };
      }
      continue;
    }
    if (accountBalance(accId, 'asset', asOf) < 0) {
      return { accountId: accId, name: byId.get(accId)?.name ?? accId };
    }
  }
  return null;
}

export interface SimpleEntryInput {
  date: string;
  description: string;
  debitAccountId: string;
  creditAccountId: string;
  amount: number;
  memo?: string;
  kind?: JournalEntryKind;
  metadata?: EntryMetadata;
  /** どの管理区分の仕訳か。未指定なら既定（個人用）。 */
  managementScopeId?: string;
  /** 仕訳全体タグ（イベント/目的ラベル）。 */
  tagIds?: string[];
  /** 借方/貸方の支払い手段の細目（任意）。 */
  debitInstrumentId?: string;
  creditInstrumentId?: string;
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
  const debitInst = input.debitInstrumentId ? { instrumentId: input.debitInstrumentId } : {};
  const creditInst = input.creditInstrumentId ? { instrumentId: input.creditInstrumentId } : {};
  return {
    id: existing?.id ?? newId(),
    date: input.date,
    description: input.description.trim(),
    lines: [
      { accountId: input.debitAccountId, side: 'debit', amount: input.amount, ...debitInst },
      { accountId: input.creditAccountId, side: 'credit', amount: input.amount, ...creditInst },
    ],
    ...(input.memo && input.memo.trim() !== '' ? { memo: input.memo.trim() } : {}),
    kind: input.kind ?? 'normal',
    managementScopeId: input.managementScopeId ?? DEFAULT_MANAGEMENT_SCOPE_ID,
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
    managementScopeId: entry.managementScopeId,
    ...(entry.metadata ? { metadata: entry.metadata } : {}),
    ...(entry.tagIds ? { tagIds: entry.tagIds } : {}),
    ...(debit?.instrumentId ? { debitInstrumentId: debit.instrumentId } : {}),
    ...(credit?.instrumentId ? { creditInstrumentId: credit.instrumentId } : {}),
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
    // 管理区分は引き継ぐ。仕訳全体タグも引き継ぐ（タグ別集計に取消を反映させるため）。
    // 支払い手段は side 入れ替えに合わせて付け替える。
    managementScopeId: source.managementScopeId,
    ...(source.tagIds?.length ? { tagIds: source.tagIds } : {}),
    ...(credit?.instrumentId ? { debitInstrumentId: credit.instrumentId } : {}),
    ...(debit?.instrumentId ? { creditInstrumentId: debit.instrumentId } : {}),
    metadata: { inputMode: 'reversal', reversalOfEntryId: source.id },
  };
}
