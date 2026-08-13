/*
 * 永続化された TemplateDef / Frame / Format を、合成・入力 UI が読む解決済み Template へ変換する。
 * 解決済み PlacedFormat.id は必ず FormatPlacement.id とし、入力値の保存キーを配置単位に保つ。
 */

import type { Format, Frame, TemplateDef } from './entities';
import type { PlacedFormat, Template } from './template';

export function resolveTemplate(
  definition: TemplateDef,
  frames: readonly Frame[],
  formats: readonly Format[],
): Template | null {
  const frame = frames.find((candidate) => candidate.id === definition.frameId);
  if (!frame) return null;

  const formatById = new Map(formats.map((format) => [format.id, format]));
  const sectionIds = new Set(frame.sections.map((section) => section.id));
  const placedBySection = new Map<string, PlacedFormat[]>();

  for (const placement of definition.placements) {
    if (!sectionIds.has(placement.sectionId)) continue;
    const format = formatById.get(placement.formatId);
    if (!format) continue;
    const placed: PlacedFormat = {
      id: placement.id,
      name: format.name,
      display: placement.display,
      joiner: format.joiner,
      labelSep: format.labelSep,
      titleWrap: format.titleWrap,
      items: format.items,
    };
    if (format.showName === false) placed.showName = false;
    const current = placedBySection.get(placement.sectionId) ?? [];
    current.push(placed);
    placedBySection.set(placement.sectionId, current);
  }

  return {
    id: definition.id,
    name: definition.name,
    includeProblems: definition.includeProblems,
    includeHandover: definition.includeHandover,
    sections: frame.sections.map((section) => ({
      ...section,
      formats: placedBySection.get(section.id) ?? [],
    })),
    updatedAt: definition.updatedAt,
  };
}
