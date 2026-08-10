/*
 * 解決済みテンプレートと本文合成エンジン。
 *
 * 永続化の正本は entities.ts の TemplateDef / Frame / Format。ここで定義する Template は
 * resolveTemplate が入力 UI と合成処理へ渡す読み取り用の形で、PlacedFormat.id には
 * FormatPlacement.id が入る。
 *
 * 合成は「空の枝を落としながら join する」再帰 1 本（空伝播）。空項目で区切りが
 * 二重になる・空行だけ残る問題を原理的に起こさない。テンプレートに条件分岐や式は
 * 持たせない（logic-less 原則。入れた瞬間に言語処理系の所有になるため）。
 *
 * 旧回診との対応:
 *   display 'always' = 旧 expand（値を保存し合成時に出力）
 *   display 'oncall' = 旧 quick（チップから入力シートを開く）
 *   display 'menu' = 旧 menu（ハンバーガーメニューから入力シートを開く）
 */

import { newId } from '../data/constants';
import {
  readPlacementValues,
  readNumericEntry,
  readSelectValue,
  readTextValue,
} from './formValues';
import type { FormValues, Patient } from './types';

// ============================
// 型
// ============================

export type ItemKind = 'text' | 'number' | 'fraction' | 'select';

/** 配置方法。always = 展開 / oncall = 呼び出し / menu = メニュー。値はいずれも保存する。 */
export type PlacementDisplay = 'always' | 'oncall' | 'menu';

/** フォーマットの小項目。text は正常文チェック（normal）対応。 */
export interface TemplateItem {
  id: string;
  label: string;
  kind: ItemKind;
  /** number/fraction の単位（例 mmHg, %）。値の直後に付く。 */
  unit?: string;
  /** text の正常文（長押しチェック入力の対象）。 */
  normal?: string;
  /** select の選択肢（1 個以上）。 */
  options?: string[];
  /** 合成でラベルを出すか。未定義は true 扱い。false は値だけを出す。 */
  showLabel?: boolean;
}

/** 解決済みの配置フォーマット。id は配置 ID。 */
export interface PlacedFormat {
  id: string;
  name: string;
  display: PlacementDisplay;
  /** 項目間の区切り（例 ", " / "\n" / "-"）。 */
  joiner: string;
  /** ラベルと値の区切り（例 "：" / " "）。 */
  labelSep: string;
  /**
   * 合成時に群名を囲んでタイトル行にする括弧ペア（例 "（）" → "（バイタル）"）。
   * 空 = タイトル行なし。
   */
  titleWrap: string;
  items: TemplateItem[];
}

/** フレーム内の場所。自由本文欄 + 解決済み配置の入れ物。 */
export interface TemplateSection {
  id: string;
  /** 見出し（例 "(S)" / "今日やったこと"）。空 = 見出し行なし。 */
  title: string;
  /** 自由本文欄を持つか。 */
  freeText: boolean;
  /** 自由本文の正常文（完成文の空欄をこれで補う。例 "著変なし"）。 */
  normal?: string;
  formats: PlacedFormat[];
}

/** 入力 UI・合成処理向けの解決済みテンプレート。永続化しない。 */
export interface Template {
  id: string;
  name: string;
  /** 合成に問題リストブロックを含めるか（日報などでは false）。 */
  includeProblems: boolean;
  /** 合成に継続メモブロックを含めるか。 */
  includeHandover: boolean;
  sections: TemplateSection[];
  updatedAt: number;
}

// ============================
// 合成（空伝播つき join）
// ============================

/** 出力後の整形: 3 連以上の改行を 2 つへ潰し、末尾の空白を落とす。唯一の後処理。 */
export function normalizeComposedText(text: string): string {
  return text.replace(/\n{3,}/g, '\n\n').replace(/\s+$/g, '');
}

