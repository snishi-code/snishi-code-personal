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
 * IndexedDB のバージョン。version 13 は SCHEMA_VERSION 13（完全導出）と対で上げ、
 * tags を現行構成から外した（機能・受理とも撤去。既存 DB のストアは「未知レガシー」として
 * 温存し、復旧面の DB 初期化でのみ消える＝「黙って削除しない」原則は維持・監査 P1-1）。
 * version 12 は SCHEMA_VERSION 12（継続コストの同日刻み化ほか）と
 * 対で上げた（store 構成は不変だが、版対応 1:1 の方針で DB_VERSION も上げる）。
 * version 11 は SCHEMA_VERSION 11（金額の 1/100 単位化）と対で上げた
 * （store 構成は不変だが保存値の意味 = スケールが変わるため、版対応 1:1 の方針で両方上げる）。
 * version 10 で CSV 取込の 3 ストアを現行構成から外した
 * （機能ごと全撤去・SCHEMA_VERSION 10 と対で上げる）。
 * version 8〜9 は CSV 取込（Import Profile）の追加とその改版だった。
 * version 7 で予定キャッシュフロー（cashflowSchedules）ストアを
 * 現行構成から外した（機能ごと全廃 = 予定は未来日付の通常仕訳へ一本化）。
 * upgrade は不足ストアの作成だけを行い、**旧版のストアは削除しない**（旧版 DB は
 * schemaVersion 検査で復旧面へ送られ、復旧面の「DB 初期化」= DB 削除でのみ消える。
 * 黙って削除しない・監査 P1-1）。
 */
export const DB_VERSION = 13 as const;

/** エクスポート/import 照合用のアプリ ID（封筒 appId）。v1 とは別 ID。 */
export const APP_ID = 'snishi-code.simple-ledger-v2' as const;

/**
 * 現行スキーマ版。v2 は v1 の最終形（v16 相当の最新モデル）を **1** として開始した
 * （レガシー migration は持たない・仕様§16）。互換性のない変更ごとに +1 する。
 * version 12 = 継続コストの同日刻み化（作者決定 2026-08-15）。ルール由来 item
 * （id = `ccr-{ruleId}-{YYYY-MM}`）の endDate の意味が「周期末の月末」から
 * **「次回起票日と同日」**（= clampDayToMonth(起票月 + everyMonths, dayOfMonth)）へ変わる。
 * あわせて MonthlyCostItem.allocationStartDate を撤去（機能ごと廃止）、
 * 残高補正を全科目へ開放（補正の全科目化）、ルール×継続コストの台帳経由を明示トグル化、
 * JournalEntry.groupId を**予約のみ**で追加（諸口・UI と集計は未実装）。
 * 旧 v11 実データは _workspace-management/scripts/convert-ledger-v11-to-v12.mjs で単発変換する。
 * store 構成は不変だが、版対応 1:1 の方針で DB_VERSION も 12 へ上げる。
 * version 11 = 金額の 1/100 単位化（作者決定 2026-08-12/13・指示書 v3）。全金額フィールドを
 * 「1/100 単位の整数」（minor）として解釈する（例: 1,234.56 → 123456・100円 → 10000）。
 * あわせて settings.locale を撤去（言語は端末設定・Part B で使用）、
 * settings.displayFractionDigits（表示桁数 0|1|2・既定 0・入力の刻みも連動）を新設、
 * スナップショット reason を理由コード（'import' / 'restore'）へ変更。
 * 旧 v10 実データは _workspace-management/scripts/convert-ledger-v10-to-v11.mjs で単発変換する。
 * version 10 = CSV取込一式の撤去（実ユーズの結論・作者決定 2026-08-11）。
 * 「ざっくり登録 + 残高補正」の使い方に明細単位の CSV 取込は合わない＝使わない死荷重として
 * 型・schema・store・UI・交換 JSON の 3 配列と EntryMetadata の取込由来メタデータを全撤去。
 * 設計は git 履歴に残る（将来要望が出たら再導入可能）。
 * 同じ version 10 内の optional 追加（2026-08-11・投資の利回り投影 §D・版は上げない）:
 * `Account.annualReturnBp`（想定利回り・年率 bp 整数・investment-asset のみ）と
 * `Account.projectionAccountId`（投影の計上先・income-category・soft reference）。
 * どちらも optional かつセットで持つ・明示値のみ検証（未設定の旧データはそのまま適法）。
 * version 9 = 取込プロファイルのアーカイブ（v10 で機能ごと撤去）。
 * version 8 = CSV 取込（Import Profile）の導入（v10 で機能ごと撤去）。
 * version 7 = 予定キャッシュフロー（CashflowSchedule）の全廃。「予定 = 未来日付の通常仕訳」へ
 * version 13 = 完全導出。ルール由来の保存（rec- 仕訳・ccr- item・postedThroughMonth）と
 * tags / tagIds を撤去し、RecurringRule.settlements（清算）を追加。
 * 一本化し、export からも cashflowSchedules フィールドを削除。
 * version 6 = 定期ルールを時間軸上の線分にし、RecurringRule.startDate を必須化。
 * version 5 = 取り置き機能の全廃（store・仕訳メタデータ・専用 role を含む）+
 * Account.movable（「自由に動かせる」フラグ）追加。
 * migration step は追加しない（作者決定＝後方互換を持たない）。旧版 JSON /
 * スナップショットは unsupported-version として fail-closed に拒否される。
 */
export const SCHEMA_VERSION = 13 as const;

/**
 * revision は JSON / IndexedDB の双方で安全な整数だけを扱う。
 * 上限到達時は黙って丸めず、保存境界で fail-closed に停止する。
 */
export const MAX_LEDGER_REVISION = Number.MAX_SAFE_INTEGER;

/** localStorage 等のキー接頭辞（ポインタ/フラグ用。v1 の 'simple-ledger' 系と分離）。 */
export const LOCAL_PREFIX = 'slv2.' as const;

/** Service Worker のキャッシュ名接頭辞（sw.js が `${CACHE_NAME_PREFIX}<version>` で使う）。 */
export const CACHE_NAME_PREFIX = 'simple-ledger-v2-' as const;
