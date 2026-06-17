// 移植元: snishi-code-medical/hospital-rounds/src/features/qr-protocol.js (transport 層のみ)

/**
 * QR Wire Format Authority — transport 層 (v1 互換の正本)
 *
 * すべての QR 種が従う共通ページ書式:
 *
 *   RND_<KIND> #<batchId> N/M\n<本文>
 *
 *   - KIND: 2 文字以上の大文字 (HM/MM/SH/ST/FMT/FS など。kind の定義はアプリ側)
 *   - batchId: 1 回の送信を識別する短い ID (Date.now().toString(36))
 *   - N/M: ページ番号 / 総ページ数
 *
 * 本文は wire format の文字列 (短キー JSON)、または crypto.ts の transport prefix
 * ("C1:" / "E1:" / "E2:") 付き base64url。transport 層 (pack/unpack) はページ分割
 * (encodePages/decodePage) の前段に位置する。
 *
 * ── 設計 2 原則 (v1 qr-protocol.js 冒頭の要旨。ドメイン wire 変換
 *    (formatToWire / patientToWire / PANEL_BY_INDEX 等) はアプリ側に残すが、
 *    Wire Format Authority の正本性はこの doc comment に保持する) ──
 *
 * 原則①「可変領域は冒頭辞書 + index 参照」:
 *   ユーザーが順序や内容を変えうるもの (タグ名、フォーマット並び、項目並び等)
 *   は、ペイロード冒頭に辞書を 1 回だけ置き、本体は数値 index で参照する。
 *   位置依存のスキーマ宣言は禁止 (順序が変わると壊れる)。
 *
 * 原則②「コード固定値は wire に含めない」:
 *   コード側で決まっている enum 許容値・デフォルト値は wire に乗せない。
 *   受信側コードが復元する。enum 値は数値 index で送り、デフォルトと等価な
 *   値は省略する。
 *
 * 互換性ルール (アプリ側 WIRE_V の bump 判定):
 *   bump 必須 — 既存フィールドの意味変更・削除 / enum 許容値の追加 / 短キー名変更。
 *   bump 不要 — 新規フィールドの追加 (受信側 normalize が未知フィールドを温存する
 *   forward compat 前提)。
 *
 * この設計は「ユーザーの編集自由と互換性を両立する」ために選ばれた。キー名直書き・
 * 文字列のままの enum・位置依存配列といった素朴な実装に戻すと、ユーザーが順序を
 * 変えた途端に壊れるデータ破壊バグになりうる。本仕様を絶対に逸脱しないこと。
 */

// 5 種すべての QR の上限。QR version ~20 (~97 modules) 程度で iPad camera で
// 確実にスキャンできる範囲。収まらない payload は複数ページに分割される。
export const MAX_BYTES = 750;
// 'RND_HM #abcdef12 99/99\n' = 約 25 バイト。余裕を持って 50 バイト確保
export const HEADER_BUDGET = 50;
const HEADER_RE = /^RND_([A-Z]+)\s+#(\S+)\s+(\d+)\/(\d+)\n([\s\S]*)$/;

export function utf8ByteLength(text: string): number {
  return new TextEncoder().encode(String(text ?? '')).length;
}

// now 注入可 (決定論テスト用)。既定は v1 と同じ Date.now().toString(36)
export function newBatchId(now?: number): string {
  return (now ?? Date.now()).toString(36);
}

// ============================
// Escape helpers (v1 逐語移植)
// ============================

export function escapeField(s: string): string {
  return String(s).replace(/\\/g, '\\\\').replace(/\|/g, '\\|').replace(/\n/g, '\\n');
}

export function unescapeField(s: string): string {
  let out = '';
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '\\' && i + 1 < s.length) {
      const c = s[i + 1];
      out += c === 'n' ? '\n' : c;
      i++;
    } else {
      out += s[i];
    }
  }
  return out;
}

export function splitEscapedPipe(line: string): string[] {
  const parts: string[] = [];
  let cur = '';
  for (let i = 0; i < line.length; i++) {
    if (line[i] === '\\' && i + 1 < line.length) {
      cur += String(line[i]) + String(line[i + 1]);
      i++;
    } else if (line[i] === '|') {
      parts.push(cur);
      cur = '';
    } else {
      cur += line[i];
    }
  }
  parts.push(cur);
  return parts;
}

