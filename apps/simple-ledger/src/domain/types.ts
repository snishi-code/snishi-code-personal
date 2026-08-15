/*
 * 会計ドメインの型。
 *
 * 旧 GAS の source/dest や +/- 表現は使わない。すべて複式簿記の
 * 借方(debit) / 貸方(credit) で表現する。
 *
 * 金額は表示単位の 1/100 を最小単位とする整数（minor）で持つ。
 * これにより保存・合算で浮動小数を使わない。表示単位は settings.currency。
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
  /**
   * 科目が存在する最初の日（両端を含む）。**未設定 = 過去へ開いた線分**（過去側制限なし・
   * §A 案1 2026-08-11。旧「createdAt を暗黙開始日とみなす」は廃止）。新規作成の既定も空欄で、
   * アプリが端点を書かない。作者が科目編集で明示したときだけ保存される。
   */
  startDate?: string;
  /** 科目が存在する最後の日（両端を含む）。アーカイブ操作で記録し、解除時に削除する。 */
  endDate?: string;
  /**
   * 終了点を持つ（または旧形式で終了済みの）科目。候補表示の現在性はこの値だけで決めず、
   * 仕訳日と startDate/endDate の線分から導出する。
   */
  archived: boolean;
  note?: string;
  /**
   * 「自由に動かせる」フラグ（role: daily-asset のみ・既定 ON）。
   * **`false` のときだけ「自由に動かせない」**（undefined = 動かせる）。`true` は保存境界で
   * undefined へ正規化する（レコードを最小に保つ）。false の科目（Suica・チャージ残高など、
   * 支払いには使えるが自由に引き出せないもの）は資金繰りの原資「自由に動かせるお金」から外れる。
   * 貸借対照表・資産内訳は従来どおり全資産を出す（資金繰りだけ絞る）。
   */
  movable?: boolean;
  /**
   * 返済設定（負債科目のみ: payment-liability / other-liability）。
   * 毎月の返済元となる資金口座（role: daily-asset）。資金繰り画面の返済計画
   * （未来日付の実仕訳の一括起票）で既定値になる。予定の自動生成はしない。
   */
  repaymentAccountId?: string;
  /** 毎月の返済日（1〜31）。31 など月に無い日はその月の月末として扱う。 */
  repaymentDay?: number;
  /**
   * 想定利回り（投資科目のみ: investment-asset）。年率のベーシスポイント整数
   * （300 = 3.00%・範囲 -9999〜100000）。浮動小数は保存しない。
   * 未設定 or 0 = 投影なし。projectionAccountId と必ずセットで設定する（片方だけは保存拒否）。
   * 表示専用の導出（domain/investmentProjection.ts）にだけ使い、保存判断には影響しない。
   */
  annualReturnBp?: number;
  /**
   * 利回り投影の計上先（income-category の科目・soft reference）。毎月
   * 「計上先 → この科目」の評価益が仮想仕訳として生まれる（継続コストの月割りと対の掛け算）。
   * soft reference = accountRefs の「使用中」判定に入れない。参照先が消えたら
   * 投影エンジンが fail-closed に生成を止める（保存は壊さない）。
   */
  projectionAccountId?: string;
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
 * @deprecated タグ機能は 2026-08-15 に撤去した（実ユーズ 0 件・作者決定）。
 * 型は交換フォーマット v12 の形を保つためだけに残る「受理のみ」の存在で、
 * 作る経路（画面・保存 API）は無い。import されたタグは黙って保持し export へ素通しする。
 * フィールドごとの削除は v13 の版上げに同乗させる。
 */
export type TagScope = 'entry';

/** @deprecated 撤去済み（受理のみ・v13 でフィールドごと削除）。TagScope を参照。 */
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
  /**
   * 継続コスト資産に紐づく保存仕訳の印。
   *  - `monthlyCostRecovery` なし = **購入の仕訳**（借方 継続コスト台帳 / 貸方 支払い元）。
   *    item と 1:1 で、金額・日付は item の amount / startDate と双方向ミラー。削除不可
   *    （item 削除で cascade）。
   *  - `monthlyCostRecovery: true` = **回収の振替**（借方 振替先 / 貸方 継続コスト台帳）。
   *    アーカイブ時の売却・返金。普通の振替として編集・削除できる。
   * 台帳を借方/貸方に持つ保存仕訳はこの 2 種類だけ（保存境界・schema の不変条件）。
   */
  monthlyCostId?: string;
  /** 回収の振替の印（monthlyCostId とペア。貸方 = 継続コスト台帳）。 */
  monthlyCostRecovery?: true;
  /**
   * 継続コスト（資産経由モデル）の仮想仕訳の印。これらは **保存されない導出専用**で、
   * `reportEntriesForAsOf` の結果にのみ現れる。実仕訳(`journalEntries`)・保存系・export には入れない。
   */
  virtual?: true;
  /** 仮想仕訳が属する MonthlyCostItem(継続コスト)の ID。 */
  continuousCostId?: string;
  /** 仮想仕訳の種別。funding=資産化（支払元→対象資産）/ monthly-allocation=月割り（対象資産→月割り先）。 */
  ccKind?: 'funding' | 'monthly-allocation';
  /**
   * 投資利回り投影の仮想仕訳の印（対象の投資科目 ID）。保存されない導出専用で、
   * `displayEntriesForAsOf` の結果にのみ現れる（保存不変条件用の `reportEntriesForAsOf`
   * には決して合流しない）。実仕訳・保存系・export には入れない。
   */
  investmentProjectionOf?: string;
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
 * 継続コスト資産。項目名・金額・開始日・終了日を持つ償却対象（4項目モデル）。
 *
 *  - 開始日は**購入の仕訳の日付と完全一致**（双方向ミラー。日付を変えるのは仕訳側）。
 *  - 終了日は**任意**。未設定なら費用の割り振りを一切しない（残存価値 = 全額が BS に乗るだけ）。
 *    設定すると開始日〜終了日で月割りされ、過去にも未来にも計算で生まれる仕訳が展開される。
 *  - 費用の行はデータに残らない導出（monthlyCost.ts / continuousCost.ts）。
 *  - アーカイブは「終了日を過ぎた」の導出のみ（status フィールドは持たない）。
 */
