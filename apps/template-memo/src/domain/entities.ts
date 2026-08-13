/*
 * 永続化するテンプレート部品。
 *
 * Frame と Format は独立した再利用部品、TemplateDef は両者を参照して配置するレシピ。
 * 入力値は Format の id ではなく FormatPlacement.id に紐づくため、同じ Format を
 * 複数の場所へ配置しても衝突しない。
 */

import { newId } from '../data/constants';
import { normalizeItem, type PlacementDisplay, type TemplateItem } from './template';

export interface FrameSection {
  id: string;
  title: string;
  freeText: boolean;
  normal?: string;
}

export interface Frame {
  id: string;
  name: string;
  sections: FrameSection[];
}

export interface Format {
  id: string;
  name: string;
  joiner: string;
  labelSep: string;
  titleWrap: string;
  /**
   * 入力カードにフォーマット名の見出し行を出すか。未定義 = 出す。false のときだけ保存する
   * （TemplateItem.showLabel と同型）。titleWrap（合成出力のタイトル行）とは別制御。
   */
  showName?: boolean;
  items: TemplateItem[];
}

export interface FormatPlacement {
  /** 対象ごとの projectedValues を保存する安定キー。 */
  id: string;
  sectionId: string;
  formatId: string;
  display: PlacementDisplay;
}

export interface TemplateDef {
  id: string;
  name: string;
  frameId: string;
  includeProblems: boolean;
  includeHandover: boolean;
  placements: FormatPlacement[];
  updatedAt: number;
}

export interface EntityRefs {
  frames: readonly Frame[];
  formats: readonly Format[];
}

function str(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

function normalizeFrameSection(raw: unknown): FrameSection | null {
  if (!raw || typeof raw !== 'object') return null;
  const row = raw as Record<string, unknown>;
  const section: FrameSection = {
    id: str(row.id) || newId('sec'),
    title: str(row.title),
    freeText: row.freeText !== false,
  };
  const normal = str(row.normal);
  if (normal !== '') section.normal = normal;
  // 見出しも自由本文も無い場所も残す。フレーム単体では配置の有無が分からないため、
  // 「フォーマットだけを置く場所」を保存時に黙って消さない（不要な場所は明示的に削除する運用）。
  return section;
}

export function normalizeFrame(raw: unknown): Frame | null {
  if (!raw || typeof raw !== 'object') return null;
  const row = raw as Record<string, unknown>;
  const sections = (Array.isArray(row.sections) ? row.sections : [])
    .map(normalizeFrameSection)
    .filter((section): section is FrameSection => section !== null);
  if (sections.length === 0) return null;
  return {
    id: str(row.id) || newId('frm'),
    // 空名は許容する（旧 normalize と同じ。表示側が (無題) を補う）。
    name: str(row.name),
    sections,
  };
}

export function normalizeFormat(raw: unknown): Format | null {
  if (!raw || typeof raw !== 'object') return null;
  const row = raw as Record<string, unknown>;
  const items = (Array.isArray(row.items) ? row.items : [])
    .map(normalizeItem)
    .filter((item): item is TemplateItem => item !== null);
  if (items.length === 0) return null;
  const format: Format = {
    id: str(row.id) || newId('fmt'),
    // 空名は許容する（旧 normalize と同じ）。titleWrap 付き無名フォーマットで
    // 存在しなかったタイトル行が合成に混入しないよう、ここで代替名を注入しない。
    name: str(row.name),
    joiner: typeof row.joiner === 'string' ? row.joiner : '\n',
    labelSep: typeof row.labelSep === 'string' ? row.labelSep : '：',
    titleWrap: str(row.titleWrap),
    items,
  };
  // 見出しを消す指定は false のときだけ持つ（真偽値以外は「出す」へ倒す fail-safe）。
  // ここへ足し忘れると、起動ロード・編集保存・共有QR・backup 復元のすべてが
  // この whitelist で落とすため「設定できるのに再起動で戻る」挙動になる。
  if (row.showName === false) format.showName = false;
  return format;
}

function normalizePlacement(raw: unknown): FormatPlacement | null {
  if (!raw || typeof raw !== 'object') return null;
  const row = raw as Record<string, unknown>;
  const sectionId = str(row.sectionId);
  const formatId = str(row.formatId);
  if (sectionId === '' || formatId === '') return null;
  return {
    id: str(row.id) || newId('plm'),
    sectionId,
    formatId,
    display: row.display === 'oncall' || row.display === 'menu' ? row.display : 'always',
  };
}

/**
 * refs を渡した場合は参照整合も検証し、迷子フレームは定義ごと、迷子配置は配置だけ落とす。
 * refs を省略した場合も構造検証は必ず行う。
 */
export function normalizeTemplateDef(raw: unknown, refs?: EntityRefs): TemplateDef | null {
  if (!raw || typeof raw !== 'object') return null;
  const row = raw as Record<string, unknown>;
  const frameId = str(row.frameId);
  if (frameId === '') return null;
  const frame = refs?.frames.find((candidate) => candidate.id === frameId);
  if (refs && !frame) return null;

  let placements = (Array.isArray(row.placements) ? row.placements : [])
    .map(normalizePlacement)
    .filter((placement): placement is FormatPlacement => placement !== null);
  // 配置 ID は projectedValues のキー。重複すると 2 配置が同じ値レコードを共有するため、
  // 先勝ちで落とす（手編集 JSON や取り込み経路の防御）。
  const seenPlacementIds = new Set<string>();
  placements = placements.filter((placement) => {
    if (seenPlacementIds.has(placement.id)) return false;
    seenPlacementIds.add(placement.id);
    return true;
  });
  if (refs && frame) {
    const sectionIds = new Set(frame.sections.map((section) => section.id));
    const formatIds = new Set(refs.formats.map((format) => format.id));
    placements = placements.filter(
      (placement) => sectionIds.has(placement.sectionId) && formatIds.has(placement.formatId),
    );
  }

  return {
    id: str(row.id) || newId('tpl'),
    name: str(row.name),
    frameId,
    includeProblems: row.includeProblems === true,
    includeHandover: row.includeHandover === true,
    placements,
    updatedAt: typeof row.updatedAt === 'number' ? row.updatedAt : 0,
  };
}
