/*
 * DSL 検証エラー（zod issue）→ 日本語文言（指示書 §6-3 / §2 の fail-closed 表示）。
 *
 * AI ビルダーと JSON 貼付の検証は fail-closed（部分保存しない・再貼付でやり直す）なので、
 * 「どこが」「なぜ」弾かれたのかが読めないと、AI に何を直させればよいか分からない。
 * zod の既定 message は英語なので、issue の code / path から日本語へ写す。
 *
 *  - path は DSL のフィールド名。対応表にあるものは日本語ラベルへ、無いものは原文のまま
 *    （ユーザーが貼った JSON のキーそのもの＝原文の方が場所を特定しやすい）。
 *  - **未知 code でも英語を生で出さない**: 対応表に無い code は「<場所> の値が不正です」へ倒す。
 *  - code=custom は schema 側（importDsl.ts）で日本語 message を書いているのでそれを使う。
 *    zod 既定の英語が紛れ込む余地を塞ぐため、日本語を含むことを確認してから通す。
 *  - 文言は i18n（ja.ts）が正本。ここは組み立てだけを持つ純関数。
 */
import { ZodError } from 'zod';
import { errorText, t, type MessageKey } from '../i18n';

/** zod v4 の issue 型（ZodError の要素型から引く＝zod の内部型名に依存しない）。 */
type DslIssue = ZodError['issues'][number];

/** 一度に見せる issue の件数（多すぎると読めない。残りは直して貼り直せば出る）。 */
export const DSL_ISSUE_DISPLAY_LIMIT = 5;

/** DSL のフィールド名 → 日本語ラベルのキー（欠けるとコンパイルエラーになる MessageKey）。 */
const DSL_FIELD_LABEL_KEYS: Record<string, MessageKey> = {
  dslVersion: 'csvImport.dslField.dslVersion',
  fileFormat: 'csvImport.dslField.fileFormat',
  encoding: 'csvImport.dslField.encoding',
  delimiter: 'csvImport.dslField.delimiter',
  headerRowIndex: 'csvImport.dslField.headerRowIndex',
  emptyValues: 'csvImport.dslField.emptyValues',
  columns: 'csvImport.dslField.columns',
  date: 'csvImport.dslField.date',
  column: 'csvImport.dslField.column',
  format: 'csvImport.dslField.format',
  amount: 'csvImport.dslField.amount',
  mode: 'csvImport.dslField.mode',
  outflowColumn: 'csvImport.dslField.outflowColumn',
  inflowColumn: 'csvImport.dslField.inflowColumn',
  positiveDirection: 'csvImport.dslField.positiveDirection',
  description: 'csvImport.dslField.description',
  separator: 'csvImport.dslField.separator',
  counterparty: 'csvImport.dslField.counterparty',
  externalId: 'csvImport.dslField.externalId',
  skipRules: 'csvImport.dslField.skipRules',
  kindRules: 'csvImport.dslField.kindRules',
  when: 'csvImport.dslField.when',
  reason: 'csvImport.dslField.reason',
  kind: 'csvImport.dslField.kind',
  op: 'csvImport.dslField.op',
  value: 'csvImport.dslField.value',
  conditions: 'csvImport.dslField.conditions',
  condition: 'csvImport.dslField.condition',
};

/** zod の expected（型名）→ 日本語ラベルのキー。未知の型名は undefined（fallback へ倒す）。 */
const TYPE_LABEL_KEYS: Record<string, MessageKey> = {
  object: 'csvImport.dslIssue.type.object',
  array: 'csvImport.dslIssue.type.array',
  string: 'csvImport.dslIssue.type.string',
  number: 'csvImport.dslIssue.type.number',
  boolean: 'csvImport.dslIssue.type.boolean',
};

/** 上限・下限メッセージのキー（対象が配列 / 文字列 / それ以外＝数値で単位が変わる）。 */
const LIMIT_KEYS = {
  tooSmall: {
    array: 'csvImport.dslIssue.tooSmall.array',
    string: 'csvImport.dslIssue.tooSmall.string',
    number: 'csvImport.dslIssue.tooSmall.number',
  },
  tooBig: {
    array: 'csvImport.dslIssue.tooBig.array',
    string: 'csvImport.dslIssue.tooBig.string',
    number: 'csvImport.dslIssue.tooBig.number',
  },
} satisfies Record<'tooSmall' | 'tooBig', Record<'array' | 'string' | 'number', MessageKey>>;

function fieldLabel(name: string): string {
  const key = DSL_FIELD_LABEL_KEYS[name];
  return key !== undefined ? t(key) : name;
}

