/*
 * template-memo の識別子・バージョン定数（一箇所へ集約）。
 *
 * medical 側 hospital-workspace（DB=hospital-workspace / prefix=hw.）や
 * simple-ledger（DB=simple-ledger-v2 / prefix=slv2.）とは識別子を完全分離する。
 * 同一 origin に同居しても衝突せず、交換ファイルも appId 不一致で fail-closed に拒否される。
 */

/** IndexedDB のデータベース名。 */
export const DB_NAME = 'template-memo' as const;

/** IndexedDB のバージョン。store 構成を変える時だけ上げる。 */
export const DB_VERSION = 1 as const;

/** エクスポート/import 照合用のアプリ ID（封筒 appId）。 */
export const APP_ID = 'snishi-code.template-memo' as const;

/**
 * 現行スキーマ版。互換性のない変更ごとに +1 する。migration step は持たない
 * （simple-ledger と同じ単発変換方式。旧版 JSON は fail-closed に拒否し、
 * 必要なら変換ツールを別途用意する）。
 */
export const SCHEMA_VERSION = 1 as const;

/** バックアップ JSON の kind 識別子。 */
export const BACKUP_KIND = 'TEMPLATE_MEMO_BACKUP' as const;

/** localStorage 等のキー接頭辞（ポインタ/フラグ用）。 */
export const LOCAL_PREFIX = 'tm.' as const;

/** Service Worker のキャッシュ名接頭辞（public/sw.js の CACHE_PREFIX と値を合わせる）。 */
export const CACHE_NAME_PREFIX = 'template-memo-' as const;

// object store 名（実体単位で分離。将来 SQLite テーブルへ素直に写せる単位）。
export const STORE_SETTINGS = 'settings';
export const STORE_SUBJECTS = 'subjects';
export const STORE_GROUPS = 'groups';
export const STORE_TEMPLATES = 'templates';
/** ラウンド開始/クリア直前の 1 段階 Undo スナップショット（kv・単一レコード）。 */
export const STORE_SNAPSHOTS = 'snapshots';
export const ALL_STORES = [
  STORE_SETTINGS,
  STORE_SUBJECTS,
  STORE_GROUPS,
  STORE_TEMPLATES,
  STORE_SNAPSHOTS,
] as const;

/** settings store の単一レコードの固定キー。 */
export const APP_SETTINGS_KEY = 'app';
/** snapshots store（kv）の Undo レコードの固定キー。 */
export const UNDO_SNAPSHOT_KEY = 'undo';

/**
 * QR 1 ページの最大バイト数（UTF-8）。旧回診と同じ 600B
 * （MacBook 内蔵カメラ等でも確実に読める実測値）を既定にする。
 */
export const QR_MAX_BYTES = 600;

/** ランダムトークン（crypto.randomUUID 優先・jsdom 等の fallback あり。外部送信なし）。 */
function randomToken(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID().replace(/-/g, '').slice(0, 16);
  }
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
}

/** 採番 ID（prefix 付き）。固定 ID は使わず端末間衝突を避ける。 */
export function newId(prefix: string): string {
  return `${prefix}_${randomToken()}`;
}
