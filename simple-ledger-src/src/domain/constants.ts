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
 *             tag.scope の line・both を廃止）。JournalLine に任意の instrumentId を追加。 */
export const SCHEMA_VERSION = 11 as const;

/** 既定の管理区分（『個人用』）。seed と migration で同じ id を使い、既存データを寄せる。 */
export const DEFAULT_MANAGEMENT_SCOPE_ID = 'scope-personal' as const;
export const DEFAULT_MANAGEMENT_SCOPE_NAME = '個人用' as const;
