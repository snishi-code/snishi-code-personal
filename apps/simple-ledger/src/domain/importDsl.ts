/*
 * Import Profile DSL v1（指示書 §2）: CSV → 正規化行の宣言的な変換規則と、その評価器。
 *
 *  - **regex なし**。条件式は eq / prefix / suffix / contains / and / or / not のみ・
 *    対象は列参照のみ（ReDoS の余地を最初から作らない）。
 *  - 評価器は純関数。profile が壊れていても既存データに触れない。
 *  - **保存則（§4-2）**: ヘッダー以外の全レコード = normalized + 明示 skip（理由コード付き）+
 *    error。どの行も黙って捨てない。
 */
import { z } from 'zod';
import { isValidIsoDate } from './calendar';
import type { Side } from './types';
import {
  CSV_ENCODINGS,
  CsvImportError,
  extractCsvTable,
  parseCsv,
  type CsvEncoding,
  type CsvRecord,
} from './importCsv';

export const DSL_VERSION = 1 as const;

/** 条件式の最大深さ（and/or/not の入れ子）。超過は schema で拒否する。 */
export const MAX_CONDITION_DEPTH = 8;
/** DSL 全体（skipRules + kindRules）の条件ノード総数の上限。 */
export const MAX_CONDITION_NODES = 200;

/* ── 型（discriminated union の AST） ── */

export type ImportConditionLeafOp = 'eq' | 'prefix' | 'suffix' | 'contains';

export type ImportCondition =
  | { op: ImportConditionLeafOp; column: string; value: string }
  | { op: 'and' | 'or'; conditions: ImportCondition[] }
  | { op: 'not'; condition: ImportCondition };

/**
 * 日付書式の限定トークン。自由書式（strftime 等）は持たない。
 * `HH:MM:SS` 付きは日時 → 日付へ切り捨てる（PayPay の `取引日`）。
 */
export const IMPORT_DATE_FORMATS = [
  'YYYY/MM/DD',
  'YYYY-MM-DD',
  'YYYY/M/D',
  'YYYYMMDD',
  'YYYY/MM/DD HH:MM:SS',
  'YYYY-MM-DD HH:MM:SS',
] as const;
export type ImportDateFormat = (typeof IMPORT_DATE_FORMATS)[number];

/** 金額の取り方: 出金/入金の 2 列、または符号付き 1 列。 */
export type ImportAmountConfig =
  | { mode: 'in-out'; outflowColumn: string; inflowColumn: string }
  | { mode: 'signed'; column: string; positiveDirection: 'inflow' | 'outflow' };

export interface ImportProfileDsl {
  dslVersion: typeof DSL_VERSION;
  fileFormat: {
    encoding: CsvEncoding;
    /** 区切り文字（1 文字）。 */
    delimiter: string;
    /** ヘッダーがあるレコード index（0 始まり）。前置き行は skip 扱いになる。 */
    headerRowIndex: number;
  };
  /**
   * 「空」を意味するセル値（trim 後の完全一致。例: PayPay の `-`）。
   * 金額・摘要・取引先の解釈で空として扱う。externalId には適用しない（原文のまま識別に使う）。
   */
  emptyValues?: string[];
  columns: {
    date: { column: string; format: ImportDateFormat };
    amount: ImportAmountConfig;
    /** 摘要: 複数列を separator で連結（空セルは飛ばす）。 */
    description: { columns: string[]; separator?: string };
    counterparty?: { column: string };
  };
  /**
   * 外部 ID を成す列の組（canonical tuple・§5-1）。単純文字列連結は禁止＝
   * 区切り衝突（['a,b','c'] と ['a','b,c'] の混同）を作らない。
   */
  externalId?: { columns: string[] };
  /** 行を明示 skip する条件（上から評価・最初に一致）。reason は件数会計に出す理由コード。 */
  skipRules?: { when: ImportCondition; reason: string }[];
  /**
   * 行種分類（上から評価・最初に一致）。どれにも一致しない行は未知 kind = error 行
   * （黙って捨てない）。
   */
  kindRules: { when: ImportCondition; kind: string }[];
}

