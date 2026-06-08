/*
 * 入力モード → フィールド役割の対応。
 *
 * 日常入力（収入/支出/振替）はユーザーに借方/貸方を意識させない。代わりに意味のある
 * フィールド（入金先・カテゴリ・支払元・振替元・振替先）で 2 科目を選ばせ、各フィールドが
 * どちらの side（debit/credit）に入るかをここで定義する。内部は常に複式。
 */
import { ACCOUNT_ROLES, type AccountRole } from '../domain/accountRoles';
import type { MessageKey } from '../i18n';

/** フォームとして扱う入力モード（reversal は manual フォームを使い回す）。 */
export type FormMode = 'income' | 'expense' | 'transfer' | 'manual';

export interface EntryRole {
  side: 'debit' | 'credit';
  labelKey: MessageKey;
  /**
   * このフィールドで選べる科目の役割(role)。type ではなく role で絞ることで、
   * 按分中資産・取り置き資金・投資資産・残高調整科目を日常入力から外す。
   */
  allowedRoles: AccountRole[];
}

const ALL_ROLES: AccountRole[] = [...ACCOUNT_ROLES];

/**
 * 各モードの 2 フィールド（表示順）。日常入力は role で候補を絞る。
 *  - 収入: 入金先(daily-asset=debit) / カテゴリ(income-category=credit)
 *  - 支出: カテゴリ(expense-category=debit) / 支払元(daily-asset|payment-liability=credit)
 *  - 振替: 振替元(daily-asset=credit) / 振替先(daily-asset=debit)
 *  - manual(詳細/編集): 借方(any role) / 貸方(any role)
 */
export const MODE_ROLES: Record<FormMode, readonly [EntryRole, EntryRole]> = {
  income: [
    { side: 'debit', labelKey: 'entry.income.target', allowedRoles: ['daily-asset'] },
    { side: 'credit', labelKey: 'entry.income.category', allowedRoles: ['income-category'] },
  ],
  expense: [
    // 使い道は費用カテゴリのほか、固定資産（車・家財など）の購入先も選べる。
    {
      side: 'debit',
      labelKey: 'entry.expense.category',
      allowedRoles: ['expense-category', 'fixed-asset'],
    },
    {
      side: 'credit',
      labelKey: 'entry.expense.source',
      allowedRoles: ['daily-asset', 'reserve-asset', 'payment-liability'],
    },
  ],
  transfer: [
    // 資金移動: 日常/取り置き資金 ↔ 資金、資金→負債（返済）、負債→資金（借入実行）。
    {
      side: 'credit',
      labelKey: 'entry.transfer.from',
      allowedRoles: ['daily-asset', 'reserve-asset', 'payment-liability', 'other-liability'],
    },
    {
      side: 'debit',
      labelKey: 'entry.transfer.to',
      allowedRoles: ['daily-asset', 'reserve-asset', 'payment-liability', 'other-liability'],
    },
  ],
  manual: [
    { side: 'debit', labelKey: 'entry.debitAccount', allowedRoles: ALL_ROLES },
    { side: 'credit', labelKey: 'entry.creditAccount', allowedRoles: ALL_ROLES },
  ],
};

/** 日常入力モード（manual 以外）。 */
export type FlowMode = 'income' | 'expense' | 'transfer';

/**
 * 「お金の流れ」フォーム定義。簿記用語を出さず `源泉 → 行き先` で見せる。
 * 内部対応は常に source=貸方(credit) / destination=借方(debit)。
 *  - 収入: 収入元(income-category, credit) → 入る場所(daily-asset, debit)
 *  - 支出: 支払い方法(daily-asset|payment-liability, credit) → 使い道(expense-category, debit)
 *  - 振替: 移動元(daily-asset, credit) → 移動先(daily-asset, debit)
 *
 * 支出の支払い方法は、現金・預金などの資金(daily-asset)とクレジットカード(payment-liability)を
 * 既定で出す（カードは日常の支払い手段なのでトグル無しで選べる）。それ以外の
 * 取り置き資金(reserve-asset)・ローン等(other-liability)、および振替での負債は候補を重くしないため
 * 既定に出さず、EntrySheet のトグル（取り置き資金を使う / ローン等の負債も使う）で allowedRoles に
 * 追加する。編集中の既選択は groupedAccountsByRole の includeId で常に表示維持される。
 */
export interface FlowDef {
  source: EntryRole; // 左（貸方）
  destination: EntryRole; // 右（借方）
  flowLabelKey: MessageKey;
}

export const MODE_FLOW: Record<FlowMode, FlowDef> = {
  income: {
    source: { side: 'credit', labelKey: 'entry.source.income', allowedRoles: ['income-category'] },
    destination: {
      side: 'debit',
      labelKey: 'entry.destination.income',
      allowedRoles: ['daily-asset'],
    },
    flowLabelKey: 'entry.flow.income',
  },
  expense: {
    source: {
      side: 'credit',
      labelKey: 'entry.source.expense',
      // 現金・預金など(daily-asset)に加え、クレジットカード(payment-liability)も既定で選べる。
      allowedRoles: ['daily-asset', 'payment-liability'],
    },
    destination: {
      side: 'debit',
      labelKey: 'entry.destination.expense',
      allowedRoles: ['expense-category', 'fixed-asset'],
    },
    flowLabelKey: 'entry.flow.expense',
  },
  transfer: {
    source: {
      side: 'credit',
      labelKey: 'entry.transfer.from',
      allowedRoles: ['daily-asset'],
    },
    destination: {
      side: 'debit',
      labelKey: 'entry.transfer.to',
      allowedRoles: ['daily-asset'],
    },
    flowLabelKey: 'entry.flow.transfer',
  },
};

export const FORM_MODE_TITLE: Record<FormMode, MessageKey> = {
  income: 'entry.income.title',
  expense: 'entry.expense.title',
  transfer: 'entry.transfer.title',
  manual: 'entry.manual.title',
};
