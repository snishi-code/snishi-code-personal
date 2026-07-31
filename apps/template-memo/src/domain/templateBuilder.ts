/*
 * テンプレート作成アシストの一時契約。
 *
 * 外部 AI の返答は信頼できない入力として扱い、ここで定義する key は候補内参照にだけ使う。
 * Frame / Format / TemplateDef の永続 ID は、候補確認後にアプリがすべて新規採番する。
 */

import type { ItemKind, PlacementDisplay } from './template';

export const BUILDER_KIND = 'template-memo-builder' as const;
export const BUILDER_VERSION = 1 as const;
export const BUILDER_RESPONSE_MAX_CHARS = 100_000;

export interface BuilderSectionCandidate {
  key: string;
  title: string;
  freeText: boolean;
}

export interface BuilderItemCandidate {
  label: string;
  kind: ItemKind;
  unit?: string;
  normal?: string;
  options?: string[];
}

export interface BuilderFormatCandidate {
  key: string;
  name: string;
  joiner: string;
  labelSep: string;
  items: BuilderItemCandidate[];
}

export interface BuilderPlacementCandidate {
  sectionKey: string;
  formatKey: string;
  display: Exclude<PlacementDisplay, 'menu'>;
}

export interface BuilderCandidate {
  requestId: string;
  frame: {
    name: string;
    sections: BuilderSectionCandidate[];
  };
  formats: BuilderFormatCandidate[];
  template: {
    name: string;
    memoSectionKey?: string;
    includeProblems: boolean;
    includeHandover: boolean;
    placements: BuilderPlacementCandidate[];
  };
  aiWarnings: string[];
}

export interface BuilderWarning {
  code:
    | 'duplicate-key'
    | 'invalid-item'
    | 'select-downgraded'
    | 'unresolved-placement'
    | 'unresolved-memo'
    | 'limit-exceeded';
  message: string;
}

export type BuilderParseErrorCode =
  | 'empty'
  | 'invalid-json'
  | 'not-object'
  | 'wrong-kind'
  | 'wrong-version'
  | 'request-mismatch'
  | 'truncated'
  | 'no-sections'
  | 'too-large';

export type BuilderParseResult =
  | { ok: true; candidate: BuilderCandidate; warnings: BuilderWarning[] }
  | { ok: false; code: BuilderParseErrorCode };

/**
 * 依頼文とパーサが共有する唯一の期待 JSON 例。
 * 医療へ寄せず、4 種の項目・複数の区切り・自由本文なしの場所・空配置を含める。
 */
export const BUILDER_EXPECTED_JSON = `{
  "kind": "template-memo-builder",
  "version": 1,
  "requestId": "<依頼文の requestId をそのまま返す>",
  "frame": {
    "name": "設備点検",
    "sections": [
      { "key": "sec_summary", "title": "【点検概要】", "freeText": true },
      { "key": "sec_readings", "title": "【測定値】", "freeText": false }
    ]
  },
  "formats": [
    {
      "key": "fmt_readings",
      "name": "測定結果",
      "joiner": ", ",
      "labelSep": " ",
      "items": [
        { "label": "温度", "kind": "number", "unit": "℃" },
        { "label": "混合比", "kind": "fraction" },
        { "label": "運転モード", "kind": "select", "options": ["自動", "手動"] }
      ]
    },
    {
      "key": "fmt_appearance",
      "name": "外観",
      "joiner": "\\n",
      "labelSep": "：",
      "items": [
        { "label": "外装", "kind": "text", "normal": "異常なし" }
      ]
    }
  ],
  "template": {
    "name": "設備点検メモ",
    "memoSectionKey": "sec_summary",
    "includeProblems": false,
    "includeHandover": false,
    "placements": []
  },
  "warnings": []
}`;

function parseableJson(text: string): boolean {
  try {
    JSON.parse(text);
    return true;
  } catch {
    return false;
  }
}

/** 文字列リテラル内の波括弧を無視し、最初の対応する JSON object 候補を切り出す。 */
function balancedObjectFrom(text: string, start: number): string | null {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < text.length; index += 1) {
    const char = text[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') {
      inString = true;
      continue;
    }
    if (char === '{') depth += 1;
    else if (char === '}') {
      depth -= 1;
      if (depth === 0) return text.slice(start, index + 1).trim();
    }
  }
  return null;
}

/**
 * 外部 AI の返答から JSON 候補を抽出する。
 * 複数フェンスは parse できるものを順に探し、次に全文、最後に散文中の balanced object を試す。
 * 対応する閉じ波括弧が無い場合は先頭波括弧以降を返し、呼び出し側が truncated と判定できる。
 */
export function extractJsonText(text: string): string {
  const source = String(text ?? '').trim();
  if (source === '') return '';

  const fenced: string[] = [];
  const fencePattern = /```(?:json)?\s*([\s\S]*?)```/gi;
  for (const match of source.matchAll(fencePattern)) {
    const candidate = String(match[1] ?? '').trim();
    if (candidate) fenced.push(candidate);
  }
  const validFence = fenced.find(parseableJson);
  if (validFence) return validFence;
  if (parseableJson(source)) return source;

  let firstUnclosed = '';
  for (let start = source.indexOf('{'); start >= 0; start = source.indexOf('{', start + 1)) {
    const candidate = balancedObjectFrom(source, start);
    if (candidate && parseableJson(candidate)) return candidate;
    if (!candidate && firstUnclosed === '') firstUnclosed = source.slice(start).trim();
  }
  return firstUnclosed || fenced[0] || source;
}
