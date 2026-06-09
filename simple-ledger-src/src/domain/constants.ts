/** エクスポート/DB を識別するアプリ ID。import 時の照合に使う。 */
export const APP_ID = 'snishi-code.simple-ledger' as const;

/** 現行スキーマ版。互換性のない変更ごとに +1 し、migrations を追加する。
 *  v1 → v2: 按分支出（allocations）を追加。
 *  v2 → v3: 予定キャッシュフロー（cashflowSchedules）と目的別資金（reserves）を追加。
 *  v3 → v4: タグ（tags）を追加。
 *  v4 → v5: 残高補正（metadata.adjustment）の永続化に伴う版上げ（構造変更なし＝恒等移行）。
 *  v5 → v6: 勘定科目に role（UI 用の役割）を追加。既存科目は type 等から推定して補完。
 *  v6 → v7: 月額化コスト（monthlyCostItems）を追加。既存按分から移行生成する。
 *  v7 → v8: 資金目標（fundingGoals）を追加（空配列補完）。
 *  v8 → v9: 予定CFの direction に transfer（口座間移動）を追加。許容値が増える＝
 *           新しい JSON を旧 v8 アプリが読むと validation error になり得るため版を上げる
 *           （既存データの構造変更はなし＝恒等移行）。
 *  v9 → v10: AccountRole に fixed-asset（固定資産）を追加 + MonthlyCostItem に任意フィールド
 *            （recognitionCreditAccountId / sourceEntryId）。許容値・任意項目が増えるため版を上げる
 *            （既存データの構造変更はなし＝恒等移行）。
 *  v10 → v11: 管理区分（managementScopes）と支払い手段の細目（accountInstruments）を追加。
 *             仕訳・予定CF・月額化コストに managementScopeId を必須化（既存は『個人用』へ寄せる）。
 *             タグは「仕訳全体のみ」に再設計（明細タグ JournalLine.tagIds / 予定CFの明細タグ /
 *             tag.scope の line・both を廃止）。JournalLine に任意の instrumentId を追加。
 *  v11 → v12: 固定資産の売却・故障処分（assetDisposals）を追加（空配列補完＝恒等移行）。
 *             JournalEntry.metadata に任意の assetDisposalId を追加（許容項目が増えるため版を上げる）。
 *  v12 → v13: 継続コストを資産経由モデルへ統一。AccountRole に continuing-cost-asset を追加、
 *             MonthlyCostItem に任意 paymentSourceAccountId を追加、EntryMetadata に
 *             continuousCostId/ccKind/virtual を追加（許容値・任意項目が増えるため版を上げる）。
 *             破壊的方針（未実運用）: 旧モデルの月額化/固定資産月額化の生成仕訳・MonthlyCostItem は
 *             混在を避けるため migration でクリアする。
 *  v13 → v14: 勘定科目の聖域化。継続コスト対象（YouTube/洗濯機 等）を品目別の
 *             continuing-cost-asset 科目として自動作成するのをやめ、未消化残高を単一の集約台帳口座
 *             （CONTINUOUS_COST_LEDGER_ACCOUNT_ID『継続コスト台帳』）に寄せる。既存の品目別科目は
 *             MonthlyCostItem.recognitionCreditAccountId を集約口座へ付け替え、参照されなくなった
 *             旧科目を削除する（品目名は MonthlyCostItem.name に残るため失われない）。
 *  v14 → v15: 取り置き資金の聖域化・集約。目的ごとの reserve-asset 科目をやめ、単一の集約口座
 *             （RESERVE_LEDGER_ACCOUNT_ID『取り置き資金』）に寄せる。取り置き仕訳に `metadata.reserveId`
 *             を付与し目的別残高はその集計で導出。既存の目的別科目を集約へ付け替え、関連振替仕訳を
 *             reserveId でタグ付けし、参照されなくなった旧科目を削除する（目的名は ReserveItem.name に残る）。 */
export const SCHEMA_VERSION = 15 as const;

/** 既定の管理区分（『個人用』）。seed と migration で同じ id を使い、既存データを寄せる。 */
export const DEFAULT_MANAGEMENT_SCOPE_ID = 'scope-personal' as const;
export const DEFAULT_MANAGEMENT_SCOPE_NAME = '個人用' as const;

/**
 * 継続コストの未消化残高を寄せる単一の集約台帳口座（role=continuing-cost-asset・内部集約）。
 * 品目ごとに資産科目を作らず、全継続コストの funding/recognition をこの 1 口座に通す。
 * find-or-create で 1 つだけ存在させる（ADJUSTMENT_ACCOUNTS と同じシングルトン方針）。
 * 勘定科目管理 UI には出さず、BS / 資産内訳には 1 行で表示する。
 */
export const CONTINUOUS_COST_LEDGER_ACCOUNT_ID = 'continuing-cost-ledger' as const;
export const CONTINUOUS_COST_LEDGER_ACCOUNT_NAME = '継続コスト台帳' as const;

/**
 * 取り置き資金（目的別）の残高を寄せる単一の集約口座（role=reserve-asset・内部・聖域化）。
 * 目的ごとに勘定科目を作らず、全取り置きをこの 1 口座に通し、目的別残高は仕訳の `metadata.reserveId`
 * 集計で導出する。勘定科目管理 UI には出さず、資産内訳では資金グループの下部に入れ子表示する。
 */
export const RESERVE_LEDGER_ACCOUNT_ID = 'reserve-ledger' as const;
export const RESERVE_LEDGER_ACCOUNT_NAME = '取り置き資金' as const;
