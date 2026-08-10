/*
 * 組み込み Import Profile（指示書 §3）。v1 は PayPay 取引履歴 CSV のみ。
 *
 *  - **データ定義だけ**を置く（seed の実行はデータ層の管轄）。組み込み profile は
 *    fresh DB / 全リセット時にのみ seed し、削除後に自動復活しない（§1-1）。
 *    戻すのは設定画面の「組み込みプロファイルを復元」ボタンのみ。
 *  - builtinId / builtinVersion は固定値。DSL を変えるときは builtinVersion を +1 する。
 *  - 実 CSV（UTF-8 BOM・13 列固定・カンマ金額・`-`=空・`YYYY/MM/DD HH:MM:SS`・行種 8 種）
 *    に準拠する。externalId = [取引番号, 取引内容]（取引番号単独は非一意・検証済み）。
 *  - 科目は ID でも名前でも参照しない（§1-1b。科目への紐付けは ProfileBinding の管轄）。
 */
import type { Side } from './types';
import type { ImportProfile, ImportProfileDsl } from './importDsl';

export const PAYPAY_BUILTIN_ID = 'paypay-csv' as const;
export const PAYPAY_BUILTIN_VERSION = 1 as const;
/** seed 時に使う決定的な profile ID（組み込みは 1 つしか存在しない）。 */
export const PAYPAY_PROFILE_ID = 'builtin-paypay-csv' as const;
export const PAYPAY_PROFILE_NAME = 'PayPay（取引履歴 CSV）' as const;

/** PayPay CSV の行種（取引内容の値・実データ検証済みの 8 種）。 */
export const PAYPAY_KINDS = [
  '支払い',
  '請求書払い',
  'ポイント、残高の獲得',
  'ポイント、残高の取消',
  'チャージ',
  '送った金額',
  '受け取った金額',
  '口座送金',
] as const;
export type PaypayKind = (typeof PAYPAY_KINDS)[number];

/**
 * PayPay 取引履歴 CSV の変換規則。
 * 行種はどれにも一致しなければ未知 kind = error（黙って捨てない）ため、
 * skipRules は置かず 8 種を全て列挙する。
 */
export const PAYPAY_DSL: ImportProfileDsl = {
  dslVersion: 1,
  fileFormat: { encoding: 'utf-8-sig', delimiter: ',', headerRowIndex: 0 },
  emptyValues: ['-'],
  columns: {
    // 日時 `YYYY/MM/DD HH:MM:SS` → 日付へ切り捨て（§3）。
    date: { column: '取引日', format: 'YYYY/MM/DD HH:MM:SS' },
    // 出金/入金の 2 列・カンマ金額・`-`=空。
    amount: { mode: 'in-out', outflowColumn: '出金金額（円）', inflowColumn: '入金金額（円）' },
    // 摘要 = 取引内容 + 取引先（例: 「支払い セブン-イレブン…」「チャージ PayPay」）。
    description: { columns: ['取引内容', '取引先'], separator: ' ' },
    counterparty: { column: '取引先' },
  },
  // canonical tuple。[取引番号, 取引内容] で 452/452 一意（実データ検証済み・§0）。
  externalId: { columns: ['取引番号', '取引内容'] },
  kindRules: PAYPAY_KINDS.map((kind) => ({
    when: { op: 'eq', column: '取引内容', value: kind },
    kind,
  })),
};

/**
 * seed 用の profile を組み立てる（純関数）。呼び出し側（データ層）が保存時に
 * structuredClone などで複製して使う。
 */
export function paypayBuiltinProfile(nowIso: string): ImportProfile {
  return {
    id: PAYPAY_PROFILE_ID,
    name: PAYPAY_PROFILE_NAME,
    builtin: { builtinId: PAYPAY_BUILTIN_ID, builtinVersion: PAYPAY_BUILTIN_VERSION },
    dsl: PAYPAY_DSL,
    createdAt: nowIso,
    updatedAt: nowIso,
  };
}

/* ── 行種 → 仕訳形のヒント（§3 の表・レビュー UI / binding セットアップの参考データ） ── */

/** 相手方（自口座でない側）の決め方。 */
export type ImportCounterAccountHint =
  /** 費用カテゴリを行単位で選択（行種一括適用も可）。 */
  | 'expense-per-row'
  /** 収入カテゴリ（既定サジェスト = その他収入）。binding の行種→計上先で記憶。 */
  | 'income-category'
  /** チャージ源泉（daily-asset）。binding で記憶。 */
  | 'charge-source'
  /** 相手方を個別選択（件数僅少の送金系）。 */
  | 'per-row-counterparty';

export interface ImportKindHint {
  /** 自口座側の借/貸の期待値（評価器の導出と一致するはず。ズレはレビューで可視化）。 */
  expectedOwnSide: Side;
  counter: ImportCounterAccountHint;
  /** レビューの既定挙動: bulk = 一括適用可 / per-row = 個別選択。 */
  review: 'bulk' | 'per-row';
}

/**
 * §3 の表そのまま。binding（§1-1b）の role 制約: 獲得・取消 → income-category、
 * 支払い → expense-category（行単位選択なので既定なし）、チャージ源泉 → daily-asset。
 */
export const PAYPAY_KIND_HINTS: Record<PaypayKind, ImportKindHint> = {
  // 借方 <費用カテゴリ: 行単位選択> / 貸方 <自口座>。
  支払い: { expectedOwnSide: 'credit', counter: 'expense-per-row', review: 'per-row' },
  請求書払い: { expectedOwnSide: 'credit', counter: 'expense-per-row', review: 'per-row' },
  // 借方 <自口座> / 貸方 <獲得先: 既定サジェスト = その他収入>。
  'ポイント、残高の獲得': { expectedOwnSide: 'debit', counter: 'income-category', review: 'bulk' },
  // 獲得の逆向き。
  'ポイント、残高の取消': { expectedOwnSide: 'credit', counter: 'income-category', review: 'bulk' },
  // 借方 <自口座> / 貸方 <チャージ源泉>。
  チャージ: { expectedOwnSide: 'debit', counter: 'charge-source', review: 'bulk' },
  // 相手方を個別選択（件数僅少）。
  送った金額: { expectedOwnSide: 'credit', counter: 'per-row-counterparty', review: 'per-row' },
  受け取った金額: { expectedOwnSide: 'debit', counter: 'per-row-counterparty', review: 'per-row' },
  口座送金: { expectedOwnSide: 'credit', counter: 'per-row-counterparty', review: 'per-row' },
};
