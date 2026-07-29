/*
 * 会計ドメインの型。
 *
 * 旧 GAS の source/dest や +/- 表現は使わない。すべて複式簿記の
 * 借方(debit) / 貸方(credit) で表現する。
 *
 * 金額は最小単位の整数で持つ（JPY なら「円」。小数は扱わない）。
 * これにより浮動小数の誤差を避ける。通貨は settings.currency。
 */

import type { AccountRole } from './accountRoles';

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
  /**
   * UI 用の役割。type（会計分類）とは別に、日常入力の候補制御に使う。
   * type と整合する必要がある（src/domain/accountRoles.ts の roleAllowsType）。
   */
  role: AccountRole;
  /** アーカイブ済みの科目は新規仕訳の選択肢から外すが、過去仕訳の集計には残る。 */
  archived: boolean;
  note?: string;
  /**
   * 返済設定（負債科目のみ: payment-liability / other-liability）。
   * 毎月の返済元となる資金口座（role: daily-asset）。資金繰り画面の返済予定作成で既定値になる。
   * 予定の自動生成はしない（予定 CF は明示登録・実績化のまま）。
   */
  repaymentAccountId?: string;
  /** 毎月の返済日（1〜31）。31 など月に無い日はその月の月末として扱う。 */
  repaymentDay?: number;
  /** 箱内での表示順（並び替え機能）。未設定は名前順で末尾。 */
  sortIndex?: number;
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
 * タグ。勘定科目を増やさずに、旅行・帰省・学会・引っ越しなどイベント/目的ラベルで
 * 仕訳を後から抽出する分析軸。PL/BS の会計ロジックは変えない。
 * タグは常に「仕訳全体（entry）」に付く。
 */
export type TagScope = 'entry';