/* ── zod schema ──
 *
 * **ドクトリン例外（§2・§7）**: 台帳 JSON の schema は「strip 維持・`.strict()` 禁止」
 * （撤去済みフィールドの残骸が自己修復で落ちる）だが、**DSL に限り未知キーを明示拒否**する。
 * DSL は実行設定であり、未知キーは AI ビルダーの幻覚（存在しない機能の指定）の可能性が高い。
 * 黙って strip すると「指定したつもりの動きにならないまま取込が走る」ため、fail-closed に
 * 入口で止めて作り直させる。この例外は DSL の schema だけに限定する。
 */

const columnName = z.string().min(1).max(120);
const conditionValue = z.string().max(200);

const conditionRef: z.ZodType<ImportCondition> = z.lazy(() => importConditionSchema);

const conditionLeaf = (op: ImportConditionLeafOp) =>
  z.strictObject({ op: z.literal(op), column: columnName, value: conditionValue });

export const importConditionSchema: z.ZodType<ImportCondition> = z.lazy(() =>
  z.discriminatedUnion('op', [
    conditionLeaf('eq'),
    conditionLeaf('prefix'),
    conditionLeaf('suffix'),
    conditionLeaf('contains'),
    z.strictObject({ op: z.literal('and'), conditions: z.array(conditionRef).min(1).max(32) }),
    z.strictObject({ op: z.literal('or'), conditions: z.array(conditionRef).min(1).max(32) }),
    z.strictObject({ op: z.literal('not'), condition: conditionRef }),
  ]),
);

const importAmountConfigSchema = z.discriminatedUnion('mode', [
  z.strictObject({
    mode: z.literal('in-out'),
    outflowColumn: columnName,
    inflowColumn: columnName,
  }),
  z.strictObject({
    mode: z.literal('signed'),
    column: columnName,
    positiveDirection: z.enum(['inflow', 'outflow']),
  }),
]);

export const importProfileDslSchema = z
  .strictObject({
    dslVersion: z.literal(DSL_VERSION),
    fileFormat: z.strictObject({
      encoding: z.enum(CSV_ENCODINGS),
      delimiter: z
        .string()
        .length(1)
        .refine((d) => d !== '"' && d !== '\n' && d !== '\r', {
          message: '区切り文字に引用符・改行は使えません',
        }),
      headerRowIndex: z.number().int().min(0).max(1000),
    }),
    emptyValues: z.array(z.string().min(1).max(20)).max(10).optional(),
    columns: z.strictObject({
      date: z.strictObject({ column: columnName, format: z.enum(IMPORT_DATE_FORMATS) }),
      amount: importAmountConfigSchema,
      description: z.strictObject({
        columns: z.array(columnName).min(1).max(8),
        separator: z.string().max(8).optional(),
      }),
      counterparty: z.strictObject({ column: columnName }).optional(),
    }),
    externalId: z.strictObject({ columns: z.array(columnName).min(1).max(8) }).optional(),
    skipRules: z
      .array(z.strictObject({ when: importConditionSchema, reason: z.string().min(1).max(60) }))
      .max(64)
      .optional(),
    kindRules: z
      .array(z.strictObject({ when: importConditionSchema, kind: z.string().min(1).max(60) }))
      .min(1)
      .max(64),
  })
  .superRefine((dsl, ctx) => {
    // 条件式の深さ・ノード数の上限（幻覚的に巨大な条件木を入口で拒否する）。
    let totalNodes = 0;
    const check = (cond: ImportCondition, path: (string | number)[]) => {
      totalNodes += countConditionNodes(cond);
      if (conditionDepth(cond) > MAX_CONDITION_DEPTH) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `条件式の入れ子が上限(${MAX_CONDITION_DEPTH})を超えています`,
          path,
        });
      }
    };
    dsl.skipRules?.forEach((r, i) => check(r.when, ['skipRules', i, 'when']));
    dsl.kindRules.forEach((r, i) => check(r.when, ['kindRules', i, 'when']));
    if (totalNodes > MAX_CONDITION_NODES) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `条件ノード総数が上限(${MAX_CONDITION_NODES})を超えています`,
        path: ['kindRules'],
      });
    }
  });

