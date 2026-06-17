/*
 * simple-ledger-v2 の識別子・バージョン定数（監査用に一箇所へ集約・仕様§14）。
 *
 * v1 の識別子（DB 名 'simple-ledger' / appId 'snishi-code.simple-ledger'）は
 * **絶対に使わない**（仕様§7: v2 は識別子を完全分離し、v1 のローカルデータ・
 * 交換ファイルと衝突/誤取り込みしない）。v1 ファイルの import は appId 不一致で
 * not-our-file として fail-closed に拒否される。
 */

/** IndexedDB のデータベース名。v1 の 'simple-ledger' とは別 DB。 */
export const DB_NAME = 'simple-ledger-v2' as const;

/** IndexedDB のバージョン。v2 は 12 ストア構成を version 1 で一括作成する。 */
export const DB_VERSION = 1 as const;

/** エクスポート/import 照合用のアプリ ID（封筒 appId）。v1 とは別 ID。 */
export const APP_ID = 'snishi-code.simple-ledger-v2' as const;

/**
 * 現行スキーマ版。v2 は v1 の最終形（v16 相当の最新モデル）を **1** として開始する
 * （レガシー migration は持たない・仕様§16）。互換性のない変更ごとに +1 し、
 * exportImport.ts の migration チェーンへ step を追加する。
 */
export const SCHEMA_VERSION = 1 as const;

/** localStorage 等のキー接頭辞（ポインタ/フラグ用。v1 の 'simple-ledger' 系と分離）。 */
export const LOCAL_PREFIX = 'slv2.' as const;

/** Service Worker のキャッシュ名接頭辞（sw.js が `${CACHE_NAME_PREFIX}<version>` で使う）。 */
export const CACHE_NAME_PREFIX = 'simple-ledger-v2-' as const;
