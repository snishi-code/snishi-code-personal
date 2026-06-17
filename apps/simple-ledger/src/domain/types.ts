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
  createdAt: string;
  updatedAt: string;
}

/**
 * 管理区分。「楽天カードか JAL カードか」より先に「個人用/事業用/家族用のどの財布か」を扱う軸。
 * 別会計ではなく、分析・入力候補を分けるための軸。グローバル PL/BS の複式整合は勘定科目で守る。
 * 初期値は『個人用』1 件のみ。
 */
export interface ManagementScope {
  id: string;
  name: string;
  archived?: boolean;
  createdAt: string;
  updatedAt: string;
}

/**
 * 支払い手段の細目（任意）。粗い科目（クレジットカード/チャージ残高/預金）の下に、
 * 楽天カード・三井住友カード・Suica・PayPay・楽天銀行などを任意で持つ。
 * 細目別残高の厳密管理はまだ行わない（指定された行だけ細目別に集計できる程度）。
 */
export type AccountInstrumentKind = 'bank' | 'card' | 'prepaid' | 'cash' | 'other';

export interface AccountInstrument {
  id: string;
  /** どの管理区分に属する細目か。 */
  managementScopeId: string;
  /** 親の粗い科目（例: クレジットカード / チャージ残高 / 預金）。 */
  accountId: string;
  name: string;
  kind: AccountInstrumentKind;
  archived: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface JournalLine {
  accountId: string;
  side: Side;
  /** 正の整数（最小通貨単位）。 */
  amount: number;
  /** 支払い手段の細目（任意）。指定時、instrument.accountId === accountId である必要がある。 */
  instrumentId?: string;
}

/**
 * タグ。勘定科目を増やさずに、旅行・帰省・学会・引っ越しなどイベント/目的ラベルで
 * 仕訳を後から抽出する分析軸。PL/BS の会計ロジックは変えない。
 * タグは常に「仕訳全体（entry）」に付く。カード名・銀行名・Pay 系名はタグにしない
 * （それらは支払い手段の細目 = AccountInstrument で扱う）。
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
  /** 按分支出から生成された仕訳のとき、紐づく AllocationItem の ID。 */
  allocationId?: string;
  /** 按分仕訳の役割。source=原始仕訳 / recognition=月次認識仕訳。 */
  allocationRole?: 'source' | 'recognition';
  /** 残高補正（実残高との差分調整）で作られた仕訳の付帯情報。 */
  adjustment?: AdjustmentMeta;
  /** 月額化コストの実支払い仕訳のとき、紐づく MonthlyCostItem の ID（通常編集/削除は不可）。 */
  monthlyCostId?: string;
  /** 固定資産の売却・故障処分で生成された仕訳のとき、紐づく AssetDisposal の ID（通常編集/削除は不可）。 */
  assetDisposalId?: string;
  /**
   * 取り置き資金（聖域化・集約モデル）の目的を表す ReserveItem の ID。
   * 取り置きは目的ごとの勘定科目を作らず、単一の集約口座（reserve-ledger）に寄せ、目的別残高は
   * この `reserveId` 付き仕訳の集計で導出する（`reserveBalances`）。
   */
  reserveId?: string;
  /**
   * 継続コスト（資産経由モデル）の仮想仕訳の印。これらは **保存されない導出専用**で、
   * `Ledger.derivedEntries` にのみ現れる。実仕訳(`journalEntries`)・保存系・export には入れない。
   */
  virtual?: true;
  /** 仮想仕訳が属する MonthlyCostItem(継続コスト)の ID。 */
  continuousCostId?: string;
  /** 仮想仕訳の種別。funding=資産化(支払元→対象資産) / recognition=認識(対象資産→費用カテゴリ)。 */
  ccKind?: 'funding' | 'recognition';
}

/**
 * 残高補正。任意の日に実残高との差分を補正する（「締め」は作らない）。
 *  - unknown-balance: 通常の現金/預金差額 → 残高調整費/収入
 *  - investment-valuation: 投資残高差額 → 投資評価損/益（生活コストとは別）
 */
export type AdjustmentKind = 'unknown-balance' | 'investment-valuation';

export interface AdjustmentMeta {
  kind: AdjustmentKind;
  /** 補正対象の科目（asset または liability）。 */
  accountId: string;
  /** アプリ上の理論残高。 */
  expectedBalance: number;
  /** ユーザーが入力した実残高。 */
  actualBalance: number;
  /** actual - expected。 */
  delta: number;
  /** 相手科目（残高調整費/収入 or 投資評価損/益）。 */
  counterpartAccountId: string;
}

/** 按分支出（長期の生活コストを月割りで費用認識する）。 */
export type AllocationStatus = 'active' | 'completed' | 'disposed' | 'settled';