/** DSL の JSON（AI 返書の貼付など）を検証して型付きで返す。失敗は ZodError。 */
export function parseImportProfileDsl(value: unknown): ImportProfileDsl {
  return importProfileDslSchema.parse(value) as ImportProfileDsl;
}

/* ── ImportProfile（§1-1・ポータブルな変換規則の封筒） ── */

export interface ImportProfile {
  id: string;
  name: string;
  /** 組み込み profile の識別（PayPay 同梱など）。固定値・削除後に自動復活しない。 */
  builtin?: { builtinId: string; builtinVersion: number };
  /**
   * アーカイブ済み（v9 で追加・既定 false = undefined）。profile の「編集」は上書きではなく
   * 旧をアーカイブして新規作成する（作者決定 2026-08-11）。アーカイブ済みは取込の
   * プロファイル選択に出さないが、decision の provenance からの参照は残る（過去との接続維持）。
   * アーカイブ解除の操作は作らない（組み込みだけは「組み込みを復元」が原本で上書き = 解除になる）。
   */
  archived?: boolean;
  dsl: ImportProfileDsl;
  createdAt: string;
  updatedAt: string;
}

/**
 * profile の封筒はドクトリンどおり strip（`.strict()` にしない）。未知キー拒否の例外は
 * `dsl` フィールドの中身（importProfileDslSchema）だけに限定する。
 */
export const importProfileSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1).max(120),
  builtin: z
    .object({ builtinId: z.string().min(1).max(60), builtinVersion: z.number().int().min(1) })
    .optional(),
  archived: z.boolean().optional(),
  dsl: importProfileDslSchema,
  createdAt: z.string().min(1),
  updatedAt: z.string().min(1),
});

/* ── 条件式ユーティリティ ── */

export function conditionDepth(cond: ImportCondition): number {
  switch (cond.op) {
    case 'and':
    case 'or':
      return 1 + Math.max(...cond.conditions.map(conditionDepth));
    case 'not':
      return 1 + conditionDepth(cond.condition);
    default:
      return 1;
  }
}

export function countConditionNodes(cond: ImportCondition): number {
  switch (cond.op) {
    case 'and':
    case 'or':
      return 1 + cond.conditions.reduce((s, c) => s + countConditionNodes(c), 0);
    case 'not':
      return 1 + countConditionNodes(cond.condition);
    default:
      return 1;
  }
}

/** 条件式が参照する列名を列挙する（評価前の欠損列チェック用）。 */
export function conditionColumns(cond: ImportCondition): string[] {
  switch (cond.op) {
    case 'and':
    case 'or':
      return cond.conditions.flatMap(conditionColumns);
    case 'not':
      return conditionColumns(cond.condition);
    default:
      return [cond.column];
  }
}

/* ── 評価結果の型 ── */

/**
 * 正規化行の共通部（§1-4 NormalizedRow から rowKey / groupId を除いた形）。
 * rowKey は sourceId（binding 由来の不変な取込元 ID）が要るため importIdentity.attachRowKeys が付与する。
 */
export interface NormalizedRowCore {
  /** ISO 日付（YYYY-MM-DD）。日時は日付へ切り捨て済み。 */
  date: string;
  description: string;
  /** 正整数（最小通貨単位）。 */
  amount: number;
  /** 行種（kindRules の kind 名）。 */
  kind: string;
  counterparty: string;
  /** 自口座側の借/貸。出金(outflow)=credit・入金(inflow)=debit（§3 の表と一致する導出）。 */
  ownSide: Side;
}

/** 評価器が返す正規化行（rowKey 付与前）。 */
export interface EvaluatedImportRow extends NormalizedRowCore {
  /** 元ファイルの物理行番号（1 始まり・レコード開始行）。 */
  rowIndex: number;
  /** デコード後の生行文字列（列解釈前）。fingerprint の素材（トリムは importIdentity 側）。 */
  rawLine: string;
  /** externalId 定義がある場合の canonical tuple の素材（列値の並び）。 */
  externalIdTuple?: string[];
}

/** error 行の理由コード（i18n 文言化は UI フェーズ）。 */
export type ImportRowErrorCode =
  | 'column-count-mismatch'
  | 'date-parse-failed'
  | 'amount-parse-failed'
  | 'amount-both'
  | 'amount-neither'
  | 'amount-not-positive'
  | 'unknown-kind'
  | 'external-id-empty'
  | 'external-id-duplicate';