/** 項目 1 つの合成。空値は '' を返す（呼び出し側の filter で枝ごと落ちる）。 */
export function composeItem(item: TemplateItem, rawValue: unknown, labelSep: string): string {
  const labelPart = item.showLabel !== false && item.label !== '' ? item.label + labelSep : '';
  if (item.kind === 'number') {
    const { value, note } = readNumericEntry(rawValue);
    const v = value.trim();
    if (v === '') return ''; // 値なし注記だけは出力しない（文脈不明になるため）
    const base = `${labelPart}${v}${item.unit ?? ''}`;
    return note.trim() === '' ? base : `${base} ${note.trim()}`;
  }
  if (item.kind === 'fraction') {
    const { value, note } = readNumericEntry(rawValue);
    const v = value.trim();
    // "a/b" 両側空（"" or "/"）はスキップ
    if (v === '' || /^\/*$/.test(v)) return '';
    const base = `${labelPart}${v}${item.unit ?? ''}`;
    return note.trim() === '' ? base : `${base} ${note.trim()}`;
  }
  const value =
    item.kind === 'select'
      ? readSelectValue(rawValue, item.options ?? []).trim()
      : readTextValue(rawValue).trim();
  if (value === '') return '';
  return `${labelPart}${value}`;
}

/** 配置フォーマット 1 つの合成。全項目が空ならタイトル行も出さない。 */
export function composePlacedFormat(
  placedFormat: PlacedFormat,
  values: Record<string, unknown>,
): { text: string; hasValue: boolean } {
  const parts = placedFormat.items
    .map((item) => composeItem(item, values[item.id], placedFormat.labelSep))
    .filter((s) => s !== '');
  if (parts.length === 0) return { text: '', hasValue: false };
  const body = parts.join(placedFormat.joiner);
  const wrap = placedFormat.titleWrap;
  if (wrap.length >= 2 && placedFormat.name !== '') {
    const open = wrap.slice(0, Math.floor(wrap.length / 2));
    const close = wrap.slice(Math.floor(wrap.length / 2));
    return { text: `${open}${placedFormat.name}${close}\n${body}`, hasValue: true };
  }
  return { text: body, hasValue: true };
}

/**
 * 場所 1 つの合成。全配置 → 自由本文の順。
 * 自由本文は呼び出し側が渡す（その場所の patient.sectionTexts[section.id]）。
 * 空でも見出しは常に残す（不要な場所はテンプレートから場所自体を削除する）。
 */
export function composeSection(
  section: TemplateSection,
  freeTextRaw: string,
  formValues: FormValues,
): string {
  const pieces: string[] = [];
  for (const placedFormat of section.formats) {
    const { text, hasValue } = composePlacedFormat(
      placedFormat,
      readPlacementValues(formValues, placedFormat.id),
    );
    if (hasValue) pieces.push(text);
  }
  const free = section.freeText ? String(freeTextRaw ?? '').trim() : '';
  if (free !== '') pieces.push(free);

  if (pieces.length === 0) {
    return section.title !== '' ? section.title : '';
  }
  const body = pieces.join('\n\n');
  return section.title !== '' ? `${section.title}\n${body}` : body;
}

/** 問題リストブロックの合成。先頭行に #n、2 行目以降（経過等）はそのまま続ける。 */
export function composeProblems(problems: readonly string[]): string {
  const rows: string[] = [];
  let n = 0;
  for (const raw of problems) {
    const text = String(raw ?? '').replace(/\s+$/g, '');
    if (text.trim() === '') continue;
    n += 1;
    const lines = text.split('\n');
    rows.push(`#${n} ${lines[0]}`);
    for (const rest of lines.slice(1)) rows.push(rest);
  }
  return rows.join('\n');
}

/** その場所へ書かれた自由本文（sectionTexts は場所 id をキーに持つ）。 */
function sectionFreeTextOf(patient: Patient, section: TemplateSection): string {
  return String(patient.sectionTexts?.[section.id] ?? '');
}

/** ブロック合成の共通部（自由本文の決め方だけ差し替える）。 */
function composeDocumentWith(
  patient: Patient,
  template: Template,
  freeTextOf: (section: TemplateSection) => string,
): string {
  const blocks: string[] = [];
  if (template.includeProblems) {
    const p = composeProblems(patient.problems);
    if (p !== '') blocks.push(p);
  }
  if (template.includeHandover) {
    const h = String(patient.standingMemo ?? '').trim();
    if (h !== '') blocks.push(h);
  }
  for (const section of template.sections) {
    const s = composeSection(section, freeTextOf(section), patient.projectedValues);
    if (s !== '') blocks.push(s);
  }
  return normalizeComposedText(blocks.join('\n\n'));
}

/** 文書全体の合成。ブロック間は空行 1 つ。 */
export function composeDocument(patient: Patient, template: Template): string {
  return composeDocumentWith(patient, template, (section) => sectionFreeTextOf(patient, section));
}

/**
 * 正常文補完つき完成文: 空の自由本文セクションを normal で埋めて合成する。
 * 保存はせず、転記用 QR を開くたびに現在値から生成する。
 * 各場所の自由本文が空なら、その場所の normal へ倒れる。
 */
export function composePresetClean(patient: Patient, template: Template): string {
  return composeDocumentWith(patient, template, (section) => {
    const free = sectionFreeTextOf(patient, section);
    if (free.trim() !== '') return free;
    return String(section.normal ?? '');
  });
}

// ============================
// 正規化（fail-safe）
// ============================

function str(v: unknown, fallback = ''): string {
  return typeof v === 'string' ? v : fallback;
}

/** item 1 件の正規化。label も normal も無い壊れ row は捨てる。id 欠落は採番して救う。 */
export function normalizeItem(raw: unknown): TemplateItem | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const kind: ItemKind =
    r.kind === 'number' || r.kind === 'fraction' || r.kind === 'select' ? r.kind : 'text';
  const item: TemplateItem = {
    id: str(r.id) || newId('itm'),
    label: str(r.label),
    kind,
  };
  if (kind === 'number' || kind === 'fraction') {
    const unit = str(r.unit);
    if (unit !== '') item.unit = unit;
  } else if (kind === 'text') {
    const normal = str(r.normal);
    if (normal !== '') item.normal = normal;
  } else {
    const options = (Array.isArray(r.options) ? r.options : [])
      .filter((option): option is string => typeof option === 'string')
      .map((option) => option.trim())
      .filter((option) => option !== '');
    if (options.length === 0) return null;
    item.options = options;
  }
  if (r.showLabel === false) item.showLabel = false;
  // text はラベルも正常文も無いと入力欄の意味が立たないので捨てる。
  // number/fraction/select はラベル無しが正当。
  if (item.kind === 'text' && item.label === '' && item.normal === undefined) return null;
  return item;
}