export interface MonthlyCostItem {
  id: string;
  /** 項目名。 */
  name: string;
  /** 金額（正の整数）= 割り振る総額の正本。購入の仕訳の金額と双方向ミラー。 */
  amount: number;
  /** 開始日 'YYYY-MM-DD'（= 購入の仕訳の日付と完全一致）。 */
  startDate: string;
  /** 終了日 'YYYY-MM-DD'。任意。未設定 = まだ費用にしない。 */
  endDate?: string;
  /** 計上先（費用カテゴリのほか、給与など収入カテゴリも可。内部集約・残高調整は不可）。 */
  expenseAccountId: string;
  createdAt: string;
  updatedAt: string;
}

/**
 * 定期ルール（毎月の支出・収入・振替）。
 * 「実仕訳の自動起票」方式: ルールは起票の道具で、正本は起票された実仕訳
 * （金額が揺れる月は起票後にその月の仕訳を編集する）。展開は domain/recurring.ts。
 * 行き先が費用または収入（差引形 = 給与から差し引く形）なら起票時に継続コスト item を作り、
 * ルール自体は費用/収入減を直接作らない。それ以外（収入・振替・積立）は行き先へ直接起票する。
 */
export interface RecurringRule {
  id: string;
  /** 摘要（起票される仕訳の description）。 */
  name: string;
  /** 毎月の既定額（正の整数）。 */
  amount: number;
  /** 毎月の日（1〜31。月に無い日は月末）。 */
  dayOfMonth: number;
  /** 何か月ごとに起票するか（必須。1 = 毎月）。位相の基点は startMonth。 */
  everyMonths: number;
  /**
   * 正規化済みの計上先（任意）。行き先 role が費用または収入（差引形）なら必ず継続コスト化し、
   * 起票のたびに item（id = `ccr-{ruleId}-{month}`・endDate = 周期末）を同一 tx で自動生成し、
   * 購入の仕訳の借方は継続コスト台帳に固定される。v7 の費用・差引形ルールはこの
   * 正規形だけを保存する。
   */
  spreadExpenseAccountId?: string;
  /** 保存上の借方（月割りルールでは継続コスト台帳、それ以外では論理的な行き先）。 */
  debitAccountId: string;
  /** 源泉（資金 / カード / 収入カテゴリ）。 */
  creditAccountId: string;
  /** 位相の基点 'YYYY-MM'。 */
  startMonth: string;
  /** ルールの存在開始日（含む）。起票周期の位相とは独立する。 */
  startDate: string;
  /** 金額変更の分割で生まれた後継 segment が参照する直前のルール。 */
  splitFromRuleId?: string;
  /**
   * ルールの存在終了日（含まない）。未設定 = 将来へ継続する。
   * 指定日の起票を旧ルールに含めず、同日開始の後継ルールへ一意に渡せるよう半開区間にする。
   */
  endDate?: string;
  /**
   * 起票済みカーソル（この月まで処理済み）。キャッチアップが管理する。
   * 起票済み仕訳をユーザーが削除しても再起票しない（スキップの尊重）。
   */
  postedThroughMonth?: string;
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
  /**
   * @deprecated タグ機能は撤去済み（2026-08-15）。新規に付く経路は無いが、import 済み
   * データの値は黙って保持し export へ素通しする（v13 でフィールドごと削除）。
   */
  tagIds?: string[];
  /**
   * 諸口（複数フロー行の束）のグループ ID。v12 で**予約のみ**（2026-08-11 設計合意・
   * グループ ID 方式）。UI・集計は未実装で、検証は形式のみ。グループに「2 行以上」等の
   * 不変条件は将来も持たせない（1 行に減ったら普通の仕訳に退化する設計）。
   */
  groupId?: string;
  createdAt: string;
  updatedAt: string;
}

export interface Settings {
  ledgerName: string;
  /**
   * 金額の表示単位。ISO 4217 の列挙・換算はせず、後置表示する 1〜8 文字の
   * ユーザー入力文字列。空白だけは保存しない。
   */
  currency: string;
  /** 表示する小数桁数（0|1|2・既定 0）。入力欄の刻みも連動する。保存値は常に 1/100 単位。 */
  displayFractionDigits: 0 | 1 | 2;
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
export type SnapshotReason = 'import' | 'restore';

export interface Snapshot {
  id: string;
  createdAt: string;
  /** 永続化する理由コード。表示文言は i18n で解決する。 */
  reason: SnapshotReason;
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
  tags: Tag[];
  monthlyCostItems: MonthlyCostItem[];
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
  tags: Tag[];
  monthlyCostItems: MonthlyCostItem[];
  recurringRules: RecurringRule[];
}
