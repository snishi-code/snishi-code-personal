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

/**
 * IndexedDB のバージョン。version 7 で予定キャッシュフロー（cashflowSchedules）ストアを削除した
 * （機能ごと全廃 = 予定は未来日付の通常仕訳へ一本化。version 6 は取り置き機能のストア削除、
 * version 5 は旧・処分機能のストア削除、version 4 は旧 allocations ストアの削除）。
 */
export const DB_VERSION = 7 as const;

/** エクスポート/import 照合用のアプリ ID（封筒 appId）。v1 とは別 ID。 */
export const APP_ID = 'snishi-code.simple-ledger-v2' as const;

/**
 * 現行スキーマ版。v2 は v1 の最終形（v16 相当の最新モデル）を **1** として開始した
 * （レガシー migration は持たない・仕様§16）。互換性のない変更ごとに +1 する。
 * version 7 = 予定キャッシュフロー（CashflowSchedule）の全廃。「予定 = 未来日付の通常仕訳」へ
 * 一本化し、export からも cashflowSchedules フィールドを削除。
 * version 6 = 定期ルールを時間軸上の線分にし、RecurringRule.startDate を必須化。
 * version 5 = 取り置き機能の全廃（store・仕訳メタデータ・専用 role を含む）+
 * Account.movable（「自由に動かせる」フラグ）追加。
 * migration step は追加しない（作者決定＝後方互換を持たない）。旧版 JSON /
 * スナップショットは unsupported-version として fail-closed に拒否される。
 */
export const SCHEMA_VERSION = 7 as const;

/**
 * revision は JSON / IndexedDB の双方で安全な整数だけを扱う。
 * 上限到達時は黙って丸めず、保存境界で fail-closed に停止する。
 */
export const MAX_LEDGER_REVISION = Number.MAX_SAFE_INTEGER;

/** localStorage 等のキー接頭辞（ポインタ/フラグ用。v1 の 'simple-ledger' 系と分離）。 */
export const LOCAL_PREFIX = 'slv2.' as const;

/** Service Worker のキャッシュ名接頭辞（sw.js が `${CACHE_NAME_PREFIX}<version>` で使う）。 */
export const CACHE_NAME_PREFIX = 'simple-ledger-v2-' as const;
