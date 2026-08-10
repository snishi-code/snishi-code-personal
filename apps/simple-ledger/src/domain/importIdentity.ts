/*
 * 行の同一性（行キー・指示書 §5-1）。
 *
 *  - rowKey = canonical tuple [sourceId, identityVersion, 種別, 本体...]。
 *    エンコードは **JSON 配列**（単純文字列連結は禁止＝区切り文字の衝突で
 *    ['a,b','c'] と ['a','b,c'] が同一視される穴を作らない）。
 *  - sourceId は binding の不変な取込元 ID（作成時に採番する UUID・監査 P1-3）。externalId は
 *    金融口座内でのみ一意のため、profile でもユーザー命名の表示名でもなく、改名・重複命名の
 *    影響を受けない取込元 ID で名前空間を切る。
 *  - externalId 定義があれば ['ext', ...tuple]、無ければ
 *    ['fp', SHA-256(生行のトリム済み文字列), occurrence]。
 *  - occurrence = 同一 fingerprint のファイル内出現順（1 始まり）。生行に日付が含まれる
 *    ため、日付範囲スライスの export 同士でも同日の行集合は保たれ、番号は安定する。
 *  - SHA-256 は WebCrypto（crypto.subtle）＝ async。外部通信なし。
 */
import type { EvaluatedImportRow } from './importDsl';

/** キー生成アルゴリズムの版（§5-1）。将来キーの作り方を変えるとき +1 する。 */
export const IMPORT_IDENTITY_VERSION = 1 as const;

/* ── canonical tuple ── */

/** 文字列/数値の並びを canonical tuple 文字列へ（JSON 配列・決定的）。 */
export function encodeCanonicalTuple(parts: readonly (string | number)[]): string {
  return JSON.stringify(parts);
}

/** canonical tuple 文字列を復元する。形が違えば undefined（例外にしない）。 */
export function decodeCanonicalTuple(encoded: string): (string | number)[] | undefined {
  let value: unknown;
  try {
    value = JSON.parse(encoded);
  } catch {
    return undefined;
  }
  if (!Array.isArray(value)) return undefined;
  const ok = value.every(
    (p) => typeof p === 'string' || (typeof p === 'number' && Number.isFinite(p)),
  );
  return ok ? (value as (string | number)[]) : undefined;
}

/* ── fingerprint ── */

/** fingerprint の素材 = デコード後の生行文字列（トリムのみ・列解釈前・§5-1）。 */
export function fingerprintSource(rawLine: string): string {
  return rawLine.trim();
}

/** SHA-256 の 16 進表現（WebCrypto・端末内のみ）。 */
export async function sha256Hex(text: string): Promise<string> {
  return sha256HexOfBytes(new TextEncoder().encode(text));
}

/** バイト列の SHA-256（ファイル本体の fileHash・§5-2 層0 に使う）。 */
export async function sha256HexOfBytes(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes as BufferSource);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/* ── profile digest（§5-1: provenance に保存し、レビュー中の profile 変更を検出する） ── */

/**
 * 決定的な canonical JSON（オブジェクトキーを再帰的に辞書順へ並べ替える）。
 * 同じ内容の DSL は保存順序に関わらず同一の文字列 = 同一の digest になる。
 * JSON に載らない値（undefined / 関数）はプロパティごと落ちる（JSON.stringify と同じ規則）。
 */
export function canonicalJsonText(value: unknown): string {
  return JSON.stringify(sortKeysDeep(value));
}

function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return Object.fromEntries(entries.map(([k, v]) => [k, sortKeysDeep(v)]));
  }
  return value;
}

/**
 * profile DSL の digest = canonical JSON の SHA-256（§5-1）。
 * レビュー表示時に取得し、適用時に再計算値と照合する（不一致 = profile が変更された =
 * 適用を全拒否して作り直す）。
 */
export async function profileDslDigest(dsl: unknown): Promise<string> {
  return sha256Hex(canonicalJsonText(dsl));
}

/* ── rowKey ── */

export function externalRowKey(
  sourceId: string,
  tuple: readonly string[],
  identityVersion: number = IMPORT_IDENTITY_VERSION,
): string {
  return encodeCanonicalTuple([sourceId, identityVersion, 'ext', ...tuple]);
}

export function fingerprintRowKey(
  sourceId: string,
  fingerprint: string,
  occurrence: number,
  identityVersion: number = IMPORT_IDENTITY_VERSION,
): string {
  return encodeCanonicalTuple([sourceId, identityVersion, 'fp', fingerprint, occurrence]);
}

