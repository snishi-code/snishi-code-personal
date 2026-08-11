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
 * IndexedDB のバージョン。version 9 はストア構成の変更なし（SCHEMA_VERSION 9 =
 * ImportProfile.archived 追加と対で上げる。版の対応を 1:1 に保つため）。
 * version 8 で CSV 取込（Import Profile）の 3 ストア
 * （importProfiles / profileBindings / importDecisions）を追加した。
 * version 7 で予定キャッシュフロー（cashflowSchedules）ストアを
 * 現行構成から外した（機能ごと全廃 = 予定は未来日付の通常仕訳へ一本化）。
 * upgrade は不足ストアの作成だけを行い、**旧版のストアは削除しない**（旧版 DB は
 * schemaVersion 検査で復旧面へ送られ、復旧面の「DB 初期化」= DB 削除でのみ消える。
 * 黙って削除しない・監査 P1-1）。
 */
export const DB_VERSION = 9 as const;

/** エクスポート/import 照合用のアプリ ID（封筒 appId）。v1 とは別 ID。 */
export const APP_ID = 'snishi-code.simple-ledger-v2' as const;

/**
 * 現行スキーマ版。v2 は v1 の最終形（v16 相当の最新モデル）を **1** として開始した
 * （レガシー migration は持たない・仕様§16）。互換性のない変更ごとに +1 する。
 * version 9 = 取込プロファイルのアーカイブ（ImportProfile.archived・optional・既定 false）。
 * profile の上書き保存を廃止し「旧をアーカイブして新規作成」へ（作者決定 2026-08-11）。
 * 以降の v9 内フィールド追加は後続の変更がこの版のまま行う:
 *  - ProfileBinding.importFromDate（取込開始日・optional・明示値のみ検証・2026-08-11 追加済み）
 *  - Account.annualReturnBp（予定）
 * version 8 = CSV 取込（Import Profile）。importProfiles / profileBindings /
 * importDecisions を交換 JSON の必須フィールドとして追加し、EntryMetadata に取込由来
 * （importSource ほか）を追加。
 * version 7 = 予定キャッシュフロー（CashflowSchedule）の全廃。「予定 = 未来日付の通常仕訳」へ
 * 一本化し、export からも cashflowSchedules フィールドを削除。
 * version 6 = 定期ルールを時間軸上の線分にし、RecurringRule.startDate を必須化。
 * version 5 = 取り置き機能の全廃（store・仕訳メタデータ・専用 role を含む）+
 * Account.movable（「自由に動かせる」フラグ）追加。
 * migration step は追加しない（作者決定＝後方互換を持たない）。旧版 JSON /
 * スナップショットは unsupported-version として fail-closed に拒否される。
 */
export const SCHEMA_VERSION = 9 as const;

/**
 * revision は JSON / IndexedDB の双方で安全な整数だけを扱う。
 * 上限到達時は黙って丸めず、保存境界で fail-closed に停止する。
 */
export const MAX_LEDGER_REVISION = Number.MAX_SAFE_INTEGER;

/** localStorage 等のキー接頭辞（ポインタ/フラグ用。v1 の 'simple-ledger' 系と分離）。 */
export const LOCAL_PREFIX = 'slv2.' as const;

/** Service Worker のキャッシュ名接頭辞（sw.js が `${CACHE_NAME_PREFIX}<version>` で使う）。 */
export const CACHE_NAME_PREFIX = 'simple-ledger-v2-' as const;