export interface Tag {
  id: string;
  name: string;
  /** 常に 'entry'（仕訳全体タグ）。互換のためフィールドは残す。 */
  scope: TagScope;
  /** 表示色（CSS トークン名など）。任意。 */
  color?: string;
  archived: boolean;
  createdAt: string;
  updatedAt: string;
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

/** 仕訳の付帯情報。取消/返金や自動生成仕訳の由来を保持する。 */
export interface EntryMetadata {
  inputMode?: InputMode;
  /** reversal のとき、元仕訳の ID。 */
  reversalOfEntryId?: string;
  /** 残高補正（実残高との差分調整）で作られた仕訳の付帯情報。 */
  adjustment?: AdjustmentMeta;
  /** 月額化コストの実支払い仕訳のとき、紐づく MonthlyCostItem の ID（通常編集/削除は不可）。 */
  monthlyCostId?: string;
  /** 継続コストの処分で生成された仕訳のとき、紐づく AssetDisposal の ID（通常編集/削除は不可）。 */
  assetDisposalId?: string;
  /**
   * 取り置き資金（聖域化・集約モデル）の目的を表す ReserveItem の ID。
   * 取り置きは目的ごとの勘定科目を作らず、単一の集約口座（reserve-ledger）に寄せ、目的別残高は
   * この `reserveId` 付き仕訳の集計で導出する（`reserveBalances`）。
   */
  reserveId?: string;
  /**
   * 継続コスト（資産経由モデル）の仮想仕訳の印。これらは **保存されない導出専用**で、
   * `reportEntriesForAsOf` の結果にのみ現れる。実仕訳(`journalEntries`)・保存系・export には入れない。
   */
  virtual?: true;
  /** 仮想仕訳が属する MonthlyCostItem(継続コスト)の ID。 */
  continuousCostId?: string;
  /** 仮想仕訳の種別。funding=資産化(支払元→対象資産) / recognition=認識(対象資産→認識先)。 */
  ccKind?: 'funding' | 'recognition';
  /**
   * 定期ルールから自動起票された仕訳の由来（recurringMonth とペア）。
   * 起票後は通常の仕訳として編集・削除できる。ルール削除時はこのメタデータを剥がして
   * 通常仕訳へ戻す（事実は消さない）。
   */
  recurringRuleId?: string;
  /** どの月ぶんの起票か 'YYYY-MM'。 */
  recurringMonth?: string;
}

/**
 * 残高補正。任意の日に実残高との差分を補正する（「締め」は作らない）。
 * 通常の現金・預金・投資・負債の差額を、残高調整費/収入との仕訳で合わせる。
 */
export interface AdjustmentMeta {
  /** 補正対象の科目（asset または liability）。 */
  accountId: string;
  /** アプリ上の理論残高。 */
  expectedBalance: number;
  /** ユーザーが入力した実残高。 */
  actualBalance: number;
  /** actual - expected。 */
  delta: number;
  /** 相手科目（残高調整費/収入）。 */
  counterpartAccountId: string;
}

/**
 * 月額化コスト。サブスク・年払い/前払い・耐久財・定期イベントを統一して扱う。
 * 登録時に「実際の支払い仕訳」（借方 認識先 / 貸方 支払い元、metadata.monthlyCostId 付き）を
 * 作る。一方で「生活コストとしての月割り認識」は仕訳ではなく、この項目の formula
 * （amount / costMonths を端数調整）から導出する分析レイヤで、ダッシュボードの生活コストに足す
 * （実支払い仕訳は二重計上しないよう除外する）。
 */
export type MonthlyCostKind =
  | 'subscription' // サブスク（月課金）
  | 'prepaid-service' // 年払い/前払いサービス
  | 'durable-asset' // 耐久財・買い替え
  | 'recurring-event'; // 定期イベント（車検等）

export type MonthlyCostStatus = 'active' | 'paused' | 'ended';

export interface MonthlyCostItem {
  id: string;
  name: string;
  kind: MonthlyCostKind;
  /** 1 回の契約・購入・更新で発生する総額（正の整数）。 */
  amount: number;
  /** その金額を何か月分の生活コストとして見るか（1 以上）。 */
  costMonths: number;
  /** 継続/更新する場合、何か月ごとに同じコストが再発するか。未指定なら 1 回限り（costMonths で終了）。 */
  repeatEveryMonths?: number;
  /** 初回の月 'YYYY-MM'。 */
  startMonth: string;
  /** 終了月 'YYYY-MM'。継続中なら未指定。 */
  endMonth?: string;
  /** 月ごとの認識先。会計 type により費用・収入減・BS 内振替として導出する。 */
  expenseAccountId: string;
  /**
   * 資産経由モデルの funding（資産化）仮想仕訳の貸方＝支払い元（role: daily-asset | payment-liability）。
   * 継続コスト対象（recognitionCreditAccountId が continuing-cost-asset）で使う。
   */
  paymentSourceAccountId?: string;
  /** 実際の支払い元（role: daily-asset または payment-liability）。旧モデル（実支払い仕訳あり）用。 */
  paymentAccountId?: string;
  /** liability 払いのとき、返済 CF を作るための支払い口座（role: daily-asset）。 */
  repaymentAccountId?: string;
  /**
   * 処分（売却・解約）時の売却額（最終サイクル額まで）。実績動的償却では損益を一括計上せず、
   * 最終サイクルの配分総額からこの額を控除する（超過分だけ売却益の実仕訳）。処分時に設定。
   */
  disposalProceedsAmount?: number;
  /** 仮想認識で貸方側に見せる継続コスト台帳科目。 */
  recognitionCreditAccountId?: string;
  status: MonthlyCostStatus;
  createdAt: string;
  updatedAt: string;
}

/**
 * 継続コストの売却・解約・故障処分の記録（監査用の独立エンティティ）。
 * 生成仕訳は `metadata.assetDisposalId` でこのレコードに紐づき、通常編集/削除は不可（fail-closed）。
 */
export interface AssetDisposal {
  id: string;
  /** 処分した MonthlyCostItem。 */
  monthlyCostId: string;
  /** 処分対象の継続コスト台帳科目（= MonthlyCostItem.recognitionCreditAccountId）。 */
  fixedAccountId: string;
  /** 処分日 (YYYY-MM-DD)。 */
  disposalDate: string;
  /** 売却額（故障・廃棄は 0）。正の整数または 0。 */
  proceedsAmount: number;
  /** 売却額の入金先（proceedsAmount > 0 のときのみ）。 */
  destinationAccountId?: string;
  /** 処分時点で費用配分へ収束させた合計。 */
  recognizedAmount: number;
  /** 処分後に残る価値。継続コスト処分では常に 0。 */
  remainingAmount: 0;
  /** この処分で生成した仕訳の ID 群（監査・追跡用）。 */
  generatedEntryIds: string[];
  createdAt: string;
  updatedAt: string;
}

/**
 * 定期ルール（毎月の支出・収入・振替）。
 * 「実仕訳の自動起票」方式: ルールは起票の道具で、正本は起票された実仕訳
 * （金額が揺れる月は起票後にその月の仕訳を編集する）。展開は domain/recurring.ts。
 * 継続コスト（費用の月割り認識 = 導出）とは別概念（こちらは実際の資金移動）。
 */
export interface RecurringRule {
  id: string;
  /** 摘要（起票される仕訳の description）。 */
  name: string;
  /** 毎月の既定額（正の整数）。 */
  amount: number;
  /** 毎月の日（1〜31。月に無い日は月末）。 */
  dayOfMonth: number;
  /** 行き先（費用カテゴリ / 資金 / 投資）。 */
  debitAccountId: string;
  /** 源泉（資金 / カード / 収入カテゴリ）。 */
  creditAccountId: string;
  /** 起票開始月 'YYYY-MM'。再開時は現在月へ更新される（停止中の月を遡って起票しない）。 */
  startMonth: string;
  /**
   * 起票済みカーソル（この月まで処理済み）。キャッチアップが管理する。
   * 起票済み仕訳をユーザーが削除しても再起票しない（スキップの尊重）。
   */
  postedThroughMonth?: string;
  /** 停止中は起票しない。 */
  paused?: boolean;
  createdAt: string;
  updatedAt: string;
}

/**
 * 予定キャッシュフロー（将来の現金の出入り）。
 * 「いつ費用認識するか」とは別概念で、「いつ現金が動くか」を保持する。
 * 予定は通常仕訳一覧へ大量生成せず、ここに置く。実績化で 1 件の仕訳を作る。
 */
export type CashflowDirection = 'inflow' | 'outflow' | 'transfer';
export type CashflowSource = 'manual' | 'credit-card' | 'installment' | 'reserve';
export type CashflowStatus = 'planned' | 'posted' | 'cancelled';

export interface CashflowSchedule {
  id: string;
  title: string;
  /** ISO 日付 (YYYY-MM-DD)。 */
  dueDate: string;
  /** 正の整数（最小通貨単位）。 */
  amount: number;
  direction: CashflowDirection;
  /** 現金が出入りする口座（asset）。 */
  accountId: string;
  /** 相手科目。負債返済なら liability、収入予定なら revenue 等。実績化に必要。 */
  counterAccountId?: string;
  source: CashflowSource;
  status: CashflowStatus;
  /** posted のとき、作成された仕訳の ID。 */
  linkedEntryId?: string;
  /** 実績化時に仕訳へコピーする仕訳全体タグ。 */
  entryTagIds?: string[];
  /** 月額化コスト（負債払い）の返済予定として生成されたとき、紐づく MonthlyCostItem の ID。 */
  monthlyCostId?: string;
  createdAt: string;
  updatedAt: string;
}

/**
 * 目的別資金（取り置き）。**聖域化・集約モデル / A=短期の封筒分けのみ**。目的ごとの勘定科目は作らず、
 * 単一の集約口座（reserve-ledger『取り置き資金』）に寄せる。目的別残高は仕訳の `metadata.reserveId`
 * 集計で導出する（`reserveBalances`）。**目標額・目標期限・利回りは持たない**（長期の目標/投資前提は将来別途）。
 */
export interface ReserveItem {
  id: string;
  name: string;
  /** 取り置き残高を寄せる集約口座（全取り置き共通の reserve-ledger）。 */
  reserveAccountId: string;
  /**
   * どの資金口座から取り置いたか（daily-asset。既定=表示順先頭）。資産内訳で親口座の下部構造として
   * 見せる手がかり。将来は投資資産などにも拡張する余地（現状は表示の所属ヒントに留める）。
   */
  parentAccountId?: string;
  note?: string;
  createdAt: string;
  updatedAt: string;
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
  /** 付帯情報（入力方法・逆仕訳リンク・自動生成の由来など）。任意。 */
  metadata?: EntryMetadata;
  /** 仕訳全体タグ（旅行・帰省・学会 等のイベント/目的ラベル）。 */
  tagIds?: string[];
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
  /**
   * export 元が基準とした編集リビジョン（= export 時点の meta.revision）。
   * foundation の交換封筒(ExchangeEnvelope)の `revision` に対応し、import の楽観的
   * 衝突検出に使う（v1 の baseRevision/currentRevision は export 時に常に同値だったため
   * v2 では単一フィールドに統合）。import 成功時は meta.revision をこの値へ合わせる。
   */
  revision: number;
  accounts: Account[];
  journalEntries: JournalEntry[];
  cashflowSchedules: CashflowSchedule[];
  reserves: ReserveItem[];
  tags: Tag[];
  monthlyCostItems: MonthlyCostItem[];
  assetDisposals: AssetDisposal[];
  /** 定期ルール。交換 JSON では必須（旧形式はリポジトリ外で一度だけ変換する）。 */
  recurringRules: RecurringRule[];
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
  /** 実仕訳（保存される正本）。保存系・export・残高チェックはこれだけを見る。 */
  journalEntries: JournalEntry[];
  cashflowSchedules: CashflowSchedule[];
  reserves: ReserveItem[];
  tags: Tag[];
  monthlyCostItems: MonthlyCostItem[];
  assetDisposals: AssetDisposal[];
  recurringRules: RecurringRule[];
}