/** issue の path → 「ファイル形式 > 文字コード」「行種の分類 > 1 番目 > 条件」。 */
function pathLabel(path: readonly PropertyKey[]): string {
  if (path.length === 0) return t('csvImport.dslIssue.root');
  return path
    .map((segment) =>
      typeof segment === 'number'
        ? t('csvImport.dslIssue.index', { n: segment + 1 })
        : fieldLabel(String(segment)),
    )
    .join(' > ');
}

/** path をたどって元の JSON の値を取り出す（無ければ undefined）。 */
function valueAtPath(source: unknown, path: readonly PropertyKey[]): unknown {
  let current = source;
  for (const segment of path) {
    if (current === null || typeof current !== 'object') return undefined;
    current = (current as Record<PropertyKey, unknown>)[segment];
  }
  return current;
}

/** enum / literal の候補値を表示用テキストへ（DSL の候補は文字列・数値のみ）。 */
function valueText(value: unknown): string {
  return typeof value === 'string' ? value : String(value);
}

/**
 * discriminatedUnion の判別子違いは、zod が型に無い `options`（候補値）を実行時に載せてくる。
 * 型では読めないので runtime で形を確かめてから使う（読めなければ候補なしの文言へ倒す）。
 */
function discriminatorOptions(issue: DslIssue): string[] | undefined {
  const raw = (issue as { options?: unknown }).options;
  if (!Array.isArray(raw) || raw.length === 0) return undefined;
  if (!raw.every((option) => typeof option === 'string' || typeof option === 'number')) {
    return undefined;
  }
  return raw.map((option) => String(option));
}

/** 日本語（漢字・かな）を含むか。custom message が自前の日本語であることの確認に使う。 */
function looksJapanese(text: string): boolean {
  return /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u.test(text);
}

function limitKey(bound: 'tooSmall' | 'tooBig', origin: string): MessageKey {
  if (origin === 'array') return LIMIT_KEYS[bound].array;
  if (origin === 'string') return LIMIT_KEYS[bound].string;
  return LIMIT_KEYS[bound].number;
}

/**
 * zod issue 1 件 → 日本語 1 行。
 *
 * @param source 検証にかけた元の値（貼り付けた JSON）。渡すと「未指定（必須欠落）」と
 *   「型違い」を区別できる（zod v4 の issue は入力値を持たないため path でたどる）。
 */
export function dslIssueText(issue: DslIssue, source?: unknown): string {
  const path = pathLabel(issue.path);
  switch (issue.code) {
    case 'unrecognized_keys':
      return t('csvImport.dslIssue.unrecognizedKeys', { path, keys: issue.keys.join('、') });
    case 'invalid_type': {
      if (source !== undefined && valueAtPath(source, issue.path) === undefined) {
        return t('csvImport.dslIssue.required', { path });
      }
      const typeKey = TYPE_LABEL_KEYS[String(issue.expected)];
      return typeKey === undefined
        ? t('csvImport.dslIssue.fallback', { path })
        : t('csvImport.dslIssue.type', { path, expected: t(typeKey) });
    }
    case 'invalid_value': {
      const values = issue.values.map(valueText);
      return values.length === 1
        ? t('csvImport.dslIssue.exact', { path, value: values[0]! })
        : t('csvImport.dslIssue.oneOf', { path, values: values.join('、') });
    }
    case 'invalid_union': {
      const options = discriminatorOptions(issue);
      return options === undefined
        ? t('csvImport.dslIssue.union', { path })
        : t('csvImport.dslIssue.oneOf', { path, values: options.join('、') });
    }
    case 'too_small':
      return t(limitKey('tooSmall', String(issue.origin)), {
        path,
        limit: Number(issue.minimum),
      });
    case 'too_big':
      return t(limitKey('tooBig', String(issue.origin)), { path, limit: Number(issue.maximum) });
    case 'invalid_format':
      return t('csvImport.dslIssue.format', { path });
    case 'custom':
      return looksJapanese(issue.message)
        ? issue.message
        : t('csvImport.dslIssue.fallback', { path });
    default:
      return t('csvImport.dslIssue.fallback', { path });
  }
}

/**
 * DSL 検証の例外 → ユーザー表示文言。ZodError は日本語 issue を並べ、それ以外は既存の
 * errorText へ渡す（CsvImportError などはこれまでどおり code から引かれる）。
 */
export function dslIssuesText(e: unknown, source?: unknown): string {
  if (e instanceof ZodError) {
    const issues = e.issues
      .slice(0, DSL_ISSUE_DISPLAY_LIMIT)
      .map((issue) => dslIssueText(issue, source))
      .join(' / ');
    return t('csvImport.profiles.dslInvalid', { issues });
  }
  return errorText(e);
}
