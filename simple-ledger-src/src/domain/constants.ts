/** エクスポート/DB を識別するアプリ ID。import 時の照合に使う。 */
export const APP_ID = 'snishi-code.simple-ledger' as const;

/** 現行スキーマ版。互換性のない変更ごとに +1 し、migrations を追加する。 */
export const SCHEMA_VERSION = 1 as const;
