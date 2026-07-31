import { describe, expect, it } from 'vitest';
import type { Format, Frame, TemplateDef } from './entities';
import { resolveTemplate } from './resolveTemplate';
import { normalizeTemplate } from './template';

const frame: Frame = {
  id: 'frame-soap',
  name: 'SOAP',
  sections: [
    { id: 'section-s', title: '(S)', freeText: true, normal: '変わりない' },
    { id: 'section-o', title: '(O)', freeText: true },
  ],
};

const format: Format = {
  id: 'format-vitals',
  name: 'バイタル',
  joiner: ', ',
  labelSep: ' ',
  titleWrap: '',
  items: [{ id: 'item-bp', label: 'BP', kind: 'fraction', unit: 'mmHg' }],
};

function definition(overrides: Partial<TemplateDef> = {}): TemplateDef {
  return {
    id: 'template-round',
    name: '回診',
    frameId: frame.id,
    memoSectionId: 'section-o',
    includeProblems: true,
    includeHandover: true,
    placements: [
      {
        id: 'placement-first',
        sectionId: 'section-o',
        formatId: format.id,
        display: 'always',
      },
      {
        id: 'placement-second',
        sectionId: 'section-s',
        formatId: format.id,
        display: 'menu',
      },
    ],
    updatedAt: 100,
    ...overrides,
  };
}

describe('resolveTemplate', () => {
  it('フレームとフォーマットを配置順に解決し、display を配置から合成する', () => {
    const resolved = resolveTemplate(definition(), [frame], [format]);
    expect(resolved?.sections[0]?.formats[0]).toMatchObject({
      id: 'placement-second',
      name: 'バイタル',
      display: 'menu',
    });
    expect(resolved?.sections[1]?.formats[0]).toMatchObject({
      id: 'placement-first',
      name: 'バイタル',
      display: 'always',
    });
  });

  it('同一フォーマットの複数配置でも解決済み id は別の配置 ID になる', () => {
    const resolved = resolveTemplate(definition(), [frame], [format]);
    const ids = resolved?.sections.flatMap((section) => section.formats.map((placed) => placed.id));
    expect(ids).toEqual(['placement-second', 'placement-first']);
    expect(new Set(ids).size).toBe(2);
  });

  it('迷子配置は落とし、迷子 memoSection は null にする', () => {
    const resolved = resolveTemplate(
      definition({
        memoSectionId: 'missing-section',
        placements: [
          {
            id: 'missing-section-placement',
            sectionId: 'missing-section',
            formatId: format.id,
            display: 'always',
          },
          {
            id: 'missing-format-placement',
            sectionId: 'section-o',
            formatId: 'missing-format',
            display: 'always',
          },
        ],
      }),
      [frame],
      [format],
    );
    expect(resolved?.memoSectionId).toBeNull();
    expect(resolved?.sections.every((section) => section.formats.length === 0)).toBe(true);
  });

  it('迷子フレームはテンプレートごと null にし、解決結果は resolved normalize を通る', () => {
    expect(resolveTemplate(definition({ frameId: 'missing-frame' }), [frame], [format])).toBeNull();
    const resolved = resolveTemplate(definition(), [frame], [format]);
    expect(normalizeTemplate(resolved)).toEqual(resolved);
  });
});