/** 明示 skip の組み込み理由コード。profile 由来は `rule:<reason>` になる。 */
export type ImportRowSkipCode = 'blank-line' | 'before-header' | `rule:${string}`;

export interface ProfileEvaluation {
  header: string[];
  normalized: EvaluatedImportRow[];
  skipped: { rowIndex: number; reasonCode: ImportRowSkipCode }[];
  errors: { rowIndex: number; reasonCode: ImportRowErrorCode; detail?: string }[];
  /**
   * ヘッダー以外の全レコード数（前置き行を含む）。
   * 保存則: totalRowCount === normalized.length + skipped.length + errors.length。
   */
  totalRowCount: number;
}

/* ── 日付・金額のパース（決定的・Date の TZ 正規化に依存しない） ── */

const DATE_PATTERNS: Record<ImportDateFormat, RegExp> = {
  'YYYY/MM/DD': /^(\d{4})\/(\d{2})\/(\d{2})$/,
  'YYYY-MM-DD': /^(\d{4})-(\d{2})-(\d{2})$/,
  'YYYY/M/D': /^(\d{4})\/(\d{1,2})\/(\d{1,2})$/,
  YYYYMMDD: /^(\d{4})(\d{2})(\d{2})$/,
  'YYYY/MM/DD HH:MM:SS': /^(\d{4})\/(\d{2})\/(\d{2}) (\d{2}):(\d{2}):(\d{2})$/,
  'YYYY-MM-DD HH:MM:SS': /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})$/,
};

/** 書式トークンで日付をパースして ISO 日付にする（日時は切り捨て）。失敗は undefined。 */
export function parseImportDate(value: string, format: ImportDateFormat): string | undefined {
  const m = DATE_PATTERNS[format].exec(value);
  if (!m) return undefined;
  const iso = `${m[1]}-${m[2]!.padStart(2, '0')}-${m[3]!.padStart(2, '0')}`;
  return isValidIsoDate(iso) ? iso : undefined;
}

/**
 * 金額セルをパースする（桁区切りカンマ許容・非負整数）。不正は undefined。
 * カンマは 3 桁区切りの位置のみ許す（`,,1` のようなゴミを受け付けない）。
 */
function parseAmountDigits(value: string): number | undefined {
  if (!/^(\d+|\d{1,3}(,\d{3})+)$/.test(value)) return undefined;
  const n = Number.parseInt(value.replaceAll(',', ''), 10);
  return Number.isSafeInteger(n) ? n : undefined;
}

/* ── 評価器 ── */

/**
 * profile DSL をパース済み CSV レコード列へ適用する（純関数）。
 *
 * ファイル単位のブロッキングエラー（ヘッダー行なし・重複ヘッダー・参照列がヘッダーに無い）は
 * CsvImportError を投げる。行単位の問題は errors へ入れて保存則を守る。
 */
