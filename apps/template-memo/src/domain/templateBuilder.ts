/*
 * テンプレート作成アシストの一時契約。
 *
 * 外部 AI の返答は信頼できない入力として扱い、ここで定義する key は候補内参照にだけ使う。
 * Frame / Format / TemplateDef の永続 ID は、候補確認後にアプリがすべて新規採番する。
 */

import { newId } from '../data/constants';
import {
  normalizeFormat,
  normalizeFrame,
  normalizeTemplateDef,
  type Format,
  type Frame,
  type TemplateDef,
} from './entities';
import type { TemplatePresetBundle } from './presets';
import type { ItemKind, PlacementDisplay, TemplateItem } from './template';

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
    | 'invalid-section'
    | 'invalid-format'
    | 'invalid-item'
    | 'select-downgraded'
    | 'display-coerced'
    | 'unresolved-placement'
    | 'unresolved-memo'
    | 'limit-exceeded'
    | 'normalize-dropped';
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
 * 医療へ寄せず、4 種の項目・複数の区切り・自由本文なしの場所・always/oncall 両方の配置を含める。
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
    "placements": [
      { "sectionKey": "sec_readings", "formatKey": "fmt_readings", "display": "always" },
      { "sectionKey": "sec_summary", "formatKey": "fmt_appearance", "display": "oncall" }
    ]
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

const JOINERS = new Set(['\n', ', ', '、', '-', ' ']);
const LABEL_SEPARATORS = new Set(['：', ' ', '']);
const ITEM_KINDS = new Set<ItemKind>(['text', 'number', 'fraction', 'select']);

