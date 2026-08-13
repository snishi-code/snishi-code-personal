/*
 * 生成一式（テンプレート作成アシストの候補）を登録するときの「既存部品の再利用」計画。
 *
 * 一致判定は名前を無視した構造の完全一致（作者決定・2026-08-10）。名前を含めると、
 * 既存に同名別内容があるときに生成分が「バイタル (2)」で保存され、次回の候補「バイタル」と
 * 名前が合わず再利用できない＝連番が (3)(4) と伸び続けるため。
 *
 * 確認画面（TemplateBuilder）と登録（store.saveGeneratedBundle）が同じ関数を呼ぶことで、
 * 「見せた計画」と「実際に登録される形」がずれない。
 */

import type { Format, Frame, FrameSection } from './entities';
import type { TemplatePresetBundle } from './presets';
import type { TemplateItem } from './template';

/** 省略可能な文字列フィールドは未定義と空文字を同じ扱いにする（normalize 後の形が揺れるため）。 */
function textOf(value: string | undefined): string {
  return value ?? '';
}

function itemStructureEquals(a: TemplateItem, b: TemplateItem): boolean {
  if (a.label !== b.label) return false;
  if (a.kind !== b.kind) return false;
  if (textOf(a.unit) !== textOf(b.unit)) return false;
  if (textOf(a.normal) !== textOf(b.normal)) return false;
  // showLabel は未定義 = true 扱い（template.ts の composeItem と同じ解釈）。
  if ((a.showLabel !== false) !== (b.showLabel !== false)) return false;
  const aOptions = a.options ?? [];
  const bOptions = b.options ?? [];
  if (aOptions.length !== bOptions.length) return false;
  return aOptions.every((option, index) => option === bOptions[index]);
}

/** 名前と全 id を無視し、合成出力に効く全フィールドの完全一致（順序込み）。 */
export function formatStructureEquals(a: Format, b: Format): boolean {
  if (a.joiner !== b.joiner) return false;
  if (a.labelSep !== b.labelSep) return false;
  if (a.titleWrap !== b.titleWrap) return false;
  if (a.items.length !== b.items.length) return false;
  return a.items.every((item, index) => {
    const other = b.items[index];
    return other !== undefined && itemStructureEquals(item, other);
  });
}

function sectionStructureEquals(a: FrameSection, b: FrameSection): boolean {
  // 見出し（title）は合成出力に出るので「構造」に含める。
  return a.title === b.title && a.freeText === b.freeText && textOf(a.normal) === textOf(b.normal);
}

/** 名前と全 id を無視し、場所の並びと各場所の内容が完全一致するか。 */
export function frameStructureEquals(a: Frame, b: Frame): boolean {
  if (a.sections.length !== b.sections.length) return false;
  return a.sections.every((section, index) => {
    const other = b.sections[index];
    return other !== undefined && sectionStructureEquals(section, other);
  });
}

export interface FormatReusePlan {
  /** 統合後の代表候補。name は先に現れた候補のもの。 */
  candidate: Format;
  /** この代表へ統合された候補フォーマット id（代表自身を含む・初出順）。 */
  mergedIds: string[];
  /** 構造一致した既存フォーマット。null = 新規作成。 */
  existing: Format | null;
}

export interface FrameReusePlan {
  candidate: Frame;
  /** 構造一致した既存フレーム。null = 新規作成。 */
  existing: Frame | null;
  /** 候補の場所 id → 再利用先の場所 id（existing が null なら空）。 */
  sectionIdMap: ReadonlyMap<string, string>;
}

export interface BundleReusePlan {
  frame: FrameReusePlan;
  /** バンドル内 dedupe 後のフォーマット計画（初出順）。 */
  formats: FormatReusePlan[];
  /** 候補フォーマット id → 統合先の計画（統合されていない候補は自分自身の計画）。 */
  formatPlanById: ReadonlyMap<string, FormatReusePlan>;
}

/**
 * 候補バンドルに対する再利用計画を組む。既存側は配列順に探して最初の一致を採る（決定的・先勝ち）。
 * この関数は読み取り専用で、既存部品も候補も書き換えない。
 */
export function planBundleReuse(
  bundle: TemplatePresetBundle,
  existingFrames: readonly Frame[],
  existingFormats: readonly Format[],
): BundleReusePlan {
  const formats: FormatReusePlan[] = [];
  const formatPlanById = new Map<string, FormatReusePlan>();
  for (const candidate of bundle.formats) {
    // ① バンドル内 dedupe（名前が違っても構造が同じなら 1 つにまとめる）。
    const merged = formats.find((plan) => formatStructureEquals(plan.candidate, candidate));
    if (merged) {
      merged.mergedIds.push(candidate.id);
      formatPlanById.set(candidate.id, merged);
      continue;
    }
    // ② 既存フォーマットとの構造一致。
    const plan: FormatReusePlan = {
      candidate,
      mergedIds: [candidate.id],
      existing:
        existingFormats.find((existing) => formatStructureEquals(existing, candidate)) ?? null,
    };
    formats.push(plan);
    formatPlanById.set(candidate.id, plan);
  }

  // ③ 既存フレームとの構造一致。一致していれば場所は index 対応で読み替えられる。
  const existingFrame =
    existingFrames.find((existing) => frameStructureEquals(existing, bundle.frame)) ?? null;
  const sectionIdMap = new Map<string, string>();
  if (existingFrame) {
    bundle.frame.sections.forEach((section, index) => {
      const target = existingFrame.sections[index];
      if (target) sectionIdMap.set(section.id, target.id);
    });
  }

  return {
    frame: { candidate: bundle.frame, existing: existingFrame, sectionIdMap },
    formats,
    formatPlanById,
  };
}
