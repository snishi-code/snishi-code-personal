/** エクスポート/DB を識別するアプリ ID。import 時の照合に使う。 */
export const APP_ID = 'snishi-code.simple-ledger' as const;

/** 現行スキーマ版。互換性のない変更ごとに +1 し、migrations を追加する。
 *  v1 → v2: 按分支出（allocations）を追加。
 *  v2 → v3: 予定キャッシュフロー（cashflowSchedules）と目的別資金（reserves）を追加。
 *  v3 → v4: タグ（tags）を追加。
 *  v4 → v5: 残高補正（metadata.adjustment）の永続化に伴う版上げ（構造変更なし＝恒等移行）。
 *  v5 → v6: 勘定科目に role（UI 用の役割）を追加。既存科目は type 等から推定して補完。
 *  v6 → v7: 月額化コスト（monthlyCostItems）を追加。既存按分から移行生成する。
 *  v7 → v8: 資金目標（fundingGoals）を追加（空配列補完）。 */
export const SCHEMA_VERSION = 8 as const;
