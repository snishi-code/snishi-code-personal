/*
 * 会計ドメインの型。
 *
 * 旧 GAS の source/dest や +/- 表現は使わない。すべて複式簿記の
 * 借方(debit) / 貸方(credit) で表現する。
 *
 * 金額は最小単位の整数で持つ（JPY なら「円」。小数は扱わない）。
 * これにより浮動小数の誤差を避ける。通貨は settings.currency。
 */

export type AccountType = 'asset' | 'liability' | 'equity' | 'revenue' | 'expense';

export const ACCOUNT_TYPES: readonly AccountType[] = [
  'asset',
  'liability',
  'equity',
  'revenue',
  'expense',
];

/** 借方=debit / 貸方=credit。 */
export type Side = 'debit' | 'credit';

export interface Account {
  id: string;
  name: string;
  type: AccountType;
  /** アーカイブ済みの科目は新規仕訳の選択肢から外すが、過去仕訳の集計には残る。 */
  archived: boolean;
  note?: string;
  createdAt: string;
  updatedAt: string;
}

export interface JournalLine {
  accountId: string;
  side: Side;
  /** 正の整数（最小通貨単位）。 */
  amount: number;
}

/**
 * 仕訳。MVP では「1 借方・1 貸方・同額」のみ（lines.length === 2）。
 * 型としては複数行を許し、将来の複合仕訳へ拡張できる。
 */
export type JournalEntryKind = 'normal' | 'opening';

/**
 * UI 上の入力方法。内部は常に debit/credit だが、どの導線で作られたかを記録する。
 *  - income/expense/transfer: 日常入力の 3 種
 *  - manual: 借方/貸方を直接指定した詳細入力
 *  - reversal: 取消/返金（逆仕訳）
 */
export type InputMode = 'income' | 'expense' | 'transfer' | 'manual' | 'reversal';

/**
 * 期間按分の計画（将来実装用）。MVP では保存・export/import・検証が通るだけ。
 * UI からは生成しない（按分仕訳の自動生成ロジックは未実装）。
 */
export interface AllocationPlan {
  kind: 'period';
  /** ISO 日付。 */
  startDate: string;
  endDate: string;
  /** 按分方式。MVP は型のみ（'even-monthly' 等を想定）。 */
  method: 'even-monthly';
  /** 期間費用/収益として認識する科目。 */
  recognitionAccountId: string;
  /** 繰延（前払/前受）として保持する科目。 */
  deferredAccountId: string;
  /** この計画から生成された仕訳 ID（未生成なら空）。 */
  generatedEntryIds: string[];
}

/** 仕訳の付帯情報。将来の取消/返金・期間按分に耐えるための拡張点。 */
export interface EntryMetadata {
  inputMode?: InputMode;
  /** reversal のとき、元仕訳の ID。 */
  reversalOfEntryId?: string;
  allocationPlan?: AllocationPlan;
}

export interface JournalEntry {
  id: string;
  /** ISO 日付 (YYYY-MM-DD)。 */
  date: string;
  description: string;
  lines: JournalLine[];
  memo?: string;
  /** 'opening' は UI で「初期残高」として見せる。集計上は通常の仕訳と同じ。 */
  kind: JournalEntryKind;
  /** 付帯情報（入力方法・逆仕訳リンク・按分計画など）。任意。 */
  metadata?: EntryMetadata;
  createdAt: string;
  updatedAt: string;
}

export interface Settings {
  ledgerName: string;
  /** ISO 4217 風のコード。MVP は表示用途のみ（換算はしない）。 */
  currency: string;
  locale: 'ja';
}

export interface LedgerMeta {
  id: string;
  schemaVersion: number;
  /** 端末ローカルの編集リビジョン。保存のたびに +1。 */
  revision: number;
  deviceId: string;
  createdAt: string;
  updatedAt: string;
}

/** import 前などに作るスナップショット（復元用）。 */
export interface Snapshot {
  id: string;
  createdAt: string;
  reason: string;
  /** 取得時点の完全なエクスポートパッケージ。 */
  data: LedgerExportPackage;
}

/** 端末間共有・バックアップの公式交換形式。 */
export interface LedgerExportPackage {
  appId: string;
  schemaVersion: number;
  ledgerId: string;
  exportedAt: string;
  deviceId: string;
  baseRevision: number;
  currentRevision: number;
  accounts: Account[];
  journalEntries: JournalEntry[];
  settings: Settings;
}

/* ── 導出（保存しない。仕訳と科目から毎回計算する） ── */

export interface AccountBalance {
  account: Account;
  /** 科目タイプの自然な符号での残高（asset/expense は借方正、他は貸方正）。 */
  balance: number;
}

export interface ProfitAndLoss {
  /** 期間（含む両端、ISO 日付）。未指定なら全期間。 */
  from?: string;
  to?: string;
  revenues: AccountBalance[];
  expenses: AccountBalance[];
  totalRevenue: number;
  totalExpense: number;
  /** 当期純損益 = totalRevenue - totalExpense。 */
  netIncome: number;
}

export interface BalanceSheet {
  /** この日付時点（含む、ISO 日付）。未指定なら全期間累計。 */
  asOf?: string;
  assets: AccountBalance[];
  liabilities: AccountBalance[];
  equity: AccountBalance[];
  totalAssets: number;
  totalLiabilities: number;
  /** equity 科目の合計。 */
  totalEquityAccounts: number;
  /** 当期純損益（未締めのため equity に算入して表示）。 */
  retainedEarnings: number;
  /** 純資産 = totalAssets - totalLiabilities = totalEquityAccounts + retainedEarnings。 */
  netAssets: number;
  /** 借方=貸方が崩れていないか（balanced なら true）。 */
  balanced: boolean;
}

export interface Ledger {
  meta: LedgerMeta;
  settings: Settings;
  accounts: Account[];
  journalEntries: JournalEntry[];
}