export function evaluateProfile(
  dsl: ImportProfileDsl,
  records: readonly CsvRecord[],
): ProfileEvaluation {
  const table = extractCsvTable(records, dsl.fileFormat.headerRowIndex);
  const colIndex = new Map<string, number>(table.header.map((name, i) => [name, i]));

  // 参照列の解決（欠損列 = profile がこのファイルに合っていない = ファイル単位で止める）。
  const requireColumn = (name: string): number => {
    const idx = colIndex.get(name);
    if (idx === undefined) throw new CsvImportError('csv-column-missing', { column: name });
    return idx;
  };
  const dateIdx = requireColumn(dsl.columns.date.column);
  const amount = dsl.columns.amount;
  const outflowIdx = amount.mode === 'in-out' ? requireColumn(amount.outflowColumn) : undefined;
  const inflowIdx = amount.mode === 'in-out' ? requireColumn(amount.inflowColumn) : undefined;
  const signedIdx = amount.mode === 'signed' ? requireColumn(amount.column) : undefined;
  const descriptionIdx = dsl.columns.description.columns.map(requireColumn);
  const counterpartyIdx =
    dsl.columns.counterparty !== undefined
      ? requireColumn(dsl.columns.counterparty.column)
      : undefined;
  const externalIdIdx = dsl.externalId?.columns.map(requireColumn);
  for (const rule of dsl.skipRules ?? []) conditionColumns(rule.when).forEach(requireColumn);
  for (const rule of dsl.kindRules) conditionColumns(rule.when).forEach(requireColumn);

  const emptyValues = new Set(dsl.emptyValues ?? []);
  /** 空マーカー（trim 後一致）を '' に正規化する。 */
  const normalizeEmpty = (cell: string): string => (emptyValues.has(cell.trim()) ? '' : cell);

  const evalCondition = (cond: ImportCondition, cells: readonly string[]): boolean => {
    switch (cond.op) {
      case 'eq':
        return cells[colIndex.get(cond.column)!] === cond.value;
      case 'prefix':
        return (cells[colIndex.get(cond.column)!] ?? '').startsWith(cond.value);
      case 'suffix':
        return (cells[colIndex.get(cond.column)!] ?? '').endsWith(cond.value);
      case 'contains':
        return (cells[colIndex.get(cond.column)!] ?? '').includes(cond.value);
      case 'and':
        return cond.conditions.every((c) => evalCondition(c, cells));
      case 'or':
        return cond.conditions.some((c) => evalCondition(c, cells));
      case 'not':
        return !evalCondition(cond.condition, cells);
    }
  };

  const normalized: EvaluatedImportRow[] = [];
  const skipped: ProfileEvaluation['skipped'] = [];
  const errors: ProfileEvaluation['errors'] = [];

  // 前置き行（ヘッダーより前）は明示 skip（保存則: 黙って落とさず件数に出す）。
  for (const record of table.preamble) {
    skipped.push({ rowIndex: record.line, reasonCode: 'before-header' });
  }

  for (const record of table.dataRecords) {
    const rowIndex = record.line;
    const cells = record.cells;

    // 空行（1 セルかつ空白のみ）は明示 skip。
    if (cells.length === 1 && cells[0]!.trim() === '') {
      skipped.push({ rowIndex, reasonCode: 'blank-line' });
      continue;
    }
    // 列数不一致はその行だけ error（ファイル全体は止めない）。
    if (cells.length !== table.header.length) {
      errors.push({
        rowIndex,
        reasonCode: 'column-count-mismatch',
        detail: `${cells.length} 列（ヘッダーは ${table.header.length} 列）`,
      });
      continue;
    }

    // 明示 skip 条件（上から評価・最初に一致）。
    const skipRule = (dsl.skipRules ?? []).find((r) => evalCondition(r.when, cells));
    if (skipRule) {
      skipped.push({ rowIndex, reasonCode: `rule:${skipRule.reason}` });
      continue;
    }

    // 行種分類。どれにも一致しない行は未知 kind = error（黙って捨てない）。
    const kindRule = dsl.kindRules.find((r) => evalCondition(r.when, cells));
    if (kindRule === undefined) {
      errors.push({ rowIndex, reasonCode: 'unknown-kind', detail: record.raw.slice(0, 120) });
      continue;
    }

    // 日付。
    const dateValue = normalizeEmpty(cells[dateIdx]!).trim();
    const date = parseImportDate(dateValue, dsl.columns.date.format);
    if (date === undefined) {
      errors.push({ rowIndex, reasonCode: 'date-parse-failed', detail: dateValue });
      continue;
    }

    // 金額 → 金額と自口座側（出金=貸方 / 入金=借方）。
    let amountValue: number;
    let ownSide: Side;
    if (amount.mode === 'in-out') {
      const outRaw = normalizeEmpty(cells[outflowIdx!]!).trim();
      const inRaw = normalizeEmpty(cells[inflowIdx!]!).trim();
      if (outRaw !== '' && inRaw !== '') {
        errors.push({ rowIndex, reasonCode: 'amount-both', detail: `${outRaw} / ${inRaw}` });
        continue;
      }
      if (outRaw === '' && inRaw === '') {
        errors.push({ rowIndex, reasonCode: 'amount-neither' });
        continue;
      }
      const raw = outRaw !== '' ? outRaw : inRaw;
      const parsed = parseAmountDigits(raw);
      if (parsed === undefined) {
        errors.push({ rowIndex, reasonCode: 'amount-parse-failed', detail: raw });
        continue;
      }
      if (parsed <= 0) {
        errors.push({ rowIndex, reasonCode: 'amount-not-positive', detail: raw });
        continue;
      }
      amountValue = parsed;
      ownSide = outRaw !== '' ? 'credit' : 'debit';
    } else {
      const raw = normalizeEmpty(cells[signedIdx!]!).trim();
      if (raw === '') {
        errors.push({ rowIndex, reasonCode: 'amount-neither' });
        continue;
      }
      const negative = raw.startsWith('-');
      const digits = negative || raw.startsWith('+') ? raw.slice(1) : raw;
      const parsed = parseAmountDigits(digits);
      if (parsed === undefined) {
        errors.push({ rowIndex, reasonCode: 'amount-parse-failed', detail: raw });
        continue;
      }
      if (parsed === 0) {
        errors.push({ rowIndex, reasonCode: 'amount-not-positive', detail: raw });
        continue;
      }
      // 符号と positiveDirection から入出金方向を決める（正 = positiveDirection の向き）。
      const inflow = !negative === (amount.positiveDirection === 'inflow');
      amountValue = parsed;
      ownSide = inflow ? 'debit' : 'credit';
    }

    // externalId（emptyValues 正規化はかけない = 原文のまま識別に使う）。
    let externalIdTuple: string[] | undefined;
    if (externalIdIdx !== undefined) {
      externalIdTuple = externalIdIdx.map((i) => cells[i]!);
      if (externalIdTuple.every((v) => v.trim() === '')) {
        errors.push({ rowIndex, reasonCode: 'external-id-empty' });
        continue;
      }
    }

    // 摘要・取引先。
    const separator = dsl.columns.description.separator ?? ' ';
    const description = descriptionIdx
      .map((i) => normalizeEmpty(cells[i]!).trim())
      .filter((v) => v !== '')
      .join(separator);
    const counterparty =
      counterpartyIdx !== undefined ? normalizeEmpty(cells[counterpartyIdx]!).trim() : '';

    normalized.push({
      rowIndex,
      rawLine: record.raw,
      date,
      description,
      amount: amountValue,
      kind: kindRule.kind,
      counterparty,
      ownSide,
      ...(externalIdTuple !== undefined ? { externalIdTuple } : {}),
    });
  }

  // externalId のファイル内衝突: 同一タプルが複数行にあると決定的照合（§5-1）が成立しない。
  // デデュープ層へ持ち込まず、評価段階で該当する**全行**を error に倒して件数会計へ出す
  // （黙って片方に寄せない・決定の削除にもつながらない）。
  if (externalIdIdx !== undefined) {
    const tupleCounts = new Map<string, number>();
    for (const row of normalized) {
      if (row.externalIdTuple === undefined) continue;
      const key = JSON.stringify(row.externalIdTuple);
      tupleCounts.set(key, (tupleCounts.get(key) ?? 0) + 1);
    }
    if ([...tupleCounts.values()].some((count) => count > 1)) {
      for (let i = normalized.length - 1; i >= 0; i -= 1) {
        const row = normalized[i]!;
        if (row.externalIdTuple === undefined) continue;
        if ((tupleCounts.get(JSON.stringify(row.externalIdTuple)) ?? 0) > 1) {
          errors.push({
            rowIndex: row.rowIndex,
            reasonCode: 'external-id-duplicate',
            detail: row.externalIdTuple.join(' / ').slice(0, 120),
          });
          normalized.splice(i, 1);
        }
      }
      // 衝突分の error は後から足すため、明細表示を行順へ戻す。
      errors.sort((a, b) => a.rowIndex - b.rowIndex);
    }
  }

  return {
    header: table.header,
    normalized,
    skipped,
    errors,
    totalRowCount: table.preamble.length + table.dataRecords.length,
  };
}

/** テキストから直接評価する便宜関数（delimiter は DSL の fileFormat から取る）。 */
export function evaluateProfileText(dsl: ImportProfileDsl, text: string): ProfileEvaluation {
  return evaluateProfile(dsl, parseCsv(text, { delimiter: dsl.fileFormat.delimiter }));
}