export interface AllocationItem {
  id: string;
  /** 表示名（例: PC）。 */
  name: string;
  /** 総額（最小通貨単位の整数）。 */
  totalAmount: number;
  /** 按分月数（2 以上）。 */
  months: number;
  /** 認識開始月 'YYYY-MM'。 */
  startMonth: string;
  /** 月次認識の費用カテゴリ。 */
  expenseAccountId: string;
  /** 支払元（asset または liability）。 */
  paymentAccountId: string;
  /** 按分中資産（繰延）科目。 */
  deferredAccountId: string;
  /** 原始仕訳（按分中資産 / 支払元）の ID。 */
  sourceEntryId: string;
  /** 月次認識仕訳の ID（months 件）。 */
  recognitionEntryIds: string[];
  /** MVP は active を基本。disposed/settled は次フェーズ。 */
  status: AllocationStatus;
  createdAt: string;
  updatedAt: string;
}

/**
 * 月額化コスト。サブスク・年払い/前払い・耐久財・定期イベントを統一して扱う。
 * 登録時に「実際の支払い仕訳」（借方 費用カテゴリ / 貸方 支払い元、metadata.monthlyCostId 付き）を
 * 作る。一方で「生活コストとしての月割り認識」は仕訳ではなく、この項目の formula
 * （amount / costMonths を端数調整）から導出する分析レイヤで、ダッシュボードの生活コストに足す
 * （実支払い仕訳は二重計上しないよう除外する）。
 * 既存の按分(allocations)から移行した項目は sourceAllocationId を持つ。
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
  /** どの管理区分の月額化コストか。migration で既存は『個人用』に寄せる。 */
  managementScopeId: string;
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
  /** 月額化先の費用カテゴリ（role: expense-category）。 */
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
  /** 既存 AllocationItem 由来なら紐づける。 */
  sourceAllocationId?: string;
  /** この月額化のもとになった実仕訳（固定資産購入など）。Journal 仮想行の由来表示に使う。 */
  sourceEntryId?: string;
  /** 仮想認識で貸方側に見せる科目（固定資産など）。指定時、Journal 仮想行は「この科目 → 費用」で表示。 */
  recognitionCreditAccountId?: string;
  status: MonthlyCostStatus;
  createdAt: string;
  updatedAt: string;
}

/**
 * 固定資産の売却・故障処分の記録（監査用の独立エンティティ）。
 * 固定資産由来の MonthlyCostItem を途中終了し、未認識残高の消し込みと売却損益の仕訳を生成したときに作る。
 * 生成仕訳は `metadata.assetDisposalId` でこのレコードに紐づき、通常編集/削除は不可（fail-closed）。
 */
export interface AssetDisposal {
  id: string;
  /** 処分した固定資産由来の MonthlyCostItem。 */
  monthlyCostId: string;
  /** 処分対象の固定資産科目（= MonthlyCostItem.recognitionCreditAccountId）。 */
  fixedAccountId: string;
  managementScopeId: string;
  /** 処分日 (YYYY-MM-DD)。 */
  disposalDate: string;
  /** 売却額（故障・廃棄は 0）。正の整数または 0。 */
  proceedsAmount: number;
  /** 売却額の入金先（proceedsAmount > 0 のときのみ）。 */
  destinationAccountId?: string;
  /** 処分月の前月までに月額化 formula で認識済みの合計。 */
  recognizedAmount: number;
  /** amount - recognizedAmount（0 未満にしない）。 */
  remainingAmount: number;
  /** この処分で生成した仕訳の ID 群（監査・追跡用）。 */
  generatedEntryIds: string[];
  createdAt: string;
  updatedAt: string;
}

/**
 * 予定キャッシュフロー（将来の現金の出入り）。
 * 「いつ費用認識するか(allocation)」とは別概念で、「いつ現金が動くか」を保持する。
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
  /** どの管理区分の予定か。実績化時に仕訳へ引き継ぐ。 */
  managementScopeId: string;
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
   * どの資金口座から取り置いたか（daily-asset。既定=預金）。資産内訳で親口座の下部構造として
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
  /** どの管理区分（個人用/事業用/家族用 等）の仕訳か。migration で既存は『個人用』に寄せる。 */
  managementScopeId: string;
  /** 付帯情報（入力方法・逆仕訳リンク・按分計画など）。任意。 */
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
  managementScopes: ManagementScope[];
  accountInstruments: AccountInstrument[];
  accounts: Account[];
  journalEntries: JournalEntry[];
  allocations: AllocationItem[];
  cashflowSchedules: CashflowSchedule[];
  reserves: ReserveItem[];
  tags: Tag[];
  monthlyCostItems: MonthlyCostItem[];
  assetDisposals: AssetDisposal[];
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
  managementScopes: ManagementScope[];
  accountInstruments: AccountInstrument[];
  accounts: Account[];
  /** 実仕訳（保存される正本）。保存系・export・残高チェックはこれだけを見る。 */
  journalEntries: JournalEntry[];
  /**
   * 導出専用の仕訳列 = 実仕訳 + 継続コストの仮想仕訳（funding/recognition）。
   * PL/BS/支出/推移/Journal 表示など**集計はこれを使う**（単一正本）。保存されない。
   */
  derivedEntries: JournalEntry[];
  allocations: AllocationItem[];
  cashflowSchedules: CashflowSchedule[];
  reserves: ReserveItem[];
  tags: Tag[];
  monthlyCostItems: MonthlyCostItem[];
  assetDisposals: AssetDisposal[];
}
