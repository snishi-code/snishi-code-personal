/*
 * CSV 取込の入口: バイト列のデコードと RFC 4180 相当の CSV パーサ（指示書 §2）。
 *
 *  - 依存追加なし・`split(',')` 禁止。quote / `""` エスケープ / 引用内改行 / CRLF・LF /
 *    末尾空列（`a,b,` は 3 セル）を正しく扱う状態機械で実装する。
 *  - fail-closed: デコード失敗・引用の壊れた CSV は黙って読み飛ばさず例外で止める。
 *  - ここは純関数のみ（ファイル I/O・ストレージ・UI に触れない）。エラーは
 *    `CsvImportError`（code + params）で投げ、文言化は UI 層（後続フェーズ）が行う。
 */

/** 対応エンコーディング（指示書 §2 の変換表）。 */
export const CSV_ENCODINGS = ['utf-8', 'utf-8-sig', 'cp932'] as const;
export type CsvEncoding = (typeof CSV_ENCODINGS)[number];

export type CsvImportErrorCode =
  | 'csv-decode-failed'
  | 'csv-invalid-delimiter'
  | 'csv-unclosed-quote'
  | 'csv-invalid-quote'
  | 'csv-header-row-missing'
  | 'csv-duplicate-header'
  | 'csv-column-missing';

/**
 * CSV 取込のドメインエラー。LedgerError と同じ「コード + params」方式だが、
 * i18n 配線（ja.ts への文言追加）は UI フェーズの管轄なので独立クラスにしている。
 */
export class CsvImportError extends Error {
  readonly code: CsvImportErrorCode;
  readonly params: Record<string, string | number> | undefined;
  constructor(code: CsvImportErrorCode, params?: Record<string, string | number>) {
    super(code);
    this.name = 'CsvImportError';
    this.code = code;
    this.params = params;
  }
}

/**
 * バイト列を指定エンコーディングでデコードする。失敗（不正バイト）は fatal:true により
 * 明示エラー（黙って U+FFFD に落とさない）。
 *
 * 変換表（指示書 §2）:
 *  - `utf-8`     → TextDecoder('utf-8', {fatal:true})。**BOM は除去しない**（ignoreBOM:true）。
 *                  BOM 付きファイルを `utf-8` で読むと先頭列名に U+FEFF が残って列不一致で
 *                  可視に失敗する = ユーザーが `utf-8-sig` を選び直す（黙って直さない）。
 *  - `utf-8-sig` → 先頭の BOM バイト（EF BB BF）を除去してから同上（BOM 無しでも受理）。
 *  - `cp932`     → TextDecoder('shift_jis', {fatal:true})。
 */
export function decodeCsvBytes(bytes: Uint8Array, encoding: CsvEncoding): string {
  try {
    if (encoding === 'utf-8-sig') {
      const hasBom =
        bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf;
      const body = hasBom ? bytes.subarray(3) : bytes;
      return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(body);
    }
    if (encoding === 'cp932') {
      return new TextDecoder('shift_jis', { fatal: true }).decode(bytes);
    }
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    throw new CsvImportError('csv-decode-failed', { encoding });
  }
}

/** パース済みの 1 レコード。引用内改行があると複数の物理行にまたがる。 */
export interface CsvRecord {
  /** アンクォート済みのセル値（引用符・エスケープ解決後）。 */
  cells: string[];
  /** レコードが始まる物理行番号（1 始まり）。エラー表示・行番号情報用。 */
  line: number;
  /**
   * レコードの生テキスト（行終端を除く・引用内改行を含む・アンクォート前）。
   * 行キーの fingerprint 素材（importIdentity）。トリムは fingerprint 側で行う。
   */
  raw: string;
}

/**
 * RFC 4180 相当の CSV パース（純関数）。
 *  - quote / `""` エスケープ / 引用内改行 / CRLF・LF 混在 / 末尾空列を扱う。
 *  - 末尾の行終端は空レコードを生まない。途中の空行は cells=[''] の 1 セルレコードになる
 *    （捨てない。分類は evaluateProfile が保存則の下で行う）。
 *  - 引用の壊れた入力（閉じない quote・閉じ quote 直後のゴミ・非引用フィールド内の quote）は
 *    fail-closed に例外で止める。
 */
