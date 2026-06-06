/*
 * 残高補正。任意の日に実残高との差分を 2 行仕訳で補正する（「締め」は作らない）。
 *  - unknown-balance: 通常の現金/預金差額 → 残高調整費 / 残高調整収入
 *  - investment-valuation: 投資残高差額 → 投資評価損 / 投資評価益（生活コストとは別）
 */
import { newId } from './ids';
import { nowIso } from '../util/time';
import type { AdjustmentKind, AdjustmentMeta, JournalEntry } from './types';

/** 補正の相手科目の既定名（初回利用時に作成/再利用）。 */
export const ADJUSTMENT_ACCOUNTS = {
  balanceExpense: '残高調整費', // expense
  balanceRevenue: '残高調整収入', // revenue
  investmentLoss: '投資評価損', // expense
  investmentGain: '投資評価益', // revenue
} as const;

/** 損益方向: asset 増 or liability 減 = 益(revenue) / それ以外 = 損(expense)。 */
export function counterpartRole(
  accountType: 'asset' | 'liability',
  delta: number,
): 'expense' | 'revenue' {
  const gain = (accountType === 'asset' && delta > 0) || (accountType === 'liability' && delta < 0);
  return gain ? 'revenue' : 'expense';
}

/** kind + 役割 → 既定の相手科目名。 */
export function counterpartName(kind: AdjustmentKind, role: 'expense' | 'revenue'): string {
  if (kind === 'investment-valuation') {
    return role === 'expense'
      ? ADJUSTMENT_ACCOUNTS.investmentLoss
      : ADJUSTMENT_ACCOUNTS.investmentGain;
  }
  return role === 'expense'
    ? ADJUSTMENT_ACCOUNTS.balanceExpense
    : ADJUSTMENT_ACCOUNTS.balanceRevenue;
}

export interface AdjustmentInput {
  kind: AdjustmentKind;
  accountId: string;
  accountType: 'asset' | 'liability';
  date: string;
  description: string;
  expectedBalance: number;
  actualBalance: number;
  /** 相手科目 ID（repository が役割に応じて選定/作成して渡す）。 */
  counterpartAccountId: string;
}

/**
 * 補正仕訳を作る。delta=0 なら null（仕訳を作らない）。
 *  - asset 増: 借方 資産 / 貸方 収入(評価益)   asset 減: 借方 費(評価損) / 貸方 資産
 *  - liability 増: 借方 費 / 貸方 負債          liability 減: 借方 負債 / 貸方 収入
 */
export function buildAdjustmentEntry(input: AdjustmentInput): JournalEntry | null {
  const delta = input.actualBalance - input.expectedBalance;
  if (delta === 0) return null;
  const ts = nowIso();
  const amount = Math.abs(delta);
  const acc = input.accountId;
  const counter = input.counterpartAccountId;

  let debit: string;
  let credit: string;
  if (input.accountType === 'asset') {
    if (delta > 0) {
      debit = acc;
      credit = counter;
    } else {
      debit = counter;
      credit = acc;
    }
  } else {
    if (delta > 0) {
      debit = counter;
      credit = acc;
    } else {
      debit = acc;
      credit = counter;
    }
  }

  const meta: AdjustmentMeta = {
    kind: input.kind,
    accountId: acc,
    expectedBalance: input.expectedBalance,
    actualBalance: input.actualBalance,
    delta,
    counterpartAccountId: counter,
  };

  return {
    id: newId(),
    date: input.date,
    description: input.description.trim() || '残高補正',
    kind: 'normal',
    lines: [
      { accountId: debit, side: 'debit', amount },
      { accountId: credit, side: 'credit', amount },
    ],
    metadata: { inputMode: 'manual', adjustment: meta },
    createdAt: ts,
    updatedAt: ts,
  };
}
