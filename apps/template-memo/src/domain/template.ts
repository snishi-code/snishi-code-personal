/*
 * テンプレート（定型文の構造定義）と本文合成エンジン。
 *
 * モデルは 3 階層の木:
 *   Template（文書）→ TemplateSection（大項目 例 "(S)"）→ TemplateGroup（群 例 バイタル/身体所見）
 *   → TemplateItem（小項目 例 肺音/BP）
 *
 * 合成は「空の枝を落としながら join する」再帰 1 本（空伝播）。空項目で区切りが
 * 二重になる・空行だけ残る問題を原理的に起こさない。テンプレートに条件分岐や式は
 * 持たせない（logic-less 原則。入れた瞬間に言語処理系の所有になるため）。
 *
 * 旧回診との対応:
 *   display 'always' = 旧 expand（値を保存し合成時に出力）
 *   display 'oncall' = 旧 quick（チップから入力シートを開き、合成文をセクション本文へ挿入。
 *                      値は保存しない）
 */

import { newId } from '../data/constants';
import {
  readGroupValues,
  readNumericEntry,
  readTextValue,
} from './formValues';
import type { FormValues, Subject } from './types';

// ============================
// 型
// ============================

export type ItemKind = 'text' | 'number' | 'fraction';
export const ITEM_KINDS: readonly ItemKind[] = Object.freeze(['text', 'number', 'fraction']);

/** 群の表示方式。always = カード常設（値保存）/ oncall = チップから呼び出し（本文へ挿入）。 */
export type GroupDisplay = 'always' | 'oncall';

/** 小項目。text は正常文ワンタップ（normal）対応。 */
export interface TemplateItem {
  id: string;
  label: string;
  kind: ItemKind;
  /** number/fraction の単位（例 mmHg, %）。値の直後に付く。 */
  unit?: string;
  /** text の正常文（ワンタップ入力・全部正常の対象）。 */
  normal?: string;
  /** 合成でラベルを出すか。未定義は true 扱い。false は値だけを出す。 */
  showLabel?: boolean;
}