// ============================
// Page chunking + headers
//
// payload を budget バイト以下に分割。可能な限り `\n` 境界で切り、改行が無い
// payload (暗号化 base64 など) もコードポイント境界で分割する。チャンクは境界の
// `\n` を保持するので、受信側は ""(空文字) で連結すれば元の payload に戻る。
// ============================

function chunkPayload(payload: string, budget: number): string[] {
  if (utf8ByteLength(payload) <= budget) return [payload];

  const chunks: string[] = [];
  let i = 0;
  const len = payload.length;
  while (i < len) {
    let chunkBytes = 0;
    let lastNewlineEnd = -1;
    let j = i;
    while (j < len) {
      const code = payload.codePointAt(j) ?? 0;
      const cpBytes = code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4;
      if (chunkBytes + cpBytes > budget) break;
      chunkBytes += cpBytes;
      const cpUtf16 = code >= 0x10000 ? 2 : 1;
      if (payload[j] === '\n') lastNewlineEnd = j + 1;
      j += cpUtf16;
    }
    if (j === i) {
      // 1 文字でも budget を超える病的ケース。これ以上分割できないので強制送出
      chunks.push(payload.slice(i, i + 1));
      i += 1;
      continue;
    }
    const splitJ = lastNewlineEnd > i ? lastNewlineEnd : j;
    chunks.push(payload.slice(i, splitJ));
    i = splitJ;
  }
  return chunks.length === 0 ? [''] : chunks;
}

export interface EncodePagesOptions {
  kind: string;
  payload: string;
  batchId?: string;
  maxBytes?: number;
}

// payload を全ページ分の文字列配列に変換
export function encodePages({
  kind,
  payload,
  batchId,
  maxBytes = MAX_BYTES,
}: EncodePagesOptions): string[] {
  const trimmed = String(payload || '').trim();
  if (!trimmed) return [];
  const id = batchId || newBatchId();
  const budget = maxBytes - HEADER_BUDGET;
  const chunks = chunkPayload(payload, budget);
  const total = chunks.length;
  return chunks.map((c, i) => `RND_${kind} #${id} ${i + 1}/${total}\n${c}`);
}

export interface DecodedPage {
  kind: string;
  batchId: string;
  pageNum: number;
  totalPages: number;
  content: string;
}

// ヘッダー解析。形式に合わなければ null (fail-closed)
export function decodePage(text: string): DecodedPage | null {
  const m = String(text || '').match(HEADER_RE);
  if (!m) return null;
  return {
    kind: m[1] as string,
    batchId: m[2] as string,
    pageNum: parseInt(m[3] as string, 10),
    totalPages: parseInt(m[4] as string, 10),
    content: m[5] as string,
  };
}

// decodePage 結果の配列 → 連結した transport payload 文字列。
// pageNum 昇順に content を "" 連結する (encodePages は境界 \n を content 側に
// 保持しているので "" 連結で元に戻る)。全ページ揃っていない / totalPages 不一致は
// null を返す (fail-closed: 欠けたまま復号させない)。順不同・重複入力も許容。
export function assemblePages(decodedPages: readonly DecodedPage[]): string | null {
  if (!Array.isArray(decodedPages) || decodedPages.length === 0) return null;
  const byNum = new Map<number, string>();
  let total: number | null = null;
  for (const d of decodedPages) {
    if (!d || typeof d.pageNum !== 'number') return null;
    if (total == null) total = d.totalPages;
    else if (total !== d.totalPages) return null; // バッチ混在
    byNum.set(d.pageNum, d.content);
  }
  if (total == null || byNum.size !== total) return null;
  const out: string[] = [];
  for (let i = 1; i <= total; i++) {
    const c = byNum.get(i);
    if (c == null) return null;
    out.push(c);
  }
  return out.join('');
}

// 同名衝突回避: base が existing(配列/Set) に既にあれば "base (2)", "(3)"... を返す。
// QR 受信 apply のリネームでアプリ側と共用。
export function uniqueName(
  base: string,
  existing: readonly string[] | ReadonlySet<string>,
): string {
  const baseName = String(base || '').trim();
  const has =
    existing instanceof Set
      ? (n: string) => existing.has(n)
      : (n: string) => Array.isArray(existing) && existing.includes(n);
  if (!has(baseName)) return baseName;
  for (let n = 2; n < 1000; n++) {
    const candidate = `${baseName} (${n})`;
    if (!has(candidate)) return candidate;
  }
  return `${baseName} (${Date.now().toString(36)})`;
}