export function parseCsv(text: string, options: { delimiter?: string } = {}): CsvRecord[] {
  const delimiter = options.delimiter ?? ',';
  if (delimiter.length !== 1 || delimiter === '"' || delimiter === '\n' || delimiter === '\r') {
    throw new CsvImportError('csv-invalid-delimiter', { delimiter });
  }

  const records: CsvRecord[] = [];
  let cells: string[] = [];
  let field = '';
  let inQuotes = false;
  /** 直前に引用フィールドを閉じた直後か（次は delimiter / 行終端 / EOF のみ許す）。 */
  let justClosedQuote = false;
  let line = 1;
  let recordStartLine = 1;
  let recordStartIndex = 0;

  const pushField = () => {
    cells.push(field);
    field = '';
    justClosedQuote = false;
  };
  const pushRecord = (endIndex: number) => {
    pushField();
    records.push({ cells, line: recordStartLine, raw: text.slice(recordStartIndex, endIndex) });
    cells = [];
  };

  let i = 0;
  const n = text.length;
  while (i < n) {
    const c = text[i]!;
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
        } else {
          inQuotes = false;
          justClosedQuote = true;
          i += 1;
        }
      } else {
        if (c === '\n') line += 1;
        field += c;
        i += 1;
      }
      continue;
    }
    if (c === delimiter) {
      pushField();
      i += 1;
      continue;
    }
    if (c === '\n' || c === '\r') {
      pushRecord(i);
      i += c === '\r' && text[i + 1] === '\n' ? 2 : 1;
      line += 1;
      recordStartLine = line;
      recordStartIndex = i;
      continue;
    }
    if (justClosedQuote) {
      // 閉じ quote の直後に区切り・行終端以外が来た（例: `"a"b`）。
      throw new CsvImportError('csv-invalid-quote', { line });
    }
    if (c === '"') {
      if (field !== '') {
        // 非引用フィールドの途中に quote（例: `a"b`）。RFC 4180 違反 = 壊れた入力。
        throw new CsvImportError('csv-invalid-quote', { line });
      }
      inQuotes = true;
      i += 1;
      continue;
    }
    field += c;
    i += 1;
  }

  if (inQuotes) {
    throw new CsvImportError('csv-unclosed-quote', { line: recordStartLine });
  }
  // 最後の行終端の後には空レコードを作らない。終端なしで終わる最終レコードは拾う
  // （ループ終了時 i === n。レコード開始位置から 1 文字でも進んでいれば未完のレコードがある）。
  if (recordStartIndex < n) pushRecord(n);
  return records;
}

/** セルを CSV 表現へ（必要時のみ quote）。プロンプトのサンプル行描画などに使う。 */
export function formatCsvLine(cells: readonly string[], delimiter = ','): string {
  return cells
    .map((cell) => {
      if (
        cell.includes('"') ||
        cell.includes(delimiter) ||
        cell.includes('\n') ||
        cell.includes('\r')
      ) {
        return `"${cell.replaceAll('"', '""')}"`;
      }
      return cell;
    })
    .join(delimiter);
}

/** ヘッダー行で分割したテーブル表現。 */
export interface CsvTable {
  /** trim 済みのヘッダー名（列参照はこの名前で解決する）。 */
  header: string[];
  /** ヘッダーの物理行番号。 */
  headerLine: number;
  /** ヘッダーより前の前置きレコード（明細ではない。skip 扱いにする）。 */
  preamble: CsvRecord[];
  /** ヘッダーより後の全データレコード。 */
  dataRecords: CsvRecord[];
}

/**
 * レコード列からヘッダー行を取り出す。
 *  - headerRowIndex はレコード配列の 0 始まり index（物理行番号ではない）。
 *  - 重複ヘッダー（trim 後同名）は列参照が曖昧になるため fail-closed に拒否する。
 */
export function extractCsvTable(records: readonly CsvRecord[], headerRowIndex: number): CsvTable {
  const headerRecord = records[headerRowIndex];
  if (headerRecord === undefined) {
    throw new CsvImportError('csv-header-row-missing', {
      headerRowIndex,
      recordCount: records.length,
    });
  }
  const header = headerRecord.cells.map((c) => c.trim());
  const seen = new Set<string>();
  for (const name of header) {
    if (seen.has(name)) {
      throw new CsvImportError('csv-duplicate-header', { name, line: headerRecord.line });
    }
    seen.add(name);
  }
  return {
    header,
    headerLine: headerRecord.line,
    preamble: records.slice(0, headerRowIndex),
    dataRecords: records.slice(headerRowIndex + 1),
  };
}
