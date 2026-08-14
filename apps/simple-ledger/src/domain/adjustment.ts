/*
 * 残高補正。任意の日に実残高（＝費用・収入なら実際の累計額）との差分を 2 行仕訳で
 * 補正する（「締め」は作らない）。現金・預金・投資・負債・費用・収入の差額を、
 * 残高調整費 / 残高調整収入との2行仕訳で合わせる。
 */
import { newId } from './ids';
import { nowIso } from '../util/time';
import { isDebitNormal } from './accounting';
import type { AccountType, AdjustmentMeta, JournalEntry } from './types';
import { assertSafeAmount } from './safeSum';

/** 補正の相手科目の既定名（初回利用時に作成/再利用）。 */
export const ADJUSTMENT_ACCOUNTS = {
  balanceExpense: '残高調整費', // expense
  balanceRevenue: '残高調整収入', // revenue
} as const;

/**
 * 補正の対象にできる会計 type。equity（初期残高）は補正の対象外
 * （初期残高は opening の編集で直す。補正で動かすと二重の正本になる）。
 */
export type AdjustableAccountType = 'asset' | 'liability' | 'expense' | 'revenue';

export function isAdjustableAccountType(
  type: AccountType | string | undefined,
): type is AdjustableAccountType {
  return type === 'asset' || type === 'liability' || type === 'expense' || type === 'revenue';
}

/**
 * 損益方向。対象科目が「正規方向に増えた」なら益(revenue)、減ったなら損(expense)。
 * 借方正規(asset / expense)は delta > 0 が増、貸方正規(liability / revenue)は delta < 0 が増
 * （isDebitNormal が符号規則の正本）。
 * 例: asset 増 = 益・liability 増 = 損・expense 増 = 相手が貸方＝調整収入・revenue 増 = 調整費。
 */
export function counterpartRole(
  accountType: AdjustableAccountType,
  delta: number,
): 'expense' | 'revenue' {
  const gain = isDebitNormal(accountType) ? delta > 0 : delta < 0;
  return gain ? 'revenue' : 'expense';
}

/** 役割 → 既定の相手科目名。 */
export function counterpartName(role: 'expense' | 'revenue'): string {
  return role === 'expense'
    ? ADJUSTMENT_ACCOUNTS.balanceExpense
    : ADJUSTMENT_ACCOUNTS.balanceRevenue;
}

export interface AdjustmentInput {
  accountId: string;
  accountType: AdjustableAccountType;
  date: string;
  description: string;
  expectedBalance: number;
  actualBalance: number;
  /** 相手科目 ID（repository が役割に応じて選定/作成して渡す）。 */
  counterpartAccountId: string;
  /**
   * 既存補正の編集時に、その id / createdAt を引き継ぐ（同一仕訳を上書きする）。
   * 未指定なら新規（id を採番し createdAt=updatedAt=now）。
   */
  existing?: { id: string; createdAt: string };
}

/**
 * 補正仕訳を作る。delta=0 なら null（仕訳を作らない）。
 * 向きは正規方向で決まる（type ごとの 4 分岐ではなく借方正規 / 貸方正規の 2 分岐）:
 *  - 借方正規(asset / expense): delta>0 → 借方 対象 / 貸方 相手(調整収入)、delta<0 → 逆
 *  - 貸方正規(liability / revenue): そのミラー（delta>0 → 借方 相手(調整費) / 貸方 対象）
 * 例: 資産増 = 借方 資産 / 貸方 調整収入、費用の累計が実際は多い = 借方 費用 / 貸方 調整収入。
 */
export function buildAdjustmentEntry(input: AdjustmentInput): JournalEntry | null {
  const delta = assertSafeAmount(input.actualBalance - input.expectedBalance);
  if (delta === 0) return null;
  const ts = nowIso();
  const amount = Math.abs(delta);
  const acc = input.accountId;
  const counter = input.counterpartAccountId;

  // 対象が増える側 = 借方正規なら借方・貸方正規なら貸方。相手はその反対側。
  const targetOnDebit = isDebitNormal(input.accountType) ? delta > 0 : delta < 0;
  const debit = targetOnDebit ? acc : counter;
  const credit = targetOnDebit ? counter : acc;

  const meta: AdjustmentMeta = {
    accountId: acc,
    expectedBalance: input.expectedBalance,
    actualBalance: input.actualBalance,
    delta,
    counterpartAccountId: counter,
  };

  return {
    id: input.existing?.id ?? newId(),
    date: input.date,
    description: input.description.trim() || '残高補正',
    kind: 'normal',
    lines: [
      { accountId: debit, side: 'debit', amount },
      { accountId: credit, side: 'credit', amount },
    ],
    metadata: { inputMode: 'manual', adjustment: meta },
    createdAt: input.existing?.createdAt ?? ts,
    updatedAt: ts,
  };
}