/**
 * 1 行の rowKey を作る。externalId 定義があれば ext キー、無ければ fingerprint キー。
 * fingerprint キーの occurrence はファイル内の出現順で呼び出し側が採番する
 * （ファイル全体では attachRowKeys を使う）。
 */
export async function rowKeyForRow(
  sourceId: string,
  row: Pick<EvaluatedImportRow, 'rawLine' | 'externalIdTuple'>,
  options: { occurrence?: number; identityVersion?: number } = {},
): Promise<string> {
  const identityVersion = options.identityVersion ?? IMPORT_IDENTITY_VERSION;
  if (row.externalIdTuple !== undefined) {
    return externalRowKey(sourceId, row.externalIdTuple, identityVersion);
  }
  const fp = await sha256Hex(fingerprintSource(row.rawLine));
  return fingerprintRowKey(sourceId, fp, options.occurrence ?? 1, identityVersion);
}

/* ── rowKey の解読（デデュープ層が出現数照合に使う） ── */

export interface ParsedRowKey {
  /** 名前空間 = binding の不変な取込元 ID（§5-1）。 */
  sourceId: string;
  identityVersion: number;
  body: { type: 'ext'; tuple: string[] } | { type: 'fp'; fingerprint: string; occurrence: number };
}

/** rowKey を構造へ戻す。形が違えば undefined（自分の作ったキー以外は解釈しない）。 */
export function parseRowKey(key: string): ParsedRowKey | undefined {
  const tuple = decodeCanonicalTuple(key);
  if (tuple === undefined || tuple.length < 3) return undefined;
  const [sourceId, identityVersion, type, ...rest] = tuple;
  if (typeof sourceId !== 'string') return undefined;
  if (typeof identityVersion !== 'number' || !Number.isInteger(identityVersion)) return undefined;
  if (type === 'ext') {
    if (!rest.every((p): p is string => typeof p === 'string')) return undefined;
    return { sourceId, identityVersion, body: { type: 'ext', tuple: rest } };
  }
  if (type === 'fp') {
    const [fingerprint, occurrence] = rest;
    if (rest.length !== 2 || typeof fingerprint !== 'string') return undefined;
    if (typeof occurrence !== 'number' || !Number.isInteger(occurrence) || occurrence < 1) {
      return undefined;
    }
    return { sourceId, identityVersion, body: { type: 'fp', fingerprint, occurrence } };
  }
  return undefined;
}

/* ── ファイル単位の付与（occurrence 採番込み） ── */

/** §1-4 NormalizedRow の実現形（保存しない中間形）。groupId は予約のみ（v1 は常に無し）。 */
export interface NormalizedRow extends EvaluatedImportRow {
  rowKey: string;
  /** 諸口グループ（§8 予約）。v1 では生成しない・デデュープにも参加しない。 */
  groupId?: string;
}

export interface RowKeyAttachment {
  /** 入力と同順の正規化行（rowKey 付き）。 */
  rows: NormalizedRow[];
  /**
   * fingerprint 値 → ファイル内出現数。§5-2 の「決定済みの既知 occurrence 数と
   * ファイル内出現数の不一致」防御に使う（externalId のファイルでは空）。
   */
  fingerprintCounts: Map<string, number>;
}

/**
 * 評価済み行の列へ rowKey を付与する（ファイル内順で occurrence を採番）。
 * 同一 fingerprint の出現数もあわせて返す。
 */
export async function attachRowKeys(
  rows: readonly EvaluatedImportRow[],
  sourceId: string,
  identityVersion: number = IMPORT_IDENTITY_VERSION,
): Promise<RowKeyAttachment> {
  const fingerprintCounts = new Map<string, number>();
  const hashCache = new Map<string, string>();
  const keyed: NormalizedRow[] = [];
  for (const row of rows) {
    if (row.externalIdTuple !== undefined) {
      keyed.push({
        ...row,
        rowKey: externalRowKey(sourceId, row.externalIdTuple, identityVersion),
      });
      continue;
    }
    const source = fingerprintSource(row.rawLine);
    let fp = hashCache.get(source);
    if (fp === undefined) {
      fp = await sha256Hex(source);
      hashCache.set(source, fp);
    }
    const occurrence = (fingerprintCounts.get(fp) ?? 0) + 1;
    fingerprintCounts.set(fp, occurrence);
    keyed.push({
      ...row,
      rowKey: fingerprintRowKey(sourceId, fp, occurrence, identityVersion),
    });
  }
  return { rows: keyed, fingerprintCounts };
}