/** 群（旧 Format 相当）。合成の区切り文字はここが持つ。 */
export interface TemplateGroup {
  id: string;
  name: string;
  display: GroupDisplay;
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

/** 大項目（セクション）。自由本文欄 + 群の入れ物。 */
export interface TemplateSection {
  id: string;
  /** 見出し（例 "(S)" / "今日やったこと"）。空 = 見出し行なし。 */
  title: string;
  /** 中身が空でも見出し行を出すか（例 "(S)" は空でも骨格を残したい場合 true）。 */
  keepWhenEmpty: boolean;
  /** 自由本文欄を持つか。 */
  freeText: boolean;
  /** 自由本文の正常文（定型清書で空欄をこれで埋める。例 "著変なし"）。 */
  normal?: string;
  groups: TemplateGroup[];
}

/** テンプレート（文書の構造定義）。 */
export interface Template {
  id: string;
  name: string;
  /** 合成に問題リストブロックを含めるか（日報などでは false）。 */
  includeProblems: boolean;
  /** 合成に申し送りブロックを含めるか。 */
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
  const value = readTextValue(rawValue).trim();
  if (value === '') return '';
  return `${labelPart}${value}`;
}

/** 群 1 つの合成。全項目が空なら text='' / hasValue=false（タイトル行も出さない）。 */
export function composeGroup(
  group: TemplateGroup,
  values: Record<string, unknown>,
): { text: string; hasValue: boolean } {
  const parts = group.items
    .map((item) => composeItem(item, values[item.id], group.labelSep))
    .filter((s) => s !== '');
  if (parts.length === 0) return { text: '', hasValue: false };
  const body = parts.join(group.joiner);
  const wrap = group.titleWrap;
  if (wrap.length >= 2 && group.name !== '') {
    const open = wrap.slice(0, Math.floor(wrap.length / 2));
    const close = wrap.slice(Math.floor(wrap.length / 2));
    return { text: `${open}${group.name}${close}\n${body}`, hasValue: true };
  }
  return { text: body, hasValue: true };
}

/**
 * セクション 1 つの合成。常設 (always) 群 → 自由本文の順。
 * oncall 群は本文への挿入部品なのでここでは出力しない。
 * 空なら keepWhenEmpty に従い「見出しのみ」か「まるごと省略」。
 */
export function composeSection(
  section: TemplateSection,
  sectionText: Record<string, string>,
  formValues: FormValues,
): string {
  const pieces: string[] = [];
  for (const group of section.groups) {
    if (group.display !== 'always') continue;
    const { text, hasValue } = composeGroup(group, readGroupValues(formValues, group.id));
    if (hasValue) pieces.push(text);
  }
  const free = section.freeText ? String(sectionText[section.id] ?? '').trim() : '';
  if (free !== '') pieces.push(free);

  if (pieces.length === 0) {
    return section.keepWhenEmpty && section.title !== '' ? section.title : '';
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

/** 文書全体の合成（清書のたたき台）。ブロック間は空行 1 つ。 */
export function composeDocument(subject: Subject, template: Template): string {
  const blocks: string[] = [];
  if (template.includeProblems) {
    const p = composeProblems(subject.problems);
    if (p !== '') blocks.push(p);
  }
  if (template.includeHandover) {
    const h = String(subject.handover ?? '').trim();
    if (h !== '') blocks.push(h);
  }
  for (const section of template.sections) {
    const s = composeSection(section, subject.sectionText, subject.formValues);
    if (s !== '') blocks.push(s);
  }
  return normalizeComposedText(blocks.join('\n\n'));
}

/**
 * 定型清書: 空の自由本文セクションを normal で埋めた状態で合成する
 * （保存はしない。ワンタップで「著変なし/現行加療継続」入りの清書案を作る）。
 */
export function composePresetClean(subject: Subject, template: Template): string {
  const filled: Record<string, string> = { ...subject.sectionText };
  for (const section of template.sections) {
    if (!section.freeText) continue;
    const cur = String(filled[section.id] ?? '').trim();
    const normal = String(section.normal ?? '');
    if (cur === '' && normal !== '') filled[section.id] = normal;
  }
  const patched: Subject = { ...subject, sectionText: filled };
  return composeDocument(patched, template);
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
  const kind: ItemKind = r.kind === 'number' || r.kind === 'fraction' ? r.kind : 'text';
  const item: TemplateItem = {
    id: str(r.id) || newId('itm'),
    label: str(r.label),
    kind,
  };
  const unit = str(r.unit);
  if (unit !== '') item.unit = unit;
  const normal = str(r.normal);
  if (normal !== '') item.normal = normal;
  if (r.showLabel === false) item.showLabel = false;
  if (item.label === '' && item.normal === undefined) return null;
  return item;
}

/** group 1 件の正規化。items が空になった group は捨てる。 */
export function normalizeGroup(raw: unknown): TemplateGroup | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const items = (Array.isArray(r.items) ? r.items : [])
    .map(normalizeItem)
    .filter((i): i is TemplateItem => i !== null);
  if (items.length === 0) return null;
  return {
    id: str(r.id) || newId('grp'),
    name: str(r.name),
    display: r.display === 'oncall' ? 'oncall' : 'always',
    joiner: typeof r.joiner === 'string' ? r.joiner : '\n',
    labelSep: typeof r.labelSep === 'string' ? r.labelSep : '：',
    titleWrap: str(r.titleWrap),
    items,
  };
}

/** section 1 件の正規化。title も freeText も groups も無い空 section は捨てる。 */
export function normalizeSection(raw: unknown): TemplateSection | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const groups = (Array.isArray(r.groups) ? r.groups : [])
    .map(normalizeGroup)
    .filter((g): g is TemplateGroup => g !== null);
  const section: TemplateSection = {
    id: str(r.id) || newId('sec'),
    title: str(r.title),
    keepWhenEmpty: r.keepWhenEmpty === true,
    freeText: r.freeText !== false,
    groups,
  };
  const normal = str(r.normal);
  if (normal !== '') section.normal = normal;
  if (section.title === '' && !section.freeText && groups.length === 0) return null;
  return section;
}

/** テンプレート 1 件の正規化。sections が全滅した壊れテンプレは null。 */
export function normalizeTemplate(raw: unknown): Template | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const sections = (Array.isArray(r.sections) ? r.sections : [])
    .map(normalizeSection)
    .filter((s): s is TemplateSection => s !== null);
  if (sections.length === 0) return null;
  return {
    id: str(r.id) || newId('tpl'),
    name: str(r.name) || '(無題テンプレート)',
    includeProblems: r.includeProblems === true,
    includeHandover: r.includeHandover === true,
    sections,
    updatedAt: typeof r.updatedAt === 'number' ? r.updatedAt : 0,
  };
}