function recordOf(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function stringOf(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function limited(value: string, max: number, label: string, warnings: BuilderWarning[]): string {
  if (value.length <= max) return value;
  warnings.push({
    code: 'limit-exceeded',
    message: `${label}が${max}文字を超えたため短縮しました`,
  });
  return value.slice(0, max);
}

function isTruncatedObject(text: string): boolean {
  let depth = 0;
  let found = false;
  let inString = false;
  let escaped = false;
  for (const char of text) {
    if (inString) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if (char === '{') {
      found = true;
      depth += 1;
    } else if (char === '}' && found) depth -= 1;
  }
  return found && depth > 0;
}

function parseItem(
  raw: unknown,
  formatName: string,
  warnings: BuilderWarning[],
): BuilderItemCandidate | null {
  const row = recordOf(raw);
  if (!row) {
    warnings.push({ code: 'invalid-item', message: `「${formatName}」の不正な項目を除外しました` });
    return null;
  }
  const label = limited(stringOf(row.label), 20, '項目名', warnings);
  const requestedKind = stringOf(row.kind) as ItemKind;
  let kind: ItemKind = ITEM_KINDS.has(requestedKind) ? requestedKind : 'text';
  // normal は text でしか使わない。捨てる値の字数超過を警告しても利用者には意味が取れないため、
  // text になり得る場合だけ検証する (select は options 不足で text へ降格することがある)。
  const normal =
    kind === 'text' || kind === 'select'
      ? limited(stringOf(row.normal), 40, `「${label || formatName}」の正常文`, warnings)
      : '';

  if (kind === 'select') {
    const seen = new Set<string>();
    const options = (Array.isArray(row.options) ? row.options : [])
      .map(stringOf)
      .filter((option) => {
        if (!option || seen.has(option)) return false;
        seen.add(option);
        return true;
      })
      .slice(0, 8);
    if (options.length < 2) {
      kind = 'text';
      warnings.push({
        code: 'select-downgraded',
        message: `「${label || formatName}」は選択肢が2個未満のため文章へ変更しました`,
      });
      if (!label && !normal) {
        warnings.push({
          code: 'invalid-item',
          message: `「${formatName}」の空項目を除外しました`,
        });
        return null;
      }
      return normal ? { label, kind, normal } : { label, kind };
    }
    return { label, kind, options };
  }

  if (kind === 'number' || kind === 'fraction') {
    const unit = limited(stringOf(row.unit), 20, `「${label || formatName}」の単位`, warnings);
    return unit ? { label, kind, unit } : { label, kind };
  }
  if (!label && !normal) {
    warnings.push({
      code: 'invalid-item',
      message: `「${formatName}」のラベルも正常文もない文章項目を除外しました`,
    });
    return null;
  }
  return normal ? { label, kind: 'text', normal } : { label, kind: 'text' };
}

export function parseBuilderResponse(text: string, requestId: string): BuilderParseResult {
  const source = String(text ?? '');
  if (source.trim() === '') return { ok: false, code: 'empty' };
  if (source.length > BUILDER_RESPONSE_MAX_CHARS) return { ok: false, code: 'too-large' };

  const jsonText = extractJsonText(source);
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch {
    return { ok: false, code: isTruncatedObject(jsonText) ? 'truncated' : 'invalid-json' };
  }
  const root = recordOf(parsed);
  if (!root) return { ok: false, code: 'not-object' };
  if (root.kind !== BUILDER_KIND) return { ok: false, code: 'wrong-kind' };
  if (root.version !== BUILDER_VERSION) return { ok: false, code: 'wrong-version' };
  if (root.requestId !== requestId) return { ok: false, code: 'request-mismatch' };

  const warnings: BuilderWarning[] = [];
  const frameRow = recordOf(root.frame) ?? {};
  const rawSections = Array.isArray(frameRow.sections) ? frameRow.sections : [];
  const sections: BuilderSectionCandidate[] = [];
  const sectionKeys = new Set<string>();
  for (const raw of rawSections.slice(0, 10)) {
    const row = recordOf(raw);
    if (!row) {
      warnings.push({ code: 'invalid-section', message: '不正な場所を除外しました' });
      continue;
    }
    const key = stringOf(row.key);
    if (!key) {
      warnings.push({ code: 'invalid-section', message: 'key の無い場所を除外しました' });
      continue;
    }
    if (sectionKeys.has(key)) {
      warnings.push({ code: 'duplicate-key', message: `重複した場所キー「${key}」を除外しました` });
      continue;
    }
    sectionKeys.add(key);
    sections.push({
      key,
      title: limited(stringOf(row.title), 80, '場所の見出し', warnings),
      freeText: row.freeText === true,
    });
  }
  if (rawSections.length > 10) {
    warnings.push({ code: 'limit-exceeded', message: '場所は先頭10個だけを取り込みました' });
  }
  if (sections.length === 0) return { ok: false, code: 'no-sections' };

  const formats: BuilderFormatCandidate[] = [];
  const formatKeys = new Set<string>();
  const rawFormats = Array.isArray(root.formats) ? root.formats : [];
  for (const raw of rawFormats.slice(0, 12)) {
    const row = recordOf(raw);
    if (!row) {
      warnings.push({ code: 'invalid-format', message: '不正なフォーマットを除外しました' });
      continue;
    }
    const key = stringOf(row.key);
    if (!key) {
      warnings.push({ code: 'invalid-format', message: 'key の無いフォーマットを除外しました' });
      continue;
    }
    if (formatKeys.has(key)) {
      warnings.push({
        code: 'duplicate-key',
        message: `重複したフォーマットキー「${key}」を除外しました`,
      });
      continue;
    }
    const name = limited(
      stringOf(row.name) || '(無題フォーマット)',
      40,
      'フォーマット名',
      warnings,
    );
    const rawItems = Array.isArray(row.items) ? row.items : [];
    const items = rawItems
      .slice(0, 12)
      .map((item) => parseItem(item, name, warnings))
      .filter((item): item is BuilderItemCandidate => item !== null);
    if (rawItems.length > 12) {
      warnings.push({
        code: 'limit-exceeded',
        message: `「${name}」の項目は先頭12個だけを取り込みました`,
      });
    }
    if (items.length === 0) {
      warnings.push({
        code: 'invalid-item',
        message: `「${name}」は有効な項目がないため除外しました`,
      });
      continue;
    }
    formatKeys.add(key);
    const joiner = typeof row.joiner === 'string' && JOINERS.has(row.joiner) ? row.joiner : '\n';
    const labelSep =
      typeof row.labelSep === 'string' && LABEL_SEPARATORS.has(row.labelSep) ? row.labelSep : '：';
    formats.push({ key, name, joiner, labelSep, items });
  }
  if (rawFormats.length > 12) {
    warnings.push({
      code: 'limit-exceeded',
      message: 'フォーマットは先頭12個だけを取り込みました',
    });
  }

  const templateRow = recordOf(root.template) ?? {};
  const placements: BuilderPlacementCandidate[] = [];
  const placementCountBySection = new Map<string, number>();
  const rawPlacements = Array.isArray(templateRow.placements) ? templateRow.placements : [];
  for (const raw of rawPlacements) {
    const row = recordOf(raw);
    if (!row) continue;
    const sectionKey = stringOf(row.sectionKey);
    const formatKey = stringOf(row.formatKey);
    if (!sectionKeys.has(sectionKey) || !formatKeys.has(formatKey)) {
      warnings.push({
        code: 'unresolved-placement',
        message: `参照先が見つからない配置（場所: ${sectionKey || '未指定'} / フォーマット: ${formatKey || '未指定'}）を除外しました`,
      });
      continue;
    }
    const count = placementCountBySection.get(sectionKey) ?? 0;
    if (count >= 5) {
      warnings.push({
        code: 'limit-exceeded',
        message: `場所「${sectionKey}」の6個目以降の配置を除外しました`,
      });
      continue;
    }
    placementCountBySection.set(sectionKey, count + 1);
    // menu と未知値は always へ寄せる (合成に必ず出る安全側)。黙って寄せず必ず知らせる。
    const requestedDisplay = stringOf(row.display);
    if (requestedDisplay !== '' && requestedDisplay !== 'always' && requestedDisplay !== 'oncall') {
      warnings.push({
        code: 'display-coerced',
        message: `表示方法「${requestedDisplay}」は使えないため「展開」にしました`,
      });
    }
    placements.push({
      sectionKey,
      formatKey,
      display: requestedDisplay === 'oncall' ? 'oncall' : 'always',
    });
  }

  let memoSectionKey = stringOf(templateRow.memoSectionKey);
  if (memoSectionKey && !sectionKeys.has(memoSectionKey)) {
    warnings.push({
      code: 'unresolved-memo',
      message: `今回メモの場所「${memoSectionKey}」が見つからないため設定しませんでした`,
    });
    memoSectionKey = '';
  }
  if (memoSectionKey) {
    const memoSection = sections.find((section) => section.key === memoSectionKey);
    if (memoSection) memoSection.freeText = true;
  }

  const aiWarnings = (Array.isArray(root.warnings) ? root.warnings : [])
    .map(stringOf)
    .filter(Boolean)
    .slice(0, 20);
  const template: BuilderCandidate['template'] = {
    name: limited(
      stringOf(templateRow.name) || '(無題テンプレート)',
      40,
      'テンプレート名',
      warnings,
    ),
    includeProblems: templateRow.includeProblems === true,
    includeHandover: templateRow.includeHandover === true,
    placements,
  };
  if (memoSectionKey) template.memoSectionKey = memoSectionKey;

  return {
    ok: true,
    candidate: {
      requestId,
      frame: {
        name: limited(stringOf(frameRow.name) || '(無題フレーム)', 40, 'フレーム名', warnings),
        sections,
      },
      formats,
      template,
      aiWarnings,
    },
    warnings,
  };
}

function itemFromCandidate(candidate: BuilderItemCandidate): TemplateItem {
  const item: TemplateItem = {
    id: newId('itm'),
    label: candidate.label,
    kind: candidate.kind,
  };
  if (candidate.kind === 'number' || candidate.kind === 'fraction') {
    if (candidate.unit) item.unit = candidate.unit;
  } else if (candidate.kind === 'select') item.options = [...(candidate.options ?? [])];
  else if (candidate.normal) item.normal = candidate.normal;
  return item;
}

export function buildBundleFromCandidate(candidate: BuilderCandidate): {
  bundle: TemplatePresetBundle;
  warnings: BuilderWarning[];
} {
  const sectionIdByKey = new Map<string, string>();
  const frame: Frame = {
    id: newId('frm'),
    name: candidate.frame.name,
    sections: candidate.frame.sections.map((section) => {
      const id = newId('sec');
      sectionIdByKey.set(section.key, id);
      return {
        id,
        title: section.title,
        freeText: section.freeText || candidate.template.memoSectionKey === section.key,
      };
    }),
  };

  const formatIdByKey = new Map<string, string>();
  const formats: Format[] = candidate.formats.map((format) => {
    const id = newId('fmt');
    formatIdByKey.set(format.key, id);
    return {
      id,
      name: format.name,
      joiner: format.joiner,
      labelSep: format.labelSep,
      titleWrap: '',
      items: format.items.map(itemFromCandidate),
    };
  });

  const template: TemplateDef = {
    id: newId('tpl'),
    name: candidate.template.name,
    frameId: frame.id,
    memoSectionId: candidate.template.memoSectionKey
      ? (sectionIdByKey.get(candidate.template.memoSectionKey) ?? null)
      : null,
    includeProblems: candidate.template.includeProblems,
    includeHandover: candidate.template.includeHandover,
    placements: candidate.template.placements.flatMap((placement) => {
      const sectionId = sectionIdByKey.get(placement.sectionKey);
      const formatId = formatIdByKey.get(placement.formatKey);
      return sectionId && formatId
        ? [
            {
              id: newId('plm'),
              sectionId,
              formatId,
              display: placement.display,
            },
          ]
        : [];
    }),
    updatedAt: Date.now(),
  };

  const normalizedFrame = normalizeFrame(frame);
  const normalizedFormats = formats.map(normalizeFormat);
  if (!normalizedFrame || normalizedFormats.some((format) => format === null)) {
    throw new Error('生成候補の正規化に失敗しました');
  }
  const safeFormats = normalizedFormats.filter((format): format is Format => format !== null);
  const normalizedTemplate = normalizeTemplateDef(template, {
    frames: [normalizedFrame],
    formats: safeFormats,
  });
  if (!normalizedTemplate) throw new Error('生成候補の正規化に失敗しました');

  // 二重防御の「検知」側。ここで件数が減るのは candidate → entity 変換の不具合であり、
  // 本来は常に 0 件（正常系で warnings が空であることをテストで固定している）。
  const warnings: BuilderWarning[] = [];
  const lost = (kindLabel: string, before: number, after: number) => {
    if (after < before) {
      warnings.push({
        code: 'normalize-dropped',
        message: `${kindLabel}を ${before - after} 件取り込めませんでした`,
      });
    }
  };
  lost('場所', frame.sections.length, normalizedFrame.sections.length);
  lost('フォーマット', formats.length, safeFormats.length);
  lost('配置', template.placements.length, normalizedTemplate.placements.length);
  for (const [index, format] of formats.entries()) {
    const after = safeFormats[index];
    if (after) lost(`「${format.name}」の項目`, format.items.length, after.items.length);
  }

  return {
    bundle: {
      frame: normalizedFrame,
      formats: safeFormats,
      template: normalizedTemplate,
    },
    warnings,
  };
}
