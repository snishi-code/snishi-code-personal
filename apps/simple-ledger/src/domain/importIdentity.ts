/*
 * 行の同一性（行キー・指示書 §5-1）。
 *
 *  - rowKey = canonical tuple [sourceIdentity, identityVersion, 種別, 本体...]。
 *    エンコードは **JSON 配列**（単純文字列連結は禁止＝区切り文字の衝突で
 *    ['a,b','c'] と ['a','b,c'] が同一視される穴を作らない）。
 *  - sourceIdentity は binding のユーザー命名識別子（取込元口座）。externalId は
 *    金融口座内でのみ一意のため、profile ではなく取込元で名前空間を切る。
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
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/* ── rowKey ── */

export function externalRowKey(
  sourceIdentity: string,
  tuple: readonly string[],
  identityVersion: number = IMPORT_IDENTITY_VERSION,
): string {
  return encodeCanonicalTuple([sourceIdentity, identityVersion, 'ext', ...tuple]);
}

export function fingerprintRowKey(
  sourceIdentity: string,
  fingerprint: string,
  occurrence: number,
  identityVersion: number = IMPORT_IDENTITY_VERSION,
): string {
  return encodeCanonicalTuple([sourceIdentity, identityVersion, 'fp', fingerprint, occurrence]);
}

/**
 * 1 行の rowKey を作る。externalId 定義があれば ext キー、無ければ fingerprint キー。
 * fingerprint キーの occurrence はファイル内の出現順で呼び出し側が採番する
 * （ファイル全体では attachRowKeys を使う）。
 */
export async function rowKeyForRow(
  sourceIdentity: string,
  row: Pick<EvaluatedImportRow, 'rawLine' | 'externalIdTuple'>,
  options: { occurrence?: number; identityVersion?: number } = {},
): Promise<string> {
  const identityVersion = options.identityVersion ?? IMPORT_IDENTITY_VERSION;
  if (row.externalIdTuple !== undefined) {
    return externalRowKey(sourceIdentity, row.externalIdTuple, identityVersion);
  }
  const fp = await sha256Hex(fingerprintSource(row.rawLine));
  return fingerprintRowKey(sourceIdentity, fp, options.occurrence ?? 1, identityVersion);
}

/* ── rowKey の解読（デデュープ層が出現数照合に使う） ── */

export interface ParsedRowKey {
  sourceIdentity: string;
  identityVersion: number;
  body: { type: 'ext'; tuple: string[] } | { type: 'fp'; fingerprint: string; occurrence: number };
}

/** rowKey を構造へ戻す。形が違えば undefined（自分の作ったキー以外は解釈しない）。 */
export function parseRowKey(key: string): ParsedRowKey | undefined {
  const tuple = decodeCanonicalTuple(key);
  if (tuple === undefined || tuple.length < 3) return undefined;
  const [sourceIdentity, identityVersion, type, ...rest] = tuple;
  if (typeof sourceIdentity !== 'string') return undefined;
  if (typeof identityVersion !== 'number' || !Number.isInteger(identityVersion)) return undefined;
  if (type === 'ext') {
    if (!rest.every((p): p is string => typeof p === 'string')) return undefined;
    return { sourceIdentity, identityVersion, body: { type: 'ext', tuple: rest } };
  }
  if (type === 'fp') {
    const [fingerprint, occurrence] = rest;
    if (rest.length !== 2 || typeof fingerprint !== 'string') return undefined;
    if (typeof occurrence !== 'number' || !Number.isInteger(occurrence) || occurrence < 1) {
      return undefined;
    }
    return { sourceIdentity, identityVersion, body: { type: 'fp', fingerprint, occurrence } };
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
  sourceIdentity: string,
  identityVersion: number = IMPORT_IDENTITY_VERSION,
): Promise<RowKeyAttachment> {
  const fingerprintCounts = new Map<string, number>();
  const hashCache = new Map<string, string>();
  const keyed: NormalizedRow[] = [];
  for (const row of rows) {
    if (row.externalIdTuple !== undefined) {
      keyed.push({
        ...row,
        rowKey: externalRowKey(sourceIdentity, row.externalIdTuple, identityVersion),
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
      rowKey: fingerprintRowKey(sourceIdentity, fp, occurrence, identityVersion),
    });
  }
  return { rows: keyed, fingerprintCounts };
}