// ============================
// プリセット（初回 seed・「プリセットから追加」用）
// ============================

/** 回診メモプリセット（作者の実運用形。id は呼び出しごとに採番 = 端末間衝突なし）。 */
export function buildRoundPreset(nowMs: number): Template {
  return {
    id: newId('tpl'),
    name: '回診メモ',
    includeProblems: true,
    includeHandover: true,
    updatedAt: nowMs,
    sections: [
      {
        id: newId('sec'),
        title: '(S)',
        keepWhenEmpty: true,
        freeText: true,
        normal: '変わりない',
        groups: [],
      },
      {
        id: newId('sec'),
        title: '(O)',
        keepWhenEmpty: true,
        freeText: true,
        groups: [
          {
            id: newId('grp'),
            name: 'バイタル',
            display: 'always',
            joiner: ', ',
            labelSep: ' ',
            titleWrap: '',
            items: [
              { id: newId('itm'), label: 'BP', kind: 'fraction', unit: 'mmHg' },
              { id: newId('itm'), label: 'HR', kind: 'number' },
              { id: newId('itm'), label: 'SpO2', kind: 'number', unit: '%' },
              { id: newId('itm'), label: 'BT', kind: 'number', unit: '℃' },
            ],
          },
          {
            id: newId('grp'),
            name: '身体所見',
            display: 'always',
            joiner: '\n',
            labelSep: '：',
            titleWrap: '',
            items: [
              { id: newId('itm'), label: '肺音', kind: 'text', normal: '明らかなラ音なし' },
              { id: newId('itm'), label: '腸音', kind: 'text', normal: '正常' },
              { id: newId('itm'), label: '腹部', kind: 'text', normal: '平坦軟、圧痛なし' },
              { id: newId('itm'), label: '下腿浮腫', kind: 'text', normal: 'なし' },
            ],
          },
          {
            id: newId('grp'),
            name: '検査所見',
            display: 'oncall',
            joiner: '\n',
            labelSep: '：',
            titleWrap: '',
            items: [
              { id: newId('itm'), label: '採血', kind: 'text' },
              { id: newId('itm'), label: '胸部Xp', kind: 'text' },
              { id: newId('itm'), label: 'CT', kind: 'text' },
            ],
          },
        ],
      },
      {
        id: newId('sec'),
        title: '(A)',
        keepWhenEmpty: true,
        freeText: true,
        normal: '著変なし',
        groups: [],
      },
      {
        id: newId('sec'),
        title: '(P)',
        keepWhenEmpty: true,
        freeText: true,
        normal: '現行加療継続',
        groups: [],
      },
    ],
  };
}

/** 日報プリセット（非医療の汎用例）。 */
export function buildDailyReportPreset(nowMs: number): Template {
  return {
    id: newId('tpl'),
    name: '日報',
    includeProblems: false,
    includeHandover: false,
    updatedAt: nowMs,
    sections: [
      {
        id: newId('sec'),
        title: '【今日やったこと】',
        keepWhenEmpty: true,
        freeText: true,
        groups: [],
      },
      {
        id: newId('sec'),
        title: '【課題・気づき】',
        keepWhenEmpty: true,
        freeText: true,
        normal: '特になし',
        groups: [],
      },
      {
        id: newId('sec'),
        title: '【明日の予定】',
        keepWhenEmpty: true,
        freeText: true,
        groups: [],
      },
    ],
  };
}
